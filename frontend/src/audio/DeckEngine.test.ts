import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInitialRuntimeState } from '../runtime/RuntimeStore'
import { DeckEngine } from './DeckEngine'

class FakeParam {
  value = 1

  setTargetAtTime(value: number): void {
    this.value = value
  }
}

class FakeGain {
  gain = new FakeParam()
  connections: unknown[] = []
  connect(target: unknown): void {
    this.connections.push(target)
  }
}

class FakeBiquad {
  type: BiquadFilterType = 'lowpass'
  frequency = new FakeParam()
  Q = new FakeParam()
  gain = new FakeParam()
  connect(): void {}
}

class FakeSource {
  buffer: AudioBuffer | null = null
  playbackRate = new FakeParam()
  onended: (() => void) | null = null
  disconnected = false
  startOffset: number | null = null

  constructor(private readonly context: FakeContext) {}

  connect(): void {}
  start(_when: number, offset: number): void {
    if (this.context.startError) throw this.context.startError
    this.startOffset = offset
  }
  stop(): void {}
  disconnect(): void {
    this.disconnected = true
  }
}

class FakeContext {
  currentTime = 0
  state: AudioContextState = 'suspended'
  destination = {}
  gains: FakeGain[] = []
  biquads: FakeBiquad[] = []
  resumeError: Error | null = null
  startError: Error | null = null
  sources: FakeSource[] = []
  deferredDecode = false
  decodeResolvers: Array<(buffer: AudioBuffer) => void> = []

  createGain(): FakeGain {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain
  }

  createBiquadFilter(): FakeBiquad {
    const filter = new FakeBiquad()
    this.biquads.push(filter)
    return filter
  }

  createBufferSource(): FakeSource {
    const source = new FakeSource(this)
    this.sources.push(source)
    return source
  }

  async resume(): Promise<void> {
    if (this.resumeError) throw this.resumeError
    this.state = 'running'
  }

  decodeAudioData(): Promise<AudioBuffer> {
    if (!this.deferredDecode) return Promise.resolve({ duration: 30 } as AudioBuffer)
    return new Promise((resolve) => this.decodeResolvers.push(resolve))
  }
}

function fakeFile(name: string): File {
  return {
    name,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  } as File
}

beforeEach(() => {
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DeckEngine mixer routing', () => {
  it('starts with the same master gain as canonical runtime state', () => {
    const context = new FakeContext()
    const engine = new DeckEngine(context as unknown as AudioContext)

    expect(engine.snapshot().masterVolume).toBe(createInitialRuntimeState().mixer.masterGain)
  })

  it('applies independent deck gain, equal-power crossfade, and master volume', () => {
    const context = new FakeContext()
    const engine = new DeckEngine(context as unknown as AudioContext)

    engine.setDeckGain('A', 1.25)
    engine.setMasterVolume(0.6)
    engine.setCrossfader(-1)

    expect(context.gains[0].gain.value).toBeCloseTo(0.6)
    expect(context.gains[1].gain.value).toBeCloseTo(1.25)
    expect(context.gains[2].gain.value).toBeCloseTo(1)
    expect(context.gains[4].gain.value).toBeCloseTo(0)
    expect(engine.snapshot().crossfader).toBe(-1)
  })

  it('uses a center-unity DJ curve for manual crossfader movement', () => {
    const context = new FakeContext()
    const engine = new DeckEngine(context as unknown as AudioContext)

    engine.setCrossfader(0)
    expect(context.gains[2].gain.value).toBe(1)
    expect(context.gains[4].gain.value).toBe(1)

    engine.setCrossfader(-0.5)
    expect(context.gains[2].gain.value).toBe(1)
    expect(context.gains[4].gain.value).toBe(0.5)

    engine.setCrossfader(0.5)
    expect(context.gains[2].gain.value).toBe(0.5)
    expect(context.gains[4].gain.value).toBe(1)
  })

  it('retains equal-power as an explicit automation curve', () => {
    const context = new FakeContext()
    const engine = new DeckEngine(context as unknown as AudioContext)

    engine.setCrossfader(0, 'equalPower')

    expect(context.gains[2].gain.value).toBeCloseTo(Math.SQRT1_2)
    expect(context.gains[4].gain.value).toBeCloseTo(Math.SQRT1_2)
  })

  it('creates and controls low, mid, and high EQ filters per deck', () => {
    const context = new FakeContext()
    const engine = new DeckEngine(context as unknown as AudioContext)

    expect(context.biquads).toHaveLength(6)
    expect(context.biquads.slice(0, 3).map((filter) => filter.type)).toEqual(['lowshelf', 'peaking', 'highshelf'])
    expect(context.biquads.slice(0, 3).map((filter) => filter.frequency.value)).toEqual([250, 1_000, 4_000])

    const mixerGainsBeforeEq = context.gains.map((node) => node.gain.value)
    engine.setDeckEq('A', 'low', -26)
    engine.setDeckEq('A', 'mid', 4)
    engine.setDeckEq('A', 'high', 6)

    expect(context.biquads[0].gain.value).toBe(-26)
    expect(context.biquads[1].gain.value).toBe(4)
    expect(context.biquads[2].gain.value).toBe(6)
    expect(context.gains.map((node) => node.gain.value)).toEqual(mixerGainsBeforeEq)

    engine.setDeckEq('A', 'low', 0)
    engine.setDeckEq('A', 'mid', 0)
    engine.setDeckEq('A', 'high', 0)
    expect(context.biquads.slice(0, 3).map((filter) => filter.gain.value)).toEqual([0, 0, 0])
    expect(context.gains.map((node) => node.gain.value)).toEqual(mixerGainsBeforeEq)
  })

  it('rejects invalid public mixer controls instead of silently clamping them', () => {
    const context = new FakeContext()
    const engine = new DeckEngine(context as unknown as AudioContext)

    expect(() => engine.setDeckGain('B', 99)).toThrow(RangeError)
    expect(() => engine.setPlaybackRate('B', 0)).toThrow(RangeError)
    expect(() => engine.setMasterVolume(-1)).toThrow(RangeError)
    expect(() => engine.setCrossfader(4)).toThrow(RangeError)
    expect(() => engine.setDeckEq('B', 'low', -26.1)).toThrow(RangeError)
    expect(() => engine.setDeckEq('B', 'high', 6.1)).toThrow(RangeError)

    const snapshot = engine.snapshot()
    expect(snapshot.decks.B.gain).toBe(1)
    expect(snapshot.decks.B.playbackRate).toBe(1)
    expect(snapshot.masterVolume).toBe(0.8)
    expect(snapshot.crossfader).toBe(0)
  })

  it('rejects seeks beyond the decoded duration without changing playback', async () => {
    const context = new FakeContext()
    const engine = new DeckEngine(context as unknown as AudioContext)
    await engine.loadFile('A', fakeFile('track.mp3'))
    await engine.seek('A', 5)

    await expect(engine.seek('A', 31)).rejects.toThrow(RangeError)

    expect(engine.snapshot().decks.A).toMatchObject({
      name: 'track.mp3',
      duration: 30,
      playing: false,
      position: 5,
    })
  })

  it('keeps the latest track when overlapping loads finish out of order', async () => {
    const context = new FakeContext()
    context.deferredDecode = true
    const engine = new DeckEngine(context as unknown as AudioContext)

    const first = engine.loadFile('A', fakeFile('old.mp3'))
    await Promise.resolve()
    const second = engine.loadFile('A', fakeFile('new.mp3'))
    await Promise.resolve()

    context.decodeResolvers[1]({ duration: 20 } as AudioBuffer)
    await expect(second).resolves.toMatchObject({ loadGeneration: 2 })
    context.decodeResolvers[0]({ duration: 40 } as AudioBuffer)
    await expect(first).resolves.toBeNull()

    expect(engine.snapshot().decks.A.name).toBe('new.mp3')
    expect(engine.snapshot().decks.A.duration).toBe(20)
  })

  it('does not report playing when AudioContext resume fails', async () => {
    const context = new FakeContext()
    const engine = new DeckEngine(context as unknown as AudioContext)
    await engine.loadFile('A', fakeFile('track.mp3'))
    context.resumeError = new Error('Audio permission denied')

    await expect(engine.play('A')).rejects.toThrow('Audio permission denied')
    expect(engine.snapshot().decks.A.playing).toBe(false)
  })

  it('rolls back source state when AudioBufferSourceNode.start throws', async () => {
    const context = new FakeContext()
    const engine = new DeckEngine(context as unknown as AudioContext)
    await engine.loadFile('A', fakeFile('track.mp3'))
    context.startError = new Error('Source start failed')

    await expect(engine.play('A')).rejects.toThrow('Source start failed')
    expect(engine.snapshot().decks.A).toMatchObject({ playing: false, position: 0 })
    expect(context.sources[0].disconnected).toBe(true)

    context.startError = null
    await expect(engine.play('A')).resolves.toBeUndefined()
    expect(engine.snapshot().decks.A.playing).toBe(true)
  })

  it('awaits and reports a failed restart when seeking during playback', async () => {
    const context = new FakeContext()
    const engine = new DeckEngine(context as unknown as AudioContext)
    await engine.loadFile('A', fakeFile('track.mp3'))
    await engine.play('A')
    context.currentTime = 4
    context.startError = new Error('Seek restart failed')

    await expect(engine.seek('A', 12)).rejects.toThrow('Seek restart failed')
    expect(engine.snapshot().decks.A).toMatchObject({ playing: false, position: 12 })
  })

  it('starts at the exact decoded duration and reports its natural end', async () => {
    const context = new FakeContext()
    const engine = new DeckEngine(context as unknown as AudioContext)
    const ended: number[] = []
    engine.onEnded((_deckId, position) => ended.push(position))
    await engine.loadFile('A', fakeFile('track.mp3'))
    await engine.seek('A', 30)

    await engine.play('A')

    expect(context.sources).toHaveLength(1)
    expect(context.sources[0].startOffset).toBe(30)
    expect(engine.snapshot().decks.A.playing).toBe(true)
    context.sources[0].onended?.()
    expect(engine.snapshot().decks.A).toMatchObject({ playing: false, position: 0 })
    expect(ended).toEqual([30])
  })

  it('loads a catalog track from its served URL', async () => {
    const context = new FakeContext()
    const engine = new DeckEngine(context as unknown as AudioContext)
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input) => {
      expect(input).toBe('/tracks/example.mp3')
      return new Response(new ArrayBuffer(8), { status: 200 })
    }

    try {
      await engine.loadUrl('B', '/tracks/example.mp3', 'Example Track')
      expect(engine.snapshot().decks.B.name).toBe('Example Track')
      expect(engine.snapshot().decks.B.loaded).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('reports a clear error when a catalog track cannot be fetched', async () => {
    const context = new FakeContext()
    const engine = new DeckEngine(context as unknown as AudioContext)
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response(null, { status: 404 })

    try {
      await expect(engine.loadUrl('A', '/tracks/missing.mp3', 'Missing')).rejects.toThrow('(404)')
      expect(engine.snapshot().decks.A.loaded).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('routes master gain directly to the destination without automatic dynamics processing', () => {
    const context = new FakeContext()
    void new DeckEngine(context as unknown as AudioContext)

    expect(context.gains).toHaveLength(5)
    expect(context.gains[0].connections).toEqual([context.destination])
  })

  it('staged load failure leaves the previous track fully intact', async () => {
    const context = new FakeContext()
    const engine = new DeckEngine(context as unknown as AudioContext)
    await engine.loadFile('A', fakeFile('old.mp3'))

    const failing = {
      name: 'bad.mp3',
      arrayBuffer: () => Promise.reject(new Error('network down')),
    } as unknown as File
    await expect(engine.loadFile('A', failing)).rejects.toThrow('network down')

    const deck = engine.snapshot().decks.A
    expect(deck.loaded).toBe(true)
    expect(deck.name).toBe('old.mp3')
  })
})
