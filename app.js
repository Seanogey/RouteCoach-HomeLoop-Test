'use strict';

const DATA_FILE       = 'home_loop_points.json';
const SIM_INTERVAL_MS = 3000;   // ms between simulated arrivals

// ── State ─────────────────────────────────────────────────────────────────────
let points = [];

let state = {
  mode:          'idle',   // 'idle' | 'live' | 'simulating'
  targetIdx:     0,        // index into points[] of the ONE point being waited for
  watchId:       null,
  simHandle:     null,
  audioUnlocked: false,
  lastFired:     null,     // { sequence, type, streetName, time }
  lastTick:      null,     // { lat, lng, accuracy, dist, radius, reason }
};

// ── Haversine ─────────────────────────────────────────────────────────────────
function haversineMetres(lat1, lng1, lat2, lng2) {
  const R   = 6371000;
  const toR = x => x * Math.PI / 180;
  const dLat = toR(lat2 - lat1);
  const dLng = toR(lng2 - lng1);
  const a   = Math.sin(dLat / 2) ** 2
            + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Loader ────────────────────────────────────────────────────────────────────
async function loadPoints() {
  const res = await fetch(DATA_FILE + '?v=' + Date.now());
  if (!res.ok) throw new Error('Failed to load ' + DATA_FILE + ': ' + res.status);
  const data = await res.json();
  points = data.points.slice().sort((a, b) => a.sequence - b.sequence);
  console.log(`Loaded ${points.length} points.`);
  refreshDebug();
}

// ── Core engine: one GPS tick ─────────────────────────────────────────────────
// This is the ENTIRE routing logic. One distance check against ONE target.
function onFix(lat, lng, accuracy) {
  if (state.mode === 'idle' || state.targetIdx >= points.length) return;

  const target  = points[state.targetIdx];
  const dist    = Math.round(haversineMetres(lat, lng, target.location.lat, target.location.lng));
  const arrived = dist < target.radius;

  state.lastTick = {
    lat, lng, accuracy,
    dist,
    radius:  target.radius,
    reason:  arrived
      ? `arrived: ${dist} m < ${target.radius} m radius`
      : `too far: ${dist} m (radius ${target.radius} m)`,
  };

  refreshDebug();

  if (arrived) {
    firePoint(target);
    state.targetIdx++;
    if (state.targetIdx >= points.length) {
      finishRoute();
    }
  }
}

// ── Fire a point ──────────────────────────────────────────────────────────────
function firePoint(point) {
  const now = new Date();

  state.lastFired = {
    sequence:   point.sequence,
    type:       point.type,
    streetName: point.streetName || point.qualifier || null,
    time:       now.toLocaleTimeString(),
  };

  let text = point.defaultText || '';

  if (point.additionalText) {
    const expiry  = point.additionalTextExpiry ? new Date(point.additionalTextExpiry) : null;
    const expired = expiry && expiry < now;
    if (!expired) text += ' ' + point.additionalText;
  }

  enqueueSpeak(text);
  refreshDebug();

  console.log(`▶ #${point.sequence} ${point.type}: "${text}"`);
}

function finishRoute() {
  state.mode = 'idle';
  stopGPS();
  stopSimulate();
  setModeLabel('DONE', 'done');
  setButtonState();
  state.lastTick = { ...state.lastTick, reason: 'Route complete — all points fired.' };
  refreshDebug();
}

// ── Speech ────────────────────────────────────────────────────────────────────
const speechQueue = [];
let isSpeaking    = false;

function speakNext() {
  if (isSpeaking || speechQueue.length === 0) return;
  const text = speechQueue.shift();
  const utt  = new SpeechSynthesisUtterance(text);
  utt.rate   = 0.95;
  utt.pitch  = 1.0;
  utt.volume = 1.0;
  isSpeaking = true;
  showNowPlaying(text);
  utt.onend = utt.onerror = () => {
    isSpeaking = false;
    if (speechQueue.length === 0) hideNowPlaying();
    speakNext();
  };
  speechSynthesis.speak(utt);
}

function enqueueSpeak(text) {
  speechQueue.push(text);
  speakNext();
}

function clearSpeech() {
  speechSynthesis.cancel();
  speechQueue.length = 0;
  isSpeaking = false;
  hideNowPlaying();
}

function unlockAudio() {
  if (state.audioUnlocked) return;
  state.audioUnlocked = true;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

// ── Live GPS ──────────────────────────────────────────────────────────────────
function startLive() {
  if (!navigator.geolocation) { alert('Geolocation not supported.'); return; }
  state.mode = 'live';
  setModeLabel('LIVE', 'live');
  setButtonState();
  requestWakeLock();

  state.watchId = navigator.geolocation.watchPosition(
    pos => onFix(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
    err => {
      console.error('GPS error', err.code, err.message);
      if (state.lastTick) state.lastTick.reason = 'GPS error: ' + err.message;
      else state.lastTick = { reason: 'GPS error: ' + err.message };
      refreshDebug();
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
  );
}

function stopGPS() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
}

// ── Simulate ──────────────────────────────────────────────────────────────────
function startSimulate() {
  state.mode = 'simulating';
  setModeLabel('SIMULATING', 'simulating');
  setButtonState();

  function step() {
    if (state.mode !== 'simulating' || state.targetIdx >= points.length) return;

    const target = points[state.targetIdx];

    // Pretend we are standing exactly on the target point.
    state.lastTick = {
      lat:      target.location.lat,
      lng:      target.location.lng,
      accuracy: 3,
      dist:     0,
      radius:   target.radius,
      reason:   `SIMULATED arrival — 0 m < ${target.radius} m radius`,
    };
    refreshDebug();

    firePoint(target);
    state.targetIdx++;

    if (state.targetIdx >= points.length) {
      finishRoute();
      return;
    }

    state.simHandle = setTimeout(step, SIM_INTERVAL_MS);
  }

  state.simHandle = setTimeout(step, 600);
}

function stopSimulate() {
  if (state.simHandle !== null) {
    clearTimeout(state.simHandle);
    state.simHandle = null;
  }
}

// ── Wake lock ─────────────────────────────────────────────────────────────────
let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.mode !== 'idle') requestWakeLock();
});

// ── Reset ─────────────────────────────────────────────────────────────────────
function resetAll() {
  stopGPS();
  stopSimulate();
  clearSpeech();
  state.mode       = 'idle';
  state.targetIdx  = 0;
  state.lastFired  = null;
  state.lastTick   = null;
  setModeLabel('IDLE', '');
  setButtonState();
  refreshDebug();
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function pointLabel(p) {
  const dir    = p.turnDirection === 'L' ? '← ' : p.turnDirection === 'R' ? '→ ' : '';
  const street = p.streetName || (p.qualifier ? `(${p.qualifier})` : p.type);
  return `#${p.sequence} ${p.type} ${dir}${street}`;
}

function refreshDebug() {
  const target = points[state.targetIdx];
  const tick   = state.lastTick;

  // Target
  el('dbg-target').textContent = target ? pointLabel(target) : 'DONE';
  el('dbg-radius').textContent = target ? target.radius + ' m' : '—';

  // GPS + distance from last tick
  if (tick) {
    el('dbg-lat').textContent  = tick.lat  != null ? tick.lat.toFixed(6)  : '—';
    el('dbg-lng').textContent  = tick.lng  != null ? tick.lng.toFixed(6)  : '—';
    el('dbg-acc').textContent  = tick.accuracy != null ? Math.round(tick.accuracy) + ' m' : '—';
    const distEl = el('dbg-dist');
    distEl.textContent         = tick.dist != null ? tick.dist + ' m' : '—';
    distEl.className           = (tick.dist != null && target && tick.dist < target.radius)
                                   ? 'arrived' : '';
    el('dbg-reason').textContent = tick.reason || '—';
  }

  // Last fired
  if (state.lastFired) {
    const lf = state.lastFired;
    el('dbg-last').textContent =
      `#${lf.sequence} ${lf.type}` +
      (lf.streetName ? ` (${lf.streetName})` : '') +
      ` @ ${lf.time}`;
  }
}

function setModeLabel(text, cls = '') {
  const el2 = el('mode-label');
  el2.textContent = text;
  el2.className   = cls;
}

function setButtonState() {
  const running = state.mode === 'live' || state.mode === 'simulating';
  el('btn-start').disabled    = running;
  el('btn-simulate').disabled = running;
  el('btn-stop').disabled     = !running;
  el('btn-reset').disabled    = running;
}

function showNowPlaying(text) {
  el('np-text').textContent = text;
  el('now-playing').classList.remove('hidden');
}

function hideNowPlaying() {
  el('now-playing').classList.add('hidden');
}

function el(id) { return document.getElementById(id); }

// ── Button handlers ───────────────────────────────────────────────────────────
el('btn-start').addEventListener('click', () => {
  unlockAudio();
  resetAll();
  startLive();
});

el('btn-simulate').addEventListener('click', () => {
  unlockAudio();
  resetAll();
  startSimulate();
});

el('btn-stop').addEventListener('click', () => {
  stopGPS();
  stopSimulate();
  clearSpeech();
  state.mode = 'idle';
  setModeLabel('STOPPED', 'stopped');
  setButtonState();
});

el('btn-reset').addEventListener('click', resetAll);

// ── Init ──────────────────────────────────────────────────────────────────────
loadPoints().catch(err => {
  console.error(err);
  document.getElementById('dbg-reason').textContent = 'Load error: ' + err.message;
});
