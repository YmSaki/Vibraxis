from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ANALYSIS_DIR = Path(__file__).parents[2] / "data" / "analysis"


class GeneratedSampleTests(unittest.TestCase):
    def test_committed_analysis_records_are_complete(self) -> None:
        records = sorted(ANALYSIS_DIR.glob("*.json"))
        self.assertGreater(len(records), 0, "run `uv run task analyze-samples` first")

        for path in records:
            with self.subTest(path=path.name):
                data = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(data["schemaVersion"], 2)
                self.assertEqual(len(data["source"]["sha256"]), 64)
                self.assertGreater(len(data["tempo"]["beatsSeconds"]), 0)
                self.assertGreaterEqual(data["features"]["energy"], 0)
                self.assertLessEqual(data["features"]["energy"], 1)
                self.assertEqual(set(data["capabilities"]), {"features", "beatGrid", "harmony", "structure"})
                self.assertGreater(len(data["tempo"]["downbeatsSeconds"]), 0)
                self.assertGreater(len(data["harmony"]["chords"]), 0)
                self.assertGreater(len(data["structure"]["sections"]), 0)
                self.assertEqual(data["capabilities"]["features"]["status"], "complete")
                self.assertEqual(data["capabilities"]["harmony"]["status"], "partial")
                self.assertEqual(data["capabilities"]["structure"]["status"], "partial")

                expected_bpm = re.search(r"BPM(\d+)", data["source"]["file"], re.IGNORECASE)
                if expected_bpm:
                    self.assertEqual(data["tempo"]["bpm"], float(expected_bpm.group(1)))
                    self.assertIn("bpm", data["overridesApplied"])


if __name__ == "__main__":
    unittest.main()
