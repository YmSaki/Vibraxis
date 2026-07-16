from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path


sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

import json

from analyze_tool.cli import cache_matches, combined_config_hash, ensure_unique_track_ids  # noqa: E402


class CliTests(unittest.TestCase):
    def test_config_hash_is_independent_of_override_key_order(self) -> None:
        left = combined_config_hash("provider", {"bpm": 120, "key": "A"})
        right = combined_config_hash("provider", {"key": "A", "bpm": 120})
        self.assertEqual(left, right)

    def test_rejects_duplicate_track_ids_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "one" / "Same Song.mp3"
            second = root / "two" / "same-song.wav"
            first.parent.mkdir()
            second.parent.mkdir()
            first.touch()
            second.touch()

            with self.assertRaisesRegex(ValueError, "duplicate track ID"):
                ensure_unique_track_ids([first, second])

    def test_require_complete_rejects_partial_cache(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "record.json"
            path.write_text(json.dumps({
                "schemaVersion": 2,
                "source": {"sha256": "a" * 64},
                "analyzer": {"version": "1", "configHash": "b" * 64},
                "capabilities": {"features": {"status": "partial"}},
            }), encoding="utf-8")
            self.assertFalse(cache_matches(
                path, source_hash="a" * 64, analyzer_version="1",
                config_hash="b" * 64, require_complete=True,
            ))


if __name__ == "__main__":
    unittest.main()
