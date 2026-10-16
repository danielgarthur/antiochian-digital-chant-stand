import { expect, test } from "@playwright/test";

const VIEWER_STUB = String.raw`
  const loaded = new WeakMap();

  export async function showPdf(url, pagesElement, messageElement, loadingText, onLink) {
    const absoluteUrl = new URL(url, window.location.href).href;
    if (loaded.get(pagesElement) === absoluteUrl) return;
    loaded.set(pagesElement, absoluteUrl);
    pagesElement.dataset.pdfUrl = absoluteUrl;
    pagesElement.replaceChildren();
    for (let page = 1; page <= 3; page += 1) {
      const shell = document.createElement("div");
      shell.className = "pdf-page-shell";
      shell.dataset.page = String(page);
      shell.style.height = "1200px";
      shell.style.width = "100%";
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      canvas.dataset.state = "rendered";
      canvas.setAttribute("aria-label", "Page " + page + " of 3");
      shell.append(canvas);
      pagesElement.append(shell);
    }
    if (onLink) {
      const link = document.createElement("a");
      link.href = "https://music.test/beta.pdf";
      link.dataset.testid = "embedded-music-link";
      link.textContent = "Open linked music";
      link.addEventListener("click", (event) => {
        if (onLink({ url: link.href, page: 2, top: 400 }) !== false) event.preventDefault();
      });
      pagesElement.firstElementChild.append(link);
    }
    if (messageElement) messageElement.textContent = "";
  }

  export function resizePdf() {}

  export function clearPdf(pagesElement, messageElement, text) {
    loaded.delete(pagesElement);
    pagesElement.replaceChildren();
    if (messageElement) messageElement.textContent = text;
  }
`;

function localDay(offset = 0) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(Date.now() + offset * 86400000));
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${value.year}-${value.month}-${value.day}`;
}

function shiftedDay(day, offset) {
  const value = new Date(`${day}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

function library(today = localDay()) {
  const yesterday = shiftedDay(today, -1);
  return {
    services: [
      {
        date: yesterday,
        type: "VESP",
        label: "Vespers",
        url: "services/vespers.pdf",
        music: [{
          title: "O Gladsome Light",
          links: [{ setting: "Default", url: "pdfs/gladsome.pdf", sourceUrl: "https://music.test/gladsome.pdf", sourcePage: 1, sourceTop: 100 }],
        }],
      },
      {
        date: today,
        type: "ABBREVIATED",
        label: "Abbreviated Rubrics",
        url: "services/abbreviated.pdf",
        music: [],
      },
      {
        date: today,
        type: "BILINGUAL_ORTHROS",
        label: "Bilingual Sunday Orthros",
        url: "services/bilingual-orthros.pdf",
        music: [],
      },
      {
        date: today,
        type: "BILINGUAL_LITURGY",
        label: "Bilingual Divine Liturgy",
        url: "services/bilingual-liturgy.pdf",
        music: [],
      },
      {
        date: today,
        type: "ORTHROS",
        label: "Orthros",
        url: "services/orthros.pdf",
        music: [
          {
            title: "Alpha Hymn",
            links: [
              { setting: "CHANT", url: "pdfs/alpha-chant.pdf", sourceUrl: "https://music.test/alpha-chant.pdf", sourcePage: 1, sourceTop: 100 },
              { setting: "STAM", url: "pdfs/alpha-stam-optimized-v1.pdf", fallbackUrl: "pdfs/alpha-stam.pdf", sourceUrl: "https://music.test/alpha-stam.pdf", sourcePage: 1, sourceTop: 120 },
              { setting: "CROW", url: "pdfs/alpha-crow.pdf", sourceUrl: "https://music.test/alpha-crow.pdf", sourcePage: 1, sourceTop: 140 },
            ],
          },
          {
            title: "Beta Hymn",
            links: [{ setting: "Default", url: "pdfs/beta.pdf", sourceUrl: "https://music.test/beta.pdf", sourcePage: 2, sourceTop: 400 }],
          },
        ],
      },
      {
        date: today,
        type: "LITURGY",
        label: "Liturgy",
        url: "services/liturgy.pdf",
        music: [{
          title: "Cherubic Hymn",
          links: [{ setting: "Default", url: "pdfs/cherubic.pdf", sourceUrl: "https://music.test/cherubic.pdf", sourcePage: 1, sourceTop: 100 }],
        }],
      },
      {
        date: today,
        type: "GREAT_VESPERS",
        label: "Great Vespers",
        url: "services/great-vespers.pdf",
        music: [],
      },
    ],
  };
}

async function openApp(page, query = "", serviceLibrary = library()) {
  await page.route("**/data/music.json", (route) => route.fulfill({ json: serviceLibrary }));
  await page.route("**/js/pdf-viewer.js*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: VIEWER_STUB,
  }));
  await page.goto(`/${query}`);
  await expect(page.locator("#scheduleLabel")).not.toHaveText("Loading service…");
}

test("prefers Orthros on Sunday when the URL has no selection", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-06T17:00:00Z"));
  await openApp(page, "", library("2026-09-06"));

  await expect(page.locator("#scheduleLabel")).toHaveText("Today · Orthros");
  await expect(page.locator("body")).toHaveClass(/notes-mode/);
  await expect(page.locator("#viewToggle")).toHaveAttribute("aria-label", "Return to music");
  await expect(page.locator("#notesPages")).toHaveAttribute("data-pdf-url", /services\/orthros\.pdf$/);
});

test("keeps the view toggle thumb-sized on a small phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openApp(page, `?date=${localDay()}&service=ORTHROS&view=notes`);

  const layout = await page.evaluate(() => {
    const toggle = document.querySelector("#viewToggle").getBoundingClientRect();
    const actions = document.querySelector("#actionsButton").getBoundingClientRect();
    const summary = document.querySelector("#schedule summary").getBoundingClientRect();
    return {
      toggleWidth: toggle.width,
      toggleHeight: toggle.height,
      actionsWidth: actions.width,
      actionsHeight: actions.height,
      actionsDoNotOverlap: actions.right <= summary.left,
      controlsDoNotOverlap: summary.right <= toggle.left,
      pageFitsViewport: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    };
  });

  expect(layout.toggleWidth).toBeGreaterThanOrEqual(56);
  expect(layout.toggleHeight).toBeGreaterThanOrEqual(48);
  expect(layout.actionsWidth).toBeGreaterThanOrEqual(56);
  expect(layout.actionsHeight).toBeGreaterThanOrEqual(48);
  expect(layout.actionsDoNotOverlap).toBe(true);
  expect(layout.controlsDoNotOverlap).toBe(true);
  expect(layout.pageFitsViewport).toBe(true);
});

test("offers the current PDF in a phone-friendly actions sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, `?date=${localDay()}&service=ORTHROS&view=notes`);

  await page.locator("#actionsButton").click();
  await expect(page.locator("#actionsDialog")).toBeVisible();
  await expect(page.locator("#downloadPdf")).toHaveAttribute("href", /services\/orthros\.pdf$/);
  await expect(page.locator("#downloadPdf")).toHaveAttribute("download", `${localDay()}-Orthros.pdf`);
  await expect(page.locator("#downloadDescription")).toHaveText("Save Orthros");

  const layout = await page.locator("#actionsDialog").evaluate((dialog) => {
    const bounds = dialog.getBoundingClientRect();
    const download = dialog.querySelector("#downloadPdf").getBoundingClientRect();
    const preference = dialog.querySelector(".preference-row").getBoundingClientRect();
    return {
      atBottom: Math.abs(bounds.bottom - window.innerHeight) <= 1,
      fullWidth: Math.abs(bounds.width - window.innerWidth) <= 1,
      downloadHeight: download.height,
      preferenceHeight: preference.height,
    };
  });
  expect(layout.atBottom).toBe(true);
  expect(layout.fullWidth).toBe(true);
  expect(layout.downloadHeight).toBeGreaterThanOrEqual(64);
  expect(layout.preferenceHeight).toBeGreaterThanOrEqual(64);
});

test("hides bilingual services and remembers the preference", async ({ page }) => {
  await openApp(page, `?date=${localDay()}&service=BILINGUAL_ORTHROS&view=notes`);
  await expect(page.locator("#scheduleLabel")).toContainText("Bilingual Sunday Orthros");

  await page.locator("#actionsButton").click();
  await expect(page.locator("#showBilingualServices")).toBeChecked();
  await page.locator("#showBilingualServices").uncheck();
  await expect(page.locator("#scheduleLabel")).toHaveText("Today · Orthros");
  await expect(page).toHaveURL(/service=ORTHROS/);
  await page.locator("#closeActions").click();
  await page.locator("#schedule summary").click();
  await expect(page.getByRole("tab", { name: "Bilingual Sunday Orthros" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Bilingual Divine Liturgy" })).toHaveCount(0);

  await page.reload();
  await page.locator("#actionsButton").click();
  await expect(page.locator("#showBilingualServices")).not.toBeChecked();
  await page.locator("#showBilingualServices").check();
  await page.locator("#closeActions").click();
  await page.locator("#schedule summary").click();
  await expect(page.getByRole("tab", { name: "Bilingual Sunday Orthros" })).toHaveCount(1);
});

test("keeps the music PDF close to its position indicator", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await openApp(page, `?date=${localDay()}&service=ORTHROS&view=music`);

  const gap = await page.evaluate(() => {
    const position = document.querySelector("#musicPosition").getBoundingClientRect();
    const firstPage = document.querySelector("#musicPages .pdf-page-shell").getBoundingClientRect();
    return firstPage.top - position.bottom;
  });

  expect(gap).toBeLessThanOrEqual(18);
});

test("prefers Great Vespers on Saturday when the URL has no selection", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-05T17:00:00Z"));
  await openApp(page, "", library("2026-09-05"));

  await expect(page.locator("#scheduleLabel")).toHaveText("Today · Great Vespers");
  await expect(page.locator("#notesPages")).toHaveAttribute("data-pdf-url", /services\/great-vespers\.pdf$/);
});

test("uses the weekday fallback order when the URL has no selection", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-09-07T17:00:00Z"));
  const mondayLibrary = library("2026-09-07");
  await openApp(page, "", mondayLibrary);
  await expect(page.locator("#scheduleLabel")).toHaveText("Today · Orthros");

  const withoutOrthros = {
    services: mondayLibrary.services.filter((service) => !service.type.includes("ORTHROS")),
  };
  await page.unroute("**/data/music.json");
  await page.route("**/data/music.json", (route) => route.fulfill({ json: withoutOrthros }));
  await page.reload();
  await expect(page.locator("#scheduleLabel")).toHaveText("Today · Liturgy");

  const withoutOrthrosOrLiturgy = {
    services: withoutOrthros.services.filter((service) => (
      service.type !== "READ"
      && service.type !== "LITURGY"
      && !service.type.includes("DIVINE_LITURGY")
    )),
  };
  await page.unroute("**/data/music.json");
  await page.route("**/data/music.json", (route) => route.fulfill({ json: withoutOrthrosOrLiturgy }));
  await page.reload();
  await expect(page.locator("#scheduleLabel")).toHaveText("Today · Great Vespers");
});

test("applies the service priority whenever the date changes", async ({ page }) => {
  const serviceLibrary = library("2026-09-07");
  serviceLibrary.services.push(
    { date: "2026-09-08", type: "ABBREVIATED", label: "Tuesday Rubrics", url: "services/tuesday-rubrics.pdf", music: [] },
    { date: "2026-09-08", type: "LITURGY", label: "Tuesday Liturgy", url: "services/tuesday-liturgy.pdf", music: [] },
    { date: "2026-09-08", type: "DAILY_ORTHROS", label: "Daily Orthros", url: "services/daily-orthros.pdf", music: [] },
    { date: "2026-09-12", type: "ABBREVIATED", label: "Saturday Rubrics", url: "services/saturday-rubrics.pdf", music: [] },
    { date: "2026-09-12", type: "ORTHROS", label: "Saturday Orthros", url: "services/saturday-orthros.pdf", music: [] },
    { date: "2026-09-12", type: "GREAT_VESPERS", label: "Saturday Great Vespers", url: "services/saturday-vespers.pdf", music: [] },
    { date: "2026-09-13", type: "ABBREVIATED", label: "Sunday Rubrics", url: "services/sunday-rubrics.pdf", music: [] },
    { date: "2026-09-13", type: "LITURGY", label: "Sunday Liturgy", url: "services/sunday-liturgy.pdf", music: [] },
    { date: "2026-09-13", type: "ORTHROS", label: "Sunday Orthros", url: "services/sunday-orthros.pdf", music: [] },
  );
  await openApp(page, `?date=2026-09-07&service=LITURGY&view=notes`, serviceLibrary);
  await page.locator("#schedule summary").click();

  await page.locator("#dateSelect").selectOption("2026-09-08");
  await expect(page.locator("#scheduleLabel")).toContainText("Daily Orthros");

  await page.locator("#dateSelect").selectOption("2026-09-12");
  await expect(page.locator("#scheduleLabel")).toContainText("Saturday Great Vespers");

  await page.locator("#dateSelect").selectOption("2026-09-13");
  await expect(page.locator("#scheduleLabel")).toContainText("Sunday Orthros");
});

test("navigates dates, services, and wrapping music", async ({ page }) => {
  await openApp(page, `?date=${localDay()}&service=ORTHROS&view=music`);

  await expect(page.locator("#settingButton")).toHaveText("STAM ▾");
  await page.locator("#previousMusic").click();
  await expect(page.locator("#musicSelect")).toHaveValue("1");
  await expect(page.locator("#musicPosition")).toHaveText("2 of 2");

  await page.locator("#nextMusic").click();
  await expect(page.locator("#musicSelect")).toHaveValue("0");
  await expect(page.locator("#settingButton")).toHaveText("STAM ▾");

  await page.locator("#schedule summary").click();
  await page.getByRole("tab", { name: "Liturgy", exact: true }).click();
  await expect(page.locator("#scheduleLabel")).toHaveText("Today · Liturgy");
  await page.locator("#previousDay").click();
  await expect(page.locator("#scheduleLabel")).toContainText("Vespers");
});

test("chooses a setting and keeps it in the URL", async ({ page }) => {
  await openApp(page, `?date=${localDay()}&service=ORTHROS&view=music`);

  await page.locator("#settingButton").click();
  await expect(page.locator("#settingsDialog")).toBeVisible();
  await page.getByRole("button", { name: "CROW", exact: true }).click();

  await expect(page.locator("#settingButton")).toHaveText("CROW ▾");
  await expect(page).toHaveURL(/setting=2/);
  await expect(page.locator("#musicPages")).toHaveAttribute("data-pdf-url", /pdfs\/alpha-crow\.pdf$/);
});

test("switches between optimized and original PDF copies", async ({ page }) => {
  await openApp(page, `?date=${localDay()}&service=ORTHROS&view=music`);

  await expect(page.locator("#musicPages")).toHaveAttribute("data-pdf-url", /alpha-stam-optimized-v1\.pdf$/);
  await expect(page.locator("#pdfCopyButton")).toHaveText("Having trouble?");

  await page.evaluate(() => window.scrollTo(0, 950));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(800);
  await page.locator("#pdfCopyButton").click();
  await expect(page.locator("#pdfFallbackDialog")).toBeVisible();
  await expect(page.locator("#pdfFallbackDescription")).toContainText("adjusted to load faster");
  await expect(page.locator("#keepPdfCopy")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(page.locator("#keepPdfCopy")).toHaveCSS("color", "rgb(23, 32, 25)");
  await expect(page.locator("#switchPdfCopy")).toHaveCSS("background-color", "rgb(38, 55, 47)");
  await expect(page.locator("#switchPdfCopy")).toHaveCSS("color", "rgb(255, 255, 255)");
  await page.locator("#switchPdfCopy").click();
  await expect(page.locator("#musicPages")).toHaveAttribute("data-pdf-url", /pdfs\/alpha-stam\.pdf$/);
  await expect(page.locator("#pdfCopyButton")).toHaveText("Original PDF");
  await expect(page.locator("#pdfCopyButton")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(700);
  await page.locator("#actionsButton").click();
  await expect(page.locator("#downloadPdf")).toHaveAttribute("href", /pdfs\/alpha-stam\.pdf$/);
  await expect(page.locator("#downloadPdf")).toHaveAttribute(
    "download",
    `${localDay()}-Alpha-Hymn-STAM.pdf`
  );
  await page.locator("#closeActions").click();

  await page.reload();
  await expect(page.locator("#musicPages")).toHaveAttribute("data-pdf-url", /pdfs\/alpha-stam\.pdf$/);
  await expect(page.locator("#pdfCopyButton")).toHaveText("Original PDF");

  await page.locator("#pdfCopyButton").click();
  await expect(page.locator("#pdfFallbackDescription")).toContainText("may load more slowly");
  await page.locator("#switchPdfCopy").click();
  await expect(page.locator("#musicPages")).toHaveAttribute("data-pdf-url", /alpha-stam-optimized-v1\.pdf$/);
});

test("opens an embedded notes link in the matching music", async ({ page }) => {
  await openApp(page, `?date=${localDay()}&service=ORTHROS&view=notes`);

  await page.locator('[data-testid="embedded-music-link"]').click();

  await expect(page.locator("body")).not.toHaveClass(/notes-mode/);
  await expect(page.locator("#musicSelect")).toHaveValue("1");
  await expect(page).toHaveURL(/music=1.*view=music/);
  await expect(page.locator("#musicPages")).toHaveAttribute("data-pdf-url", /pdfs\/beta\.pdf$/);
});

test("restores selections through browser history", async ({ page }) => {
  await openApp(page, `?date=${localDay()}&service=ORTHROS&music=0&setting=1&view=notes`);

  await page.locator("#viewToggle").click();
  await page.locator("#nextMusic").click();
  await expect(page.locator("#musicSelect")).toHaveValue("1");

  await page.goBack();
  await expect(page.locator("#musicSelect")).toHaveValue("0");
  await expect(page.locator("body")).not.toHaveClass(/notes-mode/);

  await page.goBack();
  await expect(page.locator("body")).toHaveClass(/notes-mode/);
});

test("restores a document's reading position after reload", async ({ page }) => {
  await openApp(page, `?date=${localDay()}&service=ORTHROS&music=0&setting=1&view=music`);
  await expect(page.locator("#musicPages .pdf-page-shell")).toHaveCount(3);

  await page.evaluate(() => window.scrollTo(0, 950));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(800);
  await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
  await page.reload();

  await expect(page.locator("#musicPages .pdf-page-shell")).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(700);
});

test("mobile navigation stays within the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page, `?date=${localDay()}&service=ORTHROS&view=music`);

  await expect(page.locator("#musicSelect")).toBeVisible();
  await page.locator("#nextMusic").click();
  await expect(page.locator("#musicSelect")).toHaveValue("1");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("mobile schedule separates the date and service into centered lines", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const serviceLibrary = library();
  serviceLibrary.services.find((service) => service.type === "BILINGUAL_LITURGY").label = "Divine Liturgy Variables";
  await openApp(page, `?date=${localDay()}&service=BILINGUAL_LITURGY&view=notes`, serviceLibrary);

  await expect(page.locator("#scheduleDay")).toHaveText("Today");
  await expect(page.locator("#scheduleService")).toHaveText("Divine Liturgy Variables");
  await expect(page.locator(".schedule-separator")).toBeHidden();
  await expect(page.locator("#scheduleLabel")).toHaveCSS("text-align", "center");
  await expect(page.locator("#scheduleLabel")).toHaveCSS("display", "grid");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("tablet service tabs scroll horizontally and keep the selection visible", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await openApp(page, `?date=${localDay()}&service=GREAT_VESPERS&view=notes`);
  await page.locator("#schedule summary").click();

  const tabs = page.locator("#serviceTabs");
  expect(await tabs.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect.poll(() => page.getByRole("tab", { name: "Great Vespers", exact: true }).evaluate((tab) => {
    const strip = tab.parentElement;
    return tab.getBoundingClientRect().left >= strip.getBoundingClientRect().left - 1
      && tab.getBoundingClientRect().right <= strip.getBoundingClientRect().right + 1;
  })).toBe(true);

  await page.getByRole("tab", { name: "Abbreviated Rubrics" }).click();
  await expect(page.getByRole("tab", { name: "Abbreviated Rubrics" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => page.getByRole("tab", { name: "Abbreviated Rubrics" }).evaluate((tab) => {
    const strip = tab.parentElement;
    return tab.getBoundingClientRect().left >= strip.getBoundingClientRect().left - 1
      && tab.getBoundingClientRect().right <= strip.getBoundingClientRect().right + 1;
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("wide service tabs form a centered compact group between fixed arrows", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page, `?date=${localDay()}&service=ORTHROS&view=notes`);
  await page.locator("#schedule summary").click();

  const layout = await page.locator(".service-row").evaluate((row) => {
    const strip = row.querySelector(".service-tabs");
    const tabs = [...strip.querySelectorAll(".service-tab")];
    const rowBounds = row.getBoundingClientRect();
    const stripBounds = strip.getBoundingClientRect();
    const firstBounds = tabs[0].getBoundingClientRect();
    const lastBounds = tabs.at(-1).getBoundingClientRect();
    const previousBounds = row.querySelector("#previousService").getBoundingClientRect();
    const nextBounds = row.querySelector("#nextService").getBoundingClientRect();
    return {
      groupCenter: (firstBounds.left + lastBounds.right) / 2,
      stripCenter: (stripBounds.left + stripBounds.right) / 2,
      maximumTabGap: Math.max(...tabs.slice(1).map((tab, index) => (
        tab.getBoundingClientRect().left - tabs[index].getBoundingClientRect().right
      ))),
      previousOffset: previousBounds.left - rowBounds.left,
      nextOffset: rowBounds.right - nextBounds.right,
      fits: strip.scrollWidth === strip.clientWidth,
    };
  });

  expect(layout.fits).toBe(true);
  expect(Math.abs(layout.groupCenter - layout.stripCenter)).toBeLessThanOrEqual(1);
  expect(layout.maximumTabGap).toBeLessThan(4);
  expect(Math.abs(layout.previousOffset)).toBeLessThanOrEqual(1);
  expect(Math.abs(layout.nextOffset)).toBeLessThanOrEqual(1);
});

test("service arrows stay within the selected date", async ({ page }) => {
  await openApp(page, `?date=${localDay()}&service=ABBREVIATED&view=notes`);
  await page.locator("#schedule summary").click();

  await expect(page.locator("#previousService")).toBeDisabled();
  await page.locator("#nextService").click();
  await expect(page.locator("#scheduleLabel")).toHaveText("Today · Bilingual Sunday Orthros");
  await expect(page.locator("#dateSelect")).toHaveValue(localDay());
});

// Inspect the audio graph without producing sound. Resume can be held pending to
// exercise the mobile initialization/Stop race deterministically.
async function instrumentPitchAudio(page) {
  await page.addInitScript(() => {
    window.pitchAudio = { oscillators: [], gains: [], contexts: [], hold: false };
    const param = () => ({
      value: 0,
      events: [],
      setValueAtTime(value, time) { this.value = value; this.events.push({ kind: "set", value, time }); },
      linearRampToValueAtTime(value, time) { this.events.push({ kind: "ramp", value, time }); },
      setTargetAtTime(value, time, timeConstant) { this.value = value; this.events.push({ kind: "target", value, time, timeConstant }); },
      cancelScheduledValues() {},
    });
    class AudioContext extends EventTarget {
      constructor() {
        super();
        this.state = "running";
        this.currentTime = 10;
        this.destination = {};
        window.pitchAudio.context = this;
        window.pitchAudio.contexts.push(this);
      }
      resume() {
        return window.pitchAudio.hold
          ? new Promise((resolve) => { window.pitchAudio.release = resolve; })
          : Promise.resolve();
      }
      close() { this.state = "closed"; this.dispatchEvent(new Event("statechange")); return Promise.resolve(); }
      createPeriodicWave(real, imaginary, options) {
        window.pitchAudio.wave = { imaginary: [...imaginary], ...options };
        return {};
      }
      createOscillator() {
        const node = {
          frequency: param(), starts: [], stops: [], disconnected: false,
          setPeriodicWave() {}, connect() {},
          disconnect() { this.disconnected = true; },
          start(time) { this.starts.push(time); },
          stop(time) {
            this.stops.push(time ?? "now");
            if (this.stops.length > 1) queueMicrotask(() => this.onended?.());
          },
        };
        window.pitchAudio.oscillators.push(node);
        return node;
      }
      createGain() {
        const node = { gain: param(), disconnected: false, connect() {}, disconnect() { this.disconnected = true; } };
        window.pitchAudio.gains.push(node);
        return node;
      }
    }
    window.AudioContext = AudioContext;
  });
}

async function setPitchLevel(page, level) {
  await page.locator("#pitchVolume").evaluate((element, value) => {
    element.value = String(value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, level);
}

test("pitch pipe is silent until Play, remembers pitch and volume, and fits small screens", async ({ page }) => {
  await instrumentPitchAudio(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await openApp(page);
  await page.getByRole("button", { name: "Pitch pipe", exact: true }).click();
  await expect(page.getByRole("button", { name: "Close pitch pipe" })).toBeFocused();
  await page.getByRole("button", { name: "C", exact: true }).click();
  await page.locator("#pitchOctave").selectOption("4");
  await expect(page.locator("#pitchFrequency")).toHaveText("261.6 Hz");
  await expect(page.locator("#pitchPlay")).toHaveText("Play C4");
  expect(await page.evaluate(() => window.pitchAudio.oscillators.length)).toBe(0);
  await setPitchLevel(page, 65);
  await page.getByRole("button", { name: "C", exact: true }).click();
  await page.getByRole("button", { name: "Close pitch pipe" }).click();
  await page.locator("#pitchPipeButton").click();
  await expect(page.locator("#pitchVolume")).toHaveValue("65");
  await page.getByRole("button", { name: "Close pitch pipe" }).click();
  await page.reload();
  await page.getByRole("button", { name: "Pitch pipe", exact: true }).click();
  await expect(page.locator("#pitchPlay")).toHaveText("Play C4");
  await expect(page.locator("#pitchVolume")).toHaveValue("65");
  await expect(page.locator("#pitchVolumeLabel")).toHaveText("65%");
  expect(await page.evaluate(() => window.pitchAudio.oscillators.length)).toBe(0);
  await page.setViewportSize({ width: 568, height: 320 });
  const layout = await page.evaluate(() => {
    const play = document.querySelector("#pitchPlay").getBoundingClientRect();
    const close = document.querySelector("#closePitchPipe").getBoundingClientRect();
    return { playVisible: play.top >= 0 && play.bottom <= innerHeight,
      closeVisible: close.top >= 0 && close.bottom <= innerHeight,
      fits: document.documentElement.scrollWidth <= innerWidth };
  });
  expect(layout).toEqual({ playVisible: true, closeVisible: true, fits: true });
});

test("pitch audio has a bounded waveform, quiet default, gentle envelope and scheduled stop", async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  await page.locator("#pitchPipeButton").click();
  await page.locator("#pitchPlay").click();
  await expect(page.locator("#pitchPlay")).toHaveText("Stop sound");
  const audio = await page.evaluate(() => ({
    frequency: window.pitchAudio.oscillators[0].frequency.events,
    stops: window.pitchAudio.oscillators[0].stops,
    envelope: window.pitchAudio.gains[0].gain.events,
    level: window.pitchAudio.gains[1].gain.events,
    wave: window.pitchAudio.wave,
  }));
  expect(audio.frequency[0].value).toBe(220);
  expect(audio.stops).toEqual([12]);
  expect(audio.level).toEqual([{ kind: "set", value: 0.01, time: 10 }]);
  expect(audio.envelope).toEqual([
    { kind: "set", value: 0, time: 10 }, { kind: "ramp", value: 1, time: 10.15 },
    { kind: "set", value: 1, time: 11.8 }, { kind: "ramp", value: 0, time: 12 },
  ]);
  await page.evaluate(() => { window.pitchAudio.context.currentTime = 10.5; });
  expect(audio.wave.disableNormalization).toBe(true);
  expect(audio.wave.imaginary.reduce((sum, value) => sum + Math.abs(value), 0)).toBeLessThanOrEqual(1);
  await expect(page.locator("#pitchPlay")).toHaveText("Play A3", { timeout: 3500 });
  expect(await page.evaluate(() => window.pitchAudio.gains[1].disconnected)).toBe(true);
});

test("volume rises gradually and falls promptly within the cap, including mute", async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  await page.locator("#pitchPipeButton").click();
  await page.locator("#pitchPlay").click();
  await setPitchLevel(page, 100);
  expect(await page.evaluate(() => window.pitchAudio.gains[1].gain.events.at(-1))).toEqual(
    { kind: "target", value: 0.05, time: 10, timeConstant: 0.05 });
  await setPitchLevel(page, 50);
  expect(await page.evaluate(() => window.pitchAudio.gains[1].gain.events.at(-1))).toEqual(
    { kind: "target", value: 0.025, time: 10, timeConstant: 0.003 });
  await setPitchLevel(page, 0);
  expect(await page.evaluate(() => window.pitchAudio.gains[1].gain.events.at(-1))).toEqual(
    { kind: "target", value: 0, time: 10, timeConstant: 0.003 });
  await setPitchLevel(page, 100);
  expect(await page.evaluate(() => window.pitchAudio.gains[1].gain.events.at(-1).value)).toBe(0.05);
  expect(await page.evaluate(() => window.pitchAudio.oscillators.length)).toBe(1);
  expect(await page.evaluate(() => window.pitchAudio.oscillators[0].stops)).toEqual([12]);
  await page.locator("#pitchPlay").click();
  await setPitchLevel(page, 75);
  expect(await page.evaluate(() => window.pitchAudio.oscillators.length)).toBe(1);
});

test("Stop and closing cancel pending mobile audio initialization", async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  await page.evaluate(() => { window.pitchAudio.hold = true; });
  await page.locator("#pitchPipeButton").click();
  await page.locator("#pitchPlay").click();
  await expect(page.locator("#pitchPlay")).toHaveText("Stop sound");
  await page.locator("#pitchPlay").click();
  await page.evaluate(() => window.pitchAudio.release());
  expect(await page.evaluate(() => window.pitchAudio.oscillators.length)).toBe(0);
  await page.locator("#pitchPlay").click();
  await page.getByRole("button", { name: "Close pitch pipe" }).click();
  await page.evaluate(() => window.pitchAudio.release());
  expect(await page.evaluate(() => window.pitchAudio.oscillators.length)).toBe(0);
});

for (const exit of ["stop", "close", "escape", "backdrop", "note", "octave", "blur", "hidden", "pagehide", "history", "interrupted"]) {
  test(`pitch pipe stops immediately on ${exit}`, async ({ page }) => {
    await instrumentPitchAudio(page);
    await openApp(page);
    await page.locator("#pitchPipeButton").click();
    await page.locator("#pitchPlay").click();
    if (exit === "stop") await page.locator("#pitchPlay").click();
    if (exit === "close") await page.getByRole("button", { name: "Close pitch pipe" }).click();
    if (exit === "escape") await page.keyboard.press("Escape");
    if (exit === "backdrop") await page.mouse.click(2, 2);
    if (exit === "note") await page.getByRole("button", { name: "C", exact: true }).click();
    if (exit === "octave") await page.locator("#pitchOctave").selectOption("4");
    if (["blur", "pagehide", "history"].includes(exit)) {
      await page.evaluate((name) => window.dispatchEvent(new Event(name === "history" ? "popstate" : name)), exit);
    }
    if (exit === "hidden") await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    if (exit === "interrupted") await page.evaluate(() => {
      window.pitchAudio.context.state = "interrupted";
      window.pitchAudio.context.dispatchEvent(new Event("statechange"));
    });
    await expect(page.locator("#pitchPlay")).not.toHaveText("Stop sound");
    expect(await page.evaluate(() => window.pitchAudio.oscillators[0].stops)).toEqual(["interrupted", "hidden", "blur", "pagehide"].includes(exit) ? [12, "now"] : [12, 10.008]);
    expect(await page.evaluate(() => window.pitchAudio.gains[1].disconnected)).toBe(true);
    expect(await page.evaluate(() => window.pitchAudio.oscillators.length)).toBe(1);
  });
}

test("pitch pipe works with the browser's real Web Audio implementation", async ({ page }) => {
  await openApp(page);
  await page.locator("#pitchPipeButton").click();
  // Exercise the real graph, PeriodicWave, resume and audio-clock ended event,
  // while keeping the test inaudible by muting the destination graph.
  await page.evaluate(() => {
    const original = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...args) {
      if (destination instanceof AudioDestinationNode) return destination;
      return original.call(this, destination, ...args);
    };
  });
  await page.locator("#pitchPlay").click();
  await expect(page.locator("#pitchStatus")).toContainText("Playing A3");
  await setPitchLevel(page, 100);
  await setPitchLevel(page, 50);
  await setPitchLevel(page, 0);
  await setPitchLevel(page, 75);
  await expect(page.locator("#pitchPlay")).toHaveText("Play A3", { timeout: 3500 });
  await expect(page.locator("#pitchStatus")).not.toContainText("unavailable");
});

test("initializing audio uses the latest chosen volume, including mute", async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  await page.evaluate(() => { window.pitchAudio.hold = true; });
  await page.locator("#pitchPipeButton").click();
  await page.locator("#pitchPlay").click();
  await setPitchLevel(page, 100);
  await page.evaluate(() => window.pitchAudio.release());
  expect(await page.evaluate(() => window.pitchAudio.gains[1].gain.events[0].value)).toBe(0.05);
  await page.locator("#pitchPlay").click();
  await page.locator("#pitchPlay").click();
  await setPitchLevel(page, 0);
  await page.evaluate(() => window.pitchAudio.release());
  expect(await page.evaluate(() => window.pitchAudio.gains[3].gain.events[0].value)).toBe(0);
});

test("unavailable audio fails silently and muted playback creates no audio graph", async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  await page.locator("#pitchPipeButton").click();
  await setPitchLevel(page, 0);
  await page.locator("#pitchPlay").click();
  await expect(page.locator("#pitchStatus")).toHaveText("Tone level is muted.");
  expect(await page.evaluate(() => window.pitchAudio.oscillators.length)).toBe(0);
  await setPitchLevel(page, 20);
  await page.evaluate(() => { window.AudioContext = undefined; window.webkitAudioContext = undefined; });
  await page.locator("#pitchPlay").click();
  await expect(page.locator("#pitchStatus")).toContainText("Audio unavailable");
  await expect(page.locator("#pitchPlay")).toHaveText("Play A3");
  await page.getByRole("button", { name: "Close pitch pipe" }).click();
  await expect(page.locator("#pitchPipeDialog")).not.toBeVisible();
});

test("pitch pipe supports touch activation without moving the music position", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await instrumentPitchAudio(page);
  await openApp(page, `?date=${localDay()}&service=ORTHROS&view=music`);
  await page.evaluate(() => window.scrollTo(0, 800));
  const before = await page.evaluate(() => ({ y: scrollY, url: location.href }));
  await page.locator("#pitchPipeButton").tap();
  await page.locator("#pitchPlay").tap();
  await expect(page.locator("#pitchPlay")).toHaveText("Stop sound");
  await page.locator("#pitchPlay").tap();
  await page.getByRole("button", { name: "Close pitch pipe" }).tap();
  expect(await page.evaluate(() => ({ y: scrollY, url: location.href }))).toEqual(before);
  await context.close();
});


test("saved volume is validated, old preferences keep the quiet default, and mute persists", async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  for (const [savedVolume, expected] of [[undefined, "20"], [-1, "20"], [101, "20"], ["80", "20"], [0, "0"]]) {
    await page.evaluate((volume) => localStorage.setItem("antiochian-chant-stand:pitch:v1",
      JSON.stringify({ note: 0, octave: 4, volume })), savedVolume);
    await page.reload();
    await page.locator("#pitchPipeButton").click();
    await expect(page.locator("#pitchVolume")).toHaveValue(expected);
    await expect(page.locator("#pitchVolumeLabel")).toHaveText(`${expected}%`);
    await expect(page.locator("#pitchPlay")).toHaveText("Play C4");
    expect(await page.evaluate(() => window.pitchAudio.oscillators.length)).toBe(0);
  }
  await page.locator("#pitchPlay").click();
  await expect(page.locator("#pitchStatus")).toHaveText("Tone level is muted.");
  expect(await page.evaluate(() => window.pitchAudio.oscillators.length)).toBe(0);
});

test("volume smoothing uses the current gain when a transition changes direction", async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  await page.locator("#pitchPipeButton").click();
  await page.locator("#pitchPlay").click();
  await setPitchLevel(page, 100);
  // The previous increase has only reached 0.012: 50% is still an increase
  // in actual sound, even though it is below the previous slider target.
  await page.evaluate(() => { window.pitchAudio.gains[1].gain.value = 0.012; });
  await setPitchLevel(page, 50);
  expect(await page.evaluate(() => window.pitchAudio.gains[1].gain.events.at(-1).timeConstant)).toBe(0.05);
  await setPitchLevel(page, 20);
  await page.evaluate(() => { window.pitchAudio.gains[1].gain.value = 0.04; });
  await setPitchLevel(page, 60);
  expect(await page.evaluate(() => window.pitchAudio.gains[1].gain.events.at(-1).timeConstant)).toBe(0.003);
});

test("Stop fades from the current gain to zero in 8 ms and rapid restart does not overlap", async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  await page.locator("#pitchPipeButton").click();
  await page.locator("#pitchPlay").click();
  // Simulate stopping in the middle of a volume transition.
  await page.evaluate(() => { window.pitchAudio.gains[1].gain.value = 0.023; });
  await page.locator("#pitchPlay").click();
  expect(await page.evaluate(() => window.pitchAudio.gains[1].gain.events.slice(-2))).toEqual([
    { kind: "set", value: 0.023, time: 10 },
    { kind: "ramp", value: 0, time: 10.008 },
  ]);
  await page.locator("#pitchPlay").click();
  expect(await page.evaluate(() => window.pitchAudio.oscillators[1].starts[0])).toBe(10.008);
  expect(await page.evaluate(() => window.pitchAudio.gains[1].disconnected)).toBe(true);
  await expect(page.locator("#pitchVolumeHelp")).toHaveCount(0);
});

async function openPitchCalibration(page) {
  await page.locator('#pitchPipeButton').click();
  await page.locator('.pitch-calibration summary').click();
}

test('calibration settings persist, and default comparison preserves experiments', async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  await openPitchCalibration(page);
  await page.locator('#pitchCeiling').selectOption('0.025');
  await page.locator('#pitchTimbre').selectOption('bright');
  await page.locator('#pitchDuration').selectOption('4');
  await setPitchLevel(page, 80);
  await page.locator('#pitchCompareDefaults').check();
  await expect(page.locator('#pitchTimbre')).toBeDisabled();
  await expect(page.locator('#pitchCalibrationSummary')).toContainText('Standard defaults: bright, effective ceiling 0.05');
  await expect(page.locator('#pitchVolume')).toHaveValue('20');
  expect(await page.evaluate(() => window.pitchAudio.oscillators.length)).toBe(0);
  await page.locator('#pitchPlay').click();
  expect(await page.evaluate(() => window.pitchAudio.oscillators[0].stops)).toEqual([12]);
  expect(await page.evaluate(() => window.pitchAudio.gains[1].gain.events[0].value)).toBe(0.01);
  expect(await page.evaluate(() => window.pitchAudio.wave.imaginary.length)).toBe(4);
  await page.locator('#pitchPlay').click();
  await page.reload();
  await openPitchCalibration(page);
  await expect(page.locator('#pitchCompareDefaults')).toBeChecked();
  await page.locator('#pitchCompareDefaults').uncheck();
  for (const [id, value] of [['Ceiling', '0.025'], ['Timbre', 'bright'], ['Duration', '4']]) {
    await expect(page.locator(`#pitch${id}`)).toHaveValue(value);
  }
  await page.locator('#pitchPlay').click();
  expect(await page.evaluate(() => window.pitchAudio.oscillators[0].stops)).toEqual([14]);
  expect(await page.evaluate(() => window.pitchAudio.gains[0].gain.events)).toEqual([
    { kind: 'set', value: 0, time: 10 }, { kind: 'ramp', value: 1, time: 10.15 },
    { kind: 'set', value: 1, time: 13.8 }, { kind: 'ramp', value: 0, time: 14 },
  ]);
});

test('all calibration timbres respect the hard ceiling and calibration edits stop playback', async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  await openPitchCalibration(page);
  for (const timbre of ['sine', 'soft', 'bright']) {
    await page.locator('#pitchTimbre').selectOption(timbre);
    await setPitchLevel(page, 100);
    await page.locator('#pitchPlay').click();
    const audio = await page.evaluate(() => ({ wave: window.pitchAudio.wave, gain: window.pitchAudio.gains.at(-1).gain.events[0].value }));
    expect(audio.wave.imaginary.reduce((sum, value) => sum + Math.abs(value), 0)).toBeLessThanOrEqual(1);
    expect(audio.wave.disableNormalization).toBe(true);
    expect(audio.gain).toBe(0.05);
    await page.locator('#pitchDuration').selectOption('4');
    await expect(page.locator('#pitchPlay')).not.toHaveText('Stop sound');
  }
  await page.locator('#pitchCeiling').selectOption('0.005');
  await setPitchLevel(page, 100);
  await page.locator('#pitchPlay').click();
  expect(await page.evaluate(() => window.pitchAudio.gains.at(-1).gain.events[0].value)).toBe(0.005);
  await page.locator('#pitchCeiling').selectOption('0.05');
  await expect(page.locator('#pitchVolume')).toHaveValue('20');
  await expect(page.locator('#pitchPlay')).not.toHaveText('Stop sound');
  await setPitchLevel(page, 0);
  await page.locator('#pitchCeiling').selectOption('0.005');
  await page.locator('#pitchCeiling').selectOption('0.05');
  await expect(page.locator('#pitchVolume')).toHaveValue('0');
});

test('calibration edits cancel pending audio initialization', async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  await openPitchCalibration(page);
  await page.evaluate(() => { window.pitchAudio.hold = true; });
  await page.locator('#pitchPlay').click();
  await page.locator('#pitchTimbre').selectOption('bright');
  await page.evaluate(() => window.pitchAudio.release());
  expect(await page.evaluate(() => window.pitchAudio.oscillators.length)).toBe(0);
});

test('invalid saved calibration falls back to bounded defaults', async ({ page }) => {
  await instrumentPitchAudio(page);
  await page.addInitScript(() => localStorage.setItem('antiochian-chant-stand:pitch-calibration:v1', JSON.stringify({
    experiment: { ceiling: 100, duration: 900, attack: -1, release: '0', timbre: 'square' },
  })));
  await openApp(page);
  await openPitchCalibration(page);
  await expect(page.locator('#pitchCeiling')).toHaveValue('0.05');
  await expect(page.locator('#pitchDuration')).toHaveValue('2');
  await expect(page.locator('#pitchAttack')).toHaveCount(0);
  await expect(page.locator('#pitchRelease')).toHaveCount(0);
  await expect(page.locator('#pitchTimbre')).toHaveValue('soft');
});

test('expanded calibration keeps Stop and Close visible on a phone in landscape', async ({ page }) => {
  await instrumentPitchAudio(page);
  await page.setViewportSize({ width: 568, height: 320 });
  await openApp(page);
  await openPitchCalibration(page);
  await page.locator('#pitchResetCalibration').scrollIntoViewIfNeeded();
  const layout = await page.evaluate(() => {
    const visible = (id) => { const rect = document.getElementById(id).getBoundingClientRect(); return rect.top >= 0 && rect.bottom <= innerHeight; };
    return { stop: visible('pitchPlay'), close: visible('closePitchPipe'), fits: document.documentElement.scrollWidth <= innerWidth };
  });
  expect(layout).toEqual({ stop: true, close: true, fits: true });
});

test('higher test ceilings require fresh permission and reset restores standard sound', async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  await openPitchCalibration(page);
  await page.locator('#pitchCeiling').selectOption('0.2');
  await setPitchLevel(page, 100);
  await page.locator('#pitchPlay').click();
  expect(await page.evaluate(() => window.pitchAudio.gains.at(-1).gain.events[0].value)).toBe(0.05);
  await page.locator('#pitchEnableLouderTests').check();
  await expect(page.locator('#pitchPlay')).not.toHaveText('Stop sound');
  await expect(page.locator('#pitchVolume')).toHaveValue('20');
  await setPitchLevel(page, 100);
  await page.locator('#pitchPlay').click();
  expect(await page.evaluate(() => window.pitchAudio.gains.at(-1).gain.events[0].value)).toBe(0.2);
  await page.locator('#pitchPlay').click();
  await page.getByRole('button', { name: 'Close pitch pipe' }).click();
  await page.locator('#pitchPipeButton').click();
  await expect(page.locator('#pitchEnableLouderTests')).not.toBeChecked();
  await expect(page.locator('#pitchCeiling')).toHaveValue('0.2');
  await page.reload();
  await openPitchCalibration(page);
  await expect(page.locator('#pitchEnableLouderTests')).not.toBeChecked();
  await page.locator('#pitchEnableLouderTests').check();
  await page.locator('#pitchTimbre').selectOption('bright');
  await page.locator('#pitchDuration').selectOption('4');
  await page.locator('#pitchResetCalibration').click();
  await expect(page.locator('#pitchEnableLouderTests')).not.toBeChecked();
  await expect(page.locator('#pitchCeiling')).toHaveValue('0.05');
  await expect(page.locator('#pitchTimbre')).toHaveValue('soft');
  await expect(page.locator('#pitchDuration')).toHaveValue('2');
  await expect(page.locator('#pitchVolume')).toHaveValue('20');
  await page.reload();
  await openPitchCalibration(page);
  await expect(page.locator('#pitchCeiling')).toHaveValue('0.05');
  await expect(page.locator('#pitchVolume')).toHaveValue('20');
});

test('intermediate interruption during resume does not cancel playback', async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  await openPitchCalibration(page);
  await page.evaluate(() => { window.pitchAudio.hold = true; });
  await page.locator('#pitchPlay').click();
  await page.evaluate(() => {
    window.pitchAudio.context.state = 'interrupted';
    window.pitchAudio.context.dispatchEvent(new Event('statechange'));
    window.pitchAudio.context.state = 'running';
    window.pitchAudio.release();
  });
  expect(await page.evaluate(() => window.pitchAudio.oscillators.length)).toBe(1);
  await expect(page.locator('#pitchPlay')).toHaveText('Stop sound');
});

test('pending resume times out safely and ignores late fulfillment', async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  await openPitchCalibration(page);
  await page.evaluate(() => { window.pitchAudio.hold = true; });
  await page.locator('#pitchPlay').click();
  await expect(page.locator('#pitchStatus')).toContainText('Audio did not wake up');
  await expect(page.locator('#pitchPlay')).toHaveText('Play A3');
  await page.evaluate(() => window.pitchAudio.release());
  expect(await page.evaluate(() => window.pitchAudio.oscillators.length)).toBe(0);
});

test('frozen running audio is disconnected and only a new Play tap creates a fresh context', async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  await openPitchCalibration(page);
  await page.locator('#pitchPlay').click();
  await expect(page.locator('#pitchStatus')).toContainText('Audio did not wake up');
  expect(await page.evaluate(() => window.pitchAudio.context.state)).toBe('closed');
  expect(await page.evaluate(() => window.pitchAudio.gains[1].disconnected)).toBe(true);
  expect(await page.evaluate(() => window.pitchAudio.contexts.length)).toBe(1);
  expect(await page.evaluate(() => window.pitchAudio.oscillators.length)).toBe(1);
  await page.locator('#pitchPlay').click();
  expect(await page.evaluate(() => window.pitchAudio.contexts.length)).toBe(2);
  expect(await page.evaluate(() => window.pitchAudio.oscillators[1].starts)).toEqual([10]);
  await page.evaluate(() => {
    window.pitchAudio.context.currentTime = 10.5;
    const old = window.pitchAudio.contexts[0];
    old.state = 'interrupted';
    old.dispatchEvent(new Event('statechange'));
  });
  await expect(page.locator('#pitchPlay')).toHaveText('Stop sound');
});

test('backgrounding discards active and fading nodes before wake-up playback', async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  await page.locator('#pitchPipeButton').click();
  await page.locator('#pitchPlay').click();
  await page.evaluate(() => {
    // Initiate a fade and background before its audio-clock stop completes.
    window.pitchAudio.oscillators[0].stop = () => {};
    document.querySelector('#pitchPlay').click();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await page.evaluate(() => window.pitchAudio.gains[1].disconnected)).toBe(true);
  expect(await page.evaluate(() => window.pitchAudio.context.state)).toBe('closed');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await page.evaluate(() => window.pitchAudio.contexts.length)).toBe(1);
  expect(await page.evaluate(() => window.pitchAudio.oscillators.length)).toBe(1);
  await page.locator('#pitchPlay').click();
  expect(await page.evaluate(() => window.pitchAudio.contexts.length)).toBe(2);
  expect(await page.evaluate(() => window.pitchAudio.oscillators[1].starts)).toEqual([10]);
});

test('standard timbre adds harmonics only in the lower octave at the same output gain', async ({ page }) => {
  await instrumentPitchAudio(page);
  await openApp(page);
  await openPitchCalibration(page);
  await page.locator('#pitchPlay').click();
  const low = await page.evaluate(() => window.pitchAudio.wave.imaginary);
  expect(low).toHaveLength(4);
  expect(low[1]).toBeCloseTo(0.78);
  expect(low[2]).toBeCloseTo(0.16);
  expect(low[3]).toBeCloseTo(0.06);
  expect(await page.evaluate(() => window.pitchAudio.gains.at(-1).gain.events[0].value)).toBe(0.01);
  await page.locator('#pitchOctave').selectOption('4');
  await expect(page.locator('#pitchCalibrationSummary')).toContainText('soft');
  await page.locator('#pitchPlay').click();
  const high = await page.evaluate(() => window.pitchAudio.wave.imaginary);
  expect(high).toHaveLength(3);
  expect(high[1]).toBeCloseTo(0.94);
  expect(high[2]).toBeCloseTo(0.06);
  expect(await page.evaluate(() => window.pitchAudio.gains.at(-1).gain.events[0].value)).toBe(0.01);
  await page.locator('#pitchTimbre').selectOption('sine');
  await page.locator('#pitchOctave').selectOption('3');
  await page.locator('#pitchPlay').click();
  expect(await page.evaluate(() => window.pitchAudio.wave.imaginary)).toEqual([0, 1]);
});
