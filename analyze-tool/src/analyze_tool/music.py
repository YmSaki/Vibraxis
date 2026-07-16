from __future__ import annotations

import re
import unicodedata
from pathlib import Path

import numpy as np

from analyze_tool.models import Scale, TempoAdjustment


NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")

_MAJOR_DEGREES = {0: "I", 2: "ii", 4: "iii", 5: "IV", 7: "V", 9: "vi", 11: "vii°"}
_MINOR_DEGREES = {0: "i", 2: "ii°", 3: "III", 5: "iv", 7: "v", 8: "VI", 10: "VII"}
_CHROMATIC_DEGREES = {
    0: "I", 1: "bII", 2: "II", 3: "bIII", 4: "III", 5: "IV",
    6: "#IV", 7: "V", 8: "bVI", 9: "VI", 10: "bVII", 11: "VII",
}

_CAMELOT: dict[tuple[str, Scale], str] = {
    ("C", "major"): "8B",
    ("C#", "major"): "3B",
    ("D", "major"): "10B",
    ("D#", "major"): "5B",
    ("E", "major"): "12B",
    ("F", "major"): "7B",
    ("F#", "major"): "2B",
    ("G", "major"): "9B",
    ("G#", "major"): "4B",
    ("A", "major"): "11B",
    ("A#", "major"): "6B",
    ("B", "major"): "1B",
    ("C", "minor"): "5A",
    ("C#", "minor"): "12A",
    ("D", "minor"): "7A",
    ("D#", "minor"): "2A",
    ("E", "minor"): "9A",
    ("F", "minor"): "4A",
    ("F#", "minor"): "11A",
    ("G", "minor"): "6A",
    ("G#", "minor"): "1A",
    ("A", "minor"): "8A",
    ("A#", "minor"): "3A",
    ("B", "minor"): "10A",
}

_KEY_ALIASES = {
    "DB": "C#",
    "EB": "D#",
    "GB": "F#",
    "AB": "G#",
    "BB": "A#",
}


def canonical_key(key: str) -> str:
    normalized = key.strip().upper().replace("♯", "#").replace("♭", "B")
    normalized = _KEY_ALIASES.get(normalized, normalized)
    for note in NOTE_NAMES:
        if normalized == note.upper():
            return note
    raise ValueError(f"unsupported key: {key}")


def camelot_for(key: str, scale: Scale) -> str:
    return _CAMELOT[(canonical_key(key), scale)]


def degree_for(root: str | None, quality: str, key: str, scale: Scale, extension: str = "") -> str:
    """Convert an absolute chord to a transposition-independent Roman numeral."""

    if root is None or quality == "none":
        return "N"
    root_pc = NOTE_NAMES.index(canonical_key(root))
    key_pc = NOTE_NAMES.index(canonical_key(key))
    interval = (root_pc - key_pc) % 12
    if extension == "7" and quality == "major" and interval != 7:
        target = (interval - 7) % 12
        target_degree = (_MAJOR_DEGREES if scale == "major" else _MINOR_DEGREES).get(target)
        if target_degree is not None:
            target_degree = target_degree.replace("°", "")
            return f"V7/{target_degree}"
    diatonic = (_MAJOR_DEGREES if scale == "major" else _MINOR_DEGREES).get(interval)
    if diatonic is None:
        degree = _CHROMATIC_DEGREES[interval]
        degree = degree.lower() if quality == "minor" else degree
        if quality == "diminished":
            degree += "°"
    else:
        accidental = "".join(char for char in diatonic if char in "b#")
        roman = "".join(char for char in diatonic if char not in "b#°")
        if quality == "major":
            roman = roman.upper()
        elif quality == "minor":
            roman = roman.lower()
        degree = accidental + roman + ("°" if quality == "diminished" else "")
    return degree + extension


def fold_bpm(raw_bpm: float, minimum: float = 70.0, maximum: float = 180.0) -> tuple[float, TempoAdjustment]:
    if raw_bpm <= 0:
        raise ValueError("raw BPM must be positive")
    if minimum <= 0 or maximum <= minimum:
        raise ValueError("invalid BPM range")

    bpm = float(raw_bpm)
    adjustment: TempoAdjustment = "none"
    while bpm < minimum and bpm * 2 <= maximum:
        bpm *= 2
        adjustment = "double"
    while bpm > maximum and bpm / 2 >= minimum:
        bpm /= 2
        adjustment = "half"
    if bpm < minimum or bpm > maximum:
        bpm = min(max(bpm, minimum), maximum)
        adjustment = "clamp"
    return round(bpm, 3), adjustment


def estimate_key(chroma: np.ndarray) -> tuple[str, Scale, float]:
    """Estimate a global key using Krumhansl-Schmuckler profiles."""

    if chroma.ndim != 2 or chroma.shape[0] != 12 or chroma.shape[1] == 0:
        raise ValueError("chroma must have shape (12, frames)")

    pitch_class = np.mean(chroma, axis=1)
    if not np.any(pitch_class):
        return "C", "major", 0.0

    major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
    minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

    scores: list[tuple[float, int, Scale]] = []
    for root in range(12):
        scores.append((_correlation(pitch_class, np.roll(major, root)), root, "major"))
        scores.append((_correlation(pitch_class, np.roll(minor, root)), root, "minor"))
    scores.sort(reverse=True, key=lambda item: item[0])
    best, second = scores[0], scores[1]
    confidence = float(np.clip((best[0] - second[0]) / 0.25, 0.0, 1.0))
    return NOTE_NAMES[best[1]], best[2], round(confidence, 4)


def slugify_track_id(path: Path) -> str:
    normalized = unicodedata.normalize("NFKC", path.stem).strip().lower()
    slug = re.sub(r"[^\w-]+", "-", normalized, flags=re.UNICODE).strip("-_")
    return slug or "track"


def _correlation(left: np.ndarray, right: np.ndarray) -> float:
    if np.std(left) == 0 or np.std(right) == 0:
        return 0.0
    return float(np.corrcoef(left, right)[0, 1])
