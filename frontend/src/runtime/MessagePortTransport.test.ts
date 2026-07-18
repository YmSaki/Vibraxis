import { describe, expect, it, vi } from 'vitest'
import {
  VDAP_VERSION,
  type VdapAcceptedAck,
  type VdapCompletedAck,
  type VdapDelta,
  type VdapRejectedAck,
  type VdapRequest,
  type VdapSnapshot,
} from '../../../shared/vdap'
import {
  MessagePortTransport,
  type RuntimeRequestEnvelope,
  type VdapOutboundMessage,
} from './MessagePortTransport'

function hello(
  requestId: string,
  role: 'ui' | 'agent',
  cancelOnDisconnect?: boolean,
): VdapRequest {
  return {
    vdap: VDAP_VERSION,
    kind: 'request',
    requestId,
    command: 'session.hello',
    params: {
      protocolVersions: [VDAP_VERSION],
      client: { name: 'transport-test', version: '0.1.0' },
      role,
      ...(cancelOnDisconnect === undefined ? {} : { cancelOnDisconnect }),
    },
  }
}

function rejected(requestId: string): VdapRejectedAck {
  return {
    vdap: VDAP_VERSION,
    kind: 'ack',
    requestId,
    state: 'rejected',
    error: { code: 'E_UNSUPPORTED_VERSION', retryable: false, message: 'Rejected by runtime.' },
  }
}

function stateGet(requestId: string): VdapRequest {
  return {
    vdap: VDAP_VERSION,
    kind: 'request',
    requestId,
    command: 'state.get',
    params: {},
  }
}

function completed(requestId: string): VdapCompletedAck {
  return {
    vdap: VDAP_VERSION,
    kind: 'ack',
    requestId,
    state: 'completed',
    revision: 1,
    result: {},
  }
}

function nextMessage(port: MessagePort): Promise<VdapOutboundMessage> {
  port.start()
  return new Promise((resolve) => {
    port.addEventListener('message', (event) => resolve(event.data as VdapOutboundMessage), {
      once: true,
    })
  })
}

function nextMessages(port: MessagePort, count: number): Promise<VdapOutboundMessage[]> {
  port.start()
  return new Promise((resolve) => {
    const messages: VdapOutboundMessage[] = []
    const listener = (event: MessageEvent<unknown>) => {
      messages.push(event.data as VdapOutboundMessage)
      if (messages.length !== count) return
      port.removeEventListener('message', listener)
      resolve(messages)
    }
    port.addEventListener('message', listener)
  })
}

async function exchange(port: MessagePort, request: VdapRequest): Promise<VdapOutboundMessage> {
  const response = nextMessage(port)
  port.postMessage(request)
  return response
}

async function exchangeUnknown(port: MessagePort, request: unknown): Promise<VdapOutboundMessage> {
  const response = nextMessage(port)
  port.postMessage(request)
  return response
}

describe('MessagePortTransport', () => {
  it('fixes ui and agent authority at channel creation', async () => {
    const observed: Array<{ role: string; origin: string; command: string }> = []
    const transport = new MessagePortTransport((request, context) => {
      observed.push({ role: context.role, origin: context.origin, command: request.command })
      return completed(request.requestId)
    })

    expect(await exchange(transport.uiPort, hello('ui-hello', 'ui'))).toMatchObject({
      kind: 'ack',
      state: 'completed',
    })
    expect(await exchange(transport.agentPort, hello('agent-hello', 'agent'))).toMatchObject({
      kind: 'ack',
      state: 'completed',
    })
    expect(await exchange(transport.uiPort, stateGet('ui-state'))).toMatchObject({ state: 'completed' })
    expect(await exchange(transport.agentPort, stateGet('agent-state'))).toMatchObject({
      state: 'completed',
    })

    expect(observed).toEqual([
      { role: 'ui', origin: 'user', command: 'session.hello' },
      { role: 'agent', origin: 'agent', command: 'session.hello' },
      { role: 'ui', origin: 'user', command: 'state.get' },
      { role: 'agent', origin: 'agent', command: 'state.get' },
    ])
    transport.close()
  })

  it('rejects a hello role that disagrees with the assigned port', async () => {
    const handler = vi.fn(() => completed('unused'))
    const transport = new MessagePortTransport(handler)

    const response = await exchange(transport.agentPort, hello('wrong-role', 'ui'))
    expect(response).toMatchObject({
      kind: 'ack',
      requestId: 'wrong-role',
      state: 'rejected',
      error: { code: 'E_ROLE_MISMATCH', retryable: false },
    })
    expect(handler).not.toHaveBeenCalled()

    const afterRefusal = await exchange(transport.agentPort, stateGet('after-refusal'))
    expect(afterRefusal).toMatchObject({
      state: 'rejected',
      error: { code: 'E_PROTOCOL' },
    })
    transport.close()
  })

  it('rejects commands before hello and permits a correct hello afterward', async () => {
    const handler = vi.fn((request: RuntimeRequestEnvelope) => completed(request.requestId))
    const transport = new MessagePortTransport(handler)

    const beforeHello = await exchange(transport.uiPort, stateGet('too-early'))
    expect(beforeHello).toMatchObject({
      requestId: 'too-early',
      state: 'rejected',
      error: { code: 'E_PROTOCOL' },
    })
    expect(handler).not.toHaveBeenCalled()

    expect(await exchange(transport.uiPort, hello('now-hello', 'ui'))).toMatchObject({
      state: 'completed',
    })
    expect(handler).toHaveBeenCalledTimes(1)
    transport.close()
  })

  it('completes hello only after the runtime returns a completed ack', async () => {
    const handler = vi.fn((request: RuntimeRequestEnvelope) => rejected(request.requestId))
    const transport = new MessagePortTransport(handler)

    expect(await exchange(transport.uiPort, hello('rejected-hello', 'ui'))).toMatchObject({
      state: 'rejected',
    })
    expect(await exchange(transport.uiPort, stateGet('after-rejected-hello'))).toMatchObject({
      state: 'rejected',
      error: { code: 'E_PROTOCOL' },
    })
    expect(handler).toHaveBeenCalledTimes(1)
    transport.close()

    const failing = new MessagePortTransport(() => {
      throw new Error('hello failed')
    })
    expect(await exchange(failing.agentPort, hello('internal-hello', 'agent'))).toMatchObject({
      state: 'rejected',
      error: { code: 'E_INTERNAL' },
    })
    expect(await exchange(failing.agentPort, stateGet('after-internal'))).toMatchObject({
      state: 'rejected',
      error: { code: 'E_PROTOCOL' },
    })
    failing.close()
  })

  it('validates versions, hello client metadata, and known commands', async () => {
    const handler = vi.fn((request: RuntimeRequestEnvelope) => completed(request.requestId))

    const unsupported = new MessagePortTransport(handler)
    expect(
      await exchangeUnknown(unsupported.uiPort, {
        ...hello('unsupported', 'ui'),
        vdap: '9.0',
      }),
    ).toMatchObject({ state: 'rejected', error: { code: 'E_UNSUPPORTED_VERSION' } })
    unsupported.close()

    const badClient = new MessagePortTransport(handler)
    const badHello = hello('bad-client', 'ui') as VdapRequest & {
      params: { client: { name: string; version: string } }
    }
    badHello.params.client.name = ''
    expect(await exchangeUnknown(badClient.uiPort, badHello)).toMatchObject({
      state: 'rejected',
      error: { code: 'E_PROTOCOL' },
    })
    badClient.close()

    const unknownCommand = new MessagePortTransport(handler)
    await exchange(unknownCommand.uiPort, hello('hello', 'ui'))
    expect(
      await exchangeUnknown(unknownCommand.uiPort, {
        ...stateGet('unknown'),
        command: 'runtime.takeOverComputer',
      }),
    ).toMatchObject({ state: 'rejected', error: { code: 'E_UNSUPPORTED_COMMAND' } })
    expect(
      await exchangeUnknown(unknownCommand.uiPort, {
        ...stateGet('bad-revision'),
        expectedRevision: -1,
      }),
    ).toMatchObject({ state: 'rejected', error: { code: 'E_PROTOCOL' } })
    expect(
      await exchangeUnknown(unknownCommand.uiPort, {
        ...stateGet('bad-when'),
        when: { at: 'someday' },
      }),
    ).toMatchObject({ state: 'rejected', error: { code: 'E_PROTOCOL' } })
    unknownCommand.close()
  })

  it('passes deck.setEq through the transport command allowlist', async () => {
    const handler = vi.fn((request: RuntimeRequestEnvelope) => completed(request.requestId))
    const transport = new MessagePortTransport(handler)
    await exchange(transport.uiPort, hello('hello-eq', 'ui'))

    const response = await exchange(transport.uiPort, {
      vdap: VDAP_VERSION,
      kind: 'request',
      requestId: 'eq',
      command: 'deck.setEq',
      params: { deckId: 'A', band: 'mid', gainDb: -3 },
    })

    expect(response).toMatchObject({ state: 'completed', requestId: 'eq' })
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({ command: 'deck.setEq' }),
      expect.objectContaining({ role: 'ui', origin: 'user' }),
    )
    transport.close()
  })

  it('replays only the cached ack and rejects conflicting requestId reuse', async () => {
    const accepted: VdapAcceptedAck = {
      vdap: VDAP_VERSION,
      kind: 'ack',
      requestId: 'play-once',
      state: 'accepted',
      intentId: 'intent-play-once',
      revision: 2,
    }
    const terminal: VdapOutboundMessage = {
      vdap: VDAP_VERSION,
      kind: 'event',
      event: 'intent.completed',
      requestId: 'play-once',
      intentId: 'intent-play-once',
      revision: 3,
      runtimeTime: 10,
      result: {},
    }
    const handler = vi.fn((request: RuntimeRequestEnvelope) => {
      if (request.command === 'session.hello') return completed(request.requestId)
      return [accepted, terminal]
    })
    const transport = new MessagePortTransport(handler)
    await exchange(transport.agentPort, hello('hello', 'agent'))

    const playRequest = {
      vdap: VDAP_VERSION,
      kind: 'request',
      requestId: 'play-once',
      command: 'deck.play',
      params: { deckId: 'B' },
    } as VdapRequest
    const firstMessages = nextMessages(transport.agentPort, 2)
    transport.agentPort.postMessage(playRequest)
    expect(await firstMessages).toEqual([accepted, terminal])

    expect(await exchange(transport.agentPort, playRequest)).toEqual(accepted)
    expect(handler).toHaveBeenCalledTimes(2)
    expect(
      await exchangeUnknown(transport.agentPort, {
        ...playRequest,
        params: { deckId: 'A' },
      }),
    ).toMatchObject({ state: 'rejected', error: { code: 'E_PROTOCOL' } })
    expect(handler).toHaveBeenCalledTimes(2)
    transport.close()
  })

  it('turns un-fingerprintable values into E_PROTOCOL and keeps the queue usable', async () => {
    const handler = vi.fn((request: RuntimeRequestEnvelope) => completed(request.requestId))
    const transport = new MessagePortTransport(handler)

    expect(
      await exchangeUnknown(transport.uiPort, {
        ...stateGet('bigint'),
        params: { value: 1n },
      }),
    ).toMatchObject({ state: 'rejected', error: { code: 'E_PROTOCOL' } })
    expect(await exchange(transport.uiPort, hello('hello-after-bigint', 'ui'))).toMatchObject({
      state: 'completed',
    })

    const cyclicParams: Record<string, unknown> = {}
    cyclicParams.self = cyclicParams
    expect(
      await exchangeUnknown(transport.uiPort, {
        ...stateGet('cyclic'),
        params: cyclicParams,
      }),
    ).toMatchObject({ state: 'rejected', error: { code: 'E_PROTOCOL' } })
    expect(await exchange(transport.uiPort, stateGet('after-cycle'))).toMatchObject({
      state: 'completed',
    })
    transport.close()
  })

  it('keeps every request for 60 seconds and at least the newest 128 afterward', async () => {
    let now = 0
    const calls = new Map<string, number>()
    const transport = new MessagePortTransport(
      (request) => {
        calls.set(request.requestId, (calls.get(request.requestId) ?? 0) + 1)
        return completed(request.requestId)
      },
      { now: () => now },
    )
    await exchange(transport.uiPort, hello('cache-hello', 'ui'))

    for (let index = 0; index < 130; index += 1) {
      await exchange(transport.uiPort, stateGet(`cache-${index}`))
    }
    expect(await exchange(transport.uiPort, stateGet('cache-0'))).toMatchObject({
      state: 'completed',
    })
    expect(calls.get('cache-0')).toBe(1)

    now = 60_001
    await exchange(transport.uiPort, stateGet('cache-prune-trigger'))
    await exchange(transport.uiPort, stateGet('cache-0'))
    expect(calls.get('cache-0')).toBe(2)
    transport.close()
  })

  it('sends handler responses, pushed events, snapshots, deltas, and broadcasts', async () => {
    const snapshot = {
      vdap: VDAP_VERSION,
      kind: 'snapshot',
      revision: 2,
      runtimeTime: 10,
    } as VdapSnapshot
    const delta = {
      vdap: VDAP_VERSION,
      kind: 'delta',
      fromRevision: 2,
      toRevision: 3,
      runtimeTime: 11,
      patch: [],
    } satisfies VdapDelta

    const transport = new MessagePortTransport((request, context) => {
      if (request.command === 'session.hello') return completed(request.requestId)
      context.send(snapshot)
      return [completed(request.requestId), delta]
    })

    await exchange(transport.uiPort, hello('ui-hello', 'ui'))
    await exchange(transport.agentPort, hello('agent-hello', 'agent'))

    const uiMessages = nextMessages(transport.uiPort, 3)
    transport.uiPort.postMessage(stateGet('state'))
    const [uiSnapshot, uiAck, uiDelta] = await uiMessages
    expect(uiSnapshot).toStrictEqual(snapshot)
    expect(uiAck).toMatchObject({ requestId: 'state', state: 'completed' })
    expect(uiDelta).toEqual(delta)

    const uiBroadcast = nextMessage(transport.uiPort)
    const agentBroadcast = nextMessage(transport.agentPort)
    transport.broadcast(delta)
    expect(await uiBroadcast).toEqual(delta)
    expect(await agentBroadcast).toEqual(delta)
    transport.close()
  })

  it('removes listeners, closes ports, and reports disconnect once', async () => {
    const handler = vi.fn((request: RuntimeRequestEnvelope) => completed(request.requestId))
    const onDisconnect = vi.fn()
    const transport = new MessagePortTransport(handler, { onDisconnect })

    await exchange(transport.uiPort, hello('hello', 'ui', false))
    transport.closeClient('ui')
    transport.closeClient('ui')
    transport.uiPort.postMessage(stateGet('ignored'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(onDisconnect).toHaveBeenCalledTimes(1)
    expect(onDisconnect).toHaveBeenCalledWith({
      connectionId: 'ui-port',
      role: 'ui',
      origin: 'user',
      helloCompleted: true,
      cancelOnDisconnect: false,
    })
    expect(transport.sendTo('ui', completed('closed'))).toBe(false)

    transport.close()
    expect(onDisconnect).toHaveBeenCalledTimes(2)
  })

  it('detects peer close when the MessagePort implementation exposes a close event', async () => {
    const onDisconnect = vi.fn()
    const transport = new MessagePortTransport(
      (request) => completed(request.requestId),
      { onDisconnect },
    )
    await exchange(transport.agentPort, hello('hello-agent', 'agent'))

    transport.agentPort.close()
    await vi.waitFor(() => {
      expect(onDisconnect).toHaveBeenCalledWith({
        connectionId: 'agent-port',
        role: 'agent',
        origin: 'agent',
        helloCompleted: true,
        cancelOnDisconnect: true,
      })
    })
    transport.close()
  })
})
