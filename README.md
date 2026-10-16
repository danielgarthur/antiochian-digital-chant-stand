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
.venv/bin/python pipeline/build_local.py --start 2026-09-05 --end 2026-09-07
```

The range is inclusive. When a range is supplied, recognized dated service PDFs
outside that range are excluded from the generated library, even if they remain in
`pipeline/input/` from an earlier run. In-range and undated manual inputs are included;
when an in-range manual file duplicates the same date and service family from the current
API manifest, the API version wins. For just the current day:

```sh
.venv/bin/python pipeline/build_local.py --today
```

The builder obtains a short-lived access token and asks the Archdiocese's
`LiturgicalTexts/{date}` API for each date. Every entry whose public URL ends in
`.pdf` is downloaded; entries for other formats such as RTF are ignored. It then
extracts the music links, downloads each unique music PDF, and writes
`docs/data/music.json`. If one advertised service PDF cannot be downloaded or is not
actually a PDF, that service is reported and skipped without aborting the rest of the
date range.

For local development, `build_local.py` discovers the current credential from the
JavaScript published by `antiochian.org`, keeps it in process memory, and then runs
the normal builder. It neither displays nor stores the credential. You can pass it
the same command-line options as `build_library.py`.

Deployments deliberately do not scrape the frontend. Add `ANTIOCHIAN_CLIENT_SECRET`
as a GitHub Actions repository secret; the workflow supplies it to
`build_library.py`. Access tokens are obtained afresh and are never stored.

You can also place service PDFs in `pipeline/input/` by hand and run:

```sh
.venv/bin/python pipeline/build_library.py
```

Use the upstream filename convention, such as `Sep 06 2026 ORTHROS.pdf`, so the site
can assign the date and service. Other PDF names are still included under their own
filename as undated music.

Parish-specific services that should be committed and deployed belong in
`pipeline/special-input/`. The same dated filename convention applies, with `VIGIL`
also recognized (for example, `Sep 24 2026 VIGIL.pdf`). Music PDFs committed beneath
`special-music/` can be linked from the service PDF using their GitHub file URLs; the
builder reads those files directly from the checkout and publishes content-hashed copies.

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
.venv/bin/python pipeline/build_local.py --start 2026-09-05 --end 2026-09-07
npm run dev
```

Browsers do not allow the site to fetch JSON from a `file://` URL, so it must be opened
through the local server rather than by opening `index.html` directly. The development
server refreshes the generated content hashes before startup and disables caching for
the HTML, application assets, and generated JSON. This avoids stale assets in Safari
and device simulators while leaving the production cache policy unchanged.

Then open <http://localhost:8000>.

Run `.venv/bin/python pipeline/validate_site.py` for the same pre-deployment validation used by
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

## Pitch pipe

The tuning-fork button in the header opens the pitch pipe from notes or music.
Choose a chromatic pitch (C3–B4), then tap Play for a two-second reference tone;
tap Stop sound or close the panel to silence it with an 8 ms fade that avoids clicks. Selecting a note is
silent. The last pitch and tone level are remembered on this browser, including
across reloads. New users start at a quiet 20%. Raising the slider fades the current
tone up over approximately 150 ms. Decreases, including mute, respond in about
10 ms with brief smoothing to avoid clicks. Adjusting the level
never starts a tone or extends its two-second duration. Opening the panel is silent.

Audio is synthesized locally with Web Audio, using a sine fundamental and a faint
second harmonic, with gentle attack and release. No audio samples or third-party
sound assets are used. Peak digital output is capped at 0.05 (approximately
−26 dBFS), with a default of 0.01 (−40 dBFS). These limits reduce output but cannot
guarantee acoustic loudness: start with the device's media volume low, especially
when using Bluetooth or external speakers. The app cannot read or set system volume.
Playback stops on backgrounding, lost window focus, navigation, or audio interruption
and never resumes automatically. No offline cache is provided.

Mobile sound quality and final speaker loudness should be checked on physical
iOS and Android devices before using the feature during a service.

Expand **Calibration / debug** in the pitch pipe to test it on a tablet resting
on the chant stand. Controls offer ceilings of 0.005–0.20, pure sine / soft /
brighter harmonic timbres, and 1.5–4 second total duration. Attack and release
remain fixed at the standard 150 ms and 200 ms. All settings are saved on this
browser. Changes stop playback; tap Play again to hear them. The normal 0.05 ceiling applies unless **Enable louder test ceilings for this opening**
is checked. Test ceilings of 0.10 and 0.20 require this explicit permission each
time the dialog opens; that permission is never saved. The absolute test maximum
is 0.20. Increasing the effective ceiling, including switching to standard
defaults for comparison, limits the tone level to 20% or less and preserves mute.
The normal volume slider still adjusts a playing tone with the same smoothing.
Stop and Close always use the short 8 ms stop fade.

When finished, tap **Reset sound to defaults**: it stops playback, disables louder
testing, restores the standard ceiling, timbre and duration, and resets tone level
to the quiet 20% starting point. This reset is saved across sessions.

**Compare with standard defaults** temporarily uses the original sound without
discarding experimental settings. Set the same tone level for a deliberate A/B
comparison after any safety reset. No automatic comparison playback is used.
Try timbre and octave changes before increasing the device volume: harmonics
may improve clarity from partially obstructed tablet speakers, but can also carry
further into the church. Consider stand placement, device media volume, clarity
at the stand, and audibility in the nave; these cannot be measured by the browser.
No EQ, speaker compensation, or automatic gain boost is applied.

## GitHub Pages deployment

`.github/workflows/deploy-pages.yml` builds and deploys the site without committing any
generated PDFs. It runs on pushes to `master`, can be started manually with an optional
date range, and runs each Saturday at 11:17 AM America/Chicago. Its automatic range is
the most recent Saturday (including the build day) through the following weekend's
Sunday, a nine-day inclusive window. This keeps the previous weekend available during
weekday rebuilds; a Saturday build starts with that Saturday and includes the next
Saturday and Sunday. Unpublished service files are simply skipped.

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

During a build, a strict music-PDF optimizer looks for a pathological encoding made
entirely of hundreds of contiguous, one-pixel-high image strips arranged as a small
number of adjacent columns. Service-note PDFs are never optimization candidates. It
consolidates only that bounded artwork region into a single image.
The source PDF remains untouched and both copies are published. Builds log every
optimization and write optimized, missing, and failed-optimization lists to the GitHub
Actions run summary. For optimized music, a small **Having trouble?** control appears
beside the music position and setting. It explains the tradeoff before switching files,
preserves the reading position, and becomes an **Original PDF** status control when the
fallback is active.
