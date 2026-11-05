import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from benchmark_api import binary_ndcg_at_10


class BenchmarkMetricsTests(unittest.TestCase):
    def test_multiple_relevant_documents_use_multiple_document_ideal(self):
        result = {"status": "ok", "expected": ["a", "b"], "top10": ["a", "x", "b"]}
        expected = (1 + 1 / math.log2(4)) / (1 + 1 / math.log2(3))
        self.assertAlmostEqual(binary_ndcg_at_10(result), expected)

    def test_duplicate_results_do_not_receive_extra_credit(self):
        result = {"status": "ok", "expected": ["a", "b"], "top10": ["a", "a"]}
        self.assertAlmostEqual(binary_ndcg_at_10(result), 1 / (1 + 1 / math.log2(3)))

    def test_api_failure_is_zero_even_with_stale_results(self):
        result = {"status": "request_error", "expected": ["a"], "top10": ["a"]}
        self.assertEqual(binary_ndcg_at_10(result), 0)


if __name__ == "__main__":
    unittest.main()
