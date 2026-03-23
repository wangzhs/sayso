/// Configuration management.
///
/// - Non-secret settings stored in JSON: ~/Library/Application Support/com.sayso.app/config.json
/// - API keys stored in system Keychain (never written to JSON)
/// - Cached in-memory at startup; refreshed when settings change
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use anyhow::{Context, Result};
use log::{info, warn};

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
    /// Mode A: type (default: Alt+Space)
    pub mode_a: String,
    /// Mode B: type + send (default: Alt+Enter)
    pub mode_b: String,
    /// Mode C: command (default: Alt+Period)
    pub mode_c: String,
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            mode_a: "Alt+Space".to_string(),
            mode_b: "Alt+Return".to_string(),
            mode_c: "Alt+Period".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoiceConfig {
    /// Whether to polish raw STT text using LLM (Modes A/B only)
    pub polish_enabled: bool,
}

impl Default for VoiceConfig {
    fn default() -> Self {
        Self {
            polish_enabled: false,
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
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub stt: Option<SttConfig>,
    pub llm: Option<LlmConfig>,
    pub hotkeys: HotkeyConfig,
    pub voice: VoiceConfig,
    /// Whether this is the first run (triggers onboarding)
    pub first_run: bool,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            stt: None,
            llm: None,
            hotkeys: HotkeyConfig::default(),
            voice: VoiceConfig::default(),
            first_run: true,
        }
    }
}

fn config_path() -> Result<PathBuf> {
    let base = dirs::config_dir()
        .context("Cannot determine config dir")?;
    Ok(base.join("com.sayso.app").join("config.json"))
}

pub fn load() -> Result<AppConfig> {
    let path = config_path()?;
    if !path.exists() {
        info!("No config file found; using defaults (first run)");
        return Ok(AppConfig::default());
    }
    let content = std::fs::read_to_string(&path)
        .with_context(|| format!("Failed to read config from {:?}", path))?;
    let cfg: AppConfig = serde_json::from_str(&content)
        .with_context(|| "Config file is malformed")?;
    info!("Config loaded from {:?}", path);
    Ok(cfg)
}

pub fn save(cfg: &AppConfig) -> Result<()> {
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let content = serde_json::to_string_pretty(cfg)?;
    std::fs::write(&path, content)?;
    info!("Config saved to {:?}", path);
    Ok(())
}

// ─── Keychain (macOS) ────────────────────────────────────────────────────────

const KEYCHAIN_SERVICE: &str = "com.sayso.app";

pub fn keychain_save(key: &str, value: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        use security_framework::passwords::set_generic_password;
        set_generic_password(KEYCHAIN_SERVICE, key, value.as_bytes())
            .map_err(|e| anyhow::anyhow!("Keychain save error: {}", e))?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows: use credential manager; stub for now
        warn!("Keychain not implemented on this platform; key '{}' not saved", key);
    }
    Ok(())
}

pub fn keychain_load(key: &str) -> Result<Option<String>> {
    #[cfg(target_os = "macos")]
    {
        use security_framework::passwords::get_generic_password;
        match get_generic_password(KEYCHAIN_SERVICE, key) {
            Ok(bytes) => {
                let s = String::from_utf8(bytes)
                    .map_err(|e| anyhow::anyhow!("Keychain value is not UTF-8: {}", e))?;
                Ok(Some(s))
            }
            Err(e) if e.code() == -25300 => Ok(None), // errSecItemNotFound
            Err(e) => Err(anyhow::anyhow!("Keychain load error: {}", e)),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        warn!("Keychain not implemented on this platform; key '{}' not loaded", key);
        Ok(None)
    }
}

#[allow(dead_code)]
pub fn keychain_delete(key: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        use security_framework::passwords::delete_generic_password;
        match delete_generic_password(KEYCHAIN_SERVICE, key) {
            Ok(_) => {}
            Err(e) if e.code() == -25300 => {} // already gone
            Err(e) => return Err(anyhow::anyhow!("Keychain delete error: {}", e)),
        }
    }
    Ok(())
}

// ─── In-memory cache ─────────────────────────────────────────────────────────

/// Shared config state cached at startup.
#[derive(Debug, Clone)]
pub struct ConfigState {
    inner: Arc<RwLock<(AppConfig, Option<String>, Option<String>)>>,
}

impl Default for ConfigState {
    fn default() -> Self {
        Self {
            inner: Arc::new(RwLock::new((AppConfig::default(), None, None))),
        }
    }
}

impl ConfigState {
    /// Load config + API keys from Keychain into memory.
    pub fn load_all() -> Result<Self> {
        let cfg = load()?;
        let stt_key = keychain_load("stt_api_key")
            .unwrap_or_else(|e| { warn!("Failed to load STT key: {}", e); None });
        let llm_key = keychain_load("llm_api_key")
            .unwrap_or_else(|e| { warn!("Failed to load LLM key: {}", e); None });
        Ok(Self {
            inner: Arc::new(RwLock::new((cfg, stt_key, llm_key))),
        })
    }

    pub fn config(&self) -> AppConfig {
        self.inner.read().unwrap().0.clone()
    }

    pub fn stt_api_key(&self) -> Option<String> {
        self.inner.read().unwrap().1.clone()
    }

    pub fn llm_api_key(&self) -> Option<String> {
        self.inner.read().unwrap().2.clone()
    }

    /// Update config and persist to disk. Does NOT update Keychain.
    pub fn update_config(&self, new_cfg: AppConfig) -> Result<()> {
        save(&new_cfg)?;
        self.inner.write().unwrap().0 = new_cfg;
        Ok(())
    }

    /// Update an API key in both Keychain and in-memory cache.
    pub fn update_stt_key(&self, key: String) -> Result<()> {
        keychain_save("stt_api_key", &key)?;
        self.inner.write().unwrap().1 = Some(key);
        Ok(())
    }

    pub fn update_llm_key(&self, key: String) -> Result<()> {
        keychain_save("llm_api_key", &key)?;
        self.inner.write().unwrap().2 = Some(key);
        Ok(())
    }
}
