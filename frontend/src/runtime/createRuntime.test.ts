import { describe, expect, it } from 'vitest'
import type {
  DeckId,
  DeckLoadParams,
  PositionPair,
  RuntimePanicParams,
  TrackBinding,
  VdapSnapshot,
} from '../../../shared/vdap'
import { createRuntime } from './createRuntime'
import type {
  AudioLoadResult,
  AudioSeekRequest,
  RuntimeAudioPort,
} from './RuntimeAudioPort'
import { VdapClient, VdapClientError } from './VdapClient'

class FakeAudioPort implements RuntimeAudioPort {
  calls: string[] = []
  pauseResult: Promise<PositionPair> | null = null
  #bindings = 0

  async load(params: DeckLoadParams): Promise<AudioLoadResult> {
    this.calls.push(`load:${params.deckId}`)
    const trackId = params.source.kind === 'catalog' ? params.source.trackId : params.source.url
    const binding: TrackBinding = {
      bindingId: `bind-${++this.#bindings}`,
      trackId,
      source: { kind: params.source.kind, uri: `uri:${trackId}`, title: trackId },
      sha256: null,
      durationSeconds: 120,
      analysis: null,
    }
    return { binding, position: { sourceSeconds: 0, atRuntimeTime: 0 } }
  }

  async unload(deckId: DeckId): Promise<void> {
    this.calls.push(`unload:${deckId}`)
  }

  async play(deckId: DeckId): Promise<PositionPair> {
    this.calls.push(`play:${deckId}`)
    return { sourceSeconds: 0, atRuntimeTime: 0 }
  }

  async pause(deckId: DeckId): Promise<PositionPair> {
    this.calls.push(`pause:${deckId}`)
    if (this.pauseResult) return this.pauseResult
    return { sourceSeconds: 1, atRuntimeTime: 0 }
  }

  async seek(deckId: DeckId, request: AudioSeekRequest): Promise<PositionPair> {
    this.calls.push(`seek:${deckId}`)
    const seconds = request.target.type === 'sourceSeconds' ? request.target.sourceSeconds : 0
    return { sourceSeconds: seconds, atRuntimeTime: 0 }
  }

  async setGain(deckId: DeckId): Promise<void> {
    this.calls.push(`gain:${deckId}`)
  }

  async setVelocity(deckId: DeckId): Promise<PositionPair | undefined> {
    this.calls.push(`velocity:${deckId}`)
    return undefined
  }

  async setCrossfader(): Promise<void> {
    this.calls.push('crossfader')
  }

  async setMasterGain(): Promise<void> {
    this.calls.push('master')
  }

  async panic(
    scope: RuntimePanicParams['scope'],
  ): Promise<Partial<Record<DeckId, PositionPair>>> {
    this.calls.push(`panic:${scope ?? 'all'}`)
    return {
      A: { sourceSeconds: 2, atRuntimeTime: 0 },
      B: { sourceSeconds: 0, atRuntimeTime: 0 },
    }
  }

  endedListener: ((deckId: DeckId, position: PositionPair) => void) | null = null

  onTrackEnded(listener: (deckId: DeckId, position: PositionPair) => void): () => void {
    this.endedListener = listener
    return () => {
      this.endedListener = null
    }
  }
}

function testRuntime() {
  const audio = new FakeAudioPort()
  const runtime = createRuntime({ audio, now: () => 1 })
  return { audio, runtime }
}

describe('createRuntime golden path', () => {
  it('drives load, play, crossfade, and panic through the ui MessagePort with snapshot delivery', async () => {
    const { audio, runtime } = testRuntime()
    const ui = runtime.createUiClient()
    try {
      await ui.hello()
      const snapshots: VdapSnapshot[] = []
      await ui.subscribeState((message) => {
        if (message.kind === 'snapshot') snapshots.push(message)
      })

      const load = await ui.mutate('deck.load', {
        deckId: 'A',
        source: { kind: 'catalog', trackId: 'track-1' },
      })
      expect((await load.terminal).event).toBe('intent.completed')

      const play = await ui.mutate('deck.play', { deckId: 'A' })
      expect((await play.terminal).event).toBe('intent.completed')

      const fade = await ui.mutate('mixer.setCrossfader', { position: 0.5 })
      expect((await fade.terminal).event).toBe('intent.completed')

      const state = await ui.query('state.get', {})
      expect(state.decks.A.transport.phase).toBe('playing')
      expect(state.decks.A.binding?.trackId).toBe('track-1')
      expect(state.mixer.crossfader.effective).toBe(0.5)
      expect(audio.calls).toContain('load:A')
      expect(audio.calls).toContain('play:A')

      const latest = snapshots.at(-1)
      expect(latest).toBeDefined()
      expect(latest?.mixer.crossfader.effective).toBe(0.5)

      const panic = await ui.mutate('runtime.panic', {})
      expect((await panic.terminal).event).toBe('intent.completed')
      const after = await ui.query('state.get', {})
      expect(after.decks.A.transport.phase).toBe('ready')
      expect(after.decks.A.playback.headVelocity).toBe(0)
      expect(after.decks.A.playback.direction).toBe('stopped')
    } finally {
      ui.close()
      runtime.dispose()
    }
  })

  it('broadcasts deck.ended and marks the deck ended when the audio layer reports a natural end', async () => {
    const { audio, runtime } = testRuntime()
    const ui = runtime.createUiClient()
    try {
      await ui.hello()
      const events: string[] = []
      ui.onEvent((event) => events.push(event.event))
      await (await ui.mutate('deck.load', {
        deckId: 'A',
        source: { kind: 'catalog', trackId: 'track-1' },
      })).terminal
      await (await ui.mutate('deck.play', { deckId: 'A' })).terminal

      audio.endedListener?.('A', { sourceSeconds: 120, atRuntimeTime: 1 })
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(events).toContain('deck.ended')
      const state = await ui.query('state.get', {})
      expect(state.decks.A.transport.phase).toBe('ended')
      expect(state.decks.A.playback.position.sourceSeconds).toBe(120)
      expect(state.decks.A.playback.headVelocity).toBe(0)
    } finally {
      ui.close()
      runtime.dispose()
    }
  })

  it('keeps the natural end state when an earlier pause resolves late', async () => {
    const { audio, runtime } = testRuntime()
    const ui = runtime.createUiClient()
    try {
      await ui.hello()
      await (await ui.mutate('deck.load', {
        deckId: 'A',
        source: { kind: 'catalog', trackId: 'track-1' },
      })).terminal
      await (await ui.mutate('deck.play', { deckId: 'A' })).terminal

      let resolvePause!: (position: PositionPair) => void
      audio.pauseResult = new Promise((resolve) => { resolvePause = resolve })
      const pause = await ui.mutate('deck.pause', { deckId: 'A' })
      audio.endedListener?.('A', { sourceSeconds: 120, atRuntimeTime: 1 })
      resolvePause({ sourceSeconds: 0, atRuntimeTime: 1 })
      expect((await pause.terminal).event).toBe('intent.completed')

      const state = await ui.query('state.get', {})
      expect(state.decks.A.transport.phase).toBe('ended')
      expect(state.decks.A.playback.position.sourceSeconds).toBe(120)
      expect(state.decks.A.playback.headVelocity).toBe(0)
    } finally {
      ui.close()
      runtime.dispose()
    }
  })

  it('allows a new play accepted after natural end to update canonical state', async () => {
    const { audio, runtime } = testRuntime()
    const ui = runtime.createUiClient()
    try {
      await ui.hello()
      await (await ui.mutate('deck.load', {
        deckId: 'A',
        source: { kind: 'catalog', trackId: 'track-1' },
      })).terminal
      await (await ui.mutate('deck.play', { deckId: 'A' })).terminal
      audio.endedListener?.('A', { sourceSeconds: 120, atRuntimeTime: 1 })

      const replay = await ui.mutate('deck.play', { deckId: 'A' })
      expect((await replay.terminal).event).toBe('intent.completed')
      const state = await ui.query('state.get', {})
      expect(state.decks.A.transport.phase).toBe('playing')
      expect(state.decks.A.playback.position.sourceSeconds).toBe(0)
      expect(state.decks.A.playback.headVelocity).toBe(1)
      expect(state.decks.A.playback.direction).toBe('forward')
    } finally {
      ui.close()
      runtime.dispose()
    }
  })

  it('rejects an agent load into a playing deck without an explicit replacement', async () => {
    const { runtime } = testRuntime()
    const ui = runtime.createUiClient()
    const agent = runtime.createAgentClient()
    try {
      await ui.hello()
      await agent.hello()
      await (await ui.mutate('deck.load', {
        deckId: 'A',
        source: { kind: 'catalog', trackId: 'track-1' },
      })).terminal
      await (await ui.mutate('deck.play', { deckId: 'A' })).terminal

      let caught: unknown
      try {
        await agent.mutate('deck.load', {
          deckId: 'A',
          source: { kind: 'catalog', trackId: 'track-2' },
        })
      } catch (cause) {
        caught = cause
      }
      expect(caught).toBeInstanceOf(VdapClientError)
      expect((caught as VdapClientError).ack?.error.code).toBe('E_DECK_PLAYING')
    } finally {
      ui.close()
      agent.close()
      runtime.dispose()
    }
  })

  it('fixes the port role at creation time and rejects a mismatched hello', async () => {
    const { runtime } = testRuntime()
    const impostor = new VdapClient(runtime.uiPort, {
      role: 'agent',
      client: { name: 'impostor', version: '0.0.0' },
    })
    try {
      let caught: unknown
      try {
        await impostor.hello()
      } catch (cause) {
        caught = cause
      }
      expect(caught).toBeInstanceOf(VdapClientError)
      expect((caught as VdapClientError).ack?.error.code).toBe('E_ROLE_MISMATCH')
    } finally {
      impostor.close()
      runtime.dispose()
    }
  })
})
