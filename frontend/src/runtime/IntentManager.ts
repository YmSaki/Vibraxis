import {
  VDAP_VERSION,
  type CommandResult,
  type DeckId,
  type IntentCancelReason,
  type IntentCancelledEvent,
  type IntentCompletedEvent,
  type IntentDomain,
  type IntentFailedEvent,
  type IntentId,
  type IntentState,
  type IntentSupersededEvent,
  type IntentTarget,
  type ImmediateWhen,
  type P0When,
  type RequestId,
  type RuntimeState,
  type ScheduleCancelFilter,
  type ScheduledFor,
  type VdapError,
  type VdapMutationCommand,
  type VdapOrigin,
} from '@vibraxis/shared/vdap'

export type IntentStateMap = Record<IntentId, IntentState>
export type RuntimeStateEffect = (draft: RuntimeState) => void

export type IntentCommit = {
  revision: number
  runtimeTime: number
}

export type IntentTransactionPlan<T> = {
  intents: IntentStateMap
  value: T
}

export type IntentTransactionResult<T> = IntentCommit & { value: T }

/**
 * RuntimeStore integration boundary. The adapter MUST evaluate `prepare`
 * synchronously against the current top-level Intent map. When it returns a
 * plan, the adapter applies both the new map and `effect` to one RuntimeState
 * draft and commits them with one revision. A null plan performs no commit.
 */
export interface IntentStateAdapter {
  transaction<T>(
    prepare: (
      current: Readonly<IntentStateMap>,
    ) => IntentTransactionPlan<T> | null,
    effect?: RuntimeStateEffect,
  ): IntentTransactionResult<T> | null
}

export type GeneralMutationCommand = Exclude<
  VdapMutationCommand,
  'deck.load' | 'deck.unload'
>
export type GeneralIntentDomain = Exclude<IntentDomain, 'binding'>

export type AcceptIntentInput = {
  requestId: RequestId
  command: GeneralMutationCommand
  origin: VdapOrigin
  target: IntentTarget
  domain: GeneralIntentDomain
  when?: P0When
  scheduledFor?: ScheduledFor
}

export type BindingSupersessionInput = {
  requestId: RequestId
  command: 'deck.load' | 'deck.unload'
  origin: VdapOrigin
  domain: 'binding'
  target: { deckId: DeckId }
  when?: ImmediateWhen
  scheduledFor?: ScheduledFor
}

type InternalAcceptIntentInput = AcceptIntentInput | BindingSupersessionInput

export type AcceptedIntent = {
  accepted: true
  intent: IntentState
  revision: number
  runtimeTime: number
  cancelled: IntentCancelledEvent[]
}

export type AcceptedBindingSupersession = AcceptedIntent & {
  cancelled: []
  superseded: IntentSupersededEvent[]
}

export type RejectedIntent = {
  accepted: false
  error: 'E_USER_PRIORITY'
  blockingIntentIds: IntentId[]
}

export type AcceptIntentResult = AcceptedIntent | RejectedIntent
export type BindingSupersessionResult = AcceptedBindingSupersession | RejectedIntent
export type IntentTransition = IntentCommit & { intent: IntentState }

export type CancelByFilterResult = {
  cancelledCount: number
  skippedCount: number
  events: IntentCancelledEvent[]
}

export type CancelMatchingResult = CancelByFilterResult

export type CompleteWithCancellationResult = {
  terminal: IntentCompletedEvent
  cancelled: IntentCancelledEvent[]
}

export type CompleteWithFilteredCancellationResult = CompleteWithCancellationResult & {
  cancelledCount: number
  skippedCount: number
}

export type IntentManagerOptions = {
  state: IntentStateAdapter
  nextIntentId: () => IntentId
}

type IntentTerminalEvent =
  | IntentCompletedEvent
  | IntentFailedEvent
  | IntentCancelledEvent
  | IntentSupersededEvent

type ConflictPolicy = 'userOverride' | 'bindingSupersession'

type InternalAcceptance = {
  intent: IntentState
  cancelled: IntentState[]
  superseded: IntentState[]
}

export class IntentManager {
  private readonly state: IntentStateAdapter
  private readonly nextIntentId: () => IntentId
  private readonly terminalIntentIds = new Set<IntentId>()

  constructor(options: IntentManagerOptions) {
    this.state = options.state
    this.nextIntentId = options.nextIntentId
  }

  accept(input: AcceptIntentInput, effect?: RuntimeStateEffect): AcceptIntentResult {
    if (
      (input.command as VdapMutationCommand) === 'deck.load'
      || (input.command as VdapMutationCommand) === 'deck.unload'
      || (input.domain as IntentDomain) === 'binding'
    ) {
      throw new TypeError(
        'Binding commands must use acceptBindingSupersession().',
      )
    }
    const transaction = this.acceptWithPolicy(input, 'userOverride', effect)
    if (!transaction.accepted) return transaction

    const { intent, cancelled } = transaction.value
    return {
      accepted: true,
      intent,
      revision: transaction.revision,
      runtimeTime: transaction.runtimeTime,
      cancelled: cancelled.map((candidate) =>
        cancelledEvent(candidate, 'userOverride', transaction),
      ),
    }
  }

  /** Accepts an emergency command without applying normal conflict priority. */
  acceptUncontested(
    input: AcceptIntentInput,
    effect?: RuntimeStateEffect,
  ): AcceptedIntent {
    const intentId = this.nextIntentId()
    const when = input.when ?? { at: 'immediate' }
    const intent: IntentState = {
      intentId,
      requestId: input.requestId,
      command: input.command,
      origin: input.origin,
      state: when.at === 'immediate' ? 'executing' : 'scheduled',
      target: input.target,
      domain: input.domain,
      when,
      ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
    }
    const transaction = this.state.transaction((current) => {
      if (current[intentId] || this.terminalIntentIds.has(intentId)) {
        throw new Error(`Intent id '${intentId}' has already been used.`)
      }
      return { intents: { ...current, [intentId]: intent }, value: intent }
    }, effect)
    if (!transaction) throw new Error('Emergency Intent acceptance unexpectedly failed.')
    return {
      accepted: true,
      intent: transaction.value,
      revision: transaction.revision,
      runtimeTime: transaction.runtimeTime,
      cancelled: [],
    }
  }

  /**
   * Accepts a load/unload and atomically supersedes prior live deck.load
   * Intents. Callers must use this instead of generic `accept` for binding
   * replacement; generic acceptance deliberately never emits userOverride for
   * the binding domain.
   */
  acceptBindingSupersession(
    input: BindingSupersessionInput,
    effect?: RuntimeStateEffect,
  ): BindingSupersessionResult {
    const transaction = this.acceptWithPolicy(input, 'bindingSupersession', effect)
    if (!transaction.accepted) return transaction

    const { intent, superseded } = transaction.value
    return {
      accepted: true,
      intent,
      revision: transaction.revision,
      runtimeTime: transaction.runtimeTime,
      cancelled: [],
      superseded: superseded.map((candidate) =>
        supersededEvent(candidate, intent.intentId, transaction),
      ),
    }
  }

  markExecuting(
    intentId: IntentId,
    effect?: RuntimeStateEffect,
  ): IntentTransition | null {
    const transaction = this.state.transaction((current) => {
      const existing = current[intentId]
      if (!existing || existing.state !== 'scheduled' || this.terminalIntentIds.has(intentId)) {
        return null
      }

      const intent: IntentState = { ...existing, state: 'executing' }
      return { intents: { ...current, [intentId]: intent }, value: intent }
    }, effect)

    return transaction
      ? {
          revision: transaction.revision,
          runtimeTime: transaction.runtimeTime,
          intent: transaction.value,
        }
      : null
  }

  complete(
    intentId: IntentId,
    result: CommandResult = {},
    degraded?: 'immediate',
    effect?: RuntimeStateEffect,
  ): IntentCompletedEvent | null {
    return this.terminate(intentId, (intent, commit) => ({
      vdap: VDAP_VERSION,
      kind: 'event',
      event: 'intent.completed',
      intentId: intent.intentId,
      requestId: intent.requestId,
      revision: commit.revision,
      runtimeTime: commit.runtimeTime,
      result,
      ...(degraded ? { degraded } : {}),
    }), effect)
  }

  completeWithCancellation(
    intentId: IntentId,
    predicate: (intent: Readonly<IntentState>) => boolean,
    reason: IntentCancelReason,
    result: CommandResult = {},
    effect?: RuntimeStateEffect,
  ): CompleteWithCancellationResult | null {
    if (this.terminalIntentIds.has(intentId)) return null
    const transaction = this.state.transaction((current) => {
      const completing = current[intentId]
      if (!completing || this.terminalIntentIds.has(intentId)) return null
      const cancelled = Object.values(current).filter((intent) =>
        intent.intentId !== intentId && predicate(intent),
      )
      const intents = { ...current }
      delete intents[intentId]
      for (const intent of cancelled) delete intents[intent.intentId]
      return { intents, value: { completing, cancelled } }
    }, effect)
    if (!transaction) return null

    this.terminalIntentIds.add(intentId)
    for (const intent of transaction.value.cancelled) {
      this.terminalIntentIds.add(intent.intentId)
    }
    return {
      terminal: {
        vdap: VDAP_VERSION,
        kind: 'event',
        event: 'intent.completed',
        intentId: transaction.value.completing.intentId,
        requestId: transaction.value.completing.requestId,
        revision: transaction.revision,
        runtimeTime: transaction.runtimeTime,
        result,
      },
      cancelled: transaction.value.cancelled.map((intent) =>
        cancelledEvent(intent, reason, transaction),
      ),
    }
  }

  completeWithFilteredCancellation(
    intentId: IntentId,
    filter: ScheduleCancelFilter,
    reason: IntentCancelReason,
    requesterOrigin: VdapOrigin,
    effect?: RuntimeStateEffect,
  ): CompleteWithFilteredCancellationResult | null {
    if (this.terminalIntentIds.has(intentId)) return null
    const transaction = this.state.transaction((current) => {
      const completing = current[intentId]
      if (!completing || this.terminalIntentIds.has(intentId)) return null
      // The command performing the cancellation is never part of its own
      // match set, including for `{ all: true }`.
      const matches = Object.values(current).filter((intent) =>
        intent.intentId !== intentId && matchesFilter(intent, filter),
      )
      const cancelled = matches.filter((intent) =>
        isCancellablePendingWork(intent)
        && (requesterOrigin !== 'agent' || intent.origin !== 'user'),
      )
      const skippedCount = matches.length - cancelled.length
      const intents = { ...current }
      delete intents[intentId]
      for (const intent of cancelled) delete intents[intent.intentId]
      return {
        intents,
        value: { completing, cancelled, skippedCount },
      }
    }, effect)
    if (!transaction) return null

    this.terminalIntentIds.add(intentId)
    for (const intent of transaction.value.cancelled) {
      this.terminalIntentIds.add(intent.intentId)
    }
    const cancelledCount = transaction.value.cancelled.length
    return {
      terminal: {
        vdap: VDAP_VERSION,
        kind: 'event',
        event: 'intent.completed',
        intentId: transaction.value.completing.intentId,
        requestId: transaction.value.completing.requestId,
        revision: transaction.revision,
        runtimeTime: transaction.runtimeTime,
        result: {
          cancelledCount,
          skippedCount: transaction.value.skippedCount,
        },
      },
      cancelled: transaction.value.cancelled.map((intent) =>
        cancelledEvent(intent, reason, transaction),
      ),
      cancelledCount,
      skippedCount: transaction.value.skippedCount,
    }
  }

  fail(
    intentId: IntentId,
    error: VdapError,
    result?: CommandResult,
    effect?: RuntimeStateEffect,
  ): IntentFailedEvent | null {
    return this.terminate(intentId, (intent, commit) => ({
      vdap: VDAP_VERSION,
      kind: 'event',
      event: 'intent.failed',
      intentId: intent.intentId,
      requestId: intent.requestId,
      revision: commit.revision,
      runtimeTime: commit.runtimeTime,
      error,
      ...(result ? { result } : {}),
    }), effect)
  }

  cancel(
    intentId: IntentId,
    reason: IntentCancelReason,
    result?: CommandResult,
    effect?: RuntimeStateEffect,
  ): IntentCancelledEvent | null {
    return this.terminate(intentId, (intent, commit) => ({
      ...cancelledEvent(intent, reason, commit),
      ...(result ? { result } : {}),
    }), effect)
  }

  supersede(
    intentId: IntentId,
    supersededBy: IntentId,
    effect?: RuntimeStateEffect,
  ): IntentSupersededEvent | null {
    return this.terminate(
      intentId,
      (intent, commit) => supersededEvent(intent, supersededBy, commit),
      effect,
    )
  }

  cancelByFilter(
    filter: ScheduleCancelFilter,
    reason: IntentCancelReason,
    requesterOrigin: VdapOrigin,
    effect?: RuntimeStateEffect,
  ): CancelByFilterResult {
    let skippedCount = 0
    const transaction = this.state.transaction((current) => {
      const matches = Object.values(current).filter((intent) => matchesFilter(intent, filter))
      const selected = matches.filter((intent) =>
        isCancellablePendingWork(intent)
        && (requesterOrigin !== 'agent' || intent.origin !== 'user'),
      )
      skippedCount = matches.length - selected.length
      if (selected.length === 0) return null

      const intents = { ...current }
      for (const intent of selected) delete intents[intent.intentId]
      return { intents, value: selected }
    }, effect)

    if (!transaction) return { cancelledCount: 0, skippedCount, events: [] }

    for (const intent of transaction.value) this.terminalIntentIds.add(intent.intentId)
    return {
      cancelledCount: transaction.value.length,
      skippedCount,
      events: transaction.value.map((intent) =>
        cancelledEvent(intent, reason, transaction),
      ),
    }
  }

  cancelMatching(
    predicate: (intent: Readonly<IntentState>) => boolean,
    reason: IntentCancelReason,
    effect?: RuntimeStateEffect,
  ): CancelMatchingResult {
    const transaction = this.state.transaction((current) => {
      const selected = Object.values(current).filter(predicate)
      if (selected.length === 0) return null
      const intents = { ...current }
      for (const intent of selected) delete intents[intent.intentId]
      return { intents, value: selected }
    }, effect)
    if (!transaction) return { cancelledCount: 0, skippedCount: 0, events: [] }

    for (const intent of transaction.value) this.terminalIntentIds.add(intent.intentId)
    return {
      cancelledCount: transaction.value.length,
      skippedCount: 0,
      events: transaction.value.map((intent) =>
        cancelledEvent(intent, reason, transaction),
      ),
    }
  }

  private acceptWithPolicy(
    input: InternalAcceptIntentInput,
    policy: ConflictPolicy,
    effect?: RuntimeStateEffect,
  ):
    | ({ accepted: true } & IntentTransactionResult<InternalAcceptance>)
    | RejectedIntent {
    const intentId = this.nextIntentId()
    const when = input.when ?? { at: 'immediate' }
    const intent: IntentState = {
      intentId,
      requestId: input.requestId,
      command: input.command,
      origin: input.origin,
      state: when.at === 'immediate' ? 'executing' : 'scheduled',
      target: input.target,
      domain: input.domain,
      when,
      ...(input.scheduledFor ? { scheduledFor: input.scheduledFor } : {}),
    }

    let blockingIntentIds: IntentId[] = []
    const transaction = this.state.transaction((current) => {
      if (current[intentId] || this.terminalIntentIds.has(intentId)) {
        throw new Error(`Intent id '${intentId}' has already been used.`)
      }

      const conflicts = Object.values(current).filter((candidate) =>
        intentsConflict(candidate, intent),
      )
      if (input.origin === 'agent') {
        blockingIntentIds = conflicts
          .filter((candidate) => candidate.origin === 'user')
          .map((candidate) => candidate.intentId)
        if (blockingIntentIds.length > 0) return null
      }

      const cancelled = policy === 'userOverride'
        && input.origin === 'user'
        && input.domain !== 'binding'
        ? conflicts.filter(
            (candidate) => candidate.origin === 'agent' && isCancellablePendingWork(candidate),
          )
        : []
      const superseded = policy === 'bindingSupersession'
        ? conflicts.filter((candidate) => candidate.command === 'deck.load')
        : []

      const intents = { ...current }
      for (const candidate of [...cancelled, ...superseded]) {
        delete intents[candidate.intentId]
      }
      intents[intentId] = intent
      return { intents, value: { intent, cancelled, superseded } }
    }, effect)

    if (!transaction) {
      return { accepted: false, error: 'E_USER_PRIORITY', blockingIntentIds }
    }

    for (const candidate of [
      ...transaction.value.cancelled,
      ...transaction.value.superseded,
    ]) {
      this.terminalIntentIds.add(candidate.intentId)
    }
    return { accepted: true, ...transaction }
  }

  private terminate<T extends IntentTerminalEvent>(
    intentId: IntentId,
    buildEvent: (intent: IntentState, commit: IntentCommit) => T,
    effect?: RuntimeStateEffect,
  ): T | null {
    if (this.terminalIntentIds.has(intentId)) return null

    const transaction = this.state.transaction((current) => {
      const existing = current[intentId]
      if (!existing || this.terminalIntentIds.has(intentId)) return null
      const intents = { ...current }
      delete intents[intentId]
      return { intents, value: existing }
    }, effect)

    if (!transaction) return null
    this.terminalIntentIds.add(intentId)
    return buildEvent(transaction.value, transaction)
  }
}

function isCancellablePendingWork(intent: IntentState): boolean {
  return intent.state === 'scheduled'
    || (intent.state === 'executing' && intent.command === 'mixer.rampCrossfader')
}

function intentsConflict(left: IntentState, right: IntentState): boolean {
  return left.domain === right.domain && targetKey(left.target) === targetKey(right.target)
}

function targetKey(target: IntentTarget): string {
  if ('deckId' in target) return `deck:${target.deckId}`
  if ('mixer' in target) return `mixer:${target.mixer}`
  if ('scope' in target) return `scope:${target.scope}`
  if ('connectionId' in target) return `connection:${target.connectionId}`
  return 'runtime'
}

function matchesFilter(intent: IntentState, filter: ScheduleCancelFilter): boolean {
  if ('intentId' in filter && filter.intentId !== undefined) {
    return intent.intentId === filter.intentId
  }
  if ('all' in filter && filter.all === true) return true
  if ('deckId' in filter && filter.deckId !== undefined) {
    return 'deckId' in intent.target
      && intent.target.deckId === filter.deckId
      && (!filter.domain || intent.domain === filter.domain)
  }
  return false
}

function cancelledEvent(
  intent: IntentState,
  reason: IntentCancelReason,
  commit: IntentCommit,
): IntentCancelledEvent {
  return {
    vdap: VDAP_VERSION,
    kind: 'event',
    event: 'intent.cancelled',
    intentId: intent.intentId,
    requestId: intent.requestId,
    revision: commit.revision,
    runtimeTime: commit.runtimeTime,
    reason,
  }
}

function supersededEvent(
  intent: IntentState,
  supersededBy: IntentId,
  commit: IntentCommit,
): IntentSupersededEvent {
  return {
    vdap: VDAP_VERSION,
    kind: 'event',
    event: 'intent.superseded',
    intentId: intent.intentId,
    requestId: intent.requestId,
    revision: commit.revision,
    runtimeTime: commit.runtimeTime,
    supersededBy,
  }
}
