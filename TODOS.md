# Sayso — TODOS

> Items deferred from /plan-ceo-review. Pick up in order of priority.

---

## P1

### [TODO-1] Settings 页加入「测试 API」按钮

**What:** STT Config 和 LLM Config 两个设置页，各加一个「Test Connection」按钮，点击后发一个最小请求验证 endpoint + key 是否可用。

**Why:** 新用户配置错误是最常见的上手障碍。当前设计文档中用户填完配置后只能通过真实录音才知道配置是否正确，错误反馈循环太长。

**Pros:** 把配置错误的反馈循环从"录音后才发现"缩短为几秒；降低新用户放弃率。

**Cons:** 需要额外实现一个最小 API 调用路径（STT 发一个空白音频，LLM 发一个 ping 消息）。

**Context:** 属于 Phase 3（Settings UI）的一部分。STT 测试：发一个 0.3s 空白 WAV；LLM 测试：发 `{"messages": [{"role": "user", "content": "ping"}], "max_tokens": 5}`，成功返回任意响应即视为可用。

**Effort:** S (human) → XS (CC)
**Depends on:** Phase 3 Settings UI 基础实现完成

---

## P2

### [TODO-2] 首次启动引导页 UI 设计

**What:** 设计并实现首次启动欢迎引导页——按步骤引导用户配置 STT API 和 LLM API，以及授权辅助功能权限（macOS）。

**Why:** 对非技术用户而言，首次配置体验决定软件的留存率。当前设计文档只说"配置文件不存在时显示欢迎引导页"但无具体设计。

**Pros:** 减少非技术用户上手摩擦；引导用户完成关键配置步骤（API key + 权限）。

**Cons:** 需要额外设计 onboarding 流程和 UI；增加 Phase 3 工作量。

**Context:** 引导页至少包含 3 个步骤：(1) 欢迎 + 说明 (2) 配置 STT API (3) 配置 LLM API + 辅助功能权限授权。配合 TODO-1 的 Test Connection 按钮使用效果更好。

**Effort:** M (human) → S (CC)
**Priority:** P2 | **Depends on:** Phase 3 基础 Settings UI

---

### [TODO-3] Homebrew Cask 发布渠道

**What:** v1 发布后，提交 sayso 到 Homebrew Cask，让用户可以 `brew install --cask sayso` 安装。

**Why:** 对于开源开发工具，Homebrew 是 macOS 开发者群体最主要的发现渠道。相比直接下载 .dmg，Homebrew 安装不需要手动绕过 Gatekeeper（已签名的 cask 会自动处理），且开发者社区对 Homebrew 工具有更高的信任度和传播意愿。

**Pros:** 解决 Gatekeeper 摩擦（无需公证）；进入 Homebrew 生态系统；开发者群体自然发现和传播。

**Cons:** 需要 PR 到 homebrew-cask 仓库；每次版本更新需要更新 cask formula（可通过 GitHub Actions 自动化）。

**Context:** 需要发布带 SHA256 校验的 .dmg 文件。GitHub Actions 在 release 时自动计算 SHA256 并提交 cask 更新。参考：`brew install --cask raycast` 模式。

**Effort:** S (human) → XS (CC)
**Priority:** P2 | **Depends on:** Phase 4 打包发布完成

---

## 实现注意事项（来自 CEO Review 安全/架构分析）

以下是 CEO Review 发现的实现细节，不需要 TODO 追踪但必须在实现时处理：

1. **RecordingFSM 并发快捷键：** PROCESSING 状态下再次按键 → 显示 Toast "正在处理中，请稍候" + 忽略
2. **灰色地带 LLM 不可用：** Fail-closed。LLM 安全检查失败 → 拒绝命令 + Toast "已拒绝：安全检查不可用"
3. **ShellExecutor 超时：** 默认 30 秒，超时后 Toast "命令执行超时"
4. **STT 响应解析失败：** Toast "响应解析失败（格式错误）"
5. **TextInjector 焦点丢失：** 注入时焦点已切换 → Toast "注入失败：焦点已改变"
6. **剪贴板回退策略：** 使用剪贴板 fallback 时，**不恢复**原剪贴板内容（简化实现，避免数据竞争风险）
7. **API key 绝不写入日志：** Rust 日志中屏蔽 Authorization header 内容
8. **ShellExecutor 工作目录：** 使用用户 $HOME，不是 app 的工作目录
9. **Tauri 版本：** 必须使用 Tauri v2（不是 v1）
10. **日志位置：** macOS: `~/Library/Logs/sayso/sayso.log`，Windows: `%APPDATA%\sayso\logs\sayso.log`

以下是 Eng Review 新增的实现细节：

11. **LLM 文字润色（可选开关）：** 仅 Mode A/B 启用。Mode C 跳过润色直接进 CommandEngine。润色失败（LLM 不可用或返回格式错误）→ fallback 到原始文字 + Toast "润色失败，使用原始文字"
12. **HttpApiClient 共享实例：** STTClient、TextPolisher、IntentParser 三者共用一个 `reqwest::Client`（存于 Tauri state，`Arc<HttpApiClient>`）。不要每次请求都新建 Client
13. **Keychain 读取缓存：** 启动时读取一次 API key 存入内存（Tauri state）。Settings 变更时刷新缓存。避免每次按键都访问 Keychain
14. **TextPolisher 禁用时：** 直接透传 raw_text，不发起任何 LLM 调用
15. **统计数据持久化：** 使用 Tauri 的 `app_local_data_dir()` 存储 **JSON 文件**（不用 SQLite，保护隐私）。路径：macOS `~/Library/Application Support/com.sayso.app/stats.json`
16. **统计数据界面位置：** 作为独立窗口从 Menu Bar 图标下拉菜单打开（"查看统计"），或在 Settings 页增加 "Statistics" Tab
17. **协作次数计算：** 每次成功完成一次语音输入流程（录音→STT→注入/执行）计为 1 次。无论文字长度或是否成功注入，只要 STT 返回有效文本即计数
18. **累计口述时间：** 累加每次录音的实际时长（按下热键到释放的时间），精确到秒。存储为总秒数，界面显示转换为 "X小时Y分钟"
19. **口述字数：** 累加每次 STT 返回文本的字符数（char count，非 byte count）。中文按字计数，英文按单词计数（whitespace 分隔）。存储原始文本字数（润色前的 raw_text）
20. **节省时间计算：** 公式 `saved_seconds = total_chars / avg_typing_speed_wpm * 60 - total_speaking_time`。avg_typing_speed_wpm 取 40（中等打字速度）。若结果为负则显示为 0
21. **决策点计数：** 仅统计 Mode C（命令模式）中需要用户确认的决策点，包括：(a) 模糊意图选择 (b) 危险命令确认 (c) 多步骤命令的中间确认。每个确认对话框弹出即计数 +1
22. **统计数据内存缓存：** 启动时加载全部统计数据到内存（Tauri state），每次更新时先写内存再异步刷盘，避免高频写入导致磁盘 IO 瓶颈
23. **统计数据重置：** 界面提供 "重置统计数据" 按钮，需二次确认。重置后所有计数归零但保留历史记录文件（备份命名为 stats.db.bak.YYYYMMDD）
24. **统计数据导出：** 支持导出为 CSV 格式（日期,协作次数,口述时间,字数,节省时间），便于用户自行分析

---

## P2（新增）

### [TODO-4] 命令执行方式决策

**What:** 确定 Mode C（命令模式）的 Shell 命令执行方式：直接执行程序 vs 通过 shell 执行。

**Why:** 关系到 CVE-2024-24576 安全风险（Windows 命令注入，CVSS 10/10）。直接执行程序更安全但不支持管道/重定向；通过 shell 更灵活但需要严格的转义和沙箱。

**Pros:** 明确安全边界，避免实现到一半发现架构问题。

**Cons:** 需要权衡功能灵活性和安全性。

**Context:** 用户说"还没想好"，需要后续决策。建议 v1 用直接执行，明确限制不支持管道，覆盖 95% 场景。

**Effort:** N/A（架构决策）
**Priority:** P2 | **Depends on:** Phase 2 开始前必须决定

---

## Eng Review 决策记录

以下决策来自 Eng Review 讨论：

| # | 问题 | 决策 |
|---|------|------|
| 1 | 命令执行方式 | 待决策（放入 TODO-4） |
| 2 | Recording FSM 状态机 | **5状态+错误**：IDLE→RECORDING→STT_WAITING→INJECTING→DONE + ERROR |
| 3 | 剪贴板 fallback 恢复策略 | **不恢复**原剪贴板内容 |
| 4 | 命令模式 3 次 API 延迟 | **接受现状**，v1 不做流式，v2 再考虑优化 |
| 5 | 统计数据存储格式 | **JSON** 本地存储，不用 SQLite，保护用户隐私 |

---

## 测试策略（来自 Eng Review）

### 关键测试用例

```rust
// 1. FSM 状态机测试
#[test]
fn test_fsm_invalid_transition() {
    // IDLE -> INJECTING 应该是非法转移
}

// 2. 安全过滤器测试
#[test]
fn test_safety_filter_blocks_rm_rf() {
    assert!(safety_filter.is_dangerous("rm -rf ~"));
}

// 3. STT 超时测试
#[test]
fn test_stt_timeout_returns_error() {
    // 模拟 5s 超时
}

// 4. 剪贴板 fallback 测试
#[test]
fn test_clipboard_inject() {
    // 验证剪贴板内容被正确写入
}
```

### 测试覆盖率目标

- Unit tests: 80%+
- Integration tests: 核心流程（快捷键→录音→STT→注入）
- E2E tests: 可延后到 v1.1

---

## Codex 对抗审查修复记录（2026-03-23）

### 已修复

| # | 级别 | 问题 | 修复说明 |
|---|------|------|----------|
| 1 | P1 | FSM 错误路径不发送状态事件到前端 | `run_pipeline` 所有错误路径现在都发 `emit_fsm_state` → Error/Idle |
| 2 | P1 | 多声道音频不降混为单声道 | audio.rs 回调中按 channels 数平均所有声道 |
| 3 | P1 | 命令超时后子进程不被杀死 | executor.rs 改用 `tokio::process::Command` + `kill_on_drop(true)` |
| 4 | P1 | 安全过滤器运行在原始语音文本上而非解析后的命令 | main.rs 中 LLM 安全检查移到 intent 解析之后，运行在 `intent.command` 上 |
| 5 | P1 | 注入前无焦点完整性检查（`InjectorFocusLost` 从未使用） | 热键释放时捕获当前窗口，注入前对比，焦点变化返回 `InjectorFocusLost` |
| 6 | P2 | STT 超时仅 5 秒，但录音可长达 60 秒 | 改为 120 秒（2× 最大录音时长） |
| 7 | P2 | `split_whitespace` 不支持带引号的参数（如路径含空格） | 改用 `shell-words` crate 解析参数 |
| 8 | P2 | Finder 启动的 app 缺少 Homebrew/开发工具 PATH | executor.rs 自动补全 `/opt/homebrew/bin` 等常见路径 |
| 9 | P2 | 渲染进程拥有 `shell:allow-execute/kill/stdin-write` + CSP=null | 从 capabilities/default.json 移除 shell 权限；tauri.conf.json 加入严格 CSP |
| 10 | P2 | 音频设备格式不支持时报错"设备未找到" | 改为明确报错"不支持的 f32 音频格式" |

### 已验证（Codex 指出但代码已正确处理）

| # | 级别 | Codex 的描述 | 实际情况 |
|---|------|-------------|---------|
| 1 | P1 | `reset()` 只允许 Done/Error → Idle，Mode C 会死锁 | `reset()` 是无条件的，不受状态机守卫限制；FSM 测试覆盖此路径 |
| 2 | P1 | config.json 损坏会触发 panic | `load_all()` 失败时 `unwrap_or_else` 回退到默认配置，不 panic |

### 已确认为设计取舍（不修改）

| # | 级别 | 问题 | 取舍说明 |
|---|------|------|---------|
| 1 | P2 | Accessibility 权限无 preflight 检查 | Enigo + macOS entitlement 模型会在首次调用时自动触发系统权限弹窗；后续版本可加 `AXIsProcessTrusted()` 预检 |
| 2 | P2 | 剪贴板 fallback 不恢复原内容 | 设计决策（见实现注意事项 #6）：避免数据竞争风险 |
| 3 | P2 | `unsafe impl Send for RecordingHandle` | 有注释说明：Mutex 保证独占访问，cpal 音频线程由 OS 管理，实际安全 |
| 4 | P2 | 设置页"测试连接"测的是已保存配置而非未保存字段 | UX 问题，记入 TODO 待 Phase 3 Settings UI 改进时修复 |
| 5 | P2 | i16/u16 格式设备不支持 | 已改善错误信息；完整 i16/u16 支持需要重构 build_input_stream，延后 |
