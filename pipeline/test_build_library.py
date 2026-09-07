import argparse
import hashlib
import io
import json
import unittest
from contextlib import redirect_stderr
from datetime import date, datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import Mock, patch

import build_library
import requests


class BuildLibraryTests(unittest.TestCase):
    def test_manual_build_ignores_cached_api_downloads(self):
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
                "Sep 06 2026 ORTHROS.pdf",
                "Manual music.pdf",
                "api-service-2026-09-05-deadbeef.pdf",
                "api-service-2026-09-06-deadbeef-Sep 06 2026 READ.pdf",
            ):
                (input_dir / filename).write_bytes(b"%PDF")

            args = argparse.Namespace(
                start=None,
                end=None,
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
                patch.object(build_library, "download_service_pdfs") as download_services,
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
                [(service["date"], service["type"], service["label"]) for service in services],
                [
                    ("2026-09-06", "ORTHROS", "Orthros"),
                    (None, "OTHER", "Manual music"),
                ],
            )
            download_services.assert_not_called()

    def test_ranged_build_keeps_in_range_manual_inputs_and_deduplicates_api_services(self):
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
                "Sep 06 2026 VESP.pdf",
                "Sep 06 2026 ORTHROS.pdf",
                "Sep 06 2026 READ.pdf",
                "Manual music.pdf",
                "api-service-2026-09-06-deadbeef-festal-orthros.pdf",
                "api-service-2026-09-06-feedface-great-vespers.pdf",
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
                patch.object(
                    build_library,
                    "download_service_pdfs",
                    return_value=[
                        {
                            "date": "2026-09-06",
                            "type": "FESTAL_ORTHROS",
                            "label": "Festal Orthros",
                            "path": input_dir / "api-service-2026-09-06-deadbeef-festal-orthros.pdf",
                            "order": 0,
                        },
                        {
                            "date": "2026-09-06",
                            "type": "GREAT_VESPERS",
                            "label": "Great Vespers",
                            "path": input_dir / "api-service-2026-09-06-feedface-great-vespers.pdf",
                            "order": 0,
                        },
                    ],
                ),
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
                [
                    ("2026-09-06", "FESTAL_ORTHROS"),
                    ("2026-09-06", "GREAT_VESPERS"),
                    ("2026-09-06", "READ"),
                    (None, "OTHER"),
                ],
            )

    def test_api_pdf_services_filters_non_pdfs_and_preserves_all_pdf_labels(self):
        payload = [
            {
                "publicUrl": "https://example.com/Abbr.pdf",
                "typeOfService": "Abbreviated Rubrics (PDF)",
            },
            {
                "publicUrl": "https://example.com/Bilingual%20ORTHROS.PDF?version=1",
                "typeOfService": "Bilingual - Sunday Orthros (PDF)",
            },
            {
                "publicUrl": "https://example.com/ORTHROS.pdf",
                "typeOfService": "Sunday Orthros (PDF)",
            },
            {
                "publicUrl": "https://example.com/ORTHROS.rtf",
                "typeOfService": "Sunday Orthros (RTF)",
            },
        ]

        self.assertEqual(
            build_library.api_pdf_services(payload),
            [
                {
                    "url": "https://example.com/Abbr.pdf",
                    "label": "Abbreviated Rubrics",
                    "type": "ABBREVIATED_RUBRICS",
                },
                {
                    "url": "https://example.com/Bilingual%20ORTHROS.PDF?version=1",
                    "label": "Bilingual - Sunday Orthros",
                    "type": "BILINGUAL_SUNDAY_ORTHROS",
                },
                {
                    "url": "https://example.com/ORTHROS.pdf",
                    "label": "Sunday Orthros",
                    "type": "ORTHROS",
                },
            ],
        )

    def test_access_token_uses_client_credentials_without_persisting_bearer_header(self):
        response = Mock()
        response.json.return_value = {"access_token": "short-lived-token"}
        session = Mock()
        session.post.return_value = response

        with patch.dict("os.environ", {"ANTIOCHIAN_CLIENT_SECRET": "configured-secret"}):
            token = build_library.antiochian_access_token(session)

        self.assertEqual(token, "short-lived-token")
        session.post.assert_called_once_with(
            "https://www.antiochian.org/connect/token",
            data={
                "client_id": "antiochian_api",
                "client_secret": "configured-secret",
                "grant_type": "client_credentials",
            },
            timeout=30,
        )

    def test_download_service_pdfs_uses_api_as_manifest_and_ignores_rtf(self):
        with TemporaryDirectory() as directory:
            input_dir = Path(directory)
            api_response = Mock()
            api_response.json.return_value = [
                {
                    "publicUrl": "https://files.example/Sept%2013%20LITART.pdf",
                    "typeOfService": "Litia/Artoklasia (PDF)",
                },
                {
                    "publicUrl": "https://files.example/Sept%2013%20LITART.rtf",
                    "typeOfService": "Litia/Artoklasia (RTF)",
                },
            ]
            pdf_response = Mock()
            pdf_response.content = b"%PDF downloaded\n%%EOF\n"
            session = Mock()
            session.get.side_effect = [api_response, pdf_response]

            with (
                patch.object(build_library, "INPUT_DIR", input_dir),
                patch.object(build_library, "antiochian_access_token", return_value="token"),
            ):
                services = build_library.download_service_pdfs(
                    session, date(2026, 9, 13), date(2026, 9, 13), refresh=False
                )

            self.assertEqual(len(services), 1)
            self.assertEqual(services[0]["label"], "Litia/Artoklasia")
            self.assertEqual(services[0]["date"], "2026-09-13")
            self.assertTrue(services[0]["path"].name.startswith("api-service-2026-09-13-"))
            self.assertEqual(session.get.call_count, 2)
            session.get.assert_any_call(
                "https://www.antiochian.org/api/antiochian/LiturgicalTexts/2026-09-13",
                headers={"Authorization": "Bearer token"},
                timeout=30,
            )

    def test_download_service_pdfs_skips_failed_and_non_pdf_downloads(self):
        with TemporaryDirectory() as directory:
            input_dir = Path(directory)
            api_response = Mock()
            api_response.json.return_value = [
                {"publicUrl": "https://files.example/missing.pdf", "typeOfService": "Missing (PDF)"},
                {"publicUrl": "https://files.example/html.pdf", "typeOfService": "HTML (PDF)"},
                {"publicUrl": "https://files.example/good.pdf", "typeOfService": "Good (PDF)"},
            ]
            failed_response = Mock()
            failed_response.raise_for_status.side_effect = requests.HTTPError("404 Not Found")
            malformed_response = Mock()
            malformed_response.content = b"<!doctype html>"
            good_response = Mock()
            good_response.content = b"%PDF valid\n%%EOF\n"
            session = Mock()
            session.get.side_effect = [
                api_response,
                failed_response,
                malformed_response,
                good_response,
            ]

            errors = io.StringIO()
            with (
                patch.object(build_library, "INPUT_DIR", input_dir),
                patch.object(build_library, "antiochian_access_token", return_value="token"),
                redirect_stderr(errors),
            ):
                services = build_library.download_service_pdfs(
                    session, date(2026, 9, 13), date(2026, 9, 13), refresh=False
                )

            self.assertEqual([service["label"] for service in services], ["Good"])
            self.assertEqual([path.name for path in input_dir.glob("*.pdf")], [services[0]["path"].name])
            self.assertIn("missing.pdf: 404 Not Found", errors.getvalue())
            self.assertIn("html.pdf: response was not a complete PDF", errors.getvalue())

    def test_download_service_pdfs_replaces_an_incomplete_cached_download(self):
        with TemporaryDirectory() as directory:
            input_dir = Path(directory)
            source_url = "https://files.example/orthros.pdf"
            url_digest = hashlib.sha256(source_url.encode()).hexdigest()[:8]
            destination = input_dir / (
                f"api-service-2026-09-13-{url_digest}-orthros.pdf"
            )
            destination.write_bytes(b"%PDF interrupted before trailer")
            api_response = Mock()
            api_response.json.return_value = [
                {"publicUrl": source_url, "typeOfService": "Sunday Orthros (PDF)"}
            ]
            pdf_response = Mock()
            pdf_response.content = b"%PDF replacement\n%%EOF\n"
            session = Mock()
            session.get.side_effect = [api_response, pdf_response]

            with (
                patch.object(build_library, "INPUT_DIR", input_dir),
                patch.object(build_library, "antiochian_access_token", return_value="token"),
            ):
                services = build_library.download_service_pdfs(
                    session, date(2026, 9, 13), date(2026, 9, 13), refresh=False
                )

            self.assertEqual([service["label"] for service in services], ["Sunday Orthros"])
            self.assertEqual(destination.read_bytes(), b"%PDF replacement\n%%EOF\n")
            self.assertEqual(list(input_dir.glob(".*.tmp")), [])

    def test_atomic_write_preserves_destination_if_replacement_fails(self):
        with TemporaryDirectory() as directory:
            destination = Path(directory) / "cached.pdf"
            destination.write_bytes(b"original")

            with (
                patch.object(build_library.os, "replace", side_effect=OSError("replace failed")),
                self.assertRaisesRegex(OSError, "replace failed"),
            ):
                build_library.atomic_write(destination, b"replacement")

            self.assertEqual(destination.read_bytes(), b"original")
            self.assertEqual(list(Path(directory).glob(".*.tmp")), [])

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

    def test_pdfjs_matching_version_and_complete_files_are_reused(self):
        with TemporaryDirectory() as directory:
            docs_dir = Path(directory) / "docs"
            vendor_dir = docs_dir / "vendor" / "pdfjs"
            vendor_dir.mkdir(parents=True)
            (vendor_dir / build_library.PDFJS_VERSION_FILE).write_text(
                build_library.PDFJS_VERSION + "\n", encoding="utf-8"
            )
            for filename in build_library.PDFJS_FILES:
                (vendor_dir / filename).write_bytes(filename.encode())
            session = Mock()

            with patch.object(build_library, "DOCS_DIR", docs_dir):
                build_library.ensure_pdfjs(session)

            session.get.assert_not_called()

    def test_pdfjs_version_change_replaces_the_complete_release(self):
        with TemporaryDirectory() as directory:
            docs_dir = Path(directory) / "docs"
            vendor_dir = docs_dir / "vendor" / "pdfjs"
            vendor_dir.mkdir(parents=True)
            (vendor_dir / build_library.PDFJS_VERSION_FILE).write_text(
                "older-version\n", encoding="utf-8"
            )
            for filename in build_library.PDFJS_FILES:
                (vendor_dir / filename).write_bytes(b"old")
            responses = []
            for filename in build_library.PDFJS_FILES:
                response = Mock()
                response.content = f"new {filename}".encode()
                responses.append(response)
            session = Mock()
            session.get.side_effect = responses

            with patch.object(build_library, "DOCS_DIR", docs_dir):
                build_library.ensure_pdfjs(session)

            self.assertEqual(session.get.call_count, len(build_library.PDFJS_FILES))
            for filename in build_library.PDFJS_FILES:
                self.assertEqual((vendor_dir / filename).read_bytes(), f"new {filename}".encode())
            self.assertEqual(
                (vendor_dir / build_library.PDFJS_VERSION_FILE).read_text(encoding="utf-8"),
                build_library.PDFJS_VERSION + "\n",
            )

    def test_pdfjs_failed_upgrade_keeps_the_existing_release_and_version(self):
        with TemporaryDirectory() as directory:
            docs_dir = Path(directory) / "docs"
            vendor_dir = docs_dir / "vendor" / "pdfjs"
            vendor_dir.mkdir(parents=True)
            version_path = vendor_dir / build_library.PDFJS_VERSION_FILE
            version_path.write_text("older-version\n", encoding="utf-8")
            for filename in build_library.PDFJS_FILES:
                (vendor_dir / filename).write_bytes(f"old {filename}".encode())
            first_response = Mock()
            first_response.content = b"new first file"
            failed_response = Mock()
            failed_response.raise_for_status.side_effect = RuntimeError("download failed")
            session = Mock()
            session.get.side_effect = [first_response, failed_response]

            with (
                patch.object(build_library, "DOCS_DIR", docs_dir),
                self.assertRaisesRegex(RuntimeError, "download failed"),
            ):
                build_library.ensure_pdfjs(session)

            self.assertEqual(version_path.read_text(encoding="utf-8"), "older-version\n")
            for filename in build_library.PDFJS_FILES:
                self.assertEqual(
                    (vendor_dir / filename).read_bytes(), f"old {filename}".encode()
                )


if __name__ == "__main__":
    unittest.main()
