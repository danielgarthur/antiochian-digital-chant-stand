# Antiochian Digital Chant Stand

A small, static, touch-friendly website that displays the liturgical notes and music used by the Antiochian Orthodox Christian Archdiocese of North America. The generated `docs/` directory can be published directly
with GitHub Pages.

## First-time setup

Python 3.10 or newer is recommended.

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Build a date range

```sh
python pipeline/build_library.py --start 2026-09-05 --end 2026-09-07
```

The range is inclusive. For just the current day:

```sh
python pipeline/build_library.py --today
```

The builder tries `VESP`, `ORTHROS`, and `READ` for each date. Missing/unpublished
services are skipped. It then extracts the music links, downloads each unique music
PDF, and writes `docs/data/music.json`.

You can also place service PDFs in `pipeline/input/` by hand and run:

```sh
python pipeline/build_library.py
```

Use the upstream filename convention, such as `Sep 06 2026 ORTHROS.pdf`, so the site
can assign the date and service. Other PDF names are still included under their own
filename as undated music.

Downloaded music is content-hashed and reused. The builder checks cached music at
most once per day and uses HTTP validators when the source server provides them.
Use `--refresh-music` or `--refresh-services` to force a check.

The builder also adds content-version query parameters to the CSS and JavaScript
references. Frontend files are cached while unchanged, but editing them and rebuilding
produces a new URL that bypasses stale tablet browser caches. JavaScript module imports
are versioned as well.

## Preview the site

Generated service PDFs, music PDFs, `music.json`, and the downloaded PDF.js files are
ignored by Git but remain on your computer. To refresh them and preview the result:

```sh
python pipeline/build_library.py --start 2026-09-05 --end 2026-09-07
python3 -m http.server 8000 --directory docs
```

Browsers do not allow the site to fetch JSON from a `file://` URL, so it must be opened
through the local server rather than by opening `index.html` directly:

Then open <http://localhost:8000>.

Run `python pipeline/validate_site.py` for the same pre-deployment validation used by
GitHub Actions.

## GitHub Pages deployment

`.github/workflows/deploy-pages.yml` builds and deploys the site without committing any
generated PDFs. It runs on pushes to `main`, can be started manually with an optional
date range, and runs each Saturday at 11:17 AM America/Chicago. Its automatic range is
yesterday through eight days ahead; unpublished service files are simply skipped.

In the repository's GitHub settings, set **Pages → Build and deployment → Source** to
**GitHub Actions**. A failed or empty build stops before deployment, leaving the last
successful site online.

## What is generated

- `docs/data/music.json` — ordered services and music metadata
- `docs/pdfs/` — content-hashed music PDFs
- `docs/services/` — content-hashed source service PDFs used by the Notes view
- `docs/vendor/pdfjs/` — the pinned PDF.js browser library
- `pipeline/.download-cache.json` — local download metadata

These are build outputs and are not stored in Git history.

The HTML, CSS, and JavaScript are ordinary hand-maintainable files. The interface
defaults to today's Orthros when available, keeps Orthros immediately before Liturgy,
and provides separate arrows for dates, services, and music within a service.
The date and service controls are collapsed by default; tap the compact current-service
line to reveal them. Selecting a service collapses them again.

When a piece has multiple settings, the site prefers `STAM`, `CROW`, `KARAM`,
`EL MASSIH`, then `CHANT`. Unlisted settings retain their order from the service PDF.
This list is named `PREFERRED_AUTHORS` near the top of `docs/js/app.js` so it is easy
to change by hand. The selected setting appears beside the piece count only when a
choice is available; tapping it opens the setting chooser.

The `Notes` button switches between the current service text and the selected music.
Every service and music PDF remembers its own reading position for the current browser
session. A PDF not previously opened starts at the top. Pages outside the nearby screen
area are released from memory so repeated switching remains practical on tablets.
