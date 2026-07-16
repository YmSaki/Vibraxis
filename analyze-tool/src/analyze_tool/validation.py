from __future__ import annotations

import math
from datetime import datetime
from typing import Any


REQUIRED_TOP_LEVEL = {
    "schemaVersion", "trackId", "source", "analyzer", "capabilities", "tempo",
    "tonal", "harmony", "structure", "features", "overridesApplied",
}
CAPABILITIES = {"features", "beatGrid", "harmony", "structure"}
STATUSES = {"complete", "partial", "failed", "skipped"}


def validate_analysis(data: dict[str, Any], *, require_complete: bool = False) -> None:
    if set(data) != REQUIRED_TOP_LEVEL or data.get("schemaVersion") != 2:
        raise ValueError("analysis does not match schema v2 top-level contract")
    _finite(data)
    if not isinstance(data["trackId"], str) or not data["trackId"]:
        raise ValueError("trackId must be a non-empty string")
    duration = _positive(data["source"], "durationSeconds")
    if set(data["source"]) != {"file", "sha256", "durationSeconds", "sampleRate"}:
        raise ValueError("source fields do not match schema v2")
    if not isinstance(data["source"]["file"], str) or not data["source"]["file"]:
        raise ValueError("source.file must be a non-empty string")
    if not isinstance(data["source"]["sampleRate"], int) or data["source"]["sampleRate"] <= 0:
        raise ValueError("source.sampleRate must be a positive integer")
    if len(data["source"].get("sha256", "")) != 64:
        raise ValueError("source.sha256 must contain 64 characters")
    try:
        int(data["source"]["sha256"], 16)
    except (TypeError, ValueError) as error:
        raise ValueError("source.sha256 must be hexadecimal") from error
    _analyzer(data["analyzer"])
    _features(data["features"])
    _tempo(data["tempo"])
    _tonal(data["tonal"])
    capabilities = data["capabilities"]
    if set(capabilities) != CAPABILITIES:
        raise ValueError("analysis capabilities are incomplete or unknown")
    for name, info in capabilities.items():
        if set(info) != {"status", "provider", "version", "confidence", "error"}:
            raise ValueError(f"invalid capability fields: {name}")
        if info.get("status") not in STATUSES:
            raise ValueError(f"invalid capability status: {name}")
        if not isinstance(info["provider"], str) or not info["provider"]:
            raise ValueError(f"capability provider is invalid: {name}")
        if not isinstance(info["version"], str) or not info["version"]:
            raise ValueError(f"capability version is invalid: {name}")
        if info["confidence"] is not None:
            _unit(info["confidence"], f"capability confidence: {name}")
        if info["status"] == "failed" and not isinstance(info["error"], str):
            raise ValueError(f"failed capability must contain an error: {name}")
        if require_complete and info["status"] != "complete":
            raise ValueError(f"capability is not complete: {name}")

    for key in ("beatsSeconds", "downbeatsSeconds", "barsSeconds"):
        _timestamps(data["tempo"].get(key), f"tempo.{key}", duration)
    beats = data["tempo"]["beatsSeconds"]
    bars = data["tempo"]["barsSeconds"]
    bar_starts = sorted(set([0.0, *bars]))
    key_regions = data["tonal"].get("keyRegions")
    _intervals(key_regions, "tonal.keyRegions", duration, cover=True)
    for region in key_regions:
        if region.get("scale") not in {"major", "minor"} or not isinstance(region.get("key"), str):
            raise ValueError("key region key or scale is invalid")
        _unit(region.get("confidence"), "key region confidence")
    chords = data["harmony"].get("chords")
    _intervals(chords, "harmony.chords", duration)
    sections = data["structure"].get("sections")
    _intervals(sections, "structure.sections", duration, cover=bool(sections))
    _intervals(data["structure"].get("phrases"), "structure.phrases", duration)
    for chord in chords:
        beat_index = chord.get("beatIndex", -1)
        bar_index = chord.get("barIndex", -1)
        if not isinstance(beat_index, int) or not 0 <= beat_index <= len(beats):
            raise ValueError("chord beatIndex is outside the beat grid")
        if not isinstance(bar_index, int) or not 0 <= bar_index < len(bar_starts):
            raise ValueError("chord barIndex is outside the bar grid")
        if abs(float(chord["startSeconds"]) - float(bar_starts[bar_index])) > 0.02:
            raise ValueError("chord barIndex does not match startSeconds")
        if not chord.get("degree") or not chord.get("symbol"):
            raise ValueError("chord symbol and degree are required")
        _unit(chord.get("confidence"), "chord confidence")
        _number(chord.get("rawStartSeconds"), "chord.rawStartSeconds")
        _number(chord.get("rawEndSeconds"), "chord.rawEndSeconds")
    for section in sections:
        if section.get("label") not in {
            "intro", "verse", "preChorus", "chorus", "build", "drop",
            "breakdown", "bridge", "instrumental", "outro", "other",
        }:
            raise ValueError("section label is invalid")
        _unit(section.get("confidence"), "section confidence")
        _unit(section.get("energy"), "section energy")
        _exclusive_range(section, "startBeat", "endBeat", len(beats), "section beat")
        _exclusive_range(section, "startBar", "endBar", len(bar_starts), "section bar")
        _boundary_matches(section, "startSeconds", "startBar", bar_starts, duration, "section startBar")
        _boundary_matches(section, "endSeconds", "endBar", bar_starts, duration, "section endBar")
    phrases = data["structure"]["phrases"]
    for phrase in phrases:
        _exclusive_range(phrase, "startBar", "endBar", len(bar_starts), "phrase bar")
        section_index = phrase.get("sectionIndex", -1)
        if not isinstance(section_index, int) or not 0 <= section_index < len(sections):
            raise ValueError("phrase sectionIndex is outside the section list")
        section = sections[section_index]
        if (
            float(phrase["startSeconds"]) < float(section["startSeconds"]) - 0.01
            or float(phrase["endSeconds"]) > float(section["endSeconds"]) + 0.01
        ):
            raise ValueError("phrase is outside its referenced section")

    if capabilities["beatGrid"]["status"] == "complete" and not data["tempo"]["downbeatsSeconds"]:
        raise ValueError("complete beatGrid requires downbeats")
    if capabilities["harmony"]["status"] == "complete" and not chords:
        raise ValueError("complete harmony requires chords")
    if capabilities["structure"]["status"] == "complete" and not sections:
        raise ValueError("complete structure requires sections")


def _finite(value: Any) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError("analysis cannot contain NaN or infinity")
    if isinstance(value, dict):
        for item in value.values():
            _finite(item)
    elif isinstance(value, list):
        for item in value:
            _finite(item)


def _positive(value: dict[str, Any], key: str) -> float:
    result = _number(value.get(key), key)
    if result <= 0:
        raise ValueError(f"{key} must be positive")
    return result


def _number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    return float(value)


def _unit(value: Any, name: str) -> None:
    number = _number(value, name)
    if not 0 <= number <= 1:
        raise ValueError(f"{name} must be between 0 and 1")


def _analyzer(value: Any) -> None:
    required = {"provider", "version", "analyzedAt", "configHash"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("analyzer fields do not match schema v2")
    if any(not isinstance(value[key], str) or not value[key] for key in required):
        raise ValueError("analyzer fields must be non-empty strings")
    if len(value["configHash"]) != 64:
        raise ValueError("analyzer.configHash must contain 64 characters")
    try:
        int(value["configHash"], 16)
        datetime.fromisoformat(value["analyzedAt"].replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError("analyzer hash or timestamp is invalid") from error


def _features(value: Any) -> None:
    required = {"energy", "rms", "loudnessDb", "dynamicRangeDb", "onsetRate", "spectralCentroidHz"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("feature fields do not match schema v2")
    _unit(value["energy"], "features.energy")
    for key in ("rms", "dynamicRangeDb", "onsetRate", "spectralCentroidHz"):
        if _number(value[key], f"features.{key}") < 0:
            raise ValueError(f"features.{key} cannot be negative")
    _number(value["loudnessDb"], "features.loudnessDb")


def _tempo(value: Any) -> None:
    required = {"bpm", "rawBpm", "adjustment", "timeSignature", "beatsSeconds", "downbeatsSeconds", "barsSeconds"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("tempo fields do not match schema v2")
    if _number(value["bpm"], "tempo.bpm") <= 0 or _number(value["rawBpm"], "tempo.rawBpm") <= 0:
        raise ValueError("tempo values must be positive")
    if value["adjustment"] not in {"none", "double", "half", "clamp"}:
        raise ValueError("tempo adjustment is invalid")
    if not isinstance(value["timeSignature"], str) or not value["timeSignature"]:
        raise ValueError("time signature is invalid")


def _tonal(value: Any) -> None:
    required = {"key", "scale", "camelot", "confidence", "keyRegions"}
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("tonal fields do not match schema v2")
    if value["scale"] not in {"major", "minor"}:
        raise ValueError("tonal scale is invalid")
    if any(not isinstance(value[key], str) or not value[key] for key in ("key", "camelot")):
        raise ValueError("tonal key and camelot must be non-empty strings")
    _unit(value["confidence"], "tonal confidence")


def _timestamps(values: Any, name: str, duration: float) -> None:
    if not isinstance(values, list):
        raise ValueError(f"{name} must be an array")
    numbers = [_number(value, name) for value in values]
    if any(not 0 <= value <= duration + 0.01 for value in numbers):
        raise ValueError(f"{name} contains an out-of-range timestamp")
    if any(left >= right for left, right in zip(numbers, numbers[1:])):
        raise ValueError(f"{name} must be strictly increasing")


def _intervals(values: Any, name: str, duration: float, *, cover: bool = False) -> None:
    if not isinstance(values, list):
        raise ValueError(f"{name} must be an array")
    previous_end: float | None = None
    for value in values:
        start = _number(value.get("startSeconds"), f"{name}.startSeconds")
        end = _number(value.get("endSeconds"), f"{name}.endSeconds")
        if start < 0 or end <= start or end > duration + 0.01:
            raise ValueError(f"{name} contains an invalid interval")
        if previous_end is not None and start < previous_end - 0.001:
            raise ValueError(f"{name} intervals overlap or are out of order")
        previous_end = end
    if cover and values:
        if abs(float(values[0]["startSeconds"])) > 0.01 or abs(float(values[-1]["endSeconds"]) - duration) > 0.01:
            raise ValueError(f"{name} must cover the complete track")
        for left, right in zip(values, values[1:]):
            if abs(float(left["endSeconds"]) - float(right["startSeconds"])) > 0.01:
                raise ValueError(f"{name} contains a gap")


def _exclusive_range(
    value: dict[str, Any], start_key: str, end_key: str, maximum: int, name: str
) -> None:
    start, end = value.get(start_key), value.get(end_key)
    if not isinstance(start, int) or not isinstance(end, int) or not 0 <= start < end <= maximum:
        raise ValueError(f"{name} indexes are invalid")


def _boundary_matches(
    value: dict[str, Any], seconds_key: str, index_key: str,
    boundaries: list[float], duration: float, name: str,
) -> None:
    index = value[index_key]
    expected = boundaries[index] if index < len(boundaries) else duration
    if abs(float(value[seconds_key]) - float(expected)) > 0.02:
        raise ValueError(f"{name} does not match its timestamp")
