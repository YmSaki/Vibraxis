from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).parents[2]
annotations = json.loads((Path(__file__).parents[1] / "tests" / "golden" / "annotations.json").read_text(encoding="utf-8"))
failed = False
for track_id, expected in annotations["tracks"].items():
    record = json.loads((ROOT / "data" / "analysis" / f"{track_id}.json").read_text(encoding="utf-8"))
    error = abs(float(record["tempo"]["bpm"]) - float(expected["bpm"]))
    coverage = record["structure"]["sections"]
    valid_coverage = bool(coverage) and coverage[0]["startSeconds"] == 0 and abs(coverage[-1]["endSeconds"] - record["source"]["durationSeconds"]) < 0.01
    ok = error <= 1 and valid_coverage and bool(record["harmony"]["chords"])
    print(f"{track_id}: bpmError={error:.2f}, structureCoverage={valid_coverage}, chords={len(record['harmony']['chords'])}, ok={ok}")
    failed |= not ok
    if expected["chords"] is None or expected["sections"] is None:
        print("  accuracy: pending human chord/section annotations")
raise SystemExit(1 if failed else 0)
