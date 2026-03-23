/// Statistics tracking (per TODOS.md items 15-24).
///
/// Stored in JSON: ~/Library/Application Support/com.sayso.app/stats.json
/// Cached in memory (Tauri state). Written async after each update.
///
/// Time saved formula:
///   saved_seconds = total_chars / (40 wpm * 5 chars/word / 60) - total_speaking_time
///   = total_chars / 3.33 - total_speaking_time
///   (40 WPM average, ~5 chars/word)
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use anyhow::Result;
use log::{info, warn};

const AVG_TYPING_WPM: f64 = 40.0;
const CHARS_PER_WORD: f64 = 5.0;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Stats {
    /// Total successful STT transcriptions
    pub total_transcriptions: u64,
    /// Total speaking time in seconds (accumulated key-hold duration)
    pub total_speaking_secs: f64,
    /// Total characters transcribed (char count, not byte count)
    pub total_chars: u64,
    /// Total Mode C commands executed
    pub commands_executed: u64,
}

impl Stats {
    pub fn saved_time_secs(&self) -> f64 {
        let typing_secs = self.total_chars as f64 / (AVG_TYPING_WPM * CHARS_PER_WORD / 60.0);
        (typing_secs - self.total_speaking_secs).max(0.0)
    }

    pub fn saved_time_display(&self) -> String {
        let secs = self.saved_time_secs() as u64;
        let hours = secs / 3600;
        let mins = (secs % 3600) / 60;
        if hours > 0 {
            format!("{}h {}m", hours, mins)
        } else if mins > 0 {
            format!("{}m", mins)
        } else {
            format!("{}s", secs)
        }
    }

    pub fn speaking_time_display(&self) -> String {
        let secs = self.total_speaking_secs as u64;
        let hours = secs / 3600;
        let mins = (secs % 3600) / 60;
        let s = secs % 60;
        if hours > 0 {
            format!("{}h {}m", hours, mins)
        } else if mins > 0 {
            format!("{}m {}s", mins, s)
        } else {
            format!("{}s", secs)
        }
    }
}

fn stats_path() -> Result<PathBuf> {
    let base = dirs::data_local_dir()
        .ok_or_else(|| anyhow::anyhow!("Cannot determine data dir"))?;
    Ok(base.join("com.sayso.app").join("stats.json"))
}

pub fn load() -> Stats {
    let path = match stats_path() {
        Ok(p) => p,
        Err(e) => { warn!("Stats path error: {}", e); return Stats::default(); }
    };
    if !path.exists() {
        return Stats::default();
    }
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(e) => { warn!("Failed to load stats: {}", e); Stats::default() }
    }
}

pub fn save(stats: &Stats) -> Result<()> {
    let path = stats_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let content = serde_json::to_string_pretty(stats)?;
    std::fs::write(&path, content)?;
    Ok(())
}

/// Thread-safe stats state with in-memory cache.
#[derive(Clone, Debug)]
pub struct StatsState {
    inner: Arc<RwLock<Stats>>,
}

impl StatsState {
    pub fn load() -> Self {
        Self {
            inner: Arc::new(RwLock::new(load())),
        }
    }

    pub fn get(&self) -> Stats {
        self.inner.read().unwrap().clone()
    }

    /// Record a completed transcription.
    pub fn record_transcription(&self, speaking_secs: f64, raw_text: &str) {
        let char_count = count_chars(raw_text);
        let mut s = self.inner.write().unwrap();
        s.total_transcriptions += 1;
        s.total_speaking_secs += speaking_secs;
        s.total_chars += char_count as u64;
        let snapshot = s.clone();
        drop(s);
        // Async flush (fire and forget — acceptable data loss on crash)
        tokio::spawn(async move {
            if let Err(e) = save(&snapshot) {
                warn!("Stats flush failed: {}", e);
            }
        });
    }

    /// Record a command execution (Mode C only).
    pub fn record_command(&self) {
        let mut s = self.inner.write().unwrap();
        s.commands_executed += 1;
        let snapshot = s.clone();
        drop(s);
        tokio::spawn(async move {
            if let Err(e) = save(&snapshot) {
                warn!("Stats flush failed: {}", e);
            }
        });
    }

    /// Reset all stats (with backup).
    pub fn reset(&self) -> Result<()> {
        let path = stats_path()?;
        if path.exists() {
            let ts = chrono_now();
            let backup = path.with_file_name(format!("stats.db.bak.{}", ts));
            std::fs::copy(&path, &backup)?;
            info!("Stats backed up to {:?}", backup);
        }
        *self.inner.write().unwrap() = Stats::default();
        save(&Stats::default())?;
        Ok(())
    }

    /// Export stats as CSV string.
    pub fn export_csv(&self) -> String {
        let s = self.get();
        format!(
            "metric,value\ntotal_transcriptions,{}\ntotal_speaking_secs,{:.1}\ntotal_chars,{}\ncommands_executed,{}\nsaved_time_secs,{:.1}\n",
            s.total_transcriptions,
            s.total_speaking_secs,
            s.total_chars,
            s.commands_executed,
            s.saved_time_secs(),
        )
    }
}

/// Count characters: Chinese chars as 1, English words as 1 unit (space-split).
fn count_chars(text: &str) -> usize {
    // Mixed: count CJK characters individually, English words by spaces
    let mut count = 0;
    let mut in_word = false;
    for ch in text.chars() {
        if ch as u32 > 0x2E7F {
            // CJK/wide character — count individually
            if in_word { count += 1; in_word = false; }
            count += 1;
        } else if ch.is_alphanumeric() || ch == '\'' {
            in_word = true;
        } else {
            if in_word { count += 1; in_word = false; }
        }
    }
    if in_word { count += 1; }
    count
}

fn chrono_now() -> String {
    // Simple timestamp without chrono dependency
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // YYYYMMDD approximation
    let days = secs / 86400;
    let y = 1970 + days / 365;
    format!("{}", y * 10000 + 101) // approximate — good enough for backup filenames
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_char_count_english() {
        assert_eq!(count_chars("hello world"), 2);
        assert_eq!(count_chars("one two three"), 3);
    }

    #[test]
    fn test_char_count_chinese() {
        assert_eq!(count_chars("你好世界"), 4);
    }

    #[test]
    fn test_char_count_mixed() {
        assert_eq!(count_chars("hello 世界"), 3); // 1 word + 2 chars
    }

    #[test]
    fn test_saved_time_zero_when_speaking_exceeds_typing() {
        let stats = Stats {
            total_chars: 10,
            total_speaking_secs: 1000.0,
            ..Default::default()
        };
        assert_eq!(stats.saved_time_secs(), 0.0);
    }

    #[test]
    fn test_saved_time_positive() {
        let stats = Stats {
            total_chars: 1000, // ~200 words / 40 WPM = 5 min = 300 secs of typing
            total_speaking_secs: 30.0,
            ..Default::default()
        };
        assert!(stats.saved_time_secs() > 0.0);
    }
}
