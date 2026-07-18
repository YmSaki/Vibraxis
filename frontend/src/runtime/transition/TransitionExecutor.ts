/**
 * TransitionExecutor — converts one validated {@link TransitionPlan} into the
 * concrete VDAP command sequence that performs a minimal beat transition
 * (roadmap 順序4). It owns no audio state of its own; it drives the runtime
 * through the agent MessagePort client and reacts to real terminal events.
 *
 * Ordering (VDAP 実装順 §5.5):
 *   1. record active/inactive decks + current binding
 *   2. load the next track into the inactive deck, capture its confirmed bindingId
 *   3. apply an exact tempo-only sync (out-of-range requests are rejected)
 *   4. send one transition.start command; Runtime resolves one nextBar boundary
 *      and atomically reserves target playback plus the equal-power ramp there
 *   5. pause the active deck ONLY after the ramp completes
 *   6. on any failure, cancel outstanding reservations, pause the inactive deck,
 *      return the crossfader to the active side, and keep the active deck playing
 *   7. re-check expectedBindingId at every deck step and yield to user override
 *
 * The executor never reports a stage it did not observe as completed, and never
 * downgrades a rejected/failed step into a success (AGENTS §0).
 */

import type {
  CommandResult,
  DeckId,
  IntentCancelReason,
  LoadResult,
  RampCrossfaderResult,
  RequestFor,
  SyncResult,
  VdapError,
  VdapMutationCommand,
} from '@vibraxis/shared/vdap'
import type { TransitionPlan } from '@vibraxis/shared/dj'
import { VdapClientError, type IntentTerminalEvent, type MutationHandle, type MutationOptionsFor } from '../VdapClient'

/** Minimal client surface the executor needs; satisfied by {@link VdapClient}. */
export interface TransitionClient {
  mutate<C extends VdapMutationCommand>(
    command: C,
    params: RequestFor<C>['params'],
    options?: MutationOptionsFor<C>,
  ): Promise<MutationHandle>
}

export type TransitionStage = 'load' | 'sync' | 'start' | 'ramp' | 'pauseActive'

export type TransitionResult =
  | { status: 'completed'; bindingId: string; sync: SyncResult | null; ramp: RampCrossfaderResult }
  /** A step was cancelled (e.g. user override); the executor yields without fighting the user. */
  | { status: 'cancelled'; stage: TransitionStage; reason: IntentCancelReason }
  /**
   * A step was rejected/failed. `rolledBack` is true ONLY when cleanup ran and
   * every cleanup step reached a terminal `completed`; if any cleanup step was
   * itself rejected/failed/cancelled it is false and `cleanupErrors` lists the
   * failures (AGENTS §0.5/§0.10). Finding 4.
   */
  | { status: 'failed'; stage: TransitionStage; error: VdapError; rolledBack: boolean; cleanupErrors?: VdapError[] }

type StepOutcome =
  | { kind: 'completed'; result: CommandResult; revision: number }
  | { kind: 'cancelled'; reason: IntentCancelReason }
  | { kind: 'failed'; error: VdapError }

const INTERNAL_ERROR = (message: string): VdapError => ({ code: 'E_INTERNAL', message, retryable: false })

export class TransitionExecutor {
  constructor(private readonly client: TransitionClient) {}

  async run(plan: TransitionPlan): Promise<TransitionResult> {
    const active = plan.activeDeckId
    const target = plan.targetDeckId
    if (active === target) {
      return { status: 'failed', stage: 'load', error: INTERNAL_ERROR('active and target decks must differ.'), rolledBack: false }
    }
    const targetSide = deckSide(target)
    const activeSide = deckSide(active)

    // Stage 2 — load the next track and capture the confirmed bindingId.
    const load = await this.step(() =>
      this.client.mutate('deck.load', { deckId: target, source: { kind: 'catalog', trackId: plan.nextTrackId } }),
    )
    if (load.kind !== 'completed') {
      // Nothing on the active deck changed, so there is nothing to roll back.
      return this.nonCompleted('load', load, false)
    }
    const bindingId = (load.result as LoadResult).binding.bindingId

    // Stage 3 — exact tempo-only sync. Out-of-range sync is rejected upstream.
    let sync: SyncResult | null = null
    if (plan.tempoSync === 'tempo') {
      const outcome = await this.step(() =>
        this.client.mutate('deck.sync', { deckId: target, reference: active, mode: 'tempo' }, { expectedBindingId: bindingId }),
      )
      if (outcome.kind !== 'completed') {
        const cleanup = await this.rollback(target, activeSide, bindingId)
        return this.nonCompleted('sync', outcome, cleanup.ok, cleanup.errors)
      }
      sync = outcome.result as SyncResult
    }

    // Stage 4 — one Runtime Intent owns one boundary and both audio side effects.
    const transition = await this.step(() => this.client.mutate('transition.start', {
      activeDeckId: active,
      activeBindingId: plan.fromBindingId,
      targetDeckId: target,
      targetBindingId: bindingId,
      at: plan.startAt,
      crossfader: {
        to: targetSide,
        duration: { bars: plan.crossfadeBars },
        curve: 'equalPower',
      },
    }))
    if (transition.kind !== 'completed') {
      return this.settleNonCompleted('start', transition, target, activeSide, bindingId)
    }

    // Stage 5 — pause the active deck ONLY after the ramp completed, and only if
    // its binding is still the one this transition started from. If the user
    // reloaded the active deck mid-transition, expectedBindingId makes the pause
    // fail (E_BINDING_MISMATCH) instead of silencing the user's new track (finding 6).
    const pause = await this.step(() =>
      this.client.mutate('deck.pause', { deckId: active }, {
        expectedBindingId: plan.fromBindingId,
        expectedRevision: transition.revision,
      }),
    )
    if (pause.kind !== 'completed') {
      // The mix already happened; do not claim success, but the active deck is
      // still audible, so there is no safe rollback that unwinds the ramp.
      return this.nonCompleted('pauseActive', pause, false)
    }
    return { status: 'completed', bindingId, sync, ramp: transition.result as RampCrossfaderResult }
  }

  /** Cancelled steps → yield to the user; failed steps → roll back the mix. */
  private async settleNonCompleted(
    stage: TransitionStage,
    outcome: StepOutcome,
    target: DeckId,
    activeSide: number,
    targetBindingId: string,
  ): Promise<TransitionResult> {
    if (outcome.kind === 'cancelled') {
      // A user override already owns this domain; do not force the crossfader or
      // pause the active deck. Yield cleanly.
      return { status: 'cancelled', stage, reason: outcome.reason }
    }
    const cleanup = await this.rollback(target, activeSide, targetBindingId)
    return this.nonCompleted(stage, outcome, cleanup.ok, cleanup.errors)
  }

  private nonCompleted(
    stage: TransitionStage,
    outcome: StepOutcome,
    rolledBack: boolean,
    cleanupErrors: readonly VdapError[] = [],
  ): TransitionResult {
    if (outcome.kind === 'cancelled') return { status: 'cancelled', stage, reason: outcome.reason }
    const error = outcome.kind === 'failed'
      ? outcome.error
      : INTERNAL_ERROR('Unexpected completed outcome in failure path.')
    return { status: 'failed', stage, error, rolledBack, ...cleanupField({ ok: rolledBack, errors: cleanupErrors }) }
  }

  /**
   * Pause the inactive deck and return the crossfader to the active side. The
   * active deck's binding and playback are deliberately left untouched. The
   * inactive pause carries the loaded bindingId as `expectedBindingId` so a user
   * reload of the inactive deck during cleanup is not silenced (finding 4/6).
   * Reports `ok` only when BOTH cleanup steps reached a terminal `completed`;
   * otherwise callers must not claim the mix was rolled back (AGENTS §0.10).
   */
  private async rollback(
    target: DeckId,
    activeSide: number,
    targetBindingId: string,
  ): Promise<{ ok: boolean; errors: VdapError[] }> {
    const errors: VdapError[] = []
    const pause = await this.step(() =>
      this.client.mutate('deck.pause', { deckId: target }, { expectedBindingId: targetBindingId }),
    )
    if (pause.kind === 'failed') errors.push(pause.error)
    const fader = await this.step(() => this.client.mutate('mixer.setCrossfader', { position: activeSide }))
    if (fader.kind === 'failed') errors.push(fader.error)
    return { ok: pause.kind === 'completed' && fader.kind === 'completed', errors }
  }

  private async step(begin: () => Promise<MutationHandle>): Promise<StepOutcome> {
    let handle: MutationHandle
    try {
      handle = await begin()
    } catch (cause) {
      return { kind: 'failed', error: errorFrom(cause) }
    }
    return this.awaitTerminal(handle.terminal)
  }

  private async awaitTerminal(terminal: Promise<IntentTerminalEvent>): Promise<StepOutcome> {
    let event: IntentTerminalEvent
    try {
      event = await terminal
    } catch (cause) {
      return { kind: 'failed', error: errorFrom(cause) }
    }
    if (event.event === 'intent.completed') return { kind: 'completed', result: event.result, revision: event.revision }
    if (event.event === 'intent.cancelled') return { kind: 'cancelled', reason: event.reason }
    if (event.event === 'intent.superseded') return { kind: 'cancelled', reason: 'bindingChanged' }
    return { kind: 'failed', error: event.error }
  }

}

/** Crossfader position that fully favours a deck: A → −1, B → +1. */
function deckSide(deckId: DeckId): number {
  return deckId === 'B' ? 1 : -1
}

/** Attaches `cleanupErrors` to a failed result only when cleanup actually failed. */
function cleanupField(cleanup: { ok: boolean; errors: readonly VdapError[] }): { cleanupErrors?: VdapError[] } {
  return cleanup.errors.length > 0 ? { cleanupErrors: [...cleanup.errors] } : {}
}

function errorFrom(cause: unknown): VdapError {
  if (cause instanceof VdapClientError && cause.ack) return cause.ack.error
  if (cause instanceof Error) return INTERNAL_ERROR(cause.message)
  return INTERNAL_ERROR('Unknown transition failure.')
}
