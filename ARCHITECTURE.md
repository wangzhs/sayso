# Architecture — Sayso

本文档描述 Sayso 的技术架构、关键设计决策和组件交互。

## 系统架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Sayso Desktop App                              │
│                         (Tauri v2: Rust + React)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Frontend   │  │   Backend    │  │   Platform   │  │   External   │     │
│  │   (React)    │  │    (Rust)    │  │    APIs      │  │    APIs      │     │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘     │
│         │                 │                 │                 │             │
│    Settings UI       Core Engine      Audio/Mic          STT/LLM           │
│    Statistics     ┌─────────────┐    ┌─────────┐      ┌──────────┐         │
│    Onboarding     │   5-State   │    │  cpal   │      │ OpenAI   │         │
│                   │    FSM      │    │         │      │ Groq     │         │
│                   └──────┬──────┘    └────┬────┘      │ etc.     │         │
│                          │                │            └──────────┘         │
│                   ┌──────┴──────┐    ┌────┴────┐                          │
│                   │  Recording  │    │  Audio  │                          │
│                   │  Pipeline   │    │ Capture │                          │
│                   └──────┬──────┘    └─────────┘                          │
│                          │                                                 │
│         ┌────────────────┼────────────────┐                                │
│         ▼                ▼                ▼                                │
│    ┌─────────┐     ┌──────────┐     ┌──────────┐                          │
│    │ Mode A  │     │  Mode B  │     │  Mode C  │                          │
│    │(Type)   │     │(Type+Send│     │(Command) │                          │
│    └────┬────┘     └────┬─────┘     └────┬─────┘                          │
│         │               │                │                                  │
│    ┌────┴────┐     ┌────┴────┐     ┌─────┴──────┐                         │
│    │ enigo   │     │ enigo   │     │  Safety    │                         │
│    │ CGEvent │     │ CGEvent │     │  Filter    │                         │
│    │Fallback │     │ + Enter │     │(Rule+LLM)  │                         │
│    └─────────┘     └─────────┘     └─────┬──────┘                         │
│                                          │                                  │
│                                    ┌─────┴──────┐                         │
│                                    │  Intent    │                         │
│                                    │  Parser    │                         │
│                                    └─────┬──────┘                         │
│                                          │                                  │
│                                    ┌─────┴──────┐                         │
│                                    │  Shell     │                         │
│                                    │  Executor  │                         │
│                                    │ (Direct)   │                         │
│                                    └────────────┘                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 核心组件

### 1. 有限状态机 (FSM)

文件: `src-tauri/src/fsm.rs`

```rust
pub enum FsmState {
    Idle,
    Recording { handle: RecordingHandle },
    SttWaiting { audio_data: Vec<u8> },
    Injecting { text: String },
    Done,
    Error { message: String },
}
```

状态转换规则：

| 从状态 | 触发条件 | 目标状态 |
|--------|----------|----------|
| Idle | 热键按下 | Recording |
| Recording | 热键释放 | SttWaiting |
| SttWaiting | STT 完成 | Injecting |
| SttWaiting | STT 失败 | Error |
| Injecting | 注入完成 | Done |
| Injecting | 注入失败 | Error |
| Done/Error | 重置 | Idle |

**关键设计**: 所有状态转换都是同步的，只有数据处理是异步的。这确保了 FSM 的线程安全性。

### 2. 音频子系统

文件: `src-tauri/src/audio.rs`

- **捕获**: 使用 `cpal` crate 进行跨平台音频捕获
- **格式**: 支持 f32 格式（i16/u16 需要额外处理）
- **降混**: 多声道音频自动平均为单声道
- **编码**: 录制完成后编码为 WAV 格式 (16 kHz, 16-bit, mono)

```rust
// 音频回调中执行降混
let sample_sum: f32 = data.iter().step_by(channels).sum();
let mixed_sample = sample_sum / channels as f32;
```

### 3. STT 客户端

文件: `src-tauri/src/stt.rs`

- **协议**: OpenAI `/audio/transcriptions` API 兼容
- **超时**: 120 秒（2×最大录音时长）
- **重试**: 无（fail-fast，错误通过 Toast 通知）

### 4. LLM 客户端

文件: `src-tauri/src/llm.rs`

共享 HTTP 客户端供三个组件使用：

1. **TextPolisher**: 润色语音转录文字（可选，Mode A/B）
2. **SafetyFilter**: 命令语义安全检查（Mode C）
3. **IntentParser**: 解析自然语言为结构化命令（Mode C）

超时设置：
- 普通请求: 15 秒
- 命令执行: 30 秒

### 5. 文字注入器

文件: `src-tauri/src/injector.rs`

两层注入策略：

```rust
pub enum InjectStrategy {
    Enigo,      // 首选：跨平台 keystroke 模拟
    Clipboard,  // 回退：剪贴板 + 粘贴
}
```

**macOS 特有**: CGEvent 回退，用于处理某些不支持 enigo 的应用。

**焦点检查**: 注入前检查当前窗口是否与热键释放时一致，防止文字注入到错误窗口。

**剪贴板策略**: 不回恢复原剪贴板内容（设计决策，避免数据竞争风险）。

### 6. 安全过滤器

文件: `src-tauri/src/safety.rs`

两层安全架构：

```
┌─────────────────────────────────────────────────────────┐
│                    Safety Pipeline                      │
├─────────────────────────────────────────────────────────┤
│  Layer 1: Rule-based Filter (O(1))                     │
│  - Block list: rm -rf /, mkfs.*, dd if=/dev/zero, etc. │
│  - Allow list: ls, cat, pwd, git status, etc.          │
│                                                         │
│  Layer 2: LLM Semantic Filter                          │
│  - Gray-zone commands sent to LLM for judgment         │
│  - Fail-closed: LLM unavailable → reject               │
└─────────────────────────────────────────────────────────┘
```

### 7. 命令执行器

文件: `src-tauri/src/executor.rs`

**安全设计**: 直接执行程序，不通过 shell

```rust
// 安全：直接执行，无 shell 注入风险
let output = tokio::process::Command::new(&program)
    .args(&args)
    .kill_on_drop(true)  // 超时后自动终止
    .output()
    .await?;
```

参数解析使用 `shell-words` crate 处理带引号的参数（如路径含空格）。

**PATH 处理**: 自动补全常见路径（`/opt/homebrew/bin`, `/usr/local/bin` 等），解决从 Finder 启动时缺少 PATH 的问题。

### 8. 统计数据

文件: `src-tauri/src/stats.rs`

存储于 `~/Library/Application Support/com.sayso.app/stats.json`：

```json
{
  "total_sessions": 100,
  "total_chars": 50000,
  "total_words": 8000,
  "speaking_time_seconds": 3600,
  "time_saved_seconds": 7200,
  "commands_executed": 50,
  "last_updated": "2026-03-23T12:00:00Z"
}
```

**内存缓存**: 启动时加载到内存，更新时先写内存再异步刷盘。

## 数据流

### Mode A: 录音 → 打字

```
Hotkey Press ──┐
               ▼
┌────────────────────────────────────────────────────────────┐
│  1. FSM: Idle → Recording                                   │
│     - Start cpal audio stream                               │
│     - Begin capturing samples                               │
└────────────────────────────────────────────────────────────┘
               │
Hotkey Release ▼
┌────────────────────────────────────────────────────────────┐
│  2. FSM: Recording → SttWaiting                             │
│     - Stop audio stream                                     │
│     - Encode to WAV                                         │
│     - Send to STT API                                       │
└────────────────────────────────────────────────────────────┘
               │
STT Response   ▼
┌────────────────────────────────────────────────────────────┐
│  3. FSM: SttWaiting → Injecting                             │
│     - Receive transcribed text                              │
│     - Optional: TextPolisher (if enabled)                   │
│     - Inject text via enigo/CGEvent                         │
└────────────────────────────────────────────────────────────┘
               │
Injection Done ▼
┌────────────────────────────────────────────────────────────┐
│  4. FSM: Injecting → Done → Idle                            │
│     - Update stats (chars, words, speaking time)            │
│     - Show success toast                                    │
└────────────────────────────────────────────────────────────┘
```

### Mode C: 录音 → 命令执行

```
STT Response   ▼
┌────────────────────────────────────────────────────────────┐
│  1. Intent Parsing                                          │
│     - Send text to LLM for intent extraction                │
│     - Receive {"command": "...", "description": "..."}      │
└────────────────────────────────────────────────────────────┘
               │
┌────────────────────────────────────────────────────────────┐
│  2. Safety Filter (Rule + LLM)                              │
│     - Layer 1: Check allow/block lists                      │
│     - Layer 2: LLM semantic judgment (if gray-zone)         │
└────────────────────────────────────────────────────────────┘
               │
┌────────────────────────────────────────────────────────────┐
│  3. Command Execution                                       │
│     - Parse command with shell-words                        │
│     - Execute with 30s timeout                              │
│     - Capture stdout/stderr                                 │
└────────────────────────────────────────────────────────────┘
               │
┌────────────────────────────────────────────────────────────┐
│  4. Result Notification                                     │
│     - Show toast with command output (truncated)            │
│     - Update stats                                          │
└────────────────────────────────────────────────────────────┘
```

## 关键设计决策

### 1. 为什么选择 Tauri v2？

- **安全性**: Rust 的内存安全保证
- **性能**: 原生二进制，无 Electron 的内存开销
- **体积**: 应用包体积小（~10MB vs Electron 的 ~100MB）
- **系统集成**: 轻松访问系统 API（Keychain、全局热键、音频）

### 2. 为什么不使用剪贴板恢复？

设计决策：**不回恢复原剪贴板内容**

原因：
- 避免数据竞争（用户可能在注入期间操作剪贴板）
- 简化实现
- 剪贴板回退本身已是边缘情况

### 3. 为什么直接执行而非 shell？

```rust
// 危险：通过 shell 执行
tokio::process::Command::new("sh")
    .arg("-c")
    .arg(user_input)  // CVE-2024-24576 注入风险

// 安全：直接执行程序
let args = shell_words::split(user_input)?;
let program = &args[0];
let program_args = &args[1..];
tokio::process::Command::new(program)
    .args(program_args)
```

权衡：不支持管道、重定向、shell 内置命令。覆盖 95% 的语音命令场景。

### 4. 为什么使用 JSON 而非 SQLite？

统计数据使用 JSON 文件存储：

- **隐私**: 用户可以直接查看/删除自己的数据
- **透明**: 无需工具即可读取
- **简单**: 足够满足统计数据需求
- **无依赖**: 无需 SQLite 库

### 5. Fail-Closed 安全模型

在 Mode C 中，所有安全检查都是 fail-closed：

| 检查点 | 失败行为 |
|--------|----------|
| 规则过滤器 | 拒绝执行 |
| LLM 安全检查 | 拒绝执行 |
| Intent 解析失败 | 拒绝执行 |
| 命令执行超时 | 终止进程，返回错误 |

安全 > 便利性。

## 错误处理

所有错误通过 `SaysoError` 枚举表示：

```rust
pub enum SaysoError {
    Audio(String),
    Stt(String),
    Llm(String),
    Injection(String),
    SafetyViolation(String),
    Execution(String),
    Config(String),
    // ...
}
```

错误通过 Tauri event 发送到前端显示 Toast 通知。

## 测试策略

### 单元测试 (33 个)

```bash
cd src-tauri
cargo test
```

覆盖：
- FSM 状态转换
- 安全过滤器规则匹配
- LLM 客户端超时处理
- Intent 解析 JSON 验证
- 命令执行参数解析
- 文字润色 fallback
- STT 响应解析
- 音频编码 WAV 格式
- 统计数据计算

### 集成测试

- 热键 → 录音 → STT → 注入完整流程
- 需要在有麦克风的环境中手动验证

### E2E 测试

v1.1 后通过 Playwright 测试关键用户流程。

## 性能考虑

### 内存使用

- 音频数据: 最大 60s × 16kHz × 2bytes ≈ 1.9MB
- 统计数据: 常驻内存，<1KB
- HTTP 客户端: 共享 `reqwest::Client`，连接池复用

### 启动时间

- Rust 二进制: <100ms
- React 前端: 由 Tauri 加载，<50ms
- 总启动时间: <1s（包括配置加载、Keychain 读取）

### 热键响应

热键处理在专用线程进行，延迟 <10ms。

## 安全边界

```
┌─────────────────────────────────────────────────────────┐
│                    安全边界                              │
├─────────────────────────────────────────────────────────┤
│  Untrusted                                              │
│  ┌──────────────────────────────────────────────────┐  │
│  │  - User voice input                              │  │
│  │  - STT API response                              │  │
│  │  - LLM API response                              │  │
│  └──────────────────────────────────────────────────┘  │
│                          │                              │
│                          ▼                              │
│  ┌──────────────────────────────────────────────────┐  │
│  │  SafetyFilter (Rule + LLM)                       │  │
│  └──────────────────────────────────────────────────┘  │
│                          │                              │
│  Trusted                  ▼                             │
│  ┌──────────────────────────────────────────────────┐  │
│  │  - Shell execution                               │  │
│  │  - Keystroke injection                           │  │
│  │  - File system access (stats.json)               │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

所有外部输入（语音转录、LLM 输出）都经过安全检查后才执行敏感操作。
