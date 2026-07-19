from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from analyze_tool.advanced import infer_downbeats, infer_harmony, infer_key_regions, infer_structure  # noqa: E402


class AdvancedAnalysisTests(unittest.TestCase):
    def test_downbeat_phase_offset_shifts_the_bar_head(self) -> None:
        # Sixteen beats, ten frames apart; onset strength peaks on phase 0 beats.
        beat_frames = np.arange(16) * 10
        envelope = np.full(160, 0.1)
        envelope[beat_frames[0::4]] = 1.0
        auto, auto_phase = infer_downbeats(beat_frames, envelope, 22_050)
        self.assertEqual(auto_phase, 0)
        shifted, shifted_phase = infer_downbeats(beat_frames, envelope, 22_050, phase_offset=1)
        self.assertEqual(shifted_phase, 1)
        self.assertEqual(len(shifted), len(auto))
        self.assertGreater(shifted[0], auto[0])
        negative, negative_phase = infer_downbeats(beat_frames, envelope, 22_050, phase_offset=-1)
        self.assertEqual(negative_phase, 3)

    def test_recognizes_and_merges_c_major_bars(self) -> None:
        chroma = np.zeros((12, 8))
        chroma[[0, 4, 7], :] = 1
        harmony = infer_harmony(
            chroma, np.arange(8, dtype=float), [0, 4], list(range(8)), 8, "C", "major"
        )
        self.assertEqual(len(harmony.chords), 1)
        self.assertEqual((harmony.chords[0].symbol, harmony.chords[0].degree), ("C", "I"))

    def test_structure_covers_the_track_without_gaps(self) -> None:
        bars = [float(index * 2) for index in range(40)]
        beats = [float(index) / 2 for index in range(160)]
        rms_times = np.arange(0, 80, 0.5)
        rms = np.linspace(0.1, 0.8, len(rms_times))
        result = infer_structure(bars, beats, 80, rms, rms_times)
        self.assertEqual(result.sections[0].start_seconds, 0)
        self.assertEqual(result.sections[-1].end_seconds, 80)
        for left, right in zip(result.sections, result.sections[1:]):
            self.assertEqual(left.end_seconds, right.start_seconds)

    def test_local_key_regions_cover_duration(self) -> None:
        chroma = np.zeros((12, 80))
        chroma[[0, 4, 7], :40] = 1
        chroma[[7, 11, 2], 40:] = 1
        regions = infer_key_regions(
            chroma, np.arange(80, dtype=float), list(np.arange(0, 80, 2)), 80, "C", "major", window_bars=16
        )
        self.assertEqual(regions[0].start_seconds, 0)
        self.assertEqual(regions[-1].end_seconds, 80)
        self.assertGreaterEqual(len(regions), 2)


if __name__ == "__main__":
    unittest.main()
