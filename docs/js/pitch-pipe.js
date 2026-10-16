// All sound is synthesized here; no recordings or third-party assets are used.
const NOTES = ["C", "C♯ / D♭", "D", "D♯ / E♭", "E", "F", "F♯ / G♭", "G", "G♯ / A♭", "A", "A♯ / B♭", "B"];
const STORAGE_KEY = "antiochian-chant-stand:pitch:v1";
const MAX_GAIN = 0.05; // At most -26 dBFS peak, including the harmonic.
const MAX_TEST_GAIN = 0.2; // Temporary, explicitly enabled calibration ceiling.
const DEFAULT_LEVEL = 20; // 0.01 gain (-40 dBFS peak).
const DURATION = 2;
const CALIBRATION_KEY = "antiochian-chant-stand:pitch-calibration:v1";
const AUDIO_LOG_KEY = "antiochian-chant-stand:pitch-audio-log:v1";
const DEFAULT_SOUND = { ceiling: MAX_GAIN, timbre: "soft", attack: 0.15, release: 0.2, duration: DURATION };
const CALIBRATION_OPTIONS = {
  ceiling: [0.005, 0.01, 0.025, MAX_GAIN, 0.1, MAX_TEST_GAIN], timbre: ["sine", "soft", "bright"],
  duration: [1.5, 2, 3, 4],
};
// Coefficient sums are at most 1, preserving the peak ceiling across timbres.
const TIMBRES = { sine: [0, 1], soft: [0, 0.94, 0.06], bright: [0, 0.78, 0.16, 0.06] };

export function initializePitchPipe() {
  const get = (id) => document.getElementById(id);
  const dialog = get("pitchPipeDialog");
  const trigger = get("pitchPipeButton");
  const play = get("pitchPlay");
  const volume = get("pitchVolume");
  const octave = get("pitchOctave");
  const status = get("pitchStatus");
  let note = 9;
  let context;
  let voice = null;
  let active = false;
  let generation = 0;
  let timer;
  let silenceUntil = 0;
  let clockTimer;
  const connectedVoices = new Set();
  let audioEvents = [];
  let contextId = 0;
  try {
    const saved = JSON.parse(localStorage.getItem(AUDIO_LOG_KEY));
    if (Array.isArray(saved)) audioEvents = saved.filter((entry) => typeof entry === "string").slice(-100).map((entry) => entry.slice(0, 2000));
  } catch { /* Diagnostics must never interfere with audio. */ }
  function logAudio(event, details = {}) {
    const entry = `${new Date().toISOString()} ${event} ${JSON.stringify({
      contextId, state: context?.state ?? "none", audioTime: context?.currentTime ?? null,
      generation, active, hasVoice: Boolean(voice), visibility: document.visibilityState,
      focused: document.hasFocus(), ...details,
    })}`;
    audioEvents.push(entry);
    audioEvents = audioEvents.slice(-100);
    get("pitchAudioLog").value = audioEvents.join("\n");
    try { localStorage.setItem(AUDIO_LOG_KEY, JSON.stringify(audioEvents)); }
    catch { get("pitchAudioLogHelp").textContent = "Browser storage unavailable. Select and copy this log before leaving the page. Nothing is uploaded."; }
  }
  get("pitchClearAudioLog").addEventListener("click", () => {
    audioEvents = [];
    logAudio("log cleared");
  });
  get("pitchCopyAudioLog").addEventListener("click", async () => {
    const output = get("pitchAudioLog");
    const text = output.value;
    try {
      await navigator.clipboard.writeText(text);
      get("pitchAudioLogStatus").textContent = "Log copied.";
    } catch {
      output.focus();
      output.select();
      output.setSelectionRange(0, output.value.length);
      // Local HTTP testing may lack the modern clipboard API entirely.
      try {
        if (document.execCommand("copy")) {
          get("pitchAudioLogStatus").textContent = "Log copied.";
          return;
        }
      } catch { /* Keep the text selected for manual copying. */ }
      get("pitchAudioLogStatus").textContent = "Automatic copy unavailable. Touch and hold the selected log, then choose Copy.";
    }
  });
  logAudio("page initialized", { diagnosticVersion: 2, userAgent: navigator.userAgent, secureContext: window.isSecureContext });
  let experiment = { ...DEFAULT_SOUND };
  const calibrationControls = Object.fromEntries(Object.keys(CALIBRATION_OPTIONS).map((key) =>
    [key, get(`pitch${key[0].toUpperCase()}${key.slice(1)}`)]));
  const comparison = get("pitchCompareDefaults");
  const louderTests = get("pitchEnableLouderTests");
  const calibrationStatus = get("pitchCalibrationStatus");
  const sound = () => {
    const settings = comparison.checked ? DEFAULT_SOUND : experiment;
    return { ...settings, ceiling: Math.min(settings.ceiling, louderTests.checked ? MAX_TEST_GAIN : MAX_GAIN) };
  };

  try {
    const saved = JSON.parse(localStorage.getItem(CALIBRATION_KEY));
    for (const key of Object.keys(CALIBRATION_OPTIONS)) {
      if (CALIBRATION_OPTIONS[key].includes(saved?.experiment?.[key])) experiment[key] = saved.experiment[key];
    }
    comparison.checked = saved?.compareDefaults === true;
  } catch {
    calibrationStatus.textContent = "Saved calibration unavailable. Using default settings.";
  }
  for (const [key, control] of Object.entries(calibrationControls)) control.value = String(experiment[key]);

  function saveCalibration() {
    try {
      localStorage.setItem(CALIBRATION_KEY, JSON.stringify({ experiment, compareDefaults: comparison.checked }));
    } catch {
      calibrationStatus.textContent = "Browser storage unavailable. Settings will only last for this page load.";
    }
  }

  function updateCalibration() {
    get("pitchExperiment").disabled = comparison.checked;
    const settings = sound();
    get("pitchCalibrationSummary").textContent = `${comparison.checked ? "Standard defaults" : "Experiment"}: ${settings.timbre}, effective ceiling ${settings.ceiling}, ${settings.duration} s.${!comparison.checked && experiment.ceiling > settings.ceiling ? " Higher ceiling saved; enable louder testing to use it." : ""}`;
  }

  function disconnectVoice(ended) {
    ended.oscillator.onended = null;
    ended.oscillator.disconnect();
    ended.envelope.disconnect();
    ended.gain.disconnect();
    connectedVoices.delete(ended);
  }

  function discardContext(reason) {
    const discarded = context;
    logAudio("context discarded", { reason });
    context = undefined; // Ignore late events from this context, even during close().
    for (const graph of connectedVoices) {
      disconnectVoice(graph);
      try { graph.oscillator.stop(); } catch { /* A failed start may leave an unstarted source. */ }
    }
    voice = null;
    silenceUntil = 0;
    stop(reason);
    if (discarded) {
      try { Promise.resolve(discarded.close()).catch((error) => logAudio("context close failed", { message: error?.message })); }
      catch (error) { logAudio("context close failed", { message: error?.message }); }
    }
  }

  volume.value = String(DEFAULT_LEVEL);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Number.isInteger(saved?.note) && saved.note >= 0 && saved.note < 12
        && [3, 4].includes(saved.octave)) {
      note = saved.note;
      octave.value = String(saved.octave);
    }
    if (Number.isInteger(saved?.volume) && saved.volume >= 0 && saved.volume <= 100) {
      volume.value = String(saved.volume);
    }
  } catch { /* Storage is optional. */ }
  get("pitchVolumeLabel").textContent = `${volume.value}%`;

  const selectedName = () => `${NOTES[note]}${octave.value}`;
  const selectedFrequency = () => 440 * 2 ** (((Number(octave.value) + 1) * 12 + note - 69) / 12);
  const selectedGain = () => Math.min(MAX_TEST_GAIN, sound().ceiling) * Math.max(0, Math.min(100, Number(volume.value) || 0)) / 100;

  function update() {
    play.textContent = active ? "Stop sound" : `Play ${selectedName()}`;
    play.dataset.active = String(active);
    get("pitchFrequency").textContent = `${selectedFrequency().toFixed(1)} Hz`;
    for (const [index, button] of [...get("pitchNotes").children].entries()) {
      button.setAttribute("aria-pressed", String(index === note));
    }
  }

  function stop(reason = "control change") {
    logAudio("stop", { reason: typeof reason === "string" ? reason : reason.type, nextGeneration: generation + 1 });
    generation += 1; // Invalidates any outstanding AudioContext.resume().
    clearTimeout(timer);
    clearTimeout(clockTimer);
    if (voice) {
      const ending = voice;
      voice = null;
      if (context.state === "running") {
        const now = context.currentTime;
        const gain = ending.gain.gain;
        const current = gain.value;
        gain.cancelScheduledValues(now);
        gain.setValueAtTime(current, now);
        silenceUntil = now + 0.008;
        gain.linearRampToValueAtTime(0, silenceUntil);
        ending.oscillator.onended = () => disconnectVoice(ending);
        ending.oscillator.stop(silenceUntil);
        // A frozen clock cannot finish the fade or fire onended. Never leave
        // that source connected for a later, unexpected recovery.
        setTimeout(() => { if (connectedVoices.has(ending)) disconnectVoice(ending); }, 30);
      } else {
        // An interrupted audio clock cannot finish a fade; disconnect now.
        disconnectVoice(ending);
        ending.oscillator.stop();
      }
    }
    active = false;
    status.textContent = `${sound().duration}-second tone · A4 = 440 Hz`;
    update();
  }

  function savePreferences() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        note, octave: Number(octave.value), volume: Number(volume.value),
      }));
    } catch { /* Preferences still apply for this page load without storage. */ }
  }

  function choose() {
    stop();
    savePreferences();
  }

  NOTES.forEach((name, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = name;
    button.addEventListener("click", () => { note = index; choose(); });
    get("pitchNotes").append(button);
  });
  octave.addEventListener("change", choose);

  let previousCeiling = sound().ceiling;
  function changeCalibration() {
    stop();
    for (const [key, control] of Object.entries(calibrationControls)) {
      const value = key === "timbre" ? control.value : Number(control.value);
      experiment[key] = CALIBRATION_OPTIONS[key].includes(value) ? value : DEFAULT_SOUND[key];
    }
    if (sound().ceiling > previousCeiling) {
      volume.value = String(Math.min(Number(volume.value), DEFAULT_LEVEL));
      get("pitchVolumeLabel").textContent = `${volume.value}%`;
      savePreferences();
      calibrationStatus.textContent = "Higher ceiling selected. Tone level limited to 20% or less; tap Play when ready.";
    }
    previousCeiling = sound().ceiling;
    saveCalibration();
    updateCalibration();
    stop();
  }
  for (const control of Object.values(calibrationControls)) control.addEventListener("change", changeCalibration);
  comparison.addEventListener("change", changeCalibration);
  louderTests.addEventListener("change", changeCalibration);
  get("pitchResetCalibration").addEventListener("click", () => {
    stop();
    experiment = { ...DEFAULT_SOUND };
    comparison.checked = false;
    louderTests.checked = false;
    for (const [key, control] of Object.entries(calibrationControls)) control.value = String(experiment[key]);
    volume.value = String(DEFAULT_LEVEL);
    get("pitchVolumeLabel").textContent = `${DEFAULT_LEVEL}%`;
    previousCeiling = MAX_GAIN;
    savePreferences();
    calibrationStatus.textContent = "Standard sound and quiet 20% level restored.";
    saveCalibration();
    updateCalibration();
    stop();
  });
  updateCalibration();

  volume.addEventListener("input", () => {
    get("pitchVolumeLabel").textContent = `${volume.value}%`;
    savePreferences();
    if (voice) {
      const now = context.currentTime;
      const gain = voice.gain.gain;
      const target = selectedGain();
      // Compare with the actual gain, including an in-progress transition.
      // Exponential smoothing reaches 95% in ~150 ms up / ~9 ms down.
      // The separate envelope and two-second stop remain untouched.
      gain.setTargetAtTime(target, now, target > gain.value ? 0.05 : 0.003);
    }
  });

  play.addEventListener("click", async () => {
    logAudio("Play/Stop tapped", { outputGain: selectedGain(), pitch: selectedName() });
    if (active) { stop("Stop tapped"); return; }
    if (selectedGain() === 0) { logAudio("play muted"); status.textContent = "Tone level is muted."; return; }
    if (context && context.state !== "running") discardContext("stale context before Play");
    const request = ++generation;
    active = true; // Stop remains available even while audio is initializing.
    update();
    status.textContent = "Starting…";
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error("Web Audio unavailable");
      if (!context || context.state === "closed") {
        context = new AudioContext();
        contextId += 1;
        silenceUntil = 0;
        logAudio("context created", { request });
        const created = context;
        created.addEventListener("statechange", () => {
          if (context !== created) return;
          logAudio("context statechange");
          // A resume may pass through interrupted/suspended. Give that explicit
          // request time to settle; interruptions of existing audio invalidate it.
          if (created.state !== "running" && (voice || !active || created.state === "closed")) {
            discardContext("non-running statechange");
          }
        });
      }
      // Called directly from the gesture for iOS/Android autoplay policies.
      logAudio("resume requested", { request });
      const playingContext = context;
      const pendingTimer = setTimeout(() => {
        logAudio("resume still pending after 1500 ms", { request });
        if (request === generation && context === playingContext) {
          discardContext("resume timed out");
          status.textContent = "Audio did not wake up. Tap Play to try again.";
        }
      }, 1500);
      try { await playingContext.resume(); }
      finally { clearTimeout(pendingTimer); }
      logAudio("resume fulfilled", { request });
      if (request !== generation || !dialog.open || document.hidden) {
        logAudio("play canceled after resume", { request, requestInvalidated: request !== generation, dialogOpen: dialog.open, hidden: document.hidden });
        return;
      }
      if (context.state !== "running") throw new Error("Audio interrupted");
      // A rapid restart must not overlap the previous tone's brief stop fade.
      const now = Math.max(context.currentTime, silenceUntil);
      const settings = { ...sound() };
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      const gain = context.createGain();
      // Coefficient sum is 1: the wave cannot exceed unit peak amplitude.
      const coefficients = TIMBRES[settings.timbre];
      oscillator.setPeriodicWave(context.createPeriodicWave(
        new Float32Array(coefficients.length), new Float32Array(coefficients),
        { disableNormalization: true }
      ));
      oscillator.frequency.setValueAtTime(selectedFrequency(), now);
      gain.gain.setValueAtTime(selectedGain(), now);
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime(1, now + settings.attack);
      envelope.gain.setValueAtTime(1, now + settings.duration - settings.release);
      envelope.gain.linearRampToValueAtTime(0, now + settings.duration);
      oscillator.connect(envelope);
      envelope.connect(gain);
      gain.connect(context.destination);
      voice = { oscillator, envelope, gain };
      connectedVoices.add(voice);
      const playing = voice;
      oscillator.onended = () => {
        logAudio("oscillator ended", { request });
        disconnectVoice(playing);
        if (request === generation) { voice = null; stop("tone ended"); }
      };
      oscillator.start(now);
      oscillator.stop(now + settings.duration); // Audio-clock limit, never beyond 4 seconds.
      timer = setTimeout(() => { if (request === generation) stop("duration timer"); }, settings.duration * 1000 + 100);
      logAudio("tone scheduled", { request, startTime: now, endTime: now + settings.duration, outputGain: selectedGain(), settings });
      clockTimer = setTimeout(() => {
        if (request !== generation || context !== playingContext) return;
        const advancedSeconds = playingContext.currentTime - now;
        logAudio("audio clock check", { request, advancedSeconds });
        if (advancedSeconds <= 0) {
          discardContext("audio clock stalled");
          status.textContent = "Audio did not wake up. Tap Play to try again.";
        }
      }, 500);
      status.textContent = `Playing ${selectedName()} · stops after ${settings.duration} seconds`;
    } catch (error) {
      logAudio("play error", { request, name: error?.name, message: error?.message });
      if (request !== generation) return;
      discardContext("play error");
      status.textContent = "Audio unavailable or interrupted. Tap Play to try again.";
    }
  });

  trigger.setAttribute("aria-expanded", "false");
  trigger.addEventListener("click", () => {
    stop("dialog opened");
    louderTests.checked = false;
    previousCeiling = sound().ceiling;
    updateCalibration();
    dialog.showModal();
    trigger.setAttribute("aria-expanded", "true");
    get("closePitchPipe").focus(); // Enter after opening cannot accidentally play.
  });
  function close() { stop("dialog close requested"); dialog.close(); }
  get("closePitchPipe").addEventListener("click", close);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener("cancel", stop);
  dialog.addEventListener("close", () => { stop("dialog closed"); trigger.setAttribute("aria-expanded", "false"); });
  document.addEventListener("visibilitychange", () => {
    logAudio("visibilitychange");
    if (document.hidden) discardContext("page hidden");
  });
  window.addEventListener("focus", () => logAudio("window focus"));
  window.addEventListener("pageshow", (event) => logAudio("pageshow", { persisted: event.persisted }));
  window.addEventListener("blur", () => discardContext("blur"));
  window.addEventListener("pagehide", () => discardContext("pagehide"));
  window.addEventListener("popstate", close);
  update();
}
