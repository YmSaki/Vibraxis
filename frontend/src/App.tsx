import { useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeState } from '@vibraxis/shared/vdap'
import { DeckEngine, type DeckId, type DeckSnapshot } from './audio/DeckEngine'
import {
  calculateTempoSync,
  interpretedBpm,
  type TempoMultiplier,
  type TempoSyncResult,
} from './audio/audioMath'
import { fetchCatalog, type CatalogTrack } from './catalog'
import { Deck, type EqBand } from './components/Deck'
import { TrackLibrary } from './components/TrackLibrary'
import { createRuntime, runtimeNow } from './runtime/createRuntime'
import { DeckObjectUrls } from './runtime/DeckObjectUrls'
import { settleMutation } from './runtime/settleMutation'
import { VdapClient, VdapClientError } from './runtime/VdapClient'
import { useDeckVisuals } from './visuals/useDeckVisuals'
import './styles.css'

const emptyDeckView = (id: DeckId): DeckSnapshot => ({
  id,
  name: null,
  duration: 0,
  position: 0,
  gain: 1,
  playbackRate: 1,
  playing: false,
  loaded: false,
})

export async function applyTempoSync(
  masterBpm: number,
  masterPlaybackRate: number,
  followerBpm: number,
  mutateVelocity: (velocity: number) => Promise<void>,
): Promise<TempoSyncResult> {
  const result = calculateTempoSync(masterBpm, masterPlaybackRate, followerBpm)
  await mutateVelocity(result.playbackRate)
  return result
}

export default function App() {
  const engine = useMemo(() => new DeckEngine(), [])
  const objectUrls = useMemo(() => new DeckObjectUrls(), [])
  const tracksRef = useRef<CatalogTrack[]>([])
  const runtime = useMemo(
    () =>
      createRuntime({
        engine,
        resolveTrack: (trackId) => tracksRef.current.find((track) => track.trackId === trackId),
      }),
    [engine],
  )

  const [client, setClient] = useState<VdapClient | null>(null)
  const [runtimeState, setRuntimeState] = useState<RuntimeState | null>(null)
  const [audioReady, setAudioReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tracks, setTracks] = useState<CatalogTrack[]>([])
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [syncNotice, setSyncNotice] = useState<string | null>(null)
  const [tempoMultipliers, setTempoMultipliers] = useState<Record<DeckId, TempoMultiplier>>({ A: 1, B: 1 })
  const [selectedCueSlots, setSelectedCueSlots] = useState<Record<DeckId, number>>({ A: 1, B: 1 })
  useEffect(() => engine.subscribe((snapshot) => setAudioReady(snapshot.audioReady)), [engine])

  useEffect(() => () => objectUrls.dispose(), [objectUrls])

  useEffect(() => {
    const vdap = runtime.createUiClient()
    let disposed = false
    void (async () => {
      await vdap.hello()
      const initial = await vdap.query('state.get', {})
      if (disposed) return
      setRuntimeState(initial)
      await vdap.subscribeState((message) => {
        if (message.kind !== 'snapshot') return
        const { vdap: _vdap, kind: _kind, ...state } = message
        setRuntimeState(state as RuntimeState)
      })
      if (!disposed) setClient(vdap)
    })().catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'Runtimeを初期化できませんでした。')
    })
    return () => {
      disposed = true
      setClient(null)
      vdap.close()
      runtime.dispose()
      engine.dispose()
    }
  }, [engine, runtime])

  useEffect(() => {
    const controller = new AbortController()
    fetchCatalog(controller.signal)
      .then((loaded) => {
        tracksRef.current = loaded
        setTracks(loaded)
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError') return
        setError(cause instanceof Error ? cause.message : '楽曲カタログを読み込めませんでした。')
      })
      .finally(() => setCatalogLoading(false))
    return () => controller.abort()
  }, [])

  const deckVisuals: Record<DeckId, ReturnType<typeof useDeckVisuals>> = {
    A: useDeckVisuals('A', runtimeState?.decks.A.binding ?? null, client, engine),
    B: useDeckVisuals('B', runtimeState?.decks.B.binding ?? null, client, engine),
  }

  const anyPlaying =
    runtimeState !== null &&
    (runtimeState.decks.A.transport.phase === 'playing' ||
      runtimeState.decks.B.transport.phase === 'playing')

  const [, setTick] = useState(0)
  useEffect(() => {
    if (!anyPlaying) return
    const ticker = window.setInterval(() => setTick((value) => value + 1), 100)
    return () => window.clearInterval(ticker)
  }, [anyPlaying])

  const run = (operation: (vdap: VdapClient) => Promise<void>) => {
    if (!client) {
      setError('Runtimeを初期化中です。少し待ってから操作してください。')
      return
    }
    setError(null)
    void operation(client).catch((cause) => {
      if (cause instanceof VdapClientError) setError(cause.ack?.error.message ?? cause.message)
      else setError(cause instanceof Error ? cause.message : '操作に失敗しました。')
    })
  }

  const resetDeckUiState = (id: DeckId) => {
    setSyncNotice(null)
    setTempoMultipliers((current) => ({ ...current, [id]: 1 }))
    setSelectedCueSlots((current) => ({ ...current, [id]: 1 }))
  }

  const loadCatalogTrack = (id: DeckId, track: CatalogTrack) =>
    run(async (vdap) => {
      await engine.resume()
      await settleMutation(vdap.mutate('deck.load', { deckId: id, source: { kind: 'catalog', trackId: track.trackId } }))
      objectUrls.clear(id)
      resetDeckUiState(id)
    })

  const loadFileTrack = (id: DeckId, file: File) =>
    run(async (vdap) => {
      await engine.resume()
      await objectUrls.load(id, file, (url) =>
        settleMutation(vdap.mutate('deck.load', { deckId: id, source: { kind: 'url', url, title: file.name } })),
      )
      resetDeckUiState(id)
    })

  const togglePlayback = (id: DeckId) =>
    run(async (vdap) => {
      const playing = runtimeState?.decks[id].transport.phase === 'playing'
      if (!playing) await engine.resume()
      await settleMutation(vdap.mutate(playing ? 'deck.pause' : 'deck.play', { deckId: id }))
    })

  const seekDeck = (id: DeckId, seconds: number, resume: 'keep' | 'pause' = 'keep') =>
    run(async (vdap) => {
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new RangeError('Seek position must be a non-negative finite number.')
      }
      await settleMutation(
        vdap.mutate('deck.seek', {
          deckId: id,
          target: { type: 'sourceSeconds', sourceSeconds: seconds },
          resume,
        }),
      )
    })

  const syncTempoTo = (masterId: DeckId) => {
    const followerId: DeckId = masterId === 'A' ? 'B' : 'A'
    const masterTrack = deckTrack(masterId)
    const followerTrack = deckTrack(followerId)
    const master = runtimeState?.decks[masterId]
    if (!masterTrack || !followerTrack || !master) return

    run(async (vdap) => {
      const result = await applyTempoSync(
        interpretedBpm(masterTrack.bpm, tempoMultipliers[masterId]),
        master.playback.configuredVelocity,
        interpretedBpm(followerTrack.bpm, tempoMultipliers[followerId]),
        async (velocity) => {
          await settleMutation(vdap.mutate('deck.setVelocity', { deckId: followerId, velocity }))
        },
      )
      setSyncNotice(
        `Deck ${followerId} synced to Deck ${masterId} at ${result.targetBpm.toFixed(1)} BPM.`,
      )
    })
  }

  const triggerCue = (id: DeckId) => {
    const cue = deckTrack(id)?.performancePads.find((pad) => pad.slot === selectedCueSlots[id])
    if (!cue) {
      setError(`Deck ${id} pad ${selectedCueSlots[id]} has no assigned cue point.`)
      return
    }
    seekDeck(id, cue.sourceSeconds, 'pause')
  }

  const triggerPerformancePad = (id: DeckId, slot: number, seconds: number) => {
    setSelectedCueSlots((current) => ({ ...current, [id]: slot }))
    seekDeck(id, seconds)
  }

  const panic = () => run(async (vdap) => settleMutation(vdap.mutate('runtime.panic', {})))

  const enableAudio = () => {
    setError(null)
    engine.resume().catch((cause) => {
      setError(cause instanceof Error ? cause.message : 'Audioを有効にできませんでした。')
    })
  }

  const deckTrack = (id: DeckId): CatalogTrack | undefined => {
    const trackId = runtimeState?.decks[id].binding?.trackId
    return trackId ? tracks.find((track) => track.trackId === trackId) : undefined
  }

  const deckView = (id: DeckId): DeckSnapshot => {
    const deck = runtimeState?.decks[id]
    if (!deck) return emptyDeckView(id)
    const duration = deck.binding?.durationSeconds ?? 0
    const playing = deck.transport.phase === 'playing'
    const elapsed = playing
      ? Math.max(0, runtimeNow() - deck.playback.position.atRuntimeTime) * deck.playback.headVelocity
      : 0
    return {
      id,
      name: deck.binding?.source.title ?? null,
      duration,
      position: Math.min(deck.playback.position.sourceSeconds + elapsed, duration),
      gain: deck.gain,
      playbackRate: deck.playback.configuredVelocity,
      playing,
      loaded: deck.binding !== null,
    }
  }

  const loadingDeck: DeckId | null =
    runtimeState?.decks.A.load.phase === 'loading'
      ? 'A'
      : runtimeState?.decks.B.load.phase === 'loading'
        ? 'B'
        : null

  const tempoSyncDisabled = !deckTrack('A') || !deckTrack('B') || loadingDeck !== null

  const deckProps = (id: DeckId) => ({
    id,
    deck: deckView(id),
    track: deckTrack(id),
    loading: loadingDeck === id,
    onFile: (file: File) => loadFileTrack(id, file),
    onPlayPause: () => togglePlayback(id),
    onCue: () => triggerCue(id),
    onSeek: (seconds: number) => seekDeck(id, seconds),
    onGain: (value: number) => run(async (vdap) => settleMutation(vdap.mutate('deck.setGain', { deckId: id, gain: value }))),
    eq: {
      low: runtimeState?.decks[id].eq.lowDb ?? 0,
      mid: runtimeState?.decks[id].eq.midDb ?? 0,
      high: runtimeState?.decks[id].eq.highDb ?? 0,
    },
    onEq: (band: EqBand, gainDb: number) =>
      run(async (vdap) => settleMutation(vdap.mutate('deck.setEq', { deckId: id, band, gainDb }))),
    onEqReset: () => run(async (vdap) => {
      for (const band of ['low', 'mid', 'high'] as const) {
        await settleMutation(vdap.mutate('deck.setEq', { deckId: id, band, gainDb: 0 }))
      }
    }),
    onRate: (value: number) => {
      setSyncNotice(null)
      run(async (vdap) => settleMutation(vdap.mutate('deck.setVelocity', { deckId: id, velocity: value })))
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
    waveform: deckVisuals[id].waveform,
    waveformStatus: deckVisuals[id].waveformStatus,
    waveformFailureReason: deckVisuals[id].waveformFailureReason,
    grid: deckVisuals[id].grid,
    gridStatus: deckVisuals[id].gridStatus,
    gridFailureReason: deckVisuals[id].gridFailureReason,
    timeline: deckVisuals[id].timeline,
    estimatedGrid: runtimeState?.decks[id].binding?.analysis?.grid.status === 'partial',
    gridConfidence:
      deckVisuals[id].grid?.confidence ??
      runtimeState?.decks[id].binding?.analysis?.grid.confidence ??
      null,
  })

  const crossfader = runtimeState?.mixer.crossfader.effective ?? 0
  const masterGain = runtimeState?.mixer.masterGain ?? 1

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
        <div className="topbar__actions">
          <button className={`audio-status ${audioReady ? 'audio-status--ready' : ''}`} onClick={enableAudio}>
            <span />
            {audioReady ? 'AUDIO ACTIVE' : 'ENABLE AUDIO'}
          </button>
          <button className="panic-button" onClick={panic} title="Stop all decks immediately">
            PANIC
          </button>
        </div>
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
            <output>{Math.round(masterGain * 100)}%</output>
            <input
              aria-label="Master volume"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={masterGain}
              onChange={(event) => {
                const gain = Number(event.target.value)
                run(async (vdap) => settleMutation(vdap.mutate('mixer.setMasterGain', { gain })))
              }}
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
              value={crossfader}
              onChange={(event) => {
                const position = Number(event.target.value)
                run(async (vdap) => settleMutation(vdap.mutate('mixer.setCrossfader', { position })))
              }}
            />
            <button
              className="center-button"
              onClick={() => run(async (vdap) => settleMutation(vdap.mutate('mixer.setCrossfader', { position: 0 })))}
            >
              CENTER
            </button>
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
          A: deckTrack('A')?.trackId,
          B: deckTrack('B')?.trackId,
        }}
        onLoad={(deck, track) => loadCatalogTrack(deck, track)}
      />

      <footer className="footer">
        <span>ANALYZED LOCAL LIBRARY</span>
        <span>VDAP RUNTIME · MESSAGEPORT</span>
        <span>2 DECKS · DJ CURVE MIX</span>
      </footer>
    </main>
  )
}
