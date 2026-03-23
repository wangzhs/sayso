# Changelog

## [0.1.0] - 2026-03-23

### Features

**Phase 1 — Rust backend**
- 5-state FSM (`IDLE → RECORDING → STT_WAITING → INJECTING → DONE + ERROR`)
- Audio capture via `cpal` with WAV encoding and resampling to 16 kHz
- OpenAI-compatible STT HTTP client (`/audio/transcriptions`) with 30 s timeout
- Text injection via `enigo` with CGEvent fallback on macOS
- Two-layer command safety filter: rule-based O(1) pass + LLM semantic layer (fail-closed)
- Persistent stats (`~/Library/Application Support/com.sayso.app/stats.json`)
- System keychain storage for API keys (never logged, never written to disk)

**Phase 2 — CommandEngine (Mode C)**
- Shared LLM HTTP client (`reqwest`, OpenAI-compatible, 15 s timeout)
- Intent parser: natural language → `{"command", "description"}` JSON via LLM
- Direct shell executor: `std::process::Command` (no `/bin/sh`, no injection vectors), 30 s timeout
- Optional text polisher for Modes A/B (`voice.polish_enabled`), falls back to raw text with toast
- Full Mode C pipeline: rule filter → LLM gray-zone safety → intent parse → second rule pass → execute

**Phase 3 — Settings UI (React/TypeScript)**
- 3-page app: Onboarding wizard (3 steps), Preferences, Statistics
- Onboarding: STT endpoint + API key → LLM endpoint + API key → mode selection
- Preferences: tabbed (STT / LLM / Voice / Hotkeys), "Test Connection" for both APIs
- Statistics: 4 stat cards (characters, words, time saved, commands), Export CSV, Reset
- Design system: `Digital Obsidian` — dark-only, `#EF4444` accent, Space Grotesk + DM Sans

**Phase 4 — Packaging & CI**
- GitHub Actions workflow: builds macOS universal `.dmg` (arm64 + x86_64) and Windows `.exe` on every tag push
- PR builds for CI verification
- macOS entitlements (`com.apple.security.device.audio-input`, `com.apple.security.network.client`)
- `NSMicrophoneUsageDescription` in `Info.plist` for Gatekeeper permission dialog

### Design Rationale

- **Direct execution model (no shell)** prevents CVE-2024-24576-class command injection. Trade-off: no pipes/redirections. Acceptable for v1 voice commands.
- **Fail-closed safety** on LLM gray zone: if the LLM is unreachable, the command is rejected rather than passing through. Security > convenience.
- **Unsigned builds for v0.1.0**: code signing requires Apple Developer Program ($99/yr) and a Windows EV certificate. Users can bypass Gatekeeper / SmartScreen. Signing can be added by setting the `APPLE_*` / `TAURI_SIGNING_*` GitHub secrets documented in the workflow file.

### Notes & Caveats

- **Accessibility permission** (for text injection on macOS) is requested at runtime — macOS will show a system dialog the first time a keystroke is injected. This is normal behavior for typing tools.
- **Windows builds** produce an NSIS `.exe` installer. WebView2 is auto-downloaded on Windows machines that don't already have it.
- **`cargo test`** runs 33 unit tests covering FSM, safety filter, LLM client, intent parser, executor, polisher, STT client, audio encoding, and stats.
