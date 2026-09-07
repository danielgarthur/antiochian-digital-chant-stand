import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import frontend_versions
from serve_local import should_disable_cache


class FrontendVersionTests(unittest.TestCase):
    def test_updates_frontend_asset_versions(self):
        with TemporaryDirectory() as directory:
            docs = Path(directory)
            (docs / "css").mkdir()
            (docs / "js").mkdir()
            (docs / "css" / "site.css").write_text("new styles", encoding="utf-8")
            (docs / "js" / "pdf-viewer.js").write_text("new viewer", encoding="utf-8")
            (docs / "js" / "app.js").write_text(
                'import "./pdf-viewer.js?v=deadbeef";\nnew app', encoding="utf-8"
            )
            (docs / "index.html").write_text(
                '<link href="./css/site.css?v=deadbeef"><script src="./js/app.js?v=deadbeef"></script>',
                encoding="utf-8",
            )

            with patch.object(frontend_versions, "DOCS_DIR", docs):
                frontend_versions.update_frontend_versions()

            app = (docs / "js" / "app.js").read_text(encoding="utf-8")
            index = (docs / "index.html").read_text(encoding="utf-8")
            self.assertIn(
                f'./pdf-viewer.js?v={frontend_versions.short_file_hash(docs / "js" / "pdf-viewer.js")}',
                app,
            )
            self.assertIn(
                f'./css/site.css?v={frontend_versions.short_file_hash(docs / "css" / "site.css")}',
                index,
            )
            self.assertIn(
                f'./js/app.js?v={frontend_versions.short_file_hash(docs / "js" / "app.js")}',
                index,
            )

    def test_dev_cache_policy_targets_editable_assets_only(self):
        for path in ("/", "/index.html", "/css/site.css?v=1", "/js/app.js?v=1", "/data/music.json"):
            with self.subTest(path=path):
                self.assertTrue(should_disable_cache(path))
        for path in ("/pdfs/music.pdf", "/services/orthros.pdf", "/vendor/pdfjs/pdf.min.mjs"):
            with self.subTest(path=path):
                self.assertFalse(should_disable_cache(path))


if __name__ == "__main__":
    unittest.main()
