import { describe, expect, it } from 'vitest'
import type { MutationHandle } from './VdapClient'
import { settleMutation } from './settleMutation'

const handle = (terminal: Awaited<MutationHandle['terminal']>): Promise<MutationHandle> =>
  Promise.resolve({
    ack: {
      vdap: '1.0',
      kind: 'ack',
      requestId: terminal.requestId,
      state: 'accepted',
      intentId: terminal.intentId,
      revision: terminal.revision - 1,
    },
    terminal: Promise.resolve(terminal),
  })

const base = {
  vdap: '1.0' as const,
  kind: 'event' as const,
  intentId: 'it-1',
  requestId: 'req-1',
  revision: 2,
  runtimeTime: 1,
}

describe('settleMutation', () => {
  it('resolves only completed terminals', async () => {
    await expect(settleMutation(handle({
      ...base,
      event: 'intent.completed',
      result: {},
    }))).resolves.toBeUndefined()
  })

  it('rejects failed, cancelled, and superseded terminals', async () => {
    await expect(settleMutation(handle({
      ...base,
      event: 'intent.failed',
      error: { code: 'E_INTERNAL', retryable: false, message: 'broken' },
    }))).rejects.toThrow('broken')
    await expect(settleMutation(handle({
      ...base,
      event: 'intent.cancelled',
      reason: 'userOverride',
    }))).rejects.toThrow('userOverride')
    await expect(settleMutation(handle({
      ...base,
      event: 'intent.superseded',
      supersededBy: 'it-2',
    }))).rejects.toThrow('it-2')
  })
})
