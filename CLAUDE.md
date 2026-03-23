# CLAUDE.md — Sayso

## Project

Sayso is a Tauri v2 (Rust + React) desktop app for macOS and Windows. It's a voice keyboard + command executor: hold a hotkey, speak, release — text is injected or a shell command is executed.

## Tech Stack

- **Backend:** Rust (Tauri v2)
- **Frontend:** React + TypeScript
- **Audio:** cpal (Rust crate)
- **Text injection:** enigo (Rust crate) + CGEvent fallback
- **STT:** OpenAI-compatible HTTP API (user-configured)
- **LLM:** OpenAI-compatible HTTP API (user-configured, for command mode)

## Implementation Notes

See `TODOS.md` for outstanding decisions and deferred items.

Key implementation constraints from design spec:
- Tauri v2 only (not v1)
- 5-state FSM: IDLE → RECORDING → STT_WAITING → INJECTING → DONE + ERROR
- No clipboard restore after fallback injection
- API keys stored in system Keychain (never logged)
- Log path: `~/Library/Logs/sayso/sayso.log` (macOS)

## Design System

Always read `DESIGN.md` before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.

Key reminders:
- Dark mode only (`#161616` background — not a blue-gray, a true near-black)
- Accent: `#EF4444` for recording state, active elements, and primary CTAs
- Typography: Space Grotesk (headings) + DM Sans (body/UI) + JetBrains Mono (code)
- No visible borders — use tonal layering (each surface ~6 hex lighter)
- Compact spacing (8px base)
- In QA mode, flag any code that doesn't match DESIGN.md

## Testing

- Unit tests: 80%+ coverage target
- Key test cases: FSM state machine, SafetyFilter (`rm -rf ~` must be blocked), STT timeout handling, clipboard injection
- See `TODOS.md` for test strategy details
