// Prevents console window on Windows in release builds
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Arc;
use tauri::{
    AppHandle, Manager, State, Emitter,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
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
}

// ─── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
async fn get_config(state: State<'_, Arc<AppState>>) -> Result<config::AppConfig, SaysoError> {
    Ok(state.config.config())
}

#[tauri::command]
async fn save_config(
    new_config: config::AppConfig,
    state: State<'_, Arc<AppState>>,
) -> Result<(), SaysoError> {
    state.config.update_config(new_config).map_err(SaysoError::from)
}

#[tauri::command]
async fn save_stt_key(
    key: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), SaysoError> {
    state.config.update_stt_key(key).map_err(SaysoError::from)
}

#[tauri::command]
async fn save_llm_key(
    key: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), SaysoError> {
    state.config.update_llm_key(key).map_err(SaysoError::from)
}

#[tauri::command]
async fn test_stt_connection(
    state: State<'_, Arc<AppState>>,
) -> Result<(), SaysoError> {
    let config = state.config.config();
    let stt_config = config.stt.ok_or_else(|| SaysoError::ConfigNotFound)?;
    let api_key = state.config.stt_api_key();
    state
        .stt_client
        .test_connection(&stt_config, api_key.as_deref())
        .await
}

#[tauri::command]
async fn test_llm_connection(
    state: State<'_, Arc<AppState>>,
) -> Result<(), SaysoError> {
    let config = state.config.config();
    let llm_config = config.llm.ok_or_else(|| SaysoError::ConfigNotFound)?;
    let api_key = state.config.llm_api_key();
    state
        .llm_client
        .test_connection(&llm_config, api_key.as_deref())
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

// ─── Voice pipeline ──────────────────────────────────────────────────────────

/// Run the full voice pipeline for a given mode.
///
/// Mode A: record → STT → inject text
/// Mode B: record → STT → inject text → press Enter
/// Mode C: record → STT → LLM intent → safety check → execute (Phase 2)
async fn run_pipeline(
    app: AppHandle,
    state: Arc<AppState>,
    mode: char,
    wav_bytes: Vec<u8>,
    speaking_secs: f64,
) {
    let cfg = state.config.config();

    // ── STT ──
    let stt_config = match cfg.stt {
        Some(ref c) => c.clone(),
        None => {
            emit_toast(
                &app,
                "error",
                "STT not configured — open Preferences to set up your API",
            );
            state.fsm.reset();
            return;
        }
    };

    let api_key = state.config.stt_api_key();

    let text = match state
        .stt_client
        .transcribe(wav_bytes, &stt_config, api_key.as_deref())
        .await
    {
        Ok(Some(t)) => t,
        Ok(None) => {
            // Empty result — silent skip
            state.fsm.reset();
            return;
        }
        Err(SaysoError::SttTimeout) => {
            state.fsm.on_stt_error("Connection timeout".to_string());
            emit_toast(&app, "error", "Connection timeout — please check your network");
            state.fsm.reset();
            return;
        }
        Err(SaysoError::SttApiError(code)) => {
            state.fsm.on_stt_error(format!("API error {}", code));
            emit_toast(&app, "error", &format!("Recognition failed ({})", code));
            state.fsm.reset();
            return;
        }
        Err(SaysoError::SttMalformedResponse) => {
            state.fsm.on_stt_error("Malformed response".to_string());
            emit_toast(&app, "error", "Response parse error (malformed response)");
            state.fsm.reset();
            return;
        }
        Err(e) => {
            state.fsm.on_stt_error(e.to_string());
            emit_toast(&app, "error", &e.to_string());
            state.fsm.reset();
            return;
        }
    };

    // ── Mode C: CommandEngine ──
    if mode == 'c' {
        // Layer 1: rule-based safety filter (fast O(1))
        let verdict = safety::rule_filter(&text);
        match verdict {
            Some(v) if !v.safe => {
                emit_toast(&app, "warning", &format!("Rejected: {}", v.reason));
                state.fsm.reset();
                return;
            }
            Some(_) => {
                // rule_filter says safe — skip LLM safety layer
            }
            None => {
                // Gray zone: rule filter inconclusive → LLM safety check (fail-closed)
                let llm_config = match cfg.llm {
                    Some(ref c) => c.clone(),
                    None => {
                        emit_toast(&app, "error", "Rejected: safety check unavailable — LLM not configured");
                        state.fsm.reset();
                        return;
                    }
                };
                let llm_key = state.config.llm_api_key();
                match safety::llm_safety_check(
                    &state.llm_client,
                    &llm_config,
                    llm_key.as_deref(),
                    &text,
                )
                .await
                {
                    Ok(v) if !v.safe => {
                        emit_toast(&app, "warning", &format!("Rejected: {}", v.reason));
                        state.fsm.reset();
                        return;
                    }
                    Ok(_) => {}
                    Err(_) => {
                        // Fail-closed: LLM unavailable → reject
                        emit_toast(&app, "error", "Rejected: safety check unavailable");
                        state.fsm.reset();
                        return;
                    }
                }
            }
        }

        // LLM intent parse: natural language → shell command
        let llm_config = match cfg.llm {
            Some(ref c) => c.clone(),
            None => {
                emit_toast(&app, "error", "LLM not configured — open Preferences to set up your LLM API");
                state.fsm.reset();
                return;
            }
        };
        let llm_key = state.config.llm_api_key();

        let intent = match intent::parse_intent(
            &state.llm_client,
            &llm_config,
            llm_key.as_deref(),
            &text,
        )
        .await
        {
            Ok(i) => i,
            Err(SaysoError::LlmTimeout) => {
                emit_toast(&app, "error", "LLM timeout — please check your network");
                state.fsm.reset();
                return;
            }
            Err(e) => {
                emit_toast(&app, "error", &format!("Intent parse failed: {}", e));
                state.fsm.reset();
                return;
            }
        };

        if intent.command.is_empty() {
            emit_toast(&app, "warning", &format!("Unclear intent: {}", intent.description));
            state.fsm.reset();
            return;
        }

        // Second rule-filter pass on the parsed command (defense-in-depth)
        if let Some(v) = safety::rule_filter(&intent.command) {
            if !v.safe {
                emit_toast(&app, "warning", &format!("Rejected: {}", v.reason));
                state.fsm.reset();
                return;
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
        return;
    }

    // ── Modes A/B: text injection ──
    // Optional polish step (controlled by voice.polish_enabled)
    let final_text = if cfg.voice.polish_enabled {
        let llm_cfg = cfg.llm.clone();
        match llm_cfg {
            Some(ref lc) => {
                let llm_key = state.config.llm_api_key();
                let result = polish::polish_text(
                    &state.llm_client,
                    lc,
                    llm_key.as_deref(),
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

    let inject_result = if mode == 'b' {
        injector::inject_text_and_send(&final_text)
    } else {
        injector::inject_text(&final_text)
    };

    match inject_result {
        Ok(_) => {
            state.fsm.on_inject_done();
            state.stats.record_transcription(speaking_secs, &final_text);
            emit_fsm_state(&app, FsmState::Done);
            // Auto-reset to IDLE
            state.fsm.reset();
        }
        Err(e) => {
            state.fsm.on_inject_error(e.to_string());
            emit_toast(&app, "error", &e.to_string());
            state.fsm.reset();
        }
    }
}

// ─── Hotkey handlers ─────────────────────────────────────────────────────────

fn on_hotkey_press(app: &AppHandle, state: Arc<AppState>, mode: char) {
    if !state.fsm.on_hotkey_press() {
        // Already processing
        emit_toast(app, "info", "Processing… please wait");
        return;
    }

    emit_fsm_state(app, FsmState::Recording);

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
    if !state.fsm.on_hotkey_release() {
        return;
    }

    // Drop the recording handle → stops the audio stream
    let handle = state.recording_handle.lock().unwrap().take();
    drop(handle);

    let recorder = state.recorder.lock().unwrap();
    let speaking_secs = recorder.elapsed().as_secs_f64();

    // Get the native sample rate from the recorder
    // For simplicity, we assume 16kHz after resampling
    let wav_result = recorder.finish(16_000);
    drop(recorder);

    match wav_result {
        Err(SaysoError::RecordingTooShort) => {
            emit_toast(app, "info", "No speech detected");
            state.fsm.reset();
        }
        Err(e) => {
            emit_toast(app, "error", &format!("Audio error: {}", e));
            state.fsm.reset();
        }
        Ok(wav_bytes) => {
            emit_fsm_state(app, FsmState::SttWaiting);
            let app_clone = app.clone();
            let state_clone = Arc::clone(&state);
            tokio::spawn(async move {
                run_pipeline(app_clone, state_clone, mode, wav_bytes, speaking_secs).await;
            });
        }
    }
}

// ─── Event helpers ───────────────────────────────────────────────────────────

fn emit_toast(app: &AppHandle, level: &str, message: &str) {
    let _ = app.emit("toast", serde_json::json!({ "level": level, "message": message }));
}

fn emit_fsm_state(app: &AppHandle, state: FsmState) {
    let _ = app.emit("fsm_state", state.to_string());
}

// ─── Main ────────────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new()
            .level(log::LevelFilter::Info)
            .build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Load config + API keys into memory
            let config_state = ConfigState::load_all().unwrap_or_else(|e| {
                warn!("Failed to load config: {} — using defaults", e);
                ConfigState::default()
            });

            let app_state = Arc::new(AppState {
                config: config_state.clone(),
                fsm: RecordingFsm::new(),
                stats: StatsState::load(),
                stt_client: SttClient::new(),
                llm_client: LlmClient::new(),
                recording_handle: std::sync::Mutex::new(None),
                recorder: std::sync::Mutex::new(audio::AudioRecorder::new()),
            });

            app.manage(Arc::clone(&app_state));

            // ── System tray ──
            let quit = MenuItemBuilder::with_id("quit", "Quit Sayso").build(app)?;
            let preferences = MenuItemBuilder::with_id("preferences", "Preferences…").build(app)?;
            let stats_item = MenuItemBuilder::with_id("stats", "Statistics…").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&preferences, &stats_item, &quit])
                .build()?;

            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "preferences" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|_tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        // Left-click: no-op (menu opens on right-click)
                    }
                })
                .build(app)?;

            // ── Register global hotkeys ──
            let cfg = app_state.config.config();
            let shortcuts: Vec<(String, char)> = vec![
                (cfg.hotkeys.mode_a.clone(), 'a'),
                (cfg.hotkeys.mode_b.clone(), 'b'),
                (cfg.hotkeys.mode_c.clone(), 'c'),
            ];

            let state_for_shortcuts = Arc::clone(&app_state);

            // Parse shortcut strings into Shortcut objects, skipping invalid ones
            let parsed: Vec<(Shortcut, char)> = shortcuts
                .iter()
                .filter_map(|(s, m)| s.parse::<Shortcut>().ok().map(|sh| (sh, *m)))
                .collect();

            let shortcut_list: Vec<Shortcut> = parsed.iter().map(|(s, _)| s.clone()).collect();
            let shortcut_map = parsed.clone();

            if shortcut_list.is_empty() {
                warn!("No valid hotkeys configured — voice input will not be available");
            } else if let Err(e) = app.global_shortcut().on_shortcuts(
                shortcut_list,
                move |app, shortcut, event| {
                    let mode = shortcut_map
                        .iter()
                        .find(|(s, _)| s == shortcut)
                        .map(|(_, m)| *m)
                        .unwrap_or('a');

                    match event.state() {
                        ShortcutState::Pressed => {
                            on_hotkey_press(app, Arc::clone(&state_for_shortcuts), mode);
                        }
                        ShortcutState::Released => {
                            on_hotkey_release(app, Arc::clone(&state_for_shortcuts), mode);
                        }
                    }
                },
            ) {
                warn!("Failed to register hotkeys: {}", e);
            } else {
                for (s, _) in &shortcuts {
                    info!("Registered hotkey: {}", s);
                }
            }

            // Show preferences on first run
            if app_state.config.config().first_run {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.emit("navigate", "onboarding");
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            save_stt_key,
            save_llm_key,
            test_stt_connection,
            test_llm_connection,
            get_stats,
            reset_stats,
            export_stats_csv,
            get_fsm_state,
        ])
        .run(tauri::generate_context!())
        .expect("Error running Sayso");
}
