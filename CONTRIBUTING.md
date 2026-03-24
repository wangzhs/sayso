# Contributing to Sayso

感谢你对 Sayso 的兴趣！本文档将帮助你快速搭建开发环境并开始贡献。

## 项目概述

Sayso 是一个基于 Tauri v2（Rust + React）的桌面应用，支持 macOS 和 Windows。它是一个语音键盘 + 命令执行器：按住热键，说话，松开后文字会被注入到当前应用，或执行 shell 命令。

## 开发环境要求

### 必需工具

- **Rust** (最新稳定版): https://rustup.rs/
- **Node.js** (v18+): https://nodejs.org/
- **Tauri CLI**: `cargo install tauri-cli`

### macOS 特有要求

- **Xcode Command Line Tools**: `xcode-select --install`
- 辅助功能权限（运行时会自动请求）
- 麦克风权限（运行时会自动请求）

### Windows 特有要求

- **Microsoft Visual Studio C++ Build Tools**
- **WebView2** (Windows 10/11 通常已预装)

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/yourusername/sayso.git
cd sayso

# 2. 安装前端依赖
npm install

# 3. 启动开发服务器
npm run tauri dev
```

开发服务器启动后：
- Rust 编译会自动进行
- 前端开发服务器运行在 http://localhost:1420
- Tauri 窗口会自动打开

## 项目结构

```
sayso/
├── src/                    # React 前端代码
│   ├── App.tsx            # 主应用组件
│   └── index.css          # 全局样式
├── src-tauri/             # Rust 后端代码
│   ├── src/               # Rust 源代码
│   │   ├── main.rs        # 应用入口
│   │   ├── audio.rs       # 音频捕获
│   │   ├── fsm.rs         # 状态机 (5-state FSM)
│   │   ├── stt.rs         # STT HTTP 客户端
│   │   ├── llm.rs         # LLM HTTP 客户端
│   │   ├── safety.rs      # 命令安全过滤器
│   │   ├── executor.rs    # Shell 命令执行器
│   │   ├── injector.rs    # 文字注入 (enigo + CGEvent)
│   │   ├── intent.rs      # 意图解析器
│   │   ├── polish.rs      # 文字润色
│   │   ├── stats.rs       # 统计数据
│   │   └── config.rs      # 配置管理
│   └── Cargo.toml         # Rust 依赖
├── CHANGELOG.md           # 版本历史
├── DESIGN.md              # 设计系统文档
├── TODOS.md               # 待办事项
└── CLAUDE.md              # 项目开发指南
```

## 开发工作流

### 运行测试

```bash
# 运行 Rust 单元测试 (共 33 个测试)
cd src-tauri
cargo test

# 运行前端测试
npm test
```

### 构建发布版本

```bash
# 构建 macOS 应用
npm run tauri build -- --target universal-apple-darwin

# 构建 Windows 应用
npm run tauri build -- --target x86_64-pc-windows-msvc
```

构建产物位于 `src-tauri/target/release/bundle/`。

### 代码风格

- **Rust**: 使用 `cargo fmt` 格式化，`cargo clippy` 检查
- **TypeScript**: 使用项目配置的 Prettier 格式化

## 配置开发环境

### STT 和 LLM API 配置

首次启动时，应用会显示配置向导。你也可以手动编辑配置文件：

**macOS**: `~/Library/Application Support/com.sayso.app/config.json`
**Windows**: `%APPDATA%\sayso\config\config.json`

示例配置：

```json
{
  "stt_config": {
    "endpoint": "https://api.openai.com/v1/audio/transcriptions",
    "api_key_reference": "openai_stt_key",
    "model": "whisper-1"
  },
  "llm_config": {
    "endpoint": "https://api.openai.com/v1/chat/completions",
    "api_key_reference": "openai_llm_key",
    "model": "gpt-4o"
  },
  "voice": {
    "mode_a_hotkey": "Option+Space",
    "mode_b_hotkey": "Option+Enter",
    "mode_c_hotkey": "Option+Period",
    "polish_enabled": false
  },
  "ui": {
    "language": "zh-CN"
  }
}
```

API 密钥存储在系统 Keychain 中，不会写入配置文件。

### 查看日志

**macOS**:
```bash
tail -f ~/Library/Logs/sayso/sayso.log
```

**Windows**:
```powershell
Get-Content "$env:APPDATA\sayso\logs\sayso.log" -Wait
```

## 架构要点

### 5 状态 FSM

应用核心是一个有限状态机：

```
IDLE → RECORDING → STT_WAITING → INJECTING → DONE
                ↓
              ERROR
```

所有状态转换都在 `src-tauri/src/fsm.rs` 中实现。

### 安全过滤器

命令模式（Mode C）有两层安全检查：

1. **规则层**: O(1) 检查危险命令模式（如 `rm -rf ~`）
2. **LLM 语义层**: 解析意图后由 LLM 判断命令风险

安全过滤是**fail-closed**的——如果 LLM 不可用，命令会被拒绝。

### 命令执行

使用 `std::process::Command` 直接执行程序（不通过 `/bin/sh`），防止 CVE-2024-24576 类命令注入。

## 贡献指南

### 报告 Bug

1. 检查是否已有相关 Issue
2. 提供重现步骤
3. 附上日志文件（路径见上文）
4. 说明操作系统版本

### 提交 Pull Request

1. Fork 仓库并创建特性分支
2. 确保测试通过 (`cargo test`)
3. 更新相关文档
4. 提交 PR 并描述变更内容

### 代码审查清单

- [ ] 是否处理了错误情况？
- [ ] 是否更新了单元测试？
- [ ] 是否检查了 FSM 状态转换的合法性？
- [ ] 新增 API 调用是否有适当的超时设置？

## 设计系统

修改 UI 前请阅读 `DESIGN.md`：

- 仅深色模式 (`#161616` 背景)
- 强调色：`#EF4444`（红色）
- 字体：Space Grotesk + DM Sans + JetBrains Mono
- 无可见边框，使用色调分层

## 常见问题

### Q: macOS 上出现 "无法打开应用，因为无法验证开发者"
A: 这是预期行为——v0.1.0 未签名。右键点击应用 → 打开 → 再次确认。

### Q: 文字注入不工作
A: 检查系统设置 → 隐私与安全 → 辅助功能 → 添加并启用 Sayso。

### Q: 热键无响应
A: 检查是否有其他应用占用了相同热键（如 Raycast、Alfred）。

## 获取帮助

- 查看 [TODOS.md](TODOS.md) 了解当前优先级
- 查看 [CHANGELOG.md](CHANGELOG.md) 了解最新变更
- 在 GitHub Issues 中提问

## 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件
