import type { DeckId } from '../audio/DeckEngine'
import type { CatalogTrack } from '../catalog'

type Props = {
  tracks: CatalogTrack[]
  loading: boolean
  loadingDeck: DeckId | null
  loadedTrackIds: Partial<Record<DeckId, string>>
  onLoad: (deck: DeckId, track: CatalogTrack) => void
}

export function TrackLibrary({ tracks, loading, loadingDeck, loadedTrackIds, onLoad }: Props) {
  return (
    <section className="library" aria-label="Track library">
      <div className="library__header">
        <div>
          <p className="eyebrow">ANALYZED COLLECTION</p>
          <h2>TRACK LIBRARY</h2>
        </div>
        <span>{loading ? 'SCANNING…' : `${tracks.length} TRACKS READY`}</span>
      </div>

      <div className="library__grid">
        {tracks.map((track) => (
          <article className="track-card" key={track.trackId}>
            <div className="track-card__title">
              <div>
                <strong>{track.title}</strong>
                <span>{track.artist}</span>
              </div>
              <b>{Math.round(track.bpm)} BPM</b>
            </div>
            <div className="track-card__meta">
              <span>{track.key} {track.scale}</span>
              <span>{track.camelot}</span>
              <span>ENERGY {Math.round(track.energy * 100)}</span>
            </div>
            <div className="energy-bar" aria-label={`Energy ${Math.round(track.energy * 100)} percent`}>
              <i style={{ width: `${track.energy * 100}%` }} />
            </div>
            <div className="track-card__sections">
              {track.sectionSummary.slice(0, 6).map((section, index) => (
                <i
                  className={`section-dot section-dot--${section.label}`}
                  key={`${section.label}-${index}`}
                  title={`${section.label}: bars ${section.startBar}-${section.endBar}`}
                />
              ))}
              <span>{track.sectionSummary.length} SECTIONS</span>
            </div>
            <div className="track-card__actions">
              {(['A', 'B'] as DeckId[]).map((deck) => {
                const loaded = loadedTrackIds[deck] === track.trackId
                return (
                  <button
                    className={loaded ? 'is-loaded' : ''}
                    disabled={loadingDeck !== null}
                    key={deck}
                    onClick={() => onLoad(deck, track)}
                  >
                    {loadingDeck === deck ? 'LOADING…' : loaded ? `LOADED ${deck}` : `LOAD DECK ${deck}`}
                  </button>
                )
              })}
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
