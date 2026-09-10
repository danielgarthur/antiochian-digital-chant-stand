"""Conservatively repair PDFs made from pathological image scanlines."""

from __future__ import annotations

import os
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from tempfile import NamedTemporaryFile

import pymupdf

OPTIMIZER_VERSION = 1
MIN_TOTAL_STRIPS = 512
MIN_STRIPS_PER_COLUMN = 256
MAX_COLUMNS = 8
MAX_REGION_PAGE_FRACTION = 0.40
MIN_SOURCE_DPI = 150
MAX_SOURCE_DPI = 610
RENDER_DPI_CAP = 600
# A second rasterization changes anti-aliasing around colored edges even when
# the page is visually equivalent. This still rejects missing or shifted art.
MAX_VISUAL_MEAN_DIFFERENCE = 15.0


@dataclass(frozen=True)
class ScanlineRegion:
    rect: pymupdf.Rect
    dpi: int
    strips: int
    columns: int


def _near(left: float, right: float, tolerance: float) -> bool:
    return abs(left - right) <= tolerance


def detect_pathological_scanlines(page: pymupdf.Page) -> ScanlineRegion | None:
    """Detect only dense, contiguous, one-pixel image scanline columns."""
    images = page.get_image_info(xrefs=True)
    if len(images) < MIN_TOTAL_STRIPS:
        return None

    groups: dict[tuple, list[pymupdf.Rect]] = defaultdict(list)
    for image in images:
        transform = image.get("transform", ())
        if (
            image.get("height") != 1
            or image.get("bpc") != 8
            or image.get("colorspace") not in {1, 3}
            or image.get("has-mask")
            or len(transform) != 6
            or abs(transform[1]) > 0.001
            or abs(transform[2]) > 0.001
            or transform[0] <= 0
            or transform[3] <= 0
        ):
            return None
        rect = pymupdf.Rect(image["bbox"])
        if rect.is_empty or rect.width <= 0 or rect.height <= 0:
            return None
        key = (
            image["width"],
            image["colorspace"],
            round(rect.x0, 2),
            round(rect.x1, 2),
        )
        groups[key].append(rect)

    if not 1 <= len(groups) <= MAX_COLUMNS:
        return None

    columns = []
    for (pixel_width, _colorspace, _x0, _x1), boxes in groups.items():
        if len(boxes) < MIN_STRIPS_PER_COLUMN:
            return None
        boxes.sort(key=lambda box: box.y0)
        strip_height = boxes[0].height
        tolerance = max(0.002, strip_height * 0.03)
        if any(not _near(box.height, strip_height, tolerance) for box in boxes):
            return None
        if any(
            not _near(current.y0, previous.y1, tolerance)
            for previous, current in zip(boxes, boxes[1:])
        ):
            return None
        union = pymupdf.Rect(boxes[0])
        for box in boxes[1:]:
            union |= box
        horizontal_dpi = pixel_width / union.width * 72
        vertical_dpi = len(boxes) / union.height * 72
        if (
            not MIN_SOURCE_DPI <= horizontal_dpi <= MAX_SOURCE_DPI
            or not MIN_SOURCE_DPI <= vertical_dpi <= MAX_SOURCE_DPI
            or abs(horizontal_dpi - vertical_dpi) / vertical_dpi > 0.02
        ):
            return None
        columns.append((union, len(boxes), (horizontal_dpi + vertical_dpi) / 2))

    columns.sort(key=lambda column: column[0].x0)
    first_rect, first_count, first_dpi = columns[0]
    for previous, current in zip(columns, columns[1:]):
        rect, count, dpi = current
        if (
            count != first_count
            or not _near(rect.y0, first_rect.y0, 0.02)
            or not _near(rect.y1, first_rect.y1, 0.02)
            or abs(dpi - first_dpi) / first_dpi > 0.02
            or rect.x0 - previous[0].x1 > 1
            or previous[0].x1 - rect.x0 > 1
        ):
            return None

    region = pymupdf.Rect(first_rect)
    for rect, _count, _dpi in columns[1:]:
        region |= rect
    if region.get_area() / page.rect.get_area() > MAX_REGION_PAGE_FRACTION:
        return None
    for annotation in page.annots() or ():
        if annotation.rect.intersects(region):
            return None
    # PyMuPDF deliberately omits links from page.annots(), so check them
    # separately before applying a redaction that could otherwise delete one.
    for link in page.get_links():
        link_rect = link.get("from")
        if link_rect is not None and pymupdf.Rect(link_rect).intersects(region):
            return None

    return ScanlineRegion(
        rect=region,
        dpi=min(round(first_dpi), RENDER_DPI_CAP),
        strips=len(images),
        columns=len(columns),
    )


def pathological_pages(path: Path) -> list[tuple[int, ScanlineRegion]]:
    with pymupdf.open(path) as document:
        if document.is_encrypted or document.is_form_pdf:
            return []
        return [
            (index, region)
            for index, page in enumerate(document)
            if (region := detect_pathological_scanlines(page)) is not None
        ]


def optimized_filename(path: Path) -> str:
    return f"{path.stem}-optimized-v{OPTIMIZER_VERSION}.pdf"


def _mean_sample_difference(left: pymupdf.Pixmap, right: pymupdf.Pixmap) -> float:
    if (left.width, left.height, left.n) != (right.width, right.height, right.n):
        return float("inf")
    differences = sum(abs(a - b) for a, b in zip(left.samples, right.samples))
    return differences / len(left.samples)


def _outside_rectangles(page_rect: pymupdf.Rect, region: pymupdf.Rect):
    """Partition the page outside a rectangular replacement into four clips."""
    rectangles = (
        pymupdf.Rect(page_rect.x0, page_rect.y0, page_rect.x1, region.y0),
        pymupdf.Rect(page_rect.x0, region.y1, page_rect.x1, page_rect.y1),
        pymupdf.Rect(page_rect.x0, region.y0, region.x0, region.y1),
        pymupdf.Rect(region.x1, region.y0, page_rect.x1, region.y1),
    )
    return [rectangle for rectangle in rectangles if not rectangle.is_empty]


def optimize_scanline_pdf(
    source: Path,
    destination: Path,
    detections: list[tuple[int, ScanlineRegion]] | None = None,
) -> list[dict]:
    """Write a repaired copy, returning page-level optimization details."""
    detections = detections if detections is not None else pathological_pages(source)
    if not detections:
        return []
    details = [
        {
            "page": index + 1,
            "strips": region.strips,
            "columns": region.columns,
            "dpi": region.dpi,
        }
        for index, region in detections
    ]
    if destination.is_file():
        return details

    temporary_path = None
    try:
        with pymupdf.open(source) as document:
            original_page_count = document.page_count
            original_rects = [tuple(page.rect) for page in document]
            reference_pixmaps = {}
            outside_pixmaps = {}
            for index, region in detections:
                page = document[index]
                reference_pixmaps[index] = page.get_pixmap(
                    matrix=pymupdf.Matrix(144 / 72, 144 / 72),
                    clip=region.rect,
                    alpha=False,
                )
                outside_pixmaps[index] = [
                    (
                        rectangle,
                        page.get_pixmap(
                            matrix=pymupdf.Matrix(144 / 72, 144 / 72),
                            clip=rectangle,
                            alpha=False,
                        ),
                    )
                    for rectangle in _outside_rectangles(page.rect, region.rect)
                ]
                artwork = page.get_pixmap(
                    matrix=pymupdf.Matrix(region.dpi / 72, region.dpi / 72),
                    clip=region.rect,
                    alpha=False,
                ).tobytes("png")
                page.add_redact_annot(region.rect, fill=(1, 1, 1))
                page.apply_redactions(
                    images=pymupdf.PDF_REDACT_IMAGE_REMOVE_UNLESS_INVISIBLE,
                    graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,
                    text=pymupdf.PDF_REDACT_TEXT_REMOVE,
                )
                page.insert_image(
                    region.rect,
                    stream=artwork,
                    keep_proportion=False,
                    overlay=True,
                )

            destination.parent.mkdir(parents=True, exist_ok=True)
            with NamedTemporaryFile(
                dir=destination.parent,
                prefix=f".{destination.name}.",
                suffix=".tmp.pdf",
                delete=False,
            ) as temporary:
                temporary_path = Path(temporary.name)
            document.save(temporary_path, garbage=4, deflate=True)

        with pymupdf.open(temporary_path) as optimized:
            if optimized.page_count != original_page_count:
                raise ValueError("optimized PDF page count changed")
            if [tuple(page.rect) for page in optimized] != original_rects:
                raise ValueError("optimized PDF page geometry changed")
            for index, region in detections:
                page = optimized[index]
                remaining = page.get_image_info(xrefs=True)
                if len(remaining) >= region.strips:
                    raise ValueError("scanline images were not consolidated")
                rendered = page.get_pixmap(
                    matrix=pymupdf.Matrix(144 / 72, 144 / 72),
                    clip=region.rect,
                    alpha=False,
                )
                difference = _mean_sample_difference(reference_pixmaps[index], rendered)
                if difference > MAX_VISUAL_MEAN_DIFFERENCE:
                    raise ValueError(
                        f"optimized page {index + 1} visual difference {difference:.3f} is too large"
                    )
                for rectangle, reference in outside_pixmaps[index]:
                    rendered_outside = page.get_pixmap(
                        matrix=pymupdf.Matrix(144 / 72, 144 / 72),
                        clip=rectangle,
                        alpha=False,
                    )
                    if _mean_sample_difference(reference, rendered_outside) != 0:
                        raise ValueError(
                            f"optimized page {index + 1} changed content outside the scanline region"
                        )
        os.replace(temporary_path, destination)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    return details
