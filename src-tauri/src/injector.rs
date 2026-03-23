/// Text injector.
///
/// Injection strategy (priority):
/// 1. enigo key simulation (CGEvent on macOS, SendInput on Windows)
/// 2. Clipboard fallback for Electron-class apps (VS Code, Slack, Discord, Notion, Figma)
///
/// Clipboard fallback notes (from TODOS.md):
/// - Does NOT restore original clipboard content (avoids data race risk)
/// - Uses bundle ID detection on macOS to decide strategy
use enigo::{Enigo, Keyboard, Key, Settings};
use arboard::Clipboard;
use log::{info, warn};
use std::thread;
use std::time::Duration;

use crate::error::SaysoError;
use crate::config::ELECTRON_APP_BUNDLE_IDS;

/// Inject text into the currently focused application.
pub fn inject_text(text: &str) -> Result<(), SaysoError> {
    // Check if the foreground app needs clipboard fallback
    if needs_clipboard_fallback() {
        info!("Using clipboard fallback injection");
        inject_via_clipboard(text)
    } else {
        info!("Using key simulation injection");
        inject_via_enigo(text)
            .or_else(|e| {
                warn!("Key simulation failed ({}), falling back to clipboard", e);
                inject_via_clipboard(text)
            })
    }
}

/// Inject text followed by Enter keypress (Mode B).
pub fn inject_text_and_send(text: &str) -> Result<(), SaysoError> {
    inject_text(text)?;
    // Brief delay to ensure text is injected before Enter
    thread::sleep(Duration::from_millis(50));
    press_enter().map_err(|e| SaysoError::InjectorFailed(e.to_string()))
}

fn inject_via_enigo(text: &str) -> Result<(), SaysoError> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| SaysoError::InjectorFailed(e.to_string()))?;
    enigo
        .text(text)
        .map_err(|e| SaysoError::InjectorFailed(e.to_string()))
}

fn inject_via_clipboard(text: &str) -> Result<(), SaysoError> {
    let mut clipboard = Clipboard::new()
        .map_err(|e| SaysoError::InjectorFailed(e.to_string()))?;

    // Write transcribed text to clipboard (original content NOT saved/restored)
    clipboard
        .set_text(text.to_string())
        .map_err(|e| SaysoError::InjectorFailed(e.to_string()))?;

    // Small delay for clipboard to settle
    thread::sleep(Duration::from_millis(50));

    // Simulate Cmd+V (macOS) or Ctrl+V (Windows)
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| SaysoError::InjectorFailed(e.to_string()))?;

    #[cfg(target_os = "macos")]
    {
        // macOS: Meta (Cmd) + V
        let _ = enigo.key(Key::Meta, enigo::Direction::Press);
        enigo
            .key(Key::Unicode('v'), enigo::Direction::Click)
            .map_err(|e| SaysoError::InjectorFailed(e.to_string()))?;
        let _ = enigo.key(Key::Meta, enigo::Direction::Release);
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows/Linux: Ctrl + V
        let _ = enigo.key(Key::Control, enigo::Direction::Press);
        let _ = enigo.key(Key::Unicode('v'), enigo::Direction::Click);
        let _ = enigo.key(Key::Control, enigo::Direction::Release);
    }

    info!("Clipboard injection complete");
    Ok(())
}

fn press_enter() -> anyhow::Result<()> {
    let mut enigo = Enigo::new(&Settings::default())?;
    enigo.key(Key::Return, enigo::Direction::Click)?;
    Ok(())
}

/// Determine if the currently focused app needs clipboard fallback.
/// On macOS: checks the frontmost app's bundle ID against the known list.
/// On Windows: stub (always returns false for now).
fn needs_clipboard_fallback() -> bool {
    #[cfg(target_os = "macos")]
    {
        if let Some(bundle_id) = frontmost_bundle_id() {
            return ELECTRON_APP_BUNDLE_IDS.contains(&bundle_id.as_str());
        }
    }
    false
}

#[cfg(target_os = "macos")]
fn frontmost_bundle_id() -> Option<String> {
    use std::process::Command;
    // Use osascript to get frontmost app bundle ID
    let output = Command::new("osascript")
        .arg("-e")
        .arg("id of app (path to frontmost application as text)")
        .output()
        .ok()?;
    if output.status.success() {
        let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clipboard_inject_text_available() {
        // Verify clipboard can be opened (basic sanity check)
        // Note: this test requires a display server to be available
        if std::env::var("CI").is_ok() {
            return; // Skip in headless CI
        }
        let result = Clipboard::new();
        assert!(result.is_ok(), "Clipboard should be accessible");
    }
}
