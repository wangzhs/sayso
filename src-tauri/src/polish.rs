/// Text polisher for Modes A/B (optional, controlled by voice.polish_enabled).
///
/// Sends raw STT text to LLM for light cleanup:
/// - Fix punctuation and capitalization
/// - Correct obvious speech recognition errors
/// - Preserve meaning exactly
///
/// Failure behavior (TODOS.md #11):
/// - LLM unavailable → fallback to raw text + Toast "润色失败，使用原始文字"
/// - Empty result → fallback to raw text
/// - Mode C: polish is always skipped
use log::{info, warn};

use crate::config::LlmConfig;
use crate::llm::LlmClient;

const POLISH_SYSTEM_PROMPT: &str = r#"You are a speech-to-text cleanup assistant.
The user just dictated text using a voice keyboard. Clean up the raw transcription.

Rules:
- Fix punctuation, capitalization, and obvious speech recognition errors.
- Do NOT change the meaning or add/remove information.
- Do NOT add greetings or commentary.
- Return ONLY the cleaned text, nothing else.
- If the text is already clean, return it unchanged.
"#;

/// Attempt to polish raw STT text via LLM.
///
/// Returns the polished text, or the raw text if polishing fails.
/// Caller is responsible for showing a toast if this falls back.
pub async fn polish_text(
    client: &LlmClient,
    config: &LlmConfig,
    api_key: Option<&str>,
    raw: &str,
) -> PolishResult {
    info!("Polishing {} chars", raw.len());

    match client.chat(config, api_key, POLISH_SYSTEM_PROMPT, raw, 500, 0.2).await {
        Ok(polished) if !polished.is_empty() => {
            info!("Polished: {} → {} chars", raw.len(), polished.len());
            PolishResult::Polished(polished)
        }
        Ok(_) => {
            warn!("Polish returned empty text, using raw");
            PolishResult::Fallback(raw.to_string())
        }
        Err(e) => {
            warn!("Polish failed: {}", e);
            PolishResult::Fallback(raw.to_string())
        }
    }
}

/// Result of polishing. Caller decides whether to show a toast on fallback.
#[derive(Debug)]
pub enum PolishResult {
    Polished(String),
    Fallback(String),
}

impl PolishResult {
    pub fn text(&self) -> &str {
        match self {
            PolishResult::Polished(s) | PolishResult::Fallback(s) => s,
        }
    }

    pub fn is_fallback(&self) -> bool {
        matches!(self, PolishResult::Fallback(_))
    }
}
