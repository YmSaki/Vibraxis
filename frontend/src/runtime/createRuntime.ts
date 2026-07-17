import {
  VDAP_VERSION,
  type RuntimeState,
  type VdapSnapshot,
} from '@vibraxis/shared/vdap'
import type { DeckEngine } from '../audio/DeckEngine'
import { CommandDispatcher } from './CommandDispatcher'
import { DeckEngineAudioPort, type TrackResolver } from './DeckEngineAudioPort'
import { MessagePortTransport } from './MessagePortTransport'
import type { RuntimeAudioPort } from './RuntimeAudioPort'
import { RuntimeStore } from './RuntimeStore'
import { VdapClient } from './VdapClient'

/** Monotonic runtime clock shared by the store, the audio port, and UI extrapolation. */
export function runtimeNow(): number {
  return performance.now() / 1000
}

export type CreateRuntimeOptions = {
  engine?: DeckEngine
  resolveTrack?: TrackResolver
  /** Test seam: overrides the DeckEngine-backed audio port. */
  audio?: RuntimeAudioPort
  now?: () => number
  runtime?: { name: string; version: string }
  client?: { name: string; version: string }
}

export type VibraxisRuntime = {
  store: RuntimeStore
  transport: MessagePortTransport
  uiPort: MessagePort
  agentPort: MessagePort
  createUiClient(): VdapClient
  createAgentClient(): VdapClient
  dispose(): void
}

/**
 * Assembles the browser-local VDAP runtime: canonical store, audio port,
 * command dispatcher, and the two-role MessagePort transport. Snapshots are
 * pushed to every connection with an active state subscription on each
 * revision, so clients only ever render canonical runtime state.
 */
export function createRuntime(options: CreateRuntimeOptions = {}): VibraxisRuntime {
  const now = options.now ?? runtimeNow
  if (!options.audio && (!options.engine || !options.resolveTrack)) {
    throw new Error('createRuntime requires either an audio port or engine + resolveTrack.')
  }
  const store = new RuntimeStore({ runtimeTimeProvider: now })
  const audio =
    options.audio ??
    new DeckEngineAudioPort({
      engine: options.engine as DeckEngine,
      resolveTrack: options.resolveTrack as TrackResolver,
      now,
    })
  const dispatcher = new CommandDispatcher({ store, audio, runtime: options.runtime })
  const transport = new MessagePortTransport(dispatcher.handle)

  const unsubscribe = store.subscribe(() => {
    let message: VdapSnapshot | null = null
    for (const role of ['ui', 'agent'] as const) {
      if (!dispatcher.isSubscribed(transport.connectionIdFor(role))) continue
      message ??= {
        vdap: VDAP_VERSION,
        kind: 'snapshot',
        ...(structuredClone(store.getSnapshot()) as RuntimeState),
      }
      transport.sendTo(role, message)
    }
  })

  const detachEnded = audio.onTrackEnded?.((deckId, position) => {
    transport.broadcast(dispatcher.deckEnded(deckId, position))
  })

  const clientInfo = options.client ?? { name: 'vibraxis-frontend', version: '0.1.0' }
  return {
    store,
    transport,
    uiPort: transport.uiPort,
    agentPort: transport.agentPort,
    createUiClient: () => new VdapClient(transport.uiPort, { role: 'ui', client: clientInfo }),
    createAgentClient: () =>
      new VdapClient(transport.agentPort, { role: 'agent', client: clientInfo }),
    dispose: () => {
      detachEnded?.()
      unsubscribe()
      transport.close()
    },
  }
}
