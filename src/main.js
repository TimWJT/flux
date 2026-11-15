import './startup.js';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { check as checkUpdate } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

const IS_NATIVE = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const STORAGE_PREFIX = 'nightlight.';

const DEFAULTS = {
  theme: 'auto',
  width: 'normal',
  font: 'sans',
  outline: 'off',
  enabled: true,
  mode: 'solar',          // 'solar' | 'manual'
  dayK: 6500,
  sunsetK: 3400,
  nightK: 2300,
  manualK: 3400,
  brightness: 100,
  transition: 'medium',   // 'fast' | 'medium' | 'slow'
  wakeTime: 7.0,          // hours (07:00)
  location: 'auto',       // 'auto' or 'lat,lon'
  stepSize: 200,
  textSize: 16,
  previewTint: true,
  keepOnClose: false,
  updateOnStart: true,
  effect: 'normal',       // 'normal' | 'movie' | 'darkroom' | 'grayscale'
  movieUntil: 0,          // timestamp ms, 0 = no active movie timer
  pauseUntil: 0,          // timestamp ms, 0 = not paused
  pauseMode: null,        // null | '1h' | 'sunrise'
  activePreset: 'recommended',
};

const PRESETS = [
  { id: 'recommended', name: 'Recommended Colors', dayK: 6500, sunsetK: 3400, nightK: 2300, tag: '6500 / 3400 / 2300K' },
  { id: 'eyestrain',   name: 'Reduce Eyestrain',   dayK: 5500, sunsetK: 3200, nightK: 2100, tag: '5500 / 3200 / 2100K' },
  { id: 'coding',      name: 'Late Night Coding',  dayK: 6000, sunsetK: 3000, nightK: 1900, tag: '6000 / 3000 / 1900K' },
  { id: 'working',     name: 'Working Late',       dayK: 6500, sunsetK: 4200, nightK: 2700, tag: '6500 / 4200 / 2700K' },
  { id: 'reading',     name: 'Warm Paper Reading', dayK: 5000, sunsetK: 3100, nightK: 2200, tag: '5000 / 3100 / 2200K' },
  { id: 'cave',        name: 'Cave Painting',      dayK: 4500, sunsetK: 2700, nightK: 1600, tag: '4500 / 2700 / 1600K' },
  { id: 'ember',       name: 'Ember Bedtime',      dayK: 5000, sunsetK: 2400, nightK: 1200, tag: '5000 / 2400 / 1200K' },
];

const EFFECTS = [
  { id: 'normal',    name: 'Normal Spectrum',            tag: 'Planckian' },
  { id: 'movie',     name: 'Movie Mode (4200K)',         tag: 'Cinema 2.5h' },
  { id: 'darkroom',  name: 'Darkroom Red',               tag: 'Red LUT' },
  { id: 'grayscale', name: 'E-Ink Grayscale (Window)',   tag: 'Window Mono' },
];

const QUICK_TEMPS = [
  { kelvin: 6500, name: 'Daylight',       tag: '6500K' },
  { kelvin: 5000, name: 'Morning Sun',    tag: '5000K' },
  { kelvin: 4200, name: 'Fluorescent',    tag: '4200K' },
  { kelvin: 3400, name: 'Halogen Lamp',   tag: '3400K' },
  { kelvin: 2700, name: 'Incandescent',   tag: '2700K' },
  { kelvin: 2300, name: 'Warm Dimmed',    tag: '2300K' },
  { kelvin: 1900, name: 'Candlelight',    tag: '1900K' },
  { kelvin: 1200, name: 'Campfire Ember', tag: '1200K' },
];

function loadSaved(key, fallback) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return fallback;
    const parsed = JSON.parse(raw);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function saveValue(key, value) {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch { /* ignore storage errors */ }
}

const state = {
  theme: loadSaved('theme', DEFAULTS.theme),
  width: loadSaved('width', DEFAULTS.width),
  font: loadSaved('font', DEFAULTS.font),
  outline: loadSaved('outline', DEFAULTS.outline),
  enabled: Boolean(loadSaved('enabled', DEFAULTS.enabled)),
  mode: loadSaved('mode', DEFAULTS.mode) === 'manual' ? 'manual' : 'solar',
  dayK: clampNum(loadSaved('dayK', DEFAULTS.dayK), 1900, 6500, DEFAULTS.dayK),
  sunsetK: clampNum(loadSaved('sunsetK', DEFAULTS.sunsetK), 1200, 6500, DEFAULTS.sunsetK),
  nightK: clampNum(loadSaved('nightK', DEFAULTS.nightK), 1200, 6500, DEFAULTS.nightK),
  manualK: clampNum(loadSaved('manualK', DEFAULTS.manualK), 1200, 6500, DEFAULTS.manualK),
  brightness: clampNum(loadSaved('brightness', DEFAULTS.brightness), 20, 100, DEFAULTS.brightness),
  transition: ['fast', 'medium', 'slow'].includes(loadSaved('transition', DEFAULTS.transition))
    ? loadSaved('transition', DEFAULTS.transition)
    : DEFAULTS.transition,
  wakeTime: clampNum(loadSaved('wakeTime', DEFAULTS.wakeTime), 4, 11, DEFAULTS.wakeTime),
  location: String(loadSaved('location', DEFAULTS.location) || 'auto'),
  stepSize: clampNum(loadSaved('stepSize', DEFAULTS.stepSize), 50, 500, DEFAULTS.stepSize),
  textSize: clampNum(loadSaved('textSize', DEFAULTS.textSize), 13, 22, DEFAULTS.textSize),
  previewTint: Boolean(loadSaved('previewTint', DEFAULTS.previewTint)),
  keepOnClose: Boolean(loadSaved('keepOnClose', DEFAULTS.keepOnClose)),
  updateOnStart: Boolean(loadSaved('updateOnStart', DEFAULTS.updateOnStart)),
  effect: ['normal', 'movie', 'darkroom', 'grayscale'].includes(loadSaved('effect', DEFAULTS.effect))
    ? loadSaved('effect', DEFAULTS.effect)
    : DEFAULTS.effect,
  movieUntil: Number(loadSaved('movieUntil', 0)) || 0,
  pauseUntil: Number(loadSaved('pauseUntil', 0)) || 0,
  pauseMode: loadSaved('pauseMode', null),
  activePreset: String(loadSaved('activePreset', DEFAULTS.activePreset)),
  previewing: false,
  previewMinutes: null,
  displays: ['Primary Display (256-entry LUT)'],
  hardwareActive: IS_NATIVE,
  hardwareResult: null,
};

function clampNum(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Planckian blackbody locus approximation (1000K - 10000K) -> normalized RGB [0..1].
 * Derived from CIE 1964 10-degree color matching / Tanner Helland curve,
 * anchored so 6500K is exact neutral white (1, 1, 1).
 */
function kelvinToRgb(kelvin) {
  const k = clampNum(kelvin, 1000, 10000, 6500);
  if (k >= 6500) {
    return { r: 1, g: 1, b: 1 };
  }
  const t = k / 100;
  const r = 1.0;

  // Compute raw value at t and at t65=65 so we normalize smoothly to 1.0 at 6500K
  const rawG = (99.4708025861 * Math.log(t) - 161.1195681661) / 255;
  const maxG = (99.4708025861 * Math.log(65) - 161.1195681661) / 255;
  const g = Math.min(1, Math.max(0, rawG / maxG));

  let b = 0;
  if (t > 19) {
    const rawB = (138.5177312231 * Math.log(t - 10) - 305.0447927307) / 255;
    const maxB = (138.5177312231 * Math.log(55) - 305.0447927307) / 255;
    b = Math.min(1, Math.max(0, rawB / maxB));
  }

  return { r, g, b };
}

/**
 * Builds the 3x256 16-bit gamma ramp lookup table (0..65535) for Win32 SetDeviceGammaRamp.
 */
function buildGammaRamp(kelvin, brightness = 100, effect = 'normal') {
  const dim = clampNum(brightness, 20, 100, 100) / 100;
  const base = effect === 'darkroom'
    ? { r: 1, g: 0, b: 0 }
    : kelvinToRgb(effect === 'movie' ? 4200 : kelvin);

  const rLut = new Array(256);
  const gLut = new Array(256);
  const bLut = new Array(256);

  for (let i = 0; i < 256; i++) {
    const linear = i / 255;
    rLut[i] = Math.round(linear * base.r * dim * 65535);
    gLut[i] = Math.round(linear * base.g * dim * 65535);
    bLut[i] = Math.round(linear * base.b * dim * 65535);
  }
  return { r: rLut, g: gLut, b: bLut, multipliers: { r: base.r * dim, g: base.g * dim, b: base.b * dim } };
}

const CITY_TIMEZONES = {
  '-33.87,151.21': 'Australia/Sydney',
  '-37.81,144.96': 'Australia/Melbourne',
  '37.77,-122.42': 'America/Los_Angeles',
  '40.71,-74.01': 'America/New_York',
  '51.51,-0.13': 'Europe/London',
  '35.68,139.65': 'Asia/Tokyo',
  '1.35,103.82': 'Asia/Singapore',
};

function getTimeZoneOffsetMinutes(date, timeZone) {
  if (!timeZone) return -date.getTimezoneOffset();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const get = type => Number(parts.find(p => p.type === type)?.value || 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    const flooredUtc = Math.floor(date.getTime() / 1000) * 1000;
    return Math.round((asUtc - flooredUtc) / 60000);
  } catch {
    return -date.getTimezoneOffset();
  }
}

/**
 * Estimates latitude & longitude from system standard-time offset when location is 'auto',
 * or parses explicit 'lat,lon' string (with offline IANA timezone lookup for city presets).
 */
function resolveCoordinates(locationStr, date = new Date()) {
  if (locationStr && locationStr !== 'auto' && locationStr.includes(',')) {
    const key = String(locationStr).trim();
    const [lat, lon] = key.split(',').map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      const tz = CITY_TIMEZONES[key] || null;
      return {
        lat: clampNum(lat, -66, 66, 0),
        lon: clampNum(lon, -180, 180, 0),
        tzOffsetMin: tz ? getTimeZoneOffsetMinutes(date, tz) : -date.getTimezoneOffset(),
      };
    }
  }
  // Offline estimation from local *standard-time* offset so DST does not shift
  // the estimated meridian by 15 degrees (~1 hour).
  const year = date.getFullYear();
  const janOffset = -new Date(year, 0, 1).getTimezoneOffset();
  const julOffset = -new Date(year, 6, 1).getTimezoneOffset();
  const stdOffsetMin = Math.min(janOffset, julOffset);
  const stdTzHours = stdOffsetMin / 60;
  const lon = clampNum(stdTzHours * 15, -180, 180, 0);
  // Default temperate latitude (Sydney/Melbourne for +9.5..+10.5 std, else +38 deg)
  const lat = stdTzHours >= 9.5 && stdTzHours <= 10.5 ? -34.0 : 38.0;
  return { lat, lon, tzOffsetMin: -date.getTimezoneOffset() };
}

/**
 * Computes offline sunrise and sunset in local minutes from midnight [0..1440)
 * using the NOAA solar position equations.
 */
function computeSolarTimes(date = new Date(), lat = 38.0, lon = 0.0, tzOffsetMin = -date.getTimezoneOffset()) {
  const startOfYear = new Date(date.getFullYear(), 0, 0);
  const dayOfYear = Math.floor((date - startOfYear) / 86400000);
  const rad = Math.PI / 180;
  const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1);

  // Equation of time (in minutes)
  const eqTime = 229.18 * (
    0.000075 +
    0.001868 * Math.cos(gamma) -
    0.032077 * Math.sin(gamma) -
    0.014615 * Math.cos(2 * gamma) -
    0.040849 * Math.sin(2 * gamma)
  );

  // Solar declination angle (in radians)
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  const latRad = clampNum(lat, -65, 65, 38) * rad;
  const zenith = 90.833 * rad;
  const cosHa = (Math.cos(zenith) / (Math.cos(latRad) * Math.cos(decl))) - (Math.tan(latRad) * Math.tan(decl));

  if (cosHa > 1 || cosHa < -1) {
    return { sunrise: 390, sunset: 1110, noon: 750 };
  }

  const haDeg = Math.acos(cosHa) / rad;
  const offsetMin = Number.isFinite(tzOffsetMin) ? tzOffsetMin : -date.getTimezoneOffset();
  const solarNoon = 720 - 4 * lon - eqTime + offsetMin;
  const wrapMin = m => ((Math.round(m) % 1440) + 1440) % 1440;
  const sunrise = wrapMin(solarNoon - haDeg * 4);
  const sunset = wrapMin(solarNoon + haDeg * 4);

  return {
    sunrise,
    sunset,
    noon: wrapMin(solarNoon),
  };
}

function smoothStepCosine(u) {
  const x = Math.min(1, Math.max(0, u));
  return 0.5 - 0.5 * Math.cos(Math.PI * x);
}

/**
 * Computes the scheduled Kelvin and phase ('Daytime' | 'Sunset' | 'Bedtime')
 * for any minute of the day [0..1440).
 */
function computeScheduleKelvin(minutesOfDay, solar, cfg = state) {
  const m = ((minutesOfDay % 1440) + 1440) % 1440;
  const span = cfg.transition === 'fast' ? 10 : cfg.transition === 'slow' ? 60 : 20;
  const sunrise = solar.sunrise;
  const sunset = solar.sunset;
  const wakeMin = Math.round(clampNum(cfg.wakeTime, 4, 11, 7) * 60);
  // Bedtime begins 8 hours (480 min) before wakeTime, typically 22:00 - 01:00
  let bedtime = ((wakeMin - 480) + 1440) % 1440;
  if (bedtime <= sunset + span) {
    bedtime = Math.min(1410, sunset + span + 60);
  }

  const dayK = cfg.dayK;
  const sunsetK = cfg.sunsetK;
  const nightK = cfg.nightK;

  // Sunrise transition: [sunrise - span/2, sunrise + span/2]
  const srStart = sunrise - span / 2;
  const srEnd = sunrise + span / 2;
  // Sunset transition: [sunset - span/2, sunset + span/2]
  const ssStart = sunset - span / 2;
  const ssEnd = sunset + span / 2;
  // Bedtime transition: [bedtime - span/2, bedtime + span/2]
  const btStart = bedtime - span / 2;
  const btEnd = bedtime + span / 2;

  if (m >= srStart && m <= srEnd) {
    const u = smoothStepCosine((m - srStart) / Math.max(1, span));
    return {
      kelvin: Math.round(nightK + (dayK - nightK) * u),
      phase: 'Sunrise',
      activeSlot: 'day',
      bedtime,
    };
  }
  if (m > srEnd && m < ssStart) {
    return { kelvin: dayK, phase: 'Daytime', activeSlot: 'day', bedtime };
  }
  if (m >= ssStart && m <= ssEnd) {
    const u = smoothStepCosine((m - ssStart) / Math.max(1, span));
    return {
      kelvin: Math.round(dayK + (sunsetK - dayK) * u),
      phase: 'Sunset',
      activeSlot: 'sunset',
      bedtime,
    };
  }
  if (m > ssEnd && m < btStart) {
    return { kelvin: sunsetK, phase: 'Sunset', activeSlot: 'sunset', bedtime };
  }
  if (m >= btStart && m <= btEnd) {
    const u = smoothStepCosine((m - btStart) / Math.max(1, span));
    return {
      kelvin: Math.round(sunsetK + (nightK - sunsetK) * u),
      phase: 'Bedtime',
      activeSlot: 'night',
      bedtime,
    };
  }
  return { kelvin: nightK, phase: 'Bedtime', activeSlot: 'night', bedtime };
}

function describeKelvin(kelvin, effect = 'normal') {
  if (effect === 'darkroom') return 'Darkroom Red Monochrome';
  if (effect === 'grayscale') return 'E-Ink Grayscale (Window Preview)';
  if (effect === 'movie') return 'Cinema Warmth (Shadow-Safe)';
  if (kelvin >= 6200) return 'Daylight (Neutral D65)';
  if (kelvin >= 5000) return 'Cool Morning Sunlight';
  if (kelvin >= 4000) return 'Fluorescent / Office Light';
  if (kelvin >= 3200) return 'Warm White / Halogen';
  if (kelvin >= 2500) return 'Soft Incandescent Bulb';
  if (kelvin >= 1800) return 'Candlelight Warmth';
  return 'Deep Campfire Ember';
}

function formatMinutes(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const hh = String(Math.floor(m / 60)).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

function currentMinutes(now = new Date()) {
  return now.getHours() * 60 + now.getMinutes();
}

/* ---------- DOM helpers ---------- */
const $ = sel => document.querySelector(sel);

let toastTimer = 0;
function toast(message) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), 2100);
}

function applyTheme(value, announce = true) {
  const theme = window.__nightLightTheme ? window.__nightLightTheme.apply(value) : (value === 'light' || value === 'dark' ? value : 'auto');
  state.theme = theme;
  saveValue('theme', theme);
  const btn = $('#btn-theme');
  if (btn) {
    btn.setAttribute('aria-pressed', String(theme !== 'auto'));
    btn.title = `Theme: ${theme} (t)`;
  }
  if (announce) toast(`Theme: ${theme}`);
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(state.theme) + 1) % order.length];
  applyTheme(next, true);
}

function applyWidth(value, announce = true) {
  const width = ['normal', 'wide', 'full'].includes(value) ? value : 'normal';
  state.width = width;
  document.documentElement.setAttribute('data-width', width);
  saveValue('width', width);
  const btn = $('#btn-width');
  if (btn) {
    btn.setAttribute('aria-pressed', String(width !== 'normal'));
    btn.title = `Width: ${width} (w)`;
  }
  if (announce) toast(`Width: ${width}`);
}

function cycleWidth() {
  const order = ['normal', 'wide', 'full'];
  const next = order[(order.indexOf(state.width) + 1) % order.length];
  applyWidth(next, true);
}

function applyFont(value, announce = true) {
  const font = value === 'serif' ? 'serif' : 'sans';
  state.font = font;
  document.documentElement.setAttribute('data-font', font);
  saveValue('font', font);
  const btn = $('#btn-font');
  if (btn) {
    btn.setAttribute('aria-pressed', String(font === 'serif'));
    btn.title = `Font: ${font} (f)`;
  }
  if (announce) toast(`Font: ${font}`);
}

function toggleFont() {
  applyFont(state.font === 'serif' ? 'sans' : 'serif', true);
}

function toggleOutline(force) {
  const next = typeof force === 'boolean' ? (force ? 'on' : 'off') : (state.outline === 'on' ? 'off' : 'on');
  state.outline = next;
  document.documentElement.setAttribute('data-outline', next);
  saveValue('outline', next);
  const btn = $('#btn-outline');
  if (btn) btn.setAttribute('aria-pressed', String(next === 'on'));
}

function clearPauseAndEnable() {
  state.enabled = true;
  state.pauseUntil = 0;
  state.pauseMode = null;
  saveValue('enabled', true);
  saveValue('pauseUntil', 0);
  saveValue('pauseMode', null);
}

async function syncKeepOnClose(keep) {
  if (!IS_NATIVE) return true;
  try {
    await invoke('set_keep_gamma_on_exit', { keep: Boolean(keep) });
    return true;
  } catch {
    toast('Could not update exit gamma setting');
    return false;
  }
}

function applyEffect(effectId, announce = true, { preserveTimer = false } = {}) {
  const valid = ['normal', 'movie', 'darkroom', 'grayscale'].includes(effectId) ? effectId : 'normal';
  state.effect = valid;
  if (valid === 'movie') {
    if (!preserveTimer || state.movieUntil <= Date.now()) {
      state.movieUntil = Date.now() + 2.5 * 3600 * 1000;
      saveValue('movieUntil', state.movieUntil);
    }
  } else if (state.movieUntil !== 0) {
    state.movieUntil = 0;
    saveValue('movieUntil', 0);
  }
  document.documentElement.setAttribute('data-effect', valid);
  saveValue('effect', valid);
  const btn = $('#btn-effect');
  if (btn) {
    btn.setAttribute('aria-pressed', String(valid !== 'normal'));
    btn.title = `Color effect: ${valid} (e)`;
  }
  renderSidebar();
  refreshOutput();
  if (announce) toast(`Effect: ${valid}`);
}

function cycleEffect() {
  const order = ['normal', 'movie', 'darkroom', 'grayscale'];
  const next = order[(order.indexOf(state.effect) + 1) % order.length];
  applyEffect(next, true);
}

function selectPreset(presetId, announce = true) {
  const preset = PRESETS.find(p => p.id === presetId);
  if (!preset) return;
  state.activePreset = preset.id;
  state.dayK = preset.dayK;
  state.sunsetK = preset.sunsetK;
  state.nightK = preset.nightK;
  state.mode = 'solar';
  clearPauseAndEnable();
  saveValue('activePreset', state.activePreset);
  saveValue('dayK', state.dayK);
  saveValue('sunsetK', state.sunsetK);
  saveValue('nightK', state.nightK);
  saveValue('mode', state.mode);
  syncControlsFromState();
  renderSidebar();
  refreshOutput();
  if (announce) toast(`Preset: ${preset.name}`);
}

function setQuickTemp(kelvin, announce = true) {
  const k = clampNum(kelvin, 1200, 6500, 3400);
  state.manualK = k;
  state.mode = 'manual';
  clearPauseAndEnable();
  saveValue('manualK', k);
  saveValue('mode', 'manual');
  syncControlsFromState();
  renderSidebar();
  refreshOutput();
  if (announce) toast(`Manual warmth: ${k}K`);
}

function stepKelvin(direction) {
  const nowState = evaluateCurrentOutput();
  const base = state.mode === 'manual' ? state.manualK : nowState.kelvin;
  const delta = direction * state.stepSize;
  const next = clampNum(base + delta, 1200, 6500, 3400);
  if (state.mode === 'manual') {
    state.manualK = next;
    saveValue('manualK', next);
  } else if (nowState.activeSlot === 'day') {
    state.dayK = clampNum(next, 1900, 6500, 6500);
    saveValue('dayK', state.dayK);
  } else if (nowState.activeSlot === 'sunset') {
    state.sunsetK = next;
    saveValue('sunsetK', state.sunsetK);
  } else {
    state.nightK = next;
    saveValue('nightK', state.nightK);
  }
  clearPauseAndEnable();
  syncControlsFromState();
  refreshOutput();
  toast(`${next}K`);
}

function togglePower(force) {
  const next = typeof force === 'boolean' ? force : !state.enabled;
  state.enabled = next;
  if (next) {
    clearPauseAndEnable();
  } else {
    saveValue('enabled', false);
  }
  refreshOutput();
  toast(state.enabled ? 'Night Light enabled' : 'Paused (6500K neutral)');
}

function pauseForOneHour() {
  if (state.pauseMode === '1h' && state.pauseUntil > Date.now()) {
    clearPauseAndEnable();
    refreshOutput();
    toast('Resumed schedule');
    return;
  }
  state.pauseUntil = Date.now() + 3600 * 1000;
  state.pauseMode = '1h';
  saveValue('pauseUntil', state.pauseUntil);
  saveValue('pauseMode', '1h');
  refreshOutput();
  toast('Paused for 1 hour');
}

function pauseUntilSunrise() {
  const now = new Date();
  const coords = resolveCoordinates(state.location, now);
  const solar = computeSolarTimes(now, coords.lat, coords.lon, coords.tzOffsetMin);
  const nowMin = currentMinutes(now);
  let minsUntilSunrise = solar.sunrise - nowMin;
  if (minsUntilSunrise <= 0) minsUntilSunrise += 1440;
  state.pauseUntil = Date.now() + minsUntilSunrise * 60 * 1000;
  state.pauseMode = 'sunrise';
  saveValue('pauseUntil', state.pauseUntil);
  saveValue('pauseMode', 'sunrise');
  refreshOutput();
  toast(`Paused until sunrise (${formatMinutes(solar.sunrise)})`);
}

/**
 * Evaluates current effective Kelvin, phase name, active slot, and solar schedule.
 */
function evaluateCurrentOutput(now = new Date()) {
  if (state.pauseUntil > 0 && Date.now() >= state.pauseUntil) {
    state.pauseUntil = 0;
    state.pauseMode = null;
    saveValue('pauseUntil', 0);
    saveValue('pauseMode', null);
  }

  if (state.effect === 'movie' && state.movieUntil > 0 && Date.now() >= state.movieUntil) {
    state.effect = 'normal';
    state.movieUntil = 0;
    saveValue('effect', 'normal');
    saveValue('movieUntil', 0);
    document.documentElement.setAttribute('data-effect', 'normal');
    const btn = $('#btn-effect');
    if (btn) {
      btn.setAttribute('aria-pressed', 'false');
      btn.title = 'Color effect: normal (e)';
    }
    renderSidebar();
  }

  const coords = resolveCoordinates(state.location, now);
  const solar = computeSolarTimes(now, coords.lat, coords.lon, coords.tzOffsetMin);
  const mins = state.previewing && state.previewMinutes !== null
    ? state.previewMinutes
    : currentMinutes(now);
  const sched = computeScheduleKelvin(mins, solar, state);

  const isPaused = !state.enabled || (state.pauseUntil > Date.now());
  if (isPaused && !state.previewing) {
    return {
      kelvin: 6500,
      brightness: 100,
      phase: state.pauseMode === '1h' ? 'Paused (1h)' : state.pauseMode === 'sunrise' ? 'Paused until Sunrise' : 'Paused',
      activeSlot: sched.activeSlot,
      solar,
      bedtime: sched.bedtime,
      minutes: mins,
      coords,
      isPaused: true,
    };
  }

  if (state.effect === 'movie' && !state.previewing) {
    return {
      kelvin: 4200,
      brightness: state.brightness,
      phase: 'Movie Mode',
      activeSlot: sched.activeSlot,
      solar,
      bedtime: sched.bedtime,
      minutes: mins,
      coords,
      isPaused: false,
    };
  }

  if (state.mode === 'manual' && !state.previewing) {
    return {
      kelvin: state.manualK,
      brightness: state.brightness,
      phase: 'Manual Hold',
      activeSlot: 'day',
      solar,
      bedtime: sched.bedtime,
      minutes: mins,
      coords,
      isPaused: false,
    };
  }

  return {
    kelvin: sched.kelvin,
    brightness: state.brightness,
    phase: state.previewing ? `Preview · ${sched.phase}` : sched.phase,
    activeSlot: sched.activeSlot,
    solar,
    bedtime: sched.bedtime,
    minutes: mins,
    coords,
    isPaused: false,
  };
}

function kelvinSwatchCss(kelvin) {
  const rgb = kelvinToRgb(kelvin);
  const r = Math.round(rgb.r * 255);
  const g = Math.round(rgb.g * 255);
  const b = Math.round(rgb.b * 255);
  return `rgb(${r}, ${g}, ${b})`;
}

// The native controller drops any write whose seq is below the last one it saw,
// and it outlives the page: after a webview reload (F5 / Ctrl+R) a counter that
// restarted at 0 would be refused forever. Seeding from the clock keeps every
// page load's sequence above the previous one's (stays a safe integer).
let gammaSeq = Date.now() * 1000;
let gammaInFlight = false;
let pendingGammaReq = null;
let lastAppliedKey = '';
let activeGammaKey = '';

function formatDriverStatus() {
  if (!IS_NATIVE) return 'Browser Planckian Color-Matrix Preview';
  if (!state.hardwareActive) return 'Software Tint Fallback (GDI Restricted)';
  const res = state.hardwareResult;
  if (res && res.displaysTotal > 0 && res.displaysUpdated < res.displaysTotal) {
    return `Win32 GDI SetDeviceGammaRamp (Partial ${res.displaysUpdated}/${res.displaysTotal})`;
  }
  if (res && typeof res.strength === 'number' && res.strength < 0.995) {
    return `Win32 GDI SetDeviceGammaRamp (GDI Range Limited · ${Math.round(res.strength * 100)}%)`;
  }
  return 'Win32 GDI SetDeviceGammaRamp (Hardware LUT)';
}

function applyChannelReadout(r, g, b, brightness) {
  const rPct = Math.round(r * 100);
  const gPct = Math.round(g * 100);
  const bPct = Math.round(b * 100);

  const metaEl = $('#docmeta');
  if (metaEl) metaEl.textContent = `${brightness}% · R ${rPct}% G ${gPct}% B ${bPct}%`;
  const rgbEl = $('#channel-rgb');
  if (rgbEl) rgbEl.textContent = `R ${r.toFixed(3)} · G ${g.toFixed(3)} · B ${b.toFixed(3)}`;

  const barR = $('#bar-r');
  const barG = $('#bar-g');
  const barB = $('#bar-b');
  const pctR = $('#pct-r');
  const pctG = $('#pct-g');
  const pctB = $('#pct-b');
  if (barR) barR.style.width = `${rPct}%`;
  if (barG) barG.style.width = `${gPct}%`;
  if (barB) barB.style.width = `${bPct}%`;
  if (pctR) pctR.textContent = `${rPct}%`;
  if (pctG) pctG.textContent = `${gPct}%`;
  if (pctB) pctB.textContent = `${bPct}%`;
}

function updateHardwareStatusDom() {
  const driverEl = $('#driver-status');
  if (driverEl) driverEl.textContent = formatDriverStatus();
  const res = state.hardwareResult;
  if (IS_NATIVE && state.hardwareActive && res && Array.isArray(res.multipliers) && res.multipliers.length === 3) {
    const out = evaluateCurrentOutput();
    applyChannelReadout(res.multipliers[0], res.multipliers[1], res.multipliers[2], out.brightness);
  }
}

async function drainGammaQueue() {
  if (gammaInFlight) return;
  gammaInFlight = true;
  try {
    while (pendingGammaReq) {
      const req = pendingGammaReq;
      pendingGammaReq = null;
      if (req.key === lastAppliedKey) continue;
      const seq = ++gammaSeq;
      try {
        const res = req.isPaused
          ? await invoke('restore_display_gamma', { seq })
          : await invoke('apply_display_gamma', {
              kelvin: req.effKelvin,
              brightness: req.effBrightness,
              effect: req.effMode,
              seq,
            });
        if (res && res.stale) continue;
        if (res && typeof res.applied === 'boolean') {
          state.hardwareActive = res.applied;
          state.hardwareResult = res;
          if (res.applied) {
            lastAppliedKey = req.key;
          }
        } else {
          lastAppliedKey = req.key;
        }
        updateHardwareStatusDom();
      } catch {
        state.hardwareActive = false;
        state.hardwareResult = null;
        updateHardwareStatusDom();
      }
    }
  } finally {
    gammaInFlight = false;
  }
}

function pushGammaToHardware(kelvin, brightness, effect, isPaused) {
  // The native command takes `kelvin: u32`; a fractional value would fail to deserialize.
  const effKelvin = isPaused ? 6500 : Math.round(kelvin);
  const effBrightness = isPaused ? 100 : brightness;
  const effMode = isPaused ? 'normal' : effect;
  const key = `${effKelvin}:${effBrightness}:${effMode}`;
  activeGammaKey = key;

  if (!IS_NATIVE) return Promise.resolve();
  if (key === lastAppliedKey && !pendingGammaReq) return Promise.resolve();

  pendingGammaReq = { effKelvin, effBrightness, effMode, isPaused, key };
  return drainGammaQueue();
}

function updateWindowPreviewTint(kelvin, brightness, effect, isPaused) {
  const root = document.documentElement;
  if (!state.previewTint || isPaused || effect === 'darkroom') {
    root.style.setProperty('--tint-alpha', '0');
    root.style.setProperty('--dim-alpha', '0');
    return;
  }
  const rgb = kelvinToRgb(effect === 'movie' ? 4200 : kelvin);
  const r = Math.round(rgb.r * 255);
  const g = Math.round(rgb.g * 255);
  const b = Math.round(rgb.b * 255);
  // Warmth intensity scales smoothly from 0 at 6500K up to 0.34 at 1200K
  const warmthStrength = Math.max(0, Math.min(0.36, ((6500 - kelvin) / (6500 - 1200)) * 0.32));
  const dimAlpha = Math.max(0, Math.min(0.72, (100 - brightness) / 115));

  root.style.setProperty('--tint-r', String(r));
  root.style.setProperty('--tint-g', String(g));
  root.style.setProperty('--tint-b', String(b));
  root.style.setProperty('--tint-alpha', warmthStrength.toFixed(3));
  root.style.setProperty('--dim-alpha', dimAlpha.toFixed(3));
}

function renderSolarCurve(evalOut) {
  const { solar, minutes, kelvin } = evalOut;
  const width = 640;
  const topY = 18;
  const botY = 138;
  const kToY = k => {
    const clamped = clampNum(k, 1200, 6500, 3400);
    return botY - ((clamped - 1200) / (6500 - 1200)) * (botY - topY);
  };
  const mToX = m => (clampNum(m, 0, 1440, 0) / 1440) * width;

  const pts = [];
  for (let m = 0; m <= 1440; m += 15) {
    const s = computeScheduleKelvin(m, solar, state);
    const x = mToX(m).toFixed(1);
    const y = kToY(s.kelvin).toFixed(1);
    pts.push(`${m === 0 ? 'M' : 'L'}${x},${y}`);
  }
  const lineD = pts.join(' ');
  const areaD = `${lineD} L${width},146 L0,146 Z`;

  const lineEl = $('#curve-line');
  const areaEl = $('#curve-area');
  if (lineEl) lineEl.setAttribute('d', lineD);
  if (areaEl) areaEl.setAttribute('d', areaD);

  const srLine = $('#grid-sunrise');
  const ssLine = $('#grid-sunset');
  if (srLine) {
    const x = mToX(solar.sunrise).toFixed(1);
    srLine.setAttribute('x1', x);
    srLine.setAttribute('x2', x);
  }
  if (ssLine) {
    const x = mToX(solar.sunset).toFixed(1);
    ssLine.setAttribute('x1', x);
    ssLine.setAttribute('x2', x);
  }

  const curX = mToX(minutes).toFixed(1);
  const curY = kToY(kelvin).toFixed(1);
  const cursor = $('#curve-cursor');
  const dot = $('#curve-dot');
  if (cursor) {
    cursor.setAttribute('x1', curX);
    cursor.setAttribute('x2', curX);
  }
  if (dot) {
    dot.setAttribute('cx', curX);
    dot.setAttribute('cy', curY);
    dot.setAttribute('fill', kelvinSwatchCss(kelvin));
  }

  const timeLabel = $('#curve-time-label');
  if (timeLabel) {
    timeLabel.innerHTML = `${state.previewing ? 'Preview time' : 'Local time'}: <b>${formatMinutes(minutes)}</b> (${kelvin}K)`;
  }
  const curveWrap = $('#curve-container');
  if (curveWrap) {
    curveWrap.setAttribute('aria-valuenow', String(Math.round(minutes)));
    curveWrap.setAttribute('aria-valuetext', `${formatMinutes(minutes)} (${kelvin}K)`);
  }
}

function refreshOutput() {
  const out = evaluateCurrentOutput();
  const effKelvin = out.isPaused ? 6500 : Math.round(out.kelvin);
  const effBrightness = out.isPaused ? 100 : out.brightness;
  const effMode = out.isPaused ? 'normal' : state.effect;
  // Build from the effective values, so a paused display reads neutral even
  // while an effect such as Darkroom is still selected.
  const ramp = buildGammaRamp(effKelvin, effBrightness, effMode);
  const targetKey = `${effKelvin}:${effBrightness}:${effMode}`;
  const hwMatch = IS_NATIVE && state.hardwareActive && state.hardwareResult
    && lastAppliedKey === targetKey
    && Array.isArray(state.hardwareResult.multipliers)
    && state.hardwareResult.multipliers.length === 3;
  const [r, g, b] = hwMatch
    ? state.hardwareResult.multipliers
    : [ramp.multipliers.r, ramp.multipliers.g, ramp.multipliers.b];

  // Top bar
  const powerBtn = $('#btn-power');
  const powerLabel = $('#power-label');
  const liveDot = $('#live');
  if (powerBtn) powerBtn.setAttribute('aria-pressed', String(!out.isPaused));
  if (powerLabel) powerLabel.textContent = out.isPaused ? 'Paused' : 'Active';
  if (liveDot) {
    liveDot.className = out.isPaused ? 'paused' : 'on';
    liveDot.title = out.isPaused ? 'Display warmth paused' : 'Display gamma controller active';
  }

  const titleEl = $('#title');
  if (titleEl) {
    titleEl.innerHTML = `<b>${out.phase}</b> &middot; ${out.kelvin}K`;
  }
  const zoomVal = $('#zoomval');
  if (zoomVal) {
    zoomVal.textContent = `${out.kelvin}K`;
  }

  // Hero card
  const swatch = $('#phase-swatch');
  if (swatch) swatch.style.background = kelvinSwatchCss(out.kelvin);
  const phaseName = $('#phase-name');
  if (phaseName) phaseName.textContent = out.phase;
  const heroKelvin = $('#hero-kelvin');
  if (heroKelvin) {
    heroKelvin.innerHTML = `${out.kelvin}K <span id="hero-desc">${describeKelvin(out.kelvin, state.effect)}</span>`;
  }
  const heroSub = $('#hero-sub');
  if (heroSub) {
    const wakeStr = formatMinutes(state.wakeTime * 60);
    if (out.isPaused) {
      heroSub.textContent = 'Display is at neutral 6500K daylight';
    } else if (state.effect === 'movie' && !state.previewing) {
      const remMins = state.movieUntil > Date.now() ? Math.max(1, Math.ceil((state.movieUntil - Date.now()) / 60000)) : 150;
      const hrs = Math.floor(remMins / 60);
      const mins = remMins % 60;
      heroSub.textContent = `Cinema warmth at 4200K · ${hrs}h ${mins}m remaining`;
    } else if (state.mode === 'manual') {
      heroSub.textContent = `Manual hold at ${out.kelvin}K · ${out.brightness}% brightness`;
    } else {
      heroSub.textContent = `Solar schedule (${out.coords.lat.toFixed(1)}°, ${out.coords.lon.toFixed(1)}°) · Wake at ${wakeStr}`;
    }
  }

  const srEl = $('#stat-sunrise');
  const ssEl = $('#stat-sunset');
  const btEl = $('#stat-bedtime');
  if (srEl) srEl.textContent = formatMinutes(out.solar.sunrise);
  if (ssEl) ssEl.textContent = formatMinutes(out.solar.sunset);
  if (btEl) btEl.textContent = formatMinutes(out.bedtime);

  // Sliders & swatches
  const daySwatch = $('#swatch-day');
  const sunsetSwatch = $('#swatch-sunset');
  const nightSwatch = $('#swatch-night');
  if (daySwatch) daySwatch.style.background = kelvinSwatchCss(state.dayK);
  if (sunsetSwatch) sunsetSwatch.style.background = kelvinSwatchCss(state.sunsetK);
  if (nightSwatch) nightSwatch.style.background = kelvinSwatchCss(state.nightK);

  const valDay = $('#val-day');
  const valSunset = $('#val-sunset');
  const valNight = $('#val-night');
  const valBri = $('#val-brightness');
  if (valDay) valDay.textContent = `${state.dayK}K`;
  if (valSunset) valSunset.textContent = `${state.sunsetK}K`;
  if (valNight) valNight.textContent = `${state.nightK}K`;
  if (valBri) valBri.textContent = `${state.brightness}%`;

  const descDay = $('#desc-day');
  const descSunset = $('#desc-sunset');
  const descNight = $('#desc-night');
  const descBri = $('#desc-brightness');
  if (descDay) descDay.textContent = describeKelvin(state.dayK).split(' ')[0];
  if (descSunset) descSunset.textContent = describeKelvin(state.sunsetK).split(' ')[0];
  if (descNight) descNight.textContent = describeKelvin(state.nightK).split(' ')[0];
  if (descBri) descBri.textContent = state.brightness === 100 ? 'Full output' : 'Dimmed';

  const cardDay = $('#card-day');
  const cardSunset = $('#card-sunset');
  const cardNight = $('#card-night');
  if (cardDay) cardDay.classList.toggle('active-phase', !out.isPaused && out.activeSlot === 'day');
  if (cardSunset) cardSunset.classList.toggle('active-phase', !out.isPaused && out.activeSlot === 'sunset');
  if (cardNight) cardNight.classList.toggle('active-phase', !out.isPaused && out.activeSlot === 'night');

  // Mode buttons
  const manualLabel = $('#manual-k-label');
  if (manualLabel) manualLabel.textContent = `${state.manualK}K`;
  const mSched = $('#mode-schedule');
  const mManual = $('#mode-manual');
  const mPause1h = $('#mode-pause-1h');
  const mPauseSr = $('#mode-pause-sunrise');
  const mMovie = $('#mode-movie');
  const mDark = $('#mode-darkroom');
  if (mSched) mSched.setAttribute('data-active', String(!out.isPaused && state.mode === 'solar' && state.effect === 'normal'));
  if (mManual) mManual.setAttribute('data-active', String(!out.isPaused && state.mode === 'manual' && state.effect === 'normal'));
  if (mPause1h) mPause1h.setAttribute('data-active', String(out.isPaused && state.pauseMode === '1h'));
  if (mPauseSr) mPauseSr.setAttribute('data-active', String(out.isPaused && state.pauseMode === 'sunrise'));
  if (mMovie) mMovie.setAttribute('data-active', String(!out.isPaused && state.effect === 'movie'));
  if (mDark) mDark.setAttribute('data-active', String(!out.isPaused && state.effect === 'darkroom'));

  const btnPauseHour = $('#btn-pause-hour');
  if (btnPauseHour) btnPauseHour.setAttribute('aria-pressed', String(out.isPaused && state.pauseMode === '1h'));

  // Gamma panel
  const driverEl = $('#driver-status');
  if (driverEl) {
    driverEl.textContent = formatDriverStatus();
  }
  applyChannelReadout(r, g, b, out.brightness);
  const dispEl = $('#display-list');
  if (dispEl) {
    dispEl.textContent = state.displays.join(', ');
  }

  renderSolarCurve(out);
  updateWindowPreviewTint(out.kelvin, out.brightness, state.effect, out.isPaused);
  pushGammaToHardware(out.kelvin, out.brightness, state.effect, out.isPaused);
}

function renderSidebar() {
  const presetList = $('#preset-list');
  if (presetList) {
    presetList.innerHTML = PRESETS.map(p => {
      const active = state.mode === 'solar' && state.dayK === p.dayK && state.sunsetK === p.sunsetK && state.nightK === p.nightK;
      return `<a role="button" tabindex="0" data-preset="${p.id}" class="${active ? 'active' : ''}"><span>${p.name}</span><small>${p.tag}</small></a>`;
    }).join('');
  }

  const effectList = $('#effect-list');
  if (effectList) {
    effectList.innerHTML = EFFECTS.map(e => {
      const active = state.effect === e.id;
      return `<a role="button" tabindex="0" data-effect-item="${e.id}" class="${active ? 'active' : ''}"><span>${e.name}</span><small>${e.tag}</small></a>`;
    }).join('');
  }

  const quickList = $('#quick-temp-list');
  if (quickList) {
    quickList.innerHTML = QUICK_TEMPS.map(q => {
      const active = state.mode === 'manual' && state.manualK === q.kelvin;
      return `<a role="button" tabindex="0" data-quick-k="${q.kelvin}" class="${active ? 'active' : ''}"><span>${q.name}</span><small>${q.tag}</small></a>`;
    }).join('');
  }
}

function syncControlsFromState() {
  const sDay = $('#slider-day');
  const sSunset = $('#slider-sunset');
  const sNight = $('#slider-night');
  const sBri = $('#slider-brightness');
  if (sDay) sDay.value = String(state.dayK);
  if (sSunset) sSunset.value = String(state.sunsetK);
  if (sNight) sNight.value = String(state.nightK);
  if (sBri) sBri.value = String(state.brightness);

  const cfgWake = $('#cfg-waketime');
  const cfgWakeVal = $('#cfg-waketime-val');
  if (cfgWake) cfgWake.value = String(state.wakeTime);
  if (cfgWakeVal) cfgWakeVal.textContent = formatMinutes(state.wakeTime * 60);

  const cfgLoc = $('#cfg-location');
  if (cfgLoc) cfgLoc.value = state.location;
  const cfgCoordsVal = $('#cfg-coords-val');
  if (cfgCoordsVal) {
    const coords = resolveCoordinates(state.location);
    cfgCoordsVal.textContent = `${coords.lat.toFixed(1)}°, ${coords.lon.toFixed(1)}°`;
  }

  const cfgStep = $('#cfg-step');
  const cfgStepVal = $('#cfg-step-val');
  if (cfgStep) cfgStep.value = String(state.stepSize);
  if (cfgStepVal) cfgStepVal.textContent = `${state.stepSize}K`;

  const cfgText = $('#cfg-textsize');
  const cfgTextVal = $('#cfg-textsize-val');
  if (cfgText) cfgText.value = String(state.textSize);
  if (cfgTextVal) cfgTextVal.textContent = `${state.textSize}px`;
  document.documentElement.style.setProperty('--base-size', `${state.textSize}px`);

  const cfgTint = $('#cfg-preview-tint');
  if (cfgTint) cfgTint.checked = state.previewTint;

  const cfgKeep = $('#cfg-restore-quit');
  if (cfgKeep) cfgKeep.checked = state.keepOnClose;

  const cfgUpdStart = $('#cfg-update-on-start');
  if (cfgUpdStart) cfgUpdStart.checked = state.updateOnStart;
  const cfgUpdHint = $('#cfg-update-hint');
  if (cfgUpdHint && !pendingUpdate && !checkingUpdates) {
    cfgUpdHint.textContent = state.updateOnStart
      ? 'Checked automatically when the app starts'
      : 'Automatic startup checks disabled';
  }

  const modeSeg = $('#cfg-mode');
  if (modeSeg) {
    for (const btn of modeSeg.querySelectorAll('button')) {
      btn.setAttribute('aria-checked', String(btn.dataset.val === state.mode));
    }
  }
  const transSeg = $('#cfg-transition');
  if (transSeg) {
    for (const btn of transSeg.querySelectorAll('button')) {
      btn.setAttribute('aria-checked', String(btn.dataset.val === state.transition));
    }
  }
  const transHint = $('#cfg-transition-hint');
  if (transHint) {
    const mins = state.transition === 'fast' ? 10 : state.transition === 'slow' ? 60 : 20;
    const adj = state.transition === 'fast' ? 'Quick' : state.transition === 'slow' ? 'Slow' : 'Gradual';
    transHint.textContent = `${adj} ${mins}-minute crossfade at sunrise, sunset and bedtime`;
  }
}

let previewTimer = 0;
function start24hPreview() {
  if (state.previewing) {
    stop24hPreview();
    return;
  }
  state.previewing = true;
  state.previewMinutes = currentMinutes();
  const startMin = state.previewMinutes;
  let elapsedSteps = 0;
  const totalSteps = 96; // 15-min increments across 24 hours (~6.5 seconds)
  const btn = $('#btn-preview');
  if (btn) btn.setAttribute('aria-pressed', 'true');
  toast('Previewing 24-hour solar cycle…');

  previewTimer = setInterval(() => {
    elapsedSteps++;
    if (elapsedSteps >= totalSteps) {
      stop24hPreview();
      return;
    }
    state.previewMinutes = (startMin + elapsedSteps * 15) % 1440;
    refreshOutput();
  }, 65);
}

function stop24hPreview() {
  if (!state.previewing) return;
  clearInterval(previewTimer);
  state.previewing = false;
  state.previewMinutes = null;
  const btn = $('#btn-preview');
  if (btn) btn.setAttribute('aria-pressed', 'false');
  refreshOutput();
}

function resetSettings() {
  Object.assign(state, {
    theme: DEFAULTS.theme,
    width: DEFAULTS.width,
    font: DEFAULTS.font,
    enabled: true,
    mode: DEFAULTS.mode,
    dayK: DEFAULTS.dayK,
    sunsetK: DEFAULTS.sunsetK,
    nightK: DEFAULTS.nightK,
    manualK: DEFAULTS.manualK,
    brightness: DEFAULTS.brightness,
    transition: DEFAULTS.transition,
    wakeTime: DEFAULTS.wakeTime,
    location: DEFAULTS.location,
    stepSize: DEFAULTS.stepSize,
    textSize: DEFAULTS.textSize,
    previewTint: DEFAULTS.previewTint,
    keepOnClose: DEFAULTS.keepOnClose,
    updateOnStart: DEFAULTS.updateOnStart,
    effect: DEFAULTS.effect,
    movieUntil: 0,
    pauseUntil: 0,
    pauseMode: null,
    activePreset: DEFAULTS.activePreset,
  });
  for (const key of Object.keys(DEFAULTS)) {
    saveValue(key, state[key]);
  }
  syncKeepOnClose(DEFAULTS.keepOnClose);
  applyTheme(state.theme, false);
  applyWidth(state.width, false);
  applyFont(state.font, false);
  applyEffect(state.effect, false);
  syncControlsFromState();
  renderSidebar();
  refreshOutput();
  toast('Reset to defaults');
}

let lastFocusBeforeSettings = null;
function getSettingsFocusable() {
  const panel = $('#settings');
  if (!panel) return [];
  return [...panel.querySelectorAll('button, input, select, [tabindex]:not([tabindex="-1"])')]
    .filter(el => !el.disabled && el.offsetParent !== null);
}

function toggleSettings(force) {
  const panel = $('#settings');
  const btn = $('#btn-settings');
  if (!panel) return;
  const wasOpen = panel.classList.contains('on');
  const next = typeof force === 'boolean' ? force : !wasOpen;
  if (next === wasOpen) return;
  panel.classList.toggle('on', next);
  if (btn) btn.setAttribute('aria-pressed', String(next));
  if (next) {
    lastFocusBeforeSettings = document.activeElement || btn || null;
    const focusables = getSettingsFocusable();
    if (focusables.length > 0) focusables[0].focus();
  } else if (lastFocusBeforeSettings && typeof lastFocusBeforeSettings.focus === 'function') {
    if (panel.contains(document.activeElement)) {
      lastFocusBeforeSettings.focus();
    }
    lastFocusBeforeSettings = null;
  }
}

let pendingUpdate = null;
let checkingUpdates = false;
async function checkForUpdates(manual = false) {
  if (!IS_NATIVE || checkingUpdates) return;
  checkingUpdates = true;
  const btn = $('#cfg-check');
  const hint = $('#cfg-update-hint');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Checking…';
  }
  if (hint) hint.textContent = 'Checking for updates…';

  try {
    const update = await checkUpdate();
    if (update) {
      pendingUpdate = update;
      if (hint) hint.textContent = `Update available: v${update.version}`;
      const banner = $('#update');
      const textEl = $('#update-text');
      if (textEl) textEl.textContent = `Night Light v${update.version} is available`;
      if (banner) banner.classList.add('on');
    } else {
      pendingUpdate = null;
      if (hint) hint.textContent = 'You are on the latest version';
      if (manual) toast('Night Light is up to date');
    }
  } catch {
    if (hint) hint.textContent = 'Update check unavailable';
    if (manual) toast('Could not check for updates');
  } finally {
    checkingUpdates = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Check for updates';
    }
  }
}

function bindEvents() {
  const on = (sel, evt, fn) => {
    const el = $(sel);
    if (el) el.addEventListener(evt, fn);
  };

  const returnToSolar = () => {
    state.mode = 'solar';
    clearPauseAndEnable();
    saveValue('mode', 'solar');
    applyEffect('normal', false);
    syncControlsFromState();
    refreshOutput();
    toast('Following solar schedule');
  };

  on('#btn-power', 'click', () => togglePower());
  on('#btn-outline', 'click', () => toggleOutline());
  on('#btn-warmer', 'click', () => stepKelvin(-1));
  on('#btn-cooler', 'click', () => stepKelvin(1));
  on('#zoomval', 'click', returnToSolar);
  on('#zoomval', 'keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      returnToSolar();
    }
  });
  on('#btn-preview', 'click', () => start24hPreview());
  on('#btn-pause-hour', 'click', () => pauseForOneHour());
  on('#btn-effect', 'click', () => cycleEffect());
  on('#btn-width', 'click', () => cycleWidth());
  on('#btn-font', 'click', () => toggleFont());
  on('#btn-theme', 'click', () => cycleTheme());
  on('#btn-settings', 'click', e => {
    e.stopPropagation();
    toggleSettings();
  });

  // Schedule sliders
  on('#slider-day', 'input', e => {
    state.dayK = Number(e.target.value);
    if (state.mode === 'manual') {
      state.manualK = state.dayK;
      saveValue('manualK', state.manualK);
    }
    clearPauseAndEnable();
    saveValue('dayK', state.dayK);
    refreshOutput();
  });
  on('#slider-sunset', 'input', e => {
    state.sunsetK = Number(e.target.value);
    clearPauseAndEnable();
    saveValue('sunsetK', state.sunsetK);
    refreshOutput();
  });
  on('#slider-night', 'input', e => {
    state.nightK = Number(e.target.value);
    clearPauseAndEnable();
    saveValue('nightK', state.nightK);
    refreshOutput();
  });
  on('#slider-brightness', 'input', e => {
    state.brightness = Number(e.target.value);
    saveValue('brightness', state.brightness);
    refreshOutput();
  });

  // Quick mode cards
  on('#mode-schedule', 'click', returnToSolar);
  on('#mode-manual', 'click', () => {
    const out = evaluateCurrentOutput();
    state.manualK = out.kelvin;
    state.mode = 'manual';
    clearPauseAndEnable();
    saveValue('manualK', state.manualK);
    saveValue('mode', 'manual');
    applyEffect('normal', false);
    syncControlsFromState();
    refreshOutput();
    toast(`Manual hold at ${state.manualK}K`);
  });
  on('#mode-pause-1h', 'click', () => pauseForOneHour());
  on('#mode-pause-sunrise', 'click', () => pauseUntilSunrise());
  on('#mode-movie', 'click', () => {
    clearPauseAndEnable();
    applyEffect(state.effect === 'movie' ? 'normal' : 'movie', true);
  });
  on('#mode-darkroom', 'click', () => {
    clearPauseAndEnable();
    applyEffect(state.effect === 'darkroom' ? 'normal' : 'darkroom', true);
  });

  // Interactive 24h curve scrubbing
  const curveWrap = $('#curve-container');
  if (curveWrap) {
    let scrubbing = false;
    let scrubRaf = 0;
    let pendingClientX = 0;
    const scrubAt = clientX => {
      const rect = curveWrap.getBoundingClientRect();
      if (!rect.width) return;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      state.previewing = true;
      state.previewMinutes = Math.round(ratio * 1440);
      refreshOutput();
    };
    curveWrap.addEventListener('pointerdown', e => {
      stop24hPreview();
      scrubbing = true;
      scrubAt(e.clientX);
    });
    window.addEventListener('pointermove', e => {
      if (!scrubbing) return;
      pendingClientX = e.clientX;
      if (typeof requestAnimationFrame === 'function') {
        if (!scrubRaf) {
          scrubRaf = requestAnimationFrame(() => {
            scrubRaf = 0;
            if (scrubbing) scrubAt(pendingClientX);
          });
        }
      } else {
        scrubAt(pendingClientX);
      }
    });
    window.addEventListener('pointerup', () => {
      if (scrubbing) {
        scrubbing = false;
        if (scrubRaf && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(scrubRaf);
          scrubRaf = 0;
        }
        state.previewing = false;
        state.previewMinutes = null;
        refreshOutput();
      }
    });
    curveWrap.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        stop24hPreview();
        const base = state.previewing && state.previewMinutes !== null ? state.previewMinutes : currentMinutes();
        const delta = (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 60 : 15);
        state.previewing = true;
        state.previewMinutes = ((base + delta) % 1440 + 1440) % 1440;
        refreshOutput();
      } else if (e.key === 'Escape' && state.previewing) {
        state.previewing = false;
        state.previewMinutes = null;
        refreshOutput();
      }
    });
    curveWrap.addEventListener('blur', () => {
      if (!scrubbing && state.previewing && !previewTimer) {
        state.previewing = false;
        state.previewMinutes = null;
        refreshOutput();
      }
    });
  }

  // Outline sidebar clicks & keyboard activation
  const activateSidebarTarget = target => {
    const presetItem = target.closest('[data-preset]');
    if (presetItem) {
      selectPreset(presetItem.dataset.preset, true);
      return true;
    }
    const effectItem = target.closest('[data-effect-item]');
    if (effectItem) {
      applyEffect(effectItem.dataset.effectItem, true);
      return true;
    }
    const quickItem = target.closest('[data-quick-k]');
    if (quickItem) {
      setQuickTemp(Number(quickItem.dataset.quickK), true);
      return true;
    }
    return false;
  };
  on('#outline', 'click', e => {
    activateSidebarTarget(e.target);
  });
  on('#outline', 'keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      if (activateSidebarTarget(e.target)) e.preventDefault();
    }
  });

  // Settings panel controls
  on('#cfg-mode', 'click', e => {
    const btn = e.target.closest('button[data-val]');
    if (!btn) return;
    state.mode = btn.dataset.val === 'manual' ? 'manual' : 'solar';
    saveValue('mode', state.mode);
    syncControlsFromState();
    refreshOutput();
  });
  on('#cfg-transition', 'click', e => {
    const btn = e.target.closest('button[data-val]');
    if (!btn) return;
    state.transition = btn.dataset.val;
    saveValue('transition', state.transition);
    syncControlsFromState();
    refreshOutput();
  });
  on('#cfg-waketime', 'input', e => {
    state.wakeTime = Number(e.target.value);
    saveValue('wakeTime', state.wakeTime);
    syncControlsFromState();
    refreshOutput();
  });
  on('#cfg-location', 'change', e => {
    state.location = e.target.value;
    saveValue('location', state.location);
    syncControlsFromState();
    refreshOutput();
  });
  on('#cfg-step', 'input', e => {
    state.stepSize = Number(e.target.value);
    saveValue('stepSize', state.stepSize);
    syncControlsFromState();
  });
  on('#cfg-textsize', 'input', e => {
    state.textSize = Number(e.target.value);
    saveValue('textSize', state.textSize);
    syncControlsFromState();
  });
  on('#cfg-preview-tint', 'change', e => {
    state.previewTint = Boolean(e.target.checked);
    saveValue('previewTint', state.previewTint);
    refreshOutput();
  });
  on('#cfg-restore-quit', 'change', async e => {
    const prev = state.keepOnClose;
    const next = Boolean(e.target.checked);
    state.keepOnClose = next;
    saveValue('keepOnClose', next);
    const ok = await syncKeepOnClose(next);
    if (!ok) {
      state.keepOnClose = prev;
      saveValue('keepOnClose', prev);
      e.target.checked = prev;
    }
  });
  on('#cfg-update-on-start', 'change', e => {
    state.updateOnStart = Boolean(e.target.checked);
    saveValue('updateOnStart', state.updateOnStart);
    syncControlsFromState();
  });
  on('#cfg-check', 'click', () => checkForUpdates(true));
  on('#update-later', 'click', () => {
    $('#update')?.classList.remove('on');
  });
  on('#update-go', 'click', async () => {
    if (!pendingUpdate) return;
    const goBtn = $('#update-go');
    if (goBtn) {
      goBtn.disabled = true;
      goBtn.textContent = 'Installing…';
    }
    try {
      await pendingUpdate.downloadAndInstall();
      await relaunch();
    } catch {
      toast('Update installation failed');
      if (goBtn) {
        goBtn.disabled = false;
        goBtn.textContent = 'Update';
      }
    }
  });
  on('#cfg-reset', 'click', () => resetSettings());

  // Scroll shadow on #chrome
  const scroller = $('#scroller');
  if (scroller) {
    scroller.addEventListener('scroll', () => {
      const chrome = $('#chrome');
      if (chrome) chrome.classList.toggle('scrolled', scroller.scrollTop > 6);
    });
  }

  // Close settings on outside click
  document.addEventListener('click', e => {
    const panel = $('#settings');
    const btn = $('#btn-settings');
    if (panel && panel.classList.contains('on')) {
      if (!panel.contains(e.target) && (!btn || !btn.contains(e.target))) {
        toggleSettings(false);
      }
    }
  });

  // Focus trap inside modal settings dialog
  on('#settings', 'keydown', e => {
    if (e.key !== 'Tab') return;
    const focusables = getSettingsFocusable();
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  // Keyboard shortcuts (matching Markdown Viewer conventions)
  window.addEventListener('keydown', e => {
    const tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      if (e.key === 'Escape') toggleSettings(false);
      return;
    }
    if (e.key === 'Escape') {
      stop24hPreview();
      toggleSettings(false);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (e.key === '0') {
        e.preventDefault();
        $('#zoomval')?.click();
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        stepKelvin(1);
      } else if (e.key === '-') {
        e.preventDefault();
        stepKelvin(-1);
      }
      return;
    }
    if (e.key === ' ' && (tag === 'button' || e.target?.closest?.('[role="button"]'))) {
      return;
    }
    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePower();
        break;
      case '+':
      case '=':
        e.preventDefault();
        stepKelvin(1);
        break;
      case '-':
        e.preventDefault();
        stepKelvin(-1);
        break;
      case '0':
        e.preventDefault();
        $('#zoomval')?.click();
        break;
      case 'p':
        e.preventDefault();
        start24hPreview();
        break;
      case 'h':
        e.preventDefault();
        pauseForOneHour();
        break;
      case 'e':
        e.preventDefault();
        cycleEffect();
        break;
      case 'o':
        e.preventDefault();
        toggleOutline();
        break;
      case 't':
        e.preventDefault();
        cycleTheme();
        break;
      case 'w':
        e.preventDefault();
        cycleWidth();
        break;
      case 'f':
        e.preventDefault();
        toggleFont();
        break;
      case ',':
        e.preventDefault();
        toggleSettings();
        break;
    }
  });
}

const boot = (async function boot() {
  applyTheme(state.theme, false);
  applyWidth(state.width, false);
  applyFont(state.font, false);
  toggleOutline(state.outline === 'on');
  applyEffect(state.effect, false, { preserveTimer: true });
  syncControlsFromState();
  renderSidebar();
  bindEvents();

  if (IS_NATIVE) {
    try {
      const displays = await invoke('list_displays');
      if (Array.isArray(displays) && displays.length > 0) {
        state.displays = displays;
      }
      await invoke('set_keep_gamma_on_exit', { keep: state.keepOnClose });
    } catch { /* ignore in non-desktop fixtures */ }

    try {
      const ver = await getVersion();
      const vEl = $('#cfg-version');
      if (vEl && ver) vEl.textContent = `v${ver}`;
    } catch { /* ignore */ }
  } else {
    const updField = $('#cfg-update');
    const updStartField = $('#cfg-update-start-field');
    const keepField = $('#cfg-restore-quit-field');
    if (updField) updField.style.display = 'none';
    if (updStartField) updStartField.style.display = 'none';
    if (keepField) keepField.style.display = 'none';
  }

  refreshOutput();

  if (IS_NATIVE && state.updateOnStart) {
    checkForUpdates(false);
  }

  // Periodic 30-second solar schedule tick
  setInterval(() => {
    if (!state.previewing) refreshOutput();
  }, 30000);
})();
