/// Configuration management.
///
/// - All settings, including API keys, are stored in a single JSON file:
///   ~/Library/Application Support/com.sayso.app/config.json
/// - Cached in-memory at startup; refreshed when settings change
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use anyhow::{Context, Result};
use log::info;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SttConfig {
    /// OpenAI-compatible transcription endpoint
    pub endpoint: String,
    /// Whisper-compatible model name
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmConfig {
    /// OpenAI-compatible chat completions endpoint
    pub endpoint: String,
    /// Model name for intent parsing (e.g. "gpt-4o-mini")
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyConfig {
    /// Mode A: type (default: Option+Space on macOS, Ctrl+Space elsewhere)
    pub mode_a: String,
    /// Mode B: type + send (default: Option+Enter on macOS, Ctrl+Enter elsewhere)
    pub mode_b: String,
    /// Mode C: command (default: Option+Period on macOS, Ctrl+Period elsewhere)
    pub mode_c: String,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        #[cfg(target_os = "macos")]
        let defaults = ("Option+Space", "Option+Enter", "Option+Period");

        #[cfg(not(target_os = "macos"))]
        let defaults = ("Ctrl+Space", "Ctrl+Enter", "Ctrl+Period");

        Self {
            mode_a: defaults.0.to_string(),
            mode_b: defaults.1.to_string(),
            mode_c: defaults.2.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceConfig {
    /// Whether to polish raw STT text using LLM (Modes A/B only)
    #[serde(default)]
    pub polish_enabled: bool,
    /// Whether to apply dialect-aware recognition hints.
    #[serde(default = "default_dialect_support_enabled")]
    pub dialect_support_enabled: bool,
    /// Preferred spoken input profile for STT biasing.
    #[serde(default = "default_input_variant")]
    pub input_variant: String,
    /// Output text normalization style after recognition.
    #[serde(default = "default_output_text_style")]
    pub output_text_style: String,
}

fn default_dialect_support_enabled() -> bool {
    true
}

fn default_input_variant() -> String {
    "auto".to_string()
}

fn default_output_text_style() -> String {
    "standard_mandarin".to_string()
}

impl Default for VoiceConfig {
    fn default() -> Self {
        Self {
            polish_enabled: false,
            dialect_support_enabled: default_dialect_support_enabled(),
            input_variant: default_input_variant(),
            output_text_style: default_output_text_style(),
        }
    }
}

/// Electron-class apps that need clipboard fallback for text injection.
/// Bundle IDs are macOS-specific.
pub const ELECTRON_APP_BUNDLE_IDS: &[&str] = &[
    "com.microsoft.VSCode",
    "com.tinyspeck.slackmacgui",
    "com.hnc.Discord",
    "com.notion.id",
    "com.figma.Desktop",
    "com.tencent.xinWeChat",
    "com.tencent.WeChat",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub stt: Option<SttConfig>,
    #[serde(default)]
    pub stt_key: String,
    pub llm: Option<LlmConfig>,
    #[serde(default)]
    pub llm_key: String,
    pub hotkeys: HotkeyConfig,
    #[serde(default)]
    pub voice: VoiceConfig,
    #[serde(default = "default_show_in_menu_bar")]
    pub show_in_menu_bar: bool,
    #[serde(default = "default_ui_language")]
    pub ui_language: String,
    /// Whether this is the first run (triggers onboarding)
    pub first_run: bool,
}

fn default_show_in_menu_bar() -> bool {
    true
}

fn default_ui_language() -> String {
    "en".to_string()
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            stt: None,
            stt_key: String::new(),
            llm: None,
            llm_key: String::new(),
            hotkeys: HotkeyConfig::default(),
            voice: VoiceConfig::default(),
            show_in_menu_bar: default_show_in_menu_bar(),
            ui_language: default_ui_language(),
            first_run: true,
        }
    }
}

fn config_path() -> Result<PathBuf> {
    let base = dirs::config_dir()
        .context("Cannot determine config dir")?;
    Ok(base.join("com.sayso.app").join("config.json"))
}

fn normalize_hotkey_string(value: &str) -> String {
    value
        .replace("CmdOrCtrl", "CommandOrControl")
        .replace("CmdOrControl", "CommandOrControl")
        .replace("Return", "Enter")
        .replace("Alt", "Option")
}

fn normalize_hotkeys(cfg: &mut AppConfig) {
    cfg.hotkeys.mode_a = normalize_hotkey_string(&cfg.hotkeys.mode_a);
    cfg.hotkeys.mode_b = normalize_hotkey_string(&cfg.hotkeys.mode_b);
    cfg.hotkeys.mode_c = normalize_hotkey_string(&cfg.hotkeys.mode_c);
}

pub fn load() -> Result<AppConfig> {
    let path = config_path()?;
    if !path.exists() {
        info!("No config file found; using defaults (first run)");
        return Ok(AppConfig::default());
    }
    let content = std::fs::read_to_string(&path)
        .with_context(|| format!("Failed to read config from {:?}", path))?;
    let mut cfg: AppConfig = serde_json::from_str(&content)
        .with_context(|| "Config file is malformed")?;
    normalize_hotkeys(&mut cfg);
    info!("Config loaded from {:?}", path);
    Ok(cfg)
}

pub fn save(cfg: &AppConfig) -> Result<()> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut normalized = cfg.clone();
    normalize_hotkeys(&mut normalized);
    let content = serde_json::to_string_pretty(&normalized)?;
    std::fs::write(&path, content)?;
    info!("Config saved to {:?}", path);
    Ok(())
}

// ─── In-memory cache ─────────────────────────────────────────────────────────

/// Shared config state cached at startup.
#[derive(Debug, Clone)]
pub struct ConfigState {
    inner: Arc<RwLock<AppConfig>>,
}

impl Default for ConfigState {
    fn default() -> Self {
        Self {
            inner: Arc::new(RwLock::new(AppConfig::default())),
        }
    }
}

impl ConfigState {
    /// Load config into memory.
    pub fn load_all() -> Result<Self> {
        let cfg = load()?;
        Ok(Self {
            inner: Arc::new(RwLock::new(cfg)),
        })
    }

    pub fn config(&self) -> AppConfig {
        self.inner.read().unwrap().clone()
    }

    /// Update config and persist to disk.
    pub fn update_config(&self, new_cfg: AppConfig) -> Result<()> {
        save(&new_cfg)?;
        *self.inner.write().unwrap() = new_cfg;
        Ok(())
    }
}
