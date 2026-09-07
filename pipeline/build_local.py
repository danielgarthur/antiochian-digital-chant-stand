#!/usr/bin/env python3
"""Run a local build using the API credential published by antiochian.org."""

from __future__ import annotations

import ast
import os
import re
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import requests

import build_library

SITE_PAGE_URL = f"{build_library.ANTIOCHIAN_BASE_URL}/liturgicday"
CLIENT_ID_RE = re.compile(
    rf'["\']?clientId["\']?\s*:\s*["\']{re.escape(build_library.ANTIOCHIAN_CLIENT_ID)}["\']'
)
CLIENT_SECRET_RE = re.compile(
    r'["\']?clientSecret["\']?\s*:\s*'
    r'(?P<literal>"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\')'
)


class ScriptReferencesParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.base_href: str | None = None
        self.script_sources: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag.casefold() == "base" and attributes.get("href"):
            self.base_href = attributes["href"]
        elif tag.casefold() == "script" and attributes.get("src"):
            self.script_sources.append(attributes["src"])


def extract_client_secret(javascript: str) -> str | None:
    """Extract the secret only when it is adjacent to the expected client ID."""
    for client_id in CLIENT_ID_RE.finditer(javascript):
        match = CLIENT_SECRET_RE.search(javascript, client_id.end(), client_id.end() + 1000)
        if not match:
            continue
        try:
            secret = ast.literal_eval(match.group("literal"))
        except (SyntaxError, ValueError):
            continue
        if isinstance(secret, str) and secret:
            return secret
    return None


def fetch_client_secret(session: requests.Session | None = None) -> str:
    """Find the current credential in the site's same-origin JavaScript bundles."""
    session = session or requests.Session()
    session.headers.setdefault("User-Agent", "antiochian-chant-library-local-dev/1.0")
    response = session.get(SITE_PAGE_URL, timeout=30)
    response.raise_for_status()

    parser = ScriptReferencesParser()
    parser.feed(response.text)
    document_base = urljoin(SITE_PAGE_URL, parser.base_href or "")
    site_origin = urlparse(build_library.ANTIOCHIAN_BASE_URL).netloc

    for source in parser.script_sources:
        script_url = urljoin(document_base, source)
        if urlparse(script_url).netloc != site_origin:
            continue
        script_response = session.get(script_url, timeout=60)
        script_response.raise_for_status()
        secret = extract_client_secret(script_response.text)
        if secret:
            return secret

    raise RuntimeError(
        "Could not find the Antiochian API client credential in the site's JavaScript bundles"
    )


def main() -> None:
    print("Discovering the current Antiochian API credential for this local build...")
    os.environ[build_library.ANTIOCHIAN_CLIENT_SECRET_ENV] = fetch_client_secret()
    build_library.main()


if __name__ == "__main__":
    main()
