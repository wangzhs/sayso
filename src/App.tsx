import React, { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ─── Types ───────────────────────────────────────────────────────────────────

type Page = "onboarding" | "preferences" | "statistics";
type UiLanguage = "en" | "zh-CN";

interface SttConfig  { endpoint: string; model: string; }
interface LlmConfig  { endpoint: string; model: string; }
interface HotkeyConfig { mode_a: string; mode_b: string; mode_c: string; }
interface VoiceConfig  { polish_enabled: boolean; }

interface AppConfig {
  stt: SttConfig | null;
  llm: LlmConfig | null;
  hotkeys: HotkeyConfig;
  voice: VoiceConfig;
  ui_language: UiLanguage;
  first_run: boolean;
}

interface Stats {
  total_transcriptions: number;
  total_speaking_secs: number;
  total_chars: number;
  commands_executed: number;
}

interface ToastPayload { level: "info" | "warning" | "error" | "success"; message: string; }
interface Toast extends ToastPayload { id: number; }

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

function normalizeLanguage(language?: string): UiLanguage {
  return language === "zh-CN" ? "zh-CN" : "en";
}

function tx(language: UiLanguage, en: string, zh: string) {
  return language === "zh-CN" ? zh : en;
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

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      onClick={() => onChange(!checked)}
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

function Btn({
  children, onClick, disabled, variant = "ghost", fullWidth,
}: {
  children: React.ReactNode; onClick?: () => void;
  disabled?: boolean; variant?: "primary" | "ghost" | "text"; fullWidth?: boolean;
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
  };
  return (
    <button style={{ ...base, ...styles[variant] }} onClick={disabled ? undefined : onClick} disabled={disabled}>
      {children}
    </button>
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

function Sidebar({ page, setPage, fsmState, language, onLanguageChange }: {
  page: Page;
  setPage: (p: Page) => void;
  fsmState: string;
  language: UiLanguage;
  onLanguageChange: (language: UiLanguage) => void;
}) {
  const recording = fsmState === "Recording";
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
          <div>
            <h1 style={{
              fontFamily: F.headline, fontWeight: 700,
              color: C.primary, textTransform: "uppercase",
              letterSpacing: "0.12em", fontSize: 12,
            }}>Sayso</h1>
            <p style={{ fontSize: 10, color: C.textMuted, fontWeight: 500, marginTop: 2 }}>Digital Obsidian v2.0</p>
          </div>
          <LanguageSwitch language={language} onChange={onLanguageChange} />
        </div>
      </div>

      <nav style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
        <NavItem icon="dashboard"    label={tx(language, "Dashboard", "总览")} />
        <NavItem icon="settings"     label={tx(language, "Settings", "设置")} active={page === "preferences"} onClick={() => setPage("preferences")} />
        <NavItem icon="list_alt"     label={tx(language, "Statistics", "统计")} active={page === "statistics"}  onClick={() => setPage("statistics")} />
        <NavItem icon="tune"         label={tx(language, "Configuration", "配置")} />
        <NavItem icon="verified_user"label={tx(language, "Security", "安全")} />
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
                background: C.primary,
                boxShadow: `0 0 8px ${C.primary}99`,
              }} />
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
                color: C.textVariant, textTransform: "uppercase",
              }}>{tx(language, "System Ready", "系统就绪")}</span>
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
  const [sttKey, setSttKey] = useState("");
  const [llmKey, setLlmKey] = useState("");
  const [dirty, setDirty] = useState(false);
  const [testingStt, setTestingStt] = useState(false);
  const [testingLlm, setTestingLlm] = useState(false);
  const original = useRef<AppConfig | null>(null);

  useEffect(() => {
    invoke<AppConfig>("get_config")
      .then(cfg => {
        const normalized = { ...cfg, ui_language: normalizeLanguage(cfg.ui_language) };
        setConfig(normalized);
        original.current = normalized;
      })
      .catch(() => addToast({ level: "error", message: tx(language, "Failed to load config", "加载配置失败") }));
  }, []);

  function update(fn: (c: AppConfig) => AppConfig) {
    setConfig(prev => prev ? fn(prev) : prev);
    setDirty(true);
  }

  async function handleSave() {
    if (!config) return;
    try {
      await invoke("save_config", { newConfig: config });
      if (sttKey.trim()) await invoke("save_stt_key", { key: sttKey.trim() });
      if (llmKey.trim()) await invoke("save_llm_key", { key: llmKey.trim() });
      original.current = config;
      setSttKey(""); setLlmKey(""); setDirty(false);
      addToast({ level: "success", message: tx(config.ui_language, "Configuration saved", "配置已保存") });
    } catch (e) {
      addToast({ level: "error", message: `${tx(language, "Save failed", "保存失败")}: ${e}` });
    }
  }

  function handleDiscard() {
    if (original.current) {
      setConfig(original.current);
      onLanguagePreview(original.current.ui_language);
      setSttKey(""); setLlmKey(""); setDirty(false);
    }
  }

  async function handleTestStt() {
    setTestingStt(true);
    try {
      await invoke("test_stt_connection");
      addToast({ level: "success", message: tx(language, "STT connection OK", "STT 连接正常") });
    } catch (e: unknown) {
      addToast({ level: "error", message: `${tx(language, "STT failed", "STT 测试失败")}: ${typeof e === "string" ? e : JSON.stringify(e)}` });
    } finally { setTestingStt(false); }
  }

  async function handleTestLlm() {
    setTestingLlm(true);
    try {
      await invoke("test_llm_connection");
      addToast({ level: "success", message: tx(language, "LLM connection OK", "LLM 连接正常") });
    } catch (e: unknown) {
      addToast({ level: "error", message: `${tx(language, "LLM failed", "LLM 测试失败")}: ${typeof e === "string" ? e : JSON.stringify(e)}` });
    } finally { setTestingLlm(false); }
  }

  if (!config) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: C.textMuted, fontSize: 13 }}>
        {tx(language, "Loading…", "加载中…")}
      </div>
    );
  }

  const stt = config.stt ?? { endpoint: "", model: "" };
  const llm = config.llm ?? { endpoint: "", model: "" };

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
                    <Input value={stt.endpoint} onChange={v => update(c => ({ ...c, stt: { ...stt, endpoint: v } }))}
                      placeholder="https://api.openai.com/v1/audio/transcriptions" />
                  </Field>
                  <Field label="API Key" hint={tx(language, "Stored in Keychain — leave blank to keep existing", "存储在系统钥匙串中，留空则保留现有值")}>
                    <Input value={sttKey} onChange={setSttKey} type="password" placeholder="sk-…" mono />
                  </Field>
                  <Field label={tx(language, "Model Name", "模型名")}>
                    <Input value={stt.model} onChange={v => update(c => ({ ...c, stt: { ...stt, model: v } }))}
                      placeholder="whisper-1" />
                  </Field>
                  <Btn onClick={handleTestStt} disabled={testingStt || !stt.endpoint} fullWidth>
                    {testingStt ? tx(language, "Testing…", "测试中…") : tx(language, "Test Connection", "测试连接")}
                  </Btn>
                </div>
              </div>

              {/* LLM */}
              <div style={{ ...cardStyle, borderLeft: `2px solid ${C.tertiaryCont}50` }}>
                {labelTag(tx(language, "Large Language Model (LLM)", "大语言模型（LLM）"), C.tertiary)}
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  <Field label={tx(language, "Endpoint URL", "接口地址")}>
                    <Input value={llm.endpoint} onChange={v => update(c => ({ ...c, llm: { ...llm, endpoint: v } }))}
                      placeholder="https://api.openai.com/v1/chat/completions" />
                  </Field>
                  <Field label="API Key" hint={tx(language, "Stored in Keychain — leave blank to keep existing", "存储在系统钥匙串中，留空则保留现有值")}>
                    <Input value={llmKey} onChange={setLlmKey} type="password" placeholder="sk-…" mono />
                  </Field>
                  <Field label={tx(language, "Model Name", "模型名")}>
                    <Input value={llm.model} onChange={v => update(c => ({ ...c, llm: { ...llm, model: v } }))}
                      placeholder="gpt-4o-mini" />
                  </Field>
                  <Btn onClick={handleTestLlm} disabled={testingLlm || !llm.endpoint} fullWidth>
                    {testingLlm ? tx(language, "Testing…", "测试中…") : tx(language, "Verify Model", "验证模型")}
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
                { label: tx(language, "Mode A (Plain Typing)", "模式 A（普通输入）"), desc: tx(language, "Direct transcription into active text field.", "将识别文字直接输入到当前文本框。"), key: config.hotkeys.mode_a },
                { label: tx(language, "Mode B (Type & Enter)", "模式 B（输入并发送）"), desc: tx(language, "Transcribes and automatically simulates 'Enter' key.", "识别完成后自动模拟回车键。"), key: config.hotkeys.mode_b },
                { label: tx(language, "Mode C (Command)", "模式 C（命令模式）"), desc: tx(language, "Trigger AI command processing from current clipboard.", "触发 AI 命令解析与执行。"), key: config.hotkeys.mode_c },
              ].map((item, i, arr) => (
                <div key={item.label} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "18px 20px",
                  borderBottom: i < arr.length - 1 ? `1px solid ${C.text}08` : "none",
                }}>
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 500, color: C.text }}>{item.label}</p>
                    <p style={{ fontSize: 11, color: C.textVariant, marginTop: 3 }}>{item.desc}</p>
                  </div>
                  <div style={{
                    background: C.surfaceLowest, border: `1px solid ${C.text}0f`,
                    borderRadius: 6, padding: "6px 14px",
                    fontFamily: "monospace", fontSize: 12, color: C.primary,
                    cursor: "default",
                  }}>
                    {item.key}
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Bento: Voice Options + Injection Strategy */}
          <section style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 20 }}>
            {/* Voice Options */}
            <div style={{ ...cardStyle, display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                <Icon name="graphic_eq" size={18} style={{ color: C.primary }} />
                <h4 style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.text }}>
                  {tx(language, "Voice Options", "语音选项")}
                </h4>
              </div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer" }}
                onClick={() => update(c => ({ ...c, voice: { polish_enabled: !c.voice.polish_enabled } }))}>
                <span style={{ fontSize: 13, color: C.textVariant }}>{tx(language, "LLM Polishing", "LLM 润色")}</span>
                <Toggle checked={config.voice.polish_enabled}
                  onChange={v => update(c => ({ ...c, voice: { polish_enabled: v } }))} />
              </div>
              <p style={{ fontSize: 10, color: C.textVariant, marginTop: 12, lineHeight: 1.6 }}>
                {tx(language, "AI automatically fixes grammar and refines tone during transcription.", "在转写时用 AI 自动修正语法并润色语气。")}
              </p>
            </div>

            {/* Injection Strategy */}
            <div style={{ ...cardStyle }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                <Icon name="terminal" size={18} style={{ color: C.primary }} />
                <h4 style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.text }}>
                  {tx(language, "Injection Strategy", "注入策略")}
                </h4>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                  {[
                    { label: tx(language, "Default Strategy", "默认策略"), sub: tx(language, "Keyboard simulation (Native)", "键盘模拟（原生）"), active: true },
                    { label: tx(language, "Direct Hook", "直接钩子"), sub: tx(language, "OS accessibility API", "系统辅助功能 API"), active: false },
                  ].map(opt => (
                    <div key={opt.label} style={{ display: "flex", alignItems: "center", gap: 12, opacity: opt.active ? 1 : 0.5 }}>
                      <div style={{
                        width: 16, height: 16, borderRadius: "50%",
                        border: `2px solid ${opt.active ? C.primary : C.outlineVariant}`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        {opt.active && <div style={{ width: 6, height: 6, borderRadius: "50%", background: C.primary }} />}
                      </div>
                      <div>
                        <p style={{ fontSize: 13, fontWeight: 500, color: C.text }}>{opt.label}</p>
                        <p style={{ fontSize: 10, color: C.textVariant }}>{opt.sub}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{
                  background: C.surfaceHighest, borderRadius: 8, padding: 14,
                  display: "flex", alignItems: "flex-start", gap: 12,
                }}>
                  <div style={{
                    width: 36, height: 18, borderRadius: 9, background: C.surfaceBright,
                    position: "relative", flexShrink: 0, marginTop: 2,
                  }}>
                    <div style={{ position: "absolute", left: 3, top: 3, width: 12, height: 12, borderRadius: "50%", background: C.textVariant }} />
                  </div>
                  <div>
                    <p style={{ fontSize: 12, fontWeight: 500, color: C.text }}>{tx(language, "Fallback Mode", "回退模式")}</p>
                    <p style={{ fontSize: 10, color: C.textVariant, marginTop: 4, lineHeight: 1.5 }}>
                      {tx(language, "Automatic clipboard injection for VS Code, Slack, and Electron apps.", "为 VS Code、Slack 和 Electron 应用自动使用剪贴板注入。")}
                    </p>
                  </div>
                </div>
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
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
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
              {[
                { label: tx(language, "Launch at Login", "开机启动"), desc: tx(language, "Start Sayso automatically on startup", "系统启动时自动启动 Sayso") },
                { label: tx(language, "Show in Menu Bar", "显示在菜单栏"), desc: tx(language, "Keep icon visible in system tray", "在系统托盘中保持图标可见") },
              ].map(pref => (
                <div key={pref.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <p style={{ fontSize: 13, fontWeight: 500, color: C.text }}>{pref.label}</p>
                    <p style={{ fontSize: 11, color: C.textVariant }}>{pref.desc}</p>
                  </div>
                  <Toggle checked={true} onChange={() => {}} />
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {/* Footer */}
      <div style={{
        padding: "16px 48px",
        borderTop: `1px solid ${C.text}08`,
        display: "flex", justifyContent: "flex-end", gap: 12,
        background: C.bg,
      }}>
        <Btn onClick={handleDiscard} variant="text">{tx(language, "Discard Changes", "放弃修改")}</Btn>
        <Btn onClick={handleSave} variant="primary" disabled={!dirty}>{tx(language, "Save Configuration", "保存配置")}</Btn>
      </div>
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

  useEffect(() => {
    invoke<Stats>("get_stats")
      .then(setStats)
      .catch(() => addToast({ level: "error", message: tx(language, "Failed to load statistics", "加载统计数据失败") }));
  }, []);

  async function handleExport() {
    try {
      const csv = await invoke<string>("export_stats_csv");
      const blob = new Blob([csv], { type: "text/csv" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "sayso-stats.csv";
      a.click();
    } catch (e) {
      addToast({ level: "error", message: `${tx(language, "Export failed", "导出失败")}: ${e}` });
    }
  }

  async function handleReset() {
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

  // Derived display values
  const totalHours  = stats ? Math.floor(stats.total_speaking_secs / 3600) : 0;
  const totalMins   = stats ? Math.floor((stats.total_speaking_secs % 3600) / 60) : 0;
  const wordCount   = stats ? (stats.total_chars / 5).toFixed(1) : "0";
  const savedMins   = stats ? Math.max(0, Math.round(stats.total_chars / 40 - stats.total_speaking_secs / 60)) : 0;

  const isEmpty = !stats || stats.total_transcriptions === 0;

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
          <button onClick={handleExport}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "9px 18px", borderRadius: 6,
              background: C.surfaceHigh, color: C.text,
              border: `1px solid ${C.outlineVariant}30`,
              fontFamily: F.body, fontSize: 13, fontWeight: 500, cursor: "pointer",
            }}>
            <Icon name="download" size={16} /> {tx(language, "Export to CSV", "导出 CSV")}
          </button>
          <button onClick={handleReset}
            style={{
              padding: "9px 18px", borderRadius: 6,
              background: "transparent", color: C.error,
              border: "none", fontFamily: F.body, fontSize: 13, fontWeight: 500, cursor: "pointer",
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
              {tx(language, "GETTING STARTED — Hold", "开始使用：按住")}{" "}
              <span style={{
                background: C.surfaceHighest, padding: "2px 8px",
                borderRadius: 4, fontFamily: "monospace", color: C.primary, fontSize: 11,
              }}>⌥ Space</span>{" "}
              {tx(language, "to begin recording", "开始录音")}
            </span>
          </div>
        </div>
      ) : (
        /* Bento grid */
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 20 }}>

            {/* Usage Overview */}
            <div style={{ ...cardStyle, position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, right: 0, padding: 20, opacity: 0.04 }}>
                <Icon name="analytics" size={120} />
              </div>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.primaryCont, marginBottom: 28 }}>
                {tx(language, "Usage Overview", "使用概览")}
              </p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20 }}>
                {[
                  { label: tx(language, "Total Collaborations", "总协作次数"), value: stats!.total_transcriptions.toLocaleString() },
                  { label: tx(language, "Total Dictation Time", "总口述时长"),  value: `${totalHours}h ${totalMins}m` },
                  { label: tx(language, "Word Count", "字数统计"), value: `${wordCount}k` },
                ].map(m => (
                  <div key={m.label}>
                    <p style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase", color: C.textVariant, marginBottom: 8 }}>
                      {m.label}
                    </p>
                    <p style={{ fontFamily: F.headline, fontSize: 40, fontWeight: 700, color: C.text, lineHeight: 1 }}>
                      {m.value}
                    </p>
                    <div style={{ marginTop: 14, height: 3, width: 40, background: `${C.primaryCont}30`, borderRadius: 99, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: "75%", background: C.primaryCont, borderRadius: 99 }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Efficiency Metrics */}
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
                      {savedMins >= 60 ? `${(savedMins / 60).toFixed(1)} hrs` : `${savedMins} min`}
                    </span>
                  </div>
                  <div style={{ background: C.surfaceLowest, height: 6, borderRadius: 99, overflow: "hidden" }}>
                    <div style={{
                      height: "100%", width: `${Math.min(100, (savedMins / 60) * 10)}%`,
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
                      {stats!.commands_executed}
                    </span>
                  </div>
                  <div style={{ width: 44, height: 44, borderRadius: 8, background: C.surface, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Icon name="alt_route" style={{ color: C.textVariant }} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Bottom row */}
          <div style={{ display: "grid", gridTemplateColumns: "3fr 2fr", gap: 20 }}>
            {/* Placeholder bar chart */}
            <div style={{ ...cardStyle }}>
              <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: C.text, marginBottom: 28 }}>
                {tx(language, "Activity Distribution", "活跃分布")}
              </p>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: 120 }}>
                {[20, 45, 30, 85, 60, 40, 25, 55, 70, 40, 20, 10].map((h, i) => (
                  <div key={i} style={{
                    flex: 1, height: `${h}%`,
                    background: i === 3 ? C.primaryCont : C.surfaceHighest,
                    borderRadius: "2px 2px 0 0",
                    transition: "background 150ms",
                  }} />
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.text}08` }}>
                {["01 May", "15 May", "30 May"].map(d => (
                  <span key={d} style={{ fontSize: 10, color: C.textVariant, fontFamily: "monospace", textTransform: "uppercase" }}>{d}</span>
                ))}
              </div>
            </div>

            {/* System health cards */}
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {[
                { icon: "bolt",    label: tx(language, "System Latency", "系统延迟"), value: "12ms", badge: tx(language, "Optimal", "最佳"), badgeColor: C.tertiaryCont },
                { icon: "verified",label: tx(language, "Recognition Accuracy", "识别准确率"), value: "98.4%", badge: undefined, badgeColor: undefined },
              ].map(h => (
                <div key={h.label} style={{ ...cardStyle, padding: 20, display: "flex", alignItems: "center", gap: 14, flex: 1 }}>
                  <div style={{ width: 44, height: 44, borderRadius: "50%", border: `2px solid ${C.outlineVariant}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Icon name={h.icon} style={{ color: C.primary }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{h.label}</p>
                    <p style={{ fontFamily: F.headline, fontSize: 22, fontWeight: 700, color: C.primary }}>{h.value}</p>
                  </div>
                  {h.badge && (
                    <span style={{
                      fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase",
                      background: `${h.badgeColor}20`, color: C.tertiary, padding: "3px 8px", borderRadius: 4,
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
          llm: { endpoint: llmEndpoint, model: llmModel },
          hotkeys: { mode_a: "Alt+Space", mode_b: "Alt+Return", mode_c: "Alt+Period" },
          voice: { polish_enabled: true },
          ui_language: language,
          first_run: false,
        },
      });
      if (sttKey.trim()) await invoke("save_stt_key", { key: sttKey.trim() });
      if (llmKey.trim()) await invoke("save_llm_key", { key: llmKey.trim() });
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
      minHeight: "100vh", background: C.bg,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 24,
    }}>
      <div style={{ ...cardStyle, width: "100%", maxWidth: 700 }}>
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
              <span style={{ fontFamily: F.headline, fontWeight: 700, fontSize: 18, color: C.text }}>Sayso</span>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: C.primaryCont }} />
            </div>
          </div>
        </div>

        {/* Step content */}
        {step === 0 && (
          <div style={{ textAlign: "center", padding: "24px 0 36px" }}>
            <div style={{ width: 64, height: 40, background: C.primaryCont, borderRadius: 10, margin: "0 auto 32px" }} />
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
              {tx(language, "Configure your speech-to-text provider. We support OpenAI Whisper, local instances, or Groq for ultra-low latency.", "配置你的语音转文字服务。支持 OpenAI Whisper、本地实例，以及低延迟的 Groq。")}
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
              ].map(p => (
                <div key={p.title} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "18px 20px", background: C.surfaceLowest, borderRadius: 8,
                  borderLeft: `3px solid ${p.color}`,
                }}>
                  <div>
                    <p style={{ fontWeight: 600, fontSize: 14, color: C.text, marginBottom: 4 }}>{p.title}</p>
                    <p style={{ fontSize: 12, color: C.textVariant }}>{p.desc}</p>
                  </div>
                  <Btn variant="primary">{tx(language, "Grant Access", "授予权限")}</Btn>
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
            <div style={{ width: 64, height: 40, background: C.primaryCont, borderRadius: 10, margin: "0 auto 32px" }} />
            <h1 style={{ fontFamily: F.headline, fontSize: 40, fontWeight: 700, color: C.text, marginBottom: 16 }}>
              {tx(language, "You're all set.", "已经准备好了。")}
            </h1>
            <p style={{ color: C.textVariant, fontSize: 18, fontWeight: 300, maxWidth: 440, margin: "0 auto 40px", lineHeight: 1.6 }}>
              {tx(language, "Sayso is configured and ready. Hold your hotkey, speak, and release.", "Sayso 已完成配置。按住快捷键，说话，再松开即可。")}
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 32, textAlign: "left" }}>
              {[
                { icon: "mic", label: tx(language, "HOLD ⌥ SPACE", "按住 ⌥ SPACE"), desc: tx(language, "Begin recording voice", "开始录音") },
                { icon: "keyboard", label: tx(language, "RELEASE", "松开"), desc: tx(language, "Transcription begins", "开始转写") },
                { icon: "terminal", label: tx(language, "HOLD ⌥ .", "按住 ⌥ ."), desc: tx(language, "Command mode", "命令模式") },
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

        {/* Footer */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 32, paddingTop: 24, borderTop: `1px solid ${C.text}08` }}>
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
  const [page,     setPage]     = useState<Page>("preferences");
  const [fsmState, setFsmState] = useState("Idle");
  const [toasts,   setToasts]   = useState<Toast[]>([]);
  const [ready,    setReady]    = useState(false);
  const [isOnboarding, setIsOnboarding] = useState(false);
  const [language, setLanguage] = useState<UiLanguage>(DEFAULT_UI_LANGUAGE);

  const addToast = useCallback((payload: ToastPayload) => {
    const id = ++toastCounter;
    setToasts(prev => [...prev, { ...payload, id }]);
    const dur = TOAST_DURATIONS[payload.level];
    if (dur !== null) setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), dur);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const persistLanguage = useCallback(async (nextLanguage: UiLanguage) => {
    setLanguage(nextLanguage);
    try {
      const cfg = await invoke<AppConfig>("get_config");
      await invoke("save_config", {
        newConfig: {
          ...cfg,
          ui_language: nextLanguage,
        },
      });
    } catch (e) {
      addToast({ level: "error", message: `${tx(nextLanguage, "Language switch failed", "语言切换失败")}: ${e}` });
    }
  }, [addToast]);

  // Load config to check first_run
  useEffect(() => {
    invoke<AppConfig>("get_config")
      .then(cfg => {
        setLanguage(normalizeLanguage(cfg.ui_language));
        if (cfg.first_run) setIsOnboarding(true);
        setReady(true);
      })
      .catch(() => {
        // If invoke fails (browser dev mode), show preferences
        setReady(true);
      });
  }, []);

  // Listen for Tauri events
  useEffect(() => {
    const unsubToast = listen<ToastPayload>("toast",     e => addToast(e.payload));
    const unsubFsm   = listen<string>      ("fsm_state", e => setFsmState(e.payload));
    const unsubNav   = listen<string>      ("navigate",  e => setPage(e.payload as Page));
    return () => {
      unsubToast.then(f => f());
      unsubFsm.then(f => f());
      unsubNav.then(f => f());
    };
  }, [addToast]);

  if (!ready) {
    return (
      <div style={{ height: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: 24, height: 24, borderRadius: "50%", border: `2px solid ${C.primary}30`, borderTopColor: C.primary, animation: "spin 0.8s linear infinite" }} />
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
          <Sidebar page={page} setPage={setPage} fsmState={fsmState} language={language} onLanguageChange={persistLanguage} />
          <main style={{ marginLeft: 240, flex: 1, overflow: "hidden" }}>
            {page === "preferences" && <SettingsPage addToast={addToast} language={language} onLanguagePreview={setLanguage} />}
            {page === "statistics"  && <StatisticsPage addToast={addToast} language={language} />}
          </main>
        </div>
      )}
    </>
  );
}
