import { useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeState } from '@vibraxis/shared/vdap'
import type { CatalogTrack } from '../catalog'
import { AgentApiClient, AgentApiError } from '../agent/AgentApiClient'
import { buildDjContext, type VelocityLimits } from '../agent/djContext'
import { buildDecideRequest, type DecideFormState, type FallbackMode } from '../agent/decideRequest'
import {
  deriveFlowState,
  decisionProviderLabel,
  intentSourceLabel,
  fallbackNotice,
  type ApplyPhase,
  type ApplyReadiness,
  type DecidePhase,
} from '../agent/agentState'
import { captureApplySnapshot, evaluateApply, runApply, type ApplySnapshot } from '../agent/applyDecision'
import type {
  AgentCapability,
  AgentDecideResponse,
  DjContext,
  DjIntent,
  DjTrackSummary,
  ProviderRoute,
} from '../agent/contract'
import type { TransitionClient, TransitionResult } from '../runtime/transition/TransitionExecutor'
import type {
  EnergyDirection,
  HarmonicPriority,
  TempoDirection,
  TransitionUrgency,
} from '@vibraxis/shared/dj'

export interface AgentPanelProps {
  api: AgentApiClient
  capability: AgentCapability | null
  capabilityError: string | null
  runtimeState: RuntimeState | null
  tracks: CatalogTrack[]
  velocity: VelocityLimits | null
  recentlyPlayedTrackIds: string[] | null
  /** Returns a ready (hello-completed) agent client for apply, or null. */
  getApplyClient: () => TransitionClient | null
}

const ROUTE_LABELS: Record<ProviderRoute, string> = {
  deterministic: 'Deterministic',
  'codex-local': 'Codex (local)',
  'gpt56-codex': 'GPT-5.6 → Codex',
}

const ENERGY_DIRECTIONS: EnergyDirection[] = ['decrease', 'maintain', 'increase']
const TEMPO_DIRECTIONS: TempoDirection[] = ['slower', 'similar', 'faster', 'any']
const HARMONIC_PRIORITIES: HarmonicPriority[] = ['strict', 'compatible', 'ignore']
const TRANSITION_URGENCIES: TransitionUrgency[] = ['quick', 'normal', 'gradual']

/** Editable subset of DjIntent fields exposed by the demo form. */
interface IntentForm {
  energyDirection: EnergyDirection
  tempoDirection: TempoDirection
  harmonicPriority: HarmonicPriority
  transitionUrgency: TransitionUrgency
  targetEnergy: number | null
  requestedTrackId: string | null
  rationale: string
  confidence: number
}

const DEFAULT_INTENT_FORM: IntentForm = {
  energyDirection: 'maintain',
  tempoDirection: 'similar',
  harmonicPriority: 'compatible',
  transitionUrgency: 'normal',
  targetEnergy: null,
  requestedTrackId: null,
  rationale: 'manual UI intent',
  confidence: 0.8,
}

/**
 * Assembles a full DjIntent from the exposed form fields. The array preference
 * fields (preferred/avoided genres & moods, excluded ids) are not editable in
 * this slice and are the honest empty defaults — never fabricated values.
 */
function toDjIntent(form: IntentForm): DjIntent {
  return {
    energyDirection: form.energyDirection,
    targetEnergy: form.targetEnergy,
    preferredGenres: [],
    avoidedGenres: [],
    preferredMoods: [],
    avoidedMoods: [],
    tempoDirection: form.tempoDirection,
    harmonicPriority: form.harmonicPriority,
    transitionUrgency: form.transitionUrgency,
    requestedTrackId: form.requestedTrackId,
    excludedTrackIds: [],
    rationale: form.rationale,
    confidence: form.confidence,
  }
}

export function AgentPanel(props: AgentPanelProps) {
  const { api, capability, capabilityError, runtimeState, tracks, velocity, recentlyPlayedTrackIds, getApplyClient } = props

  const [route, setRoute] = useState<ProviderRoute>('deterministic')
  const [text, setText] = useState('')
  const [fallbackMode, setFallbackMode] = useState<FallbackMode>('reject')
  const [intentForm, setIntentForm] = useState<IntentForm>(DEFAULT_INTENT_FORM)

  const [decidePhase, setDecidePhase] = useState<DecidePhase>('idle')
  const [response, setResponse] = useState<AgentDecideResponse | null>(null)
  const [decisionContext, setDecisionContext] = useState<DjContext | null>(null)
  // Deck state captured at decision time; the apply gate validates against this
  // (not against whatever the decks look like now) so a user override made after
  // the decision is rejected, never silently overwritten (findings 1 & 2).
  const [decisionSnapshot, setDecisionSnapshot] = useState<ApplySnapshot | null>(null)
  const [decideError, setDecideError] = useState<string | null>(null)
  const [formRejection, setFormRejection] = useState<string | null>(null)

  const [applyPhase, setApplyPhase] = useState<ApplyPhase>('none')
  const [applyRunning, setApplyRunning] = useState(false)
  const [applyResult, setApplyResult] = useState<TransitionResult | null>(null)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applyTransitionIntentId, setApplyTransitionIntentId] = useState<string | null>(null)

  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  // Monotonic run token: a stale apply promise (or one whose component reset
  // after starting) can never write over newer state, and post-unmount updates
  // are dropped (finding 7).
  const applyRunToken = useRef(0)

  const contextResult = useMemo(
    () => buildDjContext({ runtimeState, tracks, velocity, recentlyPlayedTrackIds }),
    [runtimeState, tracks, velocity, recentlyPlayedTrackIds],
  )

  const trackById = useMemo(() => {
    const map = new Map<string, CatalogTrack>()
    for (const track of tracks) map.set(track.trackId, track)
    return map
  }, [tracks])

  const needsIntent = route !== 'gpt56-codex' || fallbackMode === 'deterministic'
  const routeEnabled = (candidate: ProviderRoute) => capability?.routes.includes(candidate) ?? true

  const availabilityWarning = ((): string | null => {
    if (capability === null) return null
    if (route === 'gpt56-codex' && !capability.availability.gpt56) {
      return 'GPT-5.6 is unavailable (no API key configured); this route will reject unless a deterministic fallback intent is supplied.'
    }
    if ((route === 'codex-local' || route === 'gpt56-codex') && !capability.availability.codexLocal) {
      return 'Codex (local CLI) is unavailable; the decision stage will reject unless deterministic fallback is opted in.'
    }
    return null
  })()

  const resetOutcome = () => {
    // Never tear down the display of a transition that is still executing; the
    // executor has no cancel API, so we keep the confirmed state until it ends
    // (finding 7). Callers that could reset are also disabled while running.
    if (applyRunning) return
    applyRunToken.current += 1
    setResponse(null)
    setDecisionContext(null)
    setDecisionSnapshot(null)
    setDecideError(null)
    setFormRejection(null)
    setApplyPhase('none')
    setApplyResult(null)
    setApplyError(null)
    setApplyTransitionIntentId(null)
  }

  const onDecide = () => {
    // A new decision must not race an in-flight apply (finding 6/7).
    if (applyRunning) return
    resetOutcome()
    if (!contextResult.ok) {
      setFormRejection(`Context unavailable (${contextResult.reason.code}): ${contextResult.reason.detail}`)
      return
    }
    if (runtimeState === null) {
      setFormRejection('Runtime state is not available.')
      return
    }
    const built = buildDecideRequest(
      { route, text, fallbackMode, intent: needsIntent ? toDjIntent(intentForm) : null },
      contextResult.context,
    )
    if (!built.ok) {
      setFormRejection(`Request rejected (${built.reason.code}): ${built.reason.detail}`)
      return
    }
    // Snapshot the decks as they are AT decision time; the apply gate compares
    // against this, not against live state read later.
    const snapshot = captureApplySnapshot(built.request.context, runtimeState)
    setDecidePhase('deciding')
    void api
      .decide(built.request)
      .then((res) => {
        if (!mounted.current) return
        setResponse(res)
        if (res.outcome === 'decided') {
          setDecisionContext(built.request.context)
          setDecisionSnapshot(snapshot)
        } else {
          setDecisionContext(null)
          setDecisionSnapshot(null)
        }
        setDecidePhase('settled')
      })
      .catch((cause) => {
        if (!mounted.current) return
        const message =
          cause instanceof AgentApiError
            ? `Agent API error (${cause.kind}${cause.status ? ` ${cause.status}` : ''}): ${cause.message}`
            : cause instanceof Error
              ? cause.message
              : 'decide request failed'
        setDecideError(message)
        setDecidePhase('settled')
      })
  }

  const applyEvaluation =
    response !== null && response.outcome === 'decided'
      && decisionContext !== null && decisionSnapshot !== null && runtimeState !== null
      ? evaluateApply(response.decision, decisionContext, runtimeState, decisionSnapshot)
      : null

  useEffect(() => {
    if (
      applyRunning
      && applyTransitionIntentId !== null
      && runtimeState?.mixer.crossfader.automation?.intentId === applyTransitionIntentId
    ) {
      setApplyPhase('mixing')
    }
  }, [applyRunning, applyTransitionIntentId, runtimeState])

  const onApply = () => {
    // Reject a second concurrent apply outright (finding 6).
    if (applyRunning) return
    if (applyEvaluation === null || applyEvaluation.status !== 'ready') return
    const client = getApplyClient()
    if (client === null) {
      setApplyError('The apply client is not ready yet.')
      return
    }
    const token = (applyRunToken.current += 1)
    setApplyError(null)
    setApplyResult(null)
    setApplyTransitionIntentId(null)
    // No milestone is claimed until the runtime confirms one (AGENTS.md §0.10).
    setApplyPhase('none')
    setApplyRunning(true)
    void runApply(client, applyEvaluation.plan, (milestone) => {
      if (!mounted.current || applyRunToken.current !== token) return
      if (milestone.type === 'synced') setApplyPhase('synced')
      else setApplyTransitionIntentId(milestone.intentId)
    })
      .then((result) => {
        if (!mounted.current || applyRunToken.current !== token) return
        setApplyRunning(false)
        setApplyResult(result)
        setApplyPhase(
          result.status === 'completed'
            ? 'completed'
            : result.status === 'cancelled'
              ? 'cancelled'
              : 'failed',
        )
      })
      .catch((cause) => {
        if (!mounted.current || applyRunToken.current !== token) return
        setApplyRunning(false)
        setApplyError(cause instanceof Error ? cause.message : 'apply failed')
        setApplyPhase('failed')
      })
  }

  const applyReadiness: ApplyReadiness =
    applyEvaluation === null ? 'unknown' : applyEvaluation.status === 'ready' ? 'ready' : 'blocked'

  const liveTempoStillSynced = (() => {
    if (response?.outcome !== 'decided' || response.decision.tempoSync !== 'tempo'
      || decisionContext === null || runtimeState === null) return false
    const activeBpm = runtimeState.decks[decisionContext.activeDeckId].tempo.effectiveBpm
    const targetBpm = runtimeState.decks[decisionContext.inactiveDeckId].tempo.effectiveBpm
    return activeBpm !== null && targetBpm !== null
      && Number.isFinite(activeBpm) && Number.isFinite(targetBpm)
      && Math.abs(activeBpm - targetBpm) <= 1e-9
  })()
  // A completed sync is not a permanent claim. If a later user tempo input
  // breaks equality before the transition begins, show APPLYING while the
  // revision-guarded executor rejects/yields; never keep a stale SYNCED label.
  const displayedApplyPhase: ApplyPhase =
    applyPhase === 'synced' && !liveTempoStillSynced ? 'none' : applyPhase

  const flowState = deriveFlowState({
    phase: decidePhase,
    response,
    apply: displayedApplyPhase,
    applyRunning,
    readiness: applyReadiness,
    hasError: decideError !== null,
  })

  // CURRENT and NEXT are shown from a single consistent snapshot: once a decision
  // exists, both come from that decision's context — never the latest live
  // current paired with an older decision's next (finding 4).
  const decided = response !== null && response.outcome === 'decided'
  const snapshotContext = decided ? decisionContext : null
  const displayCurrentTrack = snapshotContext
    ? snapshotContext.currentTrack
    : contextResult.ok
      ? contextResult.context.currentTrack
      : null
  const displayActiveDeckId = snapshotContext
    ? snapshotContext.activeDeckId
    : contextResult.ok
      ? contextResult.activeDeckId
      : null
  const displayInactiveDeckId = snapshotContext
    ? snapshotContext.inactiveDeckId
    : contextResult.ok
      ? contextResult.inactiveDeckId
      : null
  const displayNextTrack = decided && snapshotContext
    ? snapshotContext.candidates.find((candidate) => candidate.trackId === response.decision.nextTrackId) ?? null
    : null

  return (
    <section className="agent-panel" aria-label="DJ Agent">
      <div className="agent-panel__head">
        <div>
          <p className="eyebrow">AGENT DECISION</p>
          <h2>DJ AGENT</h2>
        </div>
        <span className={`agent-flow agent-flow--${flowState.toLowerCase()}`}>{flowState}</span>
      </div>

      {capabilityError && (
        <div className="agent-note agent-note--error" role="alert">
          Capability unavailable: {capabilityError}
        </div>
      )}

      <CurrentNext
        showContextNote={!decided}
        contextOk={contextResult.ok}
        contextReason={contextResult.ok ? null : `${contextResult.reason.code}: ${contextResult.reason.detail}`}
        currentTrack={displayCurrentTrack}
        activeDeckId={displayActiveDeckId}
        inactiveDeckId={displayInactiveDeckId}
        nextTrack={displayNextTrack}
      />

      <form
        className="agent-form"
        onSubmit={(event) => {
          event.preventDefault()
          onDecide()
        }}
      >
        <fieldset className="agent-fieldset">
          <legend>ROUTE</legend>
          <div className="agent-radios">
            {(Object.keys(ROUTE_LABELS) as ProviderRoute[]).map((candidate) => (
              <label key={candidate} className={!routeEnabled(candidate) || applyRunning ? 'agent-radio--disabled' : ''}>
                <input
                  type="radio"
                  name="agent-route"
                  value={candidate}
                  checked={route === candidate}
                  disabled={!routeEnabled(candidate) || applyRunning}
                  onChange={() => {
                    // Route changes reset the outcome; forbid them while applying.
                    if (applyRunning) return
                    setRoute(candidate)
                    resetOutcome()
                  }}
                />
                {ROUTE_LABELS[candidate]}
                {!routeEnabled(candidate) && <span className="agent-muted"> (not enabled)</span>}
              </label>
            ))}
          </div>
        </fieldset>

        {route === 'gpt56-codex' && (
          <label className="agent-field">
            <span>NATURAL-LANGUAGE REQUEST (GPT route only)</span>
            <textarea
              className="agent-textarea"
              rows={2}
              value={text}
              placeholder="e.g. keep the energy high but mix into something a little faster"
              onChange={(event) => setText(event.target.value)}
            />
          </label>
        )}

        <fieldset className="agent-fieldset">
          <legend>ON PROVIDER FAILURE</legend>
          <div className="agent-radios">
            <label>
              <input
                type="radio"
                name="agent-fallback"
                value="reject"
                checked={fallbackMode === 'reject'}
                onChange={() => setFallbackMode('reject')}
              />
              Reject
            </label>
            <label className={route === 'deterministic' ? 'agent-radio--disabled' : ''}>
              <input
                type="radio"
                name="agent-fallback"
                value="deterministic"
                checked={fallbackMode === 'deterministic'}
                disabled={route === 'deterministic'}
                onChange={() => setFallbackMode('deterministic')}
              />
              Deterministic fallback
            </label>
          </div>
        </fieldset>

        {needsIntent && (
          <IntentFields
            form={intentForm}
            candidates={contextResult.ok ? contextResult.context.candidates.map((c) => c.trackId) : []}
            onChange={setIntentForm}
            heading={route === 'gpt56-codex' ? 'FALLBACK INTENT (required for GPT deterministic fallback)' : 'INTENT'}
          />
        )}

        {availabilityWarning && (
          <div className="agent-note agent-note--warn" role="status">{availabilityWarning}</div>
        )}

        <button type="submit" className="agent-submit" disabled={decidePhase === 'deciding' || applyRunning}>
          {decidePhase === 'deciding' ? 'DECIDING…' : applyRunning ? 'APPLYING…' : 'REQUEST DECISION'}
        </button>
      </form>

      {formRejection && (
        <div className="agent-note agent-note--error" role="alert">{formRejection}</div>
      )}
      {decideError && (
        <div className="agent-note agent-note--error" role="alert">{decideError}</div>
      )}

      {response && (
        <Provenance response={response} nextTrack={
          response.outcome === 'decided' ? trackById.get(response.decision.nextTrackId) ?? null : null
        } />
      )}

      {response !== null && response.outcome === 'decided' && (
        <ApplySection
          evaluation={applyEvaluation}
          applyClientReady={getApplyClient() !== null}
          applyRunning={applyRunning}
          applyPhase={applyPhase}
          applyResult={applyResult}
          applyError={applyError}
          onApply={onApply}
        />
      )}
    </section>
  )
}

function CurrentNext(props: {
  /** Only surface the LIVE context reason when no decision snapshot is shown. */
  showContextNote: boolean
  contextOk: boolean
  contextReason: string | null
  currentTrack: DjTrackSummary | null
  activeDeckId: string | null
  inactiveDeckId: string | null
  nextTrack: DjTrackSummary | null
}) {
  return (
    <div className="agent-track-flow">
      <TrackCard label={props.activeDeckId ? `CURRENT · DECK ${props.activeDeckId}` : 'CURRENT'} track={props.currentTrack} />
      <div className="agent-track-arrow" aria-hidden="true">→</div>
      <TrackCard label={props.inactiveDeckId ? `NEXT · DECK ${props.inactiveDeckId}` : 'NEXT'} track={props.nextTrack} />
      {props.showContextNote && !props.contextOk && props.contextReason && (
        <div className="agent-note agent-note--warn agent-track-flow__note" role="status">
          {props.contextReason}
        </div>
      )}
    </div>
  )
}

function TrackCard(props: { label: string; track: DjTrackSummary | null }) {
  const { track } = props
  return (
    <div className="agent-track-card">
      <p className="eyebrow">{props.label}</p>
      {track ? (
        <>
          <strong className="agent-track-title">{track.title}</strong>
          <span className="agent-muted">{track.artist}</span>
          <dl className="agent-metrics">
            <div><dt>BPM</dt><dd>{track.bpm.toFixed(1)}</dd></div>
            <div><dt>KEY</dt><dd>{track.camelot}</dd></div>
            <div><dt>ENERGY</dt><dd>{track.energy.toFixed(2)}</dd></div>
          </dl>
        </>
      ) : (
        <span className="agent-muted">—</span>
      )}
    </div>
  )
}

function IntentFields(props: {
  form: IntentForm
  candidates: string[]
  heading: string
  onChange: (next: IntentForm) => void
}) {
  const { form, onChange } = props
  const patch = (partial: Partial<IntentForm>) => onChange({ ...form, ...partial })
  return (
    <fieldset className="agent-fieldset">
      <legend>{props.heading}</legend>
      <div className="agent-grid">
        <label className="agent-field">
          <span>ENERGY</span>
          <select value={form.energyDirection} onChange={(e) => patch({ energyDirection: e.target.value as EnergyDirection })}>
            {ENERGY_DIRECTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="agent-field">
          <span>TEMPO</span>
          <select value={form.tempoDirection} onChange={(e) => patch({ tempoDirection: e.target.value as TempoDirection })}>
            {TEMPO_DIRECTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="agent-field">
          <span>HARMONY</span>
          <select value={form.harmonicPriority} onChange={(e) => patch({ harmonicPriority: e.target.value as HarmonicPriority })}>
            {HARMONIC_PRIORITIES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="agent-field">
          <span>URGENCY</span>
          <select value={form.transitionUrgency} onChange={(e) => patch({ transitionUrgency: e.target.value as TransitionUrgency })}>
            {TRANSITION_URGENCIES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="agent-field">
          <span>REQUESTED TRACK</span>
          <select
            value={form.requestedTrackId ?? ''}
            onChange={(e) => patch({ requestedTrackId: e.target.value === '' ? null : e.target.value })}
          >
            <option value="">(agent chooses)</option>
            {props.candidates.map((id) => <option key={id} value={id}>{id}</option>)}
          </select>
        </label>
        <label className="agent-field">
          <span>TARGET ENERGY</span>
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            value={form.targetEnergy ?? ''}
            placeholder="(direction)"
            onChange={(e) => patch({ targetEnergy: e.target.value === '' ? null : Number(e.target.value) })}
          />
        </label>
        <label className="agent-field agent-field--wide">
          <span>RATIONALE</span>
          <input type="text" value={form.rationale} onChange={(e) => patch({ rationale: e.target.value })} />
        </label>
        <label className="agent-field">
          <span>CONFIDENCE {form.confidence.toFixed(2)}</span>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={form.confidence}
            onChange={(e) => patch({ confidence: Number(e.target.value) })}
          />
        </label>
      </div>
    </fieldset>
  )
}

function Provenance(props: { response: AgentDecideResponse; nextTrack: CatalogTrack | null }) {
  const { response, nextTrack } = props
  return (
    <div className="agent-provenance">
      <div className="agent-prov-row">
        <span className="agent-muted">REQUESTED ROUTE</span>
        <strong>{ROUTE_LABELS[response.requestedRoute]}</strong>
      </div>
      <div className="agent-prov-row">
        <span className="agent-muted">OUTCOME</span>
        <strong className={response.outcome === 'decided' ? 'agent-ok' : 'agent-bad'}>
          {response.outcome.toUpperCase()}
        </strong>
      </div>

      {response.outcome === 'decided' ? (
        <>
          <div className="agent-prov-row">
            <span className="agent-muted">DECISION PROVIDER</span>
            <strong>{decisionProviderLabel(response.decisionProvider, response.usedDeterministicFallback)}</strong>
          </div>
          <div className="agent-prov-row">
            <span className="agent-muted">INTENT SOURCE</span>
            <strong>{intentSourceLabel(response.intent.source)}</strong>
          </div>
          {fallbackNotice(response) && (
            <div className="agent-note agent-note--warn" role="status">{fallbackNotice(response)}</div>
          )}
          <p className="agent-rationale">“{response.intent.value.rationale}” · confidence {response.intent.value.confidence.toFixed(2)}</p>

          <div className="agent-decision">
            <div className="agent-prov-row">
              <span className="agent-muted">NEXT TRACK</span>
              <strong>{nextTrack ? nextTrack.title : response.decision.nextTrackId}</strong>
            </div>
            <div className="agent-metrics agent-metrics--inline">
              <div><dt>BPM</dt><dd>{nextTrack ? nextTrack.bpm.toFixed(1) : '—'}</dd></div>
              <div><dt>KEY</dt><dd>{nextTrack ? nextTrack.camelot : '—'}</dd></div>
              <div><dt>ENERGY</dt><dd>{nextTrack ? nextTrack.energy.toFixed(2) : '—'}</dd></div>
              <div><dt>DECK</dt><dd>{response.decision.targetDeckId}</dd></div>
              <div><dt>XFADE</dt><dd>{response.decision.crossfadeBars} bars</dd></div>
              <div><dt>SYNC</dt><dd>{response.decision.tempoSync}</dd></div>
              <div><dt>START</dt><dd>{response.decision.startAt}</dd></div>
              <div><dt>CONF</dt><dd>{response.decision.confidence.toFixed(2)}</dd></div>
            </div>
            <ul className="agent-reasons">
              {response.decision.reasons.map((reason, index) => <li key={index}>{reason}</li>)}
            </ul>
          </div>
        </>
      ) : (
        <div className="agent-note agent-note--error" role="alert">
          <div><strong>{response.failure.code}</strong></div>
          <div>{response.failure.detail}</div>
          {response.failure.schemaErrors && response.failure.schemaErrors.length > 0 && (
            <ul className="agent-reasons">{response.failure.schemaErrors.map((e, i) => <li key={i}>{e}</li>)}</ul>
          )}
          {response.failure.semanticCodes && response.failure.semanticCodes.length > 0 && (
            <div className="agent-muted">semantic: {response.failure.semanticCodes.join(', ')}</div>
          )}
          {response.failure.noCandidateReasons && response.failure.noCandidateReasons.length > 0 && (
            <ul className="agent-reasons">
              {response.failure.noCandidateReasons.map((r, i) => <li key={i}>{r.code}: {r.detail}</li>)}
            </ul>
          )}
        </div>
      )}

      <details className="agent-stages">
        <summary>PROVENANCE STAGES ({response.stages.length})</summary>
        <ul>
          {response.stages.map((stage, index) => (
            <li key={index} className={`agent-stage agent-stage--${stage.status}`}>
              <span className="agent-stage__name">{stage.stage}</span>
              <span className="agent-muted"> · {stage.provider} · {stage.status}</span>
              {stage.durationMs !== undefined && <span className="agent-muted"> · {stage.durationMs}ms</span>}
              {stage.failure && <span className="agent-bad"> · {stage.failure.code}</span>}
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}

function ApplySection(props: {
  evaluation: ReturnType<typeof evaluateApply> | null
  applyClientReady: boolean
  applyRunning: boolean
  applyPhase: ApplyPhase
  applyResult: TransitionResult | null
  applyError: string | null
  onApply: () => void
}) {
  const { evaluation, applyResult, applyError, applyRunning } = props
  const ready = evaluation !== null && evaluation.status === 'ready' && props.applyClientReady && !applyRunning
  return (
    <div className="agent-apply">
      <div className="agent-prov-row">
        <span className="agent-muted">APPLY</span>
        <button className="agent-submit agent-submit--apply" onClick={props.onApply} disabled={!ready}>
          {applyRunning ? 'APPLYING…' : 'APPLY DECISION'}
        </button>
      </div>
      {evaluation !== null && evaluation.status === 'blocked' && (
        <div className="agent-note agent-note--warn" role="status">
          Apply unavailable ({evaluation.reason.code}): {evaluation.reason.detail}
        </div>
      )}
      {evaluation !== null && evaluation.status === 'ready' && !props.applyClientReady && (
        <div className="agent-note agent-note--warn" role="status">
          Decision is READY. The apply client is still initializing.
        </div>
      )}
      {applyError && <div className="agent-note agent-note--error" role="alert">{applyError}</div>}
      {applyResult && (
        <div
          className={`agent-note ${applyResult.status === 'completed' ? 'agent-note--ok' : applyResult.status === 'cancelled' ? 'agent-note--warn' : 'agent-note--error'}`}
          role="status"
        >
          {applyResult.status === 'completed' && `Mix completed on binding ${applyResult.bindingId}.`}
          {applyResult.status === 'cancelled' && `Reservation cancelled at ${applyResult.stage} (${applyResult.reason}) — yielded to user override.`}
          {applyResult.status === 'failed' &&
            `Apply failed at ${applyResult.stage}: ${applyResult.error.code}. Rolled back: ${applyResult.rolledBack ? 'yes' : 'no'}.`}
        </div>
      )}
    </div>
  )
}
