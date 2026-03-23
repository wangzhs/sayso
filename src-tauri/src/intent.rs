/// Intent parser for Mode C (command mode).
///
/// Sends the raw STT text to the LLM and parses the response into
/// a structured shell command.
///
/// v1 execution model (TODO-4 decision): direct execution only.
/// No pipes, no shell expansion, no redirections. Covers ~95% of use cases.
use serde::Deserialize;
use log::{info, warn};

use crate::config::LlmConfig;
use crate::error::SaysoError;
use crate::llm::LlmClient;

const INTENT_SYSTEM_PROMPT: &str = r#"You are a command interpreter for a voice-controlled shell assistant.
The user spoke a command in natural language. Your job is to parse it into a direct shell command.

Rules:
- Return ONLY a JSON object: {"command": "<shell command>", "description": "<1-line English description>"}
- Use direct execution only. No pipes (|), no redirections (>, <), no shell expansions ($(), ``, &&, ||).
- The command will be split on whitespace and executed directly (not through a shell).
- If the intent is unclear or cannot be mapped to a safe direct command, return: {"command": "", "description": "unclear intent"}
- Never generate: rm -rf, sudo, su, mkfs, fdisk, or any irreversible destructive command.
- Prefer read-only commands. For write operations, be conservative.
- Examples:
  "list files in current directory" -> {"command": "ls -la", "description": "list all files with details"}
  "show disk usage" -> {"command": "df -h", "description": "show disk usage in human-readable format"}
  "open finder" -> {"command": "open .", "description": "open current directory in Finder"}
  "what processes are running" -> {"command": "ps aux", "description": "list all running processes"}
"#;

/// Result of intent parsing.
#[derive(Debug, Clone, Deserialize)]
pub struct IntentResult {
    /// The parsed shell command. Empty string means intent was unclear.
    pub command: String,
    /// Human-readable description of what the command does.
    pub description: String,
}

/// Parse natural language text into a shell command via LLM.
pub async fn parse_intent(
    client: &LlmClient,
    config: &LlmConfig,
    api_key: Option<&str>,
    text: &str,
) -> Result<IntentResult, SaysoError> {
    info!("Parsing intent for: {:?}", &text.chars().take(80).collect::<String>());

    let response = client
        .chat(config, api_key, INTENT_SYSTEM_PROMPT, text, 150, 0.0)
        .await?;

    // Strip markdown code fences if the LLM wraps its response
    let cleaned = response
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let result: IntentResult = serde_json::from_str(cleaned).map_err(|e| {
        warn!("Intent JSON parse error: {} — raw: {:?}", e, &cleaned.chars().take(200).collect::<String>());
        SaysoError::LlmMalformedResponse
    })?;

    if result.command.is_empty() {
        info!("Intent unclear: {}", result.description);
    } else {
        info!("Parsed command: {:?} — {}", result.command, result.description);
    }

    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_intent_result_deserialization() {
        let json = r#"{"command": "ls -la", "description": "list files"}"#;
        let result: IntentResult = serde_json::from_str(json).unwrap();
        assert_eq!(result.command, "ls -la");
        assert_eq!(result.description, "list files");
    }

    #[test]
    fn test_intent_result_empty_command() {
        let json = r#"{"command": "", "description": "unclear intent"}"#;
        let result: IntentResult = serde_json::from_str(json).unwrap();
        assert!(result.command.is_empty());
    }

    #[test]
    fn test_intent_json_strip_markdown() {
        // Simulate LLM wrapping response in code fence
        let raw = "```json\n{\"command\": \"ps aux\", \"description\": \"list processes\"}\n```";
        let cleaned = raw
            .trim()
            .trim_start_matches("```json")
            .trim_start_matches("```")
            .trim_end_matches("```")
            .trim();
        let result: IntentResult = serde_json::from_str(cleaned).unwrap();
        assert_eq!(result.command, "ps aux");
    }
}
