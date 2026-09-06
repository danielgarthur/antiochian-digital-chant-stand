#!/usr/bin/env python3
"""Extract ordered, grouped music links from an Antiochian service PDF."""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import unquote, urlparse

import pymupdf as fitz

DEFAULT_AUTHOR = "Default"


def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def intersecting_text(page: fitz.Page, rect: fitz.Rect) -> str:
    """Return words touched by a link annotation, in reading order."""
    hits: list[tuple[float, float, str]] = []
    for x0, y0, x1, y1, word, *_ in page.get_text("words"):
        word_mid_y = (y0 + y1) / 2
        overlaps_horizontally = x1 >= rect.x0 - 1 and x0 <= rect.x1 + 1
        if rect.y0 - 0.5 <= word_mid_y <= rect.y1 + 0.5 and overlaps_horizontally:
            hits.append((y0, x0, word))
    hits.sort()
    return normalize_space(" ".join(word for _, _, word in hits))


def nearest_line(page: fitz.Page, rect: fitz.Rect) -> str:
    """Find the text line at the link's vertical position."""
    link_mid_y = (rect.y0 + rect.y1) / 2
    candidates: list[tuple[float, float, str]] = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            text = normalize_space(
                "".join(span.get("text", "") for span in line.get("spans", []))
            )
            if not text:
                continue
            line_rect = fitz.Rect(line["bbox"])
            vertical_distance = abs((line_rect.y0 + line_rect.y1) / 2 - link_mid_y)
            vertical_penalty = 0 if line_rect.y0 <= link_mid_y <= line_rect.y1 else 100
            link_mid_x = (rect.x0 + rect.x1) / 2
            horizontal_penalty = 0 if line_rect.x0 <= link_mid_x <= line_rect.x1 else 50
            penalty = vertical_penalty + horizontal_penalty
            candidates.append((penalty + vertical_distance, line_rect.x0, text))
    return min(candidates, default=(0, 0, "Untitled"))[2]


def previous_line(page: fitz.Page, rect: fitz.Rect) -> str:
    """Return the closest line above a settings-only line."""
    candidates: list[tuple[float, str]] = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            line_rect = fitz.Rect(line["bbox"])
            gap = rect.y0 - line_rect.y1
            if gap < -0.5 or gap > 40:
                continue
            text = normalize_space(
                "".join(span.get("text", "") for span in line.get("spans", []))
            )
            if text:
                candidates.append((gap, text))
    return min(candidates, default=(0, "Untitled"))[1]


def clean_author(link_text: str) -> str:
    """Convert ``(KAZAN)`` to ``KAZAN``; use Default otherwise."""
    match = re.search(r"\(([^()]+)\)", normalize_space(link_text))
    if not match:
        return DEFAULT_AUTHOR
    author = match.group(1).strip()
    if author.startswith("**") or any(character.islower() for character in author):
        return DEFAULT_AUTHOR
    return author or DEFAULT_AUTHOR


def clean_title(heading: str) -> str:
    """Remove linked setting labels from the end of a heading."""
    title = normalize_space(heading)
    while True:
        cleaned = re.sub(r"\s*\([^()]*\)\s*$", "", title).strip()
        if cleaned == title:
            return title or "Untitled"
        title = cleaned


def is_pdf_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme in {"http", "https"} and unquote(parsed.path).lower().endswith(".pdf")


def extract_entries(pdf_path: Path) -> list[dict]:
    """Return links in the order their annotations occur in the service PDF."""
    entries: list[dict] = []
    with fitz.open(pdf_path) as document:
        for page_number, page in enumerate(document, start=1):
            links = sorted(
                page.get_links(),
                key=lambda link: (
                    fitz.Rect(link.get("from", (0, 0, 0, 0))).y0,
                    fitz.Rect(link.get("from", (0, 0, 0, 0))).x0,
                ),
            )
            for link in links:
                source_url = link.get("uri", "")
                if not is_pdf_url(source_url):
                    continue
                rect = fitz.Rect(link["from"])
                title = clean_title(nearest_line(page, rect))
                if title == "Untitled":
                    title = clean_title(previous_line(page, rect))
                entries.append(
                    {
                        "title": title,
                        "author": clean_author(intersecting_text(page, rect)),
                        "sourceUrl": source_url,
                        "page": page_number,
                        # Settings for one piece are separate annotations on the
                        # same printed line.  Retain their vertical position so
                        # grouping can distinguish a later occurrence with the
                        # same title (and even the same linked PDF).
                        "top": rect.y0,
                    }
                )
    return entries


def group_entries(entries: list[dict]) -> list[dict]:
    """Group settings for each printed occurrence, preserving service order."""
    grouped: list[dict] = []
    current_key: str | None = None
    current_page: int | None = None
    current_top: float | None = None
    seen_links: set[tuple[str, str]] = set()
    for entry in entries:
        title = entry["title"]
        key = normalize_space(title).casefold()
        page = entry.get("page")
        top = entry.get("top")
        same_printed_line = (
            key == current_key
            and (
                page is None
                or top is None
                or current_page is None
                or current_top is None
                or (page == current_page and abs(top - current_top) <= 2)
            )
        )
        if not same_printed_line:
            grouped.append({"title": title, "links": []})
            current_key = key
            current_page = page
            current_top = top
            seen_links = set()
        link_key = (entry["author"].casefold(), entry["sourceUrl"])
        if link_key in seen_links:
            continue
        seen_links.add(link_key)
        grouped[-1]["links"].append(
            {"author": entry["author"], "sourceUrl": entry["sourceUrl"]}
        )
    return grouped
