// Flux — native circadian display gamma controller.
//
// Applies Planckian blackbody color temperature and brightness to the display
// hardware lookup table (LUT) via Win32 GDI `SetDeviceGammaRamp`.
//
// Design notes:
// - On startup each display's current ramp is snapshotted (`GetDeviceGammaRamp`)
//   and used as the baseline. Warmth is applied *on top of* that baseline, so an
//   ICC calibration survives, and the baseline is what gets put back on exit.
//   A snapshot that is far from linear (e.g. a warm ramp left behind by a crash)
//   is not trusted; the linear identity ramp is used instead.
// - Every LUT write goes through one mutex and carries a sequence number from
//   the UI, so a slow, older request can never land after a newer one, and
//   nothing can be written after shutdown has restored the baseline.
// - Windows rejects ramps that stray too far from linear unless the
//   `GdiIcmGammaRange` registry value is raised. When a ramp is rejected we
//   binary-search for the strongest blend between baseline and target that the
//   driver accepts, and report that strength to the UI instead of pretending
//   the full color was applied.
// - The baseline is restored on window close, on `RunEvent::Exit`, from a
//   panic hook, and when the updater or `relaunch` exits the process directly
//   (both call `cleanup_before_exit`, which drops `ExitGuard`). A hard kill
//   (Task Manager) cannot be intercepted; the next
//   launch detects the leftover ramp and does not adopt it as the baseline.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Manager, RunEvent, State};

pub const LUT_LEN: usize = 256;

/// A snapshot whose entries all lie within this distance of linear is
/// treated as a genuine calibration curve and adopted as the baseline.
const BASELINE_TOLERANCE: u16 = 6554; // ~10% of full scale

/// Binary-search iterations when the driver rejects the requested ramp.
const LIMIT_SEARCH_STEPS: u32 = 7;

/// How often the installed ramps are checked against what Windows reports.
const REASSERT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

/// A read-back ramp within this distance of what we wrote counts as unchanged
/// (drivers may round entries).
const REASSERT_TOLERANCE: u16 = 512;

// ---------------------------------------------------------------------------
// Color math
// ---------------------------------------------------------------------------

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GammaRamp {
    pub red: [u16; LUT_LEN],
    pub green: [u16; LUT_LEN],
    pub blue: [u16; LUT_LEN],
}

impl GammaRamp {
    pub fn zeroed() -> Self {
        GammaRamp {
            red: [0; LUT_LEN],
            green: [0; LUT_LEN],
            blue: [0; LUT_LEN],
        }
    }

    /// The linear identity ramp (`i * 257`): 0 at index 0, 65535 at 255.
    pub fn identity() -> Self {
        let mut ramp = Self::zeroed();
        for i in 0..LUT_LEN {
            let v = (i as u16) * 257;
            ramp.red[i] = v;
            ramp.green[i] = v;
            ramp.blue[i] = v;
        }
        ramp
    }

    /// Scales each channel of `base` by a multiplier in `[0, 1]`.
    pub fn scaled(base: &GammaRamp, r: f64, g: f64, b: f64) -> Self {
        let scale = |v: u16, m: f64| ((v as f64) * m.clamp(0.0, 1.0)).round() as u16;
        let mut ramp = Self::zeroed();
        for i in 0..LUT_LEN {
            ramp.red[i] = scale(base.red[i], r);
            ramp.green[i] = scale(base.green[i], g);
            ramp.blue[i] = scale(base.blue[i], b);
        }
        ramp
    }

    /// Linear interpolation: `t = 0` is `from`, `t = 1` is `to`.
    pub fn blend(from: &GammaRamp, to: &GammaRamp, t: f64) -> Self {
        let t = t.clamp(0.0, 1.0);
        let mix = |a: u16, b: u16| ((a as f64) + ((b as f64) - (a as f64)) * t).round() as u16;
        let mut ramp = Self::zeroed();
        for i in 0..LUT_LEN {
            ramp.red[i] = mix(from.red[i], to.red[i]);
            ramp.green[i] = mix(from.green[i], to.green[i]);
            ramp.blue[i] = mix(from.blue[i], to.blue[i]);
        }
        ramp
    }

    /// Largest absolute distance of any entry from the identity ramp.
    pub fn max_deviation_from_identity(&self) -> u16 {
        let mut worst = 0u16;
        for i in 0..LUT_LEN {
            let id = (i as u16) * 257;
            for v in [self.red[i], self.green[i], self.blue[i]] {
                worst = worst.max(v.abs_diff(id));
            }
        }
        worst
    }

    /// A ramp is a plausible baseline if it is close to linear and
    /// non-decreasing on every channel.
    pub fn is_plausible_baseline(&self) -> bool {
        let monotonic = |c: &[u16; LUT_LEN]| c.windows(2).all(|w| w[1] >= w[0]);
        self.max_deviation_from_identity() <= BASELINE_TOLERANCE
            && monotonic(&self.red)
            && monotonic(&self.green)
            && monotonic(&self.blue)
    }
}

/// Converts a color temperature in Kelvin (1000..=10000) to normalized RGB
/// multipliers in `[0.0, 1.0]`, anchored so 6500K is exact `(1.0, 1.0, 1.0)`.
/// (Tanner Helland's fit to the Planckian locus, renormalized at 6500K.)
pub fn kelvin_to_rgb(kelvin: u32) -> (f64, f64, f64) {
    let k = kelvin.clamp(1000, 10000) as f64;
    if k >= 6500.0 {
        return (1.0, 1.0, 1.0);
    }
    let t = k / 100.0;

    let raw_g = 99.4708025861 * t.ln() - 161.1195681661;
    let max_g = 99.4708025861 * 65.0_f64.ln() - 161.1195681661;
    let g = (raw_g / max_g).clamp(0.0, 1.0);

    let b = if t <= 19.0 {
        0.0
    } else {
        let raw_b = 138.5177312231 * (t - 10.0).ln() - 305.0447927307;
        let max_b = 138.5177312231 * 55.0_f64.ln() - 305.0447927307;
        (raw_b / max_b).clamp(0.0, 1.0)
    };

    (1.0, g, b)
}

/// White-point channel multipliers (before brightness) for a request.
pub fn effect_multipliers(kelvin: u32, effect: &str) -> (f64, f64, f64) {
    match effect {
        "darkroom" => (1.0, 0.0, 0.0),
        "movie" => kelvin_to_rgb(4200),
        _ => kelvin_to_rgb(kelvin),
    }
}

/// Builds a linear 256-entry ramp for `(r, g, b)` multipliers and a brightness
/// percentage (`20..=100`).
pub fn build_gamma_ramp(r: f64, g: f64, b: f64, brightness_pct: f64) -> GammaRamp {
    let dim = brightness_pct.clamp(20.0, 100.0) / 100.0;
    GammaRamp::scaled(&GammaRamp::identity(), r * dim, g * dim, b * dim)
}

// ---------------------------------------------------------------------------
// Display backends
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DisplayId {
    /// A `\\.\DISPLAYn` device name (NUL-terminated UTF-16).
    Device([u16; 32]),
    /// The whole-screen DC, used when enumeration finds nothing.
    Screen,
}

#[derive(Clone, Debug)]
pub struct DisplayInfo {
    pub id: DisplayId,
    pub label: String,
}

pub trait DisplayBackend: Send + Sync + 'static {
    fn displays(&self) -> Vec<DisplayInfo>;
    fn get_ramp(&self, id: &DisplayId) -> Option<GammaRamp>;
    fn set_ramp(&self, id: &DisplayId, ramp: &GammaRamp) -> bool;
}

#[cfg(target_os = "windows")]
mod win32 {
    use super::{DisplayBackend, DisplayId, DisplayInfo, GammaRamp};
    use std::ffi::c_void;
    use std::ptr;

    #[repr(C)]
    struct DisplayDeviceW {
        cb: u32,
        device_name: [u16; 32],
        device_string: [u16; 128],
        state_flags: u32,
        device_id: [u16; 128],
        device_key: [u16; 128],
    }

    const DISPLAY_DEVICE_ACTIVE: u32 = 0x0000_0001;
    const DISPLAY_DEVICE_MIRRORING_DRIVER: u32 = 0x0000_0008;

    #[link(name = "gdi32")]
    extern "system" {
        fn CreateDCW(
            driver: *const u16,
            device: *const u16,
            port: *const u16,
            devmode: *const c_void,
        ) -> *mut c_void;
        fn DeleteDC(hdc: *mut c_void) -> i32;
        fn SetDeviceGammaRamp(hdc: *mut c_void, ramp: *const c_void) -> i32;
        fn GetDeviceGammaRamp(hdc: *mut c_void, ramp: *mut c_void) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetDC(hwnd: *mut c_void) -> *mut c_void;
        fn ReleaseDC(hwnd: *mut c_void, hdc: *mut c_void) -> i32;
        fn EnumDisplayDevicesW(
            device: *const u16,
            index: u32,
            out: *mut DisplayDeviceW,
            flags: u32,
        ) -> i32;
    }

    fn utf16_z_to_string(buf: &[u16]) -> String {
        let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        String::from_utf16_lossy(&buf[..end])
    }

    /// Runs `f` with a device context for `id`, releasing it afterwards.
    fn with_dc<T>(id: &DisplayId, f: impl FnOnce(*mut c_void) -> T) -> Option<T> {
        // SAFETY: the DC is created and released here and never escapes `f`.
        unsafe {
            match id {
                DisplayId::Device(name) => {
                    let hdc = CreateDCW(ptr::null(), name.as_ptr(), ptr::null(), ptr::null());
                    if hdc.is_null() {
                        return None;
                    }
                    let out = f(hdc);
                    DeleteDC(hdc);
                    Some(out)
                }
                DisplayId::Screen => {
                    let hdc = GetDC(ptr::null_mut());
                    if hdc.is_null() {
                        return None;
                    }
                    let out = f(hdc);
                    ReleaseDC(ptr::null_mut(), hdc);
                    Some(out)
                }
            }
        }
    }

    pub struct Win32Backend;

    impl DisplayBackend for Win32Backend {
        fn displays(&self) -> Vec<DisplayInfo> {
            let mut out = Vec::new();
            for index in 0..64 {
                let mut dev = DisplayDeviceW {
                    cb: std::mem::size_of::<DisplayDeviceW>() as u32,
                    device_name: [0; 32],
                    device_string: [0; 128],
                    state_flags: 0,
                    device_id: [0; 128],
                    device_key: [0; 128],
                };
                // SAFETY: `dev` is a correctly sized, writable DISPLAY_DEVICEW.
                if unsafe { EnumDisplayDevicesW(ptr::null(), index, &mut dev, 0) } == 0 {
                    break;
                }
                let flags = dev.state_flags;
                if flags & DISPLAY_DEVICE_ACTIVE == 0 || flags & DISPLAY_DEVICE_MIRRORING_DRIVER != 0 {
                    continue;
                }
                let port = utf16_z_to_string(&dev.device_name).replace(r"\\.\", "");
                let adapter = utf16_z_to_string(&dev.device_string);
                let label = if adapter.is_empty() { port } else { format!("{port} ({adapter})") };
                out.push(DisplayInfo { id: DisplayId::Device(dev.device_name), label });
            }
            if out.is_empty() {
                out.push(DisplayInfo { id: DisplayId::Screen, label: "Primary display".into() });
            }
            out
        }

        fn get_ramp(&self, id: &DisplayId) -> Option<GammaRamp> {
            with_dc(id, |hdc| {
                let mut ramp = GammaRamp::zeroed();
                // SAFETY: `ramp` is a #[repr(C)] 3x256 u16 array, the layout GDI expects.
                let ok = unsafe { GetDeviceGammaRamp(hdc, &mut ramp as *mut GammaRamp as *mut c_void) };
                (ok != 0).then_some(ramp)
            })
            .flatten()
        }

        fn set_ramp(&self, id: &DisplayId, ramp: &GammaRamp) -> bool {
            with_dc(id, |hdc| {
                // SAFETY: as above; GDI only reads the buffer.
                unsafe { SetDeviceGammaRamp(hdc, ramp as *const GammaRamp as *const c_void) != 0 }
            })
            .unwrap_or(false)
        }
    }
}

/// Backend for platforms without a GDI gamma API: nothing is ever written.
#[allow(dead_code)]
pub struct NullBackend;

impl DisplayBackend for NullBackend {
    fn displays(&self) -> Vec<DisplayInfo> {
        Vec::new()
    }
    fn get_ramp(&self, _id: &DisplayId) -> Option<GammaRamp> {
        None
    }
    fn set_ramp(&self, _id: &DisplayId, _ramp: &GammaRamp) -> bool {
        false
    }
}

#[cfg(target_os = "windows")]
type PlatformBackend = win32::Win32Backend;
#[cfg(target_os = "windows")]
fn platform_backend() -> PlatformBackend {
    win32::Win32Backend
}

#[cfg(not(target_os = "windows"))]
type PlatformBackend = NullBackend;
#[cfg(not(target_os = "windows"))]
fn platform_backend() -> PlatformBackend {
    NullBackend
}

/// Writes `target`, or failing that the strongest blend from `base` toward
/// `target` that the driver accepts. Returns the strength actually installed
/// (`1.0` = exactly `target`), or `None` if nothing at all was accepted.
///
/// Accepted strengths only ever increase during the search, so the screen
/// moves monotonically toward the target rather than flickering.
pub fn write_with_limit<B: DisplayBackend>(
    backend: &B,
    id: &DisplayId,
    base: &GammaRamp,
    target: &GammaRamp,
) -> Option<f64> {
    if backend.set_ramp(id, target) {
        return Some(1.0);
    }
    let (mut lo, mut hi) = (0.0_f64, 1.0_f64);
    let mut installed = None;
    for _ in 0..LIMIT_SEARCH_STEPS {
        let mid = (lo + hi) / 2.0;
        if backend.set_ramp(id, &GammaRamp::blend(base, target, mid)) {
            lo = mid;
            installed = Some(mid);
        } else {
            hi = mid;
        }
    }
    if installed.is_none() && backend.set_ramp(id, base) {
        installed = Some(0.0);
    }
    installed
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GammaApplyResult {
    /// At least one display shows (some of) the requested color.
    pub applied: bool,
    /// The request was superseded by a newer one and was not written.
    pub stale: bool,
    pub displays_total: usize,
    pub displays_updated: usize,
    /// Lowest installed strength across displays (1.0 = full request).
    pub strength: f64,
    /// White-point multipliers actually installed (including brightness).
    pub multipliers: [f64; 3],
    /// White-point multipliers that were requested (including brightness).
    pub requested: [f64; 3],
}

struct Inner {
    last_seq: u64,
    closing: bool,
    /// Per-display ramp to apply warmth over and to restore on exit.
    baselines: Vec<(DisplayId, GammaRamp)>,
    /// True while a non-baseline ramp may be installed.
    dirty: bool,
    /// The last requested multipliers (brightness included), while warmth is on.
    active_request: Option<[f64; 3]>,
    /// The ramp each display last accepted, used to detect Windows resetting it.
    installed: Vec<(DisplayId, GammaRamp)>,
}

impl Inner {
    fn set_installed(&mut self, id: &DisplayId, ramp: GammaRamp) {
        match self.installed.iter_mut().find(|(d, _)| d == id) {
            Some(slot) => slot.1 = ramp,
            None => self.installed.push((id.clone(), ramp)),
        }
    }
}

pub struct GammaController<B: DisplayBackend> {
    backend: B,
    inner: Mutex<Inner>,
    keep_on_exit: AtomicBool,
}

impl<B: DisplayBackend> GammaController<B> {
    pub fn new(backend: B) -> Self {
        let ctl = GammaController {
            backend,
            inner: Mutex::new(Inner {
                last_seq: 0,
                closing: false,
                baselines: Vec::new(),
                dirty: false,
                active_request: None,
                installed: Vec::new(),
            }),
            keep_on_exit: AtomicBool::new(false),
        };
        {
            let mut inner = ctl.lock();
            for d in ctl.backend.displays() {
                ctl.baseline_for(&mut inner, &d.id);
            }
        }
        ctl
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A poisoned lock only means a previous writer panicked mid-write;
        // the data (a list of baselines) is still valid.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Returns the baseline for `id`, snapshotting it on first sight.
    fn baseline_for(&self, inner: &mut Inner, id: &DisplayId) -> GammaRamp {
        if let Some((_, ramp)) = inner.baselines.iter().find(|(d, _)| d == id) {
            return *ramp;
        }
        let ramp = self
            .backend
            .get_ramp(id)
            .filter(GammaRamp::is_plausible_baseline)
            .unwrap_or_else(GammaRamp::identity);
        inner.baselines.push((id.clone(), ramp));
        ramp
    }

    pub fn display_labels(&self) -> Vec<String> {
        self.backend.displays().into_iter().map(|d| d.label).collect()
    }

    pub fn set_keep_on_exit(&self, keep: bool) {
        self.keep_on_exit.store(keep, Ordering::SeqCst);
    }

    /// Claims `seq` for a write. Returns false if it is stale or we are closing.
    fn claim(inner: &mut Inner, seq: u64) -> bool {
        if inner.closing || seq < inner.last_seq {
            return false;
        }
        inner.last_seq = seq;
        true
    }

    fn stale_result(requested: [f64; 3]) -> GammaApplyResult {
        GammaApplyResult {
            applied: false,
            stale: true,
            displays_total: 0,
            displays_updated: 0,
            strength: 0.0,
            multipliers: [1.0, 1.0, 1.0],
            requested,
        }
    }

    /// Applies white-point multipliers `(r, g, b)` at `brightness_pct`.
    pub fn apply(&self, seq: u64, rgb: (f64, f64, f64), brightness_pct: f64) -> GammaApplyResult {
        let dim = brightness_pct.clamp(20.0, 100.0) / 100.0;
        let req = [
            (rgb.0 * dim).clamp(0.0, 1.0),
            (rgb.1 * dim).clamp(0.0, 1.0),
            (rgb.2 * dim).clamp(0.0, 1.0),
        ];

        let mut inner = self.lock();
        if !Self::claim(&mut inner, seq) {
            return Self::stale_result(req);
        }

        let displays = self.backend.displays();
        inner.active_request = Some(req);
        let mut updated = 0usize;
        let mut applied_strength: Option<f64> = None;
        let mut any_failed = false;
        for d in &displays {
            match self.write_display(&mut inner, &d.id, req) {
                Some(s) if s > 0.0 => {
                    updated += 1;
                    applied_strength = Some(applied_strength.map_or(s, |prev| prev.min(s)));
                }
                _ => any_failed = true,
            }
        }
        let mult_strength = applied_strength.unwrap_or(0.0);
        let strength = if updated == 0 || any_failed { 0.0 } else { mult_strength };

        let eff = |m: f64| if mult_strength >= 1.0 { m } else { 1.0 + (m - 1.0) * mult_strength };
        GammaApplyResult {
            applied: updated > 0,
            stale: false,
            displays_total: displays.len(),
            displays_updated: updated,
            strength,
            multipliers: [eff(req[0]), eff(req[1]), eff(req[2])],
            requested: req,
        }
    }

    /// Writes `req` over one display's baseline, records what the driver
    /// accepted, and returns the installed strength.
    fn write_display(&self, inner: &mut Inner, id: &DisplayId, req: [f64; 3]) -> Option<f64> {
        let base = self.baseline_for(inner, id);
        let target = GammaRamp::scaled(&base, req[0], req[1], req[2]);
        let strength = write_with_limit(&self.backend, id, &base, &target)?;
        inner.dirty = true;
        let installed = if strength >= 1.0 { target } else { GammaRamp::blend(&base, &target, strength) };
        inner.set_installed(id, installed);
        Some(strength)
    }

    /// Re-writes any display whose ramp no longer matches what we installed
    /// (Windows resets gamma after sleep, lock, display-mode changes and
    /// driver restarts), and warms displays connected since the last apply.
    /// Only ramps the driver already accepted are re-written, so this never
    /// re-runs the visible limit search for a known display. Returns how many
    /// displays were written.
    pub fn reassert(&self) -> usize {
        let mut inner = self.lock();
        let Some(req) = inner.active_request else { return 0 };
        if inner.closing {
            return 0;
        }
        let mut written = 0;
        for d in self.backend.displays() {
            let known = inner.installed.iter().find(|(id, _)| *id == d.id).map(|(_, r)| *r);
            match known {
                Some(expected) => {
                    let drifted = match self.backend.get_ramp(&d.id) {
                        Some(now) => (0..LUT_LEN).any(|i| {
                            now.red[i].abs_diff(expected.red[i]) > REASSERT_TOLERANCE
                                || now.green[i].abs_diff(expected.green[i]) > REASSERT_TOLERANCE
                                || now.blue[i].abs_diff(expected.blue[i]) > REASSERT_TOLERANCE
                        }),
                        None => false,
                    };
                    if drifted && self.backend.set_ramp(&d.id, &expected) {
                        written += 1;
                    }
                }
                None => {
                    if self.write_display(&mut inner, &d.id, req).is_some() {
                        written += 1;
                    }
                }
            }
        }
        written
    }

    /// Puts every display back on its baseline ramp.
    pub fn restore(&self, seq: u64) -> GammaApplyResult {
        let mut inner = self.lock();
        if !Self::claim(&mut inner, seq) {
            return Self::stale_result([1.0, 1.0, 1.0]);
        }
        let (total, updated) = self.restore_locked(&mut inner);
        GammaApplyResult {
            applied: updated > 0,
            stale: false,
            displays_total: total,
            displays_updated: updated,
            strength: 1.0,
            multipliers: [1.0, 1.0, 1.0],
            requested: [1.0, 1.0, 1.0],
        }
    }

    fn restore_locked(&self, inner: &mut Inner) -> (usize, usize) {
        let displays = self.backend.displays();
        let mut updated = 0;
        for d in &displays {
            let base = self.baseline_for(inner, &d.id);
            if self.backend.set_ramp(&d.id, &base) {
                updated += 1;
            }
        }
        inner.dirty = false;
        inner.active_request = None;
        inner.installed.clear();
        (displays.len(), updated)
    }

    /// Final cleanup: refuses all later writes and, unless the user asked to
    /// keep the warmth, restores the baselines. Safe to call repeatedly.
    pub fn shutdown(&self) {
        let mut inner = self.lock();
        inner.closing = true;
        if inner.dirty && !self.keep_on_exit.load(Ordering::SeqCst) {
            self.restore_locked(&mut inner);
        }
    }

    /// Best-effort restore from a panic hook. Never blocks: if the lock is
    /// held (possibly by the panicking thread) it writes baselines it can
    /// read without the lock, falling back to identity.
    pub fn emergency_restore(&self) {
        if self.keep_on_exit.load(Ordering::SeqCst) {
            return;
        }
        match self.inner.try_lock() {
            Ok(mut inner) => {
                inner.closing = true;
                if inner.dirty {
                    self.restore_locked(&mut inner);
                }
            }
            Err(std::sync::TryLockError::Poisoned(p)) => {
                let mut inner = p.into_inner();
                inner.closing = true;
                self.restore_locked(&mut inner);
            }
            Err(std::sync::TryLockError::WouldBlock) => {
                let identity = GammaRamp::identity();
                for d in self.backend.displays() {
                    self.backend.set_ramp(&d.id, &identity);
                }
            }
        }
    }
}

type Controller = GammaController<PlatformBackend>;
static CONTROLLER: OnceLock<Arc<Controller>> = OnceLock::new();

/// Lives in the app's resource table. The updater (before it runs the
/// installer and calls `std::process::exit`) and `relaunch` both call
/// `AppHandle::cleanup_before_exit`, which clears that table without emitting
/// `RunEvent::Exit`; dropping this guard is the only hook on those paths.
struct ExitGuard(Arc<Controller>);

impl tauri::Resource for ExitGuard {}

impl Drop for ExitGuard {
    fn drop(&mut self) {
        self.0.shutdown();
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn list_displays(ctl: State<'_, Arc<Controller>>) -> Result<Vec<String>, String> {
    let ctl = ctl.inner().clone();
    tauri::async_runtime::spawn_blocking(move || ctl.display_labels())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn apply_display_gamma(
    kelvin: u32,
    brightness: f64,
    effect: String,
    seq: u64,
    ctl: State<'_, Arc<Controller>>,
) -> Result<GammaApplyResult, String> {
    let ctl = ctl.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ctl.apply(seq, effect_multipliers(kelvin, &effect), brightness)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn restore_display_gamma(
    seq: u64,
    ctl: State<'_, Arc<Controller>>,
) -> Result<GammaApplyResult, String> {
    let ctl = ctl.inner().clone();
    tauri::async_runtime::spawn_blocking(move || ctl.restore(seq))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_keep_gamma_on_exit(keep: bool, ctl: State<'_, Arc<Controller>>) -> bool {
    ctl.set_keep_on_exit(keep);
    keep
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(|window, event| {
            // Restore while the window is still on screen, so the user never
            // sees the desktop flash warm after Flux disappears.
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(ctl) = window.try_state::<Arc<Controller>>() {
                    ctl.shutdown();
                }
            }
        })
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            // Created here (not in `manage` before the plugins) so a second
            // instance, which exits inside the single-instance plugin, never
            // snapshots or touches the displays.
            let ctl = Arc::new(Controller::new(platform_backend()));
            let _ = CONTROLLER.set(ctl.clone());
            {
                let ctl = ctl.clone();
                std::thread::Builder::new()
                    .name("gamma-reassert".into())
                    .spawn(move || loop {
                        std::thread::sleep(REASSERT_INTERVAL);
                        ctl.reassert();
                    })?;
            }
            app.resources_table().add(ExitGuard(ctl.clone()));
            app.manage(ctl);

            let previous = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                if let Some(ctl) = CONTROLLER.get() {
                    ctl.emergency_restore();
                }
                previous(info);
            }));

            let config = app
                .config()
                .app
                .windows
                .iter()
                .find(|w| w.label == "main")
                .ok_or("tauri.conf.json has no main window")?
                .clone();
            tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_displays,
            apply_display_gamma,
            restore_display_gamma,
            set_keep_gamma_on_exit
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Flux");

    app.run(|_app, event| {
        if let RunEvent::Exit = event {
            if let Some(ctl) = CONTROLLER.get() {
                ctl.shutdown();
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// A fake display that rejects ramps straying more than `limit` from
    /// linear, mimicking GDI's range check, and records what is installed.
    struct MockBackend {
        limit: u16,
        initial: GammaRamp,
        installed: StdMutex<Option<GammaRamp>>,
        writes: StdMutex<usize>,
    }

    impl MockBackend {
        fn new(limit: u16, initial: GammaRamp) -> Self {
            MockBackend {
                limit,
                initial,
                installed: StdMutex::new(None),
                writes: StdMutex::new(0),
            }
        }
        fn current(&self) -> GammaRamp {
            self.installed.lock().unwrap().unwrap_or(self.initial)
        }
    }

    impl DisplayBackend for MockBackend {
        fn displays(&self) -> Vec<DisplayInfo> {
            vec![DisplayInfo { id: DisplayId::Screen, label: "Mock".into() }]
        }
        fn get_ramp(&self, _id: &DisplayId) -> Option<GammaRamp> {
            Some(self.current())
        }
        fn set_ramp(&self, _id: &DisplayId, ramp: &GammaRamp) -> bool {
            if ramp.max_deviation_from_identity() > self.limit {
                return false;
            }
            *self.installed.lock().unwrap() = Some(*ramp);
            *self.writes.lock().unwrap() += 1;
            true
        }
    }

    #[test]
    fn daylight_6500k_is_exact_unit_white() {
        assert_eq!(kelvin_to_rgb(6500), (1.0, 1.0, 1.0));
    }

    #[test]
    fn warmer_temperatures_monotonically_reduce_green_and_blue() {
        let (_, g_day, b_day) = kelvin_to_rgb(6500);
        let (_, g_sun, b_sun) = kelvin_to_rgb(3400);
        let (_, g_night, b_night) = kelvin_to_rgb(2300);
        let (_, g_ember, b_ember) = kelvin_to_rgb(1800);
        assert!(g_day > g_sun && g_sun > g_night && g_night > g_ember);
        assert!(b_day > b_sun && b_sun > b_night);
        assert_eq!(b_ember, 0.0);
    }

    #[test]
    fn identity_ramp_spans_full_range() {
        let ramp = GammaRamp::identity();
        assert_eq!(ramp.red[0], 0);
        assert_eq!(ramp.blue[255], 65535);
        assert_eq!(ramp.max_deviation_from_identity(), 0);
        assert!(ramp.is_plausible_baseline());
    }

    #[test]
    fn build_gamma_ramp_scales_channels_and_brightness() {
        let ramp = build_gamma_ramp(1.0, 0.5, 0.25, 50.0);
        assert_eq!(ramp.red[0], 0);
        assert_eq!(ramp.red[255], 32768);
        assert_eq!(ramp.green[255], 16384);
        assert_eq!(ramp.blue[255], 8192);
    }

    #[test]
    fn warm_leftover_ramp_is_not_trusted_as_baseline() {
        let (r, g, b) = kelvin_to_rgb(3400);
        assert!(!build_gamma_ramp(r, g, b, 100.0).is_plausible_baseline());
        // A gentle calibration tweak is kept.
        assert!(build_gamma_ramp(1.0, 0.97, 0.95, 100.0).is_plausible_baseline());
    }

    #[test]
    fn controller_applies_full_ramp_when_driver_allows_it() {
        let ctl = GammaController::new(MockBackend::new(u16::MAX, GammaRamp::identity()));
        let res = ctl.apply(1, kelvin_to_rgb(2300), 100.0);
        assert!(res.applied && !res.stale);
        assert_eq!(res.strength, 1.0);
        assert_eq!(res.multipliers, res.requested);
    }

    #[test]
    fn rejected_ramp_is_limited_and_reported_honestly() {
        let backend = MockBackend::new(20000, GammaRamp::identity());
        let ctl = GammaController::new(backend);
        let res = ctl.apply(1, (1.0, 0.0, 0.0), 100.0);
        assert!(res.applied);
        assert!(res.strength > 0.0 && res.strength < 1.0, "strength {}", res.strength);
        // Reported multipliers are what was installed, not what was asked for.
        assert!(res.multipliers[1] > 0.6, "green {}", res.multipliers[1]);
        assert_eq!(res.requested[1], 0.0);
        assert!(ctl.backend.current().max_deviation_from_identity() <= 20000);
    }

    #[test]
    fn stale_sequence_numbers_are_dropped() {
        let ctl = GammaController::new(MockBackend::new(u16::MAX, GammaRamp::identity()));
        assert!(!ctl.apply(5, kelvin_to_rgb(3000), 100.0).stale);
        let installed = ctl.backend.current();
        let late = ctl.apply(4, kelvin_to_rgb(6500), 100.0);
        assert!(late.stale);
        assert_eq!(ctl.backend.current(), installed);
    }

    #[test]
    fn shutdown_restores_original_calibration_and_blocks_later_writes() {
        let calibrated = build_gamma_ramp(1.0, 0.98, 0.96, 100.0);
        let ctl = GammaController::new(MockBackend::new(u16::MAX, calibrated));
        ctl.apply(1, kelvin_to_rgb(2300), 100.0);
        assert_ne!(ctl.backend.current(), calibrated);
        ctl.shutdown();
        assert_eq!(ctl.backend.current(), calibrated);
        assert!(ctl.apply(2, kelvin_to_rgb(2300), 100.0).stale);
        assert_eq!(ctl.backend.current(), calibrated);
    }

    #[test]
    fn shutdown_keeps_warmth_when_asked() {
        let ctl = GammaController::new(MockBackend::new(u16::MAX, GammaRamp::identity()));
        ctl.set_keep_on_exit(true);
        ctl.apply(1, kelvin_to_rgb(2300), 100.0);
        let warm = ctl.backend.current();
        ctl.shutdown();
        assert_eq!(ctl.backend.current(), warm);
    }

    #[test]
    fn warmth_is_applied_over_the_calibration_curve() {
        let calibrated = build_gamma_ramp(1.0, 0.98, 0.96, 100.0);
        let ctl = GammaController::new(MockBackend::new(u16::MAX, calibrated));
        ctl.apply(1, (1.0, 0.5, 0.5), 100.0);
        let now = ctl.backend.current();
        assert_eq!(now.green[255], (calibrated.green[255] as f64 * 0.5).round() as u16);
    }

    #[test]
    fn reassert_rewrites_a_ramp_windows_reset_and_stops_after_restore() {
        let ctl = GammaController::new(MockBackend::new(u16::MAX, GammaRamp::identity()));
        assert_eq!(ctl.reassert(), 0, "nothing to reassert before any apply");
        ctl.apply(1, kelvin_to_rgb(2300), 100.0);
        let warm = ctl.backend.current();
        assert_eq!(ctl.reassert(), 0, "unchanged ramp is left alone");

        // Simulate Windows resetting the LUT after sleep.
        *ctl.backend.installed.lock().unwrap() = Some(GammaRamp::identity());
        assert_eq!(ctl.reassert(), 1);
        assert_eq!(ctl.backend.current(), warm);

        ctl.restore(2);
        *ctl.backend.installed.lock().unwrap() = Some(warm);
        assert_eq!(ctl.reassert(), 0, "no reassert once warmth is off");
    }

    #[test]
    fn reassert_reuses_the_limited_ramp_without_searching_again() {
        let ctl = GammaController::new(MockBackend::new(20000, GammaRamp::identity()));
        ctl.apply(1, (1.0, 0.0, 0.0), 100.0);
        let limited = ctl.backend.current();
        let writes_before = *ctl.backend.writes.lock().unwrap();
        *ctl.backend.installed.lock().unwrap() = Some(GammaRamp::identity());
        assert_eq!(ctl.reassert(), 1);
        assert_eq!(ctl.backend.current(), limited);
        assert_eq!(*ctl.backend.writes.lock().unwrap(), writes_before + 1);
    }

    #[test]
    fn multi_display_partial_failure_reports_updated_multipliers_and_zero_min_strength() {
        struct TwoDisplayBackend {
            first: GammaRamp,
        }
        impl TwoDisplayBackend {
            fn dev(n: u16) -> DisplayId {
                let mut name = [0u16; 32];
                name[0] = n;
                DisplayId::Device(name)
            }
        }
        impl DisplayBackend for TwoDisplayBackend {
            fn displays(&self) -> Vec<DisplayInfo> {
                vec![
                    DisplayInfo { id: Self::dev(1), label: "D1".into() },
                    DisplayInfo { id: Self::dev(2), label: "D2".into() },
                ]
            }
            fn get_ramp(&self, id: &DisplayId) -> Option<GammaRamp> {
                if *id == Self::dev(1) { Some(self.first) } else { None }
            }
            fn set_ramp(&self, id: &DisplayId, _ramp: &GammaRamp) -> bool {
                *id == Self::dev(1)
            }
        }

        let ctl = GammaController::new(TwoDisplayBackend { first: GammaRamp::identity() });
        let res = ctl.apply(1, (1.0, 0.6, 0.4), 100.0);
        assert!(res.applied);
        assert_eq!(res.displays_total, 2);
        assert_eq!(res.displays_updated, 1);
        assert_eq!(res.strength, 0.0);
        assert_eq!(res.multipliers, [1.0, 0.6, 0.4]);
    }
}
