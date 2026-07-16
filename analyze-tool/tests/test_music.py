from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np


sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from analyze_tool.music import camelot_for, canonical_key, degree_for, estimate_key, fold_bpm  # noqa: E402


class MusicTests(unittest.TestCase):
    def test_folds_half_and_double_tempo_errors(self) -> None:
        self.assertEqual(fold_bpm(62.0), (124.0, "double"))
        self.assertEqual(fold_bpm(200.0), (100.0, "half"))
        self.assertEqual(fold_bpm(128.0), (128.0, "none"))

    def test_maps_keys_to_camelot(self) -> None:
        self.assertEqual(camelot_for("A", "minor"), "8A")
        self.assertEqual(camelot_for("C", "major"), "8B")
        self.assertEqual(camelot_for("Bb", "major"), "6B")
        self.assertEqual(canonical_key("E♭"), "D#")

    def test_estimates_profile_key(self) -> None:
        c_major_profile = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
        chroma = np.repeat(c_major_profile[:, np.newaxis], 8, axis=1)
        key, scale, confidence = estimate_key(chroma)
        self.assertEqual((key, scale), ("C", "major"))
        self.assertGreater(confidence, 0)

    def test_converts_chords_to_degree_names(self) -> None:
        self.assertEqual(degree_for("C", "major", "C", "major"), "I")
        self.assertEqual(degree_for("A", "minor", "C", "major", "7"), "vi7")
        self.assertEqual(degree_for("A#", "major", "C", "major"), "bVII")
        self.assertEqual(degree_for(None, "none", "C", "major"), "N")
        self.assertEqual(degree_for("D", "major", "C", "major", "7"), "V7/V")


if __name__ == "__main__":
    unittest.main()
