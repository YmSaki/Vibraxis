/**
 * Apply-decision seam (Order 7 §5): turns a validated {@link DjDecision} into a
 * {@link TransitionPlan} and drives it through the EXISTING
 * {@link TransitionExecutor}, which mutates the runtime only through the agent
 * MessagePort client (no Runtime bypass).
 *
 * `evaluateApply` is a pure precondition gate: it validates the current binding
 * and freshness of the active track before anything executes, and returns a
 * typed blocked-reason when apply is not safe. The instrumented client observes
 * the real `deck.sync` / `transition.start` terminal completions so the UI can
 * advance SYNCED -> MIXING only on confirmed milestones — never optimistically.
 */

import type { DeckId, DeckState, RuntimeState, VdapMutationCommand } from '@vibraxis/shared/vdap'
import type { DjContext, DjDecision, TransitionPlan } from './contract'
import {
  TransitionExecutor,
  type TransitionClient,
  type TransitionResult,
} from '../runtime/transition/TransitionExecutor'

export type ApplyBlockedCode =
  | 'targetDeckMismatch'
  | 'nextTrackNotCandidate'
  | 'activeBindingMissing'
  | 'staleActiveTrack'
  | 'activeBindingChanged'
  | 'activeDeckChanged'
  | 'activeDeckNotPlaying'
  | 'noBeatGrid'
  | 'inactiveDeckChanged'
  | 'targetDeckBusy'
  | 'crossfaderBusy'

export interface ApplyBlocked {
  code: ApplyBlockedCode
  detail: string
}

export type EvaluateApplyResult =
  | { status: 'ready'; plan: TransitionPlan }
  | { status: 'blocked'; reason: ApplyBlocked }

function blocked(code: ApplyBlockedCode, detail: string): EvaluateApplyResult {
  return { status: 'blocked', reason: { code, detail } }
}

/**
 * The observable state of one deck at the instant a decision was made. Captured
 * up-front (not read live at apply time) so a later user override — reloading a
 * deck, starting playback, kicking off a load — can be DETECTED and rejected
 * instead of being silently overwritten by an APPLY built against stale state
 * (AGENTS.md §0.3/§0.5; Order 7 §5 findings 1 & 2).
 */
export interface ApplyDeckSnapshot {
  bindingId: string | null
  trackId: string | null
  loadPhase: DeckState['load']['phase']
  transportPhase: DeckState['transport']['phase']
  configuredVelocity: number
  tempoInterpretation: DeckState['tempo']['interpretation']
  effectiveBpm: number | null
}

export interface ApplySnapshot {
  active: ApplyDeckSnapshot
  inactive: ApplyDeckSnapshot
  crossfaderAutomationIntentId: string | null
}

function deckSnapshot(deck: DeckState): ApplyDeckSnapshot {
  return {
    bindingId: deck.binding?.bindingId ?? null,
    trackId: deck.binding?.trackId ?? null,
    loadPhase: deck.load.phase,
    transportPhase: deck.transport.phase,
    configuredVelocity: deck.playback.configuredVelocity,
    tempoInterpretation: deck.tempo.interpretation,
    effectiveBpm: deck.tempo.effectiveBpm,
  }
}

/**
 * Records the active + inactive deck state at decision time. The caller keeps
 * this alongside the decision and passes it back to {@link evaluateApply}; the
 * binding ids captured here are the ones the plan will bind to — never a fresh
 * live binding id read at apply time (finding 1).
 */
export function captureApplySnapshot(context: DjContext, runtimeState: RuntimeState): ApplySnapshot {
  return {
    active: deckSnapshot(runtimeState.decks[context.activeDeckId]),
    inactive: deckSnapshot(runtimeState.decks[context.inactiveDeckId]),
    crossfaderAutomationIntentId: runtimeState.mixer.crossfader.automation?.intentId ?? null,
  }
}

function sameDeckSnapshot(a: ApplyDeckSnapshot, b: ApplyDeckSnapshot): boolean {
  return a.bindingId === b.bindingId
    && a.trackId === b.trackId
    && a.loadPhase === b.loadPhase
    && a.transportPhase === b.transportPhase
    && a.configuredVelocity === b.configuredVelocity
    && a.tempoInterpretation === b.tempoInterpretation
    && a.effectiveBpm === b.effectiveBpm
}

/**
 * Validates that the decision can still be applied against the CURRENT runtime
 * state AND that the decks have not diverged from the decision-time snapshot,
 * then builds the transition plan bound to the SNAPSHOT active-deck binding id
 * (verified to still be live). Any divergence is a typed block, never an
 * overwrite of the user's newer state.
 */
export function evaluateApply(
  decision: DjDecision,
  context: DjContext,
  runtimeState: RuntimeState,
  snapshot: ApplySnapshot,
): EvaluateApplyResult {
  const activeDeckId: DeckId = context.activeDeckId
  const inactiveDeckId: DeckId = context.inactiveDeckId

  if (decision.targetDeckId !== inactiveDeckId) {
    return blocked(
      'targetDeckMismatch',
      `Decision targets deck ${decision.targetDeckId} but the inactive deck is ${inactiveDeckId}.`,
    )
  }
  const liveAutomationIntentId = runtimeState.mixer.crossfader.automation?.intentId ?? null
  if (snapshot.crossfaderAutomationIntentId !== null || liveAutomationIntentId !== null) {
    return blocked(
      'crossfaderBusy',
      `Crossfader automation must be idle at decision and apply time (decision=${String(snapshot.crossfaderAutomationIntentId)}, apply=${String(liveAutomationIntentId)}).`,
    )
  }
  if (!context.candidates.some((candidate) => candidate.trackId === decision.nextTrackId)) {
    return blocked('nextTrackNotCandidate', `nextTrackId "${decision.nextTrackId}" is not among the assembled candidates.`)
  }

  const activeDeck = runtimeState.decks[activeDeckId]
  const binding = activeDeck.binding
  if (binding === null) {
    return blocked('activeBindingMissing', `The active deck ${activeDeckId} has no bound track.`)
  }
  if (binding.trackId !== context.currentTrack.trackId) {
    return blocked(
      'staleActiveTrack',
      `The active deck now holds "${binding.trackId}" but the decision was built for "${context.currentTrack.trackId}".`,
    )
  }
  const snapshotBindingId = snapshot.active.bindingId
  if (snapshotBindingId === null) {
    return blocked(
      'activeBindingChanged',
      `The decision-time snapshot for active deck ${activeDeckId} has no binding id.`,
    )
  }
  // Same trackId but a different bindingId means the active deck was reloaded
  // (e.g. re-dropped the same track) after the decision. The plan must bind to
  // the decision-time binding, so this is stale — reject rather than adopt the
  // new binding (finding 1).
  if (binding.bindingId !== snapshotBindingId) {
    return blocked(
      'activeBindingChanged',
      `The active deck ${activeDeckId} was reloaded since the decision (binding ${snapshotBindingId} -> ${binding.bindingId}).`,
    )
  }
  if (activeDeck.transport.phase !== 'playing') {
    return blocked('activeDeckNotPlaying', `The active deck ${activeDeckId} is no longer playing.`)
  }
  const liveActive = deckSnapshot(activeDeck)
  if (!sameDeckSnapshot(liveActive, snapshot.active)) {
    return blocked(
      'activeDeckChanged',
      `The active deck ${activeDeckId} changed since the decision (tempo ${String(snapshot.active.effectiveBpm)} BPM/${snapshot.active.tempoInterpretation}/${snapshot.active.configuredVelocity}x -> ${String(liveActive.effectiveBpm)} BPM/${liveActive.tempoInterpretation}/${liveActive.configuredVelocity}x).`,
    )
  }
  if (binding.analysis?.grid.available !== true) {
    return blocked(
      'noBeatGrid',
      `The active deck ${activeDeckId} has no usable beat grid, so a nextBar transition boundary cannot be resolved.`,
    )
  }
  // The inactive deck is the mix target and the transition will load into it.
  // If the user loaded another track, started playback, or began a load on it
  // since the decision, honouring the plan would overwrite that newer action;
  // reject instead (finding 2).
  const liveInactive = deckSnapshot(runtimeState.decks[inactiveDeckId])
  if (!sameDeckSnapshot(liveInactive, snapshot.inactive)) {
    return blocked(
      'inactiveDeckChanged',
      `The target deck ${inactiveDeckId} changed since the decision (track ${String(snapshot.inactive.trackId)}/${snapshot.inactive.transportPhase} -> ${String(liveInactive.trackId)}/${liveInactive.transportPhase}).`,
    )
  }
  if (runtimeState.decks[inactiveDeckId].load.phase === 'loading') {
    return blocked('targetDeckBusy', `The target deck ${inactiveDeckId} is currently loading.`)
  }
  if (runtimeState.decks[inactiveDeckId].transport.phase === 'playing') {
    return blocked('targetDeckBusy', `The target deck ${inactiveDeckId} is currently playing.`)
  }

  const plan: TransitionPlan = {
    fromTrackId: binding.trackId,
    // The decision-time binding id (verified above to still be live), never a
    // freshly-read live binding id.
    fromBindingId: snapshotBindingId,
    expectedRevision: runtimeState.revision,
    targetBindingId: snapshot.inactive.bindingId,
    activeDeckId,
    nextTrackId: decision.nextTrackId,
    targetDeckId: decision.targetDeckId,
    tempoSync: decision.tempoSync,
    startAt: decision.startAt,
    crossfadeBars: decision.crossfadeBars,
    confidence: decision.confidence,
    reasons: [...decision.reasons],
  }
  return { status: 'ready', plan }
}

export type ApplyMilestone =
  | { type: 'synced' }
  | { type: 'transitionAccepted'; intentId: string }

/**
 * Wraps a {@link TransitionClient} so a caller is notified when the real
 * `deck.sync` and `transition.start` steps reach `intent.completed`. The wrapper
 * never changes what is sent; it only observes terminal events the runtime
 * already emits.
 */
export function instrumentTransitionClient(
  client: TransitionClient,
  onMilestone: (milestone: ApplyMilestone) => void,
): TransitionClient {
  return {
    mutate(command, params, options) {
      const handlePromise = client.mutate(command, params, options)
      if (command === 'transition.start') {
        void handlePromise.then(
          (handle) => onMilestone({ type: 'transitionAccepted', intentId: handle.ack.intentId }),
          () => {},
        )
      }
      const milestone = milestoneFor(command)
      if (milestone !== null) {
        void handlePromise.then((handle) => {
          handle.terminal.then(
            (event) => {
              if (event.event === 'intent.completed') onMilestone({ type: milestone })
            },
            () => {
              // Terminal rejection/failure is reported through the executor's
              // result; nothing to observe here.
            },
          )
        }, () => {})
      }
      return handlePromise
    },
  }
}

function milestoneFor(command: VdapMutationCommand): 'synced' | null {
  if (command === 'deck.sync') return 'synced'
  return null
}

/**
 * Runs a plan through the existing executor with milestone instrumentation.
 * Returns the executor's real {@link TransitionResult} verbatim.
 */
export async function runApply(
  client: TransitionClient,
  plan: TransitionPlan,
  onMilestone: (milestone: ApplyMilestone) => void,
): Promise<TransitionResult> {
  const executor = new TransitionExecutor(instrumentTransitionClient(client, onMilestone))
  return executor.run(plan)
}
