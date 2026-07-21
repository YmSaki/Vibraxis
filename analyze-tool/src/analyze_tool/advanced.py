from __future__ import annotations

from dataclasses import replace

import librosa
import numpy as np

from analyze_tool.models import ChordEvent, HarmonyInfo, KeyRegion, Phrase, Section, StructureInfo
from analyze_tool.music import NOTE_NAMES, Scale, degree_for, estimate_key


def rigid_beat_times(
    onset_envelope: np.ndarray,
    sample_rate: int,
    bpm: float,
    duration: float,
    *,
    hop_length: int = 512,
    candidates: int = 64,
) -> list[float]:
    """Anchor a constant-tempo (isochronous) beat grid to the onset envelope.

    For DAW-produced material whose nominal BPM is known and constant, dynamic
    beat tracking can wander in low-onset passages; a rigid grid whose phase is
    chosen by maximum mean onset energy is more faithful. The grid period is
    exactly 60/bpm; only the anchor offset within one period is searched.
    """

    if bpm <= 0 or duration <= 0:
        raise ValueError("rigid grid requires a positive bpm and duration")
    if len(onset_envelope) == 0:
        raise ValueError("rigid grid requires a non-empty onset envelope")
    period = 60.0 / bpm
    frame_times = librosa.frames_to_time(
        np.arange(len(onset_envelope)), sr=sample_rate, hop_length=hop_length
    )
    best_offset = 0.0
    best_score = -np.inf
    for step in range(candidates):
        offset = period * step / candidates
        times = np.arange(offset, duration, period)
        if len(times) == 0:
            continue
        indexes = np.clip(np.searchsorted(frame_times, times), 0, len(onset_envelope) - 1)
        score = float(np.mean(onset_envelope[indexes]))
        if score > best_score:
            best_offset, best_score = offset, score
    return [round(float(value), 4) for value in np.arange(best_offset, duration, period)]


def infer_downbeats(
    beats: np.ndarray | list[float],
    chroma: np.ndarray,
    chroma_times: np.ndarray,
    duration: float,
    *,
    beats_per_bar: int = 4,
    phase_offset: int = 0,
) -> tuple[list[float], int]:
    """Choose the metrical phase that carries the most harmonic change.

    Chords change on the downbeat, so the beat-synchronous chroma flux (the
    harmonic change *entering* each beat) peaks on the "1". Averaging that flux
    over each candidate phase and taking the argmax is far more reliable than
    the old onset-energy heuristic, which in most material is dominated by the
    2/4 backbeat (snare/clap) and picks the wrong beat as the bar head.
    Empirically this lifted phase accuracy from 5/16 (31%, onset) to 11/16
    (69%, harmonic) on the sample set; the residual errors are the ±half-bar
    ambiguities a human resolves via `downbeatOffsetBeats`.

    `phase_offset` shifts the automatically chosen phase by that many beats
    (modulo `beats_per_bar`) for human-verified corrections. Downbeats are
    returned as an exact subset of `beats`, so they stay aligned to the grid.
    """

    beats = np.asarray(beats, dtype=float)
    if beats.size == 0:
        return [], 0
    edges = np.append(beats, max(float(duration), float(beats[-1]) + 1e-3))
    bar_chroma = np.zeros((12, beats.size))
    for index in range(beats.size):
        lo, hi = np.searchsorted(chroma_times, (edges[index], edges[index + 1]))
        if hi > lo:
            bar_chroma[:, index] = np.mean(chroma[:, lo:hi], axis=1)
    norms = np.linalg.norm(bar_chroma, axis=0, keepdims=True)
    unit = bar_chroma / np.where(norms > 1e-9, norms, 1.0)
    flux = np.zeros(beats.size)
    if beats.size > 1:
        flux[1:] = np.sum(np.abs(unit[:, 1:] - unit[:, :-1]), axis=0)
    scores = [
        float(np.mean(flux[phase::beats_per_bar])) if flux[phase::beats_per_bar].size else 0.0
        for phase in range(beats_per_bar)
    ]
    phase = (int(np.argmax(scores)) + phase_offset) % beats_per_bar
    return [round(float(value), 4) for value in beats[phase::beats_per_bar]], phase


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
    low_band: np.ndarray | None = None,
    low_band_times: np.ndarray | None = None,
    centroid: np.ndarray | None = None,
    centroid_times: np.ndarray | None = None,
    bpm: float | None = None,
) -> StructureInfo:
    """Segment the track and label each section from its acoustic *shape*.

    Boundaries follow kick-drum (low-band) state changes plus timbral/harmonic
    novelty; labels are derived from within-track relative energy, kick
    presence, the energy slope inside a section, harmonic recurrence, and the
    build->drop adjacency — not from section index parity. Every input beyond
    `rms` is optional so the function degrades gracefully; the provider supplies
    all of them. See memo/structure-investigation/INVESTIGATION.md.
    """

    if duration <= 0:
        return StructureInfo()
    bar_starts = sorted(set([0.0, *bars]))
    bar_starts = [value for value in bar_starts if value < duration]
    if len(bar_starts) < 2:
        section = Section(
            start_seconds=0.0, end_seconds=round(duration, 4),
            start_beat=0, end_beat=max(1, len(beats)), start_bar=0, end_bar=1,
            label="other", raw_label="heuristic:other", confidence=0.3, energy=0.0,
        )
        return StructureInfo([section], [])

    feats = _bar_features(
        bar_starts, duration, rms, rms_times, low_band, low_band_times,
        onset, onset_times, centroid, centroid_times, chroma, chroma_times,
    )
    boundaries = _section_boundaries(feats, min_bars=4)
    labels, energies, confidences = _section_label(feats, boundaries, bpm)

    # Merge adjacent same-label segments at the bar-index level.
    merged: list[dict] = []
    for seg in range(len(boundaries) - 1):
        record = {
            "b0": boundaries[seg], "b1": boundaries[seg + 1],
            "label": labels[seg], "energy": energies[seg], "conf": confidences[seg],
        }
        if merged and merged[-1]["label"] == record["label"]:
            merged[-1]["b1"] = record["b1"]
            merged[-1]["energy"] = max(merged[-1]["energy"], record["energy"])
            merged[-1]["conf"] = max(merged[-1]["conf"], record["conf"])
        else:
            merged.append(record)

    sections: list[Section] = []
    for record in merged:
        b0, b1 = record["b0"], record["b1"]
        start = bar_starts[b0]
        end = duration if b1 >= len(bar_starts) else bar_starts[b1]
        if end <= start:
            continue
        start_beat = max(0, int(np.searchsorted(beats, start, side="left")))
        end_beat = max(start_beat + 1, int(np.searchsorted(beats, end, side="left")))
        sections.append(Section(
            start_seconds=round(start, 4), end_seconds=round(end, 4),
            start_beat=start_beat, end_beat=end_beat,
            start_bar=b0, end_bar=max(b0 + 1, b1),
            label=record["label"], raw_label=f"heuristic:{record['label']}",
            confidence=round(record["conf"], 4), energy=round(record["energy"], 4),
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


def _bar_features(
    bar_starts: list[float], duration: float,
    rms: np.ndarray, rms_times: np.ndarray,
    low_band: np.ndarray | None, low_band_times: np.ndarray | None,
    onset: np.ndarray | None, onset_times: np.ndarray | None,
    centroid: np.ndarray | None, centroid_times: np.ndarray | None,
    chroma: np.ndarray | None, chroma_times: np.ndarray | None,
) -> dict[str, np.ndarray]:
    """Per-bar means of every envelope, on the (human-verified) bar grid."""
    edges = [*bar_starts, duration]
    count = len(bar_starts)

    def column(values: np.ndarray | None, times: np.ndarray | None) -> np.ndarray:
        result = np.zeros(count)
        if values is None or times is None:
            return result
        for index in range(count):
            lo, hi = np.searchsorted(times, (edges[index], edges[index + 1]))
            if hi > lo:
                result[index] = float(np.mean(values[lo:hi]))
        return result

    level = column(rms, rms_times)
    # low-band (kick/bass) drives boundaries; fall back to overall level if absent.
    low = column(low_band, low_band_times) if low_band is not None else level.copy()
    dens = column(onset, onset_times) if onset is not None else level.copy()
    cent = column(centroid, centroid_times)
    chroma_bar = np.zeros((12, count))
    if chroma is not None and chroma_times is not None:
        for index in range(count):
            lo, hi = np.searchsorted(chroma_times, (edges[index], edges[index + 1]))
            if hi > lo:
                chroma_bar[:, index] = np.mean(chroma[:, lo:hi], axis=1)
    return {"level": level, "low": low, "dens": dens, "cent": cent, "chroma": chroma_bar}


def _relative(values: np.ndarray) -> np.ndarray:
    """Robustly rescale a per-bar envelope to 0..1 within this track."""
    low, high = np.percentile(values, 5), np.percentile(values, 95)
    return np.clip((values - low) / (high - low + 1e-9), 0.0, 1.0)


def _section_boundaries(feats: dict[str, np.ndarray], *, min_bars: int = 4) -> list[int]:
    """Bar indices at which sections start, [0, ..., bar_count].

    Two boundary sources are unioned: (1) kick-drum state changes — where the
    within-track low band crosses in/out of "kick present", which catches drop
    entries and breakdowns; and (2) peaks of a timbral+harmonic novelty curve,
    which catches verse->chorus style changes with no kick change. Boundaries
    land on real bar lines (no phrase-grid snapping, which smeared short
    breakdowns) and are thinned to a minimum spacing.
    """
    level, low = feats["level"], feats["low"]
    count = len(level)
    if count < 2 * min_bars:
        return [0, count]

    low_rel = _relative(low)
    kernel = np.ones(3) / 3.0
    smooth_low = np.convolve(low_rel, kernel, mode="same")
    kick_on = (smooth_low > 0.42).astype(int)
    flips = [index for index in range(1, count) if kick_on[index] != kick_on[index - 1]]

    rows = [_relative(level), low_rel, _relative(feats["dens"]), _relative(feats["cent"])]
    matrix = np.vstack([*rows, feats["chroma"]]).T
    smoothed = np.vstack([np.convolve(matrix[:, j], kernel, mode="same") for j in range(matrix.shape[1])]).T
    standardized = (smoothed - smoothed.mean(axis=0)) / (smoothed.std(axis=0) + 1e-9)
    novelty = np.linalg.norm(np.diff(standardized, axis=0, prepend=standardized[:1]), axis=1)
    threshold = float(np.percentile(novelty, 75))
    peaks = [
        index for index in range(min_bars, count - min_bars // 2)
        if novelty[index] >= threshold and novelty[index] == np.max(novelty[max(0, index - 2):index + 3])
    ]

    kept: list[int] = []
    for index in sorted(set(flips) | set(peaks)):
        if 0 < index < count and (not kept or index - kept[-1] >= min_bars):
            kept.append(index)
    return sorted(set([0, *kept, count]))


def _seg_slope(values: np.ndarray) -> float:
    """Total rise across a segment relative to its mean (positive => a build)."""
    if len(values) < 3:
        return 0.0
    axis = np.arange(len(values))
    slope = float(np.polyfit(axis, values, 1)[0])
    return slope * len(values) / (float(np.mean(values)) + 1e-9)


def _section_label(
    feats: dict[str, np.ndarray], boundaries: list[int], bpm: float | None,
) -> tuple[list[str], list[float], list[float]]:
    """Label each segment from its shape. Returns (labels, energies, confidences).

    Priority: intro/outro are position *and* genuinely low energy (a loud final
    section is never an outro); breakdown is a mid-track energy valley with the
    kick reduced, flanked by louder sections; build is a rising ramp that leads
    into a louder section; a peak section reached via a build at EDM tempo is a
    drop, otherwise a recurring/loud peak is a chorus and a mid-energy section a
    verse. All thresholds are relative to *this* track. "energy" is the section
    level relative to the track peak.
    """
    level, low = feats["level"], feats["low"]
    chroma = feats["chroma"]
    count = len(boundaries) - 1
    peak = float(level.max()) + 1e-9
    if count <= 1:
        return ["other"], [float(level.mean() / peak)], [0.3]

    records = []
    for seg in range(count):
        a, b = boundaries[seg], boundaries[seg + 1]
        records.append({
            "level": float(np.mean(level[a:b])),
            "low": float(np.mean(low[a:b])),
            "slope": _seg_slope(level[a:b]),
            "cslope": _seg_slope(feats["cent"][a:b]),
            "chroma": np.mean(chroma[:, a:b], axis=1),
        })
    seg_level = np.array([record["level"] for record in records])
    seg_low = np.array([record["low"] for record in records])

    def rescale(values: np.ndarray) -> np.ndarray:
        span = float(values.max() - values.min())
        return (values - values.min()) / (span + 1e-9)

    level_rel = rescale(seg_level)
    low_rel = rescale(seg_low)
    median_rel = float(np.median(level_rel))

    def cosine(u: np.ndarray, v: np.ndarray) -> float:
        return float(u @ v / (np.linalg.norm(u) * np.linalg.norm(v) + 1e-9))
    recurring = [
        any(
            cosine(records[k]["chroma"], records[j]["chroma"]) > 0.9
            and abs(level_rel[k] - level_rel[j]) < 0.2
            for j in range(k)
        )
        for k in range(count)
    ]
    edmish = bpm is not None and 120.0 <= bpm <= 180.0

    labels: list[str] = []
    energies: list[float] = []
    confidences: list[float] = []
    for k in range(count):
        this = level_rel[k]
        kick = low_rel[k]
        slope = records[k]["slope"]
        previous = level_rel[k - 1] if k > 0 else None
        following = level_rel[k + 1] if k + 1 < count else None
        is_high = this >= 0.6 and kick >= 0.45
        is_low = this <= 0.4 or kick <= 0.35
        confidence = 0.45

        if k == 0 and this <= 0.55:
            label, confidence = "intro", 0.6
        elif k == count - 1 and (this <= 0.45 or kick <= 0.35):
            label, confidence = "outro", 0.6
        elif is_low and 0 < k < count - 1 and (
            (previous is not None and previous > this + 0.15)
            or (following is not None and following > this + 0.15)
        ):
            label, confidence = "breakdown", 0.5
        elif slope > 0.3 and following is not None and following > this + 0.05 and records[k]["cslope"] >= 0:
            label, confidence = "build", 0.5
        elif is_high:
            came_from_build = previous is not None and (records[k - 1]["slope"] > 0.3 or previous < this - 0.2)
            if came_from_build and edmish:
                label, confidence = "drop", 0.5
            elif recurring[k] or this >= 0.85:
                label, confidence = "chorus", 0.45
            else:
                label, confidence = "verse", 0.4
        else:
            label, confidence = ("verse", 0.4) if this >= median_rel else ("breakdown", 0.4)

        labels.append(label)
        energies.append(float(seg_level[k] / peak))
        confidences.append(confidence)
    return labels, energies, confidences
