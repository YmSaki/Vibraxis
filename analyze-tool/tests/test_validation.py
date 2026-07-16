from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "src"))

from analyze_tool.validation import validate_analysis  # noqa: E402
from tests.test_models import make_record  # noqa: E402


class ValidationTests(unittest.TestCase):
    def test_accepts_model_output(self) -> None:
        validate_analysis(make_record().to_dict(), require_complete=True)

    def test_rejects_section_gap(self) -> None:
        data = make_record().to_dict()
        section = data["structure"]["sections"][0]
        section["startSeconds"] = 1
        with self.assertRaisesRegex(ValueError, "cover"):
            validate_analysis(data)

    def test_require_complete_rejects_partial(self) -> None:
        data = copy.deepcopy(make_record().to_dict())
        data["capabilities"]["harmony"]["status"] = "partial"
        with self.assertRaisesRegex(ValueError, "not complete"):
            validate_analysis(data, require_complete=True)

    def test_rejects_out_of_range_references(self) -> None:
        data = make_record().to_dict()
        data["harmony"]["chords"][0]["barIndex"] = 99
        with self.assertRaisesRegex(ValueError, "outside the bar grid"):
            validate_analysis(data)

    def test_rejects_phrase_with_unknown_section(self) -> None:
        data = make_record().to_dict()
        data["structure"]["phrases"] = [{
            "startSeconds": 0, "endSeconds": 2,
            "startBar": 0, "endBar": 1, "sectionIndex": 9,
        }]
        with self.assertRaisesRegex(ValueError, "sectionIndex"):
            validate_analysis(data)

    def test_rejects_malformed_analyzer_and_features(self) -> None:
        data = make_record().to_dict()
        data["features"]["energy"] = "invalid"
        with self.assertRaisesRegex(ValueError, "must be a number"):
            validate_analysis(data)
        data = make_record().to_dict()
        data["analyzer"] = {}
        with self.assertRaisesRegex(ValueError, "analyzer fields"):
            validate_analysis(data)


if __name__ == "__main__":
    unittest.main()
