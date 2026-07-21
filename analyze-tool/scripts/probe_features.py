"""Shared feature extraction for the structure/downbeat investigation.

Frame-level envelopes (RMS, low-band kick/bass, onset density, centroid) and
beat-synchronous features. No project deps beyond librosa/numpy; matplotlib is
pulled in ephemerally by the plotting scripts via `uv run --with matplotlib`.
"""
from __future__ import annotations
import json, os
from dataclasses import dataclass
from pathlib import Path
import numpy as np, librosa

ROOT = Path(__file__).resolve().parents[2]

@dataclass
class Track:
    track_id: str
    file: str
    bpm: float
    dur: float
    sr: int
    y: np.ndarray
    beats: np.ndarray            # committed grid (human-verified)
    downbeats: np.ndarray        # committed, override-applied
    gt_phase: int                # ground-truth metrical phase of the "1"

def load_track(analysis_json: Path) -> Track:
    d = json.load(open(analysis_json, encoding='utf8'))
    audio = ROOT/'data'/'sample'/d['source']['file']
    if not audio.exists():
        audio = ROOT/'data'/'sample-excluded'/d['source']['file']
    y, sr = librosa.load(str(audio), sr=None, mono=True)
    beats = np.asarray(d['tempo']['beatsSeconds'], float)
    dbs = np.asarray(d['tempo']['downbeatsSeconds'], float)
    gt = int(np.argmin(np.abs(beats - dbs[0]))) % 4 if len(dbs) else 0
    return Track(d['trackId'], d['source']['file'], float(d['tempo']['bpm']),
                 len(y)/sr, sr, y, beats, dbs, gt)

def envelopes(t: Track, hop=512):
    """Frame-level envelopes on a common time axis."""
    y, sr = t.y, t.sr
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    ftimes = librosa.frames_to_time(np.arange(S.shape[1]), sr=sr, hop_length=hop)
    rms = librosa.feature.rms(S=S, hop_length=hop)[0]
    low = S[freqs < 150].sum(axis=0)          # kick/bass presence
    lowmid = S[(freqs>=150)&(freqs<500)].sum(axis=0)
    high = S[freqs >= 4000].sum(axis=0)
    onset = librosa.onset.onset_strength(S=librosa.amplitude_to_db(S, ref=np.max), sr=sr, hop_length=hop)
    centroid = librosa.feature.spectral_centroid(S=S, sr=sr)[0]
    flux = np.sqrt((np.diff(S, axis=1, prepend=S[:, :1])**2).sum(axis=0))
    return dict(t=ftimes, rms=rms, low=low, lowmid=lowmid, high=high,
                onset=onset, centroid=centroid, flux=flux, freqs=freqs, S=S)

def onset_density(t: Track, hop=512, win_s=1.0):
    """Onsets per second over a sliding window -> percussive activity."""
    ons = librosa.onset.onset_detect(y=t.y, sr=t.sr, hop_length=hop, units='time', backtrack=False)
    grid = np.arange(0, t.dur, 0.25)
    dens = np.array([np.sum(np.abs(ons - g) <= win_s/2)/win_s for g in grid])
    return grid, dens

if __name__ == '__main__':
    import sys
    aj = sorted((ROOT/'data'/'analysis').glob('*.json'))
    t = load_track(aj[0])
    e = envelopes(t)
    print(t.track_id, 'dur', round(t.dur,1), 'gt_phase', t.gt_phase,
          'rms frames', len(e['rms']))
