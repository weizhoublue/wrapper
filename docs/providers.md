# Provider 交互原理与升级指南

## 概览

wrapper 通过统一的 `provider` 接口对接不同的 AI coding agent CLI 工具。已实现 claude、codex、copilot、gemini、cursor、agy、opencode。

本实现中参考了楼下项目的这个 Agent 对接方案
https://github.com/getpaseo/paseo

所有 provider 导出相同接口：

```javascript
createSession({ command, timeout, resume }) → session   // 创建会话
send(session, prompt) → { stdout, stderr, sessionId, exitCode }  // 发送消息
closeSession(session)                             // 关闭会话
```

即使用户通过 `-c` 自定义命令，provider 也会自动注入必需 flag（已有则不重复），保证非交互模式正常运行。

不指定 `-c` 时的默认命令：

```bash
# claude
claude --dangerously-skip-permissions --permission-mode=bypassPermissions

# codex
codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check

# copilot
copilot --acp --allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user

# gemini
gemini --acp --approval-mode=yolo --skip-trust

# cursor
agent --yolo --approve-mcps acp

# agy
agy --dangerously-skip-permissions 

# opencode
opencode run --dangerously-skip-permissions --format json
```

| Provider | 通信方式 | npm 依赖 | 自动注入 flag | Resume（`-s`） | 退出码来源 |
|----------|---------|----------|-------------|-----------------|-----------|
| Claude | Agent SDK | `claude-agent-sdk` | `--dangerously-skip-permissions`, `--permission-mode=bypassPermissions`（SDK option 同步设置） | `--resume <id>` CLI flag | `result.subtype === "success" ? 0 : 1` |
| Codex | spawn 子进程 + 二进制调用 NDJSON | 无 | `--json`, `--dangerously-bypass-approvals-and-sandbox`, `--skip-git-repo-check` | `exec resume <id>` 子命令 | 真实 OS 退出码 |
| Copilot | ACP | `agentclientprotocol/sdk` | `--acp`, `--allow-all-tools`, `--allow-all-paths`, `--allow-all-urls`, `--no-ask-user` | ACP `session/load` 协议方法 | `inferAcpExitCode()` + 子进程码 |
| Gemini | ACP | `agentclientprotocol/sdk` | `--acp`, `--approval-mode=yolo`, `--skip-trust` | ACP `session/load` 协议方法 | 同上 |
| Cursor | ACP | `agentclientprotocol/sdk` | `--yolo`, `--approve-mcps`, `acp` | ACP `session/load` 协议方法 | 同上 |
| agy | spawn 子进程 + log 提取 | 无 | `--dangerously-skip-permissions`, `--log-file`, `--print` | `--conversation <id>` CLI flag | 真实 OS 退出码 |
| opencode | spawn 子进程 + 二进制调用 NDJSON | 无 | `run`, `--format json`, `--dangerously-skip-permissions` | `--session <id>` CLI flag | 真实 OS 退出码 + JSON error 事件 |

## Claude

### CLI 工具

[Claude Code](https://docs.anthropic.com/en/docs/claude-code)（CLI 命令：`claude`）。

### SDK

| 项目 | 说明 |
|------|------|
| npm 包 | `@anthropic-ai/claude-agent-sdk` |
| 当前版本 | `^0.2.133`（见 `package.json`） |

### 必需 flag（自动注入）

`ensureFlags()` 在 `createSession` 时确保以下 flag 存在，即使用户通过 `-c` 自定义命令：

| flag | 作用 |
|------|------|
| `--dangerously-skip-permissions` | 跳过所有权限检查 |
| `--permission-mode=bypassPermissions` | 权限模式设为自动通过 |
| `--resume <id>`（由 `-s` 注入） | 恢复已有 session | 末尾 |

### Session Resume（`-s`）

Claude Code 通过 `--resume <id>` CLI flag 恢复 session。`ensureFlags` 检测到 `resume` 参数后追加 `["--resume", resume]` 到 args 末尾。SDK 层面无需特殊处理——SDK 的 `spawnClaudeCodeProcess` 直接将 args 传给 `claude` 进程，由 Claude CLI 负责恢复 session 上下文。

SDK 层面同步设置 `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true` 作为双保险。

### 交互原理

SDK 的 `query()` 函数负责 spawn Claude Code 进程，使用 **pipe（stdin/stdout）** 进行双向 JSON 流通信。

```
wrapper                            @anthropic-ai/claude-agent-sdk           claude 进程
  |                                      |                                    |
  |-- createAsyncMessageInput() -------->|                                    |
  |-- query({ prompt: input.iterable })->|                                    |
  |   pump: for await (msg of q) ------->|-- spawn claude (pipe) ----------->|
  |                                      |   stdin/stdout JSON stream         |
  |                                      |                                    |
  |-- input.push(userMessage) ---------->|-- 写入 stdin -------------------->|
  |   轮询 events 数组                   |<-- 读取 stdout --------------------|
  |   检测 result 事件                   |                                    |
  |<-- 提取 text / thinking / sessionId  |                                    |
  |                                      |                                    |
  |-- input.end() --------------------->|                                    |
  |-- q.close() ----------------------->|-- 关闭 pipe ---------------------->|
```

关键点：

- **不需要 PTY**——SDK 内部使用 pipe 管理子进程，输出是结构化 JSON 事件，不含 ANSI 转义序列
- **结构化事件**：`assistant`（含 content blocks）、`result`（含 subtype: success/error）、`thinking` 等
- **Session 复用**：同一 session 内可多次 `send()`，Claude 保留上下文记忆，用于重试循环
- **消息队列**：`createAsyncMessageInput()` 基于 Promise resolver 队列
- **文本提取**：`extractText` 优先取 assistant text blocks，无时用 `result.result` 兜底；`extractThinking` 取 thinking blocks
- **命令拆分**：`splitCommand()` 拆为 command + args，有 args 时用 `spawnClaudeCodeProcess` 自行 spawn
- **非交互模式**：`permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`（SDK option），外加 CLI flag `--dangerously-skip-permissions --permission-mode=bypassPermissions` 自动注入
- **超时**：main 每次 attempt 前重置 `session.deadline`（`-o` 秒）；send 轮询中检测 deadline

### 升级方式

```bash
npm install @anthropic-ai/claude-agent-sdk@latest
```

关注 SDK changelog 中 `query()` 签名、事件结构、option 行为的变化。验证：`npm test`。

## Codex

### CLI 工具

[OpenAI Codex CLI](https://github.com/openai/codex)（CLI 命令：`codex`）。当前版本：0.130.0。

### 为什么不用 ACP

Codex CLI **不支持 ACP**。Codex 的非交互模式是 `codex exec --json`，输出自研的 NDJSON 事件流。ACP 要求实现特定的 JSON-RPC handshake（`initialize` → `session/new` → `session/prompt`），Codex 不识别这些方法，收到 ACP 消息会直接退出（exit 202）。

Paseo 项目对 Codex 同样使用 spawn + NDJSON 方案（`CodexAppServerClient`），而非 ACP。两者的核心逻辑一致：**CLI 支持什么协议就用什么，不强套 ACP。**

| 对比 | wrapper | paseo |
|------|-------|-------|
| Codex 接口 | `codex exec --json`（单次命令） | `codex-app-server`（JSON-RPC server） |
| 传输层 | `readline` 解析 stdout NDJSON | 自定义 `CodexAppServerClient`，双向 JSON-RPC |
| 抽象模式 | 独立 provider | Direct 模式（与 Claude SDK、OpenCode 同属一类） |

### 交互原理

使用 `codex exec --json` 子命令进行非交互调用，通过 **spawn + NDJSON 解析** 通信。无 npm 依赖，仅用 Node.js 内置模块。

```
wrapper                                    codex exec 进程
  |                                           |
  |-- spawn("codex", ["exec",                 |
  |   "--json",                               |
  |   "--dangerously-bypass-approvals",       |
  |   "--sandbox", prompt]) ----------------> |
  |   stdin: "ignore"                         |
  |                                           |
  |   readline on stdout:                     |
  |<-- {"type":"thread.started", ...} --------|
  |<-- {"type":"turn.started"} ---------------|
  |<-- {"type":"item.completed",              |
  |     "item":{"type":"agent_message",       |
  |     "text":"Hi"}} ------------------------|
  |<-- {"type":"turn.completed", ...} --------|
  |                                           |
  |   进程退出 (close 事件)                     |
```

### 必需 flag（自动注入）

`ensureFlags()` 在 `createSession` 时检查 args 中是否含 `exec` 子命令，仅在 `codex exec` 场景下自动注入以下 flag（`codex --resume` 等其他模式不注入）：

| flag | 作用 | 注入位置 |
|------|------|---------|
| `--json` | NDJSON 格式输出（否则输出 ANSI 纯文本无法解析） | `exec` 之后 |
| `--dangerously-bypass-approvals-and-sandbox` | 跳过交互式权限确认（否则等待 stdin 输入导致 hang） | prompt 之前 |
| `--skip-git-repo-check` | 跳过 git 仓库检查 | prompt 之前 |
| `resume <id>`（由 `-s` 注入） | 恢复已有 session，插入在 `exec` 之后、`--json` 之前 | `exec` 之后 |

### Session Resume（`-s`）

Codex 通过 `codex exec resume <session_id>` 子命令实现 session resume。`ensureFlags` 检测到 `resume` 参数后在 `exec` 之后注入 `["resume", resume]`，生成 `codex exec resume <id> --json ... <prompt>`。`codex exec resume` 与普通 `codex exec` 一样输出 NDJSON 事件流，`thread.started` 返回的 `thread_id` 即为原 session ID。

### 关键实现细节

- **stdin 关闭**：`stdio: ["ignore", "pipe", "pipe"]`，立即给 codex EOF
- **NDJSON 解析**：`readline` 逐行读取 stdout，`JSON.parse` 解析每行事件
- **文本提取**：`extractText` 取 `item.completed` 事件中 `item.type === "agent_message"` 的 text
- **Thinking 提取**：`extractThinking` 取 `item.type === "reasoning"` 的 text
- **Session ID**：`extractSessionId` 取 `thread.started` 事件的 `thread_id`
- **超时**：main 每次 attempt 前重置 deadline；超时发 SIGTERM → 2s 后 SIGKILL

### 升级方式

```bash
codex --version  # 确认当前版本
# 按 Codex 官方文档更新 CLI 二进制
```

升级后关注 `codex exec --json` 输出事件格式是否变化（事件类型名、item.type 值、字段名）。

验证：
```bash
npm test                           # 单元测试
wrapper -t codex -p "hello" -d       # 实际调用
wrapper -t codex -c 'codex exec --sandbox read-only' -p "hello"  # 自定义 -c
```

## Copilot

### CLI 工具

[GitHub Copilot CLI](https://docs.github.com/en/copilot)（CLI 命令：`copilot`）。当前版本：1.0.48。

### 为什么用 ACP

Copilot CLI **原生支持 ACP**。`copilot --acp` 进入 ACP server 模式，监听 stdin/stdout 上的 JSON-RPC 2.0 / NDJSON 消息，按标准 ACP 协议进行 handshake、session 管理、streaming 和权限回调。因此直接使用 `@agentclientprotocol/sdk` 即可对接，无需自建传输层。

### SDK

| 项目 | 说明 |
|------|------|
| npm 包 | `@agentclientprotocol/sdk` |
| 当前版本 | `^0.21.1`（见 `package.json`） |
| 协议版本 | `PROTOCOL_VERSION = 1` |

### 退出码（ACP 共享，Copilot / Gemini / Cursor）

ACP prompt RPC 成功时，agent CLI 子进程通常仍在运行，**不会**自动把 shell 退出码交给 wrapper。`acp.js` 的 `inferAcpExitCode()` 为每次 prompt 推断 `exitCode`：

| 信号 | exitCode |
|------|----------|
| `stopReason !== end_turn`（如 `refusal`、`max_tokens`） | 1 |
| stdout/stderr 以 `Error:` 开头 | 1 |
| stdout/stderr **行首**命中该 provider 的 `LimitMsg` 模式 | 1 |
| 子进程在 session 期间退出 | 透传子进程码 |
| 否则 | 0 |

wrapper 的 `-q` 配额检测在 **`exitCode !== 0` 且全文命中 `LimitMsg`** 时才判定为 206，避免正常回答正文中偶现限额文案时误判。

### 交互原理

`copilot --acp` 进入 ACP（Agent Communication Protocol）服务器模式。`src/provider/acp.js` 使用 `@agentclientprotocol/sdk` 通过 **JSON-RPC 2.0 / NDJSON over stdin/stdout** 通信。

```
wrapper                     @agentclientprotocol/sdk         copilot --acp 进程
  |                              |                                    |
  |-- NonInteractiveClient ----->|                                    |
  |-- ndJsonStream() ----------->|                                    |
  |-- ClientSideConnection() --->|                                    |
  |                              |                                    |
  |-- connection.initialize() -->|-- {"id":1,"method":"initialize"} ->|
  |<-- initResult --------------|<- {"id":1,"result":{...}} ----------|
  |                              |                                    |
  |-- connection.newSession() -->|-- {"id":2,"method":"session/new"} >|
  |<-- sessionId ---------------|<- {"id":2,"result":{...}} ----------|
  |                              |                                    |
  |-- connection.prompt() ------>|-- {"id":3,"method":"session/prompt"}|
  |   (agent 执行过程中)         |<- {"method":"session/update",...} --|  (streaming)
  |   client.sessionUpdate()    |   (agent_message_chunk / tool_call) |
  |   client.requestPermission()|<- {"method":"requestPermission"...} |  (权限请求)
  |<-- promptResponse ----------|<- {"id":3,"result":{...}} ----------|
  |                              |                                    |
  |-- child.kill("SIGTERM") --->|-- 关闭 pipe ----------------------->|
```

### 必需 flag（自动注入）

`ensureFlags()` 在 `createSession` 时确保以下 flag 存在，即使用户通过 `-c` 自定义命令：

| flag | 作用 | 注入位置 |
|------|------|---------|
| `--acp` | 开启 ACP 服务器模式（否则进入交互式 TUI 导致 hang） | `copilot` 之后 |
| `--allow-all-tools` | 允许所有工具调用无需确认 | 末尾 |
| `--allow-all-paths` | 允许访问所有路径无需确认 | 末尾 |
| `--allow-all-urls` | 允许访问所有 URL 无需确认 | 末尾 |
| `--no-ask-user` | 不向用户提问 | 末尾 |

**注意**：Copilot 的 `--resume` CLI flag 仅在交互模式下有效，与 `--acp` 不兼容。Session resume 通过 ACP 协议原生方法实现，不以 CLI flag 形式注入。

### Session Resume（`-s`）

Copilot CLI v1.0.48 的 ACP 实现支持 `session/load` 协议（`loadSession` capability），但不支持 `session/resume`。因此 `-s` 指定时，`acp.js` 调用 `connection.loadSession({ sessionId, cwd, mcpServers })` 代替 `connection.newSession()`。

```
wrapper                     @agentclientprotocol/sdk         copilot --acp 进程
  |                              |                                    |
  |-- connection.initialize() -->|-- {"method":"initialize"} -------->|
  |<-- initResult --------------|<- {loadSession:true, ...} ----------|
  |                              |                                    |
  |  (resume 模式)                |                                    |
  |-- connection.loadSession() ->|-- {"method":"session/load"} ------>|
  |<-- ok ----------------------|<- {"result":{...}} ----------------|
  |                              |                                    |
  |  (new 模式)                   |                                    |
  |-- connection.newSession() -->|-- {"method":"session/new"} ------->|
  |<-- sessionId ---------------|<- {"result":{sessionId}} -----------|
```

### 关键实现细节

- **ClientSideConnection**：封装 JSON-RPC 请求/响应匹配
- **NonInteractiveClient**：实现 `Client` 接口
  - `sessionUpdate()`：收集 streaming 内容（agent_message_chunk / tool_call / agent_thought_chunk）
  - `requestPermission()`：非交互模式自动批准（找 `kind: "allow"` 的选项）
  - `readTextFile()` / `writeTextFile()`：允许 agent 读写文件系统
- **Session ID**：resume 模式下 session ID 保持原值不变，new 模式下由 `session/new` 返回
- **文本提取**：从 session_update notifications 和 prompt 响应中提取 text / thinking blocks
- **超时**：main 每次 attempt 前重置 deadline；send 时按剩余时间限制 prompt

### 升级方式

```bash
npm install @agentclientprotocol/sdk@latest
```

关注 `PROTOCOL_VERSION`、`ClientSideConnection` 签名、`Client` 接口变化。

验证：
```bash
npm test                                  # 单元测试
wrapper -t copilot -p "hello" -d            # 实际调用
wrapper -t copilot -c 'copilot --allow-all-tools' -p "hello"  # 自定义 -c
```

## Gemini

### CLI 工具

[Google Gemini CLI](https://github.com/google-gemini/gemini-cli)（CLI 命令：`gemini`）。当前版本：0.42.0。

### 为什么用 ACP

Gemini CLI **原生支持 ACP**。`gemini --acp` 进入 ACP server 模式，与 Copilot 使用完全相同的 ACP 协议。因此直接复用 `acp.js`，`gemini.js` 仅是一个注入 Gemini 特定 flag 的 thin wrapper（35 行）。

### SDK

| 项目 | 说明 |
|------|------|
| npm 包 | `@agentclientprotocol/sdk` |
| 当前版本 | `^0.21.1`（见 `package.json`） |
| 协议版本 | `PROTOCOL_VERSION = 1` |

### 交互原理

与 Copilot 完全一致，使用 `@agentclientprotocol/sdk` 通过 **JSON-RPC 2.0 / NDJSON over stdin/stdout** 通信。见 Copilot 章节的交互流程图。

### 必需 flag（自动注入）

`ensureFlags()` 在 `createSession` 时确保以下 flag 存在，即使用户通过 `-c` 自定义命令：

| flag | 作用 | 注入位置 |
|------|------|---------|
| `--acp` | 开启 ACP 服务器模式 | `gemini` 之后 |
| `--approval-mode=yolo` | 自动批准所有操作（非交互模式必需） | 末尾 |
| `--skip-trust` | 跳过工作区信任确认 | 末尾 |

**注意**：Gemini CLI 的 `--resume` CLI flag 仅在交互模式下有效，与 `--acp` 不兼容。Session resume 通过 ACP 协议原生方法实现，不以 CLI flag 形式注入。

### Session Resume（`-s`）

Gemini CLI v0.42.0 的 ACP 实现支持 `session/load` 协议。指定 `-s` 时，`acp.js` 调用 `connection.loadSession({ sessionId, cwd, mcpServers })`。Session ID 通过 ACP 响应返回，两次 `wrapper` 调用保持一致。

### 关键实现细节

- `gemini.js` 是 thin wrapper，复用 `acp.js` 的全部逻辑（`createSession`、`send`、`closeSession`）
- `ensureFlags` 支持 `=` 和空格两种 flag 格式，正确检测已有 flag 避免重复注入
- 其他 ACP 行为（`NonInteractiveClient`、文本提取、超时）共享 `acp.js`，无需重复实现

### 升级方式

```bash
gemini --version  # 确认当前版本
# 按 Gemini CLI 官方文档更新
```

升级后关注 Gemini CLI `--acp` 模式的行为变化（flag 名、ACP 能力支持）。

验证：
```bash
npm test                                    # 单元测试 + 集成测试
node --test test/provider/gemini.test.js    # Gemini 专用测试
wrapper -t gemini -p "hello" -d               # 实际调用
```

## Cursor

### CLI 工具

[Cursor Agent CLI](https://cursor.com/docs/cli/overview)（CLI 命令：`agent`，别名 `cursor-agent`）。

### 为什么用 ACP

Cursor CLI **原生支持 ACP**。默认以 `agent --yolo --approve-mcps acp` 启动：在 `acp` 子命令前注入 `--yolo`（放开命令/写文件/shell）与 `--approve-mcps`（自动批准 MCP），再经 JSON-RPC 与 wrapper 通信。Print 模式（`-p`）不用于 wrapper，因 session 管理依赖 ACP 的 `session/new` 与 `session/load`。

### SDK

| 项目 | 说明 |
|------|------|
| npm 包 | `@agentclientprotocol/sdk` |
| 协议版本 | `PROTOCOL_VERSION = 1` |

### 交互原理

与 Copilot/Gemini 相同，复用 `src/provider/acp.js`。`cursor.js` 为 thin wrapper，负责 `ensureFlags` 注入 `acp` 子命令并传入 `provider: "cursor"` 以启用 `CursorNonInteractiveClient`。

### 必需 flag（自动注入）

在 `acp` 子命令**之前**插入（若已有则跳过）：

| 注入 | 作用 |
|------|------|
| `--yolo` | 强制允许命令（Run Everything），便于写文件、跑 shell |
| `--approve-mcps` | 自动批准 MCP 服务器 |
| `acp` | 开启 ACP 服务器模式 |

示例：`agent` → `agent --yolo --approve-mcps acp`

**不注入** `--trust`（仅 print 模式有效）、`-p`（print 模式）。工具权限仍由 ACP `session/request_permission` + wrapper 自动批准兜底。

### Session Resume（`-s`）

指定 `-s` 时，`acp.js` 调用 `connection.loadSession({ sessionId, cwd, mcpServers: [] })`。不使用 CLI `--resume`（与 ACP 模式不兼容）。

### Cursor ACP 扩展（非交互）

| 方法 | 行为 |
|------|------|
| `cursor/ask_question` | 自动选每题第一个选项 |
| `cursor/create_plan` | 自动 `accepted` |
| `cursor/update_todos` | 通知，仅 debug 日志 |
| `cursor/task` | 通知，仅 debug 日志 |
| `cursor/generate_image` | 通知，仅 debug 日志 |

### 认证

假定用户已 `agent login` 或设置 `CURSOR_API_KEY`。Cursor ACP 在 `initialize` 后需调用 `authenticate({ methodId: "cursor_login" })` 完成协议握手（使用已有 CLI 凭证，不打开浏览器）。未登录时 `wrapAcpError` 返回可读提示（copilot/gemini 共用同一机制）。

### 升级方式

按 Cursor CLI 官方文档更新 `agent` 二进制；关注 ACP 扩展方法与 `session/load` 行为变化。

验证：

```bash
npm test
node --test test/provider/cursor.test.js
wrapper -t cursor -p "hello" -d
wrapper -t cursor -p "hi" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
wrapper -t cursor -s "$session" -p "what did I say?"
```

## OpenCode

### CLI 工具

[OpenCode](https://opencode.ai/)（CLI 命令：`opencode`）。

### 为什么用 run + JSON

OpenCode CLI 的 `opencode run` 支持非交互单次执行；加 `--format json` 后 stdout 按行输出 JSON 事件，每行含 `sessionID: "ses_..."`。与 Codex 类似，wrapper 每次 `send()` spawn 子进程、逐行解析 NDJSON，从 `type: "text"` 事件提取回答正文。模型与 `opencode run` 一致，由 OpenCode 自身配置决定，wrapper 不 hardcode 模型名。

### SDK

无 npm 依赖；直接 spawn `opencode` 子进程。

### 交互原理

每次 `send()` 执行 `opencode run ... <prompt>`。stdout 为 NDJSON 事件流；stderr 为 CLI 诊断输出。`extractText()` 拼接 `type: "text"` 的 `part.text`；`extractSessionId()` 读取事件中的 `sessionID`。

### 必需 flag（自动注入）

`ensureFlags()` 在 `createSession` 时确保：

| 注入 | 作用 |
|------|------|
| `run` | 非交互单次执行（否则进入 TUI） |
| `--format json` | NDJSON 事件流，含 sessionID |
| `--dangerously-skip-permissions` | 跳过权限确认 |

示例：`opencode` → `opencode run --format json --dangerously-skip-permissions`

### Session Resume（`-s`）

指定 `-s ses_...` 时，wrapper 注入 `--session <id>`（与 `opencode run --session` 一致）。Session ID 由 JSON 事件中的 `sessionID` 字段提供。

### 认证

假定用户已执行 `opencode auth login`（或 OpenCode 支持的等效登录）。未登录时 CLI 会报错，wrapper 透传 stderr 并以非零退出码结束。

### 升级方式

按 OpenCode CLI 官方文档更新 `opencode` 二进制；关注 `run --format json` 事件 schema 与 `--session` 行为变化。

验证：

```bash
npm test
node --test test/provider/opencode.test.js
# live API smoke (opt-in):
WRAPPER_OPENCODE_SMOKE=1 node --test test/provider/opencode.test.js
wrapper -t opencode -p "hello" -d
wrapper -t opencode -p "hi" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
wrapper -t opencode -s "$session" -p "what did I say?"
```

## agy

### CLI 工具

[Google Antigravity CLI](https://github.com/google/antigravity)（CLI 命令：`agy`）。

### 为什么不用 ACP

`agy` 暂不支持 ACP（Agent Client Protocol）。通过 `--print` 模式进行非交互式调用。

### 交互原理

使用 `agy` 命令行工具的 `--print` 模式，通过 **spawn + log 文件解析** 进行会话管理。无外部依赖，仅使用 Node.js 内置模块。

由于 `agy` 会在主线程阻塞并从 stdin 读取输入，因此在 spawn 时必须将 stdin 重定向（`stdio: ["ignore", "pipe", "pipe"]`），避免进程挂起。

```
wrapper                                           agy 进程
  |                                                  |
  |-- spawn("agy", ["--print",                       |
  |   "--dangerously-skip-permissions",              |
  |   "--log-file", "<os.tmpdir()>/agy_session_xxx.log", |
  |   prompt]) ------------------------------------> |
  |   stdin: "ignore"                                |
  |                                                  |
  |   等待进程退出                                      |
  |<-- 进程退出 -------------------------------------|
  |                                                  |
  |   读取 <os.tmpdir()>/agy_session_xxx.log 并匹配   |
  |   "Print mode: conversation=<id>"                |
  |   获取会话 ID，并异步删除临时日志文件              |
```

*注：`<os.tmpdir()>` 使用 Node.js 的 `os.tmpdir()` 获取，在 macOS 上通常指向 `/var/folders/.../T/`，在 Linux 上通常为 `/tmp/`。*

### 必需 flag（自动注入）

`ensureFlags()` 在 `createSession` 时确保以下 flag 存在，即使用户通过 `-c` 自定义命令：

| flag | 作用 | 注入位置 |
|------|------|---------|
| `--dangerously-skip-permissions` | 自动批准所有工具调用权限，避免交互式确认挂起 | 默认命令或 args |
| `--log-file <path>` | 重定向日志输出，用以提取会话 ID | 自动注入 |
| `--print` | 开启单次输出非交互模式（若无 `--prompt` 等模式则注入） | 自动注入 |

### Session Resume（`-s`）

`agy` 通过 `--conversation <id>` 命令行参数恢复之前的会话。
在 `send()` 执行时，若 `session.sessionId` 存在，则在 `spawn` 时动态拼装 `["--conversation", session.sessionId]`。同时，如果当前请求生成了新的会话 ID，会更新 `session.sessionId` 以保证后续重试的会话一致性。

### 关键实现细节

- **防止孤儿进程**：在 `send()` 入口处检查 `session.deadline`。若已超时，则直接返回超时结果，不执行 `spawn`。对于在执行中超时的进程，在触发超时后先执行 `child.kill("SIGTERM")`，2秒后执行 `child.kill("SIGKILL")` 终止孤儿进程。
- **即时清理**：移除任何人为的 `setTimeout` 延迟，进程关闭后立即读取日志文件并将其删除。在 `child.on("error")` 事件中，也安全清理日志文件。

### 验证：

```bash
npm test
node --test test/provider/agy.test.js
wrapper -t agy -p "hello" -d
wrapper -t agy -p "hi" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
wrapper -t agy -s "$session" -p "what did I say?"
```

## 添加新 Provider

1. 在 `src/provider/<name>.js` 创建文件，导出 `createSession`、`send`、`closeSession`
2. 如需要，在 `createSession` 中注入非交互模式必需 flag
3. 在 `src/main.js` 的 `DEFAULTS` 和 `providers` 中注册
4. 添加测试文件 `test/provider/<name>.test.js`
5. 更新本文档
