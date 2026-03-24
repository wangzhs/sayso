import React, { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ─── Types ───────────────────────────────────────────────────────────────────

type Page = "onboarding" | "preferences" | "statistics";
type UiLanguage = "en" | "zh-CN";
type VoiceInputVariant = "auto" | "mandarin" | "sichuanese" | "shanghainese" | "henanese" | "guangshan";
type VoiceOutputTextStyle = "standard_mandarin" | "spoken_style";

interface SttConfig  { endpoint: string; model: string; }
interface LlmConfig  { endpoint: string; model: string; }
interface HotkeyConfig { mode_a: string; mode_b: string; mode_c: string; }
interface VoiceConfig  {
  polish_enabled: boolean;
  dialect_support_enabled: boolean;
  input_variant: VoiceInputVariant;
  output_text_style: VoiceOutputTextStyle;
}

interface AppConfig {
  stt: SttConfig | null;
  stt_key: string;
  llm: LlmConfig | null;
  llm_key: string;
  hotkeys: HotkeyConfig;
  voice: VoiceConfig;
  show_in_menu_bar: boolean;
  ui_language: UiLanguage;
  first_run: boolean;
}

interface Stats {
  total_transcriptions: number;
  total_speaking_secs: number;
  total_chars: number;
  commands_executed: number;
}

interface ToastPayload {
  level: "info" | "warning" | "error" | "success";
  message: string;
  durationMs?: number | null;
}
interface Toast extends ToastPayload { id: number; }
interface HudPayload extends ToastPayload {}

const TOAST_DURATIONS: Record<ToastPayload["level"], number | null> = {
  success: 3000, info: 4000, warning: 5000, error: null,
};

// ─── Design tokens (mirrors index.css) ────────────────────────────────────────

const C = {
  bg:           "#161616",
  sidebar:      "#1C1C1C",
  surface:      "#222222",
  surfaceLow:   "#1C1C1C",
  surfaceHigh:  "#272727",
  surfaceHighest:"#333333",
  surfaceLowest:"#111111",
  surfaceBright:"#333333",
  primary:      "#EF4444",
  primaryCont:  "#EF4444",
  onPrimaryCont:"#FFFFFF",
  tertiary:     "#3B82F6",
  tertiaryCont: "#3B82F6",
  text:         "#F9FAFB",
  textVariant:  "#9CA3AF",
  textMuted:    "#4B5563",
  error:        "#EF4444",
  outlineVariant:"#333333",
  success:      "#22C55E",
  warning:      "#F59E0B",
  info:         "#3B82F6",
} as const;

const F = {
  headline: '"Space Grotesk", sans-serif',
  body:     '"DM Sans", sans-serif',
} as const;

const DEFAULT_UI_LANGUAGE: UiLanguage = "en";
const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const IS_OVERLAY_WINDOW =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).get("overlay") === "1";
const VERIFIED_STT_KEY = "sayso:stt-verified";
const VERIFIED_LLM_KEY = "sayso:llm-verified";
const CONFIG_UPDATED_EVENT = "sayso-config-updated";

const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  polish_enabled: false,
  dialect_support_enabled: true,
  input_variant: "auto",
  output_text_style: "standard_mandarin",
};

function normalizeLanguage(language?: string): UiLanguage {
  return language === "zh-CN" ? "zh-CN" : "en";
}

function tx(language: UiLanguage, en: string, zh: string) {
  return language === "zh-CN" ? zh : en;
}

function formatCount(value: number, language: UiLanguage) {
  return value.toLocaleString(language === "zh-CN" ? "zh-CN" : "en-US");
}

function formatDuration(seconds: number, language: UiLanguage) {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const mins = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;

  if (hours > 0) {
    return language === "zh-CN" ? `${hours}小时 ${mins}分` : `${hours}h ${mins}m`;
  }
  if (mins > 0) {
    return language === "zh-CN" ? `${mins}分 ${secs}秒` : `${mins}m ${secs}s`;
  }
  return language === "zh-CN" ? `${secs}秒` : `${secs}s`;
}

function formatDecimal(value: number, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "0.0";
}

function configFingerprint(endpoint?: string, model?: string) {
  return JSON.stringify({
    endpoint: (endpoint ?? "").trim(),
    model: (model ?? "").trim(),
  });
}

function normalizeConfig(cfg: AppConfig): AppConfig {
  return {
    ...cfg,
    hotkeys: {
      mode_a: cfg.hotkeys.mode_a.replace("Return", "Enter").replace("Alt", IS_MAC ? "Option" : "Alt"),
      mode_b: cfg.hotkeys.mode_b.replace("Return", "Enter").replace("Alt", IS_MAC ? "Option" : "Alt"),
      mode_c: cfg.hotkeys.mode_c.replace("Return", "Enter").replace("Alt", IS_MAC ? "Option" : "Alt"),
    },
    voice: {
      ...DEFAULT_VOICE_CONFIG,
      ...cfg.voice,
    },
    stt_key: cfg.stt_key ?? "",
    llm_key: cfg.llm_key ?? "",
    ui_language: normalizeLanguage(cfg.ui_language),
    show_in_menu_bar: cfg.show_in_menu_bar !== false,
  };
}

function platformDefaultHotkeys(): HotkeyConfig {
  return IS_MAC
    ? { mode_a: "Option+Space", mode_b: "Option+Enter", mode_c: "Option+Period" }
    : { mode_a: "Ctrl+Space", mode_b: "Ctrl+Enter", mode_c: "Ctrl+Period" };
}

function hotkeyPlaceholder(mode: keyof HotkeyConfig): string {
  const defaults = platformDefaultHotkeys();
  return defaults[mode];
}

function isSttConfigured(config: AppConfig): boolean {
  return !!config.stt?.endpoint.trim() && !!config.stt?.model.trim() && !!config.stt_key.trim();
}

function isLlmConfigured(config: AppConfig): boolean {
  return !!config.llm?.endpoint.trim() && !!config.llm?.model.trim() && !!config.llm_key.trim();
}

function isSystemConfigured(config: AppConfig): boolean {
  return isSttConfigured(config);
}

// ─── Primitives ───────────────────────────────────────────────────────────────

function Icon({ name, size = 20, fill = 0, style }: {
  name: string; size?: number; fill?: number; style?: React.CSSProperties;
}) {
  return (
    <span
      className="material-symbols-outlined"
      style={{ fontSize: size, fontVariationSettings: `'FILL' ${fill}`, ...style }}
    >
      {name}
    </span>
  );
}

function SaysoLogo({
  size = 40,
  compact = false,
}: {
  size?: number;
  compact?: boolean;
}) {
  const width = size;
  const height = size;
  const strokeWidth = compact ? 18 : 20;
  const accentStroke = compact ? 16 : 18;

  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 512 512"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="56"
        y="56"
        width="400"
        height="400"
        rx="92"
        fill="#09090B"
      />
      <rect
        x="56"
        y="56"
        width="400"
        height="400"
        rx="92"
        stroke="#27272A"
        strokeWidth="4"
      />
      <path
        d="M256 132C223.968 132 200 155.968 200 188V252C200 284.032 223.968 308 256 308C288.032 308 312 284.032 312 252V188C312 155.968 288.032 132 256 132Z"
        fill="#FAFAFA"
      />
      <path
        d="M256 148C232.982 148 216 164.982 216 188V252C216 275.018 232.982 292 256 292C279.018 292 296 275.018 296 252V188C296 164.982 279.018 148 256 148Z"
        fill="#18181B"
      />
      <path
        d="M230 164H282C289.732 164 296 170.268 296 178V236C296 259 278 279 256 285C231 279 216 259 216 236V178C216 170.268 222.268 164 230 164Z"
        fill={C.primary}
      />
      <path
        d="M170 234C170 282.601 207.399 320 256 320C304.601 320 342 282.601 342 234"
        stroke="#FAFAFA"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <path
        d="M256 320V370"
        stroke="#FAFAFA"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      <path
        d="M215 370H297"
        stroke="#FAFAFA"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
      {!compact && (
        <>
          <path
            d="M326 172H380"
            stroke="#F87171"
            strokeWidth={accentStroke}
            strokeLinecap="round"
          />
          <path
            d="M326 224H398"
            stroke="#F87171"
            strokeWidth={accentStroke}
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      onClick={e => {
        e.stopPropagation();
        onChange(!checked);
      }}
      style={{
        width: 40, height: 20,
        borderRadius: 10,
        background: checked ? C.primaryCont : C.surfaceBright,
        position: "relative", cursor: "pointer",
        transition: "background 150ms",
        flexShrink: 0,
      }}
    >
      <div style={{
        position: "absolute",
        top: 3, left: checked ? "calc(100% - 17px)" : 3,
        width: 14, height: 14,
        borderRadius: "50%",
        background: checked ? C.onPrimaryCont : C.textVariant,
        transition: "left 150ms",
      }} />
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={{ fontSize: 11, color: C.textVariant, marginLeft: 2 }}>{label}</label>
      {children}
      {hint && <p style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>{hint}</p>}
    </div>
  );
}

function Input({
  value, onChange, placeholder, type = "text", mono = false,
}: {
  value: string; onChange: (v: string) => void;
  placeholder?: string; type?: string; mono?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        background: C.surfaceLowest,
        border: "none",
        borderRadius: 6,
        padding: "10px 14px",
        fontSize: 13,
        color: C.text,
        fontFamily: mono ? "monospace" : F.body,
        width: "100%",
        outline: "none",
        transition: "box-shadow 120ms",
      }}
      onFocus={e => (e.currentTarget.style.boxShadow = `0 0 0 1px ${C.primary}`)}
      onBlur={e  => (e.currentTarget.style.boxShadow = "none")}
    />
  );
}

function normalizeMainHotkeyCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;

  const map: Record<string, string> = {
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Escape: "Escape",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    Period: "Period",
    Comma: "Comma",
    Semicolon: "Semicolon",
    Quote: "Quote",
    Slash: "Slash",
    Backslash: "Backslash",
    Backquote: "Backquote",
    Minus: "Minus",
    Equal: "Equal",
    BracketLeft: "BracketLeft",
    BracketRight: "BracketRight",
  };

  return map[code] ?? null;
}

function modifierTokenFromCode(code: string): string | null {
  const map: Record<string, string> = {
    AltLeft: IS_MAC ? "OptionLeft" : "AltLeft",
    AltRight: IS_MAC ? "OptionRight" : "AltRight",
    ControlLeft: "ControlLeft",
    ControlRight: "ControlRight",
    ShiftLeft: "ShiftLeft",
    ShiftRight: "ShiftRight",
    MetaLeft: IS_MAC ? "CommandLeft" : "SuperLeft",
    MetaRight: IS_MAC ? "CommandRight" : "SuperRight",
  };

  return map[code] ?? null;
}

function formatHotkeyTokens(modifiers: string[], mainKey?: string | null): string | null {
  const ordered = [
    ...modifiers.filter(token => token.startsWith("Control")),
    ...modifiers.filter(token => token.startsWith("Option") || token.startsWith("Alt")),
    ...modifiers.filter(token => token.startsWith("Shift")),
    ...modifiers.filter(token => token.startsWith("Command") || token.startsWith("Super")),
  ];
  const unique = ordered.filter((token, index) => ordered.indexOf(token) === index);
  const parts = mainKey ? [...unique, mainKey] : unique;
  return parts.length ? parts.join("+") : null;
}

function HotkeyField({
  value,
  onChange,
  placeholder,
  language,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  language: UiLanguage;
}) {
  const [listening, setListening] = useState(false);

  useEffect(() => {
    if (!listening) return;

    const modifiers = new Set<string>();
    let committed = false;

    function commit(next: string | null) {
      if (!next || committed) return;
      committed = true;
      onChange(next);
      setListening(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setListening(false);
        return;
      }

      const modifier = modifierTokenFromCode(event.code);
      if (modifier) {
        modifiers.add(modifier);
        return;
      }

      const mainKey = normalizeMainHotkeyCode(event.code);
      if (!mainKey) return;

      commit(formatHotkeyTokens(Array.from(modifiers), mainKey));
    }

    function handleKeyUp(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();

      const modifier = modifierTokenFromCode(event.code);
      if (!modifier) return;

      if (modifiers.size === 1 && modifiers.has(modifier)) {
        commit(formatHotkeyTokens([modifier]));
        return;
      }

      modifiers.delete(modifier);
    }

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
    };
  }, [listening, onChange]);

  return (
    <button
      type="button"
      onClick={() => setListening(true)}
      style={{
        width: "100%",
        background: listening ? C.surfaceHigh : C.surfaceLowest,
        border: listening ? `1px solid ${C.primary}` : `1px solid ${C.text}0f`,
        borderRadius: 6,
        padding: "10px 14px",
        fontSize: 12,
        color: listening ? C.primary : C.text,
        fontFamily: "monospace",
        outline: "none",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      {listening
        ? tx(language, "Press shortcut…", "请按快捷键…")
        : (value || placeholder)}
    </button>
  );
}

function Btn({
  children, onClick, disabled, variant = "ghost", fullWidth,
}: {
  children: React.ReactNode; onClick?: () => void;
  disabled?: boolean; variant?: "primary" | "ghost" | "text" | "success"; fullWidth?: boolean;
}) {
  const base: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
    padding: "8px 20px", borderRadius: 6, border: "none", cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: F.body, fontSize: 11, fontWeight: 700, letterSpacing: "0.08em",
    textTransform: "uppercase", transition: "all 120ms", opacity: disabled ? 0.45 : 1,
    width: fullWidth ? "100%" : undefined,
  };
  const styles: Record<string, React.CSSProperties> = {
    primary: { background: C.primaryCont, color: C.onPrimaryCont },
    ghost:   { background: C.surfaceHigh, color: C.primary },
    text:    { background: "transparent", color: C.textVariant },
    success: { background: `${C.success}22`, color: C.success, border: `1px solid ${C.success}55` },
  };
  return (
    <button style={{ ...base, ...styles[variant] }} onClick={disabled ? undefined : onClick} disabled={disabled}>
      {children}
    </button>
  );
}

function ChoicePill<T extends string>({
  value,
  active,
  onClick,
  title,
  description,
}: {
  value: T;
  active: boolean;
  onClick: (value: T) => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      style={{
        border: active ? `1px solid ${C.primary}88` : `1px solid ${C.text}10`,
        background: active ? `${C.primary}16` : C.surfaceHighest,
        borderRadius: 10,
        padding: "14px 14px 13px",
        textAlign: "left",
        cursor: "pointer",
        minHeight: 78,
        transition: "all 120ms",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: active ? C.text : C.textVariant }}>{title}</span>
        <span style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: active ? C.primaryCont : `${C.textMuted}55`,
          boxShadow: active ? `0 0 0 4px ${C.primary}20` : "none",
          flexShrink: 0,
        }} />
      </div>
      <p style={{ fontSize: 11, lineHeight: 1.55, color: active ? C.textVariant : `${C.textVariant}cc` }}>
        {description}
      </p>
    </button>
  );
}

function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.56)",
        backdropFilter: "blur(10px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9997,
        padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: "min(760px, 100%)",
          maxHeight: "80vh",
          overflowY: "auto",
          background: C.surface,
          borderRadius: 18,
          border: `1px solid ${C.text}12`,
          boxShadow: "0 32px 100px rgba(0,0,0,0.45)",
          padding: 22,
        }}
      >
        <div style={{ display: "flex", alignItems: "start", justifyContent: "space-between", gap: 16, marginBottom: 18 }}>
          <div>
            <h4 style={{ fontFamily: F.headline, fontSize: 22, fontWeight: 700, color: C.text, marginBottom: subtitle ? 6 : 0 }}>
              {title}
            </h4>
            {subtitle && <p style={{ fontSize: 12, color: C.textVariant, lineHeight: 1.6 }}>{subtitle}</p>}
          </div>
          <Btn variant="text" onClick={onClose}>Close</Btn>
        </div>
        {children}
      </div>
    </div>
  );
}

function LanguageSwitch({
  language,
  onChange,
}: {
  language: UiLanguage;
  onChange: (language: UiLanguage) => void;
}) {
  const options: Array<{ value: UiLanguage; label: string }> = [
    { value: "en", label: "EN" },
    { value: "zh-CN", label: "中文" },
  ];

  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: 4,
        background: C.surfaceLow,
        borderRadius: 8,
      }}
    >
      {options.map(option => {
        const active = option.value === language;
        return (
          <button
            key={option.value}
            onClick={() => onChange(option.value)}
            style={{
              border: "none",
              borderRadius: 6,
              background: active ? C.primaryCont : "transparent",
              color: active ? C.onPrimaryCont : C.textVariant,
              padding: "6px 10px",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.06em",
              cursor: "pointer",
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function ToastList({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div style={{ position: "fixed", bottom: 24, right: 24, display: "flex", flexDirection: "column", gap: 8, zIndex: 9999 }}>
      {toasts.map(t => {
        const dot = t.level === "error" ? C.primaryCont : t.level === "success" ? "#4ade80" : t.level === "warning" ? "#fbbf24" : C.primary;
        return (
          <div
            key={t.id}
            onClick={() => onDismiss(t.id)}
            style={{
              display: "flex", alignItems: "center", gap: 10,
              background: C.surfaceHigh, borderRadius: 8,
              border: `1px solid ${dot}40`,
              padding: "10px 14px", cursor: "pointer",
              animation: "toast-in 150ms ease-out",
              maxWidth: 320,
            }}
          >
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: dot, flexShrink: 0 }} />
            <span style={{ fontSize: 12, color: C.text, lineHeight: 1.4 }}>{t.message}</span>
          </div>
        );
      })}
    </div>
  );
}

function ScreenHud({
  recording,
  hud,
  language,
}: {
  recording: boolean;
  hud: HudPayload | null;
  language: UiLanguage;
}) {
  if (!recording && !hud) return null;

  const accent =
    recording ? C.primary :
    hud?.level === "error" ? C.error :
    hud?.level === "warning" ? C.warning :
    hud?.level === "success" ? C.success :
    C.info;

  const title = recording
    ? tx(language, "Recording", "录音中")
    : hud?.message ?? "";

  const subtitle = recording
    ? tx(language, "Release to transcribe", "松开后开始转写")
    : "";

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        justifyContent: "center",
        alignItems: "flex-end",
        pointerEvents: "none",
        zIndex: 9998,
        paddingBottom: "20vh",
      }}
    >
      <div
        style={{
          minWidth: recording ? 240 : 220,
          maxWidth: 360,
          padding: recording ? "22px 26px" : "18px 22px",
          borderRadius: 18,
          background: "rgba(17, 17, 17, 0.92)",
          border: `1px solid ${accent}66`,
          boxShadow: `0 24px 80px ${C.surfaceLowest}, 0 0 0 1px ${C.text}10 inset`,
          backdropFilter: "blur(14px)",
          display: "flex",
          alignItems: "center",
          gap: recording ? 16 : 12,
        }}
      >
        <div
          style={{
            width: recording ? 44 : 10,
            height: recording ? 44 : 10,
            borderRadius: "50%",
            background: recording ? C.primaryCont : accent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: recording ? `0 0 24px ${C.primary}66` : "none",
            animation: recording ? "pulse 1.2s ease-in-out infinite" : undefined,
            flexShrink: 0,
          }}
        >
          {recording && <Icon name="mic" size={22} fill={1} style={{ color: C.onPrimaryCont }} />}
        </div>
        <div>
          <p style={{ fontSize: recording ? 17 : 14, fontWeight: 700, color: C.text, marginBottom: subtitle ? 3 : 0 }}>
            {title}
          </p>
          {subtitle && <p style={{ fontSize: 12, color: C.textVariant }}>{subtitle}</p>}
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function NavItem({ icon, label, active, onClick }: {
  icon: string; label: string; active?: boolean; onClick?: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <a
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex", alignItems: "center", gap: 10,
        padding: "8px 14px", borderRadius: 6, cursor: onClick ? "pointer" : "default",
        background: active ? C.surfaceHigh : hovered && onClick ? `${C.surfaceHigh}60` : "transparent",
        color: active ? C.primary : onClick && hovered ? C.primary : C.textMuted,
        boxShadow: active ? `inset 2px 0 0 0 ${C.primary}` : "none",
        transition: "all 150ms",
        textDecoration: "none",
      }}
    >
      <Icon name={icon} size={18} />
      <span style={{ fontFamily: F.body, fontWeight: 500, fontSize: 13 }}>{label}</span>
    </a>
  );
}

function Sidebar({ page, setPage, fsmState, language, configured }: {
  page: Page;
  setPage: (p: Page) => void;
  fsmState: string;
  language: UiLanguage;
  configured: boolean;
}) {
  const recording = fsmState === "Recording";
  const statusColor = configured ? C.success : C.error;
  return (
    <aside style={{
      position: "fixed", left: 0, top: 0,
      width: 240, height: "100vh",
      background: C.sidebar,
      display: "flex", flexDirection: "column",
      padding: 16, zIndex: 40,
    }}>
      <div style={{ padding: "0 14px", marginBottom: 32 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <SaysoLogo size={26} compact />
            <div>
            <h1 style={{
              fontFamily: F.headline, fontWeight: 700,
              color: C.primary, textTransform: "uppercase",
              letterSpacing: "0.12em", fontSize: 12,
            }}>Sayso</h1>
            <p style={{ fontSize: 10, color: C.textMuted, fontWeight: 500, marginTop: 2 }}>Digital Obsidian v2.0</p>
            </div>
          </div>
        </div>
      </div>

      <nav style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
        <NavItem icon="list_alt"     label={tx(language, "Statistics", "统计")} active={page === "statistics"}  onClick={() => setPage("statistics")} />
        <NavItem icon="settings"     label={tx(language, "Settings", "设置")} active={page === "preferences"} onClick={() => setPage("preferences")} />
      </nav>

      <div style={{ padding: "0 4px 8px" }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: 12, background: C.surface, borderRadius: 8,
        }}>
          {recording ? (
            <>
              <div style={{
                width: 32, height: 32, borderRadius: "50%",
                background: C.primaryCont, flexShrink: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Icon name="mic" size={16} fill={1} style={{ color: C.onPrimaryCont }} />
              </div>
              <div>
                <p style={{ fontSize: 12, fontWeight: 700, color: C.primary }}>{tx(language, "Recording", "录音中")}</p>
                <p style={{ fontSize: 10, color: C.textVariant }}>{tx(language, "Active Session", "当前会话")}</p>
              </div>
            </>
          ) : (
            <>
              <div style={{
                width: 8, height: 8, borderRadius: "50%",
                background: statusColor,
                boxShadow: `0 0 8px ${statusColor}99`,
              }} />
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
                color: configured ? C.textVariant : C.error, textTransform: "uppercase",
              }}>
                {configured
                  ? tx(language, "System Ready", "系统就绪")
                  : tx(language, "Setup Required", "需要配置")}
              </span>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}

// ─── Settings / Preferences page ─────────────────────────────────────────────

function SettingsPage({
  addToast,
  language,
  onLanguagePreview,
}: {
  addToast: (p: ToastPayload) => void;
  language: UiLanguage;
  onLanguagePreview: (language: UiLanguage) => void;
}) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [voicePanelOpen, setVoicePanelOpen] = useState(false);
  const [testingStt, setTestingStt] = useState(false);
  const [testingLlm, setTestingLlm] = useState(false);
  const [sttVerified, setSttVerified] = useState(false);
  const [llmVerified, setLlmVerified] = useState(false);
  const [autosaveState, setAutosaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const hydrated = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const savedTimer = useRef<number | null>(null);
  const lastSavedSnapshot = useRef<string>("");

  useEffect(() => {
    invoke<AppConfig>("get_config")
      .then(cfg => {
        const normalized = normalizeConfig(cfg);
        setConfig(normalized);
        setSttVerified(localStorage.getItem(VERIFIED_STT_KEY) === configFingerprint(normalized.stt?.endpoint, normalized.stt?.model));
        setLlmVerified(localStorage.getItem(VERIFIED_LLM_KEY) === configFingerprint(normalized.llm?.endpoint, normalized.llm?.model));
        lastSavedSnapshot.current = JSON.stringify({
          config: normalized,
        });
        hydrated.current = true;
      })
      .catch(() => addToast({ level: "error", message: tx(language, "Failed to load config", "加载配置失败") }));
  }, []);

  function update(fn: (c: AppConfig) => AppConfig) {
    setConfig(prev => prev ? fn(prev) : prev);
  }

  function updateStt(fn: (stt: SttConfig) => SttConfig) {
    setSttVerified(false);
    localStorage.removeItem(VERIFIED_STT_KEY);
    update(c => ({ ...c, stt: fn(c.stt ?? { endpoint: "", model: "" }) }));
  }

  function updateLlm(fn: (llm: LlmConfig) => LlmConfig) {
    setLlmVerified(false);
    localStorage.removeItem(VERIFIED_LLM_KEY);
    update(c => ({ ...c, llm: fn(c.llm ?? { endpoint: "", model: "" }) }));
  }

  async function handleTestStt() {
    setTestingStt(true);
    try {
      await invoke("test_stt_connection");
      setSttVerified(true);
      localStorage.setItem(VERIFIED_STT_KEY, configFingerprint(config?.stt?.endpoint, config?.stt?.model));
      addToast({ level: "success", message: tx(language, "STT connection OK", "STT 连接正常"), durationMs: 2200 });
    } catch (e: unknown) {
      setSttVerified(false);
      localStorage.removeItem(VERIFIED_STT_KEY);
      addToast({
        level: "error",
        message: `${tx(language, "STT failed", "STT 测试失败")}: ${typeof e === "string" ? e : JSON.stringify(e)}`,
        durationMs: 3500,
      });
    } finally { setTestingStt(false); }
  }

  async function handleTestLlm() {
    setTestingLlm(true);
    try {
      await invoke("test_llm_connection");
      setLlmVerified(true);
      localStorage.setItem(VERIFIED_LLM_KEY, configFingerprint(config?.llm?.endpoint, config?.llm?.model));
      addToast({ level: "success", message: tx(language, "LLM connection OK", "LLM 连接正常"), durationMs: 2200 });
    } catch (e: unknown) {
      setLlmVerified(false);
      localStorage.removeItem(VERIFIED_LLM_KEY);
      addToast({
        level: "error",
        message: `${tx(language, "LLM failed", "LLM 测试失败")}: ${typeof e === "string" ? e : JSON.stringify(e)}`,
        durationMs: 3500,
      });
    } finally { setTestingLlm(false); }
  }

  async function openPermissionSettings(command: "open_accessibility_settings" | "open_microphone_settings") {
    try {
      await invoke(command);
    } catch (e) {
      addToast({ level: "error", message: `${tx(language, "Unable to open system settings", "无法打开系统设置")}: ${e}` });
    }
  }

  useEffect(() => {
    if (!config || !hydrated.current) return;

    const snapshot = JSON.stringify({
      config,
    });

    if (snapshot === lastSavedSnapshot.current) return;

    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
    }

    setAutosaveState("saving");
    saveTimer.current = window.setTimeout(async () => {
      try {
        await invoke("save_config", { newConfig: config });
        window.dispatchEvent(new CustomEvent(CONFIG_UPDATED_EVENT, { detail: config }));
        lastSavedSnapshot.current = snapshot;
        setAutosaveState("saved");
        if (savedTimer.current) {
          window.clearTimeout(savedTimer.current);
        }
        savedTimer.current = window.setTimeout(() => setAutosaveState("idle"), 1500);
      } catch (e) {
        setAutosaveState("error");
        addToast({ level: "error", message: `${tx(language, "Save failed", "保存失败")}: ${e}` });
      }
    }, 450);

    return () => {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
      }
      if (savedTimer.current) {
        window.clearTimeout(savedTimer.current);
      }
    };
  }, [config, language]);

  if (!config) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: C.textMuted, fontSize: 13 }}>
        {tx(language, "Loading…", "加载中…")}
      </div>
    );
  }

  const stt = config.stt ?? { endpoint: "", model: "" };
  const llm = config.llm ?? { endpoint: "", model: "" };
  const voice = { ...DEFAULT_VOICE_CONFIG, ...config.voice };
  const llmConfigured = isLlmConfigured(config);

  const cardStyle: React.CSSProperties = {
    background: C.surfaceLow, borderRadius: 10, padding: 24,
  };

  const sectionHeader = (icon: string, label: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
      <Icon name={icon} style={{ color: C.primary }} />
      <h3 style={{ fontFamily: F.headline, fontSize: 18, fontWeight: 600, color: C.text }}>{label}</h3>
    </div>
  );

  const labelTag = (text: string, color: string = C.primary) => (
    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color, marginBottom: 16 }}>
      {text}
    </p>
  );

  function handleCleanupToggle(nextValue: boolean) {
    if (!nextValue) {
      update(c => ({ ...c, voice: { ...c.voice, polish_enabled: false } }));
      return;
    }

    if (!llmConfigured) {
      addToast({
        level: "warning",
        message: tx(
          language,
          "Configure LLM endpoint, model, and API key before enabling LLM cleanup.",
          "开启 LLM 规范化前，请先完整配置 LLM 的接口、模型和 API Key。",
        ),
        durationMs: 3200,
      });
      return;
    }

    update(c => ({ ...c, voice: { ...c.voice, polish_enabled: true } }));
  }

  const inputVariantOptions: Array<{
    value: VoiceInputVariant;
    title: string;
    description: string;
  }> = [
    {
      value: "auto",
      title: tx(language, "Auto Detect", "自动识别"),
      description: tx(language, "Best for mixed Mandarin and regional speech. Sayso will bias STT without forcing a single accent.", "适合普通话与方言混说。系统会给 STT 提示，但不强制锁定一种口音。"),
    },
    {
      value: "mandarin",
      title: tx(language, "Mandarin", "普通话"),
      description: tx(language, "Use when the speaker is mostly standard Mandarin and you want the cleanest baseline transcription.", "适合主要说普通话时，获得最稳定的基础识别。"),
    },
    {
      value: "sichuanese",
      title: tx(language, "Sichuan Dialect", "四川话"),
      description: tx(language, "Bias STT toward Sichuan phonetics and vocabulary, then normalize to readable Chinese output.", "让 STT 更偏向识别四川话发音和词汇，再输出可读中文。"),
    },
    {
      value: "shanghainese",
      title: tx(language, "Shanghainese", "上海话"),
      description: tx(language, "Bias STT toward Shanghainese and Shanghai-accented speech for more stable regional recognition.", "让 STT 更偏向识别上海话和上海口音，提高区域语音稳定性。"),
    },
    {
      value: "henanese",
      title: tx(language, "Henan Dialect", "河南话"),
      description: tx(language, "Use when the speaker mainly uses Henan regional speech and you want better recognition of local wording.", "适合主要使用河南地区表达时，增强本地词汇识别。"),
    },
    {
      value: "guangshan",
      title: tx(language, "Guangshan", "光山县"),
      description: tx(language, "Fine-grained bias for Guangshan speech in Xinyang, suitable for stronger local accent cases.", "更细粒度偏向信阳光山县说法，适合更重的本地方音场景。"),
    },
  ];

  const outputStyleOptions: Array<{
    value: VoiceOutputTextStyle;
    title: string;
    description: string;
  }> = [
    {
      value: "standard_mandarin",
      title: tx(language, "Standard Mandarin", "标准普通话"),
      description: tx(language, "Convert dialect wording into standard Mandarin writing. Example: Sichuan or Shanghainese speech becomes standard Chinese text.", "把方言表达转成标准普通话书面文本。例如四川话、上海话都输出为标准中文。"),
    },
    {
      value: "spoken_style",
      title: tx(language, "Keep Spoken Flavor", "保留口语感"),
      description: tx(language, "Keep more of the original phrasing and dialect color while still cleaning punctuation and obvious recognition errors.", "尽量保留原始说法和方言味道，同时修正标点和明显识别错误。"),
    },
  ];

  const selectedInputVariant = inputVariantOptions.find(option => option.value === voice.input_variant) ?? inputVariantOptions[0];
  const selectedOutputStyle = outputStyleOptions.find(option => option.value === voice.output_text_style) ?? outputStyleOptions[0];

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "48px 48px 0" }}>
        {/* Header */}
        <header style={{ marginBottom: 48 }}>
          <h2 style={{ fontFamily: F.headline, fontSize: 36, fontWeight: 700, color: C.primary, letterSpacing: "-0.02em", marginBottom: 6 }}>
            {tx(language, "Settings", "设置")}
          </h2>
          <p style={{ color: C.textVariant, fontWeight: 300 }}>{tx(language, "Configure your local intelligence environment.", "配置你的本地智能环境。")}</p>
          {autosaveState !== "idle" && (
            <p style={{
              marginTop: 10,
              fontSize: 11,
              fontWeight: 600,
              color: autosaveState === "error" ? C.error : autosaveState === "saved" ? C.success : C.textVariant,
            }}>
              {autosaveState === "saving" && tx(language, "Saving changes…", "正在保存…")}
              {autosaveState === "saved" && tx(language, "Changes saved", "已保存")}
              {autosaveState === "error" && tx(language, "Save failed", "保存失败")}
            </p>
          )}
        </header>

        <div style={{ display: "flex", flexDirection: "column", gap: 40 }}>

          {/* API Configuration */}
          <section>
            {sectionHeader("api", tx(language, "API Configuration", "API 配置"))}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>

              {/* STT */}
              <div style={{ ...cardStyle, borderLeft: `2px solid ${C.primary}30` }}>
                {labelTag(tx(language, "Speech-to-Text (STT)", "语音转文字（STT）"))}
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <Field label={tx(language, "Endpoint URL", "接口地址")}>
                    <Input value={stt.endpoint} onChange={v => updateStt(current => ({ ...current, endpoint: v }))}
                      placeholder="https://api.openai.com/v1/audio/transcriptions" />
                  </Field>
                  <Field label="API Key" hint={tx(language, "Saved in config.json", "保存在 config.json 中")}>
                    <Input value={config.stt_key} onChange={v => update(c => ({ ...c, stt_key: v }))} type="password" placeholder="sk-…" mono />
                  </Field>
                  <Field label={tx(language, "Model Name", "模型名")}>
                    <Input value={stt.model} onChange={v => updateStt(current => ({ ...current, model: v }))}
                      placeholder="whisper-1" />
                  </Field>
                  <Btn
                    onClick={handleTestStt}
                    disabled={testingStt || !stt.endpoint}
                    variant={sttVerified ? "success" : "ghost"}
                    fullWidth
                  >
                    {testingStt
                      ? tx(language, "Testing…", "测试中…")
                      : sttVerified
                        ? tx(language, "Verified", "已验证")
                        : tx(language, "Test Connection", "测试连接")}
                  </Btn>
                </div>
              </div>

              {/* LLM */}
              <div style={{ ...cardStyle, borderLeft: `2px solid ${C.tertiaryCont}50` }}>
                {labelTag(tx(language, "Large Language Model (LLM)", "大语言模型（LLM）"), C.tertiary)}
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <Field label={tx(language, "Endpoint URL", "接口地址")}>
                    <Input value={llm.endpoint} onChange={v => updateLlm(current => ({ ...current, endpoint: v }))}
                      placeholder="https://api.openai.com/v1/chat/completions" />
                  </Field>
                  <Field label="API Key" hint={tx(language, "Saved in config.json", "保存在 config.json 中")}>
                    <Input value={config.llm_key} onChange={v => update(c => ({ ...c, llm_key: v }))} type="password" placeholder="sk-…" mono />
                  </Field>
                  <Field label={tx(language, "Model Name", "模型名")}>
                    <Input value={llm.model} onChange={v => updateLlm(current => ({ ...current, model: v }))}
                      placeholder="gpt-4o-mini" />
                  </Field>
                  <Btn
                    onClick={handleTestLlm}
                    disabled={testingLlm || !llm.endpoint}
                    variant={llmVerified ? "success" : "ghost"}
                    fullWidth
                  >
                    {testingLlm
                      ? tx(language, "Testing…", "测试中…")
                      : llmVerified
                        ? tx(language, "Verified", "已验证")
                        : tx(language, "Verify Model", "验证模型")}
                  </Btn>
                </div>
              </div>
            </div>
          </section>

          {/* Hotkeys */}
          <section>
            {sectionHeader("keyboard", tx(language, "Hotkeys", "快捷键"))}
            <div style={{ ...cardStyle, padding: 0, overflow: "hidden" }}>
              {[
                {
                  id: "mode_a" as const,
                  label: tx(language, "Mode A (Plain Typing)", "模式 A（普通输入）"),
                  desc: tx(language, "Direct transcription into the active text field.", "将识别文字直接输入到当前文本框。"),
                },
                {
                  id: "mode_b" as const,
                  label: tx(language, "Mode B (Type & Enter)", "模式 B（输入并发送）"),
                  desc: tx(language, "Transcribe and then send with Enter / Return.", "识别完成后再自动发送。"),
                },
                {
                  id: "mode_c" as const,
                  label: tx(language, "Mode C (Command)", "模式 C（命令模式）"),
                  desc: tx(language, "Trigger AI command processing.", "触发 AI 命令解析与执行。"),
                },
              ].map((item, i, arr) => (
                <div key={item.label} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  gap: 20,
                  padding: "18px 20px",
                  borderBottom: i < arr.length - 1 ? `1px solid ${C.text}08` : "none",
                }}>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 13, fontWeight: 500, color: C.text }}>{item.label}</p>
                    <p style={{ fontSize: 11, color: C.textVariant, marginTop: 3 }}>{item.desc}</p>
                  </div>
                  <div style={{ width: 220, flexShrink: 0 }}>
                    <HotkeyField
                      value={config.hotkeys[item.id]}
                      onChange={value =>
                        update(current => ({
                          ...current,
                          hotkeys: { ...current.hotkeys, [item.id]: value },
                        }))
                      }
                      placeholder={hotkeyPlaceholder(item.id)}
                      language={language}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p style={{ fontSize: 11, color: C.textVariant, marginTop: 10 }}>
              {tx(language, "Click a shortcut, then press the new key or key combination. Changes save automatically.", "点击快捷键后直接按新的按键或组合键。修改会自动保存。")}
            </p>
          </section>

          {/* Voice Options */}
          <section>
            <div style={{ ...cardStyle, display: "flex", flexDirection: "column", gap: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="graphic_eq" size={18} style={{ color: C.primary }} />
                <h4 style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.text }}>
                  {tx(language, "Voice Options", "语音选项")}
                </h4>
              </div>
              <div style={{
                background: `linear-gradient(180deg, ${C.surfaceHighest}, ${C.surface})`,
                borderRadius: 12,
                padding: 18,
                border: `1px solid ${C.text}10`,
                position: "relative",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                gap: 16,
              }}>
                <div style={{
                  position: "absolute",
                  inset: 0,
                  background: `radial-gradient(circle at top right, ${C.primary}18, transparent 42%)`,
                  pointerEvents: "none",
                }} />

                <div style={{ position: "relative" }}>
                  <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.primary, marginBottom: 8 }}>
                    {tx(language, "Dialect Transcription", "方言转写")}
                  </p>
                  <p style={{ fontSize: 12, color: C.textVariant, lineHeight: 1.6 }}>
                    {tx(language, "Choose the speech you speak and the text style you want out. Open the selector only when needed.", "选择你说的话，以及你希望输出成什么文字。需要时再打开选择器。")}
                  </p>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, position: "relative" }}>
                  {[
                    {
                      key: "input" as const,
                      icon: "mic_external_on",
                      label: tx(language, "Input Voice", "输入语音"),
                      value: selectedInputVariant.title,
                      desc: selectedInputVariant.description,
                    },
                    {
                      key: "output" as const,
                      icon: "notes",
                      label: tx(language, "Output Text", "输出文字"),
                      value: selectedOutputStyle.title,
                      desc: selectedOutputStyle.description,
                    },
                  ].map(item => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setVoicePanelOpen(true)}
                      style={{
                        border: `1px solid ${C.text}10`,
                        background: C.surfaceHighest,
                        borderRadius: 12,
                        padding: "16px 16px 14px",
                        textAlign: "left",
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        gap: 10,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{
                            width: 30,
                            height: 30,
                            borderRadius: 9,
                            background: `${C.primary}18`,
                            color: C.primary,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            flexShrink: 0,
                          }}>
                            <Icon name={item.icon} size={16} />
                          </div>
                          <div>
                            <p style={{ fontSize: 11, color: C.textVariant, marginBottom: 2 }}>{item.label}</p>
                            <p style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{item.value}</p>
                          </div>
                        </div>
                        <Icon name="chevron_right" size={18} style={{ color: C.textVariant }} />
                      </div>
                      <p style={{ fontSize: 11, lineHeight: 1.6, color: C.textVariant }}>{item.desc}</p>
                    </button>
                  ))}
                </div>

                <div style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto 1fr",
                  gap: 10,
                  alignItems: "center",
                  background: C.surface,
                  borderRadius: 10,
                  padding: "14px 16px",
                  position: "relative",
                }}>
                  <div>
                    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.textMuted, marginBottom: 5 }}>
                      {tx(language, "Example Input", "输入示例")}
                    </p>
                    <p style={{ fontSize: 13, color: C.text }}>
                      {voice.input_variant === "shanghainese"
                        ? "“侬现在到哪里了？”"
                        : voice.input_variant === "henanese"
                          ? "“你这会儿搁哪哩？”"
                          : voice.input_variant === "guangshan"
                            ? "“你这会儿在搞么子？”"
                            : "“你爪子嘛，现在到哪点了？”"}
                    </p>
                  </div>
                  <Icon name="arrow_forward" size={18} style={{ color: C.primary }} />
                  <div>
                    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.textMuted, marginBottom: 5 }}>
                      {tx(language, "Example Output", "输出示例")}
                    </p>
                    <p style={{ fontSize: 13, color: C.text }}>
                      {voice.output_text_style === "standard_mandarin"
                        ? "“你现在在哪里？”"
                        : voice.input_variant === "shanghainese"
                          ? "“侬现在到哪里了？”"
                          : voice.input_variant === "henanese"
                            ? "“你这会儿搁哪哩？”"
                            : voice.input_variant === "guangshan"
                              ? "“你这会儿在搞么子？”"
                              : "“你现在到哪点了？”"}
                    </p>
                  </div>
                </div>

                <div style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 16,
                  background: C.surfaceHighest,
                  borderRadius: 10,
                  padding: "14px 16px",
                  boxShadow: `inset 0 0 0 1px ${C.text}08`,
                }}>
                  <div>
                    <p style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{tx(language, "Advanced", "高级选项")}</p>
                    <p style={{ fontSize: 11, color: C.textVariant }}>
                      {tx(language, "Enable stronger regional hinting and optional LLM cleanup.", "启用更强的地区识别提示，以及可选的 LLM 规范化。")}
                    </p>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, color: C.textVariant }}>{tx(language, "Dialect Boost", "方言增强")}</span>
                      <Toggle
                        checked={voice.dialect_support_enabled}
                        onChange={v => update(c => ({ ...c, voice: { ...c.voice, dialect_support_enabled: v } }))}
                      />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, color: C.textVariant }}>{tx(language, "LLM Cleanup (slower)", "LLM 规范化（更慢）")}</span>
                      <Toggle
                        checked={voice.polish_enabled}
                        onChange={handleCleanupToggle}
                      />
                    </div>
                  </div>
                </div>

                <Modal
                  open={voicePanelOpen}
                  title={tx(language, "Voice Transcription", "语音转写设置")}
                  subtitle={tx(language, "Choose the speech you speak and the text style you want out in one place.", "在一个面板里同时设置输入语音和输出文字。")}
                  onClose={() => setVoicePanelOpen(false)}
                >
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    <div>
                      <div style={{ marginBottom: 12 }}>
                        <p style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>
                          {tx(language, "Input Voice", "输入语音")}
                        </p>
                        <p style={{ fontSize: 11, color: C.textVariant, lineHeight: 1.6 }}>
                          {tx(language, "Start with Auto Detect. If recognition is unstable, switch to a specific dialect or region.", "默认从自动识别开始。如果识别不稳定，再切换到更具体的方言或地区。")}
                        </p>
                      </div>
                      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.textMuted, marginBottom: 10 }}>
                        {tx(language, "Common Options", "常用选项")}
                      </p>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        {inputVariantOptions.slice(0, 4).map(option => (
                          <ChoicePill
                            key={option.value}
                            value={option.value}
                            active={voice.input_variant === option.value}
                            onClick={value => {
                              update(c => ({ ...c, voice: { ...c.voice, input_variant: value as VoiceInputVariant } }));
                            }}
                            title={option.title}
                            description={option.description}
                          />
                        ))}
                      </div>
                    </div>

                    <div>
                      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.textMuted, marginBottom: 10 }}>
                        {tx(language, "Regional Variants", "地区细分")}
                      </p>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        {inputVariantOptions.slice(4).map(option => (
                          <ChoicePill
                            key={option.value}
                            value={option.value}
                            active={voice.input_variant === option.value}
                            onClick={value => {
                              update(c => ({ ...c, voice: { ...c.voice, input_variant: value as VoiceInputVariant } }));
                            }}
                            title={option.title}
                            description={option.description}
                          />
                        ))}
                      </div>
                    </div>

                    <div style={{
                      height: 1,
                      background: `${C.text}10`,
                      margin: "2px 0",
                    }} />

                    <div>
                      <div style={{ marginBottom: 12 }}>
                        <p style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>
                          {tx(language, "Output Text", "输出文字")}
                        </p>
                        <p style={{ fontSize: 11, color: C.textVariant, lineHeight: 1.6 }}>
                          {tx(language, "Use Standard Mandarin for most chat, notes, and CRM input scenarios.", "大多数聊天、记录、CRM 输入场景建议使用标准普通话。")}
                        </p>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        {outputStyleOptions.map(option => (
                          <ChoicePill
                            key={option.value}
                            value={option.value}
                            active={voice.output_text_style === option.value}
                            onClick={value => {
                              update(c => ({ ...c, voice: { ...c.voice, output_text_style: value as VoiceOutputTextStyle } }));
                            }}
                            title={option.title}
                            description={option.description}
                          />
                        ))}
                      </div>
                    </div>

                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
                      <Btn variant="primary" onClick={() => setVoicePanelOpen(false)}>
                        {tx(language, "Done", "完成")}
                      </Btn>
                    </div>
                  </div>
                </Modal>
              </div>
            </div>
          </section>

          {/* System Preferences */}
          <section style={{ ...cardStyle, marginBottom: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 24 }}>
              <Icon name="settings_suggest" size={18} style={{ color: C.primary }} />
              <h4 style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.text }}>
                {tx(language, "System Preferences", "系统偏好")}
              </h4>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
              <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: C.surfaceHighest,
                borderRadius: 10,
                padding: "18px 20px",
                boxShadow: `inset 0 0 0 1px ${C.text}08`,
              }}>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 500, color: C.text }}>{tx(language, "Interface Language", "界面语言")}</p>
                  <p style={{ fontSize: 11, color: C.textVariant }}>{tx(language, "Switch between English and Simplified Chinese", "在英文和简体中文之间切换")}</p>
                </div>
                <LanguageSwitch
                  language={config.ui_language}
                  onChange={nextLanguage => update(c => {
                    onLanguagePreview(nextLanguage);
                    return { ...c, ui_language: nextLanguage };
                  })}
                />
              </div>
              <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                background: C.surfaceHighest,
                borderRadius: 10,
                padding: "18px 20px",
                boxShadow: `inset 0 0 0 1px ${C.text}08`,
              }}>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 500, color: C.text }}>{tx(language, "Show in Menu Bar", "显示在菜单栏")}</p>
                  <p style={{ fontSize: 11, color: C.textVariant }}>{tx(language, "Keep the tray icon visible in the system menu bar", "在系统菜单栏中显示托盘图标")}</p>
                </div>
                <Toggle
                  checked={config.show_in_menu_bar}
                  onChange={value => update(current => ({ ...current, show_in_menu_bar: value }))}
                />
              </div>
              <div style={{
                background: C.surfaceHighest,
                borderRadius: 10,
                padding: "18px 20px",
                boxShadow: `inset 0 0 0 1px ${C.text}08`,
              }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 500, color: C.text }}>{tx(language, "Permissions", "权限")}</p>
                    <p style={{ fontSize: 11, color: C.textVariant }}>
                      {tx(language, "Open macOS settings for Accessibility and Microphone access.", "打开 macOS 的辅助功能和麦克风权限设置。")}
                    </p>
                  </div>
                  <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
                    <Btn variant="ghost" onClick={() => openPermissionSettings("open_accessibility_settings")}>
                      {tx(language, "Accessibility", "辅助功能")}
                    </Btn>
                    <Btn variant="ghost" onClick={() => openPermissionSettings("open_microphone_settings")}>
                      {tx(language, "Microphone", "麦克风")}
                    </Btn>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* Footer */}
    </div>
  );
}

// ─── Statistics page ──────────────────────────────────────────────────────────

function StatisticsPage({
  addToast,
  language,
}: {
  addToast: (p: ToastPayload) => void;
  language: UiLanguage;
}) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    invoke<Stats>("get_stats")
      .then(setStats)
      .catch(() => addToast({ level: "error", message: tx(language, "Failed to load statistics", "加载统计数据失败") }));
  }, [addToast, language]);

  useEffect(() => {
    invoke<AppConfig>("get_config")
      .then(cfg => setConfig(normalizeConfig(cfg)))
      .catch(() => setConfig(null));
  }, []);

  const totalSessions = stats?.total_transcriptions ?? 0;
  const totalUnits = stats?.total_chars ?? 0;
  const totalSpeakingSecs = stats?.total_speaking_secs ?? 0;
  const totalCommands = stats?.commands_executed ?? 0;
  const estimatedTypingSecs = totalUnits / (40 * 5 / 60);
  const savedSecs = Math.max(0, estimatedTypingSecs - totalSpeakingSecs);
  const avgSessionSecs = totalSessions > 0 ? totalSpeakingSecs / totalSessions : 0;
  const avgUnitsPerSession = totalSessions > 0 ? totalUnits / totalSessions : 0;
  const commandsPerSession = totalSessions > 0 ? totalCommands / totalSessions : 0;
  const modeAHotkey = config?.hotkeys.mode_a || hotkeyPlaceholder("mode_a");

  async function handleReset() {
    if (totalSessions === 0) return;
    if (!confirm(tx(language, "Reset all statistics? This cannot be undone.", "要重置所有统计数据吗？此操作不可撤销。"))) return;
    try {
      await invoke("reset_stats");
      const fresh = await invoke<Stats>("get_stats");
      setStats(fresh);
      addToast({ level: "success", message: tx(language, "Statistics reset", "统计数据已重置") });
    } catch (e) {
      addToast({ level: "error", message: `${tx(language, "Reset failed", "重置失败")}: ${e}` });
    }
  }

  const cardStyle: React.CSSProperties = { background: C.surfaceLow, borderRadius: 10, padding: 28 };
  const secondaryCardStyle: React.CSSProperties = {
    ...cardStyle,
    background: C.surface,
    boxShadow: `inset 0 0 0 1px ${C.text}08`,
  };
  const isEmpty = totalSessions === 0;
  const topMetrics = [
    { label: tx(language, "Total Transcriptions", "总转写次数"), value: formatCount(totalSessions, language) },
    { label: tx(language, "Total Dictation Time", "总口述时长"), value: formatDuration(totalSpeakingSecs, language) },
    { label: tx(language, "Captured Text Units", "累计文本单位"), value: formatCount(totalUnits, language) },
  ];
  const insightMetrics = [
    {
      icon: "timer",
      label: tx(language, "Average Session Length", "平均单次时长"),
      value: formatDuration(avgSessionSecs, language),
      note: tx(language, "Average speaking time per transcription", "每次转写的平均口述时长"),
    },
    {
      icon: "notes",
      label: tx(language, "Average Units / Session", "平均每次文本单位"),
      value: formatCount(Math.round(avgUnitsPerSession), language),
      note: tx(language, "Mixed English word and CJK character units", "按英文词与 CJK 字符混合计数"),
    },
    {
      icon: "keyboard",
      label: tx(language, "Typing Equivalent", "键入等效时长"),
      value: formatDuration(estimatedTypingSecs, language),
      note: tx(language, "Estimated from 40 WPM typing speed", "按 40 WPM 打字速度估算"),
    },
    {
      icon: "alt_route",
      label: tx(language, "Commands / Session", "每次命令数"),
      value: formatDecimal(commandsPerSession),
      note: tx(language, "Mode C command density", "Mode C 命令密度"),
    },
  ];

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: "48px" }}>
      {/* Header */}
      <header style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 48 }}>
        <div>
          <h2 style={{ fontFamily: F.headline, fontSize: 36, fontWeight: 700, color: C.text, letterSpacing: "-0.02em" }}>
            {tx(language, "Statistics", "统计")}
          </h2>
          <p style={{ color: C.textVariant, fontWeight: 300, marginTop: 6 }}>{tx(language, "Performance metrics and transcription health", "性能指标与转写健康度")}</p>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <button onClick={handleReset}
            disabled={isEmpty}
            style={{
              padding: "9px 18px", borderRadius: 6,
              background: "transparent", color: isEmpty ? C.textMuted : C.error,
              border: "none", fontFamily: F.body, fontSize: 13, fontWeight: 500, cursor: isEmpty ? "not-allowed" : "pointer",
              opacity: isEmpty ? 0.6 : 1,
            }}>
            {tx(language, "Reset Data", "重置数据")}
          </button>
        </div>
      </header>

      {isEmpty ? (
        /* Empty state */
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 0", textAlign: "center" }}>
          <div style={{
            width: 72, height: 72, borderRadius: 16,
            background: C.surfaceHigh,
            display: "flex", alignItems: "center", justifyContent: "center",
            marginBottom: 24,
          }}>
            <Icon name="bar_chart" size={36} style={{ color: C.textMuted }} />
          </div>
          <h3 style={{ fontFamily: F.headline, fontSize: 22, fontWeight: 700, color: C.text, marginBottom: 12 }}>
            {tx(language, "No data yet", "还没有数据")}
          </h3>
          <p style={{ color: C.textVariant, maxWidth: 360, lineHeight: 1.7 }}>
            {tx(language, "Start using Sayso to see your transcription statistics, usage patterns, and performance metrics here.", "开始使用 Sayso 后，这里会显示你的转写统计、使用模式和性能指标。")}
          </p>
          <div style={{
            marginTop: 36,
            padding: "14px 24px",
            background: C.surfaceLow,
            borderRadius: 10,
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <Icon name="mic" size={18} style={{ color: C.primary }} />
            <span style={{ fontSize: 12, color: C.textVariant, letterSpacing: "0.05em" }}>
              {tx(language, "Hold", "按住")}{" "}
              <span style={{
                background: C.surfaceHighest, padding: "2px 8px",
                borderRadius: 4, fontFamily: "monospace", color: C.primary, fontSize: 11,
              }}>{modeAHotkey}</span>{" "}
              {tx(language, "to start speaking", "开始说话")}
            </span>
          </div>
        </div>
      ) : (
        /* Bento grid */
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 20 }}>
            <div style={{ ...cardStyle, position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, right: 0, padding: 20, opacity: 0.04 }}>
                <Icon name="analytics" size={120} />
              </div>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.primaryCont, marginBottom: 28 }}>
                {tx(language, "Usage Overview", "使用概览")}
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20 }}>
                {topMetrics.map(m => (
                  <div key={m.label}>
                    <p style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: C.textVariant, marginBottom: 8 }}>
                      {m.label}
                    </p>
                    <p style={{ fontFamily: F.headline, fontSize: 40, fontWeight: 700, color: C.text, lineHeight: 1, whiteSpace: "nowrap" }}>
                      {m.value}
                    </p>
                    <div style={{ marginTop: 14, height: 3, width: 40, background: `${C.primaryCont}30`, borderRadius: 99, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: "75%", background: C.primaryCont, borderRadius: 99 }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ ...cardStyle, borderLeft: `4px solid ${C.primaryCont}` }}>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.text, marginBottom: 28 }}>
                {tx(language, "Efficiency Metrics", "效率指标")}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 8 }}>
                    <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: C.textVariant }}>
                      {tx(language, "Estimated Time Saved", "预计节省时间")}
                    </span>
                    <span style={{ fontFamily: F.headline, fontSize: 22, fontWeight: 700, color: C.primaryCont }}>
                      {formatDuration(savedSecs, language)}
                    </span>
                  </div>
                  <div style={{ background: C.surfaceLowest, height: 6, borderRadius: 99, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", width: `${Math.min(100, estimatedTypingSecs > 0 ? (savedSecs / estimatedTypingSecs) * 100 : 0)}%`,
                      background: C.primaryCont, borderRadius: 99,
                      boxShadow: `0 0 10px ${C.primaryCont}60`,
                    }} />
                  </div>
                  <p style={{ fontSize: 10, color: `${C.textVariant}60`, marginTop: 6, fontStyle: "italic" }}>
                    {tx(language, "Based on 40wpm avg. typing speed", "基于 40wpm 平均打字速度估算")}
                  </p>
                </div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: C.textVariant, display: "block", marginBottom: 4 }}>
                      {tx(language, "Commands Run", "执行命令数")}
                    </span>
                    <span style={{ fontFamily: F.headline, fontSize: 36, fontWeight: 700, color: C.text }}>
                      {formatCount(totalCommands, language)}
                    </span>
                  </div>
                  <div style={{ width: 44, height: 44, borderRadius: 8, background: C.surface, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Icon name="alt_route" style={{ color: C.textVariant }} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "3fr 2fr", gap: 20 }}>
            <div style={secondaryCardStyle}>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.text, marginBottom: 28 }}>
                {tx(language, "Derived Insights", "衍生洞察")}
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                {insightMetrics.map((item) => (
                  <div key={item.label} style={{
                    background: C.surfaceHighest,
                    borderRadius: 10,
                    padding: 18,
                    boxShadow: `inset 0 0 0 1px ${C.text}08`,
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                      <div style={{
                        width: 34,
                        height: 34,
                        borderRadius: 8,
                        background: `${C.primaryCont}18`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}>
                        <Icon name={item.icon} size={18} style={{ color: C.primaryCont }} />
                      </div>
                      <p style={{ fontSize: 11, fontWeight: 700, color: C.textVariant, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                        {item.label}
                      </p>
                    </div>
                    <p style={{ fontFamily: F.headline, fontSize: 28, fontWeight: 700, color: C.text, marginBottom: 8 }}>
                      {item.value}
                    </p>
                    <p style={{ fontSize: 12, lineHeight: 1.6, color: C.textVariant }}>
                      {item.note}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {[
                {
                  icon: "schedule",
                  label: tx(language, "Voice vs Typing", "语音与键入对比"),
                  value: `${formatDuration(totalSpeakingSecs, language)} / ${formatDuration(estimatedTypingSecs, language)}`,
                  badge: savedSecs > 0 ? tx(language, "Time Saved", "节省时间") : tx(language, "Neutral", "持平"),
                  badgeColor: savedSecs > 0 ? C.tertiaryCont : C.surfaceHighest,
                },
                {
                  icon: "tune",
                  label: tx(language, "Command Density", "命令密度"),
                  value: `${formatDecimal(commandsPerSession)}x`,
                  badge: tx(language, "Per Session", "按会话"),
                  badgeColor: C.primaryCont,
                },
                {
                  icon: "lock",
                  label: tx(language, "Storage", "存储方式"),
                  value: tx(language, "Local JSON", "本地 JSON"),
                  badge: tx(language, "Private", "本地隐私"),
                  badgeColor: C.success,
                },
              ].map(h => (
                <div key={h.label} style={{
                  ...secondaryCardStyle,
                  padding: 20,
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  flex: 1,
                  flexWrap: "wrap",
                }}>
                  <div style={{
                    width: 44,
                    height: 44,
                    borderRadius: "50%",
                    background: `${C.primaryCont}16`,
                    border: `2px solid ${C.primary}30`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}>
                    <Icon name={h.icon} style={{ color: C.primary }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{h.label}</p>
                    <p style={{ fontFamily: F.headline, fontSize: 22, fontWeight: 700, color: C.primary }}>{h.value}</p>
                  </div>
                  {h.badge && (
                    <span style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
                      background: `${h.badgeColor}20`, color: h.badgeColor === C.success ? C.success : C.tertiary, padding: "3px 8px", borderRadius: 4,
                    }}>{h.badge}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Onboarding ───────────────────────────────────────────────────────────────

function OnboardingPage({
  onComplete,
  addToast,
  language,
  onLanguageChange,
}: {
  onComplete: () => void;
  addToast: (p: ToastPayload) => void;
  language: UiLanguage;
  onLanguageChange: (language: UiLanguage) => void;
}) {
  const [step, setStep] = useState(0);
  const [sttEndpoint, setSttEndpoint]   = useState("");
  const [sttModel,    setSttModel]      = useState("whisper-1");
  const [sttKey,      setSttKey]        = useState("");
  const [llmEndpoint, setLlmEndpoint]   = useState("");
  const [llmModel,    setLlmModel]      = useState("gpt-4o-mini");
  const [llmKey,      setLlmKey]        = useState("");
  const [saving,      setSaving]        = useState(false);
  const defaults = platformDefaultHotkeys();

  const steps = [
    tx(language, "WELCOME", "欢迎"),
    tx(language, "STT CONFIG", "STT 配置"),
    tx(language, "PERMISSIONS & LLM", "权限与 LLM"),
  ];

  async function handleFinish() {
    setSaving(true);
    try {
      await invoke("save_config", {
        newConfig: {
          stt: { endpoint: sttEndpoint, model: sttModel },
          stt_key: sttKey,
          llm: { endpoint: llmEndpoint, model: llmModel },
          llm_key: llmKey,
          hotkeys: defaults,
          voice: { ...DEFAULT_VOICE_CONFIG },
          show_in_menu_bar: true,
          ui_language: language,
          first_run: false,
        },
      });
      window.dispatchEvent(new CustomEvent(CONFIG_UPDATED_EVENT, {
        detail: normalizeConfig({
          stt: { endpoint: sttEndpoint, model: sttModel },
          stt_key: sttKey,
          llm: { endpoint: llmEndpoint, model: llmModel },
          llm_key: llmKey,
          hotkeys: defaults,
          voice: { ...DEFAULT_VOICE_CONFIG },
          show_in_menu_bar: true,
          ui_language: language,
          first_run: false,
        }),
      }));
      onComplete();
    } catch (e) {
      addToast({ level: "error", message: `${tx(language, "Setup failed", "设置失败")}: ${e}` });
    } finally {
      setSaving(false);
    }
  }

  const cardStyle: React.CSSProperties = {
    background: C.surfaceLow, borderRadius: 12, padding: 32,
    border: `1px solid ${C.text}08`,
  };

  return (
    <div style={{
      height: "100vh", background: C.bg,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 24,
      overflowY: "auto",
    }}>
      <div style={{
        ...cardStyle,
        width: "100%",
        maxWidth: 700,
        maxHeight: "calc(100vh - 48px)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* Step indicator */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 36 }}>
          <div>
            <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.primaryCont, marginBottom: 12 }}>
              {step < 3 ? `STEP ${step + 1} OF 3` : "SETUP COMPLETE"}
            </p>
            <div style={{ display: "flex", gap: 24 }}>
              {steps.map((s, i) => (
                <div key={s} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ height: 2, width: 60, background: i <= step ? C.primaryCont : C.surfaceBright, borderRadius: 99 }} />
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: i <= step ? C.primary : C.textMuted }}>
                    {s}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <LanguageSwitch language={language} onChange={onLanguageChange} />
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <SaysoLogo size={24} compact />
              <span style={{ fontFamily: F.headline, fontWeight: 700, fontSize: 18, color: C.text }}>Sayso</span>
            </div>
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", paddingRight: 4 }}>
          {/* Step content */}
          {step === 0 && (
            <div style={{ textAlign: "center", padding: "24px 0 36px" }}>
              <div style={{ margin: "0 auto 32px", display: "flex", justifyContent: "center" }}>
                <SaysoLogo size={44} />
              </div>
              <h1 style={{ fontFamily: F.headline, fontSize: 40, fontWeight: 700, color: C.text, marginBottom: 16 }}>
                {tx(language, "Welcome to Sayso", "欢迎使用 Sayso")}
              </h1>
              <p style={{ color: C.textVariant, fontSize: 18, fontWeight: 300, maxWidth: 440, margin: "0 auto 48px", lineHeight: 1.6 }}>
                {tx(language, "The open-source, private, and secure way to use your voice.", "一个开源、私密、安全的语音输入方式。")}
              </p>
              <div style={{ display: "flex", justifyContent: "center", gap: 48, paddingTop: 28, borderTop: `1px solid ${C.text}08` }}>
                {[
                  { icon: "person_off", label: tx(language, "NO ACCOUNTS", "无需账户") },
                  { icon: "subscriptions",  label: tx(language, "NO SUBS", "无需订阅") },
                  { icon: "visibility_off", label: tx(language, "NO TRACKING", "无追踪") },
                ].map(f => (
                  <div key={f.label} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
                    <Icon name={f.icon} size={28} style={{ color: C.primary }} />
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: C.text }}>{f.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 1 && (
            <div>
              <h1 style={{ fontFamily: F.headline, fontSize: 32, fontWeight: 700, color: C.text, textAlign: "center", marginBottom: 12 }}>
                {tx(language, "Connect Your STT API", "连接你的 STT API")}
              </h1>
              <p style={{ color: C.textVariant, textAlign: "center", fontSize: 16, fontWeight: 300, marginBottom: 32, lineHeight: 1.6, maxWidth: 480, margin: "0 auto 32px" }}>
                {tx(language, "Configure your speech-to-text provider. We support OpenAI Whisper, local instances, or Groq for ultra-low latency. For the fastest response after you stop speaking, keep LLM cleanup off unless you need cleaner punctuation.", "配置你的语音转文字服务。支持 OpenAI Whisper、本地实例，以及低延迟的 Groq。想要说完后更快出结果，尽量先关闭 LLM 规范化，只有在确实需要更干净标点时再开启。")}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 480, margin: "0 auto" }}>
                <Field label={tx(language, "STT ENDPOINT URL", "STT 接口地址")}>
                  <Input value={sttEndpoint} onChange={setSttEndpoint} placeholder="https://api.openai.com/v1/audio/transcriptions" />
                </Field>
                <Field label={tx(language, "MODEL NAME", "模型名")}>
                  <Input value={sttModel} onChange={setSttModel} placeholder="whisper-1" />
                </Field>
                <Field label="API KEY" hint={tx(language, "Stored securely in system Keychain", "安全存储在系统钥匙串中")}>
                  <Input value={sttKey} onChange={setSttKey} type="password" placeholder="sk-…" mono />
                </Field>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <h1 style={{ fontFamily: F.headline, fontSize: 32, fontWeight: 700, color: C.text, textAlign: "center", marginBottom: 12 }}>
                {tx(language, "Final Setup", "最后设置")}
              </h1>
              <p style={{ color: C.textVariant, textAlign: "center", fontSize: 16, fontWeight: 300, marginBottom: 32, lineHeight: 1.6, maxWidth: 480, margin: "0 auto 32px" }}>
                {tx(language, "Connect your brain (LLM) and grant system permissions.", "连接你的大脑（LLM），并授予系统权限。")}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 16, maxWidth: 480, margin: "0 auto" }}>
                {[
                  { title: tx(language, "Grant Accessibility Access", "授予辅助功能权限"), desc: tx(language, "Required for keyboard simulation and global hotkeys.", "键盘模拟和全局快捷键需要此权限。"), color: C.primaryCont },
                  { title: tx(language, "Microphone Access", "麦克风权限"), desc: tx(language, "Required for voice recording and transcription.", "语音录制和转写需要此权限。"), color: C.tertiaryCont },
                ].map((p, index) => (
                  <div key={p.title} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "18px 20px", background: C.surfaceLowest, borderRadius: 8,
                    borderLeft: `3px solid ${p.color}`,
                  }}>
                    <div>
                      <p style={{ fontWeight: 600, fontSize: 14, color: C.text, marginBottom: 4 }}>{p.title}</p>
                      <p style={{ fontSize: 12, color: C.textVariant }}>{p.desc}</p>
                    </div>
                    <Btn
                      variant="primary"
                      onClick={() => invoke(index === 0 ? "open_accessibility_settings" : "open_microphone_settings").catch(e => {
                        addToast({ level: "error", message: `${tx(language, "Unable to open system settings", "无法打开系统设置")}: ${e}` });
                      })}
                    >
                      {tx(language, "Grant Access", "授予权限")}
                    </Btn>
                  </div>
                ))}
                <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 16 }}>
                  <Field label={tx(language, "LLM ENDPOINT URL", "LLM 接口地址")}>
                    <Input value={llmEndpoint} onChange={setLlmEndpoint} placeholder="https://api.openai.com/v1/chat/completions" />
                  </Field>
                  <Field label={tx(language, "LLM MODEL", "LLM 模型")}>
                    <Input value={llmModel} onChange={setLlmModel} placeholder="gpt-4o-mini" />
                  </Field>
                  <Field label="LLM API KEY" hint={tx(language, "Stored securely in system Keychain", "安全存储在系统钥匙串中")}>
                    <Input value={llmKey} onChange={setLlmKey} type="password" placeholder="sk-…" mono />
                  </Field>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div style={{ textAlign: "center", padding: "24px 0 36px" }}>
              <div style={{ margin: "0 auto 32px", display: "flex", justifyContent: "center" }}>
                <SaysoLogo size={44} />
              </div>
              <h1 style={{ fontFamily: F.headline, fontSize: 40, fontWeight: 700, color: C.text, marginBottom: 16 }}>
                {tx(language, "You're all set.", "已经准备好了。")}
              </h1>
              <p style={{ color: C.textVariant, fontSize: 18, fontWeight: 300, maxWidth: 440, margin: "0 auto 40px", lineHeight: 1.6 }}>
                {tx(language, "Sayso is configured and ready. Hold your hotkey, speak, and release.", "Sayso 已完成配置。按住快捷键，说话，再松开即可。")}
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 32, textAlign: "left" }}>
                {[
                  { icon: "mic", label: IS_MAC ? tx(language, "HOLD ⌥ SPACE", "按住 ⌥ SPACE") : tx(language, "HOLD CTRL SPACE", "按住 CTRL SPACE"), desc: tx(language, "Begin recording voice", "开始录音") },
                  { icon: "keyboard", label: tx(language, "RELEASE", "松开"), desc: tx(language, "Transcription begins", "开始转写") },
                  { icon: "terminal", label: IS_MAC ? tx(language, "HOLD ⌥ .", "按住 ⌥ .") : tx(language, "HOLD CTRL .", "按住 CTRL ."), desc: tx(language, "Command mode", "命令模式") },
                ].map(h => (
                  <div key={h.label} style={{ background: C.surfaceLowest, borderRadius: 8, padding: 16, border: `1px solid ${C.text}08` }}>
                    <Icon name={h.icon} size={22} style={{ color: C.primary, marginBottom: 10 }} />
                    <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: C.text, marginBottom: 4 }}>
                      {h.label}
                    </p>
                    <p style={{ fontSize: 11, color: C.textVariant }}>{h.desc}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24, paddingTop: 24, borderTop: `1px solid ${C.text}08`, flexShrink: 0 }}>
          {step > 0 ? (
            <button onClick={() => setStep(s => s - 1)}
              style={{ display: "flex", alignItems: "center", gap: 6, background: "transparent", border: "none", color: C.textVariant, cursor: "pointer", fontSize: 13, fontFamily: F.body }}>
              <Icon name="arrow_back" size={16} /> {tx(language, "Back", "返回")}
            </button>
          ) : <div />}
          {step < 2 && (
            <Btn variant="primary" onClick={() => setStep(s => s + 1)}>
              {step === 0 ? tx(language, "Get Started", "开始使用") : tx(language, "Continue", "继续")}
            </Btn>
          )}
          {step === 2 && (
            <Btn variant="primary" onClick={() => setStep(3)} disabled={saving}>
              {tx(language, "Finish Setup", "完成设置")}
            </Btn>
          )}
          {step === 3 && (
            <Btn variant="primary" onClick={handleFinish} disabled={saving}>
              {saving ? tx(language, "Saving…", "保存中…") : tx(language, "Launch Sayso", "启动 Sayso")}
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Root App ─────────────────────────────────────────────────────────────────

let toastCounter = 0;

export default function App() {
  const [page,     setPage]     = useState<Page>("statistics");
  const [fsmState, setFsmState] = useState("Idle");
  const [toasts,   setToasts]   = useState<Toast[]>([]);
  const [ready,    setReady]    = useState(false);
  const [isOnboarding, setIsOnboarding] = useState(false);
  const [language, setLanguage] = useState<UiLanguage>(DEFAULT_UI_LANGUAGE);
  const [configured, setConfigured] = useState(false);
  const [hud, setHud] = useState<HudPayload | null>(null);
  const hudTimer = useRef<number | null>(null);

  const addToast = useCallback((payload: ToastPayload) => {
    const id = ++toastCounter;
    setToasts(prev => [...prev, { ...payload, id }]);
    const dur = payload.durationMs ?? TOAST_DURATIONS[payload.level];
    if (dur !== null) setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), dur);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  // Load config to check first_run
  useEffect(() => {
    if (IS_OVERLAY_WINDOW) {
      setReady(true);
      return;
    }

    invoke<AppConfig>("get_config")
      .then(cfg => {
        const normalized = normalizeConfig(cfg);
        setLanguage(normalized.ui_language);
        setConfigured(isSystemConfigured(normalized));
        if (normalized.first_run) setIsOnboarding(true);
        setReady(true);
      })
      .catch(() => {
        // If invoke fails (browser dev mode), show preferences
        setReady(true);
      });
  }, []);

  useEffect(() => {
    function handleConfigUpdated(event: Event) {
      const next = (event as CustomEvent<AppConfig>).detail;
      if (!next) return;
      setConfigured(isSystemConfigured(normalizeConfig(next)));
    }

    window.addEventListener(CONFIG_UPDATED_EVENT, handleConfigUpdated as EventListener);
    return () => {
      window.removeEventListener(CONFIG_UPDATED_EVENT, handleConfigUpdated as EventListener);
    };
  }, []);

  // Listen for Tauri events
  useEffect(() => {
    if (!IS_OVERLAY_WINDOW) return;

    const previousBody = document.body.style.background;
    const previousHtml = document.documentElement.style.background;
    document.body.style.background = "transparent";
    document.documentElement.style.background = "transparent";

    return () => {
      document.body.style.background = previousBody;
      document.documentElement.style.background = previousHtml;
    };
  }, []);

  useEffect(() => {
    const unsubToast = listen<ToastPayload>("toast",     e => addToast(e.payload));
    const unsubFsm   = listen<string>      ("fsm_state", e => setFsmState(e.payload));
    const unsubNav   = listen<string>      ("navigate",  e => setPage(e.payload as Page));
    const unsubHud   = listen<HudPayload>  ("hud",       e => {
      setHud(e.payload);
      if (hudTimer.current) {
        window.clearTimeout(hudTimer.current);
      }
      hudTimer.current = window.setTimeout(() => setHud(null), 1800);
    });
    return () => {
      unsubToast.then(f => f());
      unsubFsm.then(f => f());
      unsubNav.then(f => f());
      unsubHud.then(f => f());
      if (hudTimer.current) {
        window.clearTimeout(hudTimer.current);
      }
    };
  }, [addToast]);

  if (!ready) {
    return (
      <div style={{ height: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 24, height: 24, borderRadius: "50%", border: `2px solid ${C.primary}30`, borderTopColor: C.primary, animation: "spin 0.8s linear infinite" }} />
      </div>
    );
  }

  if (IS_OVERLAY_WINDOW) {
    return (
      <div style={{ width: "100vw", height: "100vh", background: "transparent" }}>
        <ScreenHud recording={fsmState === "Recording"} hud={fsmState === "Recording" ? null : hud} language={language} />
      </div>
    );
  }

  return (
    <>
      <ToastList toasts={toasts} onDismiss={dismissToast} />

      {isOnboarding ? (
        <OnboardingPage
          onComplete={() => { setIsOnboarding(false); setPage("preferences"); }}
          addToast={addToast}
          language={language}
          onLanguageChange={setLanguage}
        />
      ) : (
        <div style={{ display: "flex", height: "100vh", background: C.bg }}>
          <Sidebar page={page} setPage={setPage} fsmState={fsmState} language={language} configured={configured} />
          <main style={{ marginLeft: 240, flex: 1, overflow: "hidden" }}>
            {page === "preferences" && <SettingsPage addToast={addToast} language={language} onLanguagePreview={setLanguage} />}
            {page === "statistics"  && <StatisticsPage addToast={addToast} language={language} />}
          </main>
        </div>
      )}
    </>
  );
}
