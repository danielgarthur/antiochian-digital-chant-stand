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

function library() {
  const yesterday = localDay(-1);
  const today = localDay();
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
    ],
  };
}

async function openApp(page, query = "") {
  await page.route("**/data/music.json", (route) => route.fulfill({ json: library() }));
  await page.route("**/js/pdf-viewer.js*", (route) => route.fulfill({
    contentType: "application/javascript",
    body: VIEWER_STUB,
  }));
  await page.goto(`/${query}`);
  await expect(page.locator("#scheduleLabel")).not.toHaveText("Loading service…");
}

test("opens today's Orthros notes by default", async ({ page }) => {
  await openApp(page);

  await expect(page.locator("#scheduleLabel")).toHaveText("Today · Orthros");
  await expect(page.locator("body")).toHaveClass(/notes-mode/);
  await expect(page.locator("#viewToggle")).toHaveAttribute("aria-label", "Return to music");
  await expect(page.locator("#notesPages")).toHaveAttribute("data-pdf-url", /services\/orthros\.pdf$/);
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
  await page.getByRole("tab", { name: "Liturgy" }).click();
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
