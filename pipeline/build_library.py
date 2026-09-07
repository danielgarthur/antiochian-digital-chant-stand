#!/usr/bin/env python3
"""Build the static chant library from local and downloaded service PDFs."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

import requests

from extract_music_links import extract_entries, group_entries

ROOT = Path(__file__).resolve().parents[1]
INPUT_DIR = ROOT / "pipeline" / "input"
DOCS_DIR = ROOT / "docs"
PDF_DIR = DOCS_DIR / "pdfs"
SERVICE_PDF_DIR = DOCS_DIR / "services"
DATA_DIR = DOCS_DIR / "data"
CACHE_PATH = ROOT / "pipeline" / ".download-cache.json"
MUSIC_CACHE_DIR = ROOT / "pipeline" / ".music-cache"
CACHE_VERSION = 2

SERVICE_TYPES = ("VESP", "ORTHROS", "READ")
SERVICE_LABELS = {"VESP": "Vespers", "ORTHROS": "Orthros", "READ": "Liturgy"}
SERVICE_RE = re.compile(
    r"(?P<date>[A-Z][a-z]{2} \d{2} \d{4})\s+(?P<type>VESP|ORTHROS|READ)\.pdf$",
    re.IGNORECASE,
)
PDFJS_VERSION = "6.2.108"
PDFJS_FILES = {
    "pdf.min.mjs": f"https://cdn.jsdelivr.net/npm/pdfjs-dist@{PDFJS_VERSION}/build/pdf.min.mjs",
    "pdf.worker.min.mjs": f"https://cdn.jsdelivr.net/npm/pdfjs-dist@{PDFJS_VERSION}/build/pdf.worker.min.mjs",
}


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


def parse_date(value: str) -> date:
    for pattern in ("%Y-%m-%d", "%b %d %Y"):
        try:
            return datetime.strptime(value, pattern).date()
        except ValueError:
            pass
    raise argparse.ArgumentTypeError("use YYYY-MM-DD (for example, 2026-09-05)")


def dates_between(start: date, end: date):
    current = start
    while current <= end:
        yield current
        current += timedelta(days=1)


def service_filename(day: date, service_type: str) -> str:
    return f"{day.strftime('%b %d %Y')} {service_type}.pdf"


def service_url(day: date, service_type: str) -> str:
    return "https://antiochianprodsa.blob.core.windows.net/servicetexts/" + quote(
        service_filename(day, service_type)
    )


def load_cache() -> dict:
    try:
        cache = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {"version": CACHE_VERSION, "music": {}}
    if cache.get("version") != CACHE_VERSION:
        return {"version": CACHE_VERSION, "music": {}}
    return cache


def save_cache(cache: dict) -> None:
    CACHE_PATH.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def download_service_pdfs(
    session: requests.Session, start: date, end: date, refresh: bool
) -> None:
    INPUT_DIR.mkdir(parents=True, exist_ok=True)
    for day in dates_between(start, end):
        for service_type in SERVICE_TYPES:
            destination = INPUT_DIR / service_filename(day, service_type)
            if destination.exists() and not refresh:
                print(f"Using cached service: {destination.name}")
                continue
            url = service_url(day, service_type)
            print(f"Checking {url}")
            try:
                response = session.get(url, timeout=60)
                if response.status_code == 404:
                    print("  not published")
                    continue
                response.raise_for_status()
                if not response.content.startswith(b"%PDF"):
                    print("  skipped: response was not a PDF")
                    continue
                destination.write_bytes(response.content)
                print(f"  saved {destination.name}")
            except requests.RequestException as exc:
                print(f"  failed: {exc}", file=sys.stderr)


def parse_service_file(path: Path) -> tuple[str | None, str, str]:
    match = SERVICE_RE.search(path.name)
    if not match:
        return None, "OTHER", path.stem
    day = datetime.strptime(match.group("date"), "%b %d %Y").date().isoformat()
    service_type = match.group("type").upper()
    return day, service_type, SERVICE_LABELS[service_type]


def content_filename(source_url: str, digest: str) -> str:
    remote_name = unquote(urlparse(source_url).path).rsplit("/", 1)[-1]
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", Path(remote_name).stem).strip("-").lower()
    return f"{stem or 'music'}-{digest[:12]}.pdf"


def publish_service_pdf(source_pdf: Path) -> str:
    """Copy a source service into the site with a cache-safe filename."""
    content = source_pdf.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", source_pdf.stem).strip("-").lower()
    filename = f"{stem or 'service'}-{digest[:12]}.pdf"
    destination = SERVICE_PDF_DIR / filename
    if not destination.exists():
        destination.write_bytes(content)
    return f"services/{filename}"


def cached_music_path(record: dict) -> Path | None:
    filename = record.get("filename")
    if not isinstance(filename, str) or Path(filename).name != filename:
        return None
    path = MUSIC_CACHE_DIR / filename
    return path if path.is_file() else None


def publish_music_pdf(source: Path) -> str:
    destination = PDF_DIR / source.name
    if not destination.exists():
        shutil.copyfile(source, destination)
    return f"pdfs/{source.name}"


def download_music(
    session: requests.Session, source_url: str, cache: dict, refresh: bool
) -> str | None:
    record = cache.setdefault("music", {}).get(source_url, {})
    cached_path = cached_music_path(record)
    checked_at = record.get("checkedAt")
    if cached_path and checked_at and not refresh:
        try:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(checked_at)
            if age < timedelta(hours=24):
                return publish_music_pdf(cached_path)
        except ValueError:
            pass

    headers = {}
    if cached_path and record.get("etag"):
        headers["If-None-Match"] = record["etag"]
    if cached_path and record.get("lastModified"):
        headers["If-Modified-Since"] = record["lastModified"]
    try:
        response = session.get(source_url, headers=headers, timeout=90)
        if response.status_code == 304 and cached_path:
            record["checkedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            return publish_music_pdf(cached_path)
        response.raise_for_status()
        content = response.content
        if not content.startswith(b"%PDF"):
            raise ValueError("response was not a PDF")
    except (requests.RequestException, ValueError) as exc:
        print(f"  music download failed: {source_url}: {exc}", file=sys.stderr)
        if cached_path:
            return publish_music_pdf(cached_path)
        return None

    digest = hashlib.sha256(content).hexdigest()
    filename = content_filename(source_url, digest)
    cached_path = MUSIC_CACHE_DIR / filename
    if not cached_path.exists():
        cached_path.write_bytes(content)
    cache["music"][source_url] = {
        "filename": filename,
        "etag": response.headers.get("ETag"),
        "lastModified": response.headers.get("Last-Modified"),
        "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    return publish_music_pdf(cached_path)


def prune_published_pdfs(services: list[dict]) -> None:
    referenced = {service["url"] for service in services}
    referenced.update(
        link["url"]
        for service in services
        for piece in service["music"]
        for link in piece["links"]
    )
    for directory in (PDF_DIR, SERVICE_PDF_DIR):
        for path in directory.glob("*.pdf"):
            if path.relative_to(DOCS_DIR).as_posix() not in referenced:
                path.unlink()


def ensure_pdfjs(session: requests.Session) -> None:
    vendor_dir = DOCS_DIR / "vendor" / "pdfjs"
    vendor_dir.mkdir(parents=True, exist_ok=True)
    for filename, url in PDFJS_FILES.items():
        destination = vendor_dir / filename
        if destination.exists():
            continue
        print(f"Downloading PDF.js {PDFJS_VERSION}: {filename}")
        response = session.get(url, timeout=90)
        response.raise_for_status()
        destination.write_bytes(response.content)


def build(args: argparse.Namespace) -> None:
    INPUT_DIR.mkdir(parents=True, exist_ok=True)
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    SERVICE_PDF_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MUSIC_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["User-Agent"] = "antiochian-chant-library/1.0"

    build_end = args.end or args.start
    if args.start:
        if build_end < args.start:
            raise SystemExit("--end must not be before --start")
        download_service_pdfs(session, args.start, build_end, args.refresh_services)

    cache = load_cache()
    services = []
    downloaded_this_run: dict[str, str | None] = {}
    for source_pdf in sorted(INPUT_DIR.glob("*.pdf")):
        day, service_type, label = parse_service_file(source_pdf)
        if day and args.start and not (args.start.isoformat() <= day <= build_end.isoformat()):
            continue
        print(f"Extracting {source_pdf.name}")
        music = group_entries(extract_entries(source_pdf))
        for piece in music:
            usable_links = []
            for link in piece["links"]:
                source_url = link["sourceUrl"]
                if source_url not in downloaded_this_run:
                    downloaded_this_run[source_url] = download_music(
                        session, source_url, cache, args.refresh_music
                    )
                local_url = downloaded_this_run[source_url]
                if local_url:
                    usable_links.append({**link, "url": local_url})
            piece["links"] = usable_links
        music = [piece for piece in music if piece["links"]]
        services.append(
            {
                "date": day,
                "type": service_type,
                "label": label,
                "url": publish_service_pdf(source_pdf),
                "music": music,
            }
        )

    order = {name: index for index, name in enumerate(SERVICE_TYPES)}
    services.sort(
        key=lambda item: (
            item["date"] is None,
            item["date"] or "",
            order.get(item["type"], 99),
        )
    )
    payload = {"services": services}
    (DATA_DIR / "music.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    prune_published_pdfs(services)
    save_cache(cache)
    ensure_pdfjs(session)
    update_frontend_versions()
    print(f"Built {len(services)} services in {DATA_DIR / 'music.json'}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", type=parse_date, help="first service date (YYYY-MM-DD)")
    parser.add_argument("--end", type=parse_date, help="last service date, inclusive")
    parser.add_argument("--today", action="store_true", help="download services for today")
    parser.add_argument("--refresh-services", action="store_true", help="redownload service PDFs")
    parser.add_argument("--refresh-music", action="store_true", help="check music PDFs for changes")
    args = parser.parse_args()
    if args.today:
        args.start = args.end = date.today()
    if args.end and not args.start:
        parser.error("--end requires --start")
    build(args)


if __name__ == "__main__":
    main()
