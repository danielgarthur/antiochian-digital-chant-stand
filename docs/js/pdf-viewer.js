import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";

const views = new WeakMap();

function clearCanvas(canvas) {
  canvas.width = 1;
  canvas.height = 1;
  canvas.dataset.state = "idle";
}

async function renderVisiblePage(record, shell) {
  const canvas = shell.querySelector("canvas");
  if (canvas.dataset.state !== "idle") return;
  canvas.dataset.state = "rendering";
  const generation = record.generation;

  try {
    const page = await record.document.getPage(Number(shell.dataset.page));
    if (generation !== record.generation) return;
    const natural = page.getViewport({ scale: 1 });
    const cssScale = shell.clientWidth / natural.width;
    const pixelRatio = Math.min(devicePixelRatio || 1, 1.5);
    const viewport = page.getViewport({ scale: cssScale * pixelRatio });
    shell.style.aspectRatio = `${natural.width} / ${natural.height}`;
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    if (generation !== record.generation) return;
    canvas.dataset.state = "rendered";
    // Pages far outside the viewport are released to keep mobile memory bounded.
    if (shell.dataset.visible !== "true") clearCanvas(canvas);
  } catch (error) {
    if (generation === record.generation) {
      canvas.dataset.state = "idle";
      console.error(error);
    }
  }
}

function observePages(record) {
  record.observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        const shell = entry.target;
        const canvas = shell.querySelector("canvas");
        shell.dataset.visible = String(entry.isIntersecting);
        if (entry.isIntersecting) {
          renderVisiblePage(record, shell);
        } else if (canvas.dataset.state === "rendered") {
          clearCanvas(canvas);
        }
      });
    },
    { rootMargin: "150% 0px" }
  );
  record.pagesElement.querySelectorAll(".pdf-page-shell").forEach((shell) => {
    record.observer.observe(shell);
  });
}

function dispose(record) {
  record.generation += 1;
  record.observer?.disconnect();
  try {
    record.document?.destroy().catch(() => {});
  } catch {
    // A page can still be completing a render while its document is replaced.
  }
}

export async function showPdf(url, pagesElement, messageElement, loadingText = "Loading…") {
  const absoluteUrl = new URL(url, window.location.href).href;
  const existing = views.get(pagesElement);
  if (existing?.url === absoluteUrl) {
    if (messageElement) messageElement.textContent = "";
    return;
  }
  if (existing) dispose(existing);

  const record = {
    url: absoluteUrl,
    pagesElement,
    document: null,
    observer: null,
    generation: (existing?.generation || 0) + 1,
  };
  views.set(pagesElement, record);
  pagesElement.replaceChildren();
  if (messageElement) messageElement.textContent = loadingText;

  try {
    const pdfDocument = await pdfjsLib.getDocument({ url: absoluteUrl }).promise;
    if (views.get(pagesElement) !== record) {
      await pdfDocument.destroy();
      return;
    }
    record.document = pdfDocument;
    const firstPage = await pdfDocument.getPage(1);
    const firstViewport = firstPage.getViewport({ scale: 1 });

    for (let number = 1; number <= pdfDocument.numPages; number += 1) {
      const shell = document.createElement("div");
      shell.className = "pdf-page-shell";
      shell.dataset.page = String(number);
      shell.dataset.visible = "false";
      shell.style.aspectRatio = `${firstViewport.width} / ${firstViewport.height}`;
      const canvas = document.createElement("canvas");
      canvas.className = "pdf-page";
      canvas.dataset.state = "idle";
      canvas.setAttribute("aria-label", `Page ${number} of ${pdfDocument.numPages}`);
      shell.append(canvas);
      pagesElement.append(shell);
    }
    observePages(record);
    if (messageElement) messageElement.textContent = "";
    pagesElement.dispatchEvent(new CustomEvent("pdf-layout-ready"));
  } catch (error) {
    if (views.get(pagesElement) !== record) return;
    console.error(error);
    if (messageElement) {
      messageElement.textContent = `This PDF could not be displayed: ${error.message || error}`;
    }
  }
}

export function clearPdf(pagesElement, messageElement, text) {
  const existing = views.get(pagesElement);
  if (existing) dispose(existing);
  views.delete(pagesElement);
  pagesElement.replaceChildren();
  if (messageElement) messageElement.textContent = text;
}
