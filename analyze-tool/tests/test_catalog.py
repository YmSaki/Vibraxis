from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from analyze_tool.catalog import _performance_pads, build_catalog  # noqa: E402
from tests.test_models import make_record  # noqa: E402


class CatalogTests(unittest.TestCase):
    def test_builds_compact_catalog(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            analysis = root / "analysis"
            analysis.mkdir()
            (analysis / "example.json").write_text(json.dumps(make_record().to_dict()), encoding="utf-8")
            source = root / "catalog-source.json"
            source.write_text(json.dumps({"tracks": {"example": {
                "file": "example.mp3", "title": "Example", "artist": "Test",
                "genre": "test", "mood": ["test"], "license": "test-only", "sourceUrl": "local",
            }}}), encoding="utf-8")
            output = root / "catalog.json"
            catalog = build_catalog(source, analysis, output)
            self.assertEqual(catalog["tracks"][0]["beatCount"], 120)
            self.assertEqual(catalog["tracks"][0]["degreeFingerprint"], ["i"])
            self.assertEqual(catalog["tracks"][0]["performancePads"][0]["slot"], 1)
            self.assertEqual(catalog["tracks"][0]["performancePads"][0]["label"], "FIRST BEAT")
            self.assertEqual(catalog["tracks"][0]["performancePads"][0]["timeSeconds"], 0)
            self.assertTrue(output.exists())

    def test_performance_pads_snap_to_downbeats(self) -> None:
        sections = [
            {"label": "intro", "startSeconds": 0.0, "startBeat": 0, "startBar": 0},
            {"label": "drop", "startSeconds": 2.8, "startBeat": 6, "startBar": 2},
        ]
        beats = [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75]
        bars = [0.75, 2.75]

        pads = _performance_pads(sections, beats, bars)

        self.assertEqual(pads[0]["label"], "FIRST BEAT")
        self.assertEqual(pads[0]["timeSeconds"], 0.75)
        self.assertEqual(pads[0]["beatIndex"], 1)
        self.assertEqual(pads[0]["barIndex"], 0)
        self.assertEqual(pads[0]["beatInBar"], 1)
        self.assertEqual(pads[1]["timeSeconds"], 2.75)
        self.assertEqual(pads[1]["beatInBar"], 1)

    def test_rejects_missing_license_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            analysis = root / "analysis"
            analysis.mkdir()
            (analysis / "example.json").write_text(json.dumps(make_record().to_dict()), encoding="utf-8")
            source = root / "catalog-source.json"
            source.write_text(json.dumps({"tracks": {"example": {"file": "example.mp3"}}}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "missing"):
                build_catalog(source, analysis, root / "catalog.json")

    def test_unverified_license_requires_explicit_development_flag(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            analysis = root / "analysis"
            analysis.mkdir()
            (analysis / "example.json").write_text(json.dumps(make_record().to_dict()), encoding="utf-8")
            source = root / "catalog-source.json"
            source.write_text(json.dumps({"tracks": {"example": {
                "file": "example.mp3", "title": "Example", "artist": "Test",
                "genre": "test", "mood": [], "license": "Unverified local sample", "sourceUrl": "local",
            }}}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "unverified license"):
                build_catalog(source, analysis, root / "catalog.json")
            catalog = build_catalog(
                source, analysis, root / "catalog.json", allow_unverified_license=True
            )
            self.assertEqual(catalog["tracks"][0]["licenseStatus"], "unverified")


if __name__ == "__main__":
    unittest.main()
