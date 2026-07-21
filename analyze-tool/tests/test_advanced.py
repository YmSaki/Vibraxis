from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from analyze_tool.advanced import (  # noqa: E402
    infer_downbeats,
    infer_harmony,
    infer_key_regions,
    infer_structure,
    rigid_beat_times,
)


class AdvancedAnalysisTests(unittest.TestCase):
    def test_rigid_grid_is_isochronous_and_anchors_to_onset_peaks(self) -> None:
        # 120 BPM -> exact 0.5 s period. Onset peaks at 0.2 + k * 0.5 seconds.
        sample_rate, hop = 22_050, 512
        frame_dt = hop / sample_rate
        envelope = np.full(400, 0.01)
        for k in range(18):
            envelope[int(round((0.2 + k * 0.5) / frame_dt))] = 1.0
        beats = rigid_beat_times(envelope, sample_rate, 120.0, 9.0, hop_length=hop)
        self.assertGreater(len(beats), 15)
        intervals = np.diff(beats)
        self.assertTrue(np.allclose(intervals, 0.5, atol=1e-3), intervals[:4])
        # Anchor lands on the true beat phase within frame+search resolution.
        self.assertLess(abs(beats[0] - 0.2), 0.035, beats[0])

    def test_rigid_grid_rejects_invalid_inputs(self) -> None:
        with self.assertRaises(ValueError):
            rigid_beat_times(np.ones(10), 22_050, 0.0, 9.0)
        with self.assertRaises(ValueError):
            rigid_beat_times(np.ones(0), 22_050, 120.0, 9.0)

    def test_downbeat_phase_from_harmonic_change(self) -> None:
        # 16 beats one second apart; the chord changes every four beats starting
        # on phase 0 (bars C, G, Am, F), so the beat-synchronous chroma flux
        # peaks on phase-0 beats and the detector must choose phase 0.
        beats = np.arange(16, dtype=float)
        times = np.arange(0.0, 16.0, 0.1)
        chroma = np.zeros((12, len(times)))
        chords = {0: (0, 4, 7), 1: (7, 11, 2), 2: (9, 0, 4), 3: (5, 9, 0)}
        for column, moment in enumerate(times):
            for pitch_class in chords[int(moment // 4) % 4]:
                chroma[pitch_class, column] = 1.0
        auto, auto_phase = infer_downbeats(beats, chroma, times, 16.0)
        self.assertEqual(auto_phase, 0)
        self.assertEqual(auto[0], 0.0)
        shifted, shifted_phase = infer_downbeats(beats, chroma, times, 16.0, phase_offset=1)
        self.assertEqual(shifted_phase, 1)
        self.assertEqual(len(shifted), len(auto))
        self.assertGreater(shifted[0], auto[0])
        _, negative_phase = infer_downbeats(beats, chroma, times, 16.0, phase_offset=-1)
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
