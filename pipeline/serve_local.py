#!/usr/bin/env python3
"""Serve the generated site locally without stale frontend assets."""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

try:
    from .frontend_versions import DOCS_DIR, update_frontend_versions
except ImportError:
    from frontend_versions import DOCS_DIR, update_frontend_versions


def should_disable_cache(request_path: str) -> bool:
    path = urlsplit(request_path).path
    return path == "/" or path.endswith(".html") or path.startswith(("/css/", "/js/", "/data/"))


class DevelopmentRequestHandler(SimpleHTTPRequestHandler):
    """Disable caching for files edited or regenerated during development."""

    def end_headers(self) -> None:
        if should_disable_cache(self.path):
            self.send_header("Cache-Control", "no-store, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.send_header("Expires", "0")
        super().end_headers()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="0.0.0.0", help="address to bind (default: all interfaces)")
    parser.add_argument("--port", type=int, default=8000, help="port to serve (default: 8000)")
    args = parser.parse_args()

    update_frontend_versions()
    handler = partial(DevelopmentRequestHandler, directory=str(DOCS_DIR))
    server = ThreadingHTTPServer((args.bind, args.port), handler)
    display_host = "localhost" if args.bind in {"0.0.0.0", "::"} else args.bind
    print(f"Serving {DOCS_DIR} at http://{display_host}:{args.port}/ (frontend cache disabled)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
