import {
  VDAP_VERSION,
  type VdapAck,
  type VdapCommand,
  type VdapDelta,
  type VdapEvent,
  type VdapOrigin,
  type VdapRejectedAck,
  type VdapRole,
  type VdapSnapshot,
} from '@vibraxis/shared/vdap'

export type RuntimePortRole = Extract<VdapRole, 'ui' | 'agent'>
export type RuntimePortOrigin = Extract<VdapOrigin, 'user' | 'agent'>
export type VdapOutboundMessage = VdapAck | VdapEvent | VdapSnapshot | VdapDelta

/** Common envelope only. Command-specific parsing belongs to CommandDispatcher. */
export type RuntimeRequestEnvelope = {
  vdap: typeof VDAP_VERSION
  kind: 'request'
  requestId: string
  command: string
  params: unknown
  expectedRevision?: unknown
  expectedBindingId?: unknown
  when?: unknown
}

export type RuntimeRequestContext = {
  connectionId: string
  role: RuntimePortRole
  origin: RuntimePortOrigin
  send(message: VdapOutboundMessage): boolean
}

export type RuntimeRequestHandler = (
  request: RuntimeRequestEnvelope,
  context: RuntimeRequestContext,
) =>
  | void
  | VdapOutboundMessage
  | readonly VdapOutboundMessage[]
  | Promise<void | VdapOutboundMessage | readonly VdapOutboundMessage[]>

export type RuntimeDisconnectContext = Omit<RuntimeRequestContext, 'send'> & {
  helloCompleted: boolean
  cancelOnDisconnect: boolean
}

export type MessagePortTransportOptions = {
  channelFactory?: () => Pick<MessageChannel, 'port1' | 'port2'>
  onDisconnect?: (context: RuntimeDisconnectContext) => void
  now?: () => number
}

type Connection = {
  connectionId: string
  role: RuntimePortRole
  origin: RuntimePortOrigin
  runtimePort: MessagePort
  clientPort: MessagePort
  listener: (event: MessageEvent<unknown>) => void
  closeListener: EventListener
  messageErrorListener: EventListener
  helloCompleted: boolean
  helloRequestId: string | null
  cancelOnDisconnect: boolean
  refused: boolean
  closed: boolean
  queue: Promise<void>
  sentCount: number
  requestCache: Map<string, RequestCacheEntry>
}

type RequestCacheEntry = {
  fingerprint: string
  createdAtMs: number
  ack?: VdapAck
}

const ROLE_ORIGIN: Record<RuntimePortRole, RuntimePortOrigin> = {
  ui: 'user',
  agent: 'agent',
}

// Record<VdapCommand, true> so the compiler rejects this map whenever the
// shared VdapCommand union gains a member that is missing here — the transport
// allowlist can never silently drift behind the protocol contract again.
const KNOWN_COMMAND_MAP: Record<VdapCommand, true> = {
  'session.hello': true,
  'state.get': true,
  'deck.getGrid': true,
  'state.subscribe': true,
  'state.unsubscribe': true,
  'deck.load': true,
  'deck.unload': true,
  'deck.play': true,
  'deck.pause': true,
  'deck.seek': true,
  'deck.selectPad': true,
  'deck.setPad': true,
  'deck.clearPad': true,
  'deck.setGain': true,
  'deck.setEq': true,
  'deck.setVelocity': true,
  'deck.setTempoInterpretation': true,
  'deck.sync': true,
  'mixer.setCrossfader': true,
  'mixer.rampCrossfader': true,
  'mixer.setMasterGain': true,
  'transition.start': true,
  'schedule.cancel': true,
  'runtime.panic': true,
}
const KNOWN_COMMANDS = new Set<string>(Object.keys(KNOWN_COMMAND_MAP))
const REQUEST_CACHE_LIMIT = 128
const REQUEST_CACHE_WINDOW_MS = 60_000

/**
 * Browser-local VDAP transport. Role and origin are attached to the runtime
 * side of each channel and can never be changed by session.hello input.
 */
export class MessagePortTransport {
  readonly uiPort: MessagePort
  readonly agentPort: MessagePort

  private readonly handler: RuntimeRequestHandler
  private readonly onDisconnect?: (context: RuntimeDisconnectContext) => void
  private readonly now: () => number
  private readonly connections: Record<RuntimePortRole, Connection>
  private closed = false

  constructor(handler: RuntimeRequestHandler, options: MessagePortTransportOptions = {}) {
    this.handler = handler
    this.onDisconnect = options.onDisconnect
    this.now = options.now ?? Date.now

    const createChannel = options.channelFactory ?? (() => new MessageChannel())
    const uiChannel = createChannel()
    const agentChannel = createChannel()

    this.connections = {
      ui: this.createConnection('ui', uiChannel),
      agent: this.createConnection('agent', agentChannel),
    }
    this.uiPort = this.connections.ui.clientPort
    this.agentPort = this.connections.agent.clientPort
  }

  sendTo(role: RuntimePortRole, message: VdapOutboundMessage): boolean {
    return this.post(this.connections[role], message)
  }

  connectionIdFor(role: RuntimePortRole): string {
    return this.connections[role].connectionId
  }

  broadcast(message: VdapOutboundMessage): void {
    this.sendTo('ui', message)
    this.sendTo('agent', message)
  }

  closeConnection(role: RuntimePortRole): void {
    this.closeOne(this.connections[role])
  }

  /** Managed peer-close path for browsers that expose no MessagePort close event. */
  closeClient(role: RuntimePortRole): void {
    this.closeConnection(role)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.closeOne(this.connections.ui)
    this.closeOne(this.connections.agent)
  }

  private createConnection(
    role: RuntimePortRole,
    channel: Pick<MessageChannel, 'port1' | 'port2'>,
  ): Connection {
    const connection: Connection = {
      connectionId: `${role}-port`,
      role,
      origin: ROLE_ORIGIN[role],
      runtimePort: channel.port1,
      clientPort: channel.port2,
      listener: (_event: MessageEvent<unknown>) => undefined,
      closeListener: () => undefined,
      messageErrorListener: () => undefined,
      helloCompleted: false,
      helloRequestId: null,
      cancelOnDisconnect: true,
      refused: false,
      closed: false,
      queue: Promise.resolve(),
      sentCount: 0,
      requestCache: new Map(),
    }

    connection.listener = (event) => {
      connection.queue = connection.queue
        .then(() => this.handleMessage(connection, event.data))
        .catch(() => undefined)
    }
    connection.closeListener = () => this.closeOne(connection)
    connection.messageErrorListener = () => this.closeOne(connection)
    connection.runtimePort.addEventListener('message', connection.listener)
    const eventTarget = connection.runtimePort as EventTarget
    eventTarget.addEventListener('close', connection.closeListener)
    eventTarget.addEventListener('messageerror', connection.messageErrorListener)
    connection.runtimePort.start()
    return connection
  }

  private async handleMessage(connection: Connection, value: unknown): Promise<void> {
    if (this.closed || connection.closed) return

    const requestId = requestIdFrom(value)
    if (requestId === null) return

    let replay: ReturnType<MessagePortTransport['registerRequest']>
    try {
      replay = this.registerRequest(connection, requestId, value)
    } catch {
      this.reject(
        connection,
        requestId,
        'E_PROTOCOL',
        'Request cannot be fingerprinted as canonical JSON.',
        false,
      )
      return
    }
    if (replay === 'conflict') {
      this.reject(
        connection,
        requestId,
        'E_PROTOCOL',
        'requestId was reused with a different request.',
        false,
      )
      return
    }
    if (replay !== 'new') {
      if (replay.ack) this.post(connection, replay.ack, false)
      return
    }

    const parsed = parseRequest(value)
    if ('error' in parsed) {
      this.reject(connection, requestId, parsed.error.code, parsed.error.message)
      if (isHelloLike(value)) connection.refused = true
      return
    }
    const request = parsed.request

    if (connection.refused) {
      this.reject(connection, request.requestId, 'E_PROTOCOL', 'This connection was refused.')
      return
    }

    if (!connection.helloCompleted) {
      if (request.command !== 'session.hello') {
        this.reject(
          connection,
          request.requestId,
          'E_PROTOCOL',
          'session.hello must be the first command on a connection.',
        )
        return
      }

      const hello = parseHello(request.params)
      if ('error' in hello) {
        this.reject(connection, request.requestId, hello.error.code, hello.error.message)
        connection.refused = true
        return
      }
      if (hello.params.role !== connection.role) {
        this.reject(
          connection,
          request.requestId,
          'E_ROLE_MISMATCH',
          `Port role is ${connection.role}; hello declared ${hello.params.role}.`,
        )
        connection.refused = true
        return
      }
      connection.helloRequestId = request.requestId
      connection.cancelOnDisconnect = hello.params.cancelOnDisconnect ?? true
    } else if (request.command === 'session.hello') {
      this.reject(connection, request.requestId, 'E_PROTOCOL', 'session.hello was already completed.')
      return
    }

    const context: RuntimeRequestContext = {
      connectionId: connection.connectionId,
      role: connection.role,
      origin: connection.origin,
      send: (message) => this.post(connection, message),
    }

    try {
      const response = await this.handler(request, context)
      if (isOutboundMessages(response)) {
        for (const message of response) this.post(connection, message)
      } else if (response) {
        this.post(connection, response)
      }
    } catch (cause) {
      if (connection.requestCache.get(request.requestId)?.ack === undefined) {
        const message = cause instanceof Error ? cause.message : 'Runtime request handler failed.'
        this.reject(connection, request.requestId, 'E_INTERNAL', message)
      }
      if (request.command === 'session.hello') connection.refused = true
    }
  }

  private reject(
    connection: Connection,
    requestId: string,
    code:
      | 'E_PROTOCOL'
      | 'E_UNSUPPORTED_VERSION'
      | 'E_UNSUPPORTED_COMMAND'
      | 'E_ROLE_MISMATCH'
      | 'E_INTERNAL',
    message: string,
    cacheAck = true,
  ): void {
    const ack: VdapRejectedAck = {
      vdap: VDAP_VERSION,
      kind: 'ack',
      requestId,
      state: 'rejected',
      error: { code, retryable: false, message },
    }
    this.post(connection, ack, cacheAck)
  }

  private post(connection: Connection, message: VdapOutboundMessage, cacheAck = true): boolean {
    if (this.closed || connection.closed) return false
    connection.runtimePort.postMessage(message)
    connection.sentCount += 1
    if (message.kind === 'ack') {
      if (cacheAck) this.rememberAck(connection, message)
      this.observeHelloAck(connection, message)
    }
    return true
  }

  private registerRequest(
    connection: Connection,
    requestId: string,
    value: unknown,
  ): 'new' | 'conflict' | RequestCacheEntry {
    const fingerprint = stableFingerprint(value)
    const previous = connection.requestCache.get(requestId)
    if (previous) return previous.fingerprint === fingerprint ? previous : 'conflict'

    connection.requestCache.set(requestId, { fingerprint, createdAtMs: this.now() })
    this.pruneRequestCache(connection)
    return 'new'
  }

  private pruneRequestCache(connection: Connection): void {
    while (connection.requestCache.size > REQUEST_CACHE_LIMIT) {
      const oldest = connection.requestCache.entries().next().value as
        | [string, RequestCacheEntry]
        | undefined
      if (!oldest) return
      const [requestId, entry] = oldest
      if (this.now() - entry.createdAtMs <= REQUEST_CACHE_WINDOW_MS) return
      connection.requestCache.delete(requestId)
    }
  }

  private rememberAck(connection: Connection, ack: VdapAck): void {
    const entry = connection.requestCache.get(ack.requestId)
    if (entry && entry.ack === undefined) entry.ack = ack
  }

  private observeHelloAck(connection: Connection, ack: VdapAck): void {
    if (connection.helloRequestId !== ack.requestId) return
    if (ack.state === 'completed') {
      connection.helloCompleted = true
      connection.helloRequestId = null
      return
    }
    connection.refused = true
    connection.helloRequestId = null
  }

  private closeOne(connection: Connection): void {
    if (connection.closed) return
    connection.closed = true
    connection.runtimePort.removeEventListener('message', connection.listener)
    const eventTarget = connection.runtimePort as EventTarget
    eventTarget.removeEventListener('close', connection.closeListener)
    eventTarget.removeEventListener('messageerror', connection.messageErrorListener)
    connection.runtimePort.close()
    connection.clientPort.close()
    this.onDisconnect?.({
      connectionId: connection.connectionId,
      role: connection.role,
      origin: connection.origin,
      helloCompleted: connection.helloCompleted,
      cancelOnDisconnect: connection.cancelOnDisconnect,
    })
  }
}

type ParseRequestError = {
  code: 'E_PROTOCOL' | 'E_UNSUPPORTED_VERSION' | 'E_UNSUPPORTED_COMMAND'
  message: string
}

type ParseRequestResult = { request: RuntimeRequestEnvelope } | { error: ParseRequestError }

function parseRequest(value: unknown): ParseRequestResult {
  if (!isRecord(value)) return protocolError('Invalid VDAP request envelope.')
  if (value.vdap !== VDAP_VERSION) {
    return typeof value.vdap === 'string'
      ? {
          error: {
            code: 'E_UNSUPPORTED_VERSION',
            message: `Unsupported VDAP envelope version: ${value.vdap}.`,
          },
        }
      : protocolError('VDAP version must be present.')
  }
  if (value.kind !== 'request') return protocolError('Inbound message kind must be request.')
  if (typeof value.requestId !== 'string' || value.requestId.trim() === '') {
    return protocolError('requestId must be a non-empty string.')
  }
  if (typeof value.command !== 'string') return protocolError('command must be a string.')
  if (!KNOWN_COMMANDS.has(value.command)) {
    return {
      error: {
        code: 'E_UNSUPPORTED_COMMAND',
        message: `Unsupported VDAP command: ${value.command}.`,
      },
    }
  }
  if (!isRecord(value.params)) return protocolError('params must be an object.')
  if (
    value.expectedRevision !== undefined &&
    (!Number.isInteger(value.expectedRevision) || Number(value.expectedRevision) < 0)
  ) {
    return protocolError('expectedRevision must be a non-negative integer when present.')
  }
  if (
    value.expectedBindingId !== undefined &&
    (typeof value.expectedBindingId !== 'string' || value.expectedBindingId.trim() === '')
  ) {
    return protocolError('expectedBindingId must be a non-empty string when present.')
  }
  if (value.when !== undefined) {
    if (!isRecord(value.when) || typeof value.when.at !== 'string') {
      return protocolError('when must be an object with a string at field when present.')
    }
    if (!['immediate', 'nextBeat', 'nextBar'].includes(value.when.at)) {
      return protocolError('when.at is not supported by the P0 transport.')
    }
  }
  return {
    request: {
      vdap: VDAP_VERSION,
      kind: 'request',
      requestId: value.requestId,
      command: value.command,
      params: value.params,
      ...(value.expectedRevision === undefined
        ? {}
        : { expectedRevision: value.expectedRevision }),
      ...(value.expectedBindingId === undefined
        ? {}
        : { expectedBindingId: value.expectedBindingId }),
      ...(value.when === undefined ? {} : { when: value.when }),
    },
  }
}

type ParsedHelloParams = {
  protocolVersions: string[]
  client: { name: string; version: string }
  role: VdapRole
  cancelOnDisconnect?: boolean
}

type ParseHelloResult = { params: ParsedHelloParams } | { error: ParseRequestError }

function parseHello(params: unknown): ParseHelloResult {
  if (!isRecord(params)) return protocolError('hello params must be an object.')
  if (
    !Array.isArray(params.protocolVersions) ||
    params.protocolVersions.length === 0 ||
    !params.protocolVersions.every((version) => typeof version === 'string')
  ) {
    return protocolError('hello protocolVersions must be a non-empty string array.')
  }
  if (!params.protocolVersions.includes(VDAP_VERSION)) {
    return {
      error: {
        code: 'E_UNSUPPORTED_VERSION',
        message: `Client does not support VDAP ${VDAP_VERSION}.`,
      },
    }
  }
  if (
    !isRecord(params.client) ||
    typeof params.client.name !== 'string' ||
    params.client.name.trim() === '' ||
    typeof params.client.version !== 'string' ||
    params.client.version.trim() === ''
  ) {
    return protocolError('hello client name and version must be non-empty strings.')
  }
  if (!isVdapRole(params.role)) {
    return protocolError('hello role is invalid.')
  }
  if (params.cancelOnDisconnect !== undefined && typeof params.cancelOnDisconnect !== 'boolean') {
    return protocolError('cancelOnDisconnect must be boolean when present.')
  }
  return {
    params: {
      protocolVersions: [...params.protocolVersions],
      client: { name: params.client.name, version: params.client.version },
      role: params.role,
      ...(params.cancelOnDisconnect === undefined
        ? {}
        : { cancelOnDisconnect: params.cancelOnDisconnect }),
    },
  }
}

function protocolError(message: string): Extract<ParseRequestResult, { error: unknown }> {
  return { error: { code: 'E_PROTOCOL', message } }
}

function requestIdFrom(value: unknown): string | null {
  return isRecord(value) && typeof value.requestId === 'string' ? value.requestId : null
}

function isHelloLike(value: unknown): boolean {
  return isRecord(value) && value.command === 'session.hello'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isVdapRole(value: unknown): value is VdapRole {
  return value === 'ui' || value === 'agent' || value === 'observer'
}

function isOutboundMessages(value: unknown): value is readonly VdapOutboundMessage[] {
  return Array.isArray(value)
}

function stableFingerprint(value: unknown): string {
  const encoded = JSON.stringify(canonicalize(value, new WeakSet<object>()))
  if (encoded === undefined) throw new TypeError('Request is not JSON serializable.')
  return encoded
}

function canonicalize(value: unknown, ancestors: WeakSet<object>): unknown {
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError('Request contains a non-JSON value.')
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError('Request contains a cycle.')
    ancestors.add(value)
    const result = value.map((item) => canonicalize(item, ancestors))
    ancestors.delete(value)
    return result
  }
  if (!isRecord(value)) return value
  if (ancestors.has(value)) throw new TypeError('Request contains a cycle.')
  ancestors.add(value)
  const result = Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key], ancestors)]),
  )
  ancestors.delete(value)
  return result
}
