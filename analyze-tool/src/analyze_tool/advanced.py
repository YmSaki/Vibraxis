from __future__ import annotations

from dataclasses import replace

import librosa
import numpy as np

from analyze_tool.models import ChordEvent, HarmonyInfo, KeyRegion, Phrase, Section, StructureInfo
from analyze_tool.music import NOTE_NAMES, Scale, degree_for, estimate_key


def infer_downbeats(
    beat_frames: np.ndarray,
    onset_envelope: np.ndarray,
    sample_rate: int,
    *,
    beats_per_bar: int = 4,
) -> tuple[list[float], int]:
    """Choose the strongest metrical phase and return heuristic downbeats."""

    if len(beat_frames) == 0:
        return [], 0
    strengths = np.asarray([
        onset_envelope[min(int(frame), len(onset_envelope) - 1)] for frame in beat_frames
    ])
    phase_scores = [float(np.mean(strengths[phase::beats_per_bar])) for phase in range(beats_per_bar)]
    phase = int(np.argmax(phase_scores))
    frames = beat_frames[phase::beats_per_bar]
    return [round(float(value), 4) for value in librosa.frames_to_time(frames, sr=sample_rate)], phase


def infer_harmony(
    chroma: np.ndarray,
    frame_times: np.ndarray,
    bars: list[float],
    beats: list[float],
    duration: float,
    key: str,
    scale: Scale,
    key_regions: list[KeyRegion] | None = None,
) -> HarmonyInfo:
    if not bars or chroma.shape[1] == 0:
        return HarmonyInfo()
    boundaries = sorted(set([0.0, *bars, duration]))
    raw: list[ChordEvent] = []
    for bar_index, (start, end) in enumerate(zip(boundaries, boundaries[1:])):
        if end - start < 0.05:
            continue
        mask = (frame_times >= start) & (frame_times < end)
        vector = np.mean(chroma[:, mask], axis=1) if np.any(mask) else np.zeros(12)
        root, quality, extension, confidence = _classify_chord(vector)
        local = _region_at(key_regions or [], start)
        local_key, local_scale = (local.key, local.scale) if local else (key, scale)
        symbol = _chord_symbol(root, quality, extension)
        beat_index = max(0, int(np.searchsorted(beats, start, side="left")))
        raw.append(ChordEvent(
            raw_start_seconds=round(start, 4),
            raw_end_seconds=round(end, 4),
            start_seconds=round(start, 4),
            end_seconds=round(end, 4),
            beat_index=beat_index,
            bar_index=bar_index,
            symbol=symbol,
            root=root,
            quality=quality,
            bass=root,
            local_key=f"{local_key} {local_scale}",
            degree=degree_for(root, quality, local_key, local_scale, extension),
            confidence=confidence,
        ))
    return HarmonyInfo(_merge_chords(raw))


def infer_key_regions(
    chroma: np.ndarray,
    frame_times: np.ndarray,
    bars: list[float],
    duration: float,
    fallback_key: str,
    fallback_scale: Scale,
    *,
    window_bars: int = 32,
) -> list[KeyRegion]:
    if not bars:
        return [KeyRegion(0.0, duration, fallback_key, fallback_scale, 0.0)]
    boundaries = [0.0, *[bars[index] for index in range(window_bars, len(bars), window_bars)], duration]
    regions: list[KeyRegion] = []
    for start, end in zip(boundaries, boundaries[1:]):
        mask = (frame_times >= start) & (frame_times < end)
        if np.any(mask):
            key, scale, confidence = estimate_key(chroma[:, mask])
        else:
            key, scale, confidence = fallback_key, fallback_scale, 0.0
        if confidence < 0.08:
            key, scale = fallback_key, fallback_scale
        region = KeyRegion(round(start, 4), round(end, 4), key, scale, confidence)
        if regions and (regions[-1].key, regions[-1].scale) == (key, scale):
            previous = regions[-1]
            regions[-1] = KeyRegion(
                previous.start_seconds, region.end_seconds, key, scale,
                round((previous.confidence + confidence) / 2, 4),
            )
        else:
            regions.append(region)
    return regions


def infer_structure(
    bars: list[float],
    beats: list[float],
    duration: float,
    rms: np.ndarray,
    rms_times: np.ndarray,
    chroma: np.ndarray | None = None,
    chroma_times: np.ndarray | None = None,
    onset: np.ndarray | None = None,
    onset_times: np.ndarray | None = None,
) -> StructureInfo:
    if duration <= 0:
        return StructureInfo()
    bar_starts = sorted(set([0.0, *bars]))
    if bar_starts[-1] >= duration:
        bar_starts = [value for value in bar_starts if value < duration]
    boundaries = _section_boundaries(
        bar_starts, duration, rms, rms_times, chroma, chroma_times, onset, onset_times
    )
    energies = [_range_energy(rms, rms_times, start, end) for start, end in zip(boundaries, boundaries[1:])]
    maximum = max(energies, default=1.0) or 1.0
    normalized = [float(np.clip(value / maximum, 0.0, 1.0)) for value in energies]

    sections: list[Section] = []
    for index, ((start, end), energy) in enumerate(zip(zip(boundaries, boundaries[1:]), normalized)):
        start_bar = max(0, int(np.searchsorted(bar_starts, start, side="right") - 1))
        end_bar = max(start_bar + 1, int(np.searchsorted(bar_starts, end, side="left")))
        start_beat = max(0, int(np.searchsorted(beats, start, side="left")))
        end_beat = max(start_beat + 1, int(np.searchsorted(beats, end, side="left")))
        label, confidence = _section_label(index, len(energies), energy, normalized)
        sections.append(Section(
            start_seconds=round(start, 4), end_seconds=round(end, 4),
            start_beat=start_beat, end_beat=end_beat,
            start_bar=start_bar, end_bar=end_bar,
            label=label, raw_label=f"heuristic:{label}", confidence=confidence,
            energy=round(energy, 4),
        ))

    phrases: list[Phrase] = []
    for section_index, section in enumerate(sections):
        cursor = section.start_bar
        while cursor < section.end_bar:
            next_bar = min(cursor + 8, section.end_bar)
            start = bar_starts[min(cursor, len(bar_starts) - 1)]
            end = section.end_seconds if next_bar >= len(bar_starts) else min(section.end_seconds, bar_starts[next_bar])
            if end > start:
                phrases.append(Phrase(round(start, 4), round(end, 4), cursor, next_bar, section_index))
            cursor = next_bar
    return StructureInfo(sections, phrases)


def _classify_chord(vector: np.ndarray) -> tuple[str | None, str, str, float]:
    total = float(np.sum(vector))
    concentration = float(np.max(vector) / total) if total > 1e-8 else 0.0
    if total <= 1e-8 or concentration < 0.105:
        return None, "none", "", 0.0
    unit = vector / (np.linalg.norm(vector) or 1.0)
    candidates: list[tuple[float, int, str, str]] = []
    shapes = (
        ("major", "", (0, 4, 7)), ("minor", "", (0, 3, 7)),
        ("diminished", "", (0, 3, 6)), ("sus2", "", (0, 2, 7)),
        ("sus4", "", (0, 5, 7)), ("major", "7", (0, 4, 7, 10)),
        ("major", "maj7", (0, 4, 7, 11)), ("minor", "7", (0, 3, 7, 10)),
    )
    for root in range(12):
        for quality, extension, intervals in shapes:
            template = np.full(12, 0.05)
            template[list((root + np.asarray(intervals)) % 12)] = 1.0
            template /= np.linalg.norm(template)
            candidates.append((float(np.dot(unit, template)), root, quality, extension))
    candidates.sort(reverse=True)
    best, second = candidates[0], candidates[1]
    confidence = float(np.clip((best[0] - second[0]) * 4.0, 0.05, 0.95))
    return NOTE_NAMES[best[1]], best[2], best[3], round(confidence, 4)


def _chord_symbol(root: str | None, quality: str, extension: str) -> str:
    if root is None:
        return "N"
    suffix = {
        "major": "", "minor": "m", "diminished": "dim",
        "sus2": "sus2", "sus4": "sus4",
    }.get(quality, quality)
    if extension == "maj7":
        return root + suffix + "maj7"
    return root + suffix + extension


def _region_at(regions: list[KeyRegion], timestamp: float) -> KeyRegion | None:
    return next(
        (region for region in regions if region.start_seconds <= timestamp < region.end_seconds),
        regions[-1] if regions else None,
    )


def _merge_chords(chords: list[ChordEvent]) -> list[ChordEvent]:
    merged: list[ChordEvent] = []
    for chord in chords:
        if merged and merged[-1].symbol == chord.symbol and merged[-1].local_key == chord.local_key:
            previous = merged[-1]
            duration_a = previous.end_seconds - previous.start_seconds
            duration_b = chord.end_seconds - chord.start_seconds
            confidence = (previous.confidence * duration_a + chord.confidence * duration_b) / (duration_a + duration_b)
            merged[-1] = replace(
                previous,
                raw_end_seconds=chord.raw_end_seconds,
                end_seconds=chord.end_seconds,
                confidence=round(confidence, 4),
            )
        else:
            merged.append(chord)
    return merged


def _section_boundaries(
    bars: list[float], duration: float, rms: np.ndarray, rms_times: np.ndarray,
    chroma: np.ndarray | None, chroma_times: np.ndarray | None,
    onset: np.ndarray | None, onset_times: np.ndarray | None,
) -> list[float]:
    if len(bars) < 9:
        return [0.0, duration]
    bar_energy = np.asarray([
        _range_energy(rms, rms_times, start, bars[index + 1] if index + 1 < len(bars) else duration)
        for index, start in enumerate(bars)
    ])
    feature_rows: list[np.ndarray] = []
    for index, start in enumerate(bars):
        end = bars[index + 1] if index + 1 < len(bars) else duration
        chroma_value = _range_vector(chroma, chroma_times, start, end, 12)
        onset_value = _range_energy(onset, onset_times, start, end) if onset is not None and onset_times is not None else 0.0
        feature_rows.append(np.concatenate(([bar_energy[index], onset_value], chroma_value)))
    features = np.asarray(feature_rows, dtype=float)
    scale = np.std(features, axis=0)
    features = (features - np.mean(features, axis=0)) / np.where(scale > 1e-8, scale, 1.0)
    adjacent = np.linalg.norm(np.diff(features, axis=0, prepend=features[:1]), axis=1)
    recurrence_change = np.zeros(len(features))
    for index in range(8, len(features)):
        previous = features[max(0, index - 16):index]
        recurrence_change[index] = float(np.min(np.linalg.norm(previous - features[index], axis=1)))
    novelty = 0.65 * adjacent + 0.35 * recurrence_change
    candidates = set(range(32, len(bars), 32))
    threshold = float(np.percentile(novelty, 80))
    last = 0
    for index in np.argsort(novelty)[::-1]:
        index = int(index)
        if novelty[index] < threshold:
            break
        if index >= 8 and index <= len(bars) - 8 and abs(index - last) >= 8:
            candidates.add(index)
            last = index
    selected: list[int] = []
    for index in sorted(candidates):
        if not selected or index - selected[-1] >= 8:
            selected.append(index)
    return [0.0, *[bars[index] for index in selected], duration]


def _range_vector(
    values: np.ndarray | None, times: np.ndarray | None,
    start: float, end: float, size: int,
) -> np.ndarray:
    if values is None or times is None:
        return np.zeros(size)
    mask = (times >= start) & (times < end)
    if not np.any(mask):
        return np.zeros(size)
    return np.mean(values[:, mask], axis=1)


def _range_energy(rms: np.ndarray, times: np.ndarray, start: float, end: float) -> float:
    mask = (times >= start) & (times < end)
    return float(np.mean(rms[mask])) if np.any(mask) else 0.0


def _section_label(index: int, count: int, energy: float, energies: list[float]) -> tuple[str, float]:
    if index == 0:
        return "intro", 0.72
    if index == count - 1:
        return "outro", 0.72
    median = float(np.median(energies))
    previous = energies[index - 1]
    following = energies[index + 1] if index + 1 < count else energy
    if energy < median * 0.68:
        return "breakdown", 0.58
    if energy > previous * 1.18 and following >= energy * 0.9:
        return "build", 0.52
    if energy >= max(median * 1.15, previous * 1.08):
        return "drop", 0.58
    if index % 2 == 0:
        return "chorus", 0.42
    return "verse", 0.42
