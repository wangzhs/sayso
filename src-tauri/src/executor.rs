/// Shell executor for Mode C commands.
///
/// v1 execution model (TODO-4 decision): direct execution only.
/// - No shell (no /bin/sh -c). Parses quoted args with shell-words and exec()s the binary.
/// - Working directory: $HOME (TODOS.md #8)
/// - Timeout: 30 seconds (TODOS.md #3); child process is killed when timeout fires
/// - Captures stdout + stderr. Returns structured result.
/// - PATH is augmented with Homebrew/developer tool locations so commands found
///   in an interactive terminal also work from a Finder-launched app.
///
/// Direct execution prevents shell injection (CVE-2024-24576 class).
/// Tradeoff: no pipes, no redirections, no shell expansions. Acceptable for v1.
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;
use log::{info, warn};
use shell_words;

use crate::error::SaysoError;

const EXEC_TIMEOUT_SECS: u64 = 30;
const MAX_OUTPUT_CHARS: usize = 500;

/// Augmented PATH for Finder-launched apps.
///
/// macOS apps launched from Finder/dock inherit a minimal PATH that misses
/// Homebrew, nvm, pyenv, rbenv, etc. We prepend the most common locations so
/// developer-oriented voice commands actually resolve.
#[cfg(target_os = "macos")]
const EXTRA_PATH: &str =
    "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:\
     /usr/bin:/bin:/usr/sbin:/sbin";

#[cfg(not(target_os = "macos"))]
const EXTRA_PATH: &str = "";

/// Result of a shell command execution.
#[derive(Debug)]
pub struct ExecutionResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub success: bool,
}

impl ExecutionResult {
    /// A short summary suitable for toast display.
    pub fn summary(&self) -> String {
        if self.success {
            if self.stdout.is_empty() {
                "Done".into()
            } else {
                self.stdout.chars().take(MAX_OUTPUT_CHARS).collect()
            }
        } else {
            let err = if !self.stderr.is_empty() {
                self.stderr.chars().take(MAX_OUTPUT_CHARS).collect()
            } else {
                format!("exit code {}", self.exit_code)
            };
            err
        }
    }
}

/// Execute a command string using direct execution (no shell).
///
/// Arguments are parsed with shell-words so quoted paths and args work correctly
/// (e.g. `open "/Applications/Visual Studio Code.app"`). Pipes, redirections,
/// and shell expansions are NOT supported — by design.
///
/// When the timeout fires, the child process is killed (SIGKILL on Unix, TerminateProcess
/// on Windows) before the error is returned, so no orphan processes are left behind.
pub async fn execute_command(command: &str) -> Result<ExecutionResult, SaysoError> {
    let parts = shell_words::split(command)
        .map_err(|e| SaysoError::ExecutorFailed(format!("command parse error: {}", e)))?;

    if parts.is_empty() {
        return Err(SaysoError::ExecutorFailed("empty command".into()));
    }

    let program = parts[0].clone();
    let args: Vec<String> = parts[1..].to_vec();
    let work_dir = std::env::var("HOME").unwrap_or_else(|_| {
        warn!("HOME not set; using /tmp as working directory");
        "/tmp".into()
    });

    // Build augmented PATH: prepend developer tool locations that Finder-launched
    // apps don't inherit from the user's shell.
    let current_path = std::env::var("PATH").unwrap_or_default();
    let augmented_path = if EXTRA_PATH.is_empty() || current_path.contains("/opt/homebrew/bin") {
        current_path
    } else {
        format!("{}:{}", EXTRA_PATH, current_path)
    };

    info!("Executing: {:?} {:?} in {:?}", program, args, work_dir);

    // Spawn with tokio::process::Command for native async + kill-on-drop.
    // The Child is wrapped in timeout; when the timeout fires, the Child is
    // dropped and tokio kills the OS process automatically (kill_on_drop = true).
    let child = Command::new(&program)
        .args(&args)
        .current_dir(&work_dir)
        .env("PATH", &augmented_path)
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| SaysoError::ExecutorFailed(format!("process error: {}", e)))?;

    let result = timeout(
        Duration::from_secs(EXEC_TIMEOUT_SECS),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| {
        warn!("Command timed out after {}s: {:?}", EXEC_TIMEOUT_SECS, command);
        SaysoError::ExecutorTimeout
    })?
    .map_err(|e| SaysoError::ExecutorFailed(format!("process error: {}", e)))?;

    let stdout = String::from_utf8_lossy(&result.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
    let exit_code = result.status.code().unwrap_or(-1);
    let success = result.status.success();

    if success {
        info!("Command succeeded: {} chars stdout", stdout.len());
    } else {
        warn!("Command failed (exit {}): {:?}", exit_code, &stderr.chars().take(100).collect::<String>());
    }

    Ok(ExecutionResult { stdout, stderr, exit_code, success })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_execute_echo() {
        let result = execute_command("echo hello").await.unwrap();
        assert!(result.success);
        assert_eq!(result.stdout, "hello");
    }

    #[tokio::test]
    async fn test_execute_quoted_args() {
        // shell-words should handle quoted multi-word args correctly
        let result = execute_command("echo \"hello world\"").await.unwrap();
        assert!(result.success);
        assert_eq!(result.stdout, "hello world");
    }

    #[tokio::test]
    async fn test_execute_nonexistent_binary() {
        let result = execute_command("this_binary_does_not_exist_sayso_test").await;
        // Should return an error (process spawn fails)
        assert!(result.is_err() || !result.unwrap().success);
    }

    #[tokio::test]
    async fn test_execute_empty_command() {
        let result = execute_command("").await;
        assert!(result.is_err());
    }

    #[test]
    fn test_execution_result_summary_success() {
        let r = ExecutionResult {
            stdout: "hello world".into(),
            stderr: "".into(),
            exit_code: 0,
            success: true,
        };
        assert_eq!(r.summary(), "hello world");
    }

    #[test]
    fn test_execution_result_summary_empty_success() {
        let r = ExecutionResult {
            stdout: "".into(),
            stderr: "".into(),
            exit_code: 0,
            success: true,
        };
        assert_eq!(r.summary(), "Done");
    }

    #[test]
    fn test_execution_result_summary_failure() {
        let r = ExecutionResult {
            stdout: "".into(),
            stderr: "permission denied".into(),
            exit_code: 1,
            success: false,
        };
        assert!(r.summary().contains("permission denied"));
    }
}
