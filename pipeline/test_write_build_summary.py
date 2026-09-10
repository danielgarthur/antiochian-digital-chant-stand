import unittest

from write_build_summary import markdown_summary


class WriteBuildSummaryTests(unittest.TestCase):
    def test_summary_lists_optimized_and_missing_pdfs(self):
        summary = markdown_summary(
            {
                "optimizedFiles": [
                    {
                        "original": "pdfs/original.pdf",
                        "optimized": "pdfs/optimized.pdf",
                        "pages": [{"page": 5, "strips": 3156}],
                    }
                ],
                "missingFiles": [
                    {"kind": "music", "label": "missing.pdf", "reason": "404"}
                ],
                "optimizationErrors": [],
            }
        )

        self.assertIn("Optimized PDFs: **1**", summary)
        self.assertIn("page 5 (3156 scanline images)", summary)
        self.assertIn("missing.pdf - 404", summary)


if __name__ == "__main__":
    unittest.main()
