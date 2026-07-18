import type { DeckId } from '@vibraxis/shared/vdap'

/** Owns only Blob URLs that are currently bound to a deck. */
export class DeckObjectUrls {
  readonly #current: Partial<Record<DeckId, string>> = {}

  async load(
    deckId: DeckId,
    file: File,
    commit: (url: string) => Promise<void>,
  ): Promise<void> {
    const next = URL.createObjectURL(file)
    try {
      await commit(next)
    } catch (cause) {
      URL.revokeObjectURL(next)
      throw cause
    }

    const previous = this.#current[deckId]
    this.#current[deckId] = next
    if (previous) URL.revokeObjectURL(previous)
  }

  clear(deckId: DeckId): void {
    const current = this.#current[deckId]
    if (!current) return
    delete this.#current[deckId]
    URL.revokeObjectURL(current)
  }

  dispose(): void {
    this.clear('A')
    this.clear('B')
  }
}
