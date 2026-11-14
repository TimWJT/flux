# Audit report: flux (night light)

> **Status 2026-11-15: second pass done (v1.1.1).** Fixed: gamma left warm when the updater or `relaunch` exits the process (`ExitGuard` in `main.rs`), every gamma write refused as stale after a webview reload (JS seq now clock-seeded), paused readout showing Darkroom multipliers, fractional Kelvin breaking the `u32` command argument, unused window/window-state page permissions removed, "On close" hint said 6500K instead of the original gamma. Added `.github/workflows/release.yml` (Windows only; builds without updater artifacts when `TAURI_SIGNING_PRIVATE_KEY` is missing).
>
> **Status 2026-11-13: historical.** This audit describes the code *before* the repairs. H1–H5, M1, M3 and M4 are fixed in the current `src-tauri/src/main.rs` and `src/main.js` (see the table in `../NOTES-grok-4.7.md`). Check any finding below against the current functions before acting on it.

- Auditor: Grok 4.7
- Date: Thursday 12 November 2026
- Time: 3:15 AM Australia/Sydney (UTC+11)
- Kind: read-only code audit. No application code was changed.
- Scope: Static review of `C:\Users\Tim\Documents\Coding\App Development\flux` source that ships the app: `src/` (`index.html`, `startup.js`, `main.js`, `app.css`), `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/build.rs`, `tests/color-schedule.test.mjs`, `tests/early-theme.test.mjs`, `package.json`, `build.mjs`, `serve.mjs`, `create-icon.mjs`, `README.md`, `LICENSE`, plus `.gitignore` / `.gitattributes`. `night-light/` was not opened and is not evidence. `dist/` and `dist-standalone/` exist and were not used as source of truth. Not present in this tree: `node_modules/`, `src-tauri/target/`, `src-tauri/gen/`, `src-tauri/icons/`, `src-tauri/Cargo.lock`, `package-lock.json`, `.git`. The file list did not change between the initial listing and the source reads.
- Method: static reading only. Commands: PowerShell directory listing (`Get-ChildItem`, `Test-Path`) and one local `node` snippet that re-evaluated the Kelvin and solar formulas copied from `src/main.js` and joined the `serve.mjs` path candidates. The updater pubkey was base64-decoded locally. Did not run `npm install`, `npm test`, `npm audit`, `cargo build`, `cargo test`, `cargo audit`, formatters, or git writes. Did not launch the app.

## Summary

Flux is a local Tauri 2 shell whose Windows build writes a 3×256 gamma LUT with `SetDeviceGammaRamp` and chooses the temperature from an offline solar schedule. The packaged page is locked to `script-src 'self'`, the asset protocol is off, and no application code sends latitude or the schedule anywhere. The serious problems are in the ramp and the clock: a normal window close restores a linear identity LUT only when that close event runs and the in-memory “keep” flag is false; a crash or a reset of that flag can leave the last LUT on the displays; nighttime and darkroom ramps are silently swapped for a milder curve when GDI rejects them; concurrent uploads are unordered; and the default “auto” location is about 55 minutes early under Sydney daylight saving.

## Finding counts

| Severity | Count |
| --- | --- |
| Critical | 0 |
| High | 5 |
| Medium | 7 |
| Low | 5 |
| Note | 2 |

No critical findings. Critical would mean an exploitable issue, or a gamma failure that happens on the ordinary quit path with default settings. Ordinary close with the keep flag still false does write the identity ramp.

## Findings

### [H1] Identity gamma is restored only from the window close handler

- Severity: High
- Category: Reliability
- Confidence: High
- Location: `src-tauri/src/main.rs:360`
- Evidence: `on_window_event` handles only `WindowEvent::CloseRequested`. It calls `api.prevent_close()`, loads `ExitPolicy.keep_on_exit`, and if that is false calls `win32_gamma::set_gamma_on_all_displays(&neutral_gamma_ramp(), None)` before `exit(0)` (`src-tauri/src/main.rs:360-372`). The process loop is `.run(|_app, _event| {})` (`src-tauri/src/main.rs:398`), so `Exit`, `Destroyed`, and every other event are ignored. `Cargo.toml` sets `panic = "abort"` (`src-tauri/Cargo.toml:33`). There is no panic hook, no `GetDeviceGammaRamp`, and no `Drop` impl that writes a ramp. `restore_display_gamma` (`src-tauri/src/main.rs:285-293`) runs only when the page invokes it. The close path also ignores the `usize` returned by `set_gamma_on_all_displays`; a failed restore still exits.
- Impact: Task Manager end-task, a crash, or a kill during shutdown never reaches `CloseRequested`. `SetDeviceGammaRamp` changes the display LUT, not a per-process overlay, and this process will not put the linear ramp back. A normal Alt+F4 / close with `keep_on_exit == false` does write the identity ramp (`i * 257`, `src-tauri/src/main.rs:81-94`). That identity ramp is also not the LUT that was installed before Flux started, so a clean exit replaces Night Light or an ICC ramp with linear 6500K, which matches the README “neutral 6500K” sentence (`README.md:35`) and still discards the previous calibration.
- Suggested direction: Restore on every process-exit path that still runs user code, snapshot the original ramps with `GetDeviceGammaRamp` if the product promise is “put back what was there”, and do not exit when the restore call returns 0 unless the user has asked to keep the LUT.
- Verify: Read `src-tauri/src/main.rs:346-398` and confirm the only `neutral_gamma_ramp()` call outside tests and `restore_display_gamma` is inside `CloseRequested`. Confirm `Cargo.toml` `[profile.release] panic`. Do not launch the app. A later runtime check, on a machine where changing gamma is acceptable, is to apply a warm ramp, kill the process from Task Manager, and see whether the LUT survives.

### [H2] Gamma uploads are unordered, and a failed or stale upload is not retried

- Severity: High
- Category: Correctness
- Confidence: High
- Location: `src/main.js:638`
- Evidence: `pushGammaToHardware` stores `lastAppliedKey` and returns before the `invoke` finishes (`src/main.js:643-645`). `refreshOutput` calls it without awaiting (`src/main.js:887`). Each call hits `apply_display_gamma` or `restore_display_gamma`, both `spawn_blocking` (`src-tauri/src/main.rs:256` and `:286`). Nothing serializes those tasks with each other or with the close handler’s direct `set_gamma_on_all_displays` (`src-tauri/src/main.rs:369`). Slider `input`, curve `pointermove`, the 65 ms preview timer, and the 30 s timer all call `refreshOutput`. On failure, the `catch` sets `hardwareActive = false` and leaves `lastAppliedKey` unchanged (`src/main.js:661-663`), so the 30 s tick hits the same key and returns at line 644.
- Impact: Dragging brightness or scrubbing the curve can have an older `SetDeviceGammaRamp` finish last. The UI then shows the newer value while the displays keep the older LUT, and the dedupe key blocks a correction until some other temperature, brightness, or effect is requested. Closing the window can restore identity and then lose that restore to an apply that was already on the blocking pool. This is the same missing lock, not a separate exit bug.
- Suggested direction: One in-flight generation counter, or a mutex around every LUT write including the close path; commit the dedupe key only after the matching generation succeeds; retry a failed key on the next tick.
- Verify: In `src/main.js:638-664`, confirm `lastAppliedKey = key` is before `await invoke`. In `src-tauri/src/main.rs:174-229` and `:360-372`, confirm there is no mutex. Trace a burst of `#slider-brightness` `input` events (`src/main.js:1110-1113`) into `refreshOutput`.

### [H3] A rejected LUT is replaced with a milder ramp and reported as the requested color

- Severity: High
- Category: Correctness
- Confidence: High for the substitution and the reported multipliers; Medium that the default 2300K bedtime actually fails GDI on a given driver
- Location: `src-tauri/src/main.rs:263`
- Evidence: After building the requested ramp, the command always builds `safe_ramp` with each channel raised to at least 0.52 and brightness raised to at least 55 (`src-tauri/src/main.rs:266-271`). `set_gamma_on_all_displays` retries with that fallback whenever `SetDeviceGammaRamp` returns 0 (`src-tauri/src/main.rs:196-204` and `:214-221`) and counts the fallback as a successful display. The returned `multipliers` are `r/g/b * dim` from the requested color, not from `safe_ramp` (`src-tauri/src/main.rs:273-278`). The page only reads `res.applied` (`src/main.js:657-659`) and prints multipliers from its own `buildGammaRamp` (`src/main.js:749-752`). The comment at `src-tauri/src/main.rs:263-265` says GDI rejects curves whose G or B fall below about 0.50 on some drivers. Re-evaluating `kelvin_to_rgb` (`src-tauri/src/main.rs:34-55`): 2300K is about G 0.593 and B 0.201; 3400K is about B 0.541; 1200K and darkroom (`1, 0, 0` at `src-tauri/src/main.rs:258`) are below 0.52 on G and B. Default bedtime is 2300K (`src/main.js:20`, `src/index.html:199`). Darkroom still paints the Flux window red via CSS (`src/app.css:99-113`) even when the hardware fallback is not red.
- Impact: On a driver that rejects the requested ramp, default bedtime, ember/candle presets, and Darkroom Mode install a LUT no bluer-starved than 0.52 per channel and no dimmer than 55% brightness, while the hero and the RGB bars keep showing the deep-warm or pure-red numbers. `applied: true` selects the “Hardware LUT” status string (`src/main.js:859-862`), so the “GDI Restricted” string is only for the case where both ramps fail. This audit did not call GDI, so the 0.50 threshold is the source comment, not a measurement on this PC.
- Suggested direction: Return which ramp was installed, show those multipliers, and treat a fallback as a partial apply. If darkroom cannot be represented in a GDI-legal LUT, say so in the UI.
- Verify: Recompute `kelvin_to_rgb(2300)` from `src-tauri/src/main.rs:41-52` and compare with 0.52. Read `set_gamma_on_all_displays` and confirm a fallback success increments `updated`. Confirm the page never reads `res.multipliers`. A hardware check is optional and would change the screen: watch whether a 2300K apply is followed by a second `SetDeviceGammaRamp`.

### [H4] Default solar longitude treats the daylight-saving offset as geography, and city presets use the PC timezone

- Severity: High
- Category: Correctness
- Confidence: High
- Location: `src/main.js:189`
- Evidence: `resolveCoordinates` sets `lon = tzHours * 15` and `lat = -34` only when the offset is between +9.5 and +11.5 hours, otherwise latitude 38 (`src/main.js:187-193`). `computeSolarTimes` then uses that longitude with `date.getTimezoneOffset()` (`src/main.js:234-237`) and clamps sunrise into 03:00–11:00 and sunset into 15:00–22:30 (`src/main.js:236-237`). Out-of-range hour angle becomes the fixed pair 06:30 / 18:30 (`src/main.js:229-231`). The same snippet, on this PC (`Australia/Sydney`, offset +660 minutes on 2026-11-12), reproduced the functions as written: auto lat -34 lon 165 gave sunrise 04:51 and sunset 18:38; the Sydney preset lat -33.87 lon 151.21 with the same +660 offset gave 05:46 and 19:33 (55 minutes later). July with a +600 offset differed by about 5 minutes. London’s preset (-0.13°) with a +660 offset clamped to 11:00 and 22:30; the same preset with offset 0 gave 06:03 and 18:13. The location control is a preset list (`src/index.html:319-328`); “Auto (from system timezone)” is the default (`src/main.js:25`).
- Impact: With the default location during Australian daylight saving, the schedule that drives the LUT is about 55 minutes early versus the Sydney coordinates the app already ships. Picking a city the PC is not in mixes that city’s longitude with the PC’s civil offset and then clamps the result into a mid-latitude window, so the displayed sunrise and sunset are not that city’s clock times. The comment at `src/main.js:187-192` shows the latitude constant is deliberate; the daylight-saving longitude error is what moves Sydney by most of an hour. Polar day and polar night cannot be represented once `cosHa` is outside [-1, 1] or the clamps apply.
- Suggested direction: For auto mode, use a standard-time meridian, or document the error. For a city preset, use that city’s offset (including its daylight-saving rule) instead of the PC offset, and do not clamp a computed sunrise into 03:00–11:00.
- Verify: Copy `resolveCoordinates` and `computeSolarTimes` into a local script. For 2026-11-12 and `tzOffsetMin = 660`, compare lon `11 * 15` against lon `151.21`. Confirm both paths call `getTimezoneOffset()` from the PC clock (`src/main.js:234`). The unit test only checks Sydney equinox sunrise is inside 180..660 and sunset inside 900..1350 (`tests/color-schedule.test.mjs:85-87`), which both the auto and the preset results satisfy.

### [H5] Reset turns the keep-on-exit checkbox off but leaves the native flag set

- Severity: High
- Category: Reliability
- Confidence: High
- Location: `src/main.js:1004`
- Evidence: The native flag starts false (`src-tauri/src/main.rs:349`) and is updated only by `set_keep_gamma_on_exit` (`src-tauri/src/main.rs:295-298`). The page calls that command at boot (`src/main.js:1380`) and from the checkbox `change` handler (`src/main.js:1252-1257`). `resetSettings` assigns `keepOnClose: DEFAULTS.keepOnClose` (false), writes localStorage, and refreshes the checkbox through `syncControlsFromState` (`src/main.js:1022`, `:1029-1038`, `:948-949`). It never calls `invoke('set_keep_gamma_on_exit')`. Setting `checked` in script does not fire `change`.
- Impact: Check “Keep warmth active after closing window”, then “Reset to defaults”, then close the window. The checkbox and `flux.keepOnClose` say false, but `ExitPolicy` is still true, so `CloseRequested` skips the identity write (`src-tauri/src/main.rs:367-370`). The warm LUT stays installed with no process left to clear it. The next launch loads false and will apply a ramp again; the gap is the time the app stays closed.
- Suggested direction: After any write to `state.keepOnClose`, including reset, send the new value to `set_keep_gamma_on_exit` and check that the command succeeded before showing the checkbox state.
- Verify: Search `src/main.js` for `set_keep_gamma_on_exit`. The only call sites should be the boot `await` and the `#cfg-restore-quit` handler. Confirm `resetSettings` is not one of them.

### [M1] Transition labels are 20s / 20m / 60m; the scheduler uses 10 / 30 / 60 minutes

- Severity: Medium
- Category: Correctness
- Confidence: High
- Location: `src/main.js:257`
- Evidence: `span` is 10, 60, or 30 minutes for `fast` / `slow` / `medium` (`src/main.js:257`). It is subtracted from sunrise, sunset, and bedtime in minutes (`src/main.js:272-279`). The settings buttons say `20s`, `20m`, and `60m` (`src/index.html:303-305`). `#cfg-transition-hint` is the fixed sentence “Gradual 20-minute crossfade…” (`src/index.html:308`) and `syncControlsFromState` never writes it (`src/main.js:960-965`). `currentMinutes` drops seconds (`src/main.js:337-338`). The schedule tick is 30 seconds (`src/main.js:1399-1402`) and does nothing while a preview is running.
- Impact: Choosing “20s” still crossfades for 10 minutes, and “20m” crossfades for 30. The LUT can change at most once a minute, and a pause can outlive its timestamp by up to 30 seconds. The hint keeps describing a 20-minute fade after the user picks another speed.
- Suggested direction: Make the label, the hint, and `span` the same unit, and drive a short fade from a timer if a 20-second transition is actually required.
- Verify: Read `src/main.js:257` next to `src/index.html:302-308`. Grep `cfg-transition-hint` and confirm it appears only in the HTML.

### [M2] Cancelling a pause from a slider, and manual warmth from the daytime slider, is not saved

- Severity: Medium
- Category: Correctness
- Confidence: High
- Location: `src/main.js:1088`
- Evidence: The day, sunset, and night slider handlers set `state.pauseUntil = 0` and save only the Kelvin key (`src/main.js:1088-1108`). They do not `saveValue('pauseUntil')` or `saveValue('pauseMode')`. The day slider copies `manualK` in memory when mode is manual (`src/main.js:1090`) and does not `saveValue('manualK')`. `stepKelvin` also clears `pauseUntil` / `pauseMode` in memory without saving them (`src/main.js:499-504`), though it does save the Kelvin slot. Boot reloads both fields (`src/main.js:107-108`). Pause itself is saved by `pauseForOneHour` and `pauseUntilSunrise` (`src/main.js:533-536`, `:548-551`).
- Impact: During “Pause for 1 hour” or “Disable until sunrise”, moving a temperature slider or using +/- looks immediate because `evaluateCurrentOutput` honors the in-memory `pauseUntil`. After restart, the stored future `pauseUntil` pauses the app again at 6500K. In manual mode, warmth chosen on the Daytime slider reverts to the last saved `manualK` after restart. The section intro says that slider controls fixed warmth (`src/index.html:153`).
- Suggested direction: Persist `pauseUntil`, `pauseMode`, and `manualK` on the same input handlers that change them.
- Verify: Compare the `saveValue` calls in `src/main.js:1088-1113` with `src/main.js:533-536`. Restart behavior follows from `loadSaved` at `src/main.js:107-108`; do not launch the app to see it.

### [M3] E-Ink Grayscale does not change the LUT, and Movie Mode does not last 2.5 hours

- Severity: Medium
- Category: Correctness
- Confidence: High
- Location: `src-tauri/src/main.rs:257`
- Evidence: Native effect matching is `"darkroom"`, `"movie"`, or anything else including `"grayscale"` (`src-tauri/src/main.rs:257-261`). JS `buildGammaRamp` special-cases only `darkroom` and `movie` (`src/main.js:159-161`). Grayscale is a `filter: grayscale(1)` on the Flux `body` (`src/app.css:116-117`). The movie card is labeled “Movie Mode (2.5h)” (`src/index.html:239-241`). Its click handler only toggles the effect (`src/main.js:1148-1152`). Nothing assigns `pauseMode` to `'movie'` or starts a 2.5 hour timer. `pauseMode`’s comment lists `'movie'` (`src/main.js:33`) and no other line sets it.
- Impact: On the desktop app, E-Ink grays the Flux window and leaves every other window on the normal temperature LUT. Movie Mode stays at 4200K until the user turns it off; it does not expire after 2.5 hours.
- Suggested direction: Either build a real mono LUT (subject to the GDI limits in H3) or label grayscale as a window preview. Remove the 2.5h claim or start a timer the way `pauseForOneHour` does.
- Verify: Grep `grayscale` in `src-tauri/src/main.rs` (only the `_` arm applies) and in `src/app.css`. Grep `2.5h` and `pauseMode = 'movie'` in `src/`.

### [M4] The settings panel promises an update check the code never makes; the README says there is no network

- Severity: Medium
- Category: Privacy
- Confidence: High
- Location: `src/main.js:5`
- Evidence: `check` from `@tauri-apps/plugin-updater` and `relaunch` from `@tauri-apps/plugin-process` are imported (`src/main.js:5-6`) and have no other references in `src/`. `#cfg-check`, `#update-go`, and `#update-later` exist (`src/index.html:363-374`) and have no listeners. The startup checkbox defaults to checked (`src/index.html:357`, `src/main.js:30`) and the hint says “Checked automatically when the app starts” (`src/index.html:364`). Boot never calls the updater (`src/main.js:1364-1403`). The Rust plugin is registered (`src-tauri/src/main.rs:374-377`) with endpoint `https://github.com/TimWJT/flux/releases/latest/download/latest.json` and a minisign pubkey (`src-tauri/tauri.conf.json:32-41`). Decoding that pubkey locally yields the text `untrusted comment: minisign public key: B0A0FB8681361524` and a public key line; no private key is in this tree. README line 5 says “No network requests, ever.” There is no `fetch`, `XMLHttpRequest`, `WebSocket`, `geolocation`, or opener import under `src/`.
- Impact: As the code stands, launching the app does not contact GitHub, so the README’s “no network” sentence matches the call graph, and the settings copy does not. Location is not attached to an update request because no update request is built. The capability and the pubkey are ready for a later check; `updater:default` is already granted (`src-tauri/capabilities/default.json:19`). This audit did not capture packets.
- Suggested direction: Either call `check` from the button and from startup when the checkbox is on, and correct the README, or remove the updater UI, the plugin, and the capability until that exists.
- Verify: Grep `checkUpdate` and `relaunch` in `src/main.js` and confirm they occur only on the import lines. Grep `fetch(` and `geolocation` under `src/`. Read `README.md:5` against `src/index.html:355-364`.

### [M5] Tests cover theme parsing and three schedule plateaus, not the ramp risks

- Severity: Medium
- Category: Testing
- Confidence: High
- Location: `tests/color-schedule.test.mjs:83`
- Evidence: `tests/color-schedule.test.mjs` loads `src/main.js` in `vm` after stripping imports and the `boot` IIFE. It checks 6500K white, monotonic warmth, a 256-entry darkroom LUT in JS, and three plateau calls: minute 720 → 6500K Daytime, 1260 → 3400K Sunset, 120 → 2300K Bedtime, using a fake solar pair sunrise 360 / sunset 1140. The solar assertion is only `sunrise` in 180..660 and `sunset` in 900..1350 (`tests/color-schedule.test.mjs:86-87`). `tests/early-theme.test.mjs` checks `flux.theme` parsing, the double-apply guard, and that a mocked `build.mjs` keeps startup ahead of CSS and that `script-src` has no `unsafe-inline`. Rust `gamma_tests` (`src-tauri/src/main.rs:300-344`) mirror the Kelvin monotonicity check and the identity endpoints; `npm test` does not run them. Nothing in either JS file covers GDI fallback, `lastAppliedKey`, `set_keep_gamma_on_exit`, pause persistence, transition span versus labels, daylight-saving longitude, or grayscale.
- Impact: The bugs in H2, H3, H4, H5, M1, and M2 can land without a failing test. The solar bounds also pass for the 55-minute auto error in H4.
- Suggested direction: Add fixtures for the DST longitude delta, the 10/30/60 spans, pause `saveValue`, and a single-flight gamma mock. Keep the Rust LUT tests in CI once a toolchain is available.
- Verify: Read both test files. `node_modules/` is absent, so this audit did not run `npm test`. The tests import only `node:` modules, so they may run without `npm install`; that was not tried.

### [M6] Scrubbing the curve rebuilds the UI and can upload a new LUT on every pointer move

- Severity: Medium
- Category: Performance
- Confidence: High for the call path; Medium for how visible the driver cost is
- Location: `src/main.js:1178`
- Evidence: `pointermove` calls `scrubAt` → `refreshOutput` with no debounce (`src/main.js:1178-1179`, `:1165-1171`). `refreshOutput` rebuilds a 97-point SVG (`src/main.js:700-712`, step 15 minutes), writes several `innerHTML`s, builds a 256-entry JS LUT, and calls `pushGammaToHardware`. The hardware call is skipped only when the key string is unchanged (`src/main.js:643-644`). The key includes Kelvin, so each simulated minute whose temperature differs uploads a full ramp per active display, and possibly the fallback ramp too (`src-tauri/src/main.rs:196-200`). The 24h preview fires `refreshOutput` every 65 ms (`src/main.js:983-991`); plateaus dedupe, transition minutes do not. The 30 s clock tick (`src/main.js:1400`) is not the costly path. Native applies run on `spawn_blocking`, so the GDI call is off the Tauri async runtime; the close handler is the one that calls GDI on the event thread (`src-tauri/src/main.rs:369`).
- Impact: A drag across sunset or bedtime is a burst of LUT uploads and DOM rebuilds on the webview thread. Some GPU drivers glitch or stall when gamma is rewritten many times a second. The preview is also a real display change, not only a drawing in the window, until pointer-up calls `refreshOutput` again (`src/main.js:1181-1186`), subject to the race in H2.
- Suggested direction: Debounce hardware applies to one in-flight upload, and rebuild the curve on a frame callback. Keep the 30 s schedule tick.
- Verify: Follow `#curve-container` `pointermove` in `src/main.js:1173-1188` to `pushGammaToHardware`. Count the loop `for (let m = 0; m <= 1440; m += 15)` at `src/main.js:700`.

### [M7] The desktop build is missing its icons and its lockfiles, and can resolve packages from a sibling app

- Severity: Medium
- Category: Build
- Confidence: High
- Location: `src-tauri/tauri.conf.json:46`
- Evidence: `bundle.icon` lists five files under `icons/` (`src-tauri/tauri.conf.json:46-52`). `src-tauri/icons/` does not exist (`assets/icon.svg` does). `beforeDevCommand` and `beforeBuildCommand` are both `npm run build` (`src-tauri/tauri.conf.json:8-9`). There is no `devUrl`. README says `npm run app:dev` runs with hot reload (`README.md:22`). `build.mjs` adds `../markdown-viewer/node_modules` to esbuild’s `nodePaths` (`build.mjs:14`). `flux/node_modules` is absent, and that sibling directory and its `node_modules` are present (existence check only; the sibling was not audited). There is no `package-lock.json` and no `Cargo.lock`. `package.json` uses `^` ranges; `Cargo.toml` uses `tauri = "2"` and the other crates at major-only versions (`src-tauri/Cargo.toml:9-27`). `create-icon.mjs` runs `npx tauri icon` with `shell: true` and fixed arguments (`create-icon.mjs:3-6`).
- Impact: `tauri build` cannot bundle the configured icons until `icons` generates them. `tauri dev` rebuilds `dist/` once; it does not hot-reload. A build on this machine resolves `@tauri-apps/api` from the sibling `markdown-viewer` tree if Flux has no `node_modules`. Without lockfiles, a later install can move every `^` / `2` dependency. `shell: true` is unnecessary for this fixed command and is the only shell spawn in the repo.
- Suggested direction: Generate icons, commit lockfiles, drop the sibling `nodePaths` entry, and point `beforeDevCommand` at a watcher only if hot reload is still a goal. Call `npx` with `shell: false`.
- Verify: `Test-Path` on `src-tauri/icons`, `package-lock.json`, `Cargo.lock`, and `node_modules`. Read `build.mjs:14` and `tauri.conf.json:6-10`. Do not run the build.

### [L1] The main window may close, destroy, open URLs, restart, and install updates; the page uses none of those plugins

- Severity: Low
- Category: Security
- Confidence: Medium
- Location: `src-tauri/capabilities/default.json:8`
- Evidence: The only capability grants `core:default`, window set-title / set-focus / unminimize / close / destroy, `opener:allow-open-url`, `opener:allow-default-urls`, `window-state:default`, `updater:default`, and `process:allow-restart` (`src-tauri/capabilities/default.json:8-21`). `src/main.js` invokes `list_displays`, `apply_display_gamma`, `restore_display_gamma`, `set_keep_gamma_on_exit`, and `getVersion`. It does not import the opener plugin. `src-tauri/gen/` is absent, so the expanded contents of `core:default` and `updater:default` were not read. CSP is `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; script-src 'self'; form-action 'none'` (`src-tauri/tauri.conf.json:13`). `assetProtocol.enable` is false (`src-tauri/tauri.conf.json:14-16`). There is no `remote` URL list on the capability. No page code assigns `location` or embeds a remote frame. Custom commands are registered for the webview (`src-tauri/src/main.rs:390-395`); that is how the UI sets gamma. `unsafe` in `main.rs` is only the Win32 FFI blocks at lines 154, 186, 193, and 211. The single-instance callback ignores `_argv` and `_cwd` (`src-tauri/src/main.rs:351`).
- Impact: With the current page, a remote site is not loaded into the webview and therefore is not on a path to `apply_display_gamma`. The extra permissions matter if script runs in the `main` window: `allow-destroy` can tear the window down without `CloseRequested`, which skips the restore in H1, and `updater:default` / `process:allow-restart` are the update/relaunch commands the UI never calls. `unsafe-inline` is limited to styles. This is hardening, not a demonstrated exploit. Confidence is medium because the generated ACL files are not in the tree.
- Suggested direction: Drop opener, destroy, updater, and process permissions until the UI calls them. Keep `script-src 'self'` and the disabled asset protocol.
- Verify: Diff `src-tauri/capabilities/default.json` against the `invoke(` names in `src/main.js`. Confirm `src-tauri/gen` is missing before expecting a schema file.

### [L2] One successful display counts as success for the whole machine

- Severity: Low
- Category: Reliability
- Confidence: High
- Location: `src-tauri/src/main.rs:174`
- Evidence: Active adapters are enumerated with `EnumDisplayDevicesW` for indices 0..15 (`src-tauri/src/main.rs:177-191`). Each gets `CreateDCW` + `SetDeviceGammaRamp`. A later adapter that fails does not roll back earlier ones. The `GetDC(NULL)` fallback runs only when `updated == 0` (`src-tauri/src/main.rs:210-226`). `applied` is `updated > 0` (`src-tauri/src/main.rs:275`). Child monitors of an adapter are not enumerated. The original per-device ramp is never read.
- Impact: On a two-adapter machine, one screen can change and the other can stay on the old LUT while the UI says the hardware apply worked. Displays past index 15 are skipped. Identity-on-exit has the same partial-failure behavior.
- Suggested direction: Record per-display success, and only report `applied` when every active DC accepted the ramp.
- Verify: Read the loop at `src-tauri/src/main.rs:177-228` and the `applied: updated > 0` return.

### [L3] The dev static server listens on every interface and can read the repo tree

- Severity: Low
- Category: Build
- Confidence: High
- Location: `serve.mjs:37`
- Evidence: `createServer(...).listen(PORT)` is called with a port and no host (`serve.mjs:18-37`). Node’s `server.listen(port)` default is the unspecified address. The handler tries `dist/<path>` and then `<repo>/<path>` (`serve.mjs:24-27`). The guard is `file.startsWith(here)` (`serve.mjs:27`). A local reconstruction of the same `new URL` + `decodeURIComponent` + `path.join` steps for `/../secret.txt`, encoded `..`, a long `../` chain, `/C:/Windows/win.ini`, and a `%5C` UNC-like path all stayed under the Flux directory after WHATWG URL parsing. Unknown extensions are sent as `application/octet-stream` (`serve.mjs:31`). A bad `%` sequence can reject `decodeURIComponent` (`serve.mjs:19`) with no handler around it. This server is the `npm start` UI loop (`README.md:13-14`); it is not the packaged webview and it cannot call `SetDeviceGammaRamp`.
- Impact: Anyone who can reach port 4175 (or `PORT`) on this machine can read project files the join allows, including `src/main.js`, while the dev server is running. The payloads above did not escape the repo. This is a dev-server exposure, not a gamma bug.
- Suggested direction: Listen on `127.0.0.1` only, and serve `dist/` unless a path is under a dedicated assets directory. Catch decode errors.
- Verify: Read `serve.mjs:18-37`. Repeat the URL/join reconstruction. Do not start the server unless you intend to open the port.

### [L4] The settings dialog is marked modal, and the curve has no keyboard path

- Severity: Low
- Category: Accessibility
- Confidence: High
- Location: `src/index.html:291`
- Evidence: `#settings` is `role="dialog"` and `aria-modal="true"` (`src/index.html:291`). It is `display: none` until `.on` (`src/app.css:648-659`), which is the right way to hide it. `toggleSettings` only toggles the class and `aria-pressed` (`src/main.js:1042-1048`); it does not move focus or trap Tab. Escape closes it (`src/main.js:1292-1294`). The 24-hour curve is pointer-only (`src/main.js:1173-1188`); the SVG has `aria-label` (`src/index.html:110`) and no key handler. `<main id="scroller">` and `<article role="main">` are both main landmarks (`src/index.html:78-80`). `:focus-visible` outlines exist for buttons and sliders (`src/app.css:150-162`), `#scroller` suppresses its outline (`src/app.css:163`), and `prefers-reduced-motion: reduce` zeroes transitions (`src/app.css:750-758`).
- Impact: Keyboard users can use the toolbar shortcuts and sliders. Opening Settings does not put them inside the dialog, and Tab can leave it while `aria-modal` says they cannot. The curve cannot be scrubbed from the keyboard. Screen readers get two main landmarks.
- Suggested direction: On open, focus the dialog and keep Tab inside it while it is open. Give the curve a slider semantics or leave it as a graphic. Use one main landmark.
- Verify: Read the citations above. This audit did not run a screen reader.

### [L5] Kelvin and LUT math are implemented twice, and they already disagree on grayscale

- Severity: Low
- Category: Maintainability
- Confidence: High
- Location: `src/main.js:127`
- Evidence: `kelvinToRgb` / `buildGammaRamp` in `src/main.js:127-174` and `kelvin_to_rgb` / `build_gamma_ramp` in `src-tauri/src/main.rs:34-78` are two copies of the Tanner Helland curve. The JS copy quantizes channel multipliers with `toFixed(4)` (`src/main.js:147-151`); Rust does not. Hardware uses only the Rust copy. Grayscale is handled in CSS (M3) and in neither LUT builder. `npm test` never loads the Rust copy (M5).
- Impact: A change to bedtime math, movie temperature, or darkroom in one file will not move the other. The bars can disagree with the LUT by the 4-decimal rounding, and grayscale already has.
- Suggested direction: Make the native command the only LUT builder, and have the tests compare a few shared fixtures if both copies must remain.
- Verify: Diff the constants `99.4708025861`, `161.1195681661`, `138.5177312231`, and `305.0447927307` in both files. Confirm the page’s `invoke('apply_display_gamma')` does not send the JS LUT (`src/main.js:652-656`).

### [N1] Location and schedule stay in webview localStorage

- Severity: Note
- Category: Privacy
- Confidence: High
- Location: `src/main.js:9`
- Evidence: Every persisted field goes through `localStorage` key `flux.` + name (`src/main.js:9`, `:65-79`), including `location` (`lat,lon` or `auto`), Kelvin schedule, wake time, pause timestamp, and `keepOnClose`. The native side stores only the keep flag in an `AtomicBool` for the process lifetime (`src-tauri/src/main.rs:13-15`). There is no geolocation call and no filesystem write of settings in this repo. Window bounds may be written by `tauri_plugin_window_state` (`src-tauri/src/main.rs:358`); that crate is not vendored here, so its file layout was not read. The exact WebView2 profile directory was not opened.
- Impact: A city preset or timezone-derived coordinate is recoverable from the webview profile on this PC. Nothing in the Flux source uploads it. See M4 for the network claim.
- Suggested direction: None required for the privacy claim. If the updater is wired later, keep coordinates out of the request.
- Verify: Grep `localStorage` and `geolocation` under `src/`. List `invoke` argument objects and confirm `location` is not one of them.

### [N2] Dependency inventory from the manifests only

- Severity: Note
- Category: Dependencies
- Confidence: High
- Location: `package.json:23`
- Evidence: `package.json` dependencies: `@tauri-apps/api` ^2.11.1, `@tauri-apps/plugin-opener` ^2.5.4, `@tauri-apps/plugin-process` ^2.3.1, `@tauri-apps/plugin-updater` ^2.11.0. Dev: `@tauri-apps/cli` ^2.11.4, `esbuild` ^0.28.2. `Cargo.toml` direct dependencies: `tauri` 2, `percent-encoding` 2, `serde` 1, `serde_json` 1, `tauri-plugin-single-instance` 2, `tauri-plugin-opener` 2, `tauri-plugin-window-state` 2, `tauri-plugin-process` 2, `tauri-plugin-updater` 2 on desktop targets, and on Windows `webview2-com` 0.38 and `windows` 0.61 with feature `Win32_Foundation` only. `src-tauri/src/main.rs` does not reference `percent_encoding`, `webview2_com`, or the `windows` crate; GDI is raw `extern "system"`. No lockfile is present (M7). `npm audit` and `cargo audit` were not run, and the crates are not vendored, so no CVE list is claimed.
- Impact: Unused direct crates add fetch and compile surface once someone builds. Version ranges can move without a lockfile change. Neither fact is a vulnerability by itself.
- Suggested direction: Drop unused direct dependencies and commit lockfiles. Run audits separately when a network install is intended.
- Verify: Compare `Cargo.toml` `[dependencies]` with `rg` for those crate names in `src-tauri/src/main.rs`.

## What looks solid

- Packaged CSP keeps scripts on `'self'` and does not put `unsafe-inline` on `script-src` (`src-tauri/tauri.conf.json:13`). `build.mjs` emits external `startup.js` / `app.css` / `app.js` for that reason (`build.mjs:62-77`). The asset protocol is disabled.
- The page does not load remote HTML, and the single-instance hook does not pass argv into a shell (`src-tauri/src/main.rs:351-356`).
- LUT values are clamped: multipliers are forced into 0..1, brightness into 20..100, and the identity ramp is `i * 257`, which is 0 at index 0 and 65535 at index 255 (`src-tauri/src/main.rs:59-94`). Rust tests lock those endpoints (`src-tauri/src/main.rs:323-334`). That does not stop GDI from rejecting a legally encoded but extreme curve (H3).
- A normal close with the keep flag still at its default false writes that identity ramp before `exit(0)` (H1). Boot pushes the saved keep flag before the first `refreshOutput` (`src/main.js:1374-1397`).
- `startup.js` fails closed to `auto` on bad JSON and refuses a second run (`src/startup.js:4-17`). `early-theme.test.mjs` exercises that matrix.
- `build.mjs` refuses to delete a directory that is not exactly `dist` or `dist-standalone` (`build.mjs:17-20`).
- Focus-visible outlines and a reduced-motion block are present (`src/app.css:150-162`, `:750-758`).
- Schedule plateaus for the hard-coded solar pair in the test match the branch order in `computeScheduleKelvin` (`tests/color-schedule.test.mjs:97-107`).

## Not verified

- The app was not launched. No gamma ramp was written or restored, and GDI’s real rejection threshold was not measured.
- `npm test`, `cargo test`, `npm audit`, and `cargo audit` were not run. `node_modules/` and `src-tauri/target/` are missing.
- Plugin and `windows` crate sources are not in the repo. Signature enforcement is inferred from `plugins.updater.pubkey` being set in `tauri.conf.json`, not from reading `tauri-plugin-updater`.
- `src-tauri/gen/` is missing, so generated capability schemas were not read (L1).
- `dist/` and `dist-standalone/` were not treated as source. `night-light/` was not read.
- Whether Windows clears a LUT when a process is killed was not tested.
- The second-instance plugin’s exit path was not read, so it is unknown whether a duplicate launch can touch gamma before it exits.
- Packet capture was not done. The “no request” conclusion is from the call graph in M4.

## Files reviewed

- `README.md`
- `LICENSE`
- `package.json`
- `build.mjs`
- `serve.mjs`
- `create-icon.mjs`
- `.gitignore`
- `.gitattributes`
- `src/index.html`
- `src/startup.js`
- `src/main.js`
- `src/app.css`
- `src-tauri/src/main.rs`
- `src-tauri/Cargo.toml`
- `src-tauri/build.rs`
- `src-tauri/tauri.conf.json`
- `src-tauri/capabilities/default.json`
- `tests/color-schedule.test.mjs`
- `tests/early-theme.test.mjs`
- `assets/icon.svg` (exists only; not a code review)

Existence-only: `dist/`, `dist-standalone/`, and the sibling path `../markdown-viewer/node_modules` named by `build.mjs`. Not present: `node_modules/`, `src-tauri/target/`, `src-tauri/gen/`, `src-tauri/icons/`, `src-tauri/Cargo.lock`, `package-lock.json`, `.git`.
