import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeState, DeckId, LoadResult } from '@vibraxis/shared/vdap'
import type { CatalogTrack } from '../catalog'
import { AgentApiClient, AgentApiError } from '../agent/AgentApiClient'
import { buildDjContext, type VelocityLimits } from '../agent/djContext'
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

// Fallback mix-out lead (seconds before the end), used ONLY when the outgoing
// track has no analysed sections to fire on. Normally the conductor fires at the
// track's OUTRO boundary (see mixOutSeconds), not on a timer.
const MIX_OUT_FALLBACK_LEAD = 20
// Do not re-attempt an auto-mix that just failed for this long (avoids a hot
// loop when e.g. the target deck is briefly busy).
const RETRY_COOLDOWN_MS = 4000

/** Crossfader position that fully favours a deck (runtime convention: A → −1, B → +1). */
function deckSide(deckId: DeckId): number {
  return deckId === 'B' ? 1 : -1
}

// Sections a track is worth mixing INTO — the groove, not an intro/breakdown/build.
// Bringing a track in on its breakdown starts it sparse and it never connects.
const GROOVE_LABELS = new Set(['drop', 'chorus', 'verse'])

/**
 * Mix-IN cue for the incoming track: the head of its first HIGH-ENERGY section
 * (drop / chorus / verse). Skipping the intro AND any leading breakdown/build means
 * the incoming lands on real groove, not dead air or a sparse breakdown. A section
 * head is bar-aligned, so it is also a downbeat. Falls back to the first non-intro
 * section, then the track head.
 */
function mixInCueSeconds(track: CatalogTrack): number {
  const sections = track.sectionSummary
  if (sections.length === 0) return 0
  const groove = sections.find((s) => GROOVE_LABELS.has(s.label.toLowerCase()))
  if (groove) return groove.startSeconds
  const content = sections.find((s) => s.label.toLowerCase() !== 'intro')
  return (content ?? sections[0]).startSeconds
}

/**
 * Mix-OUT point for the outgoing track: ONE bar before its OUTRO boundary. Firing a
 * bar early (a) gives the beat-matched transition real runway so it never runs off
 * the end of the grid mid-switch (which would strand the set with no active deck),
 * and (b) lets the crossfade complete right as the outro lands. Falls back to the
 * last section head, then to a fixed lead before the end when there is no structure.
 */
function mixOutSeconds(track: CatalogTrack, durationSeconds: number): number {
  const sections = track.sectionSummary
  const oneBarSeconds = 240 / track.bpm // 4 beats · 60s, in the track's own timeline
  if (sections.length === 0) return Math.max(0, durationSeconds - MIX_OUT_FALLBACK_LEAD)
  const outro = sections.find((s) => s.label.toLowerCase() === 'outro')
  const boundary = outro ? outro.startSeconds : sections[sections.length - 1].startSeconds
  return Math.max(0, boundary - oneBarSeconds)
}

/**
 * PREPARE (Planner) — done calmly, ahead of time. Load the next track onto the idle
 * deck, cue it to its mix-in point, and tempo-sync it to the live deck. Leaves the
 * deck READY (paused) so the switch itself has ZERO loading latency; nothing can
 * delay the downbeat at fire time. sourceSeconds cue only (bar/beat seeks need grid
 * resolution that can fail immediately after a load).
 */
async function prepareNextDeck(
  client: TransitionClient,
  p: { targetDeckId: DeckId; nextTrackId: string; cueSeconds: number; referenceDeckId: DeckId },
): Promise<{ ok: true; targetBindingId: string } | { ok: false; detail: string }> {
  const load = await (
    await client.mutate('deck.load', { deckId: p.targetDeckId, source: { kind: 'catalog', trackId: p.nextTrackId } }, {})
  ).terminal
  if (load.event !== 'intent.completed') return { ok: false, detail: `load ${load.event}` }
  const targetBindingId = (load.result as LoadResult).binding.bindingId

  if (p.cueSeconds > 0) {
    const cue = await (
      await client.mutate(
        'deck.seek',
        { deckId: p.targetDeckId, target: { type: 'sourceSeconds', sourceSeconds: p.cueSeconds }, resume: 'pause' },
        { expectedBindingId: targetBindingId },
      )
    ).terminal
    if (cue.event !== 'intent.completed') return { ok: false, detail: `cue ${cue.event}` }
  }

  const sync = await (
    await client.mutate(
      'deck.sync',
      { deckId: p.targetDeckId, reference: p.referenceDeckId, mode: 'tempo' },
      { expectedBindingId: targetBindingId },
    )
  ).terminal
  if (sync.event !== 'intent.completed') return { ok: false, detail: `sync ${sync.event}` }
  return { ok: true, targetBindingId }
}

// Crossfade length for the cut, in seconds. The incoming deck is already
// phase-locked to the bar and cued to its groove, so this is a fast slider move on
// the bar line — a sharp cut, not a long blend. Kept as a real equal-power ramp
// (not an instant 0→1 jump) so it never clicks.
const CUT_CROSSFADE_SECONDS = 0.1

/**
 * FIRE (Executor) — the incoming deck is already loaded, cued and tempo-synced. Hand
 * the switch to the runtime's atomic `transition.start`: on the OUTGOING deck's next
 * bar it starts the incoming from its cue (phase-locked to the bar) and slides the
 * crossfader across in {@link CUT_CROSSFADE_SECONDS}s — a sharp on-the-bar cut. Then
 * pause the now-inaudible outgoing deck. No loading happens here, so the beat cannot
 * slip.
 */
async function fireCut(
  client: TransitionClient,
  p: { activeDeckId: DeckId; targetDeckId: DeckId; activeBindingId: string; targetBindingId: string },
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const trans = await (
    await client.mutate('transition.start', {
      activeDeckId: p.activeDeckId,
      activeBindingId: p.activeBindingId,
      targetDeckId: p.targetDeckId,
      targetBindingId: p.targetBindingId,
      at: 'nextBar',
      crossfader: { to: deckSide(p.targetDeckId), duration: { seconds: CUT_CROSSFADE_SECONDS }, curve: 'equalPower' },
    }, {})
  ).terminal
  if (trans.event !== 'intent.completed') return { ok: false, detail: `transition ${trans.event}` }
  await (
    await client.mutate('deck.pause', { deckId: p.activeDeckId }, { expectedBindingId: p.activeBindingId })
  ).terminal
  return { ok: true }
}

export function AutoDj(props: AutoDjProps) {
  const { api, capability, runtimeState, tracks, velocity, recentlyPlayedTrackIds, getApplyClient, onBootstrap } = props

  const [running, setRunning] = useState(false)
  const [policy, setPolicy] = useState<Policy>(DEFAULT_POLICY)
  const [queue, setQueue] = useState<string[]>([])
  const [status, setStatus] = useState<string>('idle')
  const [lastRejection, setLastRejection] = useState<string | null>(null)
  const [chatInput, setChatInput] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  // The next track — already loaded, cued and tempo-synced, WAITING on the idle
  // deck (Planner output). null means nothing is prepared yet.
  const [committedNext, setCommittedNext] = useState<
    { targetDeckId: DeckId; targetBindingId: string; trackId: string; title: string; cueSeconds: number } | null
  >(null)

  // Refs so the interval callback always sees the latest values without
  // re-arming the timer on every state change.
  const runtimeRef = useRef<RuntimeState | null>(runtimeState)
  const policyRef = useRef(policy)
  const queueRef = useRef(queue)
  const mixingRef = useRef(false)
  const preparingRef = useRef(false)
  const committedNextRef = useRef(committedNext)
  const cooldownUntilRef = useRef(0)
  runtimeRef.current = runtimeState
  policyRef.current = policy
  queueRef.current = queue
  committedNextRef.current = committedNext

  const trackById = useMemo(() => {
    const map = new Map<string, CatalogTrack>()
    for (const t of tracks) map.set(t.trackId, t)
    return map
  }, [tracks])

  // PLANNER — choose the next track and PREPARE it (load + cue to its mix-in point
  // + tempo-sync) on the idle deck, calmly and ahead of time. The result waits as
  // `committedNext` until the Executor fires it.
  const prepareNext = useCallback(async (activeDeckId: DeckId) => {
    const state = runtimeRef.current
    const client = getApplyClient()
    if (state === null || client === null) return
    const ctx = buildDjContext({ runtimeState: state, tracks, velocity, recentlyPlayedTrackIds })
    if (!ctx.ok) {
      setLastRejection(`context: ${ctx.reason.code}`)
      cooldownUntilRef.current = runtimeNow() * 1000 + RETRY_COOLDOWN_MS
      return
    }
    // Consume a queued request only if it is a currently-eligible candidate.
    const candidateIds = new Set(ctx.context.candidates.map((c) => c.trackId))
    const queued = queueRef.current.find((id) => candidateIds.has(id)) ?? null
    const intent = policyToIntent(policyRef.current, queued)

    preparingRef.current = true
    setStatus('choosing & cueing the next track…')
    try {
      const res = await api.decide({ route: 'deterministic', context: ctx.context as DjContext, intent })
      if (res.outcome !== 'decided') {
        // Invariant 7: surface why the request/selection could not be executed.
        setLastRejection(`selection: ${res.failure.code}`)
        cooldownUntilRef.current = runtimeNow() * 1000 + RETRY_COOLDOWN_MS
        return
      }
      const nextTrack = trackById.get(res.decision.nextTrackId)
      const title = nextTrack?.title ?? res.decision.nextTrackId
      const cueSeconds = nextTrack ? mixInCueSeconds(nextTrack) : 0
      const prep = await prepareNextDeck(client, {
        targetDeckId: res.decision.targetDeckId,
        nextTrackId: res.decision.nextTrackId,
        cueSeconds,
        referenceDeckId: activeDeckId,
      })
      if (!prep.ok) {
        setLastRejection(`prepare ${prep.detail}`)
        cooldownUntilRef.current = runtimeNow() * 1000 + RETRY_COOLDOWN_MS
        return
      }
      setCommittedNext({
        targetDeckId: res.decision.targetDeckId,
        targetBindingId: prep.targetBindingId,
        trackId: res.decision.nextTrackId,
        title,
        cueSeconds,
      })
      setLastRejection(null)
      setStatus('running · next cued & synced')
    } catch (cause) {
      setLastRejection(cause instanceof Error ? cause.message : 'prepare failed')
      cooldownUntilRef.current = runtimeNow() * 1000 + RETRY_COOLDOWN_MS
    } finally {
      preparingRef.current = false
    }
  }, [api, tracks, velocity, recentlyPlayedTrackIds, getApplyClient, trackById])

  // EXECUTOR — the prepared deck is loaded, cued and synced. Fire the cut on the
  // outgoing track's bar; no loading happens here, so the downbeat cannot slip.
  const fireCommitted = useCallback(async (activeDeckId: DeckId) => {
    const state = runtimeRef.current
    const client = getApplyClient()
    const cn = committedNextRef.current
    if (state === null || client === null || cn === null) return
    const activeBindingId = state.decks[activeDeckId].binding?.bindingId
    if (activeBindingId === undefined || activeBindingId === null) return
    const target = state.decks[cn.targetDeckId]
    // The prepared deck must still hold exactly what we cued; if a user reloaded or
    // started it, drop the plan and re-prepare rather than fire against stale state.
    if (target.binding?.bindingId !== cn.targetBindingId || target.transport.phase === 'playing') {
      setCommittedNext(null)
      return
    }
    mixingRef.current = true
    setStatus(`cut → ${cn.title}`)
    try {
      const result = await fireCut(client, {
        activeDeckId,
        targetDeckId: cn.targetDeckId,
        activeBindingId,
        targetBindingId: cn.targetBindingId,
      })
      if (result.ok) {
        setQueue((q) => q.filter((id) => id !== cn.trackId))
        setCommittedNext(null)
        setStatus(`now playing ${cn.title}`)
      } else {
        setLastRejection(`cut ${result.detail}`)
        cooldownUntilRef.current = runtimeNow() * 1000 + RETRY_COOLDOWN_MS
      }
    } catch (cause) {
      setLastRejection(cause instanceof Error ? cause.message : 'cut failed')
      cooldownUntilRef.current = runtimeNow() * 1000 + RETRY_COOLDOWN_MS
    } finally {
      mixingRef.current = false
    }
  }, [getApplyClient])

  // RECOVERY — if the booth ever goes silent (a track ended before a cut could
  // fire), start the already-prepared next deck immediately and move the crossfader
  // to it. Not beat-matched, but a silent booth is worse than an un-matched save.
  const recoverIdle = useCallback(async () => {
    const state = runtimeRef.current
    const client = getApplyClient()
    const cn = committedNextRef.current
    if (state === null || client === null || cn === null) return
    const target = state.decks[cn.targetDeckId]
    if (target.binding?.bindingId !== cn.targetBindingId || target.transport.phase !== 'ready') return
    mixingRef.current = true
    setStatus(`recovering → ${cn.title}`)
    try {
      const play = await (
        await client.mutate('deck.play', { deckId: cn.targetDeckId }, { expectedBindingId: cn.targetBindingId })
      ).terminal
      if (play.event !== 'intent.completed') return
      await (await client.mutate('mixer.setCrossfader', { position: deckSide(cn.targetDeckId) }, {})).terminal
      setQueue((q) => q.filter((id) => id !== cn.trackId))
      setCommittedNext(null)
      setStatus(`now playing ${cn.title}`)
    } finally {
      mixingRef.current = false
    }
  }, [getApplyClient])

  // Pin the loop to the latest callbacks WITHOUT re-arming the timer on every
  // render (getApplyClient gets a fresh identity each App tick).
  const prepareNextRef = useRef(prepareNext)
  const fireCommittedRef = useRef(fireCommitted)
  const recoverIdleRef = useRef(recoverIdle)
  prepareNextRef.current = prepareNext
  fireCommittedRef.current = fireCommitted
  recoverIdleRef.current = recoverIdle

  // Conductor loop (Planner → Executor). While a track plays: if nothing is
  // prepared, PREPARE the next one now (calm, well ahead); once prepared, wait for
  // the outgoing track's OUTRO boundary and FIRE the already-ready cut.
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => {
      if (mixingRef.current || preparingRef.current) return
      if (runtimeNow() * 1000 < cooldownUntilRef.current) return
      const state = runtimeRef.current
      if (state === null) return
      const activeId = activePlayingDeck(state)
      if (activeId === null) {
        // No audible deck (a track ended before a cut). Save the set if a next
        // track is already prepared and waiting.
        if (committedNextRef.current !== null) void recoverIdleRef.current()
        return
      }
      const inactiveId: DeckId = activeId === 'A' ? 'B' : 'A'
      const active = state.decks[activeId]
      if (active.binding === null || active.binding.analysis?.grid.available !== true) return
      const cn = committedNextRef.current
      if (cn === null) {
        // Nothing prepared yet: plan + cue the next track now, if the idle deck is free.
        const inactive = state.decks[inactiveId]
        if (inactive.transport.phase === 'playing' || inactive.load.phase === 'loading') return
        void prepareNextRef.current(activeId)
        return
      }
      // Ready & waiting: fire once the outgoing track reaches its mix-out boundary.
      if (cn.targetDeckId !== inactiveId) return
      const currentTrack = trackById.get(active.binding.trackId)
      if (currentTrack === undefined) return
      const { position, duration } = deckPosition(state, activeId)
      if (duration <= 0) return
      if (position < mixOutSeconds(currentTrack, duration)) return
      void fireCommittedRef.current(activeId)
    }, 400)
    return () => window.clearInterval(timer)
  }, [running, trackById])

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

      {committedNext && (
        <div className="autodj__policy">
          <span className="agent-muted">NEXT · cued &amp; synced</span>
          <span>{committedNext.title}</span>
        </div>
      )}

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
