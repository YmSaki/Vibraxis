import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeState, DeckId } from '@vibraxis/shared/vdap'
import type { CatalogTrack } from '../catalog'
import { AgentApiClient, AgentApiError } from '../agent/AgentApiClient'
import { buildDjContext, type VelocityLimits } from '../agent/djContext'
import { captureApplySnapshot, evaluateApply, runApply } from '../agent/applyDecision'
import type { TransitionClient } from '../runtime/transition/TransitionExecutor'
import type { AgentCapability, DjContext, DjIntent } from '../agent/contract'
import type {
  EnergyDirection,
  HarmonicPriority,
  TempoDirection,
} from '@vibraxis/shared/dj'
import { runtimeNow } from '../runtime/createRuntime'

/**
 * AutoDj — the autonomous conductor (Autonomous DJ invariants, 2026-07-21).
 *
 * Vibraxis is a resident DJ, not a mix-proposal tool: once running it keeps
 * selecting, transitioning, and playing WITHOUT any per-mix approval. It reuses
 * the tested primitives (deterministic selection + beat-matched transition) and
 * only adds the loop that fires them at a musically safe moment before the
 * active track's outro. Human input is STEERING (a persistent policy + a request
 * queue), never a confirmation. The only thing surfaced to the user is state:
 * now-playing, next candidate, reflected policy, and the reason a request could
 * not be honored.
 */

export interface AutoDjProps {
  api: AgentApiClient
  capability: AgentCapability | null
  runtimeState: RuntimeState | null
  tracks: CatalogTrack[]
  velocity: VelocityLimits | null
  recentlyPlayedTrackIds: string[] | null
  getApplyClient: () => TransitionClient | null
  /** Bootstraps the set: load + play a track on the given (idle) deck. */
  onBootstrap: (deckId: DeckId, trackId: string) => void
}

/** Persistent steering policy — the reflected result of user requests. */
interface Policy {
  energyDirection: EnergyDirection
  tempoDirection: TempoDirection
  harmonicPriority: HarmonicPriority
  targetEnergy: number | null
  note: string
}

const DEFAULT_POLICY: Policy = {
  energyDirection: 'maintain',
  tempoDirection: 'similar',
  harmonicPriority: 'compatible',
  targetEnergy: null,
  note: 'flowing — no request yet',
}

/** Builds a full DjIntent from the steering policy (+ an optional queued track). */
function policyToIntent(policy: Policy, requestedTrackId: string | null): DjIntent {
  return {
    energyDirection: policy.energyDirection,
    targetEnergy: policy.targetEnergy,
    preferredGenres: [],
    avoidedGenres: [],
    preferredMoods: [],
    avoidedMoods: [],
    tempoDirection: policy.tempoDirection,
    harmonicPriority: policy.harmonicPriority,
    transitionUrgency: 'normal',
    requestedTrackId,
    excludedTrackIds: [],
    rationale: `autonomous set · ${policy.note}`,
    confidence: 0.8,
  }
}

/** Live source position of a deck, in seconds (mirrors App.deckView). */
function deckPosition(state: RuntimeState, id: DeckId): { position: number; duration: number } {
  const deck = state.decks[id]
  const duration = deck.binding?.durationSeconds ?? 0
  const playing = deck.transport.phase === 'playing'
  const elapsed = playing
    ? Math.max(0, runtimeNow() - deck.playback.position.atRuntimeTime) * deck.playback.headVelocity
    : 0
  return { position: Math.min(deck.playback.position.sourceSeconds + elapsed, duration), duration }
}

/** The single deck currently in the playing phase, or null. */
function activePlayingDeck(state: RuntimeState): DeckId | null {
  const a = state.decks.A.transport.phase === 'playing'
  const b = state.decks.B.transport.phase === 'playing'
  if (a && !b) return 'A'
  if (b && !a) return 'B'
  return null
}

// How long before a track's end the conductor must have STARTED the next mix.
// The ramp itself is several bars (~12-15s) and the target deck load/sync needs
// a moment, so we begin with comfortable runway. Tuned live.
const MIX_LEAD_SECONDS = 24
// Do not re-attempt an auto-mix that just failed for this long (avoids a hot
// loop when e.g. the target deck is briefly busy).
const RETRY_COOLDOWN_MS = 4000

export function AutoDj(props: AutoDjProps) {
  const { api, capability, runtimeState, tracks, velocity, recentlyPlayedTrackIds, getApplyClient, onBootstrap } = props

  const [running, setRunning] = useState(false)
  const [policy, setPolicy] = useState<Policy>(DEFAULT_POLICY)
  const [queue, setQueue] = useState<string[]>([])
  const [status, setStatus] = useState<string>('idle')
  const [lastRejection, setLastRejection] = useState<string | null>(null)
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)

  // Refs so the interval callback always sees the latest values without
  // re-arming the timer on every state change.
  const runtimeRef = useRef<RuntimeState | null>(runtimeState)
  const policyRef = useRef(policy)
  const queueRef = useRef(queue)
  const mixingRef = useRef(false)
  const cooldownUntilRef = useRef(0)
  runtimeRef.current = runtimeState
  policyRef.current = policy
  queueRef.current = queue

  const trackById = useMemo(() => {
    const map = new Map<string, CatalogTrack>()
    for (const t of tracks) map.set(t.trackId, t)
    return map
  }, [tracks])

  const performAutoMix = useCallback(async () => {
    const state = runtimeRef.current
    const client = getApplyClient()
    if (state === null || client === null) return
    const ctx = buildDjContext({ runtimeState: state, tracks, velocity, recentlyPlayedTrackIds })
    if (!ctx.ok) {
      setLastRejection(`context: ${ctx.reason.code}`)
      return
    }
    // Consume a queued request only if it is a currently-eligible candidate.
    const candidateIds = new Set(ctx.context.candidates.map((c) => c.trackId))
    const queued = queueRef.current.find((id) => candidateIds.has(id)) ?? null
    const intent = policyToIntent(policyRef.current, queued)

    mixingRef.current = true
    setStatus('selecting the next track…')
    try {
      const res = await api.decide({ route: 'deterministic', context: ctx.context as DjContext, intent })
      if (res.outcome !== 'decided') {
        // Invariant 7: surface why the request/selection could not be executed.
        setLastRejection(`selection: ${res.failure.code}`)
        cooldownUntilRef.current = runtimeNow() * 1000 + RETRY_COOLDOWN_MS
        return
      }
      const snapshot = captureApplySnapshot(ctx.context, state)
      const evaluation = evaluateApply(res.decision, ctx.context, state, snapshot)
      if (evaluation.status !== 'ready') {
        setLastRejection(`mix blocked: ${evaluation.reason.code}`)
        cooldownUntilRef.current = runtimeNow() * 1000 + RETRY_COOLDOWN_MS
        return
      }
      const nextTitle = trackById.get(res.decision.nextTrackId)?.title ?? res.decision.nextTrackId
      setStatus(`mixing into ${nextTitle}…`)
      setLastRejection(null)
      const result = await runApply(client, evaluation.plan, () => {})
      if (result.status === 'completed') {
        if (queued !== null) setQueue((q) => q.filter((id) => id !== queued))
        setStatus(`now playing ${nextTitle}`)
      } else {
        setLastRejection(`mix ${result.status}`)
        cooldownUntilRef.current = runtimeNow() * 1000 + RETRY_COOLDOWN_MS
      }
    } catch (cause) {
      setLastRejection(cause instanceof Error ? cause.message : 'auto-mix failed')
      cooldownUntilRef.current = runtimeNow() * 1000 + RETRY_COOLDOWN_MS
    } finally {
      mixingRef.current = false
    }
  }, [api, tracks, velocity, recentlyPlayedTrackIds, getApplyClient, trackById])

  // Pin the loop to the latest performAutoMix WITHOUT re-arming the timer on
  // every render: getApplyClient (and other props) get a fresh identity each
  // App tick (~100ms), so depending on performAutoMix here would clear+rearm
  // the 400ms interval before it ever fires.
  const performAutoMixRef = useRef(performAutoMix)
  performAutoMixRef.current = performAutoMix

  // The conductor loop: poll the live active-deck position and fire the next
  // mix once we are within the lead window before its outro. Runs only while
  // the set is running.
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => {
      if (mixingRef.current) return
      if (runtimeNow() * 1000 < cooldownUntilRef.current) return
      const state = runtimeRef.current
      if (state === null) return
      const activeId = activePlayingDeck(state)
      if (activeId === null) return
      const inactiveId: DeckId = activeId === 'A' ? 'B' : 'A'
      const inactive = state.decks[inactiveId]
      if (inactive.transport.phase === 'playing' || inactive.load.phase === 'loading') return
      const active = state.decks[activeId]
      if (active.binding === null || active.binding.analysis?.grid.available !== true) return
      const { position, duration } = deckPosition(state, activeId)
      if (duration <= 0) return
      if (duration - position > MIX_LEAD_SECONDS) return
      void performAutoMixRef.current()
    }, 400)
    return () => window.clearInterval(timer)
  }, [running])

  const onStart = () => {
    setLastRejection(null)
    const state = runtimeRef.current
    if (state !== null && activePlayingDeck(state) !== null) {
      setRunning(true)
      setStatus('running')
      return
    }
    // Bootstrap: pick an eligible track and play it on Deck A, then run.
    const first = tracks[0]
    if (!first) {
      setLastRejection('no tracks available to start the set')
      return
    }
    onBootstrap('A', first.trackId)
    setRunning(true)
    setStatus('starting the set…')
  }

  const onStop = () => {
    setRunning(false)
    setStatus('stopped (decks keep playing; PANIC to cut audio)')
  }

  // A request is STEERING, not a play command: GPT-5.6 interprets the sentence
  // into an intent; we fold it into the persistent policy and, if it named a
  // track, enqueue it for the next musical opportunity. Nothing plays now.
  const onRequest = () => {
    const text = chatInput.trim()
    if (text.length === 0 || chatBusy) return
    const state = runtimeRef.current
    if (state === null) return
    const ctx = buildDjContext({ runtimeState: state, tracks, velocity, recentlyPlayedTrackIds })
    if (!ctx.ok) {
      setLastRejection(`context: ${ctx.reason.code}`)
      return
    }
    setChatBusy(true)
    setStatus('reading your request…')
    void api
      .decide({ route: 'gpt56-codex', context: ctx.context, text, fallback: { onProviderFailure: 'deterministic', intent: policyToIntent(policyRef.current, null) } })
      .then((res) => {
        if (res.outcome !== 'decided') {
          setLastRejection(`request: ${res.failure.code}`)
          return
        }
        const iv = res.intent.value
        setPolicy((p) => ({
          energyDirection: iv.energyDirection,
          tempoDirection: iv.tempoDirection,
          harmonicPriority: iv.harmonicPriority,
          targetEnergy: iv.targetEnergy,
          note: iv.rationale,
        }))
        if (iv.requestedTrackId) setQueue((q) => (q.includes(iv.requestedTrackId!) ? q : [...q, iv.requestedTrackId!]))
        setLastRejection(null)
        setChatInput('')
        setStatus(running ? 'running · policy updated' : 'policy updated — press START')
      })
      .catch((cause) => {
        setLastRejection(cause instanceof AgentApiError || cause instanceof Error ? cause.message : 'request failed')
      })
      .finally(() => setChatBusy(false))
  }

  const activeId = runtimeState ? activePlayingDeck(runtimeState) : null
  const nowPlaying = activeId && runtimeState
    ? trackById.get(runtimeState.decks[activeId].binding?.trackId ?? '') ?? null
    : null
  const gpt56 = capability?.availability.gpt56 !== false

  return (
    <section className="autodj" aria-label="Autonomous DJ">
      <div className="autodj__head">
        <div>
          <p className="eyebrow">AUTONOMOUS SET</p>
          <h2>AUTO-DJ</h2>
        </div>
        <span className={`agent-flow agent-flow--${running ? 'mixing' : 'idle'}`}>{running ? 'RUNNING' : 'STOPPED'}</span>
      </div>

      <div className="autodj__state">
        <div className="autodj__now">
          <span className="agent-muted">NOW PLAYING</span>
          <strong>{nowPlaying ? nowPlaying.title : '—'}</strong>
          {nowPlaying && <span className="agent-muted">{nowPlaying.bpm.toFixed(0)} BPM · {nowPlaying.camelot}</span>}
        </div>
        <div className="autodj__status">{status}</div>
      </div>

      <div className="autodj__policy">
        <span className="agent-muted">POLICY</span>
        <span>energy {policy.energyDirection} · tempo {policy.tempoDirection} · key {policy.harmonicPriority}</span>
        <em>“{policy.note}”</em>
      </div>

      {queue.length > 0 && (
        <div className="autodj__queue">
          <span className="agent-muted">QUEUED REQUESTS</span>
          <ul>{queue.map((id) => <li key={id}>{trackById.get(id)?.title ?? id}</li>)}</ul>
        </div>
      )}

      {lastRejection && (
        <div className="agent-note agent-note--warn" role="status">Could not honor: {lastRejection}</div>
      )}

      <div className="autodj__controls">
        {running
          ? <button type="button" className="agent-submit agent-submit--apply" onClick={onStop}>STOP</button>
          : <button type="button" className="agent-submit" onClick={onStart}>START SET</button>}
      </div>

      <form className="autodj__request" onSubmit={(e) => { e.preventDefault(); onRequest() }}>
        <label className="agent-field">
          <span>REQUEST (steers the set — never asks to confirm)</span>
          <div className="autodj__request-row">
            <input
              className="autodj__input"
              type="text"
              value={chatInput}
              placeholder="e.g. keep it moody, then slowly pick it up"
              onChange={(e) => setChatInput(e.target.value)}
            />
            <button type="submit" className="agent-submit" disabled={chatBusy || chatInput.trim().length === 0}>
              {chatBusy ? '…' : 'SEND'}
            </button>
          </div>
        </label>
        {!gpt56 && (
          <div className="agent-note agent-note--warn" role="status">
            Requests are read by GPT-5.6 — set <code>OPENAI_API_KEY</code> to enable natural language (selection still runs without it).
          </div>
        )}
      </form>
    </section>
  )
}
