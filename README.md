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

The range is inclusive. When a range is supplied, recognized dated service PDFs
outside that range are excluded from the generated library, even if they remain in
`pipeline/input/` from an earlier run. Undated manual inputs are still included. For
just the current day:

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

Downloaded music is content-hashed and retained separately in
`pipeline/.music-cache/` for reuse. The builder checks cached music at most once per
day and uses HTTP validators when the source server provides them. Published PDFs in
`docs/` are pruned to exactly those referenced by the current library; pruning them
does not discard the download cache. Use `--refresh-music` or `--refresh-services` to
force a check.

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

Run the browser-level UI tests with:

```sh
npm ci
npx playwright install chromium
npm run test:ui
```

The UI suite uses deterministic service data and a lightweight PDF-viewer substitute.
It covers navigation, settings, embedded music links, browser history, saved reading
positions, and a mobile viewport without downloading live service files.

## GitHub Pages deployment

`.github/workflows/deploy-pages.yml` builds and deploys the site without committing any
generated PDFs. It runs on pushes to `master`, can be started manually with an optional
date range, and runs each Saturday at 11:17 AM America/Chicago. Its automatic range is
nine days before the build date through nine days after it, a 19-day inclusive window.
This guarantees that the previous and next weekends are included regardless of the day
the build runs. Unpublished service files are simply skipped.

In the repository's GitHub settings, set **Pages → Build and deployment → Source** to
**GitHub Actions**. A failed or empty build stops before deployment, leaving the last
successful site online.

## What is generated

- `docs/data/music.json` — ordered services and music metadata
- `docs/pdfs/` — content-hashed music PDFs
- `docs/services/` — content-hashed source service PDFs used by the Notes view
- `docs/vendor/pdfjs/` — the pinned PDF.js browser library
- `pipeline/.download-cache.json` — local download metadata
- `pipeline/.music-cache/` — persistent downloaded music used to populate `docs/pdfs/`

These are build outputs and are not stored in Git history.

The HTML, CSS, and JavaScript are ordinary hand-maintainable files. The interface
defaults to today's Orthros when available, keeps Orthros immediately before Liturgy,
and provides separate arrows for dates, services, and music within a service. Tap the
date in the expanded controls to jump directly to any date in the library. Service
arrows continue chronologically across date boundaries.
The date and service controls are collapsed by default; tap the compact current-service
line to reveal them. They remain open while changing dates or services so that several
nearby selections can be browsed without repeatedly reopening the controls.

When a piece has multiple settings, the site prefers `STAM`, `CROW`, `KARAM`,
`EL MASSIH`, then `CHANT`. Unlisted settings retain their order from the service PDF.
This list is named `PREFERRED_SETTINGS` near the top of `docs/js/app.js` so it is easy
to change by hand. The selected setting appears beside the piece count only when a
choice is available; tapping it opens the setting chooser.

Hymns are numbered in the music dropdown. The previous and next hymn arrows wrap
from the beginning to the end and from the end back to the beginning.

Linked parenthetical labels become setting names regardless of capitalization.
The service-text label `(twelve times)` uses `Default` and inherits the preceding
centered section heading as its title. A parenthetical label enclosed in literal
double asterisks, such as `(**As one valiant**)`, identifies the model melody for a
prosomoion or automelon rather than a separate setting, so it also uses `Default`.

The `Notes` button switches between the current service text and the selected music.
Tapping an embedded music link in the Notes view switches directly to that hymn and
setting in the Music view instead of opening or downloading the linked PDF.
Every service and music PDF remembers its own reading position in the browser, including
across reloads and discarded tabs. Positions that have not been used for 90 days expire,
and only the 100 most recently used documents are retained. A PDF not previously opened
starts at the top. Pages outside the nearby screen area are released from memory so
repeated switching remains practical on tablets.
