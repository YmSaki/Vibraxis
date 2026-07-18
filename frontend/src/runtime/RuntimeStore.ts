import type { DeckId, DeckState, RuntimeState } from '@vibraxis/shared/vdap'

export type RuntimeTimeProvider = () => number
export type RuntimeStateUpdater = (draft: RuntimeState) => void
export type RuntimeStoreListener = () => void

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T

export type RuntimeSnapshot = DeepReadonly<RuntimeState>

export type RuntimeStoreOptions = {
  runtimeTimeProvider: RuntimeTimeProvider
  initialState?: RuntimeState
}

function createEmptyDeck(deckId: DeckId, runtimeTime: number): DeckState {
  return {
    deckId,
    load: { phase: 'idle', intentId: null, progress: null },
    binding: null,
    transport: { phase: 'empty' },
    playback: {
      position: { sourceSeconds: 0, atRuntimeTime: runtimeTime },
      baseVelocity: 1,
      override: null,
      configuredVelocity: 1,
      headVelocity: 0,
      direction: 'stopped',
    },
    tempo: {
      interpretation: 'normal',
      baseBpm: null,
      interpretedBpm: null,
      effectiveBpm: null,
    },
    gain: 1,
    eq: { lowDb: 0, midDb: 0, highDb: 0 },
    pads: { selectedSlot: 1, slots: [] },
  }
}

export function createInitialRuntimeState(runtimeTime = 0): RuntimeState {
  if (!Number.isFinite(runtimeTime) || runtimeTime < 0) {
    throw new RangeError('runtimeTime must be a finite non-negative number')
  }

  return {
    revision: 1,
    runtimeTime,
    audio: {
      contextState: 'suspended',
      sampleRate: 48_000,
      outputLatencySeconds: 0,
    },
    mixer: {
      crossfader: {
        base: 0,
        override: null,
        effective: 0,
        curve: 'dj',
        automation: null,
      },
      masterGain: 0.8,
    },
    decks: {
      A: createEmptyDeck('A', runtimeTime),
      B: createEmptyDeck('B', runtimeTime),
    },
    intents: {},
  }
}

function requireOwn(value: object, key: PropertyKey, path: string): void {
  if (!Object.hasOwn(value, key)) {
    throw new TypeError(`Canonical runtime state is missing ${path}`)
  }
}

function assertCanonicalState(state: RuntimeState): void {
  if (!Number.isSafeInteger(state.revision) || state.revision < 1) {
    throw new RangeError('revision must be a positive safe integer')
  }
  if (!Number.isFinite(state.runtimeTime) || state.runtimeTime < 0) {
    throw new RangeError('runtimeTime must be a finite non-negative number')
  }

  requireOwn(state.mixer.crossfader, 'override', 'mixer.crossfader.override')
  requireOwn(state.mixer.crossfader, 'automation', 'mixer.crossfader.automation')

  for (const deckId of ['A', 'B'] as const) {
    requireOwn(state.decks, deckId, `decks.${deckId}`)
    const deck = state.decks[deckId]
    if (deck.deckId !== deckId) {
      throw new TypeError(`decks.${deckId}.deckId must be ${deckId}`)
    }
    requireOwn(deck, 'binding', `decks.${deckId}.binding`)
    requireOwn(deck.load, 'intentId', `decks.${deckId}.load.intentId`)
    requireOwn(deck.load, 'progress', `decks.${deckId}.load.progress`)
    requireOwn(deck.playback, 'override', `decks.${deckId}.playback.override`)
    requireOwn(deck.tempo, 'baseBpm', `decks.${deckId}.tempo.baseBpm`)
    requireOwn(deck.tempo, 'interpretedBpm', `decks.${deckId}.tempo.interpretedBpm`)
    requireOwn(deck.tempo, 'effectiveBpm', `decks.${deckId}.tempo.effectiveBpm`)
    requireOwn(deck, 'eq', `decks.${deckId}.eq`)
    requireOwn(deck.eq, 'lowDb', `decks.${deckId}.eq.lowDb`)
    requireOwn(deck.eq, 'midDb', `decks.${deckId}.eq.midDb`)
    requireOwn(deck.eq, 'highDb', `decks.${deckId}.eq.highDb`)

    if (
      deck.load.phase === 'idle' &&
      (deck.load.intentId !== null || deck.load.progress !== null)
    ) {
      throw new TypeError(`decks.${deckId}.load idle fields must be null`)
    }
  }
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}

function cloneState(state: RuntimeState): RuntimeState {
  return structuredClone(state)
}

export class RuntimeStore {
  readonly #runtimeTimeProvider: RuntimeTimeProvider
  readonly #listeners = new Set<RuntimeStoreListener>()
  #snapshot: RuntimeSnapshot

  constructor(options: RuntimeStoreOptions) {
    if (typeof options?.runtimeTimeProvider !== 'function') {
      throw new TypeError('runtimeTimeProvider is required')
    }
    this.#runtimeTimeProvider = options.runtimeTimeProvider

    const initialState = options.initialState
      ? cloneState(options.initialState)
      : createInitialRuntimeState(this.#readRuntimeTime())
    assertCanonicalState(initialState)
    this.#snapshot = deepFreeze(initialState)
  }

  getSnapshot = (): RuntimeSnapshot => this.#snapshot

  subscribe = (listener: RuntimeStoreListener): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  update(updater: RuntimeStateUpdater): RuntimeSnapshot {
    const previous = this.#snapshot
    const draft = cloneState(previous as RuntimeState)

    updater(draft)
    draft.revision = previous.revision + 1
    draft.runtimeTime = Math.max(previous.runtimeTime, this.#readRuntimeTime())
    assertCanonicalState(draft)

    this.#snapshot = deepFreeze(draft)
    for (const listener of [...this.#listeners]) {
      listener()
    }
    return this.#snapshot
  }

  #readRuntimeTime(): number {
    const runtimeTime = this.#runtimeTimeProvider()
    if (!Number.isFinite(runtimeTime) || runtimeTime < 0) {
      throw new RangeError(
        'runtimeTimeProvider must return a finite non-negative number',
      )
    }
    return runtimeTime
  }
}
