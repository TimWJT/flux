# Flux

A circadian screen warmer and blue-light filter. It warms your display at sunset and bedtime using hardware gamma ramps (`SetDeviceGammaRamp`), calculates sunrise and sunset offline, and stays out of the way.

The UI is plain HTML, CSS and JS (solar calculator, Planckian locus solver, 24-hour interactive timeline). The build also produces `Flux.html`, a single self-contained file with everything inlined that runs in any browser as a window-only preview; only the Windows desktop app changes the display. Display calculation and scheduling run 100% offline with zero telemetry; your location and schedule never leave the machine. In the desktop app, an optional startup/manual update check queries GitHub Releases (and can be disabled in Settings).

## Run from source

```bash
npm install
npm start
```

Then open <http://127.0.0.1:4175>. That serves the web build — the fastest loop for working on the UI.

To build the desktop app:

```bash
npm run app:build
```

Installers land in `src-tauri/target/release/bundle/`. A local build needs `TAURI_SIGNING_PRIVATE_KEY` set (the updater signs its artifacts); without it, add `--config '{"bundle":{"createUpdaterArtifacts":false}}'`. Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed. `npm run app:dev` builds `dist/` and launches the Tauri desktop shell.

## What it does

| | |
|---|---|
| **Hardware Gamma LUT** | Writes a 3×256 16-bit lookup table directly to the display controller via Win32 `SetDeviceGammaRamp` (preserving any gentle pre-existing calibration baseline and clamping cleanly when drivers enforce GDI gamma range limits). True blacks stay `(0, 0, 0)` with zero GPU compositor overhead. |
| **3-Phase Solar Schedule** | Separate **Daytime** (`6500K`), **Sunset** (`3400K`), and **Bedtime** (`2300K`) temperatures that crossfade smoothly around local sunrise, sunset, and your wake time. |
| **100% Offline Sun Math** | Computes sunrise, solar noon, and sunset locally using NOAA solar position equations — no location tracking or weather API calls. |
| **Interactive 24h Curve** | Drag across the 24-hour solar graph to scrub any time of day, or press `p` to animate a full 24-hour cycle preview. |
| **Lighting Presets** | Sidebar (`o`) with one-click circadian profiles (Recommended, Reduce Eyestrain, Late Night Coding, Working Late, Warm Paper, Cave Painting, Ember Bedtime) and direct Kelvin steps. |
| **Color Effects** | **Movie Mode** (`4200K` shadow-preserving cinema warmth for 2.5h), **Darkroom Mode** (deep red monochrome LUT for night vision), and **E-Ink Grayscale** (window-only monochrome preview, since Win32 1D gamma LUTs are per-channel). |
| **Software Dimming** | Smoothly scales display brightness down to 20% alongside color temperature. |
| **Stays Applied** | Checks every 5 seconds that Windows hasn't reset the gamma table (sleep, lock screen, display changes) and puts the warmth back if it has. Monitors plugged in later are warmed too. |
| **Clean Exit** | Automatically restores your baseline display gamma when you quit (unless you turn on *Keep warmth active after closing window* in Settings). |

## Keyboard

| Key | Action |
|-----|--------|
| `Space` | Toggle Flux active / paused |
| `+` / `-` | Step cooler / warmer (`Ctrl` `+`/`-` works too) |
| `0` | Return to automatic solar schedule |
| `p` | Preview 24-hour solar cycle |
| `h` | Pause for 1 hour |
| `e` | Cycle color effect (Normal / Movie / Darkroom / Grayscale) |
| `o` | Toggle presets & modes sidebar |
| `t` | Cycle theme (Auto / Light / Dark) |
| `w` | Cycle layout width (Normal / Wide / Full) |
| `f` | Toggle sans / serif font |
| `,` | Open settings |
| `Esc` | Stop preview or close settings |

## Project layout

```
src/index.html       markup + toolbar, with __STARTUP__ / __CSS__ / __JS__ injection points
src/startup.js       early theme apply, runs before the stylesheet
src/app.css          design tokens (shared with Markdown Viewer), solar curve, slider cards
src/main.js          Planckian Kelvin-to-RGB solver, NOAA solar schedule, UI & IPC logic
build.mjs            bundles + inlines everything into dist/ and dist-standalone/Flux.html
serve.mjs            dev-only static server
tests/               node --test suite
dist/                index.html + startup.js + app.css + app.js (what Tauri bundles)
dist-standalone/     Flux.html — single-file standalone build
src-tauri/           the native shell
  src/main.rs        Win32 GDI SetDeviceGammaRamp / EnumDisplayDevicesW + exit restoration
  tauri.conf.json    window and bundle configuration
```

## License

Free for personal and other noncommercial use under the [PolyForm Noncommercial License 1.0.0](LICENSE).
