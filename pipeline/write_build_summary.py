#!/usr/bin/env python3
"""Write the library build report to the GitHub Actions run summary."""

from __future__ import annotations

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPORT_PATH = ROOT / "docs" / "data" / "build-report.json"


def markdown_summary(report: dict) -> str:
    optimized = report.get("optimizedFiles", [])
    missing = report.get("missingFiles", [])
    errors = report.get("optimizationErrors", [])
    lines = [
        "## Chant library build report",
        "",
        f"- Optimized PDFs: **{len(optimized)}**",
        f"- Missing PDFs: **{len(missing)}**",
        f"- Optimization errors: **{len(errors)}**",
    ]
    if optimized:
        lines.extend(["", "### Optimized PDFs", ""])
        for item in optimized:
            pages = ", ".join(
                f"page {page['page']} ({page['strips']} scanline images)"
                for page in item.get("pages", [])
            )
            lines.append(
                f"- `{item['optimized']}` - {pages}; original retained as `{item['original']}`"
            )
    if missing:
        lines.extend(["", "### Missing PDFs", ""])
        for item in missing:
            lines.append(
                f"- **{item.get('kind', 'PDF')}**: {item.get('label') or item.get('url')} - "
                f"{item.get('reason', 'unavailable')}"
            )
    if errors:
        lines.extend(["", "### Optimization errors", ""])
        for item in errors:
            lines.append(f"- `{item['original']}` - {item['reason']}")
    return "\n".join(lines) + "\n"


def main() -> None:
    try:
        report = json.loads(REPORT_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as error:
        report = {
            "optimizedFiles": [],
            "missingFiles": [],
            "optimizationErrors": [
                {"original": "build report", "reason": f"unavailable: {error}"}
            ],
        }
    summary = markdown_summary(report)
    print(summary, end="")
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with Path(summary_path).open("a", encoding="utf-8") as output:
            output.write(summary)


if __name__ == "__main__":
    main()
