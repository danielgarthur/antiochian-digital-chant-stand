import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.min.mjs";

const views = new WeakMap();
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const DOUBLE_TAP_DELAY = 325;
const DOUBLE_TAP_DISTANCE = 36;
const TAP_MOVE_TOLERANCE = 12;
const MAX_CANVAS_DIMENSION = 8192;
const MAX_CANVAS_PIXELS = 16_000_000;

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function clearCanvas(canvas) {
  canvas.renderTask?.cancel();
  canvas.renderTask = null;
  canvas.width = 1;
  canvas.height = 1;
  canvas.dataset.state = "idle";
}

function prepareCanvasForRender(canvas, keepBitmap = false) {
  canvas.renderTask?.cancel();
  canvas.renderTask = null;
  if (keepBitmap && canvas.width > 1 && canvas.height > 1) {
    canvas.dataset.state = "stale";
  } else {
    clearCanvas(canvas);
  }
}

function replacementCanvas(canvas) {
  const replacement = document.createElement("canvas");
  replacement.className = canvas.className;
  replacement.dataset.state = "rendering";
  replacement.setAttribute("aria-label", canvas.getAttribute("aria-label"));
  return replacement;
}

function availablePageWidth(pagesElement) {
  const parent = pagesElement.parentElement;
  if (!parent) return window.innerWidth;
  const style = getComputedStyle(parent);
  return parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
}

async function renderVisiblePage(record, shell) {
  const canvas = shell.querySelector("canvas");
  if (record.interacting || !["idle", "stale"].includes(canvas.dataset.state)) return;
  canvas.dataset.state = "rendering";
  const outputCanvas = replacementCanvas(canvas);
  const generation = record.generation;
  const renderRevision = record.renderRevision;
  let renderTask = null;

  try {
    const page = await record.document.getPage(Number(shell.dataset.page));
    if (generation !== record.generation || renderRevision !== record.renderRevision) return;
    const natural = page.getViewport({ scale: 1 });
    installLinkAnnotations(record, page, shell, natural);
    const cssScale = shell.clientWidth / natural.width;
    // Keep text and notation sharp without letting a page allocate an
    // unbounded canvas on high-density mobile screens.
    const cssWidth = cssScale * natural.width;
    const cssHeight = cssScale * natural.height;
    const pixelRatio = Math.min(
      devicePixelRatio || 1,
      2,
      MAX_CANVAS_DIMENSION / Math.max(cssWidth, cssHeight),
      Math.sqrt(MAX_CANVAS_PIXELS / (cssWidth * cssHeight))
    );
    const viewport = page.getViewport({ scale: cssScale * pixelRatio });
    shell.style.aspectRatio = `${natural.width} / ${natural.height}`;
    outputCanvas.width = Math.floor(viewport.width);
    outputCanvas.height = Math.floor(viewport.height);
    renderTask = page.render({
      canvasContext: outputCanvas.getContext("2d"),
      viewport,
    });
    canvas.renderTask = renderTask;
    await renderTask.promise;
    if (canvas.renderTask === renderTask) canvas.renderTask = null;
    if (generation !== record.generation || renderRevision !== record.renderRevision) return;
    outputCanvas.dataset.state = "rendered";
    canvas.replaceWith(outputCanvas);
    // Pages far outside the viewport are released to keep mobile memory bounded.
    if (shell.dataset.visible !== "true") clearCanvas(outputCanvas);
  } catch (error) {
    if (canvas.renderTask === renderTask) canvas.renderTask = null;
    if (generation === record.generation && error?.name !== "RenderingCancelledException") {
      canvas.dataset.state = canvas.width > 1 ? "rendered" : "idle";
      console.error(error);
    }
  }
}

async function installLinkAnnotations(record, page, shell, viewport) {
  if (!record.onLink || shell.dataset.linksLoaded === "true") return;
  shell.dataset.linksLoaded = "true";
  try {
    const annotations = await page.getAnnotations({ intent: "display" });
    if (views.get(record.pagesElement) !== record) return;
    annotations.forEach((annotation) => {
      const url = annotation.url || annotation.unsafeUrl;
      if (annotation.annotationType !== pdfjsLib.AnnotationType.LINK || !url || !annotation.rect) return;
      const [a, b, c, d, e, f] = viewport.transform;
      const transformPoint = (x, y) => [a * x + c * y + e, b * x + d * y + f];
      const firstCorner = transformPoint(annotation.rect[0], annotation.rect[1]);
      const secondCorner = transformPoint(annotation.rect[2], annotation.rect[3]);
      const rectangle = [...firstCorner, ...secondCorner];
      const left = Math.min(rectangle[0], rectangle[2]);
      const top = Math.min(rectangle[1], rectangle[3]);
      const width = Math.abs(rectangle[2] - rectangle[0]);
      const height = Math.abs(rectangle[3] - rectangle[1]);
      const link = document.createElement("a");
      link.className = "pdf-link";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", "Open linked music");
      link.style.left = `${left / viewport.width * 100}%`;
      link.style.top = `${top / viewport.height * 100}%`;
      link.style.width = `${width / viewport.width * 100}%`;
      link.style.height = `${height / viewport.height * 100}%`;
      link.addEventListener("click", (event) => {
        const handled = record.onLink({
          url,
          page: Number(shell.dataset.page),
          top,
        });
        if (handled !== false) event.preventDefault();
      });
      shell.append(link);
    });
  } catch (error) {
    shell.dataset.linksLoaded = "false";
    console.error(error);
  }
}

function renderVisiblePages(record) {
  record.pagesElement.querySelectorAll('.pdf-page-shell[data-visible="true"]').forEach((shell) => {
    renderVisiblePage(record, shell);
  });
}

function invalidatePages(record) {
  record.renderRevision += 1;
  record.pagesElement.querySelectorAll(".pdf-page-shell").forEach((shell) => {
    prepareCanvasForRender(shell.querySelector("canvas"), shell.dataset.visible === "true");
  });
  renderVisiblePages(record);
}

function setPageWidth(record) {
  record.pagesElement.style.setProperty(
    "--pdf-page-width",
    `${Math.round(record.overviewWidth * record.zoom * 100) / 100}px`
  );
}

function anchorAtPoint(record, clientX, clientY) {
  const element = document.elementFromPoint(clientX, clientY);
  const shell = element?.closest?.(".pdf-page-shell")
    || record.pagesElement.querySelector('.pdf-page-shell[data-visible="true"]');
  if (!shell) return null;
  const bounds = shell.getBoundingClientRect();
  return {
    page: shell.dataset.page,
    x: clamp((clientX - bounds.left) / bounds.width, 0, 1),
    y: clamp((clientY - bounds.top) / bounds.height, 0, 1),
  };
}

function keepAnchorAtPoint(record, anchor, clientX, clientY) {
  if (!anchor) return;
  const shell = record.pagesElement.querySelector(`[data-page="${anchor.page}"]`);
  if (!shell) return;
  const shellBounds = shell.getBoundingClientRect();
  const pagesBounds = record.pagesElement.getBoundingClientRect();
  const contentX = shellBounds.left - pagesBounds.left
    + record.pagesElement.scrollLeft + anchor.x * shellBounds.width;
  const documentY = shellBounds.top + window.scrollY + anchor.y * shellBounds.height;
  record.pagesElement.scrollTo({
    left: contentX - (clientX - pagesBounds.left),
    behavior: "auto",
  });
  window.scrollTo({ top: documentY - clientY, behavior: "auto" });
}

function applyZoom(record, zoom, clientX, clientY, anchor) {
  record.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  setPageWidth(record);
  keepAnchorAtPoint(record, anchor, clientX, clientY);
}

function resetToOverview(record, clientX, clientY) {
  if (record.zoom <= MIN_ZOOM + 0.01) return false;
  const anchor = anchorAtPoint(record, clientX, clientY);
  applyZoom(record, MIN_ZOOM, clientX, clientY, anchor);
  // At overview width the page fits the viewer, so no horizontal offset
  // should survive from the enlarged document.
  record.pagesElement.scrollTo({ left: 0, behavior: "auto" });
  invalidatePages(record);
  return true;
}

function showPinchPreview(record) {
  const pinch = record.pinch;
  if (!pinch?.anchor || !pinch.startCenter) return;
  if (!pinch.previewReady) {
    record.pagesElement.querySelectorAll(".pdf-page-shell").forEach((shell) => {
      const bounds = shell.getBoundingClientRect();
      shell.style.setProperty("--pinch-origin-x", `${pinch.startCenter.x - bounds.left}px`);
      shell.style.setProperty("--pinch-origin-y", `${pinch.startCenter.y - bounds.top}px`);
    });
    record.pagesElement.classList.add("pdf-pinch-preview");
    pinch.previewReady = true;
  }
  record.pagesElement.style.setProperty("--pinch-scale", pinch.zoom / pinch.startZoom);
  record.pagesElement.style.setProperty(
    "--pinch-translate-x",
    `${pinch.center.x - pinch.startCenter.x}px`
  );
  record.pagesElement.style.setProperty(
    "--pinch-translate-y",
    `${pinch.center.y - pinch.startCenter.y}px`
  );
}

function clearPinchPreview(record, pinch) {
  if (pinch.frame !== null) cancelAnimationFrame(pinch.frame);
  record.pagesElement.classList.remove("pdf-pinch-preview");
  record.pagesElement.style.removeProperty("--pinch-scale");
  record.pagesElement.style.removeProperty("--pinch-translate-x");
  record.pagesElement.style.removeProperty("--pinch-translate-y");
  record.pagesElement.querySelectorAll(".pdf-page-shell").forEach((shell) => {
    shell.style.removeProperty("--pinch-origin-x");
    shell.style.removeProperty("--pinch-origin-y");
  });
}

function installPinchZoom(record) {
  const pages = record.pagesElement;

  const touchStart = (event) => {
    if (event.touches.length === 1) {
      const touch = event.touches[0];
      record.tapCandidate = {
        time: performance.now(),
        x: touch.clientX,
        y: touch.clientY,
      };
      return;
    }
    record.tapCandidate = null;
    if (event.touches.length === 2) {
      record.touchCenter = {
        x: (event.touches[0].clientX + event.touches[1].clientX) / 2,
        y: (event.touches[0].clientY + event.touches[1].clientY) / 2,
      };
    }
  };

  const touchMove = (event) => {
    if (event.touches.length === 2) {
      record.tapCandidate = null;
      record.touchCenter = {
        x: (event.touches[0].clientX + event.touches[1].clientX) / 2,
        y: (event.touches[0].clientY + event.touches[1].clientY) / 2,
      };
      return;
    }
    if (record.tapCandidate && event.touches.length === 1) {
      const touch = event.touches[0];
      if (
        Math.hypot(
          touch.clientX - record.tapCandidate.x,
          touch.clientY - record.tapCandidate.y
        ) > TAP_MOVE_TOLERANCE
      ) {
        record.tapCandidate = null;
      }
    }
  };

  const touchEnd = (event) => {
    if (event.type === "touchcancel") {
      record.tapCandidate = null;
      record.lastTap = null;
      record.suppressTapAfterPinch = false;
      return;
    }
    if (record.suppressTapAfterPinch) {
      record.tapCandidate = null;
      if (!event.touches.length) record.suppressTapAfterPinch = false;
      return;
    }
    if (event.touches.length || event.changedTouches.length !== 1 || !record.tapCandidate) return;
    const touch = event.changedTouches[0];
    const now = performance.now();
    const candidate = record.tapCandidate;
    record.tapCandidate = null;
    if (
      now - candidate.time > DOUBLE_TAP_DELAY
      || Math.hypot(touch.clientX - candidate.x, touch.clientY - candidate.y) > TAP_MOVE_TOLERANCE
    ) return;
    const previous = record.lastTap;
    record.lastTap = { time: now, x: touch.clientX, y: touch.clientY };
    if (
      previous
      && now - previous.time <= DOUBLE_TAP_DELAY
      && Math.hypot(touch.clientX - previous.x, touch.clientY - previous.y) <= DOUBLE_TAP_DISTANCE
    ) {
      event.preventDefault();
      resetToOverview(record, touch.clientX, touch.clientY);
      record.lastTap = null;
    }
  };

  const pinchStart = () => {
    record.interacting = true;
    record.tapCandidate = null;
    record.lastTap = null;
    record.suppressTapAfterPinch = true;
    record.gesture = null;
    const center = record.touchCenter;
    record.pinch = {
      startZoom: record.zoom,
      zoom: record.zoom,
      startCenter: center,
      center,
      anchor: center ? anchorAtPoint(record, center.x, center.y) : null,
      frame: null,
      previewReady: false,
    };
  };

  const pinching = (origin, previousDistance, distance) => {
    const pinch = record.pinch;
    if (!pinch) return;
    const center = record.touchCenter || { x: origin[0], y: origin[1] };
    if (!pinch.anchor) {
      pinch.startCenter = center;
      pinch.center = center;
      pinch.anchor = anchorAtPoint(record, center.x, center.y);
    }
    pinch.zoom = clamp(pinch.zoom * distance / previousDistance, MIN_ZOOM, MAX_ZOOM);
    pinch.center = center;
    if (pinch.frame === null) {
      pinch.frame = requestAnimationFrame(() => {
        if (!record.pinch) return;
        record.pinch.frame = null;
        showPinchPreview(record);
      });
    }
  };

  const pinchEnd = () => {
    const pinch = record.pinch;
    record.pinch = null;
    if (!pinch?.anchor) {
      record.interacting = false;
      return;
    }
    clearPinchPreview(record, pinch);
    applyZoom(record, pinch.zoom, pinch.center.x, pinch.center.y, pinch.anchor);
    record.interacting = false;
    invalidatePages(record);
  };

  const gestureStart = (event) => {
    event.preventDefault();
    if (record.pinch) return;
    record.interacting = true;
    record.tapCandidate = null;
    record.lastTap = null;
    record.suppressTapAfterPinch = true;
    const x = Number.isFinite(event.clientX) ? event.clientX : window.innerWidth / 2;
    const y = Number.isFinite(event.clientY) ? event.clientY : window.innerHeight / 2;
    record.gesture = {
      zoom: record.zoom,
      x,
      y,
      anchor: anchorAtPoint(record, x, y),
    };
  };

  const gestureChange = (event) => {
    event.preventDefault();
    if (!record.gesture || record.pinch) return;
    const x = Number.isFinite(event.clientX) ? event.clientX : record.gesture.x;
    const y = Number.isFinite(event.clientY) ? event.clientY : record.gesture.y;
    applyZoom(record, record.gesture.zoom * event.scale, x, y, record.gesture.anchor);
  };

  const gestureEnd = (event) => {
    event.preventDefault();
    if (!record.gesture) return;
    record.gesture = null;
    record.interacting = false;
    invalidatePages(record);
  };

  const doubleClick = (event) => {
    event.preventDefault();
    resetToOverview(record, event.clientX, event.clientY);
  };

  pages.addEventListener("touchstart", touchStart, { passive: true });
  pages.addEventListener("touchmove", touchMove, { passive: true });
  pages.addEventListener("touchend", touchEnd, { passive: false });
  pages.addEventListener("touchcancel", touchEnd, { passive: false });
  pages.addEventListener("dblclick", doubleClick);
  pages.addEventListener("gesturestart", gestureStart, { passive: false });
  pages.addEventListener("gesturechange", gestureChange, { passive: false });
  pages.addEventListener("gestureend", gestureEnd, { passive: false });
  const touchManager = new pdfjsLib.TouchManager({
    container: pages,
    onPinchStart: pinchStart,
    onPinching: pinching,
    onPinchEnd: pinchEnd,
    signal: new AbortController().signal,
  });

  record.removePinchZoom = () => {
    pages.removeEventListener("touchstart", touchStart);
    pages.removeEventListener("touchmove", touchMove);
    pages.removeEventListener("touchend", touchEnd);
    pages.removeEventListener("touchcancel", touchEnd);
    pages.removeEventListener("dblclick", doubleClick);
    pages.removeEventListener("gesturestart", gestureStart);
    pages.removeEventListener("gesturechange", gestureChange);
    pages.removeEventListener("gestureend", gestureEnd);
    touchManager.destroy();
  };
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
  record.removePinchZoom?.();
  record.pagesElement.style.removeProperty("--pdf-page-width");
  record.pagesElement.classList.remove("pdf-pinch-preview");
  record.pagesElement.querySelectorAll("canvas").forEach(clearCanvas);
  try {
    record.document?.destroy().catch(() => {});
  } catch {
    // A page can still be completing a render while its document is replaced.
  }
}

export async function showPdf(url, pagesElement, messageElement, loadingText = "Loading…", onLink = null) {
  const absoluteUrl = new URL(url, window.location.href).href;
  const existing = views.get(pagesElement);
  if (existing?.url === absoluteUrl) {
    existing.onLink = onLink;
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
    renderRevision: 0,
    overviewWidth: Math.min(availablePageWidth(pagesElement), 1100),
    zoom: MIN_ZOOM,
    interacting: false,
    pinch: null,
    gesture: null,
    touchCenter: null,
    suppressTapAfterPinch: false,
    tapCandidate: null,
    lastTap: null,
    onLink,
  };
  views.set(pagesElement, record);
  pagesElement.replaceChildren();
  setPageWidth(record);
  installPinchZoom(record);
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
  } catch (error) {
    if (views.get(pagesElement) !== record) return;
    console.error(error);
    if (messageElement) {
      messageElement.textContent = `This PDF could not be displayed: ${error.message || error}`;
    }
  }
}

export function resizePdf(pagesElement) {
  const record = views.get(pagesElement);
  if (!record) return;
  const overviewWidth = Math.min(availablePageWidth(pagesElement), 1100);
  if (Math.abs(overviewWidth - record.overviewWidth) < 1) return;
  record.overviewWidth = overviewWidth;
  setPageWidth(record);
  invalidatePages(record);
}

export function clearPdf(pagesElement, messageElement, text) {
  const existing = views.get(pagesElement);
  if (existing) dispose(existing);
  views.delete(pagesElement);
  pagesElement.replaceChildren();
  if (messageElement) messageElement.textContent = text;
}
