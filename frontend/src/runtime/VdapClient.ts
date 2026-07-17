import {
  VDAP_VERSION,
  type DeckGrid,
  type QueryResult,
  type RequestFor,
  type RuntimeState,
  type SessionHelloRequest,
  type SessionHelloResult,
  type TerminalEventName,
  type VdapAcceptedAck,
  type VdapAck,
  type VdapCompletedAck,
  type VdapDelta,
  type VdapEvent,
  type VdapMutationCommand,
  type VdapQueryCommand,
  type VdapRejectedAck,
  type VdapRole,
  type VdapSnapshot,
} from '@vibraxis/shared/vdap'

export type ClientRole = Extract<VdapRole, 'ui' | 'agent'>
export type StateMessage = VdapSnapshot | VdapDelta
export type IntentTerminalEvent = Extract<
  VdapEvent,
  { event: TerminalEventName; intentId: string; requestId: string }
>

export type VdapClientOptions = {
  role: ClientRole
  client: { name: string; version: string }
  cancelOnDisconnect?: boolean
  requestTimeoutMs?: number
  terminalTimeoutMs?: number
  requestIdFactory?: () => string
}

type QueryResultFor<C extends VdapQueryCommand> = C extends 'session.hello'
  ? SessionHelloResult
  : C extends 'state.get'
    ? RuntimeState
    : C extends 'deck.getGrid'
      ? DeckGrid
      : QueryResult

export type MutationOptionsFor<C extends VdapMutationCommand> = Omit<
  RequestFor<C>,
  'vdap' | 'kind' | 'requestId' | 'command' | 'params'
>

export type MutationHandle = {
  ack: VdapAcceptedAck
  terminal: Promise<IntentTerminalEvent>
}

export class VdapClientError extends Error {
  constructor(
    message: string,
    readonly code: 'REJECTED' | 'TIMEOUT' | 'CLOSED' | 'PROTOCOL',
    readonly ack?: VdapRejectedAck,
  ) {
    super(message)
    this.name = 'VdapClientError'
  }
}

type PendingQuery = {
  kind: 'query'
  timer: ReturnType<typeof setTimeout>
  resolve: (ack: VdapCompletedAck) => void
  reject: (error: Error) => void
}

type PendingMutation = {
  kind: 'mutation'
  timer: ReturnType<typeof setTimeout>
  resolve: (handle: MutationHandle) => void
  reject: (error: Error) => void
}

type PendingRequest = PendingQuery | PendingMutation

type PendingIntent = {
  requestId: string
  timer: ReturnType<typeof setTimeout>
  resolve: (event: IntentTerminalEvent) => void
  reject: (error: Error) => void
}

export class VdapClient {
  private readonly port: MessagePort
  private readonly options: Required<
    Pick<VdapClientOptions, 'role' | 'client' | 'requestTimeoutMs' | 'terminalTimeoutMs'>
  > &
    Pick<VdapClientOptions, 'cancelOnDisconnect'>
  private readonly requestIdFactory: () => string
  private readonly pendingRequests = new Map<string, PendingRequest>()
  private readonly pendingIntents = new Map<string, PendingIntent>()
  private readonly usedRequestIds = new Set<string>()
  private readonly stateListeners = new Set<(message: StateMessage) => void>()
  private readonly eventListeners = new Set<(event: VdapEvent) => void>()
  private readonly messageListener: (event: MessageEvent<unknown>) => void
  private readonly closeListener: EventListener
  private readonly messageErrorListener: EventListener
  private helloCompleted = false
  private helloPending = false
  private closed = false
  private remoteStateSubscribers = 0
  private remoteSubscribePromise: Promise<void> | null = null

  constructor(port: MessagePort, options: VdapClientOptions) {
    this.port = port
    this.options = {
      role: options.role,
      client: options.client,
      cancelOnDisconnect: options.cancelOnDisconnect,
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      terminalTimeoutMs: options.terminalTimeoutMs ?? 60_000,
    }
    this.requestIdFactory = options.requestIdFactory ?? createRequestIdFactory()
    this.messageListener = (event) => this.handleMessage(event.data)
    this.closeListener = () => this.close(new VdapClientError('VDAP port closed.', 'CLOSED'))
    this.messageErrorListener = () =>
      this.close(new VdapClientError('VDAP port received an invalid message.', 'PROTOCOL'))
    this.port.addEventListener('message', this.messageListener)
    const eventTarget = this.port as EventTarget
    eventTarget.addEventListener('close', this.closeListener)
    eventTarget.addEventListener('messageerror', this.messageErrorListener)
    this.port.start()
  }

  get pendingRequestCount(): number {
    return this.pendingRequests.size
  }

  get pendingIntentCount(): number {
    return this.pendingIntents.size
  }

  get isClosed(): boolean {
    return this.closed
  }

  async hello(): Promise<SessionHelloResult> {
    this.ensureOpen()
    if (this.helloCompleted || this.helloPending) {
      throw new VdapClientError('session.hello may only be sent once.', 'PROTOCOL')
    }
    this.helloPending = true
    const params: SessionHelloRequest['params'] = {
      protocolVersions: [VDAP_VERSION],
      client: this.options.client,
      role: this.options.role,
      ...(this.options.cancelOnDisconnect === undefined
        ? {}
        : { cancelOnDisconnect: this.options.cancelOnDisconnect }),
    }
    try {
      const result = await this.sendQuery('session.hello', params, true)
      this.helloCompleted = true
      return result
    } finally {
      this.helloPending = false
    }
  }

  query<C extends Exclude<VdapQueryCommand, 'session.hello'>>(
    command: C,
    params: RequestFor<C>['params'],
  ): Promise<QueryResultFor<C>> {
    this.ensureReady()
    return this.sendQuery(command, params, false)
  }

  mutate<C extends VdapMutationCommand>(
    command: C,
    params: RequestFor<C>['params'],
    options?: MutationOptionsFor<C>,
  ): Promise<MutationHandle> {
    this.ensureReady()
    const requestId = this.nextRequestId()
    const request = {
      ...options,
      vdap: VDAP_VERSION,
      kind: 'request',
      requestId,
      command,
      params,
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new VdapClientError(`VDAP request timed out: ${requestId}`, 'TIMEOUT'))
      }, this.options.requestTimeoutMs)
      this.pendingRequests.set(requestId, { kind: 'mutation', timer, resolve, reject })
      this.port.postMessage(request)
    })
  }

  onState(listener: (message: StateMessage) => void): () => void {
    this.ensureOpen()
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  onEvent(listener: (event: VdapEvent) => void): () => void {
    this.ensureOpen()
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  async subscribeState(listener: (message: StateMessage) => void): Promise<() => Promise<void>> {
    this.ensureReady()
    const registeredListener = (message: StateMessage) => listener(message)
    this.stateListeners.add(registeredListener)
    this.remoteStateSubscribers += 1

    if (this.remoteStateSubscribers === 1) {
      this.remoteSubscribePromise = this.activateStateSubscription()
    }
    try {
      await this.remoteSubscribePromise
    } catch (error) {
      this.stateListeners.delete(registeredListener)
      this.remoteStateSubscribers -= 1
      if (this.remoteStateSubscribers === 0) this.remoteSubscribePromise = null
      throw error
    }

    let active = true
    return async () => {
      if (!active) return
      active = false
      this.stateListeners.delete(registeredListener)
      this.remoteStateSubscribers -= 1
      if (this.remoteStateSubscribers !== 0 || this.closed) return
      await this.remoteSubscribePromise
      this.remoteSubscribePromise = null
      const handle = await this.mutate('state.unsubscribe', {})
      await handle.terminal
    }
  }

  close(reason = new VdapClientError('VDAP client closed.', 'CLOSED')): void {
    if (this.closed) return
    this.closed = true
    this.helloCompleted = false
    this.port.removeEventListener('message', this.messageListener)
    const eventTarget = this.port as EventTarget
    eventTarget.removeEventListener('close', this.closeListener)
    eventTarget.removeEventListener('messageerror', this.messageErrorListener)
    this.port.close()

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.pendingRequests.clear()
    for (const pending of this.pendingIntents.values()) {
      clearTimeout(pending.timer)
      pending.reject(reason)
    }
    this.pendingIntents.clear()
    this.stateListeners.clear()
    this.eventListeners.clear()
    this.remoteStateSubscribers = 0
    this.remoteSubscribePromise = null
  }

  private async activateStateSubscription(): Promise<void> {
    const handle = await this.mutate('state.subscribe', {})
    await handle.terminal
  }

  private sendQuery<C extends VdapQueryCommand>(
    command: C,
    params: RequestFor<C>['params'],
    allowBeforeHello: boolean,
  ): Promise<QueryResultFor<C>> {
    if (!allowBeforeHello) this.ensureReady()
    else this.ensureOpen()
    const requestId = this.nextRequestId()
    const request = { vdap: VDAP_VERSION, kind: 'request', requestId, command, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new VdapClientError(`VDAP query timed out: ${requestId}`, 'TIMEOUT'))
      }, this.options.requestTimeoutMs)
      this.pendingRequests.set(requestId, {
        kind: 'query',
        timer,
        resolve: (ack) => resolve(ack.result as QueryResultFor<C>),
        reject,
      })
      this.port.postMessage(request)
    })
  }

  private handleMessage(value: unknown): void {
    if (this.closed || !isRecord(value) || value.vdap !== VDAP_VERSION) return
    if (isAck(value)) this.handleAck(value)
    else if (isEvent(value)) this.handleEvent(value)
    else if (isStateMessage(value)) {
      notifyListeners(this.stateListeners, value)
    }
  }

  private handleAck(ack: VdapAck): void {
    const pending = this.pendingRequests.get(ack.requestId)
    if (!pending) return

    if (ack.state === 'rejected') {
      this.finishRequest(ack.requestId, pending)
      pending.reject(new VdapClientError(ack.error.message, 'REJECTED', ack))
      return
    }
    if (pending.kind === 'query') {
      if (ack.state !== 'completed') {
        this.failProtocol(ack.requestId, pending, 'Query did not receive a completed ack.')
        return
      }
      this.finishRequest(ack.requestId, pending)
      pending.resolve(ack)
      return
    }
    if (ack.state !== 'accepted') {
      this.failProtocol(ack.requestId, pending, 'Mutation did not receive an accepted ack.')
      return
    }

    this.finishRequest(ack.requestId, pending)
    if (this.pendingIntents.has(ack.intentId)) {
      pending.reject(new VdapClientError(`Duplicate intentId: ${ack.intentId}`, 'PROTOCOL'))
      return
    }
    let resolveTerminal!: (event: IntentTerminalEvent) => void
    let rejectTerminal!: (error: Error) => void
    const terminal = new Promise<IntentTerminalEvent>((resolve, reject) => {
      resolveTerminal = resolve
      rejectTerminal = reject
    })
    const timer = setTimeout(() => {
      this.pendingIntents.delete(ack.intentId)
      rejectTerminal(new VdapClientError(`VDAP intent timed out: ${ack.intentId}`, 'TIMEOUT'))
    }, this.options.terminalTimeoutMs)
    this.pendingIntents.set(ack.intentId, {
      requestId: ack.requestId,
      timer,
      resolve: resolveTerminal,
      reject: rejectTerminal,
    })
    pending.resolve({ ack, terminal })
  }

  private handleEvent(event: VdapEvent): void {
    if (isTerminalEvent(event)) {
      const pending = this.pendingIntents.get(event.intentId)
      if (pending && pending.requestId === event.requestId) {
        clearTimeout(pending.timer)
        this.pendingIntents.delete(event.intentId)
        pending.resolve(event)
      }
    }
    notifyListeners(this.eventListeners, event)
  }

  private finishRequest(requestId: string, pending: PendingRequest): void {
    clearTimeout(pending.timer)
    this.pendingRequests.delete(requestId)
  }

  private failProtocol(requestId: string, pending: PendingRequest, message: string): void {
    this.finishRequest(requestId, pending)
    pending.reject(new VdapClientError(message, 'PROTOCOL'))
  }

  private nextRequestId(): string {
    const requestId = this.requestIdFactory()
    if (!requestId || this.usedRequestIds.has(requestId)) {
      throw new VdapClientError('requestIdFactory returned an empty or reused ID.', 'PROTOCOL')
    }
    this.usedRequestIds.add(requestId)
    return requestId
  }

  private ensureOpen(): void {
    if (this.closed) throw new VdapClientError('VDAP client is closed.', 'CLOSED')
  }

  private ensureReady(): void {
    this.ensureOpen()
    if (!this.helloCompleted) {
      throw new VdapClientError('session.hello has not completed.', 'PROTOCOL')
    }
  }
}

function isTerminalEvent(event: VdapEvent): event is IntentTerminalEvent {
  return (
    event.event === 'intent.completed' ||
    event.event === 'intent.failed' ||
    event.event === 'intent.cancelled' ||
    event.event === 'intent.superseded'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAck(value: Record<string, unknown>): value is VdapAck {
  if (
    value.kind !== 'ack' ||
    typeof value.requestId !== 'string' ||
    !['accepted', 'completed', 'rejected'].includes(String(value.state))
  ) {
    return false
  }
  if (value.state === 'accepted') {
    return typeof value.intentId === 'string' && typeof value.revision === 'number'
  }
  if (value.state === 'completed') {
    return typeof value.revision === 'number' && 'result' in value
  }
  return isRecord(value.error) && typeof value.error.code === 'string'
}

function isEvent(value: Record<string, unknown>): value is VdapEvent {
  if (
    value.kind !== 'event' ||
    typeof value.event !== 'string' ||
    typeof value.revision !== 'number' ||
    typeof value.runtimeTime !== 'number'
  ) {
    return false
  }
  if (value.event.startsWith('intent.')) {
    return typeof value.intentId === 'string' && typeof value.requestId === 'string'
  }
  return value.event === 'deck.ended' || value.event === 'runtime.warning'
}

function isStateMessage(value: Record<string, unknown>): value is StateMessage {
  if (value.kind === 'snapshot') {
    return typeof value.revision === 'number' && typeof value.runtimeTime === 'number'
  }
  return (
    value.kind === 'delta' &&
    typeof value.fromRevision === 'number' &&
    typeof value.toRevision === 'number' &&
    typeof value.runtimeTime === 'number' &&
    Array.isArray(value.patch)
  )
}

function createRequestIdFactory(): () => string {
  let sequence = 0
  return () => {
    sequence += 1
    const random = globalThis.crypto?.randomUUID?.()
    return random ?? `vdap-${Date.now().toString(36)}-${sequence.toString(36)}`
  }
}

function notifyListeners<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
  for (const listener of listeners) {
    try {
      listener(value)
    } catch {
      // A UI listener must not break protocol correlation for other listeners.
    }
  }
}
