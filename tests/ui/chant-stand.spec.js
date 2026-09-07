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
              { setting: "STAM", url: "pdfs/alpha-stam.pdf", sourceUrl: "https://music.test/alpha-stam.pdf", sourcePage: 1, sourceTop: 120 },
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
