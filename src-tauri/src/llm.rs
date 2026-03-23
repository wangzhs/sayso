/// LLM (Language Model) HTTP client.
///
/// - OpenAI-compatible /chat/completions endpoint
/// - 15-second timeout
/// - Shared across IntentParser and TextPolisher (stored in AppState)
/// - API key never logged
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use log::{debug, info, warn};

use crate::config::LlmConfig;
use crate::error::SaysoError;

const LLM_TIMEOUT_SECS: u64 = 15;

#[derive(Serialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    max_tokens: u32,
    temperature: f32,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessageContent,
}

#[derive(Deserialize)]
struct ChatMessageContent {
    content: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

/// Shared LLM client — created once and reused.
pub struct LlmClient {
    client: Client,
}

impl LlmClient {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(LLM_TIMEOUT_SECS))
            .build()
            .expect("Failed to build LLM HTTP client");
        Self { client }
    }

    /// Send a chat completion request. Returns the assistant's response text.
    pub async fn chat(
        &self,
        config: &LlmConfig,
        api_key: Option<&str>,
        system: &str,
        user: &str,
        max_tokens: u32,
        temperature: f32,
    ) -> Result<String, SaysoError> {
        let request = ChatRequest {
            model: config.model.clone(),
            messages: vec![
                ChatMessage { role: "system".into(), content: system.into() },
                ChatMessage { role: "user".into(), content: user.into() },
            ],
            max_tokens,
            temperature,
        };

        let mut req = self
            .client
            .post(&config.endpoint)
            .header("Accept", "application/json")
            .json(&request);

        if let Some(key) = api_key {
            // Never log the key value
            req = req.bearer_auth(key);
        }

        let resp = req.send().await.map_err(|e| {
            if e.is_timeout() {
                SaysoError::LlmTimeout
            } else {
                SaysoError::Other(format!("LLM request failed: {}", e))
            }
        })?;

        let status = resp.status().as_u16();
        if !resp.status().is_success() {
            warn!("LLM API returned {}", status);
            return Err(SaysoError::LlmApiError(status));
        }

        let body: ChatResponse = resp.json().await.map_err(|e| {
            warn!("LLM response parse error: {}", e);
            SaysoError::LlmMalformedResponse
        })?;

        let content = body
            .choices
            .into_iter()
            .next()
            .map(|c| c.message.content.trim().to_string())
            .unwrap_or_default();

        if content.is_empty() {
            warn!("LLM returned empty content");
            return Err(SaysoError::LlmMalformedResponse);
        }

        info!("LLM responded: {} chars", content.len());
        debug!("LLM response: {:?}", &content.chars().take(200).collect::<String>());
        Ok(content)
    }

    /// Minimal connectivity test: send a ping message.
    /// Returns Ok(()) if the API responds with any valid completion.
    pub async fn test_connection(
        &self,
        config: &LlmConfig,
        api_key: Option<&str>,
    ) -> Result<(), SaysoError> {
        self.chat(config, api_key, "You are a test.", "ping", 5, 0.0).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn test_llm_timeout_returns_error() {
        let client = Client::builder()
            .timeout(Duration::from_millis(10))
            .build()
            .unwrap();
        let llm = LlmClient { client };
        let cfg = LlmConfig {
            endpoint: "http://10.255.255.1/v1/chat/completions".to_string(),
            model: "gpt-4o-mini".to_string(),
        };
        let result = llm.chat(&cfg, None, "test", "test", 5, 0.0).await;
        assert!(matches!(result, Err(SaysoError::LlmTimeout)));
    }
}
