import type { ChangeEvent } from 'react'
import type { DeckId, DeckSnapshot } from '../audio/DeckEngine'
import { formatTime, interpretedBpm, type TempoMultiplier } from '../audio/audioMath'
import type { CatalogTrack } from '../catalog'

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
  onRate: (value: number) => void
  onTempoSync: () => void
  tempoSyncDisabled: boolean
  tempoMultiplier: TempoMultiplier
  onTempoMultiplier: (value: TempoMultiplier) => void
  selectedCueSlot: number
  onPerformancePad: (slot: number, seconds: number) => void
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
  onRate,
  onTempoSync,
  tempoSyncDisabled,
  tempoMultiplier,
  onTempoMultiplier,
  selectedCueSlot,
  onPerformancePad,
}: Props) {
  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) onFile(file)
    event.target.value = ''
  }
  const interpretedTempo = track ? interpretedBpm(track.bpm, tempoMultiplier) : null

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

      <input
        className="seek"
        aria-label={`Deck ${id} position`}
        type="range"
        min="0"
        max={Math.max(deck.duration, 0.01)}
        step="0.01"
        value={deck.position}
        disabled={!deck.loaded || loading}
        onChange={(event) => onSeek(Number(event.target.value))}
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
