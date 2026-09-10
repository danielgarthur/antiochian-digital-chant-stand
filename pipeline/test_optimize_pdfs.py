import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import pymupdf

from optimize_pdfs import ScanlineRegion, detect_pathological_scanlines, optimize_scanline_pdf


class FakePage:
    rect = pymupdf.Rect(0, 0, 612, 792)

    def __init__(self, images, annotations=(), links=()):
        self.images = images
        self.annotations = annotations
        self.links = links

    def get_image_info(self, xrefs=True):
        return self.images

    def annots(self):
        return iter(self.annotations)

    def get_links(self):
        return self.links


def scanline_images(columns=2, rows=256, dpi=300):
    images = []
    strip_height = 72 / dpi
    pixel_width = 100
    display_width = pixel_width / dpi * 72
    for column in range(columns):
        x0 = 10 + column * display_width
        for row in range(rows):
            y0 = 20 + row * strip_height
            images.append(
                {
                    "bbox": (x0, y0, x0 + display_width, y0 + strip_height),
                    "transform": (display_width, 0, 0, strip_height, x0, y0),
                    "width": pixel_width,
                    "height": 1,
                    "colorspace": 3,
                    "bpc": 8,
                    "has-mask": False,
                    "xref": 0,
                }
            )
    return images


class OptimizePdfsTests(unittest.TestCase):
    def test_detects_contiguous_one_pixel_scanline_columns(self):
        region = detect_pathological_scanlines(FakePage(scanline_images()))

        self.assertIsNotNone(region)
        self.assertEqual(region.strips, 512)
        self.assertEqual(region.columns, 2)
        self.assertEqual(region.dpi, 300)

    def test_rejects_a_page_when_any_image_does_not_match_the_pattern(self):
        images = scanline_images()
        images[-1] = {**images[-1], "height": 2}

        self.assertIsNone(detect_pathological_scanlines(FakePage(images)))

    def test_rejects_noncontiguous_scanlines(self):
        images = scanline_images()
        shifted = list(images[100]["bbox"])
        shifted[1] += 2
        shifted[3] += 2
        images[100] = {
            **images[100],
            "bbox": tuple(shifted),
        }

        self.assertIsNone(detect_pathological_scanlines(FakePage(images)))

    def test_rejects_scanline_region_that_intersects_a_link(self):
        page = FakePage(
            scanline_images(),
            links=[{"from": pymupdf.Rect(12, 22, 20, 30), "uri": "https://example.test"}],
        )

        self.assertIsNone(detect_pathological_scanlines(page))

    def test_optimizer_writes_a_separate_valid_copy(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "source.pdf"
            destination = Path(directory) / "optimized.pdf"
            document = pymupdf.open()
            page = document.new_page(width=612, height=792)
            page.insert_text((72, 300), "Music outside the repaired artwork")
            document.save(source)
            region = ScanlineRegion(
                rect=pymupdf.Rect(72, 72, 288, 144),
                dpi=300,
                strips=512,
                columns=2,
            )

            details = optimize_scanline_pdf(source, destination, [(0, region)])

            self.assertTrue(source.is_file())
            self.assertTrue(destination.is_file())
            self.assertEqual(details[0]["page"], 1)
            with pymupdf.open(destination) as optimized:
                self.assertEqual(optimized.page_count, 1)
                self.assertIn("Music outside", optimized[0].get_text())


if __name__ == "__main__":
    unittest.main()
