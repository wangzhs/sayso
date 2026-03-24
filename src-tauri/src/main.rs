// Prevents console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::{Arc, OnceLock, atomic::{AtomicU64, Ordering}, mpsc};
use std::time::Duration;
use tauri::{
    ActivationPolicy, AppHandle, Emitter, Manager, State, UserAttentionType,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WindowEvent,
};
#[cfg(target_os = "macos")]
use core_graphics::display::CGDisplay;
#[cfg(target_os = "macos")]
use core_graphics::window::{
    copy_window_info, kCGNullWindowID, kCGWindowBounds, kCGWindowLayer, kCGWindowListExcludeDesktopElements,
    kCGWindowListOptionOnScreenOnly, kCGWindowName, kCGWindowOwnerPID,
};
#[cfg(target_os = "macos")]
use core_foundation::{
    base::{CFType, TCFType},
    dictionary::CFDictionary,
    number::CFNumber,
    string::CFString,
};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use log::{info, warn};

mod audio;
mod config;
mod error;
mod executor;
mod fsm;
mod injector;
mod intent;
mod llm;
#[cfg(target_os = "macos")]
mod macos_hotkeys;
#[cfg(target_os = "macos")]
mod macos_hud;
mod polish;
mod safety;
mod stt;
mod stats;

use config::ConfigState;
use error::SaysoError;
use fsm::{FsmState, RecordingFsm};
use llm::LlmClient;
use stats::StatsState;
use stt::SttClient;

// ─── App state ───────────────────────────────────────────────────────────────

pub struct AppState {
    pub config: ConfigState,
    pub fsm: RecordingFsm,
    pub stats: StatsState,
    pub stt_client: SttClient,
    pub llm_client: LlmClient,
    /// Active recording handle (kept alive while recording)
    pub recording_handle: std::sync::Mutex<Option<audio::RecordingHandle>>,
    pub recorder: std::sync::Mutex<audio::AudioRecorder>,
    pub pending_hold: std::sync::Mutex<Option<PendingHold>>,
    pub hold_seq: AtomicU64,
    pub hud_seq: AtomicU64,
    #[cfg(target_os = "macos")]
    pub hotkeys: macos_hotkeys::MacHotkeyEngine,
}

#[derive(Debug, Clone, Copy)]
pub struct PendingHold {
    pub token: u64,
    pub mode: char,
    pub started: bool,
}

const SINGLE_KEY_HOLD_DELAY_MS: u64 = 120;

#[cfg(target_os = "macos")]
static MAC_APP_STATE: OnceLock<Arc<AppState>> = OnceLock::new();

#[cfg(target_os = "macos")]
#[derive(Debug, Clone)]
struct FrontmostWindowInfo {
    pid: i64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
fn validate_hotkeys(cfg: &config::AppConfig) -> Result<(), SaysoError> {
    macos_hotkeys::validate_config(cfg)
}

#[cfg(not(target_os = "macos"))]
fn validate_hotkeys(cfg: &config::AppConfig) -> Result<(), SaysoError> {
    parse_shortcuts(cfg).map(|_| ())
}

fn show_main_window(app: &AppHandle, page: &str) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(ActivationPolicy::Regular);

    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.center();
        #[cfg(target_os = "macos")]
        let _ = win.set_visible_on_all_workspaces(true);
        let _ = win.request_user_attention(Some(UserAttentionType::Critical));
        let _ = win.set_focus();
        let _ = win.emit("navigate", page);
    }
}

fn hide_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }

    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(ActivationPolicy::Accessory);
}

fn is_stt_ready(cfg: &config::AppConfig) -> bool {
    cfg.stt
        .as_ref()
        .map(|stt| !stt.endpoint.trim().is_empty() && !stt.model.trim().is_empty())
        .unwrap_or(false)
}

fn is_llm_ready(cfg: &config::AppConfig) -> bool {
    cfg.llm
        .as_ref()
        .map(|llm| !llm.endpoint.trim().is_empty() && !llm.model.trim().is_empty())
        .unwrap_or(false)
}

fn ui_is_zh(cfg: &config::AppConfig) -> bool {
    cfg.ui_language
        .trim()
        .to_ascii_lowercase()
        .starts_with("zh")
}

fn ui_text(cfg: &config::AppConfig, en: &'static str, zh: &'static str) -> String {
    if ui_is_zh(cfg) {
        zh.to_string()
    } else {
        en.to_string()
    }
}

fn stt_hint_prompt(voice: &config::VoiceConfig) -> Option<String> {
    if !voice.dialect_support_enabled {
        return None;
    }

    let profile = match voice.input_variant.trim() {
        "sichuanese" => "The speaker may use Sichuan dialect or Sichuan-accented Mandarin.",
        "shanghainese" => "The speaker may use Shanghainese or Shanghai-accented Mandarin.",
        "henanese" => "The speaker may use Henan dialect or Henan-accented Mandarin.",
        "guangshan" => "The speaker may use Guangshan speech from Xinyang, Henan, with strong local phrasing and accent.",
        "mandarin" => "The speaker is primarily using standard Mandarin.",
        _ => "The speaker may switch between Mandarin and Chinese regional dialects.",
    };

    Some(format!(
        "{} Transcribe in Simplified Chinese and favor accurate recognition of regional Chinese words.",
        profile
    ))
}

#[cfg(target_os = "macos")]
fn frontmost_app_pid() -> Option<i64> {
    use std::process::Command;

    let script = r#"
tell application "System Events"
    try
        set frontProcess to first application process whose frontmost is true
        return unix id of frontProcess
    on error
        return ""
    end try
end tell
"#;

    let output = Command::new("osascript").arg("-e").arg(script).output().ok()?;
    if !output.status.success() {
        return None;
    }

    String::from_utf8_lossy(&output.stdout).trim().parse::<i64>().ok()
}

#[cfg(target_os = "macos")]
fn frontmost_window_info() -> Option<FrontmostWindowInfo> {
    let frontmost_pid = frontmost_app_pid()?;
    let window_info = copy_window_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID,
    )?;

    let (key_pid, key_layer, key_bounds, key_name) = unsafe {
        (
            kCGWindowOwnerPID as *const _,
            kCGWindowLayer as *const _,
            kCGWindowBounds as *const _,
            kCGWindowName as *const _,
        )
    };

    let mut best_frame: Option<FrontmostWindowInfo> = None;
    let mut best_area = 0.0;

    for entry_ptr in window_info.get_all_values() {
        let entry = unsafe { CFType::wrap_under_get_rule(entry_ptr as _) };
        let dict = entry.downcast::<CFDictionary>()?;

        let owner_pid = dict
            .find(key_pid)
            .map(|value| unsafe { CFType::wrap_under_get_rule(*value as _) })
            .and_then(|value| value.downcast::<CFNumber>())
            .and_then(|value| value.to_i64());
        if owner_pid != Some(frontmost_pid) {
            continue;
        }

        let layer = dict
            .find(key_layer)
            .map(|value| unsafe { CFType::wrap_under_get_rule(*value as _) })
            .and_then(|value| value.downcast::<CFNumber>())
            .and_then(|value| value.to_i64())
            .unwrap_or(1);
        if layer != 0 {
            continue;
        }

        let bounds_dict = dict
            .find(key_bounds)
            .map(|value| unsafe { CFType::wrap_under_get_rule(*value as _) })
            .and_then(|value| value.downcast::<CFDictionary>())?;
        let rect = core_graphics::geometry::CGRect::from_dict_representation(&bounds_dict)?;
        if rect.is_empty() {
            continue;
        }

        let width = rect.size.width;
        let height = rect.size.height;
        let area = width * height;
        let name = dict
            .find(key_name)
            .map(|value| unsafe { CFType::wrap_under_get_rule(*value as _) })
            .and_then(|value| value.downcast::<CFString>())
            .map(|value| value.to_string())
            .unwrap_or_default();
        info!(
            "HUD(window-cg): candidate pid={} bounds=({}, {}, {}, {}) area={} name={:?}",
            frontmost_pid,
            rect.origin.x,
            rect.origin.y,
            width,
            height,
            area
            ,
            name
        );

        if width < 320.0 || height < 160.0 {
            continue;
        }

        if name.trim().is_empty() && width >= 0.95 * 1440.0 && height >= 0.95 * 900.0 {
            continue;
        }

        if area <= best_area {
            continue;
        }

        best_area = area;
        best_frame = Some(FrontmostWindowInfo {
            pid: frontmost_pid,
            x: rect.origin.x,
            y: rect.origin.y,
            width,
            height,
        });
    }

    if let Some(info) = best_frame {
        info!(
            "HUD(window-cg): pid={} bounds=({}, {}, {}, {})",
            info.pid,
            info.x,
            info.y,
            info.width,
            info.height
        );
        return Some(info);
    }

    None
}

#[cfg(not(target_os = "macos"))]
fn frontmost_window_info() -> Option<()> {
    None
}

#[cfg(target_os = "macos")]
fn frontmost_window_frame() -> Option<(f64, f64, f64, f64)> {
    frontmost_window_info().map(|info| (info.x, info.y, info.width, info.height))
}

#[cfg(not(target_os = "macos"))]
fn frontmost_window_frame() -> Option<(f64, f64, f64, f64)> {
    None
}

#[cfg(target_os = "macos")]
fn native_display_for_point(x: f64, y: f64) -> Option<(f64, f64, f64, f64)> {
    let display_ids = CGDisplay::active_displays().ok()?;

    for (index, display_id) in display_ids.into_iter().enumerate() {
        let display = CGDisplay::new(display_id);
        let bounds = display.bounds();
        let left = bounds.origin.x;
        let top = bounds.origin.y;
        let right = left + bounds.size.width;
        let bottom = top + bounds.size.height;
        info!(
            "HUD(native): display[{index}] bounds=({}, {}, {}, {})",
            left, top, bounds.size.width, bounds.size.height
        );
        if x >= left && x < right && y >= top && y < bottom {
            return Some((left, top, bounds.size.width, bounds.size.height));
        }
    }

    None
}

#[cfg(not(target_os = "macos"))]
fn native_display_for_point(_x: f64, _y: f64) -> Option<(f64, f64, f64, f64)> {
    None
}

fn hud_target_frame(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    let frontmost_frame = frontmost_window_frame();
    if let Some((window_x, window_y, window_width, window_height)) = frontmost_frame {
        info!(
            "HUD(window): frame=({}, {}, {}, {})",
            window_x,
            window_y,
            window_width,
            window_height
        );
        return frontmost_frame;
    }

    let fallback_cursor = app.cursor_position().ok().map(|cursor| (cursor.x, cursor.y));
    let anchor = fallback_cursor;
    let Some((anchor_x, anchor_y)) = anchor else {
        warn!("HUD: unable to resolve anchor point");
        return None;
    };

    let available_monitors = app.available_monitors().ok().unwrap_or_default();
    if available_monitors.is_empty() {
        warn!("HUD: no available monitors reported by runtime");
    } else {
        for (index, monitor) in available_monitors.iter().enumerate() {
            let position = monitor.position();
            let size = monitor.size();
            info!(
                "HUD: monitor[{index}] pos=({}, {}) size=({}, {}) scale={}",
                position.x,
                position.y,
                size.width,
                size.height,
                monitor.scale_factor()
            );
        }
    }

    if let Some((left, top, width, height)) = native_display_for_point(anchor_x, anchor_y) {
        info!(
            "HUD(native): chosen_display bounds=({}, {}, {}, {})",
            left,
            top,
            width,
            height
        );
        return Some((left, top, width, height));
    }

    let monitor = available_monitors
        .into_iter()
        .find(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            let left = position.x as f64;
            let top = position.y as f64;
            let right = left + size.width as f64;
            let bottom = top + size.height as f64;
            anchor_x >= left && anchor_x < right && anchor_y >= top && anchor_y < bottom
        })
        .or_else(|| app.monitor_from_point(anchor_x, anchor_y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        warn!("HUD: no monitor matched anchor=({}, {})", anchor_x, anchor_y);
        return None;
    };

    let monitor_pos = monitor.position();
    let monitor_size = monitor.size();
    info!(
        "HUD: chosen_monitor pos=({}, {}) size=({}, {})",
        monitor_pos.x,
        monitor_pos.y,
        monitor_size.width,
        monitor_size.height
    );
    Some((
        monitor_pos.x as f64,
        monitor_pos.y as f64,
        monitor_size.width as f64,
        monitor_size.height as f64,
    ))
}

fn hide_hud_window(app: &AppHandle, state: &AppState) {
    state.hud_seq.fetch_add(1, Ordering::SeqCst);
    let app_handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        {
            let _ = &app_handle;
            macos_hud::hide();
        }
    });
}

fn inject_text_on_main_thread(
    app: &AppHandle,
    text: String,
    expected_focus: Option<String>,
    send_after: bool,
) -> Result<(), SaysoError> {
    let (tx, rx) = mpsc::sync_channel(1);
    let app_handle = app.clone();

    app.run_on_main_thread(move || {
        let _ = &app_handle;
        let result = if send_after {
            injector::inject_text_and_send(&text, expected_focus.as_deref())
        } else {
            injector::inject_text(&text, expected_focus.as_deref())
        };
        let _ = tx.send(result);
    })
    .map_err(|e| SaysoError::InjectorFailed(e.to_string()))?;

    rx.recv()
        .map_err(|e| SaysoError::InjectorFailed(format!("Main-thread injection failed: {}", e)))?
}

#[cfg(not(target_os = "macos"))]
fn parse_shortcuts(cfg: &config::AppConfig) -> Result<Vec<(Shortcut, char, bool)>, SaysoError> {
    let shortcuts = [
        (cfg.hotkeys.mode_a.as_str(), 'a'),
        (cfg.hotkeys.mode_b.as_str(), 'b'),
        (cfg.hotkeys.mode_c.as_str(), 'c'),
    ];

    shortcuts
        .iter()
        .map(|(shortcut, mode)| {
            shortcut
                .parse::<Shortcut>()
                .map(|parsed| {
                    let is_single_key = parsed.mods.is_empty();
                    (parsed, *mode, is_single_key)
                })
                .map_err(|e| SaysoError::Other(format!("Invalid shortcut '{}': {}", shortcut, e)))
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn register_hotkeys(app: &AppHandle, state: Arc<AppState>, cfg: &config::AppConfig) -> Result<(), SaysoError> {
    let parsed = parse_shortcuts(cfg)?;
    let shortcut_list: Vec<Shortcut> = parsed.iter().map(|(s, _, _)| *s).collect();
    let shortcut_map = parsed;

    let _ = app.global_shortcut().unregister_all();

    if shortcut_list.is_empty() {
        return Err(SaysoError::Other("No hotkeys configured".to_string()));
    }

    app.global_shortcut()
        .on_shortcuts(shortcut_list, move |app, shortcut, event| {
            let (mode, is_single_key) = shortcut_map
                .iter()
                .find(|(registered, _, _)| registered == shortcut)
                .map(|(_, mode, is_single_key)| (*mode, *is_single_key))
                .unwrap_or(('a', false));

            match event.state() {
                ShortcutState::Pressed => {
                    if is_single_key {
                        on_single_key_press(app, Arc::clone(&state), mode);
                    } else {
                        on_hotkey_press(app, Arc::clone(&state), mode);
                    }
                }
                ShortcutState::Released => {
                    if is_single_key {
                        on_single_key_release(app, Arc::clone(&state), mode);
                    } else {
                        on_hotkey_release(app, Arc::clone(&state), mode);
                    }
                }
            }
        })
        .map_err(|e| SaysoError::Other(format!("Failed to register hotkeys: {}", e)))?;

    Ok(())
}

#[cfg(target_os = "macos")]
fn register_hotkeys(_app: &AppHandle, state: Arc<AppState>, cfg: &config::AppConfig) -> Result<(), SaysoError> {
    state.hotkeys.update_config(cfg)
}

fn apply_runtime_config(
    app: &AppHandle,
    state: Arc<AppState>,
    cfg: &config::AppConfig,
) -> Result<(), SaysoError> {
    register_hotkeys(app, state, cfg)?;

    if let Some(tray) = app.tray_by_id("main") {
        tray
            .set_visible(cfg.show_in_menu_bar)
            .map_err(|e| SaysoError::Other(format!("Failed to update tray visibility: {}", e)))?;
    }

    Ok(())
}

// ─── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
async fn get_config(state: State<'_, Arc<AppState>>) -> Result<config::AppConfig, SaysoError> {
    Ok(state.config.config())
}

#[tauri::command]
async fn save_config(
    new_config: config::AppConfig,
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), SaysoError> {
    let old_config = state.config.config();

    if old_config.hotkeys.mode_a == new_config.hotkeys.mode_a
        && old_config.hotkeys.mode_b == new_config.hotkeys.mode_b
        && old_config.hotkeys.mode_c == new_config.hotkeys.mode_c
        && old_config.show_in_menu_bar == new_config.show_in_menu_bar
    {
        state.config.update_config(new_config).map_err(SaysoError::from)?;
        return Ok(());
    }

    validate_hotkeys(&new_config)?;
    state.config
        .update_config(new_config.clone())
        .map_err(SaysoError::from)?;
    apply_runtime_config(&app, Arc::clone(state.inner()), &new_config)?;
    Ok(())
}

#[tauri::command]
async fn test_stt_connection(
    state: State<'_, Arc<AppState>>,
) -> Result<(), SaysoError> {
    let config = state.config.config();
    let stt_config = config.stt.ok_or_else(|| SaysoError::ConfigNotFound)?;
    let api_key = (!config.stt_key.trim().is_empty()).then_some(config.stt_key.as_str());
    let hint_prompt = stt_hint_prompt(&config.voice);
    state
        .stt_client
        .test_connection_with_prompt(&stt_config, api_key, hint_prompt.as_deref())
        .await
}

#[tauri::command]
async fn test_llm_connection(
    state: State<'_, Arc<AppState>>,
) -> Result<(), SaysoError> {
    let config = state.config.config();
    let llm_config = config.llm.ok_or_else(|| SaysoError::ConfigNotFound)?;
    let api_key = (!config.llm_key.trim().is_empty()).then_some(config.llm_key.as_str());
    state
        .llm_client
        .test_connection(&llm_config, api_key)
        .await
}

#[tauri::command]
async fn get_stats(state: State<'_, Arc<AppState>>) -> Result<stats::Stats, SaysoError> {
    Ok(state.stats.get())
}

#[tauri::command]
async fn reset_stats(state: State<'_, Arc<AppState>>) -> Result<(), SaysoError> {
    state.stats.reset().map_err(SaysoError::from)
}

#[tauri::command]
async fn export_stats_csv(state: State<'_, Arc<AppState>>) -> Result<String, SaysoError> {
    Ok(state.stats.export_csv())
}

#[tauri::command]
async fn get_fsm_state(state: State<'_, Arc<AppState>>) -> Result<String, SaysoError> {
    Ok(state.fsm.state().to_string())
}

#[tauri::command]
async fn open_accessibility_settings() -> Result<(), SaysoError> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .status()
            .map_err(|e| SaysoError::Other(format!("Failed to open Accessibility settings: {}", e)))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(SaysoError::Other("Accessibility settings shortcut is only supported on macOS".to_string()))
    }
}

#[tauri::command]
async fn open_microphone_settings() -> Result<(), SaysoError> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            .status()
            .map_err(|e| SaysoError::Other(format!("Failed to open Microphone settings: {}", e)))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(SaysoError::Other("Microphone settings shortcut is only supported on macOS".to_string()))
    }
}

// ─── Voice pipeline ──────────────────────────────────────────────────────────

/// Run the full voice pipeline for a given mode.
///
/// Mode A: record → STT → inject text
/// Mode B: record → STT → inject text → press Enter
/// Mode C: record → STT → LLM intent → safety check (on parsed command) → execute
///
/// `captured_focus`: the frontmost app bundle ID captured at hotkey-release time.
/// For Modes A/B, injection is aborted with a warning if focus changed during STT.
async fn run_pipeline(
    app: AppHandle,
    state: Arc<AppState>,
    mode: char,
    wav_bytes: Vec<u8>,
    speaking_secs: f64,
    captured_focus: Option<String>,
) {
    let cfg = state.config.config();

    // ── STT ──
    let stt_config = match cfg.stt {
        Some(ref c) => c.clone(),
        None => {
            state.fsm.on_stt_error("STT not configured".to_string());
            emit_fsm_state(&app, state.fsm.state());
            let message = ui_text(
                &cfg,
                "STT not configured — open Preferences to set up your API",
                "STT 未配置，请先在设置中完成配置",
            );
            emit_toast(
                &app,
                "error",
                &message,
            );
            state.fsm.reset();
            hide_hud_window(&app, &state);
            emit_fsm_state(&app, FsmState::Idle);
            return;
        }
    };

    let api_key = (!cfg.stt_key.trim().is_empty()).then_some(cfg.stt_key.as_str());
    let stt_prompt = stt_hint_prompt(&cfg.voice);

    let text = match state
        .stt_client
        .transcribe(wav_bytes, &stt_config, api_key, stt_prompt.as_deref())
        .await
    {
        Ok(Some(t)) => t,
        Ok(None) => {
            // Empty result — silent skip
            state.fsm.reset();
            hide_hud_window(&app, &state);
            emit_fsm_state(&app, FsmState::Idle);
            return;
        }
        Err(SaysoError::SttTimeout) => {
            state.fsm.on_stt_error("Connection timeout".to_string());
            emit_fsm_state(&app, state.fsm.state());
            emit_toast(&app, "error", "Connection timeout — please check your network");
            state.fsm.reset();
            hide_hud_window(&app, &state);
            emit_fsm_state(&app, FsmState::Idle);
            return;
        }
        Err(SaysoError::SttApiError(code)) => {
            state.fsm.on_stt_error(format!("API error {}", code));
            emit_fsm_state(&app, state.fsm.state());
            emit_toast(&app, "error", &format!("Recognition failed ({})", code));
            state.fsm.reset();
            hide_hud_window(&app, &state);
            emit_fsm_state(&app, FsmState::Idle);
            return;
        }
        Err(SaysoError::SttMalformedResponse) => {
            state.fsm.on_stt_error("Malformed response".to_string());
            emit_fsm_state(&app, state.fsm.state());
            emit_toast(&app, "error", "Response parse error (malformed response)");
            state.fsm.reset();
            hide_hud_window(&app, &state);
            emit_fsm_state(&app, FsmState::Idle);
            return;
        }
        Err(e) => {
            state.fsm.on_stt_error(e.to_string());
            emit_fsm_state(&app, state.fsm.state());
            emit_toast(&app, "error", &e.to_string());
            state.fsm.reset();
            hide_hud_window(&app, &state);
            emit_fsm_state(&app, FsmState::Idle);
            return;
        }
    };

    // ── Mode C: CommandEngine ──
    if mode == 'c' {
        // Fast rule-filter on raw speech text — catch definite blocks early
        if let Some(v) = safety::rule_filter(&text) {
            if !v.safe {
                emit_toast(&app, "warning", &format!("Rejected: {}", v.reason));
                state.fsm.reset();
                hide_hud_window(&app, &state);
                emit_fsm_state(&app, FsmState::Idle);
                return;
            }
        }

        // LLM intent parse: natural language → shell command
        let llm_config = match cfg.llm {
        Some(ref c) => c.clone(),
        None => {
            let message = ui_text(
                &cfg,
                "LLM not configured — open Preferences to set up your LLM API",
                "LLM 未配置，请先在设置中完成配置",
            );
            emit_toast(&app, "error", &message);
            state.fsm.reset();
            hide_hud_window(&app, &state);
            emit_fsm_state(&app, FsmState::Idle);
            return;
        }
        };
        let llm_key = (!cfg.llm_key.trim().is_empty()).then_some(cfg.llm_key.as_str());

        let intent = match intent::parse_intent(
            &state.llm_client,
            &llm_config,
            llm_key,
            &text,
        )
        .await
        {
            Ok(i) => i,
            Err(SaysoError::LlmTimeout) => {
                emit_toast(&app, "error", "LLM timeout — please check your network");
                state.fsm.reset();
                hide_hud_window(&app, &state);
                emit_fsm_state(&app, FsmState::Idle);
                return;
            }
            Err(e) => {
                emit_toast(&app, "error", &format!("Intent parse failed: {}", e));
                state.fsm.reset();
                hide_hud_window(&app, &state);
                emit_fsm_state(&app, FsmState::Idle);
                return;
            }
        };

        if intent.command.is_empty() {
            emit_toast(&app, "warning", &format!("Unclear intent: {}", intent.description));
            state.fsm.reset();
            hide_hud_window(&app, &state);
            emit_fsm_state(&app, FsmState::Idle);
            return;
        }

        // Safety check on the PARSED COMMAND — not raw speech.
        // This prevents prompt-injection in the intent parse from bypassing safety.
        // Rule filter first (fast), then LLM semantic check for gray-zone commands.
        match safety::rule_filter(&intent.command) {
            Some(v) if !v.safe => {
                emit_toast(&app, "warning", &format!("Rejected: {}", v.reason));
                state.fsm.reset();
                hide_hud_window(&app, &state);
                emit_fsm_state(&app, FsmState::Idle);
                return;
            }
            Some(_) => {
                // Explicitly allowed by rule filter — skip LLM safety layer
            }
            None => {
                // Gray zone: run LLM safety check on the actual parsed command
                match safety::llm_safety_check(
                    &state.llm_client,
                    &llm_config,
                    llm_key,
                    &intent.command,
                )
                .await
                {
                    Ok(v) if !v.safe => {
                        emit_toast(&app, "warning", &format!("Rejected: {}", v.reason));
                        state.fsm.reset();
                        hide_hud_window(&app, &state);
                        emit_fsm_state(&app, FsmState::Idle);
                        return;
                    }
                    Ok(_) => {}
                    Err(_) => {
                        // Fail-closed: LLM unavailable → reject
                        emit_toast(&app, "error", "Rejected: safety check unavailable");
                        state.fsm.reset();
                        hide_hud_window(&app, &state);
                        emit_fsm_state(&app, FsmState::Idle);
                        return;
                    }
                }
            }
        }

        // Execute the command
        match executor::execute_command(&intent.command).await {
            Ok(result) => {
                let summary = result.summary();
                let level = if result.success { "info" } else { "warning" };
                emit_toast(&app, level, &summary);
                state.stats.record_command();
            }
            Err(SaysoError::ExecutorTimeout) => {
                emit_toast(&app, "error", "Command timed out (30s)");
                state.stats.record_command();
            }
            Err(e) => {
                emit_toast(&app, "error", &format!("Execution failed: {}", e));
                state.stats.record_command();
            }
        }

        state.fsm.reset();
        hide_hud_window(&app, &state);
        emit_fsm_state(&app, FsmState::Idle);
        return;
    }

    // ── Modes A/B: text injection ──
    // Optional polish step (controlled by voice.polish_enabled)
    let final_text = if cfg.voice.polish_enabled {
        let llm_cfg = cfg.llm.clone();
        match llm_cfg {
            Some(ref lc) => {
                let result = polish::polish_text(
                    &state.llm_client,
                    lc,
                    &cfg.voice,
                    (!cfg.llm_key.trim().is_empty()).then_some(cfg.llm_key.as_str()),
                    &text,
                )
                .await;
                if result.is_fallback() {
                    emit_toast(&app, "warning", "润色失败，使用原始文字");
                }
                result.text().to_string()
            }
            None => text.clone(),
        }
    } else {
        text.clone()
    };

    state.fsm.on_stt_result();
    emit_fsm_state(&app, FsmState::Injecting);

    let inject_result = inject_text_on_main_thread(
        &app,
        final_text.clone(),
        captured_focus.clone(),
        mode == 'b',
    );

    match inject_result {
        Ok(_) => {
            state.fsm.on_inject_done();
            state.stats.record_transcription(speaking_secs, &final_text);
            emit_fsm_state(&app, FsmState::Done);
            state.fsm.reset();
            hide_hud_window(&app, &state);
            emit_fsm_state(&app, FsmState::Idle);
        }
        Err(SaysoError::InjectorFocusLost) => {
            state.fsm.on_inject_error("Focus changed".to_string());
            emit_fsm_state(&app, state.fsm.state());
            emit_toast(&app, "warning", "Focus changed — text was NOT injected");
            state.fsm.reset();
            hide_hud_window(&app, &state);
            emit_fsm_state(&app, FsmState::Idle);
        }
        Err(e) => {
            state.fsm.on_inject_error(e.to_string());
            emit_fsm_state(&app, state.fsm.state());
            emit_toast(&app, "error", &e.to_string());
            state.fsm.reset();
            hide_hud_window(&app, &state);
            emit_fsm_state(&app, FsmState::Idle);
        }
    }
}

// ─── Hotkey handlers ─────────────────────────────────────────────────────────

fn on_hotkey_press(app: &AppHandle, state: Arc<AppState>, mode: char) {
    let cfg = state.config.config();

    if !is_stt_ready(&cfg) {
        let toast = ui_text(&cfg, "STT not configured", "STT 未配置");
        let hud = ui_text(&cfg, "Set up STT API first", "请先配置 STT");
        emit_toast(app, "warning", &toast);
        emit_hud_timed(app, Arc::clone(&state), "warning", &hud, 1800);
        return;
    }

    if mode == 'c' && !is_llm_ready(&cfg) {
        let toast = ui_text(&cfg, "LLM not configured", "LLM 未配置");
        let hud = ui_text(&cfg, "Set up LLM API first", "请先配置 LLM");
        emit_toast(app, "warning", &toast);
        emit_hud_timed(app, Arc::clone(&state), "warning", &hud, 1800);
        return;
    }

    if mode != 'c' && !injector::has_text_input_target() {
        let toast = ui_text(&cfg, "No writable input target", "当前没有可输入目标");
        let hud = ui_text(&cfg, "Focus a text field first", "请先聚焦输入框");
        emit_toast(app, "info", &toast);
        emit_hud_timed(app, Arc::clone(&state), "info", &hud, 1800);
        return;
    }

    if !state.fsm.on_hotkey_press() {
        // Already processing
        let message = ui_text(&cfg, "Processing… please wait", "处理中，请稍候");
        emit_toast(app, "info", &message);
        emit_hud_timed(app, Arc::clone(&state), "info", &message, 1800);
        return;
    }

    emit_fsm_state(app, FsmState::Recording);
    let recording_message = ui_text(&cfg, "Listening…", "听取中…");
    emit_hud(app, &state, "info", &recording_message);

    let mut recorder = state.recorder.lock().unwrap();
    match recorder.start() {
        Ok(handle) => {
            *state.recording_handle.lock().unwrap() = Some(handle);
            info!("Recording started for mode '{}'", mode);
        }
        Err(e) => {
            state.fsm.reset();
            emit_toast(app, "error", &format!("Audio device error: {}", e));
        }
    }
}

fn on_hotkey_release(app: &AppHandle, state: Arc<AppState>, mode: char) {
    if state.fsm.state() != FsmState::Recording {
        return;
    }

    if !state.fsm.on_hotkey_release() {
        return;
    }

    // Drop the recording handle → stops the audio stream
    let handle = state.recording_handle.lock().unwrap().take();
    drop(handle);

    let recorder = state.recorder.lock().unwrap();
    let speaking_secs = recorder.elapsed().as_secs_f64();

    let wav_result = recorder.finish();
    drop(recorder);

    match wav_result {
        Err(SaysoError::RecordingTooShort) => {
            let cfg = state.config.config();
            let message = ui_text(&cfg, "No speech detected", "未检测到语音");
            emit_toast(app, "info", &message);
            state.fsm.reset();
            hide_hud_window(app, &state);
        }
        Err(e) => {
            emit_toast(app, "error", &format!("Audio error: {}", e));
            state.fsm.reset();
            hide_hud_window(app, &state);
        }
        Ok(wav_bytes) => {
            // Capture the frontmost app now (before async STT delay).
            // Passed to run_pipeline so injection can verify focus hasn't changed.
            let focus = injector::capture_focus();
            emit_fsm_state(app, FsmState::SttWaiting);
            let cfg = state.config.config();
            let message = if mode == 'c' {
                ui_text(&cfg, "Processing command…", "处理中…")
            } else {
                ui_text(&cfg, "Transcribing…", "处理中…")
            };
            emit_hud(app, &state, "info", &message);
            let app_clone = app.clone();
            let state_clone = Arc::clone(&state);
            tauri::async_runtime::spawn(async move {
                run_pipeline(app_clone, state_clone, mode, wav_bytes, speaking_secs, focus).await;
            });
        }
    }
}

fn on_single_key_press(app: &AppHandle, state: Arc<AppState>, mode: char) {
    let token = state.hold_seq.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut pending = state.pending_hold.lock().unwrap();
        *pending = Some(PendingHold {
            token,
            mode,
            started: false,
        });
    }

    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(SINGLE_KEY_HOLD_DELAY_MS)).await;

        let should_start = {
            let mut pending = state.pending_hold.lock().unwrap();
            if let Some(current) = pending.as_mut() {
                if current.token == token && current.mode == mode && !current.started {
                    current.started = true;
                    true
                } else {
                    false
                }
            } else {
                false
            }
        };

        if should_start {
            on_hotkey_press(&app_clone, state, mode);
        }
    });
}

fn on_single_key_release(app: &AppHandle, state: Arc<AppState>, mode: char) {
    let pending = {
        let mut pending = state.pending_hold.lock().unwrap();
        if let Some(current) = *pending {
            if current.mode == mode {
                pending.take()
            } else {
                None
            }
        } else {
            None
        }
    };

    if let Some(current) = pending {
        if current.started {
            on_hotkey_release(app, state, mode);
        }
    }
}

// ─── Event helpers ───────────────────────────────────────────────────────────

fn emit_toast(app: &AppHandle, level: &str, message: &str) {
    let _ = app.emit("toast", serde_json::json!({ "level": level, "message": message }));
}

fn emit_hud(app: &AppHandle, state: &AppState, _level: &str, message: &str) {
    state.hud_seq.fetch_add(1, Ordering::SeqCst);
    let target_frame = hud_target_frame(app);
    let app_handle = app.clone();
    let message = message.to_string();
    let _ = app.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        {
            let _ = &app_handle;
            macos_hud::show(&message, target_frame);
        }
    });
}

fn emit_hud_timed(app: &AppHandle, state: Arc<AppState>, level: &str, message: &str, duration_ms: u64) {
    let token = state.hud_seq.fetch_add(1, Ordering::SeqCst) + 1;
    let target_frame = hud_target_frame(app);
    let app_handle = app.clone();
    let message_owned = message.to_string();
    let _ = app.run_on_main_thread({
        let app_handle = app_handle.clone();
        let message_owned = message_owned.clone();
        move || {
            #[cfg(target_os = "macos")]
            {
                let _ = &app_handle;
                let _ = level;
                macos_hud::show(&message_owned, target_frame);
            }
        }
    });

    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(duration_ms)).await;
        if state.hud_seq.load(Ordering::SeqCst) == token {
            hide_hud_window(&app_handle, &state);
        }
    });
}

fn emit_fsm_state(app: &AppHandle, state: FsmState) {
    let _ = app.emit("fsm_state", state.to_string());
}

// ─── Main ────────────────────────────────────────────────────────────────────

fn main() {
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        );

    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

    builder
        .setup(|app| {
            // Load config + API keys into memory
            let config_state = ConfigState::load_all().unwrap_or_else(|e| {
                warn!("Failed to load config: {} — using defaults", e);
                ConfigState::default()
            });

            #[cfg(target_os = "macos")]
            let hotkeys = macos_hotkeys::MacHotkeyEngine::new(
                &config_state.config(),
                {
                    let app = app.handle().clone();
                    move |mode, is_single_key| {
                        if let Some(state) = MAC_APP_STATE.get().cloned() {
                            if is_single_key {
                                on_single_key_press(&app, state, mode);
                            } else {
                                on_hotkey_press(&app, state, mode);
                            }
                        }
                    }
                },
                {
                    let app = app.handle().clone();
                    move |mode, is_single_key| {
                        if let Some(state) = MAC_APP_STATE.get().cloned() {
                            if is_single_key {
                                on_single_key_release(&app, state, mode);
                            } else {
                                on_hotkey_release(&app, state, mode);
                            }
                        }
                    }
                },
            )?;

            let app_state = Arc::new(AppState {
                config: config_state.clone(),
                fsm: RecordingFsm::new(),
                stats: StatsState::load(),
                stt_client: SttClient::new(),
                llm_client: LlmClient::new(),
                recording_handle: std::sync::Mutex::new(None),
                recorder: std::sync::Mutex::new(audio::AudioRecorder::new()),
                pending_hold: std::sync::Mutex::new(None),
                hold_seq: AtomicU64::new(0),
                hud_seq: AtomicU64::new(0),
                #[cfg(target_os = "macos")]
                hotkeys,
            });

            app.manage(Arc::clone(&app_state));
            #[cfg(target_os = "macos")]
            let _ = MAC_APP_STATE.set(Arc::clone(&app_state));

            // ── System tray ──
            let quit = MenuItemBuilder::with_id("quit", "Quit Sayso").build(app)?;
            let preferences = MenuItemBuilder::with_id("preferences", "Preferences…").build(app)?;
            let stats_item = MenuItemBuilder::with_id("stats", "Statistics…").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&preferences, &stats_item, &quit])
                .build()?;

            let _tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "preferences" => show_main_window(app, "preferences"),
                    "stats" => show_main_window(app, "statistics"),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(&tray.app_handle(), "preferences");
                    }
                })
                .build(app)?;

            if !app_state.config.config().show_in_menu_bar {
                if let Some(tray) = app.tray_by_id("main") {
                    let _ = tray.set_visible(false);
                }
            }

            if let Some(main_window) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        hide_main_window(&app_handle);
                    }
                });
            }

            // ── Register global hotkeys ──
            let cfg = app_state.config.config();
            if let Err(e) = register_hotkeys(app.handle(), Arc::clone(&app_state), &cfg) {
                warn!("Failed to register hotkeys: {}", e);
            } else {
                info!("Registered hotkeys from config");
            }

            // Show preferences on first run
            if app_state.config.config().first_run {
                show_main_window(app.handle(), "onboarding");
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            test_stt_connection,
            test_llm_connection,
            open_accessibility_settings,
            open_microphone_settings,
            get_stats,
            reset_stats,
            export_stats_csv,
            get_fsm_state,
        ])
        .run(tauri::generate_context!())
        .expect("Error running Sayso");
}
