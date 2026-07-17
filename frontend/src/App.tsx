import { useEffect, useMemo, useState } from 'react'
import { DeckEngine, type DeckId, type MixerSnapshot } from './audio/DeckEngine'
import { calculateTempoSync, interpretedBpm, type TempoMultiplier } from './audio/audioMath'
import { fetchCatalog, trackAudioUrl, type CatalogTrack } from './catalog'
import { Deck } from './components/Deck'
import { TrackLibrary } from './components/TrackLibrary'
import './styles.css'

const initialSnapshot: MixerSnapshot = {
  decks: {
    A: { id: 'A', name: null, duration: 0, position: 0, gain: 1, playbackRate: 1, playing: false, loaded: false },
    B: { id: 'B', name: null, duration: 0, position: 0, gain: 1, playbackRate: 1, playing: false, loaded: false },
  },
  crossfader: 0,
  masterVolume: 0.8,
  audioReady: false,
}

export default function App() {
  const engine = useMemo(() => new DeckEngine(), [])
  const [mixer, setMixer] = useState(initialSnapshot)
  const [error, setError] = useState<string | null>(null)
  const [tracks, setTracks] = useState<CatalogTrack[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [loadingDeck, setLoadingDeck] = useState<DeckId | null>(null)
  const [deckTracks, setDeckTracks] = useState<Partial<Record<DeckId, CatalogTrack>>>({})
  const [syncNotice, setSyncNotice] = useState<string | null>(null)
  const [tempoMultipliers, setTempoMultipliers] = useState<Record<DeckId, TempoMultiplier>>({ A: 1, B: 1 })
  const [selectedCueSlots, setSelectedCueSlots] = useState<Record<DeckId, number>>({ A: 1, B: 1 })

  useEffect(() => {
    const unsubscribe = engine.subscribe(setMixer)
    return () => {
      unsubscribe()
      engine.dispose()
    }
  }, [engine])

  useEffect(() => {
    const controller = new AbortController()
    fetchCatalog(controller.signal)
      .then(setTracks)
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setError(cause instanceof Error ? cause.message : '楽曲カタログを読み込めませんでした。')
      })
      .finally(() => setCatalogLoading(false))
    return () => controller.abort()
  }, [])

  const loadTrack = async (id: DeckId, file: File) => {
    try {
      setError(null)
      setSyncNotice(null)
      setTempoMultipliers((current) => ({ ...current, [id]: 1 }))
      setSelectedCueSlots((current) => ({ ...current, [id]: 1 }))
      setDeckTracks((current) => ({ ...current, [id]: undefined }))
      await engine.resume()
      await engine.loadFile(id, file)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '音源を読み込めませんでした。')
    }
  }

  const loadCatalogTrack = async (id: DeckId, track: CatalogTrack) => {
    try {
      setError(null)
      setSyncNotice(null)
      setLoadingDeck(id)
      await engine.resume()
      await engine.loadUrl(id, trackAudioUrl(track), track.title)
      setDeckTracks((current) => ({ ...current, [id]: track }))
      setTempoMultipliers((current) => ({ ...current, [id]: 1 }))
      setSelectedCueSlots((current) => ({ ...current, [id]: 1 }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'カタログ音源を読み込めませんでした。')
    } finally {
      setLoadingDeck(null)
    }
  }

  const togglePlayback = async (id: DeckId) => {
    try {
      setError(null)
      if (mixer.decks[id].playing) engine.pause(id)
      else await engine.play(id)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '音声を再生できませんでした。')
    }
  }

  const enableAudio = async () => {
    try {
      setError(null)
      await engine.resume()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Audioを有効にできませんでした。')
    }
  }

  const syncTempoTo = (masterId: DeckId) => {
    const followerId: DeckId = masterId === 'A' ? 'B' : 'A'
    const masterTrack = deckTracks[masterId]
    const followerTrack = deckTracks[followerId]
    if (!masterTrack || !followerTrack) return

    try {
      setError(null)
      const result = calculateTempoSync(
        interpretedBpm(masterTrack.bpm, tempoMultipliers[masterId]),
        mixer.decks[masterId].playbackRate,
        interpretedBpm(followerTrack.bpm, tempoMultipliers[followerId]),
      )
      engine.setPlaybackRate(followerId, result.playbackRate)
      setSyncNotice(
        result.exact
          ? `Deck ${followerId} synced to Deck ${masterId} at ${result.targetBpm.toFixed(1)} BPM.`
          : `Deck ${followerId} reached its speed limit (${result.playbackRate.toFixed(2)}×); exact ${result.targetBpm.toFixed(1)} BPM sync is unavailable.`,
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'テンポを同期できませんでした。')
    }
  }

  const tempoSyncDisabled = !deckTracks.A || !deckTracks.B || loadingDeck !== null

  const triggerCue = (id: DeckId) => {
    const cue = deckTracks[id]?.performancePads.find((pad) => pad.slot === selectedCueSlots[id])
    if (!cue) {
      engine.stop(id)
      return
    }
    engine.pause(id)
    engine.seek(id, cue.sourceSeconds)
  }

  const triggerPerformancePad = (id: DeckId, slot: number, seconds: number) => {
    setSelectedCueSlots((current) => ({ ...current, [id]: slot }))
    engine.seek(id, seconds)
  }

  const deckProps = (id: DeckId) => ({
    id,
    deck: mixer.decks[id],
    track: deckTracks[id],
    loading: loadingDeck === id,
    onFile: (file: File) => void loadTrack(id, file),
    onPlayPause: () => void togglePlayback(id),
    onCue: () => triggerCue(id),
    onSeek: (seconds: number) => engine.seek(id, seconds),
    onGain: (value: number) => engine.setDeckGain(id, value),
    onRate: (value: number) => {
      setSyncNotice(null)
      engine.setPlaybackRate(id, value)
    },
    onTempoSync: () => syncTempoTo(id),
    tempoSyncDisabled,
    tempoMultiplier: tempoMultipliers[id],
    onTempoMultiplier: (value: TempoMultiplier) => {
      setSyncNotice(null)
      setTempoMultipliers((current) => ({ ...current, [id]: value }))
    },
    selectedCueSlot: selectedCueSlots[id],
    onPerformancePad: (slot: number, seconds: number) => triggerPerformancePad(id, slot, seconds),
  })

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">VX</span>
          <div>
            <p className="eyebrow">AI CLUB DJ</p>
            <h1>VIBRAXIS</h1>
          </div>
        </div>
        <button className={`audio-status ${mixer.audioReady ? 'audio-status--ready' : ''}`} onClick={() => void enableAudio()}>
          <span />
          {mixer.audioReady ? 'AUDIO ACTIVE' : 'ENABLE AUDIO'}
        </button>
      </header>

      {error && <div className="error-banner" role="alert">{error}</div>}
      {syncNotice && <div className="sync-banner" role="status">{syncNotice}</div>}

      <div className="console">
        <Deck {...deckProps('A')} accent="cyan" />

        <section className="mixer" aria-label="Mixer">
          <div className="mixer__title">
            <p className="eyebrow">MIX CONTROL</p>
            <h2>MASTER</h2>
          </div>

          <label className="master-control">
            <span>MASTER VOLUME</span>
            <output>{Math.round(mixer.masterVolume * 100)}%</output>
            <input
              aria-label="Master volume"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={mixer.masterVolume}
              onChange={(event) => engine.setMasterVolume(Number(event.target.value))}
            />
          </label>

          <div className="meters" aria-hidden="true">
            {Array.from({ length: 12 }, (_, index) => <i key={index} />)}
          </div>

          <div className="crossfader-block">
            <div className="crossfader-block__labels">
              <strong>A</strong>
              <span>CROSS FADER</span>
              <strong>B</strong>
            </div>
            <input
              className="crossfader"
              aria-label="Crossfader"
              type="range"
              min="-1"
              max="1"
              step="0.01"
              value={mixer.crossfader}
              onChange={(event) => engine.setCrossfader(Number(event.target.value))}
            />
            <button className="center-button" onClick={() => engine.setCrossfader(0)}>CENTER</button>
          </div>

          <div className="signal-flow">
            <span>DECK A</span><i /><b>∿</b><i /><span>DECK B</span>
          </div>
        </section>

        <Deck {...deckProps('B')} accent="magenta" />
      </div>

      <TrackLibrary
        tracks={tracks}
        loading={catalogLoading}
        loadingDeck={loadingDeck}
        loadedTrackIds={{
          A: deckTracks.A?.trackId,
          B: deckTracks.B?.trackId,
        }}
        onLoad={(deck, track) => void loadCatalogTrack(deck, track)}
      />

      <footer className="footer">
        <span>ANALYZED LOCAL LIBRARY</span>
        <span>2 DECKS · EQUAL POWER MIX</span>
        <span>NO AUDIO UPLOAD</span>
      </footer>
    </main>
  )
}
