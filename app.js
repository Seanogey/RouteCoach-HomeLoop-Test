'use strict';

const DATA_FILE               = 'home_loop_points.json';
const SIM_INTERVAL_MS         = 3000;

// ── v1.2 / v1.3 arrival-detection constants ───────────────────────────────────
const ACCURACY_FLOOR_M        = 30;   // discard fixes worse than this
const STOP_SPEED_THRESHOLD_MS = 0.3;  // m/s — below this counts as "stopped"
const COOLDOWN_SECONDS        = 7;    // no arrival checks this long after a fire
const GPS_WEAK_TIMEOUT_S      = 30;   // warn if no accepted fix for this long
const WALK_NOISE_FLOOR_M      = 3;    // per-tick movements smaller than this are jitter

// ── State ─────────────────────────────────────────────────────────────────────
let points = [];

let state = {
  mode:               'idle',
  targetIdx:          0,
  watchId:            null,
  simHandle:          null,
  audioUnlocked:      false,
  lastFired:          null,    // { sequence, type, streetName, time }
  lastFiredLocation:  null,    // { lat, lng } of last fired point (for departure display)
  lastFireTime:       null,    // Date.now() when last point fired (for cooldown)
  lastAcceptedFix:    null,    // { lat, lng, timeMs } — last fix that passed accuracy gate
  lastAcceptedTimeMs: null,    // ms of last accepted fix (for GPS weak check)
  walkedDistance:     0,       // running odometer in metres (resets to 0 on resetAll)
  lastTick:           null,
  fixLog:             [],      // every fix, accepted and rejected
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
  console.log('Loaded ' + points.length + ' points.');
  refreshDebug();
}

// ── Core engine ───────────────────────────────────────────────────────────────
// Every GPS fix passes through here. Five steps in order.
function onFix(lat, lng, accuracy) {
  if (state.mode === 'idle' || state.targetIdx >= points.length) return;

  const nowMs  = Date.now();
  const target = points[state.targetIdx];

  // Step 1 — accuracy gate
  if (accuracy > ACCURACY_FLOOR_M) {
    const reason = 'rejected: accuracy ' + Math.round(accuracy) + 'm > ' + ACCURACY_FLOOR_M + 'm floor';
    appendLog(nowMs, lat, lng, accuracy, null, null, reason);
    state.lastTick = { lat, lng, accuracy, dist: null, speed: null, reason };
    refreshDebug();
    return;
  }

  // Steps 3 & 4 — distance to target, per-tick movement, and speed
  // tickMovement is computed before updating lastAcceptedFix so it measures
  // displacement from the previous accepted fix.  It is used for both speed
  // and the walkedDistance odometer.  On the very first accepted fix
  // lastAcceptedFix is null so tickMovement stays 0 — no phantom distance.
  const dist = haversineMetres(lat, lng, target.location.lat, target.location.lng);
  let speed       = null;
  let tickMovement = 0;
  if (state.lastAcceptedFix) {
    tickMovement = haversineMetres(lat, lng,
      state.lastAcceptedFix.lat, state.lastAcceptedFix.lng);
    const dt = (nowMs - state.lastAcceptedFix.timeMs) / 1000;
    if (dt > 0) speed = tickMovement / dt;
  }

  // Record this fix as accepted (good accuracy), used for next tick's speed/movement
  state.lastAcceptedFix    = { lat, lng, timeMs: nowMs };
  state.lastAcceptedTimeMs = nowMs;

  // v1.3 odometer — sub-3m movements are GPS jitter, not real walking
  if (tickMovement > WALK_NOISE_FLOOR_M) state.walkedDistance += tickMovement;

  // Step 2 — cooldown gate (checked after speed is computed so debug still shows speed)
  const cooldownRemaining = state.lastFireTime
    ? Math.max(0, COOLDOWN_SECONDS - (nowMs - state.lastFireTime) / 1000)
    : 0;
  if (cooldownRemaining > 0) {
    const reason = 'cooldown: ' + cooldownRemaining.toFixed(1) + 's remaining';
    appendLog(nowMs, lat, lng, accuracy, dist, speed, reason);
    state.lastTick = { lat, lng, accuracy, dist, speed, reason, inner: target.radius, outer: target.outerRadius };
    refreshDebug();
    return;
  }

  // Step 6 — v1.3 distance gate: must have walked to this point before arrival fires
  const required = target.cumulativeDistanceFromStart;
  if (state.walkedDistance < required) {
    const reason = 'distance gate: ' + Math.round(state.walkedDistance) +
      'm walked / ' + required + 'm required';
    appendLog(nowMs, lat, lng, accuracy, dist, speed, reason);
    state.lastTick = { lat, lng, accuracy, dist, speed, reason,
      inner: target.radius, outer: target.outerRadius };
    refreshDebug();
    return;
  }

  // Step 7 — dual-ring arrival check
  const inner    = target.radius;
  const outer    = target.outerRadius;
  const innerHit = dist <= inner;
  const outerHit = outer > 0 && dist <= outer && speed !== null && speed <= STOP_SPEED_THRESHOLD_MS;
  const arrived  = innerHit || outerHit;

  let reason;
  if (innerHit) {
    reason = 'arrived: inner radius (' + Math.round(dist) + 'm ≤ ' + inner + 'm)';
  } else if (outerHit) {
    reason = 'arrived: outer + stopped (' + Math.round(dist) + 'm ≤ ' + outer + 'm, ' + speed.toFixed(2) + 'm/s)';
  } else {
    reason = 'too far: ' + Math.round(dist) + 'm (inner ' + inner + 'm / outer ' + outer + 'm)';
  }

  appendLog(nowMs, lat, lng, accuracy, dist, speed, reason);
  state.lastTick = { lat, lng, accuracy, dist, speed, reason, inner, outer };
  refreshDebug();

  if (arrived) {
    firePoint(target);
    state.targetIdx++;
    if (state.targetIdx >= points.length) finishRoute();
  }
}

// ── Fire a point ──────────────────────────────────────────────────────────────
function firePoint(point) {
  const now = new Date();

  state.lastFireTime    = Date.now();
  state.lastFiredLocation = { lat: point.location.lat, lng: point.location.lng };
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
  console.log('▶ #' + point.sequence + ' ' + point.type + ': "' + text + '"');
}

function finishRoute() {
  state.mode = 'idle';
  stopGPS();
  stopSimulate();
  setModeLabel('DONE', 'done');
  setButtonState();
  if (state.lastTick) state.lastTick.reason = 'Route complete — all points fired.';
  refreshDebug();
}

// ── Fix log ───────────────────────────────────────────────────────────────────
function appendLog(nowMs, lat, lng, accuracy, dist, speed, reason) {
  state.fixLog.push({
    timestamp: new Date(nowMs).toISOString(),
    lat:       lat,
    lng:       lng,
    accuracy:  Math.round(accuracy),
    dist_m:    dist !== null ? Math.round(dist) : '',
    speed_ms:  speed !== null ? speed.toFixed(3) : '',
    reason:    reason,
  });
  el('dbg-log-count').textContent = state.fixLog.length + ' entries';
  el('btn-download').disabled = false;
}

function downloadLog() {
  if (state.fixLog.length === 0) return;
  const header = 'timestamp,lat,lng,accuracy_m,dist_m,speed_ms,reason';
  const rows = state.fixLog.map(function(e) {
    return [
      e.timestamp, e.lat, e.lng, e.accuracy, e.dist_m, e.speed_ms,
      '"' + String(e.reason).replace(/"/g, '""') + '"',
    ].join(',');
  });
  const csv      = [header].concat(rows).join('\n');
  const filename = 'homeloop_log_' +
    new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-') + '.csv';
  const file = new File([csv], filename, { type: 'text/csv' });

  // iOS Safari doesn't honour anchor download= and navigates inline instead.
  // Web Share API with a File object opens the native share sheet (Save to Files etc).
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: 'Home Loop fix log' }).catch(function(err) {
      // User dismissed the sheet — not an error worth surfacing.
      if (err.name !== 'AbortError') console.error('share failed:', err);
    });
    return;
  }

  // Fallback: desktop browsers that support anchor download= correctly.
  const url = URL.createObjectURL(file);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
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
  utt.onend = utt.onerror = function() {
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
    function(pos) {
      onFix(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
    },
    function(err) {
      console.error('GPS error', err.code, err.message);
      const reason = 'GPS error: ' + err.message;
      if (state.lastTick) state.lastTick.reason = reason;
      else state.lastTick = { reason: reason };
      refreshDebug();
    },
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 }
  );
}

function stopGPS() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
}

// ── Simulate ──────────────────────────────────────────────────────────────────
// Calls firePoint directly — bypasses onFix and all its gates intentionally.
// Simulate exists to verify point order and cue text, not arrival detection.
function startSimulate() {
  state.mode = 'simulating';
  setModeLabel('SIMULATING', 'simulating');
  setButtonState();

  function step() {
    if (state.mode !== 'simulating' || state.targetIdx >= points.length) return;
    const target = points[state.targetIdx];

    state.lastTick = {
      lat:      target.location.lat,
      lng:      target.location.lng,
      accuracy: 3,
      dist:     0,
      speed:    0,
      inner:    target.radius,
      outer:    target.outerRadius,
      reason:   'SIMULATED — 0m ≤ ' + target.radius + 'm inner radius',
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

document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && state.mode !== 'idle') requestWakeLock();
});

// ── Reset ─────────────────────────────────────────────────────────────────────
function resetAll() {
  stopGPS();
  stopSimulate();
  clearSpeech();
  state.mode               = 'idle';
  state.targetIdx          = 0;
  state.lastFired          = null;
  state.lastFiredLocation  = null;
  state.lastFireTime       = null;
  state.lastAcceptedFix    = null;
  state.lastAcceptedTimeMs = null;
  state.walkedDistance     = 0;
  state.lastTick           = null;
  state.fixLog             = [];
  setModeLabel('IDLE', '');
  setButtonState();
  el('dbg-log-count').textContent = '0 entries';
  el('btn-download').disabled = true;
  refreshDebug();
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function pointLabel(p) {
  const dir    = p.turnDirection === 'L' ? '← ' : p.turnDirection === 'R' ? '→ ' : '';
  const street = p.streetName || (p.qualifier ? '(' + p.qualifier + ')' : p.type);
  return '#' + p.sequence + ' ' + p.type + ' ' + dir + street;
}

function refreshDebug() {
  const target = points[state.targetIdx];
  const tick   = state.lastTick;
  const nowMs  = Date.now();

  // Target and radii
  el('dbg-target').textContent = target ? pointLabel(target) : 'DONE';
  el('dbg-inner').textContent  = target ? target.radius + 'm' : '—';
  el('dbg-outer').textContent  = target ? target.outerRadius + 'm' : '—';

  // Distance gate
  const walked   = Math.round(state.walkedDistance);
  const required = target ? target.cumulativeDistanceFromStart : null;
  const gateOpen = required !== null && state.walkedDistance >= required;
  el('dbg-walked').textContent   = walked + 'm';
  el('dbg-required').textContent = required !== null ? required + 'm' : '—';
  const gateEl = el('dbg-gate-status');
  gateEl.textContent = required === null ? '—' : gateOpen ? 'open' : 'locked';
  gateEl.className   = required === null ? '' : gateOpen ? 'arrived' : 'warn';

  if (!tick) return;

  // GPS coordinates
  el('dbg-lat').textContent = tick.lat  != null ? tick.lat.toFixed(6) : '—';
  el('dbg-lng').textContent = tick.lng  != null ? tick.lng.toFixed(6) : '—';
  el('dbg-acc').textContent = tick.accuracy != null ? Math.round(tick.accuracy) + 'm' : '—';

  // Distance — GPS weak warning if no accepted fix for GPS_WEAK_TIMEOUT_S
  const distEl     = el('dbg-dist');
  const secsSince  = state.lastAcceptedTimeMs
    ? (nowMs - state.lastAcceptedTimeMs) / 1000
    : Infinity;
  const gpsWeak    = state.mode === 'live' && secsSince > GPS_WEAK_TIMEOUT_S;

  if (gpsWeak) {
    distEl.textContent = 'GPS signal weak — waiting';
    distEl.className   = 'warn';
  } else if (tick.dist !== null && tick.dist !== undefined) {
    distEl.textContent = Math.round(tick.dist) + 'm';
    distEl.className   = (target && tick.dist <= target.radius) ? 'arrived' : '';
  } else {
    distEl.textContent = '—';
    distEl.className   = '';
  }

  // Speed
  el('dbg-speed').textContent = tick.speed != null
    ? tick.speed.toFixed(2) + ' m/s'
    : '—';

  // Departure distance from last fired point
  const deptEl = el('dbg-depart');
  if (state.lastFiredLocation && tick.lat != null) {
    const d = Math.round(haversineMetres(
      tick.lat, tick.lng,
      state.lastFiredLocation.lat, state.lastFiredLocation.lng
    ));
    deptEl.textContent = d + 'm from #' + state.lastFired.sequence;
  } else {
    deptEl.textContent = '—';
  }

  // Tick reason
  el('dbg-reason').textContent = tick.reason || '—';

  // Last fired
  if (state.lastFired) {
    const lf = state.lastFired;
    el('dbg-last').textContent =
      '#' + lf.sequence + ' ' + lf.type +
      (lf.streetName ? ' (' + lf.streetName + ')' : '') +
      ' @ ' + lf.time;
  }
}

function setModeLabel(text, cls) {
  const e  = el('mode-label');
  e.textContent = text;
  e.className   = cls || '';
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
el('btn-start').addEventListener('click', function() {
  unlockAudio();
  resetAll();
  startLive();
});

el('btn-simulate').addEventListener('click', function() {
  unlockAudio();
  resetAll();
  startSimulate();
});

el('btn-stop').addEventListener('click', function() {
  stopGPS();
  stopSimulate();
  clearSpeech();
  state.mode = 'idle';
  setModeLabel('STOPPED', 'stopped');
  setButtonState();
});

el('btn-reset').addEventListener('click', resetAll);
el('btn-download').addEventListener('click', downloadLog);

// ── Init ──────────────────────────────────────────────────────────────────────
loadPoints().catch(function(err) {
  console.error(err);
  el('dbg-reason').textContent = 'Load error: ' + err.message;
});
