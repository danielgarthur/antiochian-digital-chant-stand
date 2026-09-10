#!/usr/bin/env python3
"""Build the static chant library from local and downloaded service PDFs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from tempfile import NamedTemporaryFile, TemporaryDirectory
from urllib.parse import unquote, urlparse

import requests
import pymupdf

from extract_music_links import extract_entries, group_entries
from frontend_versions import update_frontend_versions
from optimize_pdfs import optimize_scanline_pdf, optimized_filename, pathological_pages

ROOT = Path(__file__).resolve().parents[1]
INPUT_DIR = ROOT / "pipeline" / "input"
DOCS_DIR = ROOT / "docs"
PDF_DIR = DOCS_DIR / "pdfs"
SERVICE_PDF_DIR = DOCS_DIR / "services"
DATA_DIR = DOCS_DIR / "data"
CACHE_PATH = ROOT / "pipeline" / ".download-cache.json"
MUSIC_CACHE_DIR = ROOT / "pipeline" / ".music-cache"
CACHE_VERSION = 2

SERVICE_LABELS = {"VESP": "Vespers", "ORTHROS": "Orthros", "READ": "Liturgy"}
SERVICE_RE = re.compile(
    r"(?P<date>[A-Z][a-z]{2} \d{2} \d{4})\s+(?P<type>VESP|ORTHROS|READ)\.pdf$",
    re.IGNORECASE,
)
ANTIOCHIAN_BASE_URL = "https://www.antiochian.org"
ANTIOCHIAN_CLIENT_ID = "antiochian_api"
ANTIOCHIAN_CLIENT_SECRET_ENV = "ANTIOCHIAN_CLIENT_SECRET"
API_SERVICE_CACHE_PREFIX = "api-service-"
PDFJS_VERSION = "6.2.108"
PDFJS_FILES = {
    "pdf.min.mjs": f"https://cdn.jsdelivr.net/npm/pdfjs-dist@{PDFJS_VERSION}/build/pdf.min.mjs",
    "pdf.worker.min.mjs": f"https://cdn.jsdelivr.net/npm/pdfjs-dist@{PDFJS_VERSION}/build/pdf.worker.min.mjs",
}
PDFJS_VERSION_FILE = ".version"


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


def api_service_label(type_of_service: str) -> str:
    """Remove the API's redundant file-format suffix from a display label."""
    return re.sub(r"\s*\(PDF\)\s*$", "", type_of_service, flags=re.IGNORECASE).strip()


def api_service_type(label: str) -> str:
    """Retain legacy type names where the UI has useful behavior for them."""
    legacy_types = {
        "great vespers - sunday evening": "VESP",
        "sunday orthros": "ORTHROS",
        "divine liturgy variables": "READ",
    }
    if label.casefold() in legacy_types:
        return legacy_types[label.casefold()]
    return re.sub(r"[^A-Z0-9]+", "_", label.upper()).strip("_") or "OTHER"


def canonical_service_type(service_type: str) -> str:
    """Map display-specific API types to legacy service families for deduplication."""
    bilingual = service_type.startswith("BILINGUAL_")
    unqualified = service_type.removeprefix("BILINGUAL_")
    if unqualified == "VESP" or unqualified.endswith("_VESPERS"):
        family = "VESP"
    elif unqualified == "ORTHROS" or unqualified.endswith("_ORTHROS"):
        family = "ORTHROS"
    elif unqualified in {"READ", "LITURGY"} or "DIVINE_LITURGY" in unqualified:
        family = "READ"
    else:
        family = unqualified
    return f"BILINGUAL_{family}" if bilingual else family


def api_pdf_services(payload: object) -> list[dict[str, str]]:
    """Validate and normalize the PDF entries returned by LiturgicalTexts."""
    if not isinstance(payload, list):
        raise ValueError("LiturgicalTexts response was not a list")

    services = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        url = item.get("publicUrl")
        type_of_service = item.get("typeOfService")
        if not isinstance(url, str) or not isinstance(type_of_service, str):
            continue
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.path.lower().endswith(".pdf"):
            continue
        label = api_service_label(type_of_service)
        services.append({"url": url, "label": label, "type": api_service_type(label)})
    return services


def antiochian_access_token(session: requests.Session) -> str:
    secret = os.environ.get(ANTIOCHIAN_CLIENT_SECRET_ENV)
    if not secret:
        raise SystemExit(
            f"{ANTIOCHIAN_CLIENT_SECRET_ENV} is required when downloading dated services"
        )
    response = session.post(
        f"{ANTIOCHIAN_BASE_URL}/connect/token",
        data={
            "client_id": ANTIOCHIAN_CLIENT_ID,
            "client_secret": secret,
            "grant_type": "client_credentials",
        },
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json()
    token = payload.get("access_token") if isinstance(payload, dict) else None
    if not isinstance(token, str) or not token:
        raise ValueError("token response did not contain an access_token")
    return token


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


def is_complete_pdf(content: bytes) -> bool:
    """Perform a cheap completeness check before a service PDF enters the cache."""
    return content.startswith(b"%PDF") and b"%%EOF" in content[-2048:]


def is_complete_pdf_file(path: Path) -> bool:
    try:
        return is_complete_pdf(path.read_bytes())
    except OSError:
        return False


def atomic_write(path: Path, content: bytes) -> None:
    """Durably stage content beside its destination, then replace it atomically."""
    temporary_path = None
    try:
        with NamedTemporaryFile(
            mode="wb", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def download_service_pdfs(
    session: requests.Session,
    start: date,
    end: date,
    refresh: bool,
    report: dict | None = None,
) -> list[dict]:
    """Discover service PDFs through the API and cache every advertised PDF."""
    INPUT_DIR.mkdir(parents=True, exist_ok=True)
    token = antiochian_access_token(session)
    discovered = []
    for day in dates_between(start, end):
        day_string = day.isoformat()
        response = session.get(
            f"{ANTIOCHIAN_BASE_URL}/api/antiochian/LiturgicalTexts/{day_string}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=30,
        )
        response.raise_for_status()
        services = api_pdf_services(response.json())
        print(f"Found {len(services)} PDF services for {day_string}")
        for position, service in enumerate(services):
            remote_name = unquote(urlparse(service["url"]).path).rsplit("/", 1)[-1]
            safe_name = re.sub(r"[^A-Za-z0-9_. -]+", "-", remote_name).strip(". ")
            if not safe_name:
                safe_name = f"service-{position + 1}.pdf"
            url_digest = hashlib.sha256(service["url"].encode()).hexdigest()[:8]
            destination = INPUT_DIR / (
                f"{API_SERVICE_CACHE_PREFIX}{day_string}-{url_digest}-{safe_name}"
            )
            cached_is_valid = destination.exists() and is_complete_pdf_file(destination)
            if cached_is_valid and not refresh:
                print(f"Using cached service: {destination.name}")
            else:
                if destination.exists() and not cached_is_valid:
                    print(f"Cached service is incomplete; redownloading: {destination.name}")
                print(f"Downloading {service['url']}")
                try:
                    pdf_response = session.get(service["url"], timeout=60)
                    pdf_response.raise_for_status()
                    if not is_complete_pdf(pdf_response.content):
                        raise ValueError("response was not a complete PDF")
                    atomic_write(destination, pdf_response.content)
                    print(f"  saved {destination.name}")
                except (requests.RequestException, ValueError) as error:
                    if cached_is_valid:
                        print(
                            f"Could not refresh service PDF {service['url']}; using cached copy: {error}",
                            file=sys.stderr,
                        )
                    else:
                        print(f"Skipping service PDF {service['url']}: {error}", file=sys.stderr)
                        if report is not None:
                            report["missingFiles"].append(
                                {
                                    "kind": "service",
                                    "label": service["label"],
                                    "url": service["url"],
                                    "reason": str(error),
                                }
                            )
                        continue
            discovered.append(
                {
                    "date": day_string,
                    "type": service["type"],
                    "label": service["label"],
                    "path": destination,
                    "order": position,
                }
            )
    return discovered


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


def pdf_entries(services: list[dict]):
    for service in services:
        yield service
        for piece in service["music"]:
            yield from piece["links"]


def music_pdf_entries(services: list[dict]):
    for service in services:
        for piece in service["music"]:
            yield from piece["links"]


def optimize_published_pdfs(services: list[dict], report: dict) -> None:
    """Optimize music PDFs only, retaining originals as fallbacks."""
    entries_by_url: dict[str, list[dict]] = {}
    for entry in music_pdf_entries(services):
        entries_by_url.setdefault(entry["url"], []).append(entry)

    for original_url, entries in sorted(entries_by_url.items()):
        source = DOCS_DIR / original_url
        if not source.is_file():
            continue
        try:
            detections = pathological_pages(source)
            if not detections:
                continue
            destination = source.with_name(optimized_filename(source))
            details = optimize_scanline_pdf(source, destination, detections)
        except (OSError, RuntimeError, ValueError, pymupdf.FileDataError) as error:
            print(f"Could not optimize {original_url}: {error}", file=sys.stderr)
            report["optimizationErrors"].append(
                {"original": original_url, "reason": str(error)}
            )
            continue

        optimized_url = destination.relative_to(DOCS_DIR).as_posix()
        for entry in entries:
            entry["fallbackUrl"] = original_url
            entry["url"] = optimized_url
        report_entry = {
            "original": original_url,
            "optimized": optimized_url,
            "pages": details,
        }
        report["optimizedFiles"].append(report_entry)
        page_summary = ", ".join(
            f"page {page['page']}: {page['strips']} strips -> 1 image"
            for page in details
        )
        print(f"Optimized PDF: {original_url} -> {optimized_url} ({page_summary})")


def download_music(
    session: requests.Session,
    source_url: str,
    cache: dict,
    refresh: bool,
    report: dict | None = None,
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
        if report is not None:
            report["missingFiles"].append(
                {
                    "kind": "music",
                    "label": unquote(urlparse(source_url).path).rsplit("/", 1)[-1],
                    "url": source_url,
                    "reason": str(exc),
                }
            )
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
    referenced = {
        url
        for entry in pdf_entries(services)
        for key in ("url", "fallbackUrl")
        if (url := entry.get(key))
    }
    for directory in (PDF_DIR, SERVICE_PDF_DIR):
        for path in directory.glob("*.pdf"):
            if path.relative_to(DOCS_DIR).as_posix() not in referenced:
                path.unlink()


def ensure_pdfjs(session: requests.Session) -> None:
    vendor_dir = DOCS_DIR / "vendor" / "pdfjs"
    vendor_dir.mkdir(parents=True, exist_ok=True)
    version_path = vendor_dir / PDFJS_VERSION_FILE
    try:
        installed_version = version_path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        installed_version = None
    destinations = {filename: vendor_dir / filename for filename in PDFJS_FILES}
    if installed_version == PDFJS_VERSION and all(path.is_file() for path in destinations.values()):
        return

    # Download the complete release before replacing either runtime file. The
    # marker is written last so an interrupted installation is retried.
    with TemporaryDirectory(dir=vendor_dir) as staging_directory:
        staging_dir = Path(staging_directory)
        staged_files = {}
        for filename, url in PDFJS_FILES.items():
            print(f"Downloading PDF.js {PDFJS_VERSION}: {filename}")
            response = session.get(url, timeout=90)
            response.raise_for_status()
            staged_path = staging_dir / filename
            staged_path.write_bytes(response.content)
            staged_files[filename] = staged_path
        for filename, staged_path in staged_files.items():
            staged_path.replace(destinations[filename])
    version_path.write_text(PDFJS_VERSION + "\n", encoding="utf-8")


def build(args: argparse.Namespace) -> None:
    INPUT_DIR.mkdir(parents=True, exist_ok=True)
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    SERVICE_PDF_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MUSIC_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["User-Agent"] = "antiochian-chant-library/1.0"
    report = {"optimizedFiles": [], "missingFiles": [], "optimizationErrors": []}

    build_end = args.end or args.start
    discovered_services = []
    if args.start:
        if build_end < args.start:
            raise SystemExit("--end must not be before --start")
        discovered_services = download_service_pdfs(
            session, args.start, build_end, args.refresh_services, report
        )

    cache = load_cache()
    services = []
    downloaded_this_run: dict[str, str | None] = {}
    service_sources = discovered_services
    discovered_paths = {source["path"] for source in discovered_services}
    discovered_keys = {
        (source["date"], canonical_service_type(source["type"]))
        for source in discovered_services
    }
    for source_pdf in sorted(INPUT_DIR.glob("*.pdf")):
        if source_pdf in discovered_paths:
            continue
        if source_pdf.name.startswith(API_SERVICE_CACHE_PREFIX):
            # Cached API downloads are only selected by the current API response.
            continue
        day, service_type, label = parse_service_file(source_pdf)
        if args.start and day:
            if day < args.start.isoformat() or day > build_end.isoformat():
                continue
            if (day, canonical_service_type(service_type)) in discovered_keys:
                # Prefer the current API manifest over an exact manual duplicate.
                continue
        service_sources.append(
            {
                "date": day,
                "type": service_type,
                "label": label,
                "path": source_pdf,
                "order": 999,
            }
        )

    for source in service_sources:
        source_pdf = source["path"]
        day = source["date"]
        service_type = source["type"]
        label = source["label"]
        print(f"Extracting {source_pdf.name}")
        music = group_entries(extract_entries(source_pdf))
        for piece in music:
            usable_links = []
            for link in piece["links"]:
                source_url = link["sourceUrl"]
                if source_url not in downloaded_this_run:
                    downloaded_this_run[source_url] = download_music(
                        session, source_url, cache, args.refresh_music, report
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
                "_order": source["order"],
            }
        )

    services.sort(
        key=lambda item: (
            item["date"] is None,
            item["date"] or "",
            item["_order"],
            item["label"],
        )
    )
    for service in services:
        del service["_order"]
    optimize_published_pdfs(services, report)
    payload = {"services": services}
    (DATA_DIR / "music.json").write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    prune_published_pdfs(services)
    (DATA_DIR / "build-report.json").write_text(
        json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
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
