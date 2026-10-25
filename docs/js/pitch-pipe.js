// All sound is synthesized here; no recordings or third-party assets are used.
const NOTES = ["C", "C♯ / D♭", "D", "D♯ / E♭", "E", "F", "F♯ / G♭", "G", "G♯ / A♭", "A", "A♯ / B♭", "B"];
const STORAGE_KEY = "antiochian-chant-stand:pitch:v3";
const PREVIOUS_STORAGE_KEY = "antiochian-chant-stand:pitch:v2";
const LEGACY_STORAGE_KEY = "antiochian-chant-stand:pitch:v1";
const DEFAULT_LEVEL = 1; // Quiet initial output; the slider can reach unity gain.
const DURATION = 2;
const ATTACK = 0.15;
const RELEASE = 0.2;
// Coefficient sums are at most 1, keeping both waveforms within unit amplitude.
const LOW_TIMBRE = [0, 0.78, 0.16, 0.06];
const HIGH_TIMBRE = [0, 0.94, 0.06];

export function initializePitchPipe() {
  const get = (id) => document.getElementById(id);
  const dialog = get("pitchPipeDialog");
  const trigger = get("pitchPipeButton");
  const play = get("pitchPlay");
  const volume = get("pitchVolume");
  const octaveButtons = get("pitchOctaves").querySelectorAll("button");
  let octave = 4;
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
  // Discard settings from the retired temporary calibration/debug tools.
  try {
    localStorage.removeItem("antiochian-chant-stand:pitch-audio-log:v1");
    localStorage.removeItem("antiochian-chant-stand:pitch-calibration:v1");
  } catch { /* Storage is optional. */ }

  function disconnectVoice(ended) {
    ended.oscillator.onended = null;
    ended.oscillator.disconnect();
    ended.envelope.disconnect();
    ended.gain.disconnect();
    connectedVoices.delete(ended);
  }

  function discardContext() {
    const discarded = context;
    context = undefined; // Ignore late events from this context, even during close().
    for (const graph of connectedVoices) {
      disconnectVoice(graph);
      try { graph.oscillator.stop(); } catch { /* A failed start may leave an unstarted source. */ }
    }
    voice = null;
    silenceUntil = 0;
    stop();
    if (discarded) {
      try { Promise.resolve(discarded.close()).catch(() => {}); }
      catch { /* Nodes are already disconnected, even if closing fails. */ }
    }
  }

  volume.value = String(DEFAULT_LEVEL);
  try {
    const current = localStorage.getItem(STORAGE_KEY);
    const previous = localStorage.getItem(PREVIOUS_STORAGE_KEY);
    const saved = JSON.parse(current ?? previous ?? localStorage.getItem(LEGACY_STORAGE_KEY));
    if (Number.isInteger(saved?.note) && saved.note >= 0 && saved.note < 12) note = saved.note;
    // Existing users get the new octave-4 default once; later choices persist.
    if ((current !== null || previous !== null) && [3, 4].includes(saved?.octave)) octave = saved.octave;
    if (Number.isInteger(saved?.volume) && saved.volume >= 0 && saved.volume <= 100) {
      let level = saved.volume;
      if (current === null && level > 0) {
        // Translate the old cap and pitch attenuation into the new slider once.
        const pitchGain = Math.min(1, 2 ** ((60 - ((octave + 1) * 12 + note)) / 12));
        const oldLevel = previous !== null ? level : Math.floor(level / 4);
        level = Math.max(1, Math.floor(oldLevel * 0.2 * pitchGain));
      }
      volume.value = String(level);
    }
  } catch { /* Storage is optional. */ }
  get("pitchVolumeLabel").textContent = `${volume.value}%`;

  const selectedName = () => `${NOTES[note]}${octave}`;
  const selectedFrequency = () => 440 * 2 ** (((octave + 1) * 12 + note - 69) / 12);
  // 100% is unity gain; device/OS volume controls the final speaker level.
  const selectedGain = () => Math.max(0, Math.min(100, Number(volume.value) || 0)) / 100;

  function update() {
    play.textContent = active ? "Stop sound" : `Play ${selectedName()}`;
    play.dataset.active = String(active);
    get("pitchFrequency").textContent = `${selectedFrequency().toFixed(1)} Hz`;
    for (const button of octaveButtons) button.setAttribute("aria-pressed", String(Number(button.dataset.octave) === octave));
    for (const [index, button] of [...get("pitchNotes").children].entries()) {
      button.setAttribute("aria-pressed", String(index === note));
    }
  }

  function stop() {
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
    status.textContent = "";
    update();
  }

  function savePreferences() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        note, octave: octave, volume: Number(volume.value),
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
  for (const button of octaveButtons) {
    button.addEventListener("click", () => { octave = Number(button.dataset.octave); choose(); });
  }
  savePreferences(); // Persist the migrated level and new default octave once.

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
    if (active) { stop(); return; }
    if (selectedGain() === 0) { status.textContent = "Tone level is muted."; return; }
    if (context && context.state !== "running") discardContext();
    const request = ++generation;
    active = true; // Stop remains available even while audio is initializing.
    update();
    status.textContent = "Starting…";
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error("Web Audio unavailable");
      if (!context || context.state === "closed") {
        context = new AudioContext();
        silenceUntil = 0;
        const created = context;
        created.addEventListener("statechange", () => {
          if (context !== created) return;
          // A resume may pass through interrupted/suspended. Give that explicit
          // request time to settle; interruptions of existing audio invalidate it.
          if (created.state !== "running" && (voice || !active || created.state === "closed")) {
            discardContext();
          }
        });
      }
      // Called directly from the gesture for iOS/Android autoplay policies.
      const playingContext = context;
      const pendingTimer = setTimeout(() => {
        if (request === generation && context === playingContext) {
          discardContext();
          status.textContent = "Audio did not wake up. Tap Play to try again.";
        }
      }, 1500);
      try { await playingContext.resume(); }
      finally { clearTimeout(pendingTimer); }
      if (request !== generation || !dialog.open || document.hidden) {
        return;
      }
      if (context.state !== "running") throw new Error("Audio interrupted");
      // A rapid restart must not overlap the previous tone's brief stop fade.
      const now = Math.max(context.currentTime, silenceUntil);
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      const gain = context.createGain();
      // Coefficient sum is 1: the wave cannot exceed unit peak amplitude.
      // Extra harmonics help the lower octave speak through small speakers.
      const coefficients = octave === 3 ? LOW_TIMBRE : HIGH_TIMBRE;
      oscillator.setPeriodicWave(context.createPeriodicWave(
        new Float32Array(coefficients.length), new Float32Array(coefficients),
        { disableNormalization: true }
      ));
      oscillator.frequency.setValueAtTime(selectedFrequency(), now);
      gain.gain.setValueAtTime(selectedGain(), now);
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime(1, now + ATTACK);
      envelope.gain.setValueAtTime(1, now + DURATION - RELEASE);
      envelope.gain.linearRampToValueAtTime(0, now + DURATION);
      oscillator.connect(envelope);
      envelope.connect(gain);
      gain.connect(context.destination);
      voice = { oscillator, envelope, gain };
      connectedVoices.add(voice);
      const playing = voice;
      oscillator.onended = () => {
        disconnectVoice(playing);
        if (request === generation) { voice = null; stop(); }
      };
      oscillator.start(now);
      oscillator.stop(now + DURATION); // Audio-clock limit, independent of JavaScript timers.
      timer = setTimeout(() => { if (request === generation) stop(); }, DURATION * 1000 + 100);
      clockTimer = setTimeout(() => {
        if (request !== generation || context !== playingContext) return;
        const advancedSeconds = playingContext.currentTime - now;
        if (advancedSeconds <= 0) {
          discardContext();
          status.textContent = "Audio did not wake up. Tap Play to try again.";
        }
      }, 500);
      status.textContent = `Playing ${selectedName()} · stops after ${DURATION} seconds`;
    } catch {
      if (request !== generation) return;
      discardContext();
      status.textContent = "Audio unavailable or interrupted. Tap Play to try again.";
    }
  });

  trigger.setAttribute("aria-expanded", "false");
  trigger.addEventListener("click", () => {
    stop();
    dialog.showModal();
    trigger.setAttribute("aria-expanded", "true");
    get("closePitchPipe").focus(); // Enter after opening cannot accidentally play.
  });
  function close() { stop(); dialog.close(); }
  get("closePitchPipe").addEventListener("click", close);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) close(); });
  dialog.addEventListener("cancel", stop);
  dialog.addEventListener("close", () => { stop(); trigger.setAttribute("aria-expanded", "false"); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) discardContext();
  });
  window.addEventListener("blur", () => discardContext());
  window.addEventListener("pagehide", () => discardContext());
  window.addEventListener("popstate", close);
  update();
}
