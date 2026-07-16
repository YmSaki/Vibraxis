from __future__ import annotations

import sys
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from analyze_tool.models import (  # noqa: E402
    AnalysisRecord, AnalyzerInfo, AudioFeatures, CapabilityInfo, HarmonyInfo,
    SourceInfo, StructureInfo, TempoInfo, TonalInfo,
)
from analyze_tool.overrides import apply_overrides  # noqa: E402


def make_record() -> AnalysisRecord:
    return AnalysisRecord(
        track_id="example",
        source=SourceInfo("example.mp3", "a" * 64, 60.0, 44_100),
        analyzer=AnalyzerInfo("librosa", "1", "2026-07-16T00:00:00Z", "b" * 64),
        capabilities={
            "features": CapabilityInfo("complete", "test", "1"),
            "beatGrid": CapabilityInfo("complete", "test", "1"),
            "harmony": CapabilityInfo("complete", "test", "1"),
            "structure": CapabilityInfo("complete", "test", "1"),
        },
        tempo=TempoInfo(120.0, 120.0, "none", beats_seconds=[0.5, 1.0]),
        tonal=TonalInfo("C", "major", "8B", 0.2),
        harmony=HarmonyInfo(),
        structure=StructureInfo(),
        features=AudioFeatures(0.4, 0.1, -20.0, 5.0, 2.0, 2_000.0),
    )


class OverrideTests(unittest.TestCase):
    def test_manual_values_win_and_camelot_is_recomputed(self) -> None:
        result = apply_overrides(make_record(), {"bpm": 126, "key": "A", "scale": "minor", "energy": 0.8})
        self.assertEqual(result.tempo.bpm, 126)
        self.assertEqual(result.tonal.camelot, "8A")
        self.assertEqual(result.tonal.confidence, 1.0)
        self.assertEqual(result.features.energy, 0.8)
        self.assertEqual(result.overrides_applied, ["bpm", "energy", "key", "scale"])

    def test_rejects_unknown_override(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown override"):
            apply_overrides(make_record(), {"mood": "happy"})

    def test_manual_harmony_and_sections_replace_automatic_values(self) -> None:
        result = apply_overrides(make_record(), {
            "keyRegions": [{
                "startSeconds": 0, "endSeconds": 60, "key": "D", "scale": "minor"
            }],
            "chords": [{
                "startSeconds": 0, "endSeconds": 4, "root": "D", "quality": "minor",
                "symbol": "Dm", "degree": "i"
            }],
            "sections": [{
                "startSeconds": 0, "endSeconds": 60, "startBeat": 0, "endBeat": 120,
                "startBar": 0, "endBar": 30, "label": "intro"
            }],
        })
        self.assertEqual(result.tonal.key_regions[0].key, "D")
        self.assertEqual(result.harmony.chords[0].degree, "i")
        self.assertEqual(result.structure.sections[0].label, "intro")
        self.assertEqual(result.overrides_applied, ["chords", "keyRegions", "sections"])

if __name__ == "__main__":
    unittest.main()
