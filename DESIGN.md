# Design System — Sayso

## Product Context

- **What this is:** Open-source voice keyboard + command executor for macOS and Windows. Hold a hotkey, speak, release — text is injected into any app, or a shell command is executed.
- **Who it's for:** Developers and power users who want hands-free text input and voice-driven shell control. No subscription, no account, fully self-hostable.
- **Space/industry:** Developer tools / system utilities. Peers: Warp Terminal, Redis Insight, VS Code (dark theme), Raycast.
- **Project type:** Desktop app (Tauri v2 + React). Settings window + system tray + floating OS-level toasts.

---

## Aesthetic Direction

- **Direction:** Industrial / Utilitarian Dark
- **Decoration level:** Minimal — color tones do all hierarchy work; no borders, no gradients, no textures
- **Mood:** Cold and focused. This is a precision tool that stays out of your way. It should feel like the inside of a terminal, not a SaaS dashboard. When it's recording, the red accent is the only thing that demands attention.
- **Reference products:** Warp Terminal, Redis Insight, Linear (dark mode), Obsidian

---

## Color

- **Approach:** Restrained — one accent, neutrals only, color is rare and meaningful

| Role | Hex | Usage |
|------|-----|-------|
| Background | `#161616` | Main window background |
| Surface | `#1C1C1C` | Sidebar, panels, secondary sections |
| Card | `#222222` | Cards, input fields, dropdowns |
| Card Hover | `#272727` | Hover state on interactive cards |
| Accent | `#EF4444` | Recording state, primary buttons, active nav item, progress bars |
| Accent Hover | `#DC2626` | Hover/pressed state on accent elements |
| Text Primary | `#F9FAFB` | Main body text, headings |
| Text Secondary | `#9CA3AF` | Labels, descriptions, placeholders |
| Text Tertiary | `#4B5563` | Disabled text, timestamps, meta |
| Success | `#22C55E` | Successful injection, safe commands |
| Warning | `#F59E0B` | Gray-zone commands, clipboard fallback notice |
| Error | `#EF4444` | Errors, dangerous command rejection (shared with accent) |
| Info | `#3B82F6` | Neutral informational toasts |

**Dark mode strategy:** This app is dark-only — no light mode. All surfaces use tonal elevation (each layer ~6 hex values lighter), never borders. Pure near-black (`#161616`), not deep blue-gray.

---

## Typography

- **Display/Headings:** [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk) — geometric grotesque with slight technical character; large numerics (statistics, counters) look excellent at display sizes
- **Body/UI:** [DM Sans](https://fonts.google.com/specimen/DM+Sans) — clean geometric sans with more personality than Inter; small labels stay crisp
- **UI/Labels:** DM Sans (same as body)
- **Data/Tables:** DM Sans with `font-variant-numeric: tabular-nums` — aligned columns for statistics dashboard
- **Code/Monospace:** [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) — command output, shell previews, API endpoint fields
- **Loading:** Google Fonts CDN via `<link rel="preconnect">` + `font-display: swap`

### Type Scale

| Role | Size | Weight | Line-height |
|------|------|--------|-------------|
| Hero/Display | 32px / 2rem | 700 | 1.15 |
| H1 | 24px / 1.5rem | 600 | 1.2 |
| H2 | 18px / 1.125rem | 600 | 1.25 |
| H3 | 14px / 0.875rem | 600 | 1.3 |
| Body | 14px / 0.875rem | 400 | 1.5 |
| Label/Caption | 12px / 0.75rem | 500 | 1.4 |
| Mono | 13px / 0.8125rem | 400 | 1.6 |

---

## Spacing

- **Base unit:** 8px
- **Density:** Compact — this is a utility window, not a marketing page
- **Scale:** 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64px

### Application

- Section padding: 24px
- Card internal padding: 16px
- Form label → input gap: 8px
- List item height: 40px (touch-friendly even on desktop)
- Sidebar item padding: 8px 12px

---

## Layout

- **Approach:** Grid-disciplined — strict columns, predictable alignment
- **Window:** Fixed 800px minimum width, 600px minimum height (per design spec)
- **Sidebar:** 240px fixed width, full height
- **Main content:** Fluid, fills remaining space
- **Grid:** 12-column for main content area, 16px gutters

### Border Radius

| Size | Value | Usage |
|------|-------|-------|
| sm | 4px | Input fields, small tags, badges |
| md | 6px | Cards, dropdowns, list items |
| lg | 12px | Modal dialogs, large panels |
| full | 9999px | Toggle switches, pills, avatars |

---

## Motion

- **Approach:** Minimal-functional — every animation communicates something; no decoration
- **Easing:** enter `ease-out` / exit `ease-in` / move `ease-in-out`

| Duration | Value | Usage |
|----------|-------|-------|
| Micro | 50-100ms | Hover state color transitions |
| Short | 150-200ms | State changes (button press, toggle flip) |
| Medium | 250-350ms | Panel slide, dropdown open |
| Long | 400-600ms | Modal entrance, page transition |

### Key Animations

- **Recording pulse:** Microphone icon scale 1→1.1→1 + red glow, `ease-in-out` 1s loop — the only "alive" animation in the app
- **Transcribing spinner:** 200ms rotation, `linear` — signals processing
- **Toast entrance:** `translateY(8px)→0` + `opacity 0→1`, 200ms `ease-out`; exit: reverse 150ms
- **Focus ring:** `box-shadow` spread 0→3px, 100ms — keyboard navigation always visible

### Reduced Motion

All animations respect `prefers-reduced-motion: reduce`. Recording state falls back to a static red ring.

---

## Component Conventions

### Toast Notifications (floating OS-level)

- Position: bottom-right, 16px from screen edge
- Max width: 360px
- Stack: newest on top, max 3 visible
- Auto-dismiss: success 3s, info 3s, warning 5s, error 5s (never auto-dismiss)
- Colors by type:
  - **Success (green):** `background: #14532D20`, `border-left: 3px solid #22C55E`
  - **Warning (orange):** `background: #78350F20`, `border-left: 3px solid #F59E0B`
  - **Error/Reject (red):** `background: #7F1D1D20`, `border-left: 3px solid #EF4444`
  - **Info (blue):** `background: #1E3A5F20`, `border-left: 3px solid #3B82F6`

### Navigation (sidebar)

- Active item: `background: #EF444415`, `color: #EF4444`, no left border
- Hover: `background: #FFFFFF08`
- Icons: 16px, stroke-based (Lucide or Heroicons)

### Inputs & Forms

- Background: `#222222`, border: none (tonal), focus: `box-shadow: 0 0 0 2px #EF444440`
- Placeholder: `#4B5563`
- Disabled: `opacity: 0.4`, `cursor: not-allowed`

### Buttons

- Primary: `background: #EF4444`, `color: white`, hover `#DC2626`
- Secondary/Ghost: `background: transparent`, `border: 1px solid #333`, hover `background: #FFFFFF08`
- Destructive: same as primary (red is already the danger signal)
- All: `min-height: 36px`, `padding: 0 16px`, `border-radius: 6px`

---

## Accessibility

- All interactive elements: `min 44×44px` touch target (even on desktop — future mobile port)
- Focus: `focus-visible` ring always present, `outline: none` never used without replacement
- Color contrast: text primary on card → 12.5:1 ✓; text secondary on card → 4.8:1 ✓ (AA)
- No color-only encoding: icons + labels always accompany color-coded states
- `prefers-reduced-motion` respected throughout

---

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-23 | Pure near-black `#161616`, not deep blue-gray | Most dev tools use #1E2A3A; Sayso's colder, more focused character calls for pure dark |
| 2026-03-23 | DM Sans over Inter | Inter is ubiquitous in AI tools; DM Sans has stronger character at small label sizes |
| 2026-03-23 | `#EF4444` red accent (shared for both accent and error) | Recording state and danger commands share the same red — intentional: voice commands that could be dangerous use the same color as the recording indicator |
| 2026-03-23 | No light mode in v1 | Desktop utility running in background; dark mode is the expected context for dev tools |
| 2026-03-23 | Tonal layering (no visible borders) | Borders add visual noise in dense utility UIs; 6-hex-step elevation between layers is sufficient |
| 2026-03-23 | Minimal motion, recording pulse is the only "alive" animation | Everything staying still makes the pulsing red mic more noticeable when active |
