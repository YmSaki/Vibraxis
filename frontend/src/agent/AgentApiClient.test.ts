import { describe, expect, it, vi } from 'vitest'
import { AgentApiClient, AgentApiError } from './AgentApiClient'
import type { AgentDecideRequest } from './contract'

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

const decideRequest = {
  route: 'deterministic',
  context: { marker: true },
  intent: { marker: true },
} as unknown as AgentDecideRequest

describe('AgentApiClient', () => {
  it('GETs the capability route and parses the descriptor', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(jsonResponse({
      routes: ['deterministic'],
      codexCandidateShortlist: 5,
      fallback: { optInRequired: true, modes: ['reject', 'deterministic'] },
      gpt56: { model: 'gpt-5.6-sol', deadlineMs: 1000 },
      codex: {
        workingDirectory: '/repo',
        sandboxMode: 'read-only',
        networkAccessEnabled: false,
        webSearchEnabled: false,
        webSearchMode: 'disabled',
        approvalPolicy: 'never',
        skipGitRepoCheck: false,
        model: null,
        reasoningEffort: null,
        deadlineMs: 1000,
      },
      availability: { gpt56: false, codexLocal: true },
    })))
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    const capability = await client.getCapability()
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/agent/capability')
    expect(init?.method).toBe('GET')
    expect(capability.routes).toEqual(['deterministic'])
    expect(capability.availability).toEqual({ gpt56: false, codexLocal: true })
  })

  it('POSTs the decide request verbatim as JSON', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(jsonResponse({
      outcome: 'rejected',
      requestedRoute: 'deterministic',
      usedDeterministicFallback: false,
      stages: [],
      failure: { code: 'no_candidate', detail: 'none' },
    })))
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await client.decide(decideRequest)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('/api/agent/decide')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(JSON.parse(init?.body as string)).toEqual(decideRequest)
  })

  it('returns a business "rejected" outcome as data (HTTP 200 is not an error)', async () => {
    const rejected = {
      outcome: 'rejected',
      requestedRoute: 'codex-local',
      usedDeterministicFallback: false,
      stages: [],
      failure: { code: 'codex_unavailable', detail: 'not configured' },
    }
    const fetchMock = vi.fn(async () => jsonResponse(rejected))
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).resolves.toEqual(rejected)
  })

  it('raises a typed http error for a non-200 transport failure', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'payload_too_large' }, { status: 413 }))
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).rejects.toMatchObject({ kind: 'http', status: 413 })
  })

  it('raises a typed malformed error when the body is not JSON', async () => {
    const fetchMock = vi.fn(async () => new Response('not json', { status: 200 }))
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.getCapability()).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('raises a typed malformed error when JSON violates the response contract', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ outcome: 'decided' }))
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).rejects.toMatchObject({ kind: 'malformed' })
  })

  const validIntent = {
    energyDirection: 'maintain',
    targetEnergy: null,
    preferredGenres: [],
    avoidedGenres: [],
    preferredMoods: [],
    avoidedMoods: [],
    tempoDirection: 'any',
    harmonicPriority: 'ignore',
    transitionUrgency: 'normal',
    requestedTrackId: null,
    excludedTrackIds: [],
    rationale: 'ok',
    confidence: 0.5,
  }
  const validDecision = {
    nextTrackId: 'next-a',
    targetDeckId: 'B',
    tempoSync: 'tempo',
    startAt: 'nextBar',
    crossfadeBars: 8,
    confidence: 0.9,
    reasons: ['select:next-a'],
  }
  const decided = (over: Record<string, unknown> = {}) => ({
    outcome: 'decided',
    requestedRoute: 'codex-local',
    decisionProvider: 'codex-local',
    usedDeterministicFallback: false,
    stages: [
      { stage: 'deterministic-selection', provider: 'deterministic', status: 'succeeded', durationMs: 1 },
      { stage: 'codex-decision', provider: 'codex-local', status: 'succeeded', durationMs: 12 },
    ],
    intent: { value: validIntent, source: 'caller' },
    decision: validDecision,
    ...over,
  })

  it('accepts a fully contract-conforming decided response', async () => {
    const body = decided()
    const fetchMock = vi.fn(async () => jsonResponse(body))
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).resolves.toEqual(body)
  })

  it('rejects a decided response whose DjIntent violates the schema (bad enum)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(decided({ intent: { value: { ...validIntent, energyDirection: 'sideways' }, source: 'caller' } })),
    )
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('rejects a decided response whose DjIntent confidence is out of [0,1]', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(decided({ intent: { value: { ...validIntent, confidence: 1.4 }, source: 'caller' } })),
    )
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('rejects additional properties forbidden by the published intent schema', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(decided({
      intent: { value: { ...validIntent, hiddenTransform: true }, source: 'caller' },
    })))
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('rejects a decided response whose DjDecision crossfadeBars is not a positive integer', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(decided({ decision: { ...validDecision, crossfadeBars: 8.5 } })),
    )
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('rejects a decided response with an empty reasons array (schema requires >= 1)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(decided({ decision: { ...validDecision, reasons: [] } })),
    )
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('rejects a decided response with an unknown intent source', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(decided({ intent: { value: validIntent, source: 'telepathy' } })),
    )
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('rejects a response with a stage duration that is negative', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(decided({ stages: [{ stage: 'codex-decision', provider: 'codex-local', status: 'succeeded', durationMs: -1 }] })),
    )
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('rejects a failed stage without its required failure', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(decided({
      stages: [{ stage: 'codex-decision', provider: 'codex-local', status: 'failed' }],
    })))
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('rejects a stage whose provider cannot produce that stage', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(decided({
      stages: [{ stage: 'codex-decision', provider: 'deterministic', status: 'succeeded' }],
    })))
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('rejects a stage history that the requested route cannot execute', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(decided({
      requestedRoute: 'deterministic',
      decisionProvider: 'deterministic',
      stages: [{ stage: 'gpt56-intent', provider: 'gpt-5.6', status: 'succeeded' }],
    })))
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('rejects caller-fallback provenance for a successful GPT-to-Codex decision', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(decided({
      requestedRoute: 'gpt56-codex',
      stages: [
        { stage: 'gpt56-intent', provider: 'gpt-5.6', status: 'succeeded' },
        { stage: 'codex-decision', provider: 'codex-local', status: 'succeeded' },
      ],
      intent: { value: validIntent, source: 'caller-fallback' },
    })))
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('rejects impossible decision-provider and fallback provenance', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(decided({
      decisionProvider: 'codex-local',
      usedDeterministicFallback: true,
    })))
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('rejects a rejected response whose failure code is not in the published union', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        outcome: 'rejected',
        requestedRoute: 'deterministic',
        usedDeterministicFallback: false,
        stages: [],
        failure: { code: 'kaboom', detail: 'nope' },
      }),
    )
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('rejects a no_candidate failure carrying an unknown reason code', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        outcome: 'rejected',
        requestedRoute: 'deterministic',
        usedDeterministicFallback: false,
        stages: [],
        failure: { code: 'no_candidate', detail: 'none', noCandidateReasons: [{ code: 'not-a-real-code', detail: 'x' }] },
      }),
    )
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).rejects.toMatchObject({ kind: 'malformed' })
  })

  it('accepts a no_candidate failure with a valid shared reason code', async () => {
    const body = {
      outcome: 'rejected',
      requestedRoute: 'deterministic',
      usedDeterministicFallback: false,
      stages: [],
      failure: { code: 'no_candidate', detail: 'none', noCandidateReasons: [{ code: 'allCandidatesExcluded', detail: 'x' }] },
    }
    const fetchMock = vi.fn(async () => jsonResponse(body))
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    await expect(client.decide(decideRequest)).resolves.toEqual(body)
  })

  it('raises a typed network error when fetch throws', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('connection refused')
    })
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    const error = await client.getCapability().catch((cause) => cause)
    expect(error).toBeInstanceOf(AgentApiError)
    expect(error.kind).toBe('network')
  })

  it('preserves the backend error and detail in an HTTP failure', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(
      { error: 'payload_too_large', detail: 'request exceeded the published limit' },
      { status: 413 },
    ))
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    const error = await client.decide(decideRequest).catch((cause) => cause)
    expect(error).toBeInstanceOf(AgentApiError)
    expect(error).toMatchObject({ kind: 'http', status: 413 })
    expect(error.message).toContain('payload_too_large')
    expect(error.message).toContain('request exceeded the published limit')
  })

  it('propagates aborts without wrapping them', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('aborted', 'AbortError')
    })
    const client = new AgentApiClient({ fetch: fetchMock as unknown as typeof fetch })
    const error = await client.getCapability().catch((cause) => cause)
    expect(error).toBeInstanceOf(DOMException)
    expect(error.name).toBe('AbortError')
  })
})
