import { clearPdf, resizePdf, showPdf } from "./pdf-viewer.js?v=2aec3019bc5d";

const elements = Object.fromEntries(
  [
    "schedule", "scheduleLabel", "previousDay", "dateSelect", "nextDay", "dateLabel", "previousService",
    "nextService", "serviceTabs", "previousMusic", "nextMusic",
    "musicSelect", "musicPosition", "settingButton", "settingsDialog",
    "closeSettings", "settings", "viewToggle", "notesIcon", "musicIcon", "musicPages", "notesPages", "message",
  ].map((id) => [id, document.getElementById(id)])
);

let services = [];
let datedDays = [];
let serviceIndex = -1;
let musicIndex = 0;
let settingIndex = 0;
let viewMode = "music";
let activeMusicUrl = null;
let activeNotesUrl = null;
const savedPositions = new Map();
let viewportWidth = window.innerWidth;
let scrollFrame = null;
let resizeTimer = null;
let restoreGeneration = 0;
let restoringPosition = false;

// Earlier entries win. Settings not listed here keep their source-document order.
const PREFERRED_SETTINGS = ["STAM", "CROW", "KARAM", "EL MASSIH", "CHANT"];

function preferredSettingIndex(piece) {
  if (!piece?.links.length) return 0;
  let bestIndex = 0;
  let bestRank = Infinity;
  piece.links.forEach((link, index) => {
    const rank = PREFERRED_SETTINGS.indexOf(link.setting.toUpperCase());
    if (rank >= 0 && rank < bestRank) {
      bestIndex = index;
      bestRank = rank;
    }
  });
  return bestIndex;
}

const localDate = () => {
  const now = new Date();
  return [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
};

const servicesOn = (day) => services.filter((service) => service.date === day);

function formatDay(value) {
  if (!value) return "Other music";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

function chooseInitialService() {
  if (!services.length) return -1;
  const todayServices = servicesOn(localDate());
  if (todayServices.length) {
    const preferred = todayServices.find((service) => service.type === "ORTHROS") || todayServices[0];
    return services.indexOf(preferred);
  }
  const dated = services.filter((service) => service.date);
  const future = dated.find((service) => service.date > localDate());
  return services.indexOf(future || dated[dated.length - 1] || services[0]);
}

function setService(index, preferredTitle = null) {
  rememberPosition(viewMode);
  serviceIndex = index;
  const music = services[serviceIndex]?.music || [];
  const matchingIndex = preferredTitle
    ? music.findIndex((piece) => piece.title === preferredTitle)
    : -1;
  musicIndex = matchingIndex >= 0 ? matchingIndex : 0;
  settingIndex = preferredSettingIndex(music[musicIndex]);
  render();
}

function selectDay(day) {
  const service = services[serviceIndex];
  const candidates = servicesOn(day);
  if (!candidates.length) return;
  const sameType = candidates.find((item) => item.type === service?.type);
  setService(services.indexOf(sameType || candidates[0]));
}

function moveDay(offset) {
  const service = services[serviceIndex];
  const currentDayIndex = datedDays.indexOf(service?.date);
  const newDay = datedDays[currentDayIndex + offset];
  if (!newDay) return;
  selectDay(newDay);
}

function moveService(offset) {
  const target = services[serviceIndex + offset];
  if (target) {
    setService(services.indexOf(target));
  }
}

function moveMusic(offset) {
  const music = services[serviceIndex]?.music || [];
  if (!music.length) return;
  rememberPosition("music");
  musicIndex = (musicIndex + offset + music.length) % music.length;
  settingIndex = preferredSettingIndex(music[musicIndex]);
  render();
}

function pagesFor(mode) {
  return mode === "notes" ? elements.notesPages : elements.musicPages;
}

function urlFor(mode) {
  return mode === "notes" ? activeNotesUrl : activeMusicUrl;
}

function rememberPosition(mode) {
  const pages = pagesFor(mode);
  const url = urlFor(mode);
  if (!url || pages.hidden) return;
  const shells = [...pages.querySelectorAll(".pdf-page-shell")];
  if (!shells.length) return;

  // Anchor the first unobscured line to a page and a proportional position in
  // that page. Unlike a raw pixel offset, this remains meaningful when tablet
  // rotation changes the rendered page height.
  const readingLine = document.querySelector(".controls").getBoundingClientRect().bottom;
  let shell = null;
  for (const candidate of shells) {
    if (candidate.getBoundingClientRect().top > readingLine) break;
    shell = candidate;
  }

  if (!shell) {
    savedPositions.set(url, { page: 0, offset: window.scrollY });
    return;
  }

  const bounds = shell.getBoundingClientRect();
  savedPositions.set(url, {
    page: Number(shell.dataset.page),
    progress: bounds.height ? (readingLine - bounds.top) / bounds.height : 0,
  });
}

function restorePosition(mode, url) {
  const pages = pagesFor(mode);
  const generation = ++restoreGeneration;
  restoringPosition = true;
  if (viewMode !== mode || urlFor(mode) !== url) {
    restoringPosition = false;
    return;
  }

  // Restore before the browser paints the newly selected view. Waiting for
  // animation frames here exposes the scroll clamp caused by hiding a long
  // document, which looks like the PDF flashing over the sticky controls.
  const savedPosition = savedPositions.get(url);
  let top = 0;
  if (savedPosition?.page === 0) {
    top = savedPosition.offset;
  } else if (savedPosition) {
    const shell = pages.querySelector(`[data-page="${savedPosition.page}"]`);
    if (shell) {
      const readingLine = document.querySelector(".controls").getBoundingClientRect().bottom;
      const bounds = shell.getBoundingClientRect();
      top = window.scrollY + bounds.top
        + savedPosition.progress * bounds.height - readingLine;
    }
  }
  window.scrollTo({ top });
  requestAnimationFrame(() => {
    if (generation !== restoreGeneration) return;
    restoringPosition = false;
    rememberPosition(mode);
  });
}

window.addEventListener("scroll", () => {
  if (restoringPosition || resizeTimer !== null || window.innerWidth !== viewportWidth) return;
  if (scrollFrame !== null) cancelAnimationFrame(scrollFrame);
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    if (!restoringPosition && window.innerWidth === viewportWidth) rememberPosition(viewMode);
  });
}, { passive: true });

window.addEventListener("resize", () => {
  if (window.innerWidth === viewportWidth && resizeTimer === null) return;
  restoringPosition = true;
  if (scrollFrame !== null) {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = null;
  }
  if (resizeTimer !== null) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    viewportWidth = window.innerWidth;
    resizePdf(elements.musicPages);
    resizePdf(elements.notesPages);
    const url = urlFor(viewMode);
    if (url) restorePosition(viewMode, url);
    else restoringPosition = false;
  }, 100);
});

function loadView(url, mode, loadingText) {
  const pages = pagesFor(mode);
  const message = viewMode === mode ? elements.message : null;
  const onLink = mode === "notes" ? selectMusicLink : null;
  showPdf(url, pages, message, loadingText, onLink).then(() => {
    if (viewMode === mode) restorePosition(mode, url);
  });
}

function normalizedUrl(value) {
  try {
    return new URL(value, window.location.href).href;
  } catch {
    return value;
  }
}

function selectMusicLink(annotation) {
  const music = services[serviceIndex]?.music || [];
  const candidates = [];
  music.forEach((piece, pieceIndex) => {
    piece.links.forEach((link, linkIndex) => {
      if (normalizedUrl(link.sourceUrl) === normalizedUrl(annotation.url)) {
        candidates.push({ link, pieceIndex, linkIndex });
      }
    });
  });
  if (!candidates.length) return false;

  const samePage = candidates.filter(({ link }) => link.sourcePage === annotation.page);
  const matches = samePage.length ? samePage : candidates;
  const selected = matches.reduce((closest, candidate) => {
    if (candidate.link.sourceTop == null || annotation.top == null) return closest;
    if (closest.link.sourceTop == null) return candidate;
    return Math.abs(candidate.link.sourceTop - annotation.top)
      < Math.abs(closest.link.sourceTop - annotation.top) ? candidate : closest;
  });

  setViewMode("music");
  musicIndex = selected.pieceIndex;
  settingIndex = selected.linkIndex;
  render();
  return true;
}

function setViewMode(nextMode) {
  if (nextMode === viewMode) return;
  rememberPosition(viewMode);
  pagesFor(viewMode).hidden = true;
  viewMode = nextMode;
  pagesFor(viewMode).hidden = false;
  document.body.classList.toggle("notes-mode", viewMode === "notes");
  const toggleLabel = viewMode === "notes" ? "Return to music" : "Show service notes";
  elements.notesIcon.toggleAttribute("hidden", viewMode === "notes");
  elements.musicIcon.toggleAttribute("hidden", viewMode !== "notes");
  elements.viewToggle.setAttribute("aria-label", toggleLabel);
  elements.viewToggle.title = toggleLabel;
}

function switchView() {
  const nextMode = viewMode === "music" ? "notes" : "music";
  const service = services[serviceIndex];
  const piece = service?.music[musicIndex];
  if (nextMode === "notes" && !service?.url) return;
  if (nextMode === "music" && !piece?.links[settingIndex]) return;

  setViewMode(nextMode);

  const url = viewMode === "notes" ? `./${service.url}` : `./${piece.links[settingIndex].url}`;
  if (viewMode === "notes") activeNotesUrl = url;
  else activeMusicUrl = url;
  loadView(url, viewMode, viewMode === "notes" ? "Loading notes…" : "Loading music…");
}

function render() {
  const service = services[serviceIndex];
  if (!service) {
    clearPdf(elements.musicPages, elements.message, "No services are available yet.");
    clearPdf(elements.notesPages, null, "");
    return;
  }
  const dayPosition = datedDays.indexOf(service.date);
  const piece = service.music[musicIndex];
  elements.viewToggle.disabled = !service.url;

  elements.dateLabel.textContent = formatDay(service.date);
  elements.dateSelect.value = service.date || "";
  const compactDay = service.date === localDate() ? "Today" : formatDay(service.date);
  elements.scheduleLabel.textContent = `${compactDay} · ${service.label}`;
  elements.serviceTabs.replaceChildren(
    ...servicesOn(service.date).map((item) => {
      const selected = item === service;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `service-tab${selected ? " selected" : ""}`;
      button.textContent = item.label;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.addEventListener("click", () => setService(services.indexOf(item)));
      return button;
    })
  );
  elements.previousDay.disabled = dayPosition <= 0;
  elements.nextDay.disabled = dayPosition < 0 || dayPosition >= datedDays.length - 1;
  elements.previousService.disabled = serviceIndex <= 0;
  elements.nextService.disabled = serviceIndex >= services.length - 1;
  const previousService = services[serviceIndex - 1];
  const nextService = services[serviceIndex + 1];
  elements.previousService.setAttribute(
    "aria-label",
    previousService ? `Previous service: ${previousService.label}, ${formatDay(previousService.date)}` : "Previous service"
  );
  elements.nextService.setAttribute(
    "aria-label",
    nextService ? `Next service: ${nextService.label}, ${formatDay(nextService.date)}` : "Next service"
  );

  elements.musicSelect.replaceChildren(
    ...service.music.map((item, index) => {
      const option = new Option(`${index + 1}. ${item.title}`, String(index), false, index === musicIndex);
      return option;
    })
  );
  elements.musicSelect.disabled = !service.music.length;
  elements.musicPosition.textContent = service.music.length
    ? `${musicIndex + 1} of ${service.music.length}`
    : "No linked music in this service";
  elements.previousMusic.disabled = !service.music.length;
  elements.nextMusic.disabled = !service.music.length;
  elements.settings.replaceChildren();

  if (viewMode === "notes" && service.url) {
    const notesUrl = `./${service.url}`;
    activeNotesUrl = notesUrl;
    loadView(notesUrl, "notes", "Loading notes…");
  }

  if (!piece) {
    elements.settingButton.hidden = true;
    if (elements.settingsDialog.open) elements.settingsDialog.close();
    clearPdf(
      elements.musicPages,
      viewMode === "music" ? elements.message : null,
      "No linked music was found in this service."
    );
    updateUrl();
    return;
  }

  elements.settingButton.hidden = piece.links.length < 2;
  elements.settingButton.textContent = `${piece.links[settingIndex].setting} ▾`;
  elements.settingButton.setAttribute(
    "aria-label",
    `Setting: ${piece.links[settingIndex].setting}. Choose another setting`
  );

  piece.links.forEach((link, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `setting${index === settingIndex ? " selected" : ""}`;
    button.textContent = link.setting;
    button.setAttribute("aria-pressed", String(index === settingIndex));
    button.addEventListener("click", () => {
      rememberPosition("music");
      settingIndex = index;
      elements.settingsDialog.close();
      render();
    });
    elements.settings.append(button);
  });
  const musicUrl = `./${piece.links[settingIndex].url}`;
  activeMusicUrl = musicUrl;
  loadView(musicUrl, "music", "Loading music…");

  updateUrl();
}

function updateUrl() {
  const service = services[serviceIndex];
  if (!service) return;
  const parameters = new URLSearchParams({ date: service.date || "", service: service.type, music: String(musicIndex) });
  history.replaceState(null, "", `${location.pathname}?${parameters}`);
}

function restoreUrlChoice() {
  const parameters = new URLSearchParams(location.search);
  const day = parameters.get("date");
  const type = parameters.get("service");
  const match = services.findIndex((service) => service.date === day && service.type === type);
  if (match < 0) return;
  serviceIndex = match;
  const requestedMusic = Number(parameters.get("music"));
  const lastMusic = Math.max(services[match].music.length - 1, 0);
  musicIndex = Number.isInteger(requestedMusic) ? Math.min(Math.max(requestedMusic, 0), lastMusic) : 0;
}

elements.previousDay.addEventListener("click", () => moveDay(-1));
elements.nextDay.addEventListener("click", () => moveDay(1));
elements.dateSelect.addEventListener("change", (event) => selectDay(event.target.value));
elements.previousService.addEventListener("click", () => moveService(-1));
elements.nextService.addEventListener("click", () => moveService(1));
elements.previousMusic.addEventListener("click", () => moveMusic(-1));
elements.nextMusic.addEventListener("click", () => moveMusic(1));
elements.musicSelect.addEventListener("change", (event) => {
  rememberPosition("music");
  musicIndex = Number(event.target.value);
  settingIndex = preferredSettingIndex(services[serviceIndex]?.music[musicIndex]);
  render();
});
elements.settingButton.addEventListener("click", () => elements.settingsDialog.showModal());
elements.closeSettings.addEventListener("click", () => elements.settingsDialog.close());
elements.settingsDialog.addEventListener("click", (event) => {
  if (event.target === elements.settingsDialog) elements.settingsDialog.close();
});
elements.viewToggle.addEventListener("click", switchView);
try {
  const response = await fetch("./data/music.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`music.json returned ${response.status}`);
  const data = await response.json();
  services = data.services || [];
  datedDays = [...new Set(services.map((service) => service.date).filter(Boolean))];
  elements.dateSelect.replaceChildren(
    ...datedDays.map((day) => new Option(
      day === localDate() ? `Today — ${formatDay(day)}` : formatDay(day),
      day
    ))
  );
  serviceIndex = chooseInitialService();
  restoreUrlChoice();
  settingIndex = preferredSettingIndex(services[serviceIndex]?.music[musicIndex]);
  render();
} catch (error) {
  console.error(error);
  clearPdf(elements.musicPages, elements.message, "The music library could not be loaded. Try reloading the page.");
}
