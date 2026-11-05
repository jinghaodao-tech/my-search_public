import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from compare_search_results import main


class PairedComparisonTests(unittest.TestCase):
    def compare(self, before, after):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            baseline = root / "before.json"
            candidate = root / "after.json"
            output = root / "comparison.json"
            baseline.write_text(json.dumps({"all_results": before}), encoding="utf-8")
            candidate.write_text(json.dumps({"results": after}), encoding="utf-8")
            with patch("sys.argv", ["compare", "--baseline", str(baseline), "--candidate", str(candidate),
                                    "--bootstrap", "100", "--out", str(output)]):
                with contextlib.redirect_stdout(io.StringIO()):
                    main()
            return json.loads(output.read_text(encoding="utf-8"))

    def test_paired_discordance_and_exact_test(self):
        before = [{"qid": str(i), "expected": [str(i)], "success": False} for i in range(6)]
        after = [{"qid": str(i), "expected": [str(i)], "rankTop10": 1} for i in range(6)]
        result = self.compare(before, after)
        self.assertEqual(result["improved_queries"], 6)
        self.assertEqual(result["worsened_queries"], 0)
        self.assertEqual(result["exact_mcnemar_two_sided_p"], 0.03125)

    def test_shared_targets_disable_independent_exact_test(self):
        before = [{"qid": str(i), "expected": ["target"], "group_id": "shared", "success": False}
                  for i in range(2)]
        after = [{"qid": str(i), "expected": ["target"], "groupId": "shared", "rankTop10": 1}
                 for i in range(2)]
        result = self.compare(before, after)
        self.assertEqual(result["clusters"], 1)
        self.assertIsNone(result["exact_mcnemar_two_sided_p"])

    def test_changed_gold_labels_rejected(self):
        with self.assertRaisesRegex(ValueError, "gold labels changed"):
            self.compare([{"qid": "q", "expected": ["a"], "success": False}],
                         [{"qid": "q", "expected": ["b"], "rankTop10": 1}])


if __name__ == "__main__":
    unittest.main()
