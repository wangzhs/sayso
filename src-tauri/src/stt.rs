/// STT (Speech-to-Text) client.
///
/// - Uses OpenAI-compatible /audio/transcriptions endpoint
/// - 120-second timeout (2× max recording length of 60s, to account for upload + transcription)
/// - Sends WAV audio as multipart form data
/// - Error handling per spec:
///   - Network timeout (>120s) → SttTimeout
///   - Non-200 response → SttApiError(status)
///   - Empty result → SttNoSpeech (caller skips silently)
///   - Malformed JSON → SttMalformedResponse
use reqwest::{Client, multipart};
use serde::Deserialize;
use std::time::Duration;
use log::{debug, info, warn};

use crate::config::SttConfig;
use crate::error::SaysoError;

const STT_TIMEOUT_SECS: u64 = 120; // 2× max recording length; must be large enough for upload + transcription

#[derive(Deserialize, Debug)]
struct TranscriptionResponse {
    text: String,
}

/// Shared HTTP client — created once and reused (see TODOS.md note 12).
pub struct SttClient {
    client: Client,
}

impl SttClient {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(STT_TIMEOUT_SECS))
            .build()
            .expect("Failed to build HTTP client");
        Self { client }
    }

    /// Transcribe WAV bytes. Returns the transcribed text (trimmed).
    /// Returns `None` (caller should silent-skip) if the result is empty.
    pub async fn transcribe(
        &self,
        wav_bytes: Vec<u8>,
        config: &SttConfig,
        api_key: Option<&str>,
    ) -> Result<Option<String>, SaysoError> {
        let part = multipart::Part::bytes(wav_bytes)
            .file_name("audio.wav")
            .mime_str("audio/wav")
            .map_err(|e| SaysoError::Other(e.to_string()))?;

        let form = multipart::Form::new()
            .part("file", part)
            .text("model", config.model.clone());

        let mut req = self
            .client
            .post(&config.endpoint)
            .header("Accept", "application/json");

        if let Some(key) = api_key {
            // Never log the key value
            req = req.bearer_auth(key);
        }

        let resp = req
            .multipart(form)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    SaysoError::SttTimeout
                } else {
                    SaysoError::Other(format!("STT request failed: {}", e))
                }
            })?;

        let status = resp.status().as_u16();
        if !resp.status().is_success() {
            warn!("STT API returned {}", status);
            return Err(SaysoError::SttApiError(status));
        }

        let body: TranscriptionResponse = resp.json().await.map_err(|e| {
            warn!("STT response parse error: {}", e);
            SaysoError::SttMalformedResponse
        })?;

        let text = body.text.trim().to_string();
        if text.is_empty() {
            info!("STT returned empty text — silent skip");
            return Ok(None);
        }

        info!("STT transcribed {} chars", text.len());
        debug!("STT result: {:?}", text);
        Ok(Some(text))
    }

    /// Test connection with a minimal WAV (0.3s silence).
    /// Returns Ok(()) if the API is reachable, even if it returns an empty transcription.
    pub async fn test_connection(
        &self,
        config: &SttConfig,
        api_key: Option<&str>,
    ) -> Result<(), SaysoError> {
        // 0.3s of silence at 16kHz (minimal valid WAV)
        let silence_samples = vec![0i16; 4800];
        let wav = crate::audio::encode_wav_pub(&silence_samples, 16000)
            .map_err(|e| SaysoError::Other(e.to_string()))?;

        match self.transcribe(wav, config, api_key).await {
            Ok(_) => Ok(()),
            Err(SaysoError::SttNoSpeech) => Ok(()), // empty result = API is working
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_stt_timeout_returns_error() {
        // Use a non-routable address to simulate timeout
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(10))
            .build()
            .unwrap();
        let stt = SttClient { client };
        let cfg = crate::config::SttConfig {
            endpoint: "http://10.255.255.1/audio/transcriptions".to_string(),
            model: "whisper-1".to_string(),
        };
        let result = stt.transcribe(vec![0u8; 100], &cfg, None).await;
        assert!(matches!(result, Err(SaysoError::SttTimeout)));
    }
}
