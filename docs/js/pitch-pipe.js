// All sound is synthesized here; no recordings or third-party assets are used.
const NOTES = ["C", "C♯ / D♭", "D", "D♯ / E♭", "E", "F", "F♯ / G♭", "G", "G♯ / A♭", "A", "A♯ / B♭", "B"];
const STORAGE_KEY = "antiochian-chant-stand:pitch:v1";
const MAX_GAIN = 0.05; // At most -26 dBFS peak, including the harmonic.
const DEFAULT_LEVEL = 20; // 0.01 gain (-40 dBFS peak).
const DURATION = 2;

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

  function disconnectVoice(ended) {
    ended.oscillator.onended = null;
    ended.oscillator.disconnect();
    ended.envelope.disconnect();
    ended.gain.disconnect();
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
  const selectedGain = () => MAX_GAIN * Math.max(0, Math.min(100, Number(volume.value) || 0)) / 100;

  function update() {
    play.textContent = active ? "Stop sound" : `Play ${selectedName()}`;
    play.dataset.active = String(active);
    get("pitchFrequency").textContent = `${selectedFrequency().toFixed(1)} Hz`;
    for (const [index, button] of [...get("pitchNotes").children].entries()) {
      button.setAttribute("aria-pressed", String(index === note));
    }
  }

  function stop() {
    generation += 1; // Invalidates any outstanding AudioContext.resume().
    clearTimeout(timer);
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
      } else {
        // An interrupted audio clock cannot finish a fade; disconnect now.
        disconnectVoice(ending);
        ending.oscillator.stop();
      }
    }
    active = false;
    status.textContent = "Two-second tone · A4 = 440 Hz";
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
    const request = ++generation;
    active = true; // Stop remains available even while audio is initializing.
    update();
    status.textContent = "Starting…";
    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error("Web Audio unavailable");
      if (!context || context.state === "closed") {
        context = new AudioContext();
        context.addEventListener("statechange", () => {
          if (context.state !== "running") stop();
        });
      }
      // Called directly from the gesture for iOS/Android autoplay policies.
      await context.resume();
      if (request !== generation || !dialog.open || document.hidden) return;
      if (context.state !== "running") throw new Error("Audio interrupted");
      // A rapid restart must not overlap the previous tone's brief stop fade.
      const now = Math.max(context.currentTime, silenceUntil);
      const oscillator = context.createOscillator();
      const envelope = context.createGain();
      const gain = context.createGain();
      // Coefficient sum is 1: the wave cannot exceed unit peak amplitude.
      oscillator.setPeriodicWave(context.createPeriodicWave(
        new Float32Array([0, 0, 0]), new Float32Array([0, 0.94, 0.06]),
        { disableNormalization: true }
      ));
      oscillator.frequency.setValueAtTime(selectedFrequency(), now);
      gain.gain.setValueAtTime(selectedGain(), now);
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime(1, now + 0.15);
      envelope.gain.setValueAtTime(1, now + DURATION - 0.2);
      envelope.gain.linearRampToValueAtTime(0, now + DURATION);
      oscillator.connect(envelope);
      envelope.connect(gain);
      gain.connect(context.destination);
      voice = { oscillator, envelope, gain };
      const playing = voice;
      oscillator.onended = () => {
        disconnectVoice(playing);
        if (request === generation) { voice = null; stop(); }
      };
      oscillator.start(now);
      oscillator.stop(now + DURATION); // Audio-clock limit, independent of timers.
      timer = setTimeout(() => { if (request === generation) stop(); }, DURATION * 1000 + 100);
      status.textContent = `Playing ${selectedName()} · stops after two seconds`;
    } catch {
      if (request !== generation) return;
      stop();
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
  document.addEventListener("visibilitychange", () => { if (document.hidden) stop(); });
  window.addEventListener("blur", stop);
  window.addEventListener("pagehide", stop);
  window.addEventListener("popstate", close);
  update();
}
