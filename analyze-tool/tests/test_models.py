from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from analyze_tool.models import (  # noqa: E402
    AnalysisRecord, AnalyzerInfo, AudioFeatures, CapabilityInfo, ChordEvent,
    HarmonyInfo, KeyRegion, Section, SourceInfo, StructureInfo, TempoInfo, TonalInfo,
)


def make_record() -> AnalysisRecord:
    return AnalysisRecord(
        "example", SourceInfo("example.mp3", "a" * 64, 60.0, 44_100),
        AnalyzerInfo("librosa", "1", "2026-07-16T00:00:00Z", "b" * 64),
        {
            "features": CapabilityInfo("complete", "librosa", "1", 0.8),
            "beatGrid": CapabilityInfo("complete", "librosa", "1", 0.6),
            "harmony": CapabilityInfo("complete", "test", "1", 0.5),
            "structure": CapabilityInfo("complete", "test", "1", 0.5),
        },
        TempoInfo(
            120.0, 60.0, "double", "4/4",
            [index * 0.5 for index in range(120)],
            [index * 2.0 for index in range(30)],
            [index * 2.0 for index in range(30)],
        ),
        TonalInfo("A", "minor", "8A", 0.5, [KeyRegion(0, 60, "A", "minor", 0.5)]),
        HarmonyInfo([ChordEvent(0, 2, 0, 2, 0, 0, "Am", "A", "minor", "A", "A minor", "i", 0.7)]),
        StructureInfo([Section(0, 60, 0, 120, 0, 30, "intro", "manual", 1, 0.5)], []),
        AudioFeatures(0.7, 0.1, -20.0, 5.0, 2.0, 2_000.0),
    )


class AnalysisRecordTests(unittest.TestCase):
    def test_serializes_schema_v2_in_camel_case(self) -> None:
        data = make_record().to_dict()
        self.assertEqual(data["schemaVersion"], 2)
        self.assertEqual(data["tempo"]["timeSignature"], "4/4")
        self.assertEqual(data["harmony"]["chords"][0]["degree"], "i")
        self.assertEqual(data["structure"]["sections"][0]["rawLabel"], "manual")
        self.assertNotIn("duration_seconds", data["source"])

    def test_rejects_non_increasing_beats(self) -> None:
        with self.assertRaisesRegex(ValueError, "strictly increasing"):
            TempoInfo(120.0, 120.0, "none", beats_seconds=[1.0, 1.0])

    def test_rejects_overlapping_sections(self) -> None:
        with self.assertRaisesRegex(ValueError, "must not overlap"):
            StructureInfo([
                Section(0, 10, 0, 20, 0, 5, "intro", "a", 1, 0.2),
                Section(9, 20, 18, 40, 4, 10, "verse", "b", 1, 0.3),
            ])


if __name__ == "__main__":
    unittest.main()
