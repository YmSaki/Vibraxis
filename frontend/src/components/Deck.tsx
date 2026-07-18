import { useRef, useState, type ChangeEvent } from 'react'
import {
  DECK_EQ_CENTER_GAIN_DB,
  DECK_EQ_MAX_GAIN_DB,
  DECK_EQ_MIN_GAIN_DB,
  type DeckGrid,
} from '@vibraxis/shared/vdap'
import type { TrackTimeline } from '@vibraxis/shared/analysis'
import type { DeckId, DeckSnapshot } from '../audio/DeckEngine'
import { formatTime, interpretedBpm, type TempoMultiplier } from '../audio/audioMath'
import type { WaveformBands } from '../audio/waveform'
import type { CatalogTrack } from '../catalog'
import { Waveform } from './Waveform'

export type EqBand = 'low' | 'mid' | 'high'
export type DeckEq = Record<EqBand, number>

type Props = {
  id: DeckId
  deck: DeckSnapshot
  accent: 'cyan' | 'magenta'
  track?: CatalogTrack
  loading?: boolean
  onFile: (file: File) => void
  onPlayPause: () => void
  onCue: () => void
  onSeek: (seconds: number) => void
  onGain: (value: number) => void
  eq: DeckEq
  onEq: (band: EqBand, gainDb: number) => void
  onEqReset: () => void
  onRate: (value: number) => void
  onTempoSync: () => void
  tempoSyncDisabled: boolean
  tempoMultiplier: TempoMultiplier
  onTempoMultiplier: (value: TempoMultiplier) => void
  selectedCueSlot: number
  onPerformancePad: (slot: number, seconds: number) => void
  waveform: WaveformBands | null
  waveformStatus: 'idle' | 'building' | 'ready' | 'failed'
  waveformFailureReason: string | null
  grid: DeckGrid | null
  gridStatus: 'idle' | 'loading' | 'ready' | 'failed'
  gridFailureReason: string | null
  timeline: TrackTimeline | null
  estimatedGrid: boolean
  gridConfidence: number | null
}

export function Deck({
  id,
  deck,
  accent,
  track,
  loading = false,
  onFile,
  onPlayPause,
  onCue,
  onSeek,
  onGain,
  eq,
  onEq,
  onEqReset,
  onRate,
  onTempoSync,
  tempoSyncDisabled,
  tempoMultiplier,
  onTempoMultiplier,
  selectedCueSlot,
  onPerformancePad,
  waveform,
  waveformStatus,
  waveformFailureReason,
  grid,
  gridStatus,
  gridFailureReason,
  timeline,
  estimatedGrid,
  gridConfidence,
}: Props) {
  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) onFile(file)
    event.target.value = ''
  }
  const interpretedTempo = track ? interpretedBpm(track.bpm, tempoMultiplier) : null
  const musical = timeline ? timeline.at(deck.position) : null
  const [seekDraft, setSeekDraft] = useState<number | null>(null)
  const seekDirty = useRef(false)
  const commitSeek = (value: number) => {
    if (!seekDirty.current) return
    seekDirty.current = false
    setSeekDraft(null)
    onSeek(value)
  }
  const cancelSeek = () => {
    seekDirty.current = false
    setSeekDraft(null)
  }

  return (
    <section className={`deck deck--${accent}`} aria-label={`Deck ${id}`}>
      <div className="deck__header">
        <span className="deck__letter">{id}</span>
        <div>
          <p className="eyebrow">DECK {id}</p>
          <h2>{loading ? 'LOADING TRACK…' : track?.title ?? deck.name ?? 'NO TRACK LOADED'}</h2>
        </div>
        <span className={`status ${deck.playing ? 'status--live' : ''}`}>
          {deck.playing ? 'ON AIR' : loading ? 'LOADING' : deck.loaded ? 'READY' : 'EMPTY'}
        </span>
      </div>

      {track && (
        <div className="deck__metadata">
          <span>BASE {track.bpm.toFixed(1)} BPM</span>
          <span>LIVE {(interpretedTempo! * deck.playbackRate).toFixed(1)} BPM</span>
          {tempoMultiplier !== 1 && <span>BPM MODE {tempoMultiplier}×</span>}
          <span>{track.key} {track.scale}</span>
          <span>{track.camelot}</span>
          <span>ENERGY {Math.round(track.energy * 100)}</span>
        </div>
      )}

      <div className="platter-wrap">
        <div className={`platter ${deck.playing ? 'platter--playing' : ''}`}>
          <div className="platter__grooves" />
          <div className="platter__label">
            <span>VIBRAXIS</span>
            <strong>{id}</strong>
          </div>
        </div>
        <div className="time-readout">
          <strong>{formatTime(deck.position)}</strong>
          <span>/ {formatTime(deck.duration)}</span>
        </div>
      </div>

      <Waveform
        deckId={id}
        accent={accent}
        waveform={waveform}
        waveformStatus={waveformStatus}
        waveformFailureReason={waveformFailureReason}
        grid={grid}
        gridStatus={gridStatus}
        gridFailureReason={gridFailureReason}
        pads={track?.performancePads ?? []}
        duration={deck.duration}
        position={deck.position}
        loaded={deck.loaded}
        estimatedGrid={estimatedGrid}
        gridConfidence={gridConfidence}
        onSeek={onSeek}
      />

      {musical && (
        <div className="timeline-readout" aria-label={`Deck ${id} musical position`}>
          <span>BEAT <strong>{musical.beatIndex !== null ? musical.beatIndex + 1 : '—'}</strong></span>
          <span>IN BAR <strong>{musical.beatInBar ?? '—'}</strong></span>
          <span>BAR <strong>{musical.barIndex !== null ? musical.barIndex + 1 : '—'}</strong></span>
        </div>
      )}

      <input
        className="seek"
        aria-label={`Deck ${id} position`}
        type="range"
        min="0"
        max={Math.max(deck.duration, 0.01)}
        step="0.01"
        value={seekDraft ?? deck.position}
        disabled={!deck.loaded || loading}
        onChange={(event) => {
          seekDirty.current = true
          setSeekDraft(Number(event.target.value))
        }}
        onPointerUp={(event) => commitSeek(Number(event.currentTarget.value))}
        onPointerCancel={cancelSeek}
        onKeyUp={(event) => commitSeek(Number(event.currentTarget.value))}
        onBlur={(event) => commitSeek(Number(event.currentTarget.value))}
      />

      <div className="transport">
        <label className="load-button">
          LOAD TRACK
          <input type="file" accept="audio/*" onChange={handleFile} />
        </label>
        <button className="transport__primary" disabled={!deck.loaded || loading} onClick={onPlayPause}>
          {deck.playing ? 'PAUSE' : 'PLAY'}
        </button>
        <button disabled={!deck.loaded || loading} onClick={onCue}>CUE</button>
      </div>

      <div className="deck__controls">
        <label className="control">
          <span>GAIN</span>
          <output>{Math.round(deck.gain * 100)}%</output>
          <input
            type="range"
            min="0"
            max="1.5"
            step="0.01"
            value={deck.gain}
            onChange={(event) => onGain(Number(event.target.value))}
          />
        </label>
        <div className="control">
          <span>PLAY SPEED</span>
          <output>{deck.playbackRate.toFixed(2)}×</output>
          <input
            aria-label={`Deck ${id} play speed`}
            type="range"
            min="0.5"
            max="1.5"
            step="0.01"
            value={deck.playbackRate}
            onChange={(event) => onRate(Number(event.target.value))}
          />
          <div className="tempo-modes" aria-label={`Deck ${id} BPM interpretation`}>
            {([0.5, 1, 2] as TempoMultiplier[]).map((value) => (
              <button
                type="button"
                className={tempoMultiplier === value ? 'is-active' : ''}
                disabled={!track}
                onClick={() => onTempoMultiplier(value)}
                key={value}
              >
                {value === 0.5 ? 'BPM ÷2' : value === 1 ? 'RESET' : 'BPM ×2'}
              </button>
            ))}
          </div>
        </div>
        <div className="deck-eq" aria-label={`Deck ${id} equalizer`}>
          <div className="deck-eq__header">
            <div>
              <span>3 BAND EQ</span>
              <small>−26 / 0 / +6 dB</small>
            </div>
            <button
              type="button"
              onClick={onEqReset}
            >
              EQ RESET
            </button>
          </div>
          <div className="deck-eq__bands">
            {(['low', 'mid', 'high'] as EqBand[]).map((band) => (
              <label className="eq-band" key={band}>
                <span>{band === 'high' ? 'HI' : band.toUpperCase()}</span>
                <output>{eq[band] > 0 ? '+' : ''}{eq[band].toFixed(1)} dB</output>
                <input
                  aria-label={`Deck ${id} ${band === 'high' ? 'high' : band} EQ`}
                  type="range"
                  min={DECK_EQ_MIN_GAIN_DB}
                  max={DECK_EQ_MAX_GAIN_DB}
                  step="0.5"
                  value={eq[band]}
                  onChange={(event) => onEq(band, Number(event.target.value))}
                />
                <span className="eq-band__scale" aria-hidden="true">
                  <i>−26</i><b>{DECK_EQ_CENTER_GAIN_DB}</b><i>+6</i>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="performance-pads" aria-label={`Deck ${id} performance pads`}>
          {Array.from({ length: 8 }, (_, index) => {
            const slot = index + 1
            const pad = track?.performancePads.find((item) => item.slot === slot)
            return (
              <button
                type="button"
                className={selectedCueSlot === slot ? 'is-selected' : ''}
                disabled={!pad || loading}
                onClick={() => pad && onPerformancePad(slot, pad.sourceSeconds)}
                title={pad ? `${pad.label} · ${formatTime(pad.sourceSeconds)} · bar ${(pad.barIndex ?? -1) + 1}` : `Cue slot ${slot} is empty`}
                key={slot}
              >
                <span>{slot}</span>
                <strong>{pad?.label ?? 'EMPTY'}</strong>
                <small>{pad ? formatTime(pad.sourceSeconds) : '--:--'}</small>
              </button>
            )
          })}
        </div>
        <button
          className="tempo-sync"
          type="button"
          disabled={tempoSyncDisabled}
          onClick={onTempoSync}
          title={tempoSyncDisabled ? 'Load analyzed tracks on both decks to use tempo sync' : `Match the other deck to Deck ${id}`}
        >
          <span>TEMPO SYNC</span>
          <strong>SYNC OTHER DECK TO {id}</strong>
        </button>
      </div>
    </section>
  )
}
