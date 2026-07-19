from __future__ import annotations

import hashlib
import json
import math
from datetime import UTC, datetime
from pathlib import Path

import librosa
import numpy as np

from analyze_tool import __version__
from analyze_tool.advanced import (
    infer_downbeats,
    infer_harmony,
    infer_key_regions,
    infer_structure,
    rigid_beat_times,
)
from analyze_tool.models import (
    AnalysisRecord,
    AnalyzerInfo,
    AudioFeatures,
    CapabilityInfo,
    HarmonyInfo,
    KeyRegion,
    SourceInfo,
    StructureInfo,
    TempoInfo,
    TonalInfo,
)
from analyze_tool.music import camelot_for, estimate_key, fold_bpm, slugify_track_id


class LibrosaAnalyzer:
    name = "librosa"
    version = f"vibraxis-{__version__}/librosa-{librosa.__version__}"

    def __init__(
        self,
        *,
        min_bpm: float = 70.0,
        max_bpm: float = 180.0,
        key_window_seconds: float = 120.0,
        profile: str = "full",
    ) -> None:
        if profile not in {"baseline", "full"}:
            raise ValueError("profile must be 'baseline' or 'full'")
        self.min_bpm = min_bpm
        self.max_bpm = max_bpm
        self.key_window_seconds = key_window_seconds
        self.profile = profile
        config = json.dumps(
            {
                "minBpm": min_bpm,
                "maxBpm": max_bpm,
                "keyMethod": "middle-window-chroma-stft",
                "keyWindowSeconds": key_window_seconds,
                "profile": profile,
                "schemaVersion": 2,
            },
            sort_keys=True,
        )
        self.config_hash = hashlib.sha256(config.encode()).hexdigest()

    def analyze(
        self,
        path: Path,
        *,
        source_name: str | None = None,
        bpm_override: float | None = None,
        downbeat_offset_beats: int | None = None,
        rigid_grid: bool | None = None,
    ) -> AnalysisRecord:
        if downbeat_offset_beats is not None and (
            isinstance(downbeat_offset_beats, bool) or not isinstance(downbeat_offset_beats, int)
        ):
            raise ValueError("downbeat offset must be an integer number of beats")
        if rigid_grid is not None and not isinstance(rigid_grid, bool):
            raise ValueError("rigidGrid must be a boolean")
        if rigid_grid and bpm_override is None:
            raise ValueError("rigidGrid requires a bpm override (the constant nominal tempo)")
        path = path.resolve()
        if not path.is_file():
            raise FileNotFoundError(path)

        samples, sample_rate = librosa.load(path, sr=None, mono=True)
        duration = float(librosa.get_duration(y=samples, sr=sample_rate))
        if duration <= 0 or samples.size == 0:
            raise ValueError(f"audio is empty: {path}")

        onset_envelope = librosa.onset.onset_strength(y=samples, sr=sample_rate)
        tempo_result, beat_frames = librosa.beat.beat_track(
            onset_envelope=onset_envelope,
            sr=sample_rate,
            trim=False,
        )
        raw_bpm = float(np.asarray(tempo_result).reshape(-1)[0])
        if raw_bpm <= 0:
            raise ValueError(f"could not detect a tempo: {path}")
        if bpm_override is not None:
            if not math.isfinite(bpm_override) or bpm_override <= 0:
                raise ValueError("BPM override must be positive")
            bpm = float(bpm_override)
            adjustment = "none"
            _, beat_frames = librosa.beat.beat_track(
                onset_envelope=onset_envelope,
                sr=sample_rate,
                trim=False,
                bpm=bpm,
            )
        else:
            bpm, adjustment = fold_bpm(raw_bpm, self.min_bpm, self.max_bpm)
        if rigid_grid:
            # Grid solver: replace the dynamically tracked beats with an
            # isochronous grid at the pinned tempo, anchored by onset energy.
            # Downbeats, bars, harmony, structure, and pads all derive from
            # these beats, so the whole record follows the rigid grid.
            beats = rigid_beat_times(onset_envelope, sample_rate, bpm, duration)
            beat_frames = librosa.time_to_frames(np.asarray(beats), sr=sample_rate)
        else:
            beats = librosa.frames_to_time(beat_frames, sr=sample_rate).tolist()

        key_samples = _middle_window(samples, sample_rate, self.key_window_seconds)
        chroma = librosa.feature.chroma_stft(
            y=key_samples,
            sr=sample_rate,
            n_fft=4096,
            hop_length=4096,
        )
        key, scale, key_confidence = estimate_key(chroma)

        rms_frames = librosa.feature.rms(y=samples)[0]
        rms = float(np.mean(rms_frames))
        rms_db = librosa.amplitude_to_db(np.maximum(rms_frames, 1e-10), ref=1.0)
        loudness_db = float(np.mean(rms_db))
        dynamic_range_db = float(max(0.0, np.percentile(rms_db, 90) - np.percentile(rms_db, 10)))
        onset_times = librosa.onset.onset_detect(
            onset_envelope=onset_envelope,
            sr=sample_rate,
            units="time",
        )
        onset_rate = float(len(onset_times) / duration)
        centroid = float(np.mean(librosa.feature.spectral_centroid(y=samples, sr=sample_rate)))
        energy = _energy_score(loudness_db, onset_rate, centroid)

        beat_values = [round(float(value), 4) for value in beats]
        if self.profile == "full":
            rms_times = librosa.frames_to_time(np.arange(len(rms_frames)), sr=sample_rate)
            try:
                downbeats, phase = infer_downbeats(
                    beat_frames, onset_envelope, sample_rate,
                    phase_offset=downbeat_offset_beats or 0,
                )
                if rigid_grid:
                    # Frames are only used to pick the strongest phase; take the
                    # downbeat TIMES from the exact rigid beats so they stay a
                    # strict subset of beatsSeconds (no ~hop-size quantization).
                    downbeats = [round(float(value), 4) for value in beats[phase::4]]
                bars = downbeats.copy()
                beat_capability = CapabilityInfo(
                    "partial", "librosa-heuristic", self.version, 0.55,
                    "heuristic downbeats have not passed the human accuracy gate",
                )
            except Exception as error:
                downbeats, bars = [], []
                beat_capability = CapabilityInfo("failed", "librosa-heuristic", self.version, error=str(error))
            try:
                full_chroma = librosa.feature.chroma_stft(
                    y=samples, sr=sample_rate, n_fft=4096, hop_length=4096
                )
                chroma_times = librosa.frames_to_time(
                    np.arange(full_chroma.shape[1]), sr=sample_rate, hop_length=4096
                )
                key_regions = infer_key_regions(
                    full_chroma, chroma_times, bars, duration, key, scale
                )
                harmony = infer_harmony(
                    full_chroma, chroma_times, bars, beat_values, duration, key, scale, key_regions
                )
                if not harmony.chords:
                    raise ValueError("no chord events were produced")
                harmony_capability = CapabilityInfo(
                    "partial", "vibraxis-chroma", self.version, 0.45,
                    "chord accuracy has not passed the human ground-truth gate",
                )
            except Exception as error:
                key_regions = [KeyRegion(0.0, round(duration, 4), key, scale, key_confidence)]
                harmony = HarmonyInfo()
                harmony_capability = CapabilityInfo("failed", "vibraxis-chroma", self.version, error=str(error))
            try:
                structure = infer_structure(
                    bars, beat_values, duration, rms_frames, rms_times,
                    full_chroma if "full_chroma" in locals() else None,
                    chroma_times if "chroma_times" in locals() else None,
                    onset_envelope,
                    librosa.frames_to_time(np.arange(len(onset_envelope)), sr=sample_rate),
                )
                if not structure.sections:
                    raise ValueError("no structure sections were produced")
                structure_capability = CapabilityInfo(
                    "partial", "vibraxis-heuristic", self.version, 0.45,
                    "section accuracy has not passed the human ground-truth gate",
                )
            except Exception as error:
                structure = StructureInfo()
                structure_capability = CapabilityInfo("failed", "vibraxis-heuristic", self.version, error=str(error))
            capabilities = {
                "features": CapabilityInfo("complete", self.name, self.version, 0.8),
                "beatGrid": beat_capability,
                "harmony": harmony_capability,
                "structure": structure_capability,
            }
        else:
            downbeats = []
            bars = []
            harmony = HarmonyInfo()
            structure = StructureInfo()
            key_regions = [KeyRegion(0.0, round(duration, 4), key, scale, key_confidence)]
            capabilities = {
                "features": CapabilityInfo("complete", self.name, self.version, 0.8),
                "beatGrid": CapabilityInfo("partial", self.name, self.version, 0.6),
                "harmony": CapabilityInfo("skipped", "none", self.version),
                "structure": CapabilityInfo("skipped", "none", self.version),
            }

        return AnalysisRecord(
            track_id=slugify_track_id(path),
            source=SourceInfo(
                file=source_name or path.name,
                sha256=_sha256(path),
                duration_seconds=round(duration, 4),
                sample_rate=int(sample_rate),
            ),
            analyzer=AnalyzerInfo(
                provider=self.name,
                version=self.version,
                analyzed_at=datetime.now(UTC).isoformat(),
                config_hash=self.config_hash,
            ),
            capabilities=capabilities,
            tempo=TempoInfo(
                bpm=bpm,
                raw_bpm=round(raw_bpm, 3),
                adjustment=adjustment,
                time_signature="4/4",
                beats_seconds=beat_values,
                downbeats_seconds=downbeats,
                bars_seconds=bars,
            ),
            tonal=TonalInfo(
                key=key,
                scale=scale,
                camelot=camelot_for(key, scale),
                confidence=key_confidence,
                key_regions=key_regions,
            ),
            harmony=harmony,
            structure=structure,
            features=AudioFeatures(
                energy=energy,
                rms=round(rms, 6),
                loudness_db=round(loudness_db, 3),
                dynamic_range_db=round(dynamic_range_db, 3),
                onset_rate=round(onset_rate, 4),
                spectral_centroid_hz=round(centroid, 2),
            ),
        )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _energy_score(loudness_db: float, onset_rate: float, centroid_hz: float) -> float:
    loudness = np.clip((loudness_db + 35.0) / 25.0, 0.0, 1.0)
    activity = np.clip(onset_rate / 4.0, 0.0, 1.0)
    brightness = np.clip((centroid_hz - 500.0) / 4500.0, 0.0, 1.0)
    score = 0.45 * loudness + 0.35 * activity + 0.20 * brightness
    if not math.isfinite(float(score)):
        return 0.0
    return round(float(np.clip(score, 0.0, 1.0)), 4)


def _middle_window(samples: np.ndarray, sample_rate: int, seconds: float) -> np.ndarray:
    target = int(seconds * sample_rate)
    if target <= 0 or samples.size <= target:
        return samples
    start = (samples.size - target) // 2
    return samples[start : start + target]
