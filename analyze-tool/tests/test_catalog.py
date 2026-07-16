from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from analyze_tool.catalog import build_catalog  # noqa: E402
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
            self.assertEqual(catalog["tracks"][0]["degreeFingerprint"], ["i"])
            self.assertEqual(catalog["tracks"][0]["performancePads"][0]["slot"], 1)
            self.assertEqual(catalog["tracks"][0]["performancePads"][0]["label"], "INTRO")
            self.assertEqual(catalog["tracks"][0]["performancePads"][0]["timeSeconds"], 0)
            self.assertTrue(output.exists())

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
