import argparse
import json
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

import build_library


class BuildLibraryTests(unittest.TestCase):
    def test_ranged_build_excludes_other_dated_inputs_but_keeps_undated_inputs(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            input_dir = root / "input"
            data_dir = root / "docs" / "data"
            pdf_dir = root / "docs" / "pdfs"
            service_dir = root / "docs" / "services"
            music_cache_dir = root / "music-cache"
            for path in (input_dir, data_dir, pdf_dir, service_dir, music_cache_dir):
                path.mkdir(parents=True)
            for filename in (
                "Sep 05 2026 VESP.pdf",
                "Sep 06 2026 ORTHROS.pdf",
                "Manual music.pdf",
            ):
                (input_dir / filename).write_bytes(b"%PDF")

            args = argparse.Namespace(
                start=date(2026, 9, 6),
                end=date(2026, 9, 6),
                refresh_services=False,
                refresh_music=False,
            )
            with (
                patch.object(build_library, "INPUT_DIR", input_dir),
                patch.object(build_library, "DOCS_DIR", root / "docs"),
                patch.object(build_library, "DATA_DIR", data_dir),
                patch.object(build_library, "PDF_DIR", pdf_dir),
                patch.object(build_library, "SERVICE_PDF_DIR", service_dir),
                patch.object(build_library, "MUSIC_CACHE_DIR", music_cache_dir),
                patch.object(build_library, "download_service_pdfs"),
                patch.object(build_library, "load_cache", return_value={"version": 2, "music": {}}),
                patch.object(build_library, "save_cache"),
                patch.object(build_library, "extract_entries", return_value=[]),
                patch.object(build_library, "group_entries", return_value=[]),
                patch.object(
                    build_library,
                    "publish_service_pdf",
                    side_effect=lambda path: f"services/{path.stem}.pdf",
                ),
                patch.object(build_library, "ensure_pdfjs"),
                patch.object(build_library, "update_frontend_versions"),
            ):
                build_library.build(args)

            services = json.loads((data_dir / "music.json").read_text())["services"]
            self.assertEqual(
                [(service["date"], service["type"]) for service in services],
                [("2026-09-06", "ORTHROS"), (None, "OTHER")],
            )

    def test_prune_published_pdfs_keeps_only_manifest_references(self):
        with TemporaryDirectory() as directory:
            docs_dir = Path(directory)
            pdf_dir = docs_dir / "pdfs"
            service_dir = docs_dir / "services"
            pdf_dir.mkdir()
            service_dir.mkdir()
            for path in (
                pdf_dir / "keep.pdf",
                pdf_dir / "obsolete.pdf",
                service_dir / "keep.pdf",
                service_dir / "obsolete.pdf",
            ):
                path.write_bytes(b"%PDF")
            services = [
                {
                    "url": "services/keep.pdf",
                    "music": [{"links": [{"url": "pdfs/keep.pdf"}]}],
                }
            ]

            with (
                patch.object(build_library, "DOCS_DIR", docs_dir),
                patch.object(build_library, "PDF_DIR", pdf_dir),
                patch.object(build_library, "SERVICE_PDF_DIR", service_dir),
            ):
                build_library.prune_published_pdfs(services)

            self.assertTrue((pdf_dir / "keep.pdf").exists())
            self.assertTrue((service_dir / "keep.pdf").exists())
            self.assertFalse((pdf_dir / "obsolete.pdf").exists())
            self.assertFalse((service_dir / "obsolete.pdf").exists())

    def test_cached_music_is_published_without_a_network_request(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            music_cache_dir = root / "music-cache"
            pdf_dir = root / "docs" / "pdfs"
            music_cache_dir.mkdir()
            pdf_dir.mkdir(parents=True)
            cached_pdf = music_cache_dir / "cached.pdf"
            cached_pdf.write_bytes(b"%PDF cached")
            cache = {
                "version": 2,
                "music": {
                    "https://example.com/music.pdf": {
                        "filename": "cached.pdf",
                        "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    }
                },
            }
            session = Mock()

            with (
                patch.object(build_library, "MUSIC_CACHE_DIR", music_cache_dir),
                patch.object(build_library, "PDF_DIR", pdf_dir),
            ):
                url = build_library.download_music(
                    session, "https://example.com/music.pdf", cache, refresh=False
                )

            self.assertEqual(url, "pdfs/cached.pdf")
            self.assertEqual((pdf_dir / "cached.pdf").read_bytes(), b"%PDF cached")
            session.get.assert_not_called()


if __name__ == "__main__":
    unittest.main()
