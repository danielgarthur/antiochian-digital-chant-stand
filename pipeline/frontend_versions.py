"""Generate content-version query parameters for editable frontend assets."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = ROOT / "docs"


def short_file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()[:12]


def version_asset_reference(text: str, asset: str, version: str) -> str:
    """Add or replace a simple content-version query on a local asset URL."""
    pattern = rf"({re.escape(asset)})(?:\?v=[a-f0-9]+)?"
    return re.sub(pattern, rf"\g<1>?v={version}", text)


def update_frontend_versions() -> None:
    """Cache-bust editable frontend files while retaining readable filenames."""
    viewer_path = DOCS_DIR / "js" / "pdf-viewer.js"
    app_path = DOCS_DIR / "js" / "app.js"
    css_path = DOCS_DIR / "css" / "site.css"
    index_path = DOCS_DIR / "index.html"

    # Module imports have their own cache keys, so version the dependency before
    # hashing the entry module that imports it.
    viewer_version = short_file_hash(viewer_path)
    app_text = version_asset_reference(
        app_path.read_text(encoding="utf-8"), "./pdf-viewer.js", viewer_version
    )
    app_path.write_text(app_text, encoding="utf-8")

    index_text = index_path.read_text(encoding="utf-8")
    index_text = version_asset_reference(index_text, "./css/site.css", short_file_hash(css_path))
    index_text = version_asset_reference(index_text, "./js/app.js", short_file_hash(app_path))
    index_path.write_text(index_text, encoding="utf-8")
