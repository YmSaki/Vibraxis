from __future__ import annotations

from dataclasses import replace
from typing import Any

from analyze_tool.models import AnalysisRecord, ChordEvent, HarmonyInfo, KeyRegion, Section, StructureInfo
from analyze_tool.music import camelot_for, canonical_key, degree_for


ALLOWED_FIELDS = {
    "bpm", "key", "scale", "camelot", "energy", "keyRegions", "chords", "sections",
    "downbeatOffsetBeats",
}


def apply_overrides(record: AnalysisRecord, values: dict[str, Any]) -> AnalysisRecord:
    unknown = set(values) - ALLOWED_FIELDS
    if unknown:
        raise ValueError(f"unknown override fields for {record.track_id}: {sorted(unknown)}")

    applied: list[str] = []
    tempo = record.tempo
    tonal = record.tonal
    features = record.features

    if "bpm" in values:
        bpm = float(values["bpm"])
        if bpm <= 0:
            raise ValueError("override BPM must be positive")
        tempo = replace(tempo, bpm=round(bpm, 3), adjustment="none")
        applied.append("bpm")

    if "downbeatOffsetBeats" in values:
        offset = values["downbeatOffsetBeats"]
        if isinstance(offset, bool) or not isinstance(offset, int):
            raise ValueError("downbeatOffsetBeats override must be an integer")
        # Consumed during analysis (the downbeat phase is shifted before harmony
        # and structure are derived from the bar grid); recorded here so the
        # emitted overridesApplied provenance lists it.
        applied.append("downbeatOffsetBeats")

    if "key" in values or "scale" in values or "camelot" in values:
        key = canonical_key(str(values.get("key", tonal.key)))
        scale = str(values.get("scale", tonal.scale)).lower()
        if scale not in {"major", "minor"}:
            raise ValueError("override scale must be 'major' or 'minor'")
        camelot = str(values.get("camelot", camelot_for(key, scale)))
        tonal = replace(tonal, key=key, scale=scale, camelot=camelot, confidence=1.0)
        applied.extend(field for field in ("key", "scale", "camelot") if field in values)

    if "keyRegions" in values:
        regions = [_key_region(item) for item in _object_list(values["keyRegions"], "keyRegions")]
        tonal = replace(tonal, key_regions=regions)
        applied.append("keyRegions")

    harmony = record.harmony
    if "chords" in values:
        chords = [_chord(item, tonal.key, tonal.scale) for item in _object_list(values["chords"], "chords")]
        harmony = HarmonyInfo(chords)
        applied.append("chords")
    elif "keyRegions" in values or "key" in values or "scale" in values:
        updated: list[ChordEvent] = []
        for chord in harmony.chords:
            region = next(
                (item for item in tonal.key_regions if item.start_seconds <= chord.start_seconds < item.end_seconds),
                None,
            )
            local_key = region.key if region else tonal.key
            local_scale = region.scale if region else tonal.scale
            updated.append(replace(
                chord,
                local_key=f"{local_key} {local_scale}",
                degree=degree_for(chord.root, chord.quality, local_key, local_scale),
            ))
        harmony = HarmonyInfo(updated)

    structure = record.structure
    if "sections" in values:
        sections = [_section(item) for item in _object_list(values["sections"], "sections")]
        structure = StructureInfo(sections, [])
        applied.append("sections")

    if "energy" in values:
        energy = float(values["energy"])
        if not 0 <= energy <= 1:
            raise ValueError("override energy must be between 0 and 1")
        features = replace(features, energy=energy)
        applied.append("energy")

    return replace(
        record,
        tempo=tempo,
        tonal=tonal,
        harmony=harmony,
        structure=structure,
        features=features,
        overrides_applied=sorted(set(record.overrides_applied + applied)),
    )


def _object_list(value: Any, name: str) -> list[dict[str, Any]]:
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ValueError(f"{name} override must be an array of objects")
    return value


def _key_region(item: dict[str, Any]) -> KeyRegion:
    scale = str(item["scale"]).lower()
    if scale not in {"major", "minor"}:
        raise ValueError("key region scale must be major or minor")
    return KeyRegion(
        float(item["startSeconds"]), float(item["endSeconds"]),
        canonical_key(str(item["key"])), scale, float(item.get("confidence", 1.0)),
    )


def _chord(item: dict[str, Any], key: str, scale: str) -> ChordEvent:
    root = item.get("root")
    root = canonical_key(str(root)) if root else None
    quality = str(item.get("quality", "none" if root is None else "major"))
    start = float(item["startSeconds"])
    end = float(item["endSeconds"])
    return ChordEvent(
        float(item.get("rawStartSeconds", start)), float(item.get("rawEndSeconds", end)),
        start, end, int(item.get("beatIndex", 0)), int(item.get("barIndex", 0)),
        str(item.get("symbol", "N" if root is None else root)), root, quality,
        item.get("bass", root), str(item.get("localKey", f"{key} {scale}")),
        str(item.get("degree", degree_for(root, quality, key, scale))),
        float(item.get("confidence", 1.0)),
    )


def _section(item: dict[str, Any]) -> Section:
    return Section(
        float(item["startSeconds"]), float(item["endSeconds"]),
        int(item.get("startBeat", 0)), int(item.get("endBeat", 1)),
        int(item.get("startBar", 0)), int(item.get("endBar", 1)),
        item.get("label", "other"), str(item.get("rawLabel", "manual")),
        float(item.get("confidence", 1.0)), float(item.get("energy", 0.5)),
    )
