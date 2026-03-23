import React, { useEffect, useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ─── Types ───────────────────────────────────────────────────────────────────

type Page = "onboarding" | "preferences" | "statistics";

interface SttConfig {
  endpoint: string;
  model: string;
}

interface LlmConfig {
  endpoint: string;
  model: string;
}

interface HotkeyConfig {
  mode_a: string;
  mode_b: string;
  mode_c: string;
}

interface VoiceConfig {
  polish_enabled: boolean;
}

interface AppConfig {
  stt: SttConfig | null;
  llm: LlmConfig | null;
  hotkeys: HotkeyConfig;
  voice: VoiceConfig;
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
}

interface Toast extends ToastPayload {
  id: number;
}

// ─── Toast auto-dismiss durations (per spec) ──────────────────────────────────
const TOAST_DURATIONS: Record<ToastPayload["level"], number | null> = {
  success: 3000,
  info: 4000,
  warning: 5000,
  error: null, // never auto-dismiss
};

// ─── Toast component ─────────────────────────────────────────────────────────

const TOAST_LEVEL_STYLES: Record<ToastPayload["level"], { bg: string; border: string; dot: string }> = {
  success: { bg: "var(--card)", border: "var(--success)", dot: "var(--success)" },
  info:    { bg: "var(--card)", border: "var(--info)",    dot: "var(--info)" },
  warning: { bg: "var(--card)", border: "var(--warning)", dot: "var(--warning)" },
  error:   { bg: "var(--card)", border: "var(--accent)",  dot: "var(--accent)" },
};

function ToastList({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        zIndex: 1000,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => {
        const s = TOAST_LEVEL_STYLES[t.level];
        return (
          <div
            key={t.id}
            className="toast-entrance"
            style={{
              background: s.bg,
              color: "var(--text-primary)",
              border: `1px solid ${s.border}`,
              borderRadius: "var(--radius-md)",
              padding: "10px 14px",
              fontSize: 13,
              fontFamily: "var(--font-body)",
              maxWidth: 340,
              pointerEvents: "auto",
              cursor: "pointer",
              lineHeight: 1.5,
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
            }}
            onClick={() => onDismiss(t.id)}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "var(--radius-full)",
                background: s.dot,
                flexShrink: 0,
                marginTop: 5,
              }}
            />
            {t.message}
          </div>
        );
      })}
    </div>
  );
}

// ─── Nav ─────────────────────────────────────────────────────────────────────

function Nav({ page, onNav }: { page: Page; onNav: (p: Page) => void }) {
  const items: { id: Exclude<Page, "onboarding">; label: string }[] = [
    { id: "preferences", label: "Preferences" },
    { id: "statistics", label: "Statistics" },
  ];

  return (
    <nav
      style={{
        width: 200,
        flexShrink: 0,
        padding: "20px 12px",
        background: "var(--surface)",
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      <div
        style={{
          fontSize: 16,
          fontFamily: "var(--font-display)",
          fontWeight: 700,
          color: "var(--text-primary)",
          padding: "4px 10px",
          marginBottom: 16,
          letterSpacing: "-0.02em",
        }}
      >
        Sayso
      </div>
      {items.map((item) => (
        <button
          key={item.id}
          onClick={() => onNav(item.id)}
          style={{
            background: page === item.id ? "var(--card)" : "transparent",
            color: page === item.id ? "var(--text-primary)" : "var(--text-secondary)",
            border: "none",
            borderRadius: "var(--radius-md)",
            padding: "8px 10px",
            textAlign: "left",
            cursor: "pointer",
            fontSize: 13,
            fontFamily: "var(--font-body)",
            fontWeight: page === item.id ? 500 : 400,
            width: "100%",
            transition: "background 0.12s, color 0.12s",
          }}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}

// ─── Shared: Section wrapper ──────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      <h2
        style={{
          fontSize: 11,
          fontFamily: "var(--font-body)",
          fontWeight: 600,
          color: "var(--text-tertiary)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          marginBottom: 12,
        }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: "var(--card)",
        borderRadius: "var(--radius-lg)",
        padding: "20px 24px",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label
        style={{
          display: "block",
          fontSize: 12,
          fontFamily: "var(--font-body)",
          fontWeight: 500,
          color: "var(--text-secondary)",
          marginBottom: 6,
        }}
      >
        {label}
      </label>
      {children}
      {hint && (
        <div
          style={{
            fontSize: 11,
            color: "var(--text-tertiary)",
            marginTop: 4,
            lineHeight: 1.5,
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  type = "text",
  monospace = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  monospace?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: "100%",
        boxSizing: "border-box",
        fontFamily: monospace ? "var(--font-mono)" : "var(--font-body)",
      }}
    />
  );
}

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 0",
        cursor: "pointer",
      }}
      onClick={() => onChange(!checked)}
    >
      <div>
        <div style={{ fontSize: 13, fontFamily: "var(--font-body)", color: "var(--text-primary)", fontWeight: 500 }}>
          {label}
        </div>
        {description && (
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
            {description}
          </div>
        )}
      </div>
      <div
        style={{
          width: 36,
          height: 20,
          borderRadius: "var(--radius-full)",
          background: checked ? "var(--accent)" : "var(--text-tertiary)",
          position: "relative",
          flexShrink: 0,
          transition: "background 0.15s",
        }}
      >
        <div
          style={{
            width: 14,
            height: 14,
            borderRadius: "var(--radius-full)",
            background: "white",
            position: "absolute",
            top: 3,
            left: checked ? 19 : 3,
            transition: "left 0.15s",
          }}
        />
      </div>
    </div>
  );
}

// ─── Preferences page ─────────────────────────────────────────────────────────

function PreferencesPage({
  addToast,
}: {
  addToast: (p: ToastPayload) => void;
}) {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [sttKey, setSttKey] = useState("");
  const [llmKey, setLlmKey] = useState("");
  const [dirty, setDirty] = useState(false);
  const [testingConn, setTestingConn] = useState(false);
  const originalConfig = useRef<AppConfig | null>(null);

  useEffect(() => {
    invoke<AppConfig>("get_config")
      .then((cfg) => {
        setConfig(cfg);
        originalConfig.current = cfg;
      })
      .catch(() => addToast({ level: "error", message: "Failed to load config" }));
  }, []);

  function updateConfig(updater: (c: AppConfig) => AppConfig) {
    setConfig((prev) => {
      if (!prev) return prev;
      return updater(prev);
    });
    setDirty(true);
  }

  async function handleSave() {
    if (!config) return;
    try {
      await invoke("save_config", { newConfig: config });
      if (sttKey.trim()) await invoke("save_stt_key", { key: sttKey.trim() });
      if (llmKey.trim()) await invoke("save_llm_key", { key: llmKey.trim() });
      originalConfig.current = config;
      setSttKey("");
      setLlmKey("");
      setDirty(false);
      addToast({ level: "success", message: "Preferences saved" });
    } catch (e) {
      addToast({ level: "error", message: `Save failed: ${e}` });
    }
  }

  function handleDiscard() {
    if (originalConfig.current) {
      setConfig(originalConfig.current);
      setSttKey("");
      setLlmKey("");
      setDirty(false);
    }
  }

  async function handleTestStt() {
    setTestingConn(true);
    try {
      await invoke("test_stt_connection");
      addToast({ level: "success", message: "STT connection successful" });
    } catch (e: unknown) {
      const msg = typeof e === "string" ? e : JSON.stringify(e);
      addToast({ level: "error", message: `STT test failed: ${msg}` });
    } finally {
      setTestingConn(false);
    }
  }

  if (!config) {
    return (
      <div style={{ padding: 32 }}>
        <p style={{ color: "var(--text-secondary)", fontSize: 13 }}>Loading…</p>
      </div>
    );
  }

  const stt = config.stt ?? { endpoint: "", model: "" };
  const llm = config.llm ?? { endpoint: "", model: "" };

  return (
    <div style={{ padding: "28px 32px", maxWidth: 680, overflowY: "auto" }}>
      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 20,
          fontWeight: 700,
          color: "var(--text-primary)",
          marginBottom: 28,
          letterSpacing: "-0.02em",
        }}
      >
        Preferences
      </h1>

      {/* STT */}
      <Section title="Speech Recognition">
        <Card>
          <Field
            label="Endpoint"
            hint="OpenAI-compatible /audio/transcriptions endpoint"
          >
            <TextInput
              value={stt.endpoint}
              onChange={(v) =>
                updateConfig((c) => ({ ...c, stt: { ...stt, endpoint: v } }))
              }
              placeholder="https://api.openai.com/v1/audio/transcriptions"
            />
          </Field>
          <Field label="Model">
            <TextInput
              value={stt.model}
              onChange={(v) =>
                updateConfig((c) => ({ ...c, stt: { ...stt, model: v } }))
              }
              placeholder="whisper-1"
            />
          </Field>
          <Field label="API Key" hint="Stored in system Keychain — leave blank to keep existing">
            <TextInput
              value={sttKey}
              onChange={setSttKey}
              type="password"
              placeholder="sk-…"
              monospace
            />
          </Field>
          <button
            onClick={handleTestStt}
            disabled={testingConn || !stt.endpoint}
            style={{
              background: "transparent",
              color: testingConn ? "var(--text-tertiary)" : "var(--text-secondary)",
              border: "1px solid var(--card-hover)",
              borderRadius: "var(--radius-md)",
              padding: "7px 14px",
              fontSize: 12,
              fontFamily: "var(--font-body)",
              cursor: testingConn || !stt.endpoint ? "not-allowed" : "pointer",
              transition: "color 0.12s",
              marginTop: 4,
            }}
          >
            {testingConn ? "Testing…" : "Test Connection"}
          </button>
        </Card>
      </Section>

      {/* LLM */}
      <Section title="Language Model">
        <Card>
          <Field
            label="Endpoint"
            hint="OpenAI-compatible /chat/completions endpoint (used for command mode)"
          >
            <TextInput
              value={llm.endpoint}
              onChange={(v) =>
                updateConfig((c) => ({ ...c, llm: { ...llm, endpoint: v } }))
              }
              placeholder="https://api.openai.com/v1/chat/completions"
            />
          </Field>
          <Field label="Model">
            <TextInput
              value={llm.model}
              onChange={(v) =>
                updateConfig((c) => ({ ...c, llm: { ...llm, model: v } }))
              }
              placeholder="gpt-4o-mini"
            />
          </Field>
          <Field label="API Key" hint="Stored in system Keychain — leave blank to keep existing">
            <TextInput
              value={llmKey}
              onChange={setLlmKey}
              type="password"
              placeholder="sk-…"
              monospace
            />
          </Field>
        </Card>
      </Section>

      {/* Voice Options */}
      <Section title="Voice Options">
        <Card>
          <Toggle
            checked={config.voice.polish_enabled}
            onChange={(v) =>
              updateConfig((c) => ({ ...c, voice: { polish_enabled: v } }))
            }
            label="LLM Polishing"
            description="Use language model to clean up raw transcription (Modes A/B only)"
          />
        </Card>
      </Section>

      {/* Hotkeys */}
      <Section title="Hotkeys">
        <Card>
          {[
            { label: "Mode A — Type", value: config.hotkeys.mode_a, desc: "Transcribe and inject text" },
            { label: "Mode B — Type + Send", value: config.hotkeys.mode_b, desc: "Transcribe, inject, then press Enter" },
            { label: "Mode C — Command", value: config.hotkeys.mode_c, desc: "Transcribe and execute as shell command" },
          ].map((item, i) => (
            <div
              key={item.label}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "10px 0",
                borderBottom: i < 2 ? "1px solid var(--card-hover)" : "none",
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontFamily: "var(--font-body)", color: "var(--text-primary)", fontWeight: 500 }}>
                  {item.label}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
                  {item.desc}
                </div>
              </div>
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  background: "var(--surface)",
                  color: "var(--text-secondary)",
                  padding: "3px 8px",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                {item.value}
              </code>
            </div>
          ))}
          <p style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 12, lineHeight: 1.6 }}>
            Hotkey rebinding coming in a future update. Edit <code style={{ fontFamily: "var(--font-mono)" }}>config.json</code> to change now.
          </p>
        </Card>
      </Section>

      {/* Footer */}
      {dirty && (
        <div
          style={{
            display: "flex",
            gap: 10,
            paddingTop: 8,
            paddingBottom: 4,
          }}
        >
          <button className="primary" onClick={handleSave}>
            Save
          </button>
          <button className="ghost" onClick={handleDiscard}>
            Discard
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Statistics page ─────────────────────────────────────────────────────────

function formatTime(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

// saved_time = (chars typed at 40wpm * 5 chars/word / 60) - speaking_secs
function savedTimeSecs(chars: number, speakingSecs: number): number {
  const typingTimeSecs = (chars / 5 / 40) * 60;
  return Math.max(0, typingTimeSecs - speakingSecs);
}

function StatCard({
  label,
  value,
  sub,
  accent = false,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <Card>
      <div
        style={{
          fontSize: 11,
          fontFamily: "var(--font-body)",
          fontWeight: 600,
          color: "var(--text-tertiary)",
          textTransform: "uppercase",
          letterSpacing: "0.07em",
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 32,
          fontFamily: "var(--font-mono)",
          fontWeight: 600,
          color: accent ? "var(--accent)" : "var(--text-primary)",
          letterSpacing: "-0.02em",
          lineHeight: 1,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 6 }}>
          {sub}
        </div>
      )}
    </Card>
  );
}

function StatisticsPage({ addToast }: { addToast: (p: ToastPayload) => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const loadStats = useCallback(() => {
    invoke<Stats>("get_stats")
      .then(setStats)
      .catch(() => addToast({ level: "error", message: "Failed to load statistics" }));
  }, [addToast]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  async function handleExport() {
    try {
      const csv = await invoke<string>("export_stats_csv");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sayso-stats-${new Date().toISOString().split("T")[0]}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      addToast({ level: "success", message: "Stats exported" });
    } catch (e) {
      addToast({ level: "error", message: `Export failed: ${e}` });
    }
  }

  async function handleReset() {
    try {
      await invoke("reset_stats");
      await loadStats();
      setConfirmReset(false);
      addToast({ level: "success", message: "Statistics reset" });
    } catch (e) {
      addToast({ level: "error", message: `Reset failed: ${e}` });
    }
  }

  return (
    <div style={{ padding: "28px 32px", maxWidth: 680 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 28 }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 20,
            fontWeight: 700,
            color: "var(--text-primary)",
            letterSpacing: "-0.02em",
          }}
        >
          Statistics
        </h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="ghost" onClick={handleExport} style={{ fontSize: 12, padding: "6px 12px" }}>
            Export CSV
          </button>
          {!confirmReset ? (
            <button
              className="ghost"
              onClick={() => setConfirmReset(true)}
              style={{ fontSize: 12, padding: "6px 12px", color: "var(--text-tertiary)" }}
            >
              Reset
            </button>
          ) : (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>Confirm?</span>
              <button
                onClick={handleReset}
                style={{
                  background: "var(--accent)",
                  color: "white",
                  border: "none",
                  borderRadius: "var(--radius-md)",
                  padding: "5px 10px",
                  fontSize: 12,
                  fontFamily: "var(--font-body)",
                  cursor: "pointer",
                }}
              >
                Yes, reset
              </button>
              <button
                className="ghost"
                onClick={() => setConfirmReset(false)}
                style={{ fontSize: 12, padding: "5px 10px" }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>

      {stats ? (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 12,
              marginBottom: 12,
            }}
          >
            <StatCard
              label="Transcriptions"
              value={stats.total_transcriptions.toLocaleString()}
            />
            <StatCard
              label="Speaking Time"
              value={formatTime(stats.total_speaking_secs)}
              sub={`${stats.total_speaking_secs.toFixed(1)}s total`}
            />
            <StatCard
              label="Characters Typed"
              value={stats.total_chars.toLocaleString()}
              sub={`≈ ${Math.round(stats.total_chars / 5).toLocaleString()} words`}
            />
            <StatCard
              label="Commands Executed"
              value={stats.commands_executed.toLocaleString()}
            />
          </div>
          <StatCard
            label="Time Saved"
            value={formatTime(savedTimeSecs(stats.total_chars, stats.total_speaking_secs))}
            sub="vs typing at 40 WPM"
            accent
          />
        </>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {[0, 1, 2, 3].map((i) => (
            <Card key={i}>
              <div
                style={{
                  height: 12,
                  background: "var(--surface)",
                  borderRadius: "var(--radius-sm)",
                  marginBottom: 16,
                  width: "60%",
                }}
              />
              <div
                style={{
                  height: 32,
                  background: "var(--surface)",
                  borderRadius: "var(--radius-sm)",
                  width: "40%",
                }}
              />
            </Card>
          ))}
        </div>
      )}

      {stats &&
        stats.total_transcriptions === 0 && (
          <div
            style={{
              marginTop: 32,
              textAlign: "center",
              color: "var(--text-tertiary)",
              fontSize: 13,
              lineHeight: 1.7,
            }}
          >
            No transcriptions yet. Hold a hotkey and speak to get started.
          </div>
        )}
    </div>
  );
}

// ─── Onboarding ────────────────────────────────────────────────────────────────

type OnboardingStep = 1 | 2 | 3;

function StepDots({ current, total }: { current: OnboardingStep; total: number }) {
  return (
    <div style={{ display: "flex", gap: 6, justifyContent: "center" }}>
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          style={{
            width: i + 1 === current ? 20 : 6,
            height: 6,
            borderRadius: "var(--radius-full)",
            background: i + 1 === current ? "var(--accent)" : "var(--card)",
            transition: "width 0.2s, background 0.2s",
          }}
        />
      ))}
    </div>
  );
}

function OnboardingPage({ onDone, addToast }: { onDone: () => void; addToast: (p: ToastPayload) => void }) {
  const [step, setStep] = useState<OnboardingStep>(1);
  const [sttEndpoint, setSttEndpoint] = useState("https://api.openai.com/v1/audio/transcriptions");
  const [sttModel, setSttModel] = useState("whisper-1");
  const [sttKey, setSttKey] = useState("");
  const [llmEndpoint, setLlmEndpoint] = useState("https://api.openai.com/v1/chat/completions");
  const [llmModel, setLlmModel] = useState("gpt-4o-mini");
  const [llmKey, setLlmKey] = useState("");
  const [polishEnabled, setPolishEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingConn, setTestingConn] = useState(false);

  async function handleFinish() {
    setSaving(true);
    try {
      const cfg: AppConfig = {
        stt: sttEndpoint ? { endpoint: sttEndpoint, model: sttModel } : null,
        llm: llmEndpoint ? { endpoint: llmEndpoint, model: llmModel } : null,
        hotkeys: { mode_a: "Alt+Space", mode_b: "Alt+Return", mode_c: "Alt+Period" },
        voice: { polish_enabled: polishEnabled },
        first_run: false,
      };
      await invoke("save_config", { newConfig: cfg });
      if (sttKey.trim()) await invoke("save_stt_key", { key: sttKey.trim() });
      if (llmKey.trim()) await invoke("save_llm_key", { key: llmKey.trim() });
      addToast({ level: "success", message: "Sayso is ready to use!" });
      onDone();
    } catch (e) {
      addToast({ level: "error", message: `Setup failed: ${e}` });
    } finally {
      setSaving(false);
    }
  }

  async function handleTestStt() {
    if (!sttEndpoint) return;
    setTestingConn(true);
    try {
      // Save temp config so test_stt_connection can use it
      await invoke("save_config", {
        newConfig: {
          stt: { endpoint: sttEndpoint, model: sttModel },
          llm: null,
          hotkeys: { mode_a: "Alt+Space", mode_b: "Alt+Return", mode_c: "Alt+Period" },
          voice: { polish_enabled: false },
          first_run: true,
        },
      });
      if (sttKey.trim()) await invoke("save_stt_key", { key: sttKey.trim() });
      await invoke("test_stt_connection");
      addToast({ level: "success", message: "STT connection OK!" });
    } catch (e: unknown) {
      const msg = typeof e === "string" ? e : JSON.stringify(e);
      addToast({ level: "warning", message: `STT test: ${msg}` });
    } finally {
      setTestingConn(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        padding: 24,
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 520,
          background: "var(--surface)",
          borderRadius: "var(--radius-lg)",
          padding: "40px 40px 32px",
          display: "flex",
          flexDirection: "column",
          gap: 0,
        }}
      >
        {/* Progress dots */}
        <StepDots current={step} total={3} />

        {/* Step content */}
        <div style={{ marginTop: 32, marginBottom: 32, flex: 1 }}>
          {step === 1 && (
            <div style={{ textAlign: "center" }}>
              {/* Mic icon */}
              <div
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: "var(--radius-full)",
                  background: "var(--accent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  margin: "0 auto 24px",
                  fontSize: 24,
                }}
              >
                🎙
              </div>
              <h1
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: 26,
                  fontWeight: 700,
                  color: "var(--text-primary)",
                  letterSpacing: "-0.03em",
                  marginBottom: 12,
                }}
              >
                Welcome to Sayso
              </h1>
              <p
                style={{
                  color: "var(--text-secondary)",
                  fontSize: 14,
                  lineHeight: 1.7,
                  maxWidth: 380,
                  margin: "0 auto 28px",
                }}
              >
                Voice-to-text for every app. Hold a hotkey, speak, release — Sayso types for you.
              </p>
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  justifyContent: "center",
                  marginBottom: 4,
                  flexWrap: "wrap",
                }}
              >
                {["No Account", "No Subscription", "No Tracking"].map((pill) => (
                  <div
                    key={pill}
                    style={{
                      fontSize: 11,
                      fontFamily: "var(--font-body)",
                      fontWeight: 500,
                      color: "var(--text-tertiary)",
                      background: "var(--card)",
                      borderRadius: "var(--radius-full)",
                      padding: "4px 12px",
                    }}
                  >
                    {pill}
                  </div>
                ))}
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <h2
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: 20,
                  fontWeight: 700,
                  color: "var(--text-primary)",
                  letterSpacing: "-0.02em",
                  marginBottom: 6,
                }}
              >
                Speech Recognition
              </h2>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 24, lineHeight: 1.6 }}>
                Connect an OpenAI-compatible STT API. Works with OpenAI Whisper, Groq, and any compatible endpoint.
              </p>
              <Field label="Endpoint URL">
                <TextInput
                  value={sttEndpoint}
                  onChange={setSttEndpoint}
                  placeholder="https://api.openai.com/v1/audio/transcriptions"
                />
              </Field>
              <Field label="Model">
                <TextInput
                  value={sttModel}
                  onChange={setSttModel}
                  placeholder="whisper-1"
                />
              </Field>
              <Field label="API Key (optional)" hint="Stored in system Keychain, never in files">
                <TextInput
                  value={sttKey}
                  onChange={setSttKey}
                  type="password"
                  placeholder="sk-…"
                  monospace
                />
              </Field>
              <button
                onClick={handleTestStt}
                disabled={testingConn || !sttEndpoint}
                style={{
                  background: "transparent",
                  color: testingConn ? "var(--text-tertiary)" : "var(--text-secondary)",
                  border: "1px solid var(--card)",
                  borderRadius: "var(--radius-md)",
                  padding: "7px 14px",
                  fontSize: 12,
                  fontFamily: "var(--font-body)",
                  cursor: testingConn || !sttEndpoint ? "not-allowed" : "pointer",
                  marginTop: 4,
                }}
              >
                {testingConn ? "Testing…" : "Test Connection"}
              </button>
            </div>
          )}

          {step === 3 && (
            <div>
              <h2
                style={{
                  fontFamily: "var(--font-display)",
                  fontSize: 20,
                  fontWeight: 700,
                  color: "var(--text-primary)",
                  letterSpacing: "-0.02em",
                  marginBottom: 6,
                }}
              >
                Language Model
              </h2>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 24, lineHeight: 1.6 }}>
                Optional. Used for command mode (Mode C) and LLM polishing. Leave blank to skip.
              </p>
              <Field label="Endpoint URL">
                <TextInput
                  value={llmEndpoint}
                  onChange={setLlmEndpoint}
                  placeholder="https://api.openai.com/v1/chat/completions"
                />
              </Field>
              <Field label="Model">
                <TextInput
                  value={llmModel}
                  onChange={setLlmModel}
                  placeholder="gpt-4o-mini"
                />
              </Field>
              <Field label="API Key (optional)" hint="Stored in system Keychain, never in files">
                <TextInput
                  value={llmKey}
                  onChange={setLlmKey}
                  type="password"
                  placeholder="sk-…"
                  monospace
                />
              </Field>
              <div style={{ marginTop: 8 }}>
                <Toggle
                  checked={polishEnabled}
                  onChange={setPolishEnabled}
                  label="LLM Polishing"
                  description="Use LLM to clean up raw transcription text"
                />
              </div>
            </div>
          )}
        </div>

        {/* Navigation buttons */}
        <div style={{ display: "flex", gap: 10, justifyContent: "space-between", alignItems: "center" }}>
          {step > 1 ? (
            <button
              className="ghost"
              onClick={() => setStep((s) => (s - 1) as OnboardingStep)}
              style={{ fontSize: 13 }}
            >
              Back
            </button>
          ) : (
            <div />
          )}
          <div style={{ display: "flex", gap: 8 }}>
            {step < 3 && (
              <button
                className="ghost"
                onClick={() => setStep((s) => (s + 1) as OnboardingStep)}
                style={{ fontSize: 13, color: "var(--text-tertiary)" }}
              >
                Skip
              </button>
            )}
            {step < 3 ? (
              <button
                className="primary"
                onClick={() => setStep((s) => (s + 1) as OnboardingStep)}
                style={{ fontSize: 13 }}
              >
                Continue →
              </button>
            ) : (
              <button
                className="primary"
                onClick={handleFinish}
                disabled={saving}
                style={{ fontSize: 13 }}
              >
                {saving ? "Setting up…" : "Finish Setup"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── FSM indicator ─────────────────────────────────────────────────────────────

function FsmBadge({ state }: { state: string }) {
  if (state === "IDLE") return null;
  const isRecording = state === "RECORDING";
  return (
    <div
      style={{
        position: "fixed",
        top: 12,
        right: 12,
        background: isRecording ? "var(--accent)" : "var(--card)",
        color: "var(--text-primary)",
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        padding: "4px 10px",
        borderRadius: "var(--radius-full)",
        letterSpacing: "0.06em",
        zIndex: 900,
        ...(isRecording ? { animation: "recording-pulse 1s ease-in-out infinite" } : {}),
      }}
    >
      {state}
    </div>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

let toastCounter = 0;

export default function App() {
  const [page, setPage] = useState<Page>("preferences");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fsmState, setFsmState] = useState<string>("IDLE");

  const addToast = useCallback((payload: ToastPayload) => {
    const id = ++toastCounter;
    setToasts((prev) => [...prev, { ...payload, id }]);
    const duration = TOAST_DURATIONS[payload.level];
    if (duration !== null) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
    }
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  useEffect(() => {
    const unsubToast = listen<ToastPayload>("toast", (e) => addToast(e.payload));
    const unsubFsm = listen<string>("fsm_state", (e) => setFsmState(e.payload));
    const unsubNav = listen<string>("navigate", (e) => setPage(e.payload as Page));
    return () => {
      unsubToast.then((f) => f());
      unsubFsm.then((f) => f());
      unsubNav.then((f) => f());
    };
  }, [addToast]);

  return (
    <div
      style={{
        display: "flex",
        height: "100vh",
        background: "var(--bg)",
        color: "var(--text-primary)",
        fontFamily: "var(--font-body)",
        overflow: "hidden",
      }}
    >
      {page === "onboarding" ? (
        <OnboardingPage onDone={() => setPage("preferences")} addToast={addToast} />
      ) : (
        <>
          <Nav page={page} onNav={setPage} />
          <main style={{ flex: 1, overflowY: "auto" }}>
            {page === "preferences" && <PreferencesPage addToast={addToast} />}
            {page === "statistics" && <StatisticsPage addToast={addToast} />}
          </main>
        </>
      )}

      <FsmBadge state={fsmState} />
      <ToastList toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
