# Audit Report: `night-light` (v1.2.0)

- **Auditor:** Antigravity (Gemini 4 Hydrogen)
- **Date:** Monday 16 November 2026
- **Prior Audit Reference:** Replaces the historical `flux` (v1.1.1) `AUDIT-REPORT.md` from 12 Nov 2026 (with status banners from 13 & 15 Nov 2026). Every claim below was independently verified against the current `night-light` v1.2.0 codebase.
- **Scope:** `C:\Users\Tim\Documents\Coding\App Development\night-light`: `src/*` (`index.html`, `startup.js`, `main.js`, `app.css`), `src-tauri/*` (`src/main.rs`, `Cargo.toml`, `Cargo.lock`, `tauri.conf.json`, `capabilities/default.json`, `build.rs`, `icons/*`), `tests/*` (`color-schedule.test.mjs`, `early-theme.test.mjs`), `package.json`, `package-lock.json`, `build.mjs`, `serve.mjs`, `create-icon.mjs`, `.github/workflows/release.yml`, `README.md`, and `dist-standalone/Night Light.html`.
- **Method:** Static inspection of all files + offline Rust `cargo test` in an isolated scratch `--target-dir`. Zero application files were modified.

---

## Summary

`night-light` v1.2.0 is a Tauri 2 desktop blue-light filter for Windows that computes an offline NOAA solar schedule and applies 3×256 display gamma LUTs via `SetDeviceGammaRamp`. Almost all serious issues from the earlier `flux` audit have been cleanly repaired: the backend now snapshots and validates `GetDeviceGammaRamp` baselines, restores gamma across `CloseRequested`, `RunEvent::Exit`, `ExitGuard::drop`, and `panic::set_hook`, binary-searches driver LUT limits honestly, reasserts overridden LUTs every 5 seconds without redundant writes, trims capabilities, and locks down `serve.mjs` to `127.0.0.1` with path containment.

Three substantive functional bugs remain alongside CI supply-chain and minor multi-monitor/edge-case items:
1. **Queue drop race in `pushGammaToHardware`:** Checking `key === lastAppliedKey && !pendingGammaReq` without `!gammaInFlight` silently drops a revert back to `lastAppliedKey` while a different IPC call is still in flight.
2. **Broken bedtime schedule for `wakeTime >= 08:00`:** `computeScheduleKelvin` forces post-midnight bedtimes (`00:00`–`03:00`) back into the evening (`sunset + span + 60`) whenever `bedtime <= sunset + span`, breaking half the `#cfg-waketime` slider range (`08:00`–`11:00`).
3. **`stop24hPreview()` never resets `previewTimer = 0`:** Once the 24h preview runs once, keyboard curve scrubbing fails to exit on `blur`.

---

## Finding Counts

| Severity | Count |
|---|---:|
| Critical | 0 |
| High | 0 |
| Medium | 4 |
| Low | 5 |
| Note | 1 |

---

## Test & Check Results (Sandbox)

| Check | Outcome | Notes |
|---|---|---|
| `cargo test --offline --target-dir <scratch>` (in `src-tauri`) | **Passed: 14/14** (exit `0`) | Compiled `night-light v1.2.0` cleanly; all 14 `MockBackend` unit tests passed in `0.04s`. (Win32 `Win32Backend` FFI itself is not exercised by unit tests.) |
| `cargo test --offline` (default `src-tauri/target`) | Exit `1` | Blocked by read-only sandbox ACL on `.cargo-build-lock` (`os error 5`). |
| `npm test` / `node --test tests/*.test.mjs` | Not run (exit `1`) | `node`/`npm` outside workspace (`AppData\Local\hermes\node`) is denied by sandbox (`PermissionDenied`). |

---

## Verification of Prior `AUDIT-REPORT.md` (`flux` v1.1.1) Items

- **Fixed:** `H3` (honest 7-step `write_with_limit` + effective multiplier reporting), `H4` (standard-time `min(janOffset, julOffset)` & `CITY_TIMEZONES` + removed solar clamps), `H5` (reset calls `syncKeepOnClose(DEFAULTS.keepOnClose)`), `M1` (`10m/20m/60m` labels & dynamic hint), `M2` (pause cancel & manual Kelvin persistence), `M3` (grayscale labeled `(Window Preview)` + 2.5h Movie Mode timer), `M4` (updater wired + README updated), `M6` (`rAF` + single-flight coalescing), `M7` (icons, lockfiles, local `node_modules`), `L1` (minimal capabilities, `opener` removed), `L2` (partial display count reported), `L3` (`serve.mjs` `127.0.0.1` + containment), `L4` (dialog focus trap, curve keyboard slider, single `<main>`), `N2` (unused Cargo deps removed).
- **Substantially Fixed:** `H1` (baseline snapshot + `CloseRequested` + `RunEvent::Exit` + `ExitGuard` + `panic::set_hook`; only `WM_ENDSESSION` logoff & monitor hot-swap remain — see `[L4]`), `M5` (11 JS tests + 14 Rust `MockBackend` tests; Win32 FFI still untested automatically).
- **Partially Fixed:** `H2` (1 remaining `!gammaInFlight` race — see `[M1]`), `L5` (JS/Rust Kelvin & LUT math still duplicated without a shared parity test — see `[L5]`).

---

## Findings

### Medium

#### [M1] `pushGammaToHardware` drops a revert to `lastAppliedKey` when another IPC call is in flight
- **Category:** Correctness / Concurrency
- **Confidence:** High
- **Location:** `src/main.js:765-767, 809`
- **Evidence:** `drainGammaQueue()` sets `pendingGammaReq = null` (`line 766`) *before* `await invoke(...)`. Meanwhile `pushGammaToHardware()` returns early on `if (key === lastAppliedKey && !pendingGammaReq) return Promise.resolve();` (`line 809`) without checking `!gammaInFlight`.
- **Impact:** If the display is at `A` (`lastAppliedKey = A`), the user moves to `B` (now in flight in Rust, `gammaInFlight = true`, `pendingGammaReq = null`), and quickly reverts to `A` before `B` finishes, `A` is skipped. Once `B` resolves, `lastAppliedKey` becomes `B` and the monitors stay stuck on `B` until the next 30-second tick.
- **Remediation:** Change `line 809` to `if (key === lastAppliedKey && !pendingGammaReq && !gammaInFlight) return Promise.resolve();`.
- **Verify:** Mock a deferred `invoke`, call `A` -> start `B` -> call `A` before `B` resolves -> resolve `B` and assert `A` is queued and sent.

#### [M2] `computeScheduleKelvin` clobbers bedtime for all wake times `>= 08:00`
- **Category:** Correctness / Schedule Math
- **Confidence:** High
- **Location:** `src/main.js:301-356`, `src/index.html:312-315`
- **Evidence:** `#cfg-waketime` allows `4`..`11` (`04:00`–`11:00`). For any `wakeTime >= 8.0`, `bedtime = ((wakeMin - 480) + 1440) % 1440` wraps to `0`..`180` (`00:00`–`03:00`). Because `sunset + span` is typically `~1040`–`1280`, `if (bedtime <= sunset + span)` (`line 304`) is always true and overwrites `bedtime` to `Math.min(1410, sunset + span + 60)`. Linear comparisons at `322-355` also assume `0 <= srStart` and `sunset < btStart < 1440`.
- **Impact:** Wake times `08:00`–`11:00` silently schedule bedtime hours too early (e.g. `20:20`–`23:30`) instead of 8 hours before wake time.
- **Remediation:** Unwrap the daily timeline continuously relative to `sunrise` (allowing `bedtime` past `1440`) rather than clamping `bedtime <= sunset + span`.
- **Verify:** Evaluate `computeScheduleKelvin(1260, { sunrise: 390, sunset: 1140 }, { ...cfg, wakeTime: 9 })` and verify `bedtime` stays `01:00` rather than `20:20`.

#### [M3] `stop24hPreview()` fails to reset `previewTimer`, breaking keyboard curve `blur` exit
- **Category:** Correctness / UI State
- **Confidence:** High
- **Location:** `src/main.js:1149, 1160-1168, 1430-1436`
- **Evidence:** `stop24hPreview()` calls `clearInterval(previewTimer)` (`line 1162`) without setting `previewTimer = 0`. `#curve-container`'s `blur` listener (`line 1431`) checks `if (!scrubbing && state.previewing && !previewTimer)`.
- **Impact:** After running the 24h preview (`p`) once in a session, `previewTimer` remains a truthy number, so keyboard-scrubbing the curve (`ArrowLeft`/`ArrowRight`) and tabbing away (`blur`) leaves the app stuck in preview mode until `Esc` or another interaction.
- **Remediation:** Add `previewTimer = 0;` inside `stop24hPreview()`.

#### [M4] GitHub Actions in release workflow are pinned to mutable tags while holding signing secrets
- **Category:** Security / Supply Chain (CI/CD)
- **Confidence:** High
- **Location:** `.github/workflows/release.yml:20, 26, 28, 33, 35, 67, 72, 106, 107, 117`
- **Evidence:** `installers` runs with `permissions: contents: write` and `TAURI_SIGNING_PRIVATE_KEY`, referencing mutable `@v4`, `@stable`, `@v2`, `@v0` tags (`tauri-apps/tauri-action@v0`, `softprops/action-gh-release@v2`, etc.).
- **Remediation:** Pin every `uses:` step to its full 40-character commit SHA (keeping the tag as a comment) and restrict `contents: write` strictly to the release-publishing step/job.

---

### Low

- **[L1] 24h preview & paused Darkroom UI labels/hardware disagree when an effect is active** (`src/main.js:654, 822, 905, 945, 1036`): During `state.previewing`, `evaluateCurrentOutput()` skips Movie Mode (`654`) and returns solar Kelvin, while `refreshOutput()` still passes `state.effect` to `pushGammaToHardware` (`1036`), keeping hardware frozen at 4200K or Darkroom Red while the curve animates. Also `#hero-kelvin` calls `describeKelvin(out.kelvin, state.effect)` (`945`) instead of `effMode`, displaying `"6500K Darkroom Red Monochrome"` while paused.
- **[L2] Selecting a preset or Quick Temp does not clear Movie Mode or Darkroom** (`src/main.js:508-539` vs `1288, 1354`): Unlike `returnToSolar()` and `#mode-manual`, `selectPreset()` and `setQuickTemp()` omit `applyEffect('normal', false)`, leaving the monitor stuck in Movie/Darkroom while sliders/toasts update.
- **[L3] `write_with_limit` binary search steps downward to `0.5` on every clamped drag and caches `base` on `0.0` failure** (`src-tauri/src/main.rs:360-384, 552-560`): Jumping to `mid = 0.5` when a limit near e.g. `0.77` is hit can briefly flash the screen cooler; returning `Some(0.0)` (all blends failed, `base` restored) still sets `inner.dirty = true` and `inner.installed` to `base` in `write_display`. Remember the last accepted strength or avoid marking `dirty`/`installed` when `strength == 0.0`.
- **[L4] Monitor hot-swap on same `\\.\DISPLAYn` slot & OS logoff (`WM_ENDSESSION`)** (`src-tauri/src/main.rs:465-475, 575-597, 745-810`): `baselines` and `installed` key solely by `\\.\DISPLAYn` and aren't pruned on disconnect, so hot-swapping monitors on the same slot can reuse the old monitor's baseline/target. Also no `WM_ENDSESSION` handler runs if Windows terminates the process directly at user logoff without driving `RunEvent::Exit`.
- **[L5] Minor edge cases & maintenance** (`src-tauri/src/main.rs:509`, `src/main.js:129-172, 1199, 1589-1667`, `.github/workflows/release.yml:4`):
  - `GammaController::apply` `brightness_pct.clamp(20.0, 100.0)` passes `NaN` through if called directly from Rust (`NaN as u16 -> 0`); guard `is_finite()`.
  - While `#settings` (`aria-modal="true"`) is open and focus is on a button, single-key shortcuts (`p`, `h`, `e`, `o`, `t`, `w`, `f`) still fire on the underlying page.
  - Kelvin/LUT math remains duplicated between `src/main.js:129-172` and `src-tauri/src/main.rs:133-169` with no cross-check parity test.
  - `.github/workflows/release.yml:4` comment still cites `v1.1.1` while package version is `1.2.0`; `resetSettings()` calls `syncKeepOnClose` without `await` (currently safe because the Rust command is an infallible `AtomicBool::store`).

---

### Notes

- **[N1]** Location coordinates and schedule preferences are persisted locally in WebView2 `localStorage` (`nightlight.*`, `src/main.js:8`); no location data is transmitted externally.

---

## Strengths

- **Layered exit safety:** Restores baseline LUTs across `CloseRequested`, `RunEvent::Exit`, `ExitGuard::drop`, and `std::panic::set_hook`, with `is_plausible_baseline()` rejecting warm crash-leftover ramps.
- **Ordered concurrency & reassert efficiency:** `Mutex<Inner>` + monotonic `seq` (clock-seeded on JS startup/reload) prevents out-of-order gamma writes, and the 5s `reassert` thread only writes to GDI when Windows resets a display's LUT.
- **Hardened WebView & dev server:** Strict `script-src 'self'` CSP, `assetProtocol.enable: false`, minimal `capabilities/default.json` (`core:default`, `updater:default`, `process:allow-restart`), and `127.0.0.1`-only `serve.mjs` with `isInside` path checks.
- **Clean Rust unit tests:** All 14 `MockBackend` tests compile and pass offline cleanly with 0 warnings.
