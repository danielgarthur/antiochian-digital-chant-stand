#!/usr/bin/env python3
"""Validate generated site data before publishing it."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = ROOT / "docs"
DATA_PATH = DOCS_DIR / "data" / "music.json"


def require_site_file(relative_url: str, description: str) -> None:
    path = (DOCS_DIR / relative_url).resolve()
    if DOCS_DIR.resolve() not in path.parents or not path.is_file():
        raise SystemExit(f"Missing {description}: {relative_url}")


def main() -> None:
    try:
        data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Invalid generated library: {exc}") from exc

    services = data.get("services", [])
    if not services:
        raise SystemExit("Generated library contains no services; refusing to replace the live site")

    music_count = 0
    for service in services:
        require_site_file(service.get("url", ""), "service PDF")
        if service.get("fallbackUrl"):
            require_site_file(service["fallbackUrl"], "fallback service PDF")
        for piece in service.get("music", []):
            for link in piece.get("links", []):
                require_site_file(link.get("url", ""), "music PDF")
                if link.get("fallbackUrl"):
                    require_site_file(link["fallbackUrl"], "fallback music PDF")
                music_count += 1

    if music_count == 0:
        raise SystemExit("Generated library contains no music; refusing to replace the live site")

    for asset in (
        "index.html",
        "css/site.css",
        "js/app.js",
        "js/pdf-viewer.js",
        "vendor/pdfjs/pdf.min.mjs",
        "vendor/pdfjs/pdf.worker.min.mjs",
    ):
        require_site_file(asset, "site asset")

    print(f"Validated {len(services)} services and {music_count} music links.")


if __name__ == "__main__":
    main()
