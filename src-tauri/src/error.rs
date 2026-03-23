use thiserror::Error;

#[derive(Debug, Error)]
pub enum SaysoError {
    // Audio errors
    #[error("Audio device not found")]
    AudioDeviceNotFound,
    #[error("Audio recording failed: {0}")]
    AudioRecordingFailed(String),
    #[error("Recording too short (< 0.3s)")]
    RecordingTooShort,

    // STT errors
    #[error("Connection timeout — please check your network")]
    SttTimeout,
    #[error("Recognition failed ({0})")]
    SttApiError(u16),
    #[error("No speech detected")]
    SttNoSpeech,
    #[error("Response parse error (malformed response)")]
    SttMalformedResponse,

    // Text injection errors
    #[error("Injection failed: focus changed")]
    InjectorFocusLost,
    #[error("Injection failed: {0}")]
    InjectorFailed(String),

    // LLM errors
    #[error("LLM timeout — request took too long")]
    LlmTimeout,
    #[error("LLM API error ({0})")]
    LlmApiError(u16),
    #[error("LLM response malformed")]
    LlmMalformedResponse,

    // Command mode errors
    #[error("Rejected: {0}")]
    CommandRejected(String),
    #[error("Rejected: safety check unavailable")]
    SafetyCheckUnavailable,
    #[error("Command execution timed out (30s)")]
    ExecutorTimeout,
    #[error("Command execution failed: {0}")]
    ExecutorFailed(String),
    #[error("Rejected: command requires interactive terminal")]
    InteractiveCommandRejected,

    // Config errors
    #[error("Configuration not found")]
    ConfigNotFound,
    #[error("Keychain error: {0}")]
    KeychainError(String),

    // Generic
    #[error("{0}")]
    Other(String),
}

impl From<anyhow::Error> for SaysoError {
    fn from(e: anyhow::Error) -> Self {
        SaysoError::Other(e.to_string())
    }
}

impl serde::Serialize for SaysoError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
