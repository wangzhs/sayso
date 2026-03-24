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

use crate::config::{LlmConfig, VoiceConfig};
use crate::llm::LlmClient;

fn polish_system_prompt(voice: &VoiceConfig) -> String {
    let output_rule = match voice.output_text_style.as_str() {
        "spoken_style" => "Preserve the speaker's spoken flavor where natural, including dialect color, but still produce readable written Chinese.",
        _ => "When the input contains dialect words or regional phrasing, normalize them into clear standard Mandarin written Chinese whenever possible.",
    };

    format!(
        r#"You are a speech-to-text cleanup assistant.
The user just dictated text using a voice keyboard. Clean up the raw transcription.

Rules:
- Fix punctuation, capitalization, and obvious speech recognition errors.
- Do NOT change the meaning or add/remove information.
- Do NOT add greetings or commentary.
- Return ONLY the cleaned text, nothing else.
- If the text is already clean, return it unchanged.
- {}
"#,
        output_rule
    )
}

/// Attempt to polish raw STT text via LLM.
///
/// Returns the polished text, or the raw text if polishing fails.
/// Caller is responsible for showing a toast if this falls back.
pub async fn polish_text(
    client: &LlmClient,
    config: &LlmConfig,
    voice: &VoiceConfig,
    api_key: Option<&str>,
    raw: &str,
) -> PolishResult {
    info!("Polishing {} chars", raw.len());
    let system_prompt = polish_system_prompt(voice);

    match client.chat(config, api_key, &system_prompt, raw, 500, 0.2).await {
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
