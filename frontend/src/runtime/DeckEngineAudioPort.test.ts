import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TrackAnalysis } from '@vibraxis/shared/analysis'
import { DeckEngine } from '../audio/DeckEngine'
import type { CatalogTrack } from '../catalog'
import { DeckEngineAudioPort } from './DeckEngineAudioPort'
import { RuntimeAudioError } from './RuntimeAudioPort'

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
  connect(): void {}
  constructor(private readonly context: FakeContext) {}
  start(): void {
    if (this.context.startError) throw this.context.startError
  }
  stop(): void {}
  disconnect(): void {}
}

class FakeContext {
  currentTime = 0
  state: AudioContextState = 'suspended'
  destination = {}
  sources: FakeSource[] = []
  biquads: FakeBiquad[] = []
  deferredDecode = false
  decodeResolvers: Array<(buffer: AudioBuffer) => void> = []
  decodedCount = 0
  startError: Error | null = null

  createGain(): FakeGain {
    return new FakeGain()
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
    this.state = 'running'
  }

  async close(): Promise<void> {
    this.state = 'closed'
  }

  decodeAudioData(): Promise<AudioBuffer> {
    this.decodedCount += 1
    if (this.deferredDecode) {
      return new Promise((resolve) => this.decodeResolvers.push(resolve))
    }
    return Promise.resolve({ duration: 30 } as AudioBuffer)
  }
}

const track: CatalogTrack = {
  trackId: 'track-1',
  title: 'Test Track',
  artist: 'BGMer',
  file: 'track1.mp3',
  genre: 'edm',
  mood: ['energetic'],
  bpm: 120,
  key: 'A',
  scale: 'minor',
  camelot: '8A',
  energy: 0.6,
  beatCount: 0,
  sectionSummary: [],
  performancePads: [],
  degreeFingerprint: [],
  license: 'BGMer License',
  licenseStatus: 'verified',
}

function createPort(options: { fetchAnalysis?: () => Promise<TrackAnalysis> } = {}) {
  const context = new FakeContext()
  const engine = new DeckEngine(context as unknown as AudioContext)
  let time = 0
  const port = new DeckEngineAudioPort({
    engine,
    resolveTrack: (trackId) => (trackId === track.trackId ? track : undefined),
    now: () => ++time,
    fetchAnalysis: options.fetchAnalysis ?? (() => Promise.reject(new Error('no analysis in test'))),
  })
  return { context, engine, port }
}

function analysisFixture(): TrackAnalysis {
  return {
    schemaVersion: 2,
    trackId: 'track-1',
    source: { file: 'track1.mp3', sha256: 'sha-abc', durationSeconds: 30, sampleRate: 44100 },
    analyzer: { provider: 'librosa', version: '1', analyzedAt: 'x', configHash: 'x' },
    capabilities: {
      features: { status: 'complete', provider: 'librosa', version: '1', confidence: 1, error: null },
      beatGrid: { status: 'partial', provider: 'librosa', version: '1', confidence: 0.8, error: null },
      harmony: { status: 'partial', provider: 'librosa', version: '1', confidence: 0.4, error: null },
      structure: { status: 'partial', provider: 'librosa', version: '1', confidence: 0.5, error: null },
    },
    tempo: {
      bpm: 120,
      rawBpm: 120,
      adjustment: 'none',
      timeSignature: '4/4',
      beatsSeconds: [0.5, 1, 1.5, 2],
      downbeatsSeconds: [0.5],
      barsSeconds: [0.5],
    },
    tonal: { key: 'A', scale: 'minor', camelot: '8A', confidence: 0.9, keyRegions: [] },
    harmony: { chords: [] },
    structure: { sections: [], phrases: [] },
    features: {
      energy: 0.6,
      rms: 0.2,
      loudnessDb: -12,
      dynamicRangeDb: 8,
      onsetRate: 2,
      spectralCentroidHz: 2000,
    },
    overridesApplied: [],
  } as unknown as TrackAnalysis
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => new ArrayBuffer(8),
  })))
  vi.stubGlobal('window', {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DeckEngineAudioPort', () => {
  it('maps VDAP EQ changes onto the selected deck filters', async () => {
    const { context, port } = createPort()

    await port.setEq('B', 'low', -26)
    await port.setEq('B', 'mid', 3.5)
    await port.setEq('B', 'high', 6)

    expect(context.biquads.slice(3).map((filter) => filter.gain.value)).toEqual([-26, 3.5, 6])
    expect(context.biquads.slice(0, 3).map((filter) => filter.gain.value)).toEqual([0, 0, 0])
  })

  it('loads a catalog track into a binding with the decoded duration', async () => {
    const { port } = createPort()
    const result = await port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
      requireAnalysis: false,
    })
    expect(result.binding.trackId).toBe('track-1')
    expect(result.binding.source).toEqual({
      kind: 'catalog',
      uri: '/tracks/track1.mp3',
      title: 'Test Track',
    })
    expect(result.binding.durationSeconds).toBe(30)
    expect(result.binding.analysis).toBeNull()
    expect(result.position.sourceSeconds).toBe(0)
  })

  it('fails an unknown catalog track and an analysis requirement with stable errors', async () => {
    const { port } = createPort()
    await expect(
      port.load({ deckId: 'A', source: { kind: 'catalog', trackId: 'missing' } }),
    ).rejects.toSatisfy(
      (cause) => cause instanceof RuntimeAudioError && cause.error.code === 'E_LOAD_FAILED',
    )
    await expect(
      port.load({
        deckId: 'A',
        source: { kind: 'catalog', trackId: 'track-1' },
        requireAnalysis: true,
      }),
    ).rejects.toSatisfy(
      (cause) =>
        cause instanceof RuntimeAudioError && cause.error.code === 'E_ANALYSIS_UNAVAILABLE',
    )
  })

  it('keeps the old audio playing when required analysis is unavailable', async () => {
    const { context, engine, port } = createPort()
    await port.load({
      deckId: 'A',
      source: { kind: 'url', url: 'blob:old', title: 'Old Track' },
    })
    await port.play('A')
    context.currentTime = 4

    await expect(port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
      requireAnalysis: true,
    })).rejects.toSatisfy(
      (cause) => cause instanceof RuntimeAudioError && cause.error.code === 'E_ANALYSIS_UNAVAILABLE',
    )

    const deck = engine.snapshot().decks.A
    expect(deck.name).toBe('Old Track')
    expect(deck.playing).toBe(true)
    expect(deck.position).toBeCloseTo(4)
  })

  it('does not replace live audio while prepared audio waits for analysis', async () => {
    let resolveAnalysis!: (analysis: TrackAnalysis) => void
    const analysis = new Promise<TrackAnalysis>((resolve) => { resolveAnalysis = resolve })
    const { context, engine, port } = createPort({ fetchAnalysis: () => analysis })
    await port.load({
      deckId: 'A',
      source: { kind: 'url', url: 'blob:old', title: 'Old Track' },
    })
    await port.play('A')
    context.deferredDecode = true

    const pending = port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
      requireAnalysis: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(context.decodeResolvers).toHaveLength(1)
    context.decodeResolvers[0]({ duration: 30 } as AudioBuffer)
    await Promise.resolve()
    context.currentTime = 3
    expect(engine.snapshot().decks.A).toMatchObject({ name: 'Old Track', playing: true })
    expect(engine.snapshot().decks.A.position).toBeCloseTo(3)

    resolveAnalysis(analysisFixture())
    await expect(pending).resolves.toMatchObject({ binding: { trackId: 'track-1' } })
    expect(engine.snapshot().decks.A).toMatchObject({ name: 'Test Track', playing: false })
  })

  it('plays, tracks position with the fake clock, and pauses', async () => {
    const { context, port } = createPort()
    await port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
      requireAnalysis: false,
    })
    await port.play('A')
    context.currentTime = 5
    const paused = await port.pause('A')
    expect(paused.sourceSeconds).toBeCloseTo(5)
  })

  it('applies an in-range initial position exactly', async () => {
    const { port } = createPort()
    const result = await port.load({
      deckId: 'A',
      source: { kind: 'url', url: 'blob:track', title: 'Track' },
      initialPosition: { sourceSeconds: 12.25 },
    })

    expect(result.position.sourceSeconds).toBe(12.25)
  })

  it('rejects beat-grid seeks until analysis is bound', async () => {
    const { port } = createPort()
    await port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
      requireAnalysis: false,
    })
    await expect(
      port.seek('A', { target: { type: 'beat', beatIndex: 4 }, resume: 'keep' }),
    ).rejects.toSatisfy(
      (cause) =>
        cause instanceof RuntimeAudioError && cause.error.code === 'E_QUANTIZE_UNAVAILABLE',
    )
    const seeked = await port.seek('A', {
      target: { type: 'sourceSeconds', sourceSeconds: 12 },
      resume: 'keep',
    })
    expect(seeked.sourceSeconds).toBe(12)
  })

  it('binds analysis fetched in parallel with the audio', async () => {
    const { port } = createPort({ fetchAnalysis: () => Promise.resolve(analysisFixture()) })
    const result = await port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
      requireAnalysis: true,
    })
    expect(result.binding.sha256).toBe('sha-abc')
    const analysis = result.binding.analysis
    expect(analysis).not.toBeNull()
    expect(analysis?.bpm).toBe(120)
    expect(analysis?.beatsPerBar).toBe(4)
    expect(analysis?.beatCount).toBe(4)
    expect(analysis?.barCount).toBe(1)
    expect(analysis?.firstDownbeatSeconds).toBe(0.5)
    expect(analysis?.camelot).toBe('8A')
    expect(analysis?.grid).toEqual({ available: true, confidence: 0.8, status: 'partial' })
  })

  it('preserves an unknown analysis confidence as null in the binding and full grid', async () => {
    const fixture = analysisFixture()
    fixture.capabilities.beatGrid.confidence = null
    const { port } = createPort({ fetchAnalysis: () => Promise.resolve(fixture) })

    const result = await port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
    })

    expect(result.binding.analysis?.grid.confidence).toBeNull()
    expect(port.getGrid(result.binding.bindingId)?.confidence).toBeNull()
  })

  it('reports an unknown first downbeat as null instead of substituting the first beat', async () => {
    const fixture = analysisFixture()
    fixture.tempo.downbeatsSeconds = []
    const { port } = createPort({ fetchAnalysis: () => Promise.resolve(fixture) })

    const result = await port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
    })

    expect(result.binding.analysis?.firstDownbeatSeconds).toBeNull()
  })

  it('caches a full grid for deck.getGrid and evicts it on unload', async () => {
    const { port } = createPort({ fetchAnalysis: () => Promise.resolve(analysisFixture()) })
    const result = await port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
      requireAnalysis: true,
    })
    const grid = port.getGrid(result.binding.bindingId)
    expect(grid).not.toBeNull()
    expect(grid?.beatsSeconds).toEqual([0.5, 1, 1.5, 2])
    expect(grid?.downbeatsSeconds).toEqual([0.5])
    expect(grid?.bpm).toBe(120)
    expect(grid?.confidence).toBe(0.8)

    await port.unload('A')
    expect(port.getGrid(result.binding.bindingId)).toBeNull()
  })

  it('degrades to a null analysis binding unless the load requires analysis', async () => {
    const { port } = createPort()
    const result = await port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
      requireAnalysis: false,
    })
    expect(result.binding.analysis).toBeNull()
    await expect(
      port.load({
        deckId: 'B',
        source: { kind: 'catalog', trackId: 'track-1' },
        requireAnalysis: true,
      }),
    ).rejects.toSatisfy(
      (cause) =>
        cause instanceof RuntimeAudioError && cause.error.code === 'E_ANALYSIS_UNAVAILABLE',
    )
  })

  it('uses the source-specific requireAnalysis default without overriding an explicit false', async () => {
    const { port } = createPort()

    await expect(port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
    })).rejects.toSatisfy(
      (cause) => cause instanceof RuntimeAudioError && cause.error.code === 'E_ANALYSIS_UNAVAILABLE',
    )

    await expect(port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
      requireAnalysis: false,
    })).resolves.toMatchObject({ binding: { analysis: null } })

    await expect(port.load({
      deckId: 'B',
      source: { kind: 'url', url: 'blob:url', title: 'URL Track' },
    })).resolves.toMatchObject({ binding: { analysis: null } })
  })

  it.each([
    ['harmony', (analysis: TrackAnalysis) => ({ ...analysis, harmony: {} })],
    ['structure', (analysis: TrackAnalysis) => ({ ...analysis, structure: { sections: null, phrases: [] } })],
    ['time signature', (analysis: TrackAnalysis) => ({
      ...analysis,
      tempo: { ...analysis.tempo, timeSignature: 'unknown' },
    })],
    ['beat order', (analysis: TrackAnalysis) => ({
      ...analysis,
      tempo: { ...analysis.tempo, beatsSeconds: [1, 0.5, 1.5, 2] },
    })],
    ['section label', (analysis: TrackAnalysis) => ({
      ...analysis,
      structure: {
        ...analysis.structure,
        sections: [{
          startSeconds: 0,
          endSeconds: 4,
          startBeat: 0,
          endBeat: 4,
          startBar: 0,
          endBar: 1,
          label: '' as TrackAnalysis['structure']['sections'][number]['label'],
          rawLabel: '',
          confidence: 1,
          energy: 0.5,
        }],
      },
    })],
  ])('rejects malformed %s analysis before replacing live audio or its grid', async (_field, corrupt) => {
    let returned = analysisFixture()
    const { context, engine, port } = createPort({
      fetchAnalysis: () => Promise.resolve(returned),
    })
    const old = await port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
    })
    await port.play('A')
    context.currentTime = 4
    returned = corrupt(analysisFixture()) as TrackAnalysis

    await expect(port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
    })).rejects.toSatisfy(
      (cause) => cause instanceof RuntimeAudioError && cause.error.code === 'E_ANALYSIS_UNAVAILABLE',
    )

    expect(engine.snapshot().decks.A).toMatchObject({
      name: 'Test Track',
      playing: true,
      position: 4,
    })
    expect(port.getGrid(old.binding.bindingId)?.beatsSeconds).toEqual([0.5, 1, 1.5, 2])
  })

  it('loads audio without analysis when fetched analysis is malformed but optional', async () => {
    const malformed = {
      ...analysisFixture(),
      tempo: { ...analysisFixture().tempo, beatsSeconds: [1, 0.5, 2] },
    } as TrackAnalysis
    const { engine, port } = createPort({ fetchAnalysis: () => Promise.resolve(malformed) })

    const loaded = await port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
      requireAnalysis: false,
    })

    expect(loaded.binding).toMatchObject({ trackId: 'track-1', sha256: null, analysis: null })
    expect(engine.snapshot().decks.A).toMatchObject({ name: 'Test Track', loaded: true })
  })

  it('rejects an initial position beyond duration before replacing live audio', async () => {
    const { context, engine, port } = createPort()
    await port.load({
      deckId: 'A',
      source: { kind: 'url', url: 'blob:old', title: 'Old Track' },
    })
    await port.play('A')
    context.currentTime = 4

    await expect(port.load({
      deckId: 'A',
      source: { kind: 'url', url: 'blob:new', title: 'New Track' },
      initialPosition: { sourceSeconds: 31 },
    })).rejects.toSatisfy(
      (cause) => cause instanceof RuntimeAudioError && cause.error.code === 'E_OUT_OF_RANGE',
    )

    expect(engine.snapshot().decks.A).toMatchObject({
      name: 'Old Track',
      playing: true,
      position: 4,
    })
  })

  it('rejects a seek beyond duration without applying resume or changing position', async () => {
    const { context, engine, port } = createPort()
    await port.load({
      deckId: 'A',
      source: { kind: 'url', url: 'blob:track', title: 'Track' },
    })
    await port.play('A')
    context.currentTime = 6

    await expect(port.seek('A', {
      target: { type: 'sourceSeconds', sourceSeconds: 31 },
      resume: 'pause',
    })).rejects.toSatisfy(
      (cause) => cause instanceof RuntimeAudioError && cause.error.code === 'E_OUT_OF_RANGE',
    )

    expect(engine.snapshot().decks.A).toMatchObject({ playing: true, position: 6 })
  })

  it('rejects a playing seek when the required restart fails', async () => {
    const { context, engine, port } = createPort()
    await port.load({
      deckId: 'A',
      source: { kind: 'url', url: 'blob:track', title: 'Track' },
    })
    await port.play('A')
    context.currentTime = 3
    context.startError = new Error('restart denied')

    await expect(port.seek('A', {
      target: { type: 'sourceSeconds', sourceSeconds: 9 },
      resume: 'keep',
    })).rejects.toSatisfy(
      (cause) => cause instanceof RuntimeAudioError
        && cause.error.code === 'E_AUDIO_LOCKED'
        && cause.error.message === 'restart denied',
    )
    expect(engine.snapshot().decks.A).toMatchObject({ playing: false, position: 9 })
  })

  it('publishes a silently committed load only when finalized', async () => {
    const { engine, port } = createPort()
    const observed: string[] = []
    const unsubscribe = engine.subscribe((snapshot) => observed.push(snapshot.decks.A.name ?? 'empty'))
    observed.length = 0

    const loaded = await port.load({
      deckId: 'A',
      source: { kind: 'url', url: 'blob:track', title: 'Track' },
    })
    expect(observed).toEqual([])

    loaded.finalize?.()
    loaded.finalize?.()
    expect(observed).toEqual(['Track'])
    unsubscribe()
  })

  it('rejects a superseded load even after the newer load has committed audio', async () => {
    const { context, port } = createPort()
    context.deferredDecode = true

    const oldLoad = port.load({
      deckId: 'A',
      source: { kind: 'url', url: 'blob:old', title: 'Old' },
    })
    const oldExpectation = expect(oldLoad).rejects.toSatisfy(
      (cause) =>
        cause instanceof RuntimeAudioError
        && cause.error.code === 'E_LOAD_FAILED'
        && cause.error.message.includes('superseded'),
    )
    while (context.decodeResolvers.length < 1) await Promise.resolve()
    const newLoad = port.load({
      deckId: 'A',
      source: { kind: 'url', url: 'blob:new', title: 'New' },
    })
    while (context.decodeResolvers.length < 2) await Promise.resolve()

    context.decodeResolvers[1]({ duration: 20 } as AudioBuffer)
    await expect(newLoad).resolves.toMatchObject({
      binding: { trackId: 'blob:new', durationSeconds: 20 },
    })
    context.decodeResolvers[0]({ duration: 40 } as AudioBuffer)
    await oldExpectation
  })

  it('rejects a prepared load that becomes stale while waiting for analysis', async () => {
    let resolveAnalysis!: (analysis: TrackAnalysis) => void
    const analysis = new Promise<TrackAnalysis>((resolve) => { resolveAnalysis = resolve })
    const { context, engine, port } = createPort({ fetchAnalysis: () => analysis })

    const oldLoad = port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
      requireAnalysis: true,
    })
    const oldExpectation = expect(oldLoad).rejects.toSatisfy(
      (cause) => cause instanceof RuntimeAudioError && cause.error.code === 'E_LOAD_FAILED',
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(context.decodedCount).toBe(1)
    expect(engine.snapshot().decks.A.loaded).toBe(false)
    await port.load({
      deckId: 'A',
      source: { kind: 'url', url: 'blob:newer', title: 'Newer' },
    })
    resolveAnalysis(analysisFixture())

    await oldExpectation
  })

  it('reports natural track ends through onTrackEnded', async () => {
    const { context, port } = createPort()
    const ended: Array<{ deckId: string; sourceSeconds: number }> = []
    port.onTrackEnded((deckId, position) =>
      ended.push({ deckId, sourceSeconds: position.sourceSeconds }),
    )
    await port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
      requireAnalysis: false,
    })
    await port.play('A')
    context.sources.at(-1)?.onended?.()
    expect(ended).toEqual([{ deckId: 'A', sourceSeconds: 30 }])
  })

  it('panic pauses both decks and reports their positions', async () => {
    const { context, port } = createPort()
    await port.load({
      deckId: 'A',
      source: { kind: 'catalog', trackId: 'track-1' },
      requireAnalysis: false,
    })
    await port.play('A')
    context.currentTime = 3
    const positions = await port.panic(undefined)
    expect(positions.A?.sourceSeconds).toBeCloseTo(3)
    expect(positions.B?.sourceSeconds).toBe(0)
  })
})
