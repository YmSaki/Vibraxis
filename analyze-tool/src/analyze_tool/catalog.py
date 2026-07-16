from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from analyze_tool.validation import validate_analysis


REQUIRED_FIELDS = {"file", "title", "artist", "genre", "mood", "license", "sourceUrl"}


def build_catalog(
    source_path: Path, analysis_dir: Path, output_path: Path, *,
    allow_partial: bool = False, allow_unverified_license: bool = False,
) -> dict[str, Any]:
    source = json.loads(source_path.read_text(encoding="utf-8"))
    tracks = source.get("tracks", source)
    if not isinstance(tracks, dict):
        raise ValueError("catalog source must contain a trackId-to-metadata object")

    records: list[dict[str, Any]] = []
    analysis_ids = {path.stem for path in analysis_dir.glob("*.json")}
    source_ids = set(tracks)
    missing = source_ids - analysis_ids
    extra = analysis_ids - source_ids
    if missing:
        raise ValueError(f"catalog source has no analysis for: {sorted(missing)}")
    if extra:
        raise ValueError(f"analysis has no catalog metadata for: {sorted(extra)}")

    for track_id in sorted(source_ids):
        metadata = tracks[track_id]
        if not isinstance(metadata, dict):
            raise ValueError(f"metadata for {track_id} must be an object")
        absent = REQUIRED_FIELDS - set(metadata)
        if absent:
            raise ValueError(f"metadata for {track_id} is missing: {sorted(absent)}")
        if any(metadata[field] in {None, ""} for field in REQUIRED_FIELDS - {"mood"}):
            raise ValueError(f"metadata for {track_id} contains an empty required field")
        if not allow_unverified_license and str(metadata["license"]).lower().startswith("unverified"):
            raise ValueError(f"metadata for {track_id} has an unverified license")
        analysis_path = analysis_dir / f"{track_id}.json"
        analysis = json.loads(analysis_path.read_text(encoding="utf-8"))
        validate_analysis(analysis, require_complete=not allow_partial)
        incomplete = [
            name for name, info in analysis["capabilities"].items()
            if info["status"] != "complete"
        ]
        if incomplete and not allow_partial:
            raise ValueError(f"analysis for {track_id} is incomplete: {incomplete}")
        degrees = [event["degree"] for event in analysis["harmony"]["chords"]]
        fingerprint = [degree for index, degree in enumerate(degrees) if index == 0 or degree != degrees[index - 1]]
        records.append({
            "trackId": track_id,
            **{key: metadata[key] for key in sorted(REQUIRED_FIELDS)},
            "analysisFile": analysis_path.relative_to(output_path.parent.parent).as_posix()
            if output_path.parent.parent in analysis_path.parents else analysis_path.as_posix(),
            "bpm": analysis["tempo"]["bpm"],
            "key": analysis["tonal"]["key"],
            "scale": analysis["tonal"]["scale"],
            "camelot": analysis["tonal"]["camelot"],
            "energy": analysis["features"]["energy"],
            "sectionSummary": [
                {
                    "label": section["label"],
                    "startSeconds": section["startSeconds"],
                    "endSeconds": section["endSeconds"],
                    "startBeat": section["startBeat"],
                    "endBeat": section["endBeat"],
                    "startBar": section["startBar"],
                    "endBar": section["endBar"],
                }
                for section in analysis["structure"]["sections"]
            ],
            "performancePads": _performance_pads(analysis["structure"]["sections"]),
            "degreeFingerprint": fingerprint,
            "capabilities": {name: info["status"] for name, info in analysis["capabilities"].items()},
            "licenseStatus": "unverified" if str(metadata["license"]).lower().startswith("unverified") else "verified",
        })
    catalog = {"catalogVersion": 1, "tracks": records}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    temporary.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(output_path)
    return catalog


def _performance_pads(sections: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not sections:
        return []

    selected: list[dict[str, Any]] = []

    def add(section: dict[str, Any] | None) -> None:
        if section is not None and section not in selected:
            selected.append(section)

    add(sections[0])
    for label in ("verse", "build", "drop", "breakdown"):
        add(next((section for section in sections if section["label"] == label), None))
    drops = [section for section in sections if section["label"] == "drop"]
    if len(drops) > 1:
        add(drops[1])
    add(sections[-2] if len(sections) > 1 else None)
    add(sections[-1])

    for section in sections:
        if len(selected) >= 8:
            break
        add(section)

    selected.sort(key=lambda section: section["startSeconds"])
    return [
        {
            "slot": index,
            "type": "hotCue",
            "label": section["label"].upper(),
            "timeSeconds": section["startSeconds"],
            "beatIndex": section["startBeat"],
            "barIndex": section["startBar"],
            "beatInBar": section["startBeat"] % 4 + 1,
            "source": "auto",
            "locked": False,
        }
        for index, section in enumerate(selected[:8], start=1)
    ]
