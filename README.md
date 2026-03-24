# Sayso

> Your voice has the say-so. Speak, and it happens.

An open-source, free alternative to Typeless. Voice keyboard + voice command executor for macOS, Windows, iOS, and Android.

## Features

- **Voice to Text** — Hold a hotkey, speak, release. Text is injected into any app instantly.
- **Auto-send mode** — A second hotkey that types your text *and* presses Enter automatically.
- **Command mode** — A third hotkey to speak system commands. Sayso interprets your intent and executes shell commands.
- **Dialect support** — Better recognition for regional accents and dialects (including Chinese dialects).
- **100% free & open source** — No subscription. No account. Your voice data stays yours.
- **Multi-platform** — macOS, Windows, iOS, Android.

## Hotkeys (default)

| Hotkey | Action |
|--------|--------|
| `⌥ Space` | Record → Type |
| `⌥ Enter` | Record → Type → Send (auto Enter) |
| `⌥ .` | Record → Command mode (execute shell) |

## STT Engine

Supports OpenAI Whisper API out of the box. Local Whisper (via whisper.cpp) coming soon.

## Status

🚧 Early development

## Quick Start

1. **Download** the latest release from [GitHub Releases](../../releases)
2. **Install** the app (macOS: drag to Applications, Windows: run installer)
3. **Configure** STT and LLM API keys on first launch
4. **Use** the hotkeys to start voice input

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup.

## Documentation

- [DESIGN.md](DESIGN.md) — UI/UX design system
- [ARCHITECTURE.md](ARCHITECTURE.md) — Technical architecture
- [CONTRIBUTING.md](CONTRIBUTING.md) — Development guide
- [SECURITY.md](SECURITY.md) — Security policy
- [CHANGELOG.md](CHANGELOG.md) — Version history
- [TODOS.md](TODOS.md) — Roadmap and known issues

## Requirements

- **macOS**: 11.0+ (Big Sur or later)
- **Windows**: Windows 10 1809+ or Windows 11
- **API Keys**: OpenAI or compatible STT/LLM API

## License

[MIT](LICENSE)
