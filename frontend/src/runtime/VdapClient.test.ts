import { describe, expect, it, vi } from 'vitest'
import {
  VDAP_VERSION,
  type SessionHelloResult,
  type VdapAcceptedAck,
  type VdapCompletedAck,
  type VdapEvent,
  type VdapRequest,
} from '@vibraxis/shared/vdap'
import { VdapClient, VdapClientError } from './VdapClient'

function createHarness(options: Partial<ConstructorParameters<typeof VdapClient>[1]> = {}) {
  const channel = new MessageChannel()
  let sequence = 0
  const requests: VdapRequest[] = []
  const handlers = new Set<(request: VdapRequest) => void>()
  channel.port2.addEventListener('message', (event) => {
    const request = event.data as VdapRequest
    requests.push(request)
    for (const handler of handlers) handler(request)
  })
  channel.port2.start()
  const client = new VdapClient(channel.port1, {
    role: 'ui',
    client: { name: 'client-test', version: '0.1.0' },
    requestIdFactory: () => `request-${++sequence}`,
    ...options,
  })
  return {
    client,
    requests,
    respond(message: unknown) {
      channel.port2.postMessage(message)
    },
    onRequest(handler: (request: VdapRequest) => void) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    close() {
      client.close()
      channel.port2.close()
    },
  }
}

const helloResult: SessionHelloResult = {
  protocolVersion: VDAP_VERSION,
  runtime: { name: 'test-runtime', version: '0.1.0' },
  role: 'ui',
  profile: 'core',
  deckIds: ['A', 'B'],
  capabilities: {},
  limits: {
    maxScheduleHorizonSeconds: 300,
    maxPendingIntents: 32,
    idempotencyWindowSeconds: 60,
    gainRange: { min: 0, max: 1.5 },
    masterRange: { min: 0, max: 1 },
  },
  revision: 1,
}

function completed(requestId: string, result: VdapCompletedAck['result']): VdapCompletedAck {
  return { vdap: VDAP_VERSION, kind: 'ack', requestId, state: 'completed', revision: 1, result }
}

function accepted(requestId: string, intentId: string): VdapAcceptedAck {
  return {
    vdap: VDAP_VERSION,
    kind: 'ack',
    requestId,
    state: 'accepted',
    intentId,
    revision: 2,
  }
}

function terminal(requestId: string, intentId: string): VdapEvent {
  return {
    vdap: VDAP_VERSION,
    kind: 'event',
    event: 'intent.completed',
    requestId,
    intentId,
    revision: 3,
    runtimeTime: 10,
    result: {},
  }
}

async function connect(harness: ReturnType<typeof createHarness>): Promise<void> {
  harness.onRequest((request) => {
    if (request.command === 'session.hello') {
      harness.respond(completed(request.requestId, helloResult))
    }
  })
  await harness.client.hello()
}

describe('VdapClient', () => {
  it('sends hello with a generated requestId and resolves completed queries', async () => {
    const harness = createHarness()
    harness.onRequest((request) => {
      if (request.command === 'session.hello') {
        harness.respond(completed(request.requestId, helloResult))
      } else if (request.command === 'state.get') {
        harness.respond(completed(request.requestId, { revision: 7 }))
      }
    })

    await expect(harness.client.hello()).resolves.toEqual(helloResult)
    await expect(harness.client.query('state.get', {})).resolves.toEqual({ revision: 7 })
    expect(harness.requests).toMatchObject([
      { requestId: 'request-1', command: 'session.hello', params: { role: 'ui' } },
      { requestId: 'request-2', command: 'state.get' },
    ])
    harness.close()
  })

  it('registers the intent before resolving accepted ack and correlates its terminal event', async () => {
    const harness = createHarness()
    await connect(harness)
    harness.onRequest((request) => {
      if (request.command === 'deck.play') {
        harness.respond(accepted(request.requestId, 'intent-play'))
      }
    })

    const handle = await harness.client.mutate('deck.play', { deckId: 'B' })
    expect(handle.ack.intentId).toBe('intent-play')
    expect(harness.client.pendingRequestCount).toBe(0)
    expect(harness.client.pendingIntentCount).toBe(1)

    harness.respond(terminal(handle.ack.requestId, handle.ack.intentId))
    await expect(handle.terminal).resolves.toMatchObject({ event: 'intent.completed' })
    expect(harness.client.pendingIntentCount).toBe(0)
    harness.close()
  })

  it('subscribes to snapshot/delta and sends unsubscribe only for the last listener', async () => {
    const harness = createHarness()
    await connect(harness)
    let intentSequence = 0
    harness.onRequest((request) => {
      if (request.command === 'state.subscribe' || request.command === 'state.unsubscribe') {
        const intentId = `intent-sub-${++intentSequence}`
        harness.respond(accepted(request.requestId, intentId))
        harness.respond(terminal(request.requestId, intentId))
      }
    })
    const first = vi.fn()
    const second = vi.fn()

    const unsubscribeFirst = await harness.client.subscribeState(first)
    const unsubscribeSecond = await harness.client.subscribeState(second)
    harness.respond({
      vdap: VDAP_VERSION,
      kind: 'delta',
      fromRevision: 1,
      toRevision: 2,
      runtimeTime: 2,
      patch: [],
    })
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1))
    expect(second).toHaveBeenCalledTimes(1)

    await unsubscribeFirst()
    expect(harness.requests.filter((request) => request.command === 'state.unsubscribe')).toHaveLength(0)
    await unsubscribeSecond()
    expect(harness.requests.filter((request) => request.command === 'state.subscribe')).toHaveLength(1)
    expect(harness.requests.filter((request) => request.command === 'state.unsubscribe')).toHaveLength(1)

    harness.respond({
      vdap: VDAP_VERSION,
      kind: 'snapshot',
      revision: 3,
      runtimeTime: 3,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    harness.close()
  })

  it('times out without retrying and removes the pending request', async () => {
    vi.useFakeTimers()
    const harness = createHarness({ requestTimeoutMs: 10 })
    harness.onRequest((request) => {
      if (request.command === 'session.hello') harness.respond(completed(request.requestId, helloResult))
    })
    const helloPromise = harness.client.hello()
    await vi.advanceTimersByTimeAsync(0)
    await helloPromise

    const query = harness.client.query('state.get', {})
    const timeoutExpectation = expect(query).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(11)
    await timeoutExpectation
    expect(harness.requests.filter((request) => request.command === 'state.get')).toHaveLength(1)
    expect(harness.client.pendingRequestCount).toBe(0)
    harness.close()
    vi.useRealTimers()
  })

  it('close rejects pending requests and intents and removes listeners', async () => {
    const harness = createHarness()
    await connect(harness)
    const stateListener = vi.fn()
    const removeStateListener = harness.client.onState(stateListener)
    harness.onRequest((request) => {
      if (request.command === 'deck.play') {
        harness.respond(accepted(request.requestId, 'intent-close'))
      }
    })
    const handle = await harness.client.mutate('deck.play', { deckId: 'B' })
    const query = harness.client.query('state.get', {})
    expect(harness.client.pendingRequestCount).toBe(1)
    expect(harness.client.pendingIntentCount).toBe(1)

    harness.client.close()
    await expect(query).rejects.toBeInstanceOf(VdapClientError)
    await expect(handle.terminal).rejects.toMatchObject({ code: 'CLOSED' })
    expect(harness.client.pendingRequestCount).toBe(0)
    expect(harness.client.pendingIntentCount).toBe(0)
    removeStateListener()
    harness.respond({ vdap: VDAP_VERSION, kind: 'snapshot', revision: 4, runtimeTime: 4 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stateListener).not.toHaveBeenCalled()
    harness.close()
  })
})
