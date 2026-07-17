import { describe, expect, it } from 'vitest'
import { DeckEngine } from './DeckEngine'

class FakeParam {
  value = 1

  setTargetAtTime(value: number): void {
    this.value = value
  }
}

class FakeGain {
  gain = new FakeParam()
  connect(): void {}
}

class FakeCompressor {
  threshold = new FakeParam()
  knee = new FakeParam()
  ratio = new FakeParam()
  attack = new FakeParam()
  release = new FakeParam()
  connect(): void {}
}

class FakeContext {
  currentTime = 0
  state: AudioContextState = 'suspended'
  destination = {}
  gains: FakeGain[] = []
  compressors: FakeCompressor[] = []
  resumeError: Error | null = null
  deferredDecode = false
  decodeResolvers: Array<(buffer: AudioBuffer) => void> = []

  createGain(): FakeGain {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain
  }

  createDynamicsCompressor(): FakeCompressor {
    const compressor = new FakeCompressor()
    this.compressors.push(compressor)
    return compressor
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

describe('DeckEngine mixer routing', () => {
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

  it('clamps all public mixer controls to safe ranges', () => {
    const context = new FakeContext()
    const engine = new DeckEngine(context as unknown as AudioContext)

    engine.setDeckGain('B', 99)
    engine.setPlaybackRate('B', 0)
    engine.setMasterVolume(-1)
    engine.setCrossfader(4)

    const snapshot = engine.snapshot()
    expect(snapshot.decks.B.gain).toBe(1.5)
    expect(snapshot.decks.B.playbackRate).toBe(0.5)
    expect(snapshot.masterVolume).toBe(0)
    expect(snapshot.crossfader).toBe(1)
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
    await second
    context.decodeResolvers[0]({ duration: 40 } as AudioBuffer)
    await first

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

  it('routes the master bus through a limiter for final peak protection', () => {
    const context = new FakeContext()
    void new DeckEngine(context as unknown as AudioContext)

    expect(context.compressors).toHaveLength(1)
    const limiter = context.compressors[0]
    expect(limiter.threshold.value).toBeLessThan(0)
    expect(limiter.ratio.value).toBeGreaterThanOrEqual(20)
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
