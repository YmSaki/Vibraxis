import type { MutationHandle } from './VdapClient'

/** Resolves only for a successful VDAP terminal; every other terminal is non-success. */
export async function settleMutation(mutation: Promise<MutationHandle>): Promise<void> {
  const handle = await mutation
  const terminal = await handle.terminal
  switch (terminal.event) {
    case 'intent.completed':
      return
    case 'intent.failed':
      throw new Error(terminal.error.message)
    case 'intent.cancelled':
      throw new Error(`操作は取り消されました (${terminal.reason})。`)
    case 'intent.superseded':
      throw new Error(`操作は後続の操作に置き換えられました (${terminal.supersededBy})。`)
  }
}
