import { DECK_EQ_MAX_GAIN_DB, DECK_EQ_MIN_GAIN_DB } from '@vibraxis/shared/vdap'
import { clamp, djCrossfaderGains, equalPowerGains, MAX_PLAYBACK_RATE, MIN_PLAYBACK_RATE } from './audioMath'

export type DeckId = 'A' | 'B'
export type DeckEqBand = 'low' | 'mid' | 'high'
export type CrossfaderCurve = 'dj' | 'equalPower'

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

export type DeckLoadReceipt = Readonly<{ loadGeneration: number }>
export type PreparedDeckLoad = Readonly<{
  deckId: DeckId
  name: string
  buffer: AudioBuffer
  loadGeneration: number
}>

type DeckGraph = {
  buffer: AudioBuffer | null
  source: AudioBufferSourceNode | null
  inputGain: GainNode
  eqFilters: Record<DeckEqBand, BiquadFilterNode>
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
  private readonly decks: Record<DeckId, DeckGraph>
  private readonly listeners = new Set<Listener>()
  private readonly endedListeners = new Set<EndedListener>()
  private crossfader = 0
  private crossfaderCurve: CrossfaderCurve = 'dj'
  private masterVolume = 0.8
  private ticker: number | null = null
  private disposed = false

  constructor(context = new AudioContext()) {
    this.context = context
    this.masterGain = context.createGain()
    this.masterGain.gain.value = this.masterVolume
    this.masterGain.connect(context.destination)
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

  async loadFile(id: DeckId, file: File): Promise<DeckLoadReceipt | null> {
    const prepared = await this.prepareFile(id, file)
    return prepared ? this.commitPreparedLoad(prepared) : null
  }

  async loadUrl(id: DeckId, url: string, name: string): Promise<DeckLoadReceipt | null> {
    const prepared = await this.prepareUrl(id, url, name)
    return prepared ? this.commitPreparedLoad(prepared) : null
  }

  async prepareFile(id: DeckId, file: File): Promise<PreparedDeckLoad | null> {
    return this.prepareArrayBuffer(id, file.name, () => file.arrayBuffer())
  }

  async prepareUrl(id: DeckId, url: string, name: string): Promise<PreparedDeckLoad | null> {
    return this.prepareArrayBuffer(id, name, async () => {
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
  private async prepareArrayBuffer(
    id: DeckId,
    name: string,
    read: () => Promise<ArrayBuffer>,
  ): Promise<PreparedDeckLoad | null> {
    const deck = this.decks[id]
    const loadGeneration = ++deck.loadGeneration
    const data = await read()
    if (this.disposed || deck.loadGeneration !== loadGeneration) return null
    const buffer = await this.context.decodeAudioData(data.slice(0))
    if (this.disposed || deck.loadGeneration !== loadGeneration) return null
    return { deckId: id, name, buffer, loadGeneration }
  }

  commitPreparedLoad(
    prepared: PreparedDeckLoad,
    options: { emit?: boolean; initialOffset?: number } = {},
  ): DeckLoadReceipt | null {
    const deck = this.decks[prepared.deckId]
    if (this.disposed || deck.loadGeneration !== prepared.loadGeneration) return null
    this.stop(prepared.deckId, { emit: false })
    deck.buffer = prepared.buffer
    deck.name = prepared.name
    deck.offset = options.initialOffset ?? 0
    if (options.emit !== false) this.emit()
    return { loadGeneration: prepared.loadGeneration }
  }

  /** Publishes a load committed with `emit: false` after canonical state commits. */
  finalizePreparedLoad(id: DeckId, receipt: DeckLoadReceipt): boolean {
    if (!this.isLoadCurrent(id, receipt)) return false
    this.emit()
    return true
  }

  discardPreparedLoad(prepared: PreparedDeckLoad): void {
    const deck = this.decks[prepared.deckId]
    if (deck.loadGeneration === prepared.loadGeneration) deck.loadGeneration += 1
  }

  isLoadCurrent(id: DeckId, receipt: DeckLoadReceipt): boolean {
    return !this.disposed && this.decks[id].loadGeneration === receipt.loadGeneration
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
    const sourceGeneration = deck.generation + 1
    source.onended = () => {
      if (deck.generation !== sourceGeneration || !deck.playing) return
      const finalPosition = deck.buffer?.duration ?? this.positionFor(deck)
      deck.playing = false
      deck.source = null
      deck.offset = 0
      this.emit()
      this.endedListeners.forEach((listener) => listener(id, finalPosition))
    }
    const startOffset = deck.offset
    const startedAt = this.context.currentTime
    try {
      source.start(0, startOffset)
    } catch (error) {
      source.onended = null
      source.disconnect()
      deck.starting = false
      this.emit()
      throw error
    }
    deck.generation = sourceGeneration
    deck.source = source
    deck.startedAt = startedAt
    deck.offset = startOffset
    deck.playing = true
    deck.starting = false
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

  stop(id: DeckId, options: { emit?: boolean } = {}): void {
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
    if (options.emit !== false) this.emit()
  }

  unload(id: DeckId): void {
    const deck = this.decks[id]
    this.stop(id)
    deck.loadGeneration += 1
    deck.buffer = null
    deck.name = null
    this.emit()
  }

  async seek(id: DeckId, seconds: number): Promise<void> {
    const deck = this.decks[id]
    assertInRange(seconds, 0, deck.buffer?.duration ?? 0, 'Seek position')
    const wasPlaying = deck.playing
    if (wasPlaying) this.pause(id)
    deck.offset = seconds
    if (wasPlaying) await this.play(id)
    else this.emit()
  }

  setDeckGain(id: DeckId, value: number): void {
    assertInRange(value, 0, 1.5, 'Deck gain')
    const deck = this.decks[id]
    deck.gain = value
    deck.inputGain.gain.setTargetAtTime(deck.gain, this.context.currentTime, 0.01)
    this.emit()
  }

  setPlaybackRate(id: DeckId, value: number): void {
    assertInRange(value, MIN_PLAYBACK_RATE, MAX_PLAYBACK_RATE, 'Playback rate')
    const deck = this.decks[id]
    const next = value
    if (deck.playing) {
      deck.offset = this.positionFor(deck)
      deck.startedAt = this.context.currentTime
      deck.source?.playbackRate.setTargetAtTime(next, this.context.currentTime, 0.01)
    }
    deck.playbackRate = next
    this.emit()
  }

  setCrossfader(value: number, curve: CrossfaderCurve = 'dj'): void {
    assertInRange(value, -1, 1, 'Crossfader')
    this.crossfader = value
    this.crossfaderCurve = curve
    this.applyCrossfader()
    this.emit()
  }

  setDeckEq(id: DeckId, band: DeckEqBand, gainDb: number): void {
    assertInRange(gainDb, DECK_EQ_MIN_GAIN_DB, DECK_EQ_MAX_GAIN_DB, 'EQ gain')
    const deck = this.decks[id]
    deck.eqFilters[band].gain.setTargetAtTime(gainDb, this.context.currentTime, 0.01)
    this.emit()
  }

  setMasterVolume(value: number): void {
    assertInRange(value, 0, 1, 'Master volume')
    this.masterVolume = value
    this.masterGain.gain.setTargetAtTime(this.masterVolume, this.context.currentTime, 0.01)
    this.emit()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  /**
   * Returns the decoded buffer currently loaded on a deck, or null when empty.
   * Exposed as a read-only reference for one-shot waveform generation at load
   * time; the PCM is never copied into the periodic mixer snapshot.
   */
  getTrackBuffer(id: DeckId): AudioBuffer | null {
    return this.decks[id].buffer
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
    const lowEq = this.context.createBiquadFilter()
    lowEq.type = 'lowshelf'
    lowEq.frequency.value = 250
    lowEq.gain.value = 0
    const midEq = this.context.createBiquadFilter()
    midEq.type = 'peaking'
    midEq.frequency.value = 1_000
    midEq.Q.value = 1
    midEq.gain.value = 0
    const highEq = this.context.createBiquadFilter()
    highEq.type = 'highshelf'
    highEq.frequency.value = 4_000
    highEq.gain.value = 0
    const crossfadeGain = this.context.createGain()
    inputGain.connect(lowEq)
    lowEq.connect(midEq)
    midEq.connect(highEq)
    highEq.connect(crossfadeGain)
    crossfadeGain.connect(this.masterGain)
    return {
      buffer: null,
      source: null,
      inputGain,
      eqFilters: { low: lowEq, mid: midEq, high: highEq },
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
    const gains = this.crossfaderCurve === 'equalPower'
      ? equalPowerGains(this.crossfader)
      : djCrossfaderGains(this.crossfader)
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

function assertInRange(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}.`)
  }
}
