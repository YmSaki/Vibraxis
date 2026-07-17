import { clamp, equalPowerGains, MAX_PLAYBACK_RATE, MIN_PLAYBACK_RATE } from './audioMath'

export type DeckId = 'A' | 'B'

export type DeckSnapshot = {
  id: DeckId
  name: string | null
  duration: number
  position: number
  gain: number
  playbackRate: number
  playing: boolean
  loaded: boolean
}

export type MixerSnapshot = {
  decks: Record<DeckId, DeckSnapshot>
  crossfader: number
  masterVolume: number
  audioReady: boolean
}

type DeckGraph = {
  buffer: AudioBuffer | null
  source: AudioBufferSourceNode | null
  inputGain: GainNode
  crossfadeGain: GainNode
  name: string | null
  gain: number
  playbackRate: number
  playing: boolean
  startedAt: number
  offset: number
  generation: number
  loadGeneration: number
  starting: boolean
}

type Listener = (snapshot: MixerSnapshot) => void
type EndedListener = (id: DeckId, positionSeconds: number) => void

export class DeckEngine {
  private readonly context: AudioContext
  private readonly masterGain: GainNode
  private readonly limiter: DynamicsCompressorNode
  private readonly decks: Record<DeckId, DeckGraph>
  private readonly listeners = new Set<Listener>()
  private readonly endedListeners = new Set<EndedListener>()
  private crossfader = 0
  private masterVolume = 0.8
  private ticker: number | null = null
  private disposed = false

  constructor(context = new AudioContext()) {
    this.context = context
    this.masterGain = context.createGain()
    this.masterGain.gain.value = this.masterVolume
    // Final peak protection: even with both decks at maximum gain through the
    // crossfader center, the output must not clip. A hard-knee compressor just
    // below 0 dBFS acts as the safety limiter required by the VDAP roadmap.
    this.limiter = context.createDynamicsCompressor()
    this.limiter.threshold.value = -1
    this.limiter.knee.value = 0
    this.limiter.ratio.value = 20
    this.limiter.attack.value = 0.003
    this.limiter.release.value = 0.25
    this.masterGain.connect(this.limiter)
    this.limiter.connect(context.destination)
    this.decks = {
      A: this.createDeck(),
      B: this.createDeck(),
    }
    this.applyCrossfader()
  }

  async resume(): Promise<void> {
    if (this.disposed) throw new Error('Audio engine has been disposed.')
    if (this.context.state !== 'running') await this.context.resume()
    this.startTicker()
    this.emit()
  }

  async loadFile(id: DeckId, file: File): Promise<void> {
    await this.loadArrayBuffer(id, file.name, () => file.arrayBuffer())
  }

  async loadUrl(id: DeckId, url: string, name: string): Promise<void> {
    await this.loadArrayBuffer(id, name, async () => {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`音源を取得できませんでした (${response.status})`)
      return response.arrayBuffer()
    })
  }

  /**
   * Staged load: the current buffer keeps playing untouched while the new
   * source is fetched and decoded. The live deck is only mutated after a
   * successful decode; a failed or superseded load leaves the old audio,
   * name, and transport state fully intact.
   */
  private async loadArrayBuffer(
    id: DeckId,
    name: string,
    read: () => Promise<ArrayBuffer>,
  ): Promise<void> {
    const deck = this.decks[id]
    const loadGeneration = ++deck.loadGeneration
    const data = await read()
    if (this.disposed || deck.loadGeneration !== loadGeneration) return
    const buffer = await this.context.decodeAudioData(data.slice(0))
    if (this.disposed || deck.loadGeneration !== loadGeneration) return
    this.stop(id)
    deck.buffer = buffer
    deck.name = name
    deck.offset = 0
    this.emit()
  }

  async play(id: DeckId): Promise<void> {
    const deck = this.decks[id]
    if (!deck.buffer || deck.playing || deck.starting) return
    deck.starting = true
    const generation = deck.generation
    try {
      await this.resume()
    } catch (error) {
      deck.starting = false
      this.emit()
      throw error
    }
    if (this.disposed || deck.generation !== generation || !deck.buffer) {
      deck.starting = false
      return
    }
    const source = this.context.createBufferSource()
    source.buffer = deck.buffer
    source.playbackRate.value = deck.playbackRate
    source.connect(deck.inputGain)
    const sourceGeneration = ++deck.generation
    source.onended = () => {
      if (deck.generation !== sourceGeneration || !deck.playing) return
      const finalPosition = deck.buffer?.duration ?? this.positionFor(deck)
      deck.playing = false
      deck.source = null
      deck.offset = 0
      this.emit()
      this.endedListeners.forEach((listener) => listener(id, finalPosition))
    }
    const startOffset = clamp(deck.offset, 0, Math.max(0, deck.buffer.duration - 0.01))
    deck.source = source
    deck.startedAt = this.context.currentTime
    deck.offset = startOffset
    deck.playing = true
    deck.starting = false
    source.start(0, startOffset)
    this.emit()
  }

  pause(id: DeckId): void {
    const deck = this.decks[id]
    if (!deck.playing) return
    deck.offset = this.positionFor(deck)
    deck.playing = false
    deck.starting = false
    deck.generation += 1
    deck.source?.stop()
    deck.source?.disconnect()
    deck.source = null
    this.emit()
  }

  stop(id: DeckId): void {
    const deck = this.decks[id]
    deck.playing = false
    deck.starting = false
    deck.offset = 0
    deck.generation += 1
    if (deck.source) {
      deck.source.stop()
      deck.source.disconnect()
      deck.source = null
    }
    this.emit()
  }

  unload(id: DeckId): void {
    const deck = this.decks[id]
    this.stop(id)
    deck.loadGeneration += 1
    deck.buffer = null
    deck.name = null
    this.emit()
  }

  seek(id: DeckId, seconds: number): void {
    const deck = this.decks[id]
    const wasPlaying = deck.playing
    if (wasPlaying) this.pause(id)
    deck.offset = clamp(seconds, 0, deck.buffer?.duration ?? 0)
    if (wasPlaying) void this.play(id)
    else this.emit()
  }

  setDeckGain(id: DeckId, value: number): void {
    const deck = this.decks[id]
    deck.gain = clamp(value, 0, 1.5)
    deck.inputGain.gain.setTargetAtTime(deck.gain, this.context.currentTime, 0.01)
    this.emit()
  }

  setPlaybackRate(id: DeckId, value: number): void {
    const deck = this.decks[id]
    const next = clamp(value, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE)
    if (deck.playing) {
      deck.offset = this.positionFor(deck)
      deck.startedAt = this.context.currentTime
      deck.source?.playbackRate.setTargetAtTime(next, this.context.currentTime, 0.01)
    }
    deck.playbackRate = next
    this.emit()
  }

  setCrossfader(value: number): void {
    this.crossfader = clamp(value, -1, 1)
    this.applyCrossfader()
    this.emit()
  }

  setMasterVolume(value: number): void {
    this.masterVolume = clamp(value, 0, 1)
    this.masterGain.gain.setTargetAtTime(this.masterVolume, this.context.currentTime, 0.01)
    this.emit()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  /** Fires when a deck reaches the natural end of its track. */
  onEnded(listener: EndedListener): () => void {
    this.endedListeners.add(listener)
    return () => this.endedListeners.delete(listener)
  }

  snapshot(): MixerSnapshot {
    return {
      decks: {
        A: this.deckSnapshot('A'),
        B: this.deckSnapshot('B'),
      },
      crossfader: this.crossfader,
      masterVolume: this.masterVolume,
      audioReady: this.context.state === 'running',
    }
  }

  dispose(): void {
    this.disposed = true
    this.decks.A.loadGeneration += 1
    this.decks.B.loadGeneration += 1
    if (this.ticker !== null) window.clearInterval(this.ticker)
    this.stop('A')
    this.stop('B')
    void this.context.close()
    this.listeners.clear()
    this.endedListeners.clear()
  }

  private createDeck(): DeckGraph {
    const inputGain = this.context.createGain()
    const crossfadeGain = this.context.createGain()
    inputGain.connect(crossfadeGain)
    crossfadeGain.connect(this.masterGain)
    return {
      buffer: null,
      source: null,
      inputGain,
      crossfadeGain,
      name: null,
      gain: 1,
      playbackRate: 1,
      playing: false,
      startedAt: 0,
      offset: 0,
      generation: 0,
      loadGeneration: 0,
      starting: false,
    }
  }

  private applyCrossfader(): void {
    const gains = equalPowerGains(this.crossfader)
    const now = this.context.currentTime
    this.decks.A.crossfadeGain.gain.setTargetAtTime(gains.a, now, 0.01)
    this.decks.B.crossfadeGain.gain.setTargetAtTime(gains.b, now, 0.01)
  }

  private positionFor(deck: DeckGraph): number {
    if (!deck.playing) return deck.offset
    const elapsed = (this.context.currentTime - deck.startedAt) * deck.playbackRate
    return clamp(deck.offset + elapsed, 0, deck.buffer?.duration ?? 0)
  }

  private deckSnapshot(id: DeckId): DeckSnapshot {
    const deck = this.decks[id]
    return {
      id,
      name: deck.name,
      duration: deck.buffer?.duration ?? 0,
      position: this.positionFor(deck),
      gain: deck.gain,
      playbackRate: deck.playbackRate,
      playing: deck.playing,
      loaded: deck.buffer !== null,
    }
  }

  private startTicker(): void {
    if (this.ticker !== null) return
    this.ticker = window.setInterval(() => {
      if (this.decks.A.playing || this.decks.B.playing) this.emit()
    }, 100)
  }

  private emit(): void {
    const snapshot = this.snapshot()
    this.listeners.forEach((listener) => listener(snapshot))
  }
}
