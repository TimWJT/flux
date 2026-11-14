import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const project = new URL('../', import.meta.url);

function loadEngine(overrides = {}) {
  const source = readFileSync(new URL('src/main.js', project), 'utf8')
    .replace(/^import\s+[^;]+;\s*$/gm, '')
    .replace(/const boot = \(async function boot\(\) \{[\s\S]*?\}\)\(\);/, '');

  const storage = new Map(Object.entries(overrides.storage || {}));
  const elements = new Map(Object.entries(overrides.elements || {}));
  const listeners = new Map();

  const makeEl = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: '',
        checked: false,
        textContent: '',
        innerHTML: '',
        style: { setProperty() {} },
        classList: {
          _set: new Set(),
          add(c) { this._set.add(c); },
          remove(c) { this._set.delete(c); },
          toggle(c, f) { if (f === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (f) this._set.add(c); else this._set.delete(c); },
          contains(c) { return this._set.has(c); },
        },
        attrs: new Map(),
        setAttribute(k, v) { this.attrs.set(k, String(v)); },
        getAttribute(k) { return this.attrs.get(k) ?? null; },
        addEventListener(evt, fn) {
          const key = `${id}:${evt}`;
          if (!listeners.has(key)) listeners.set(key, []);
          listeners.get(key).push(fn);
        },
        querySelectorAll() { return []; },
      });
    }
    return elements.get(id);
  };

  const context = vm.createContext({
    console,
    Math,
    Date,
    Intl,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON,
    Promise,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    window: { addEventListener() {}, ...(overrides.window || {}) },
    document: {
      documentElement: {
        style: { setProperty() {} },
        setAttribute() {},
        removeAttribute() {},
      },
      activeElement: null,
      querySelector: sel => (sel.startsWith('#') ? makeEl(sel.slice(1)) : null),
      addEventListener() {},
    },
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, v),
    },
    invoke: overrides.invoke || (async () => ({ applied: true, stale: false, displaysTotal: 1, displaysUpdated: 1, strength: 1, multipliers: [1, 1, 1], requested: [1, 1, 1] })),
    getVersion: async () => '1.1.0',
    checkUpdate: async () => null,
    relaunch: async () => {},
    _storage: storage,
    _elements: elements,
    _listeners: listeners,
  });

  vm.runInContext(source, context);
  return context;
}

test('kelvinToRgb: 6500K is exact neutral white and warmth reduces blue & green monotonically', () => {
  const ctx = loadEngine();
  const d65 = ctx.kelvinToRgb(6500);
  assert.deepEqual({ ...d65 }, { r: 1, g: 1, b: 1 });

  const k4200 = ctx.kelvinToRgb(4200);
  const k3400 = ctx.kelvinToRgb(3400);
  const k2300 = ctx.kelvinToRgb(2300);
  const k1800 = ctx.kelvinToRgb(1800);

  assert.equal(k3400.r, 1);
  assert.ok(k4200.g > k3400.g && k3400.g > k2300.g && k2300.g > k1800.g);
  assert.ok(k4200.b > k3400.b && k3400.b > k2300.b);
  assert.equal(k1800.b, 0);
});

test('buildGammaRamp: constructs 256-entry 16-bit LUT for normal and darkroom modes', () => {
  const ctx = loadEngine();
  const neutral = ctx.buildGammaRamp(6500, 100, 'normal');
  assert.equal(neutral.r.length, 256);
  assert.equal(neutral.r[0], 0);
  assert.equal(neutral.r[255], 65535);
  assert.equal(neutral.g[255], 65535);
  assert.equal(neutral.b[255], 65535);

  const darkroom = ctx.buildGammaRamp(3400, 100, 'darkroom');
  assert.equal(darkroom.r[255], 65535);
  assert.equal(darkroom.g[255], 0);
  assert.equal(darkroom.b[255], 0);
});

test('computeSolarTimes & computeScheduleKelvin: transitions across Day, Sunset and Bedtime', () => {
  const ctx = loadEngine();
  const solar = ctx.computeSolarTimes(new Date('2026-03-21T12:00:00Z'), -33.87, 151.21, 660); // Sydney AEDT, so the test doesn't depend on the machine's timezone
  assert.ok(solar.sunrise >= 180 && solar.sunrise <= 660);
  assert.ok(solar.sunset >= 900 && solar.sunset <= 1350);

  const cfg = {
    dayK: 6500,
    sunsetK: 3400,
    nightK: 2300,
    wakeTime: 7.0,
    transition: 'medium',
  };

  const midday = ctx.computeScheduleKelvin(720, { sunrise: 360, sunset: 1140 }, cfg);
  assert.equal(midday.kelvin, 6500);
  assert.equal(midday.phase, 'Daytime');

  const evening = ctx.computeScheduleKelvin(1260, { sunrise: 360, sunset: 1140 }, cfg);
  assert.equal(evening.kelvin, 3400);
  assert.equal(evening.phase, 'Sunset');

  const lateNight = ctx.computeScheduleKelvin(120, { sunrise: 360, sunset: 1140 }, cfg);
  assert.equal(lateNight.kelvin, 2300);
  assert.equal(lateNight.phase, 'Bedtime');
});

test('transition spans match 10m / 20m / 60m labels and crossfade smoothly', () => {
  const ctx = loadEngine();
  const solar = { sunrise: 360, sunset: 1140 };
  const base = { dayK: 6500, sunsetK: 3400, nightK: 2300, wakeTime: 7.0 };

  // Medium (20m): [1130, 1150]. At 1132, already inside transition (<6500K).
  const medStart = ctx.computeScheduleKelvin(1132, solar, { ...base, transition: 'medium' });
  assert.ok(medStart.kelvin < 6500 && medStart.kelvin > 3400);

  // Fast (10m): [1135, 1145]. At 1132, still Daytime (6500K).
  const fastBefore = ctx.computeScheduleKelvin(1132, solar, { ...base, transition: 'fast' });
  assert.equal(fastBefore.kelvin, 6500);

  // Slow (60m): [1110, 1170]. At 1115, already transitioning (<6500K).
  const slowStart = ctx.computeScheduleKelvin(1115, solar, { ...base, transition: 'slow' });
  assert.ok(slowStart.kelvin < 6500 && slowStart.kelvin > 3400);
});

test('resolveCoordinates: auto mode uses standard-time meridian across DST and city presets use city timezone', () => {
  const ctx = loadEngine();
  const jan = new Date('2026-01-15T12:00:00Z');
  const jul = new Date('2026-07-15T12:00:00Z');
  const autoJan = ctx.resolveCoordinates('auto', jan);
  const autoJul = ctx.resolveCoordinates('auto', jul);
  assert.equal(autoJan.lon, autoJul.lon);
  assert.equal(autoJan.lat, autoJul.lat);

  // London preset should compute ~06:00-07:00 sunrise & ~18:00 sunset at equinox regardless of host TZ
  const london = ctx.resolveCoordinates('51.51,-0.13', new Date('2026-03-21T12:00:00Z'));
  assert.equal(london.tzOffsetMin, 0);
  const londonSolar = ctx.computeSolarTimes(new Date('2026-03-21T12:00:00Z'), london.lat, london.lon, london.tzOffsetMin);
  assert.ok(londonSolar.sunrise >= 330 && londonSolar.sunrise <= 400, `London sunrise ${londonSolar.sunrise}`);
  assert.ok(londonSolar.sunset >= 1060 && londonSolar.sunset <= 1140, `London sunset ${londonSolar.sunset}`);
});

test('resetSettings syncs keepOnClose=false to native backend and clears movie/pause timers', async () => {
  const calls = [];
  const ctx = loadEngine({
    window: { __TAURI_INTERNALS__: {} },
    storage: { 'flux.keepOnClose': 'true', 'flux.pauseUntil': String(Date.now() + 60000), 'flux.pauseMode': '"1h"' },
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      return { applied: true, stale: false, displaysTotal: 1, displaysUpdated: 1, strength: 1, multipliers: [1, 1, 1], requested: [1, 1, 1] };
    },
  });

  ctx.resetSettings();
  await Promise.resolve();
  const keepCall = calls.find(c => c.cmd === 'set_keep_gamma_on_exit');
  assert.ok(keepCall);
  assert.equal(keepCall.args.keep, false);
  assert.equal(ctx._storage.get('flux.pauseUntil'), '0');
  assert.equal(ctx._storage.get('flux.pauseMode'), 'null');
});

test('sliders and stepKelvin persist pause cancellation and manualK', () => {
  const ctx = loadEngine({
    storage: {
      'flux.mode': '"manual"',
      'flux.pauseUntil': String(Date.now() + 60000),
      'flux.pauseMode': '"1h"',
    },
  });
  ctx.bindEvents();
  const dayListeners = ctx._listeners.get('slider-day:input');
  assert.ok(dayListeners && dayListeners.length > 0);
  dayListeners[0]({ target: { value: '2700' } });

  assert.equal(ctx._storage.get('flux.manualK'), '2700');
  assert.equal(ctx._storage.get('flux.pauseUntil'), '0');
  assert.equal(ctx._storage.get('flux.pauseMode'), 'null');
  assert.equal(ctx._storage.get('flux.enabled'), 'true');

  // Re-pause and confirm stepKelvin also persists pause cancellation
  ctx.pauseForOneHour();
  ctx.stepKelvin(-1);
  assert.equal(ctx._storage.get('flux.manualK'), '2500');
  assert.equal(ctx._storage.get('flux.pauseUntil'), '0');
  assert.equal(ctx._storage.get('flux.pauseMode'), 'null');
});

test('pushGammaToHardware sends monotonic seq, retries after failure, and displays clamped hardware multipliers', async () => {
  const calls = [];
  let failNext = true;
  const ctx = loadEngine({
    window: { __TAURI_INTERNALS__: {} },
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'apply_display_gamma') {
        if (failNext) {
          failNext = false;
          throw new Error('transient GDI error');
        }
        return {
          applied: true,
          stale: false,
          displaysTotal: 1,
          displaysUpdated: 1,
          strength: 0.65,
          multipliers: [1.0, 0.72, 0.55],
          requested: [1.0, 0.2, 0.0],
        };
      }
      return { applied: true, stale: false, displaysTotal: 1, displaysUpdated: 1, strength: 1, multipliers: [1, 1, 1], requested: [1, 1, 1] };
    },
  });

  await ctx.pushGammaToHardware(2300, 100, 'normal', false);
  assert.equal(calls.length, 1);
  const firstSeq = calls[0].args.seq;
  assert.ok(Number.isSafeInteger(firstSeq));

  // Same key MUST retry because the first attempt failed
  await ctx.pushGammaToHardware(2300, 100, 'normal', false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.seq, firstSeq + 1);
  assert.match(ctx._elements.get('driver-status').textContent, /GDI Range Limited · 65%/);
  assert.equal(ctx._elements.get('channel-rgb').textContent, 'R 1.000 · G 0.720 · B 0.550');
});

test('Movie Mode expires automatically after movieUntil passes', () => {
  const ctx = loadEngine({
    storage: {
      'flux.effect': '"movie"',
      'flux.movieUntil': String(Date.now() - 1000),
    },
  });
  const out = ctx.evaluateCurrentOutput(new Date());
  assert.notEqual(out.phase, 'Movie Mode');
  assert.equal(ctx._storage.get('flux.effect'), '"normal"');
  assert.equal(ctx._storage.get('flux.movieUntil'), '0');
});

test('a reloaded page starts its gamma seq above the previous page load, so the native side does not drop it as stale', async () => {
  const seqs = [];
  const invoke = async (cmd, args) => {
    if (args && 'seq' in args) seqs.push(args.seq);
    return { applied: true, stale: false, displaysTotal: 1, displaysUpdated: 1, strength: 1, multipliers: [1, 1, 1], requested: [1, 1, 1] };
  };
  const first = loadEngine({ window: { __TAURI_INTERNALS__: {} }, invoke });
  for (const k of [3000, 2900, 2800]) await first.pushGammaToHardware(k, 100, 'normal', false);
  await new Promise(r => setTimeout(r, 2));
  const reloaded = loadEngine({ window: { __TAURI_INTERNALS__: {} }, invoke });
  await reloaded.pushGammaToHardware(2700, 100, 'normal', false);
  assert.equal(seqs.length, 4);
  assert.ok(seqs[3] > seqs[2], `reloaded seq ${seqs[3]} must exceed ${seqs[2]}`);
});

test('fractional kelvin is rounded before it reaches the u32 native argument', async () => {
  const calls = [];
  const ctx = loadEngine({
    window: { __TAURI_INTERNALS__: {} },
    invoke: async (cmd, args) => {
      calls.push(args);
      return { applied: true, stale: false, displaysTotal: 1, displaysUpdated: 1, strength: 1, multipliers: [1, 1, 1], requested: [1, 1, 1] };
    },
  });
  await ctx.pushGammaToHardware(3400.6, 100, 'normal', false);
  assert.equal(calls[0].kelvin, 3401);
});

test('paused readout is neutral even with Darkroom selected', () => {
  const ctx = loadEngine({ storage: { 'flux.effect': '"darkroom"', 'flux.enabled': 'false' } });
  ctx.refreshOutput();
  assert.equal(ctx._elements.get('channel-rgb').textContent, 'R 1.000 · G 1.000 · B 1.000');
});
