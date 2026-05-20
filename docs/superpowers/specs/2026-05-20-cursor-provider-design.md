# Cursor Provider（ACP）设计

## 目标

为 wrapper 新增 **Cursor Agent CLI**（`agent`）provider，通过 **ACP** 非交互调用，满足：

1. 一次性执行 prompt 并退出（与现有 provider 一致）
2. **可靠获取 `sessionId`**，写入 stderr 最后一行
3. 通过 `-s <sessionId>` **跨进程恢复会话**（`session/load`）
4. 同进程内 **重试复用同一 session**（现有 retry 循环）

## 背景与约束

- Cursor CLI 支持 ACP：`agent acp`，JSON-RPC 2.0 / NDJSON over stdio（[ACP 文档](https://cursor.com/cn/docs/cli/acp)）
- Print 模式（`--yolo --trust --approve-mcps -p`）**不采用**：session 管理与 resume 以 ACP 为准
- 认证：假定用户已 `agent login` 或配置 `CURSOR_API_KEY`；Cursor ACP 在 `initialize` 后调用 `authenticate({ methodId: "cursor_login" })` 完成握手（非交互，复用 CLI 凭证）
- 未登录失败时，**cursor / copilot / gemini** 三个 ACP provider 应给出明确、可操作的报错提示

## 已确认决策

| 项 | 决策 |
|----|------|
| 集成方式 | ACP（`agent acp`） |
| 实现路径 | **方案 1**：`cursor.js` thin wrapper + 增强共享 `acp.js` |
| Provider 名 | `-t cursor` |
| 默认命令 | `agent --yolo --approve-mcps acp` |
| Cursor 扩展方法 | 非交互自动通过（`ask_question` 选首项，`create_plan` accepted） |
| 认证 | 假定已登录；`cursor_login` ACP 握手；失败时统一 auth 错误提示 |
| Resume | ACP `session/load`（不用 CLI `--resume`，与 `--acp` 不兼容） |

## 架构

```
wrapper (main.js)
    │
    ▼
cursor.js          ensureFlags → "agent --yolo --approve-mcps acp"
    │
    ▼
acp.js             spawn + ClientSideConnection
    │              CursorNonInteractiveClient (cursor only)
    │
    ▼
agent --yolo --approve-mcps acp   initialize → authenticate → session/new|load → session/prompt
```

### 会话流程

1. `createSession`：spawn `agent --yolo --approve-mcps acp`，`initialize`，`authenticate(cursor_login)`
2. 无 `-s`：`session/new` → 得到 `sessionId`
3. 有 `-s`：`session/load({ sessionId, cwd, mcpServers: [] })` → 保持原 id
4. `send`：`session/prompt`，收集 `session/update` 流式内容
5. `closeSession`：SIGTERM 子进程
6. stderr 最后一行输出 `sessionId`（main.js 现有逻辑）

### 与现有 provider 对齐

| Provider | 通信 | Resume |
|----------|------|--------|
| copilot | ACP | `session/load` |
| gemini | ACP | `session/load` |
| **cursor** | ACP | `session/load` |
| claude | SDK | `--resume` CLI flag |
| codex | NDJSON | `exec resume <id>` |

## 文件变更

| 文件 | 改动 |
|------|------|
| `src/provider/cursor.js` | **新建**：`ensureFlags`、委托 `acp.createSession/send/closeSession` |
| `src/provider/acp.js` | Cursor 扩展 Client；auth 错误检测与提示（全 ACP provider） |
| `src/main.js` | `DEFAULTS.cursor`、`providers.cursor`、HELP |
| `test/provider/cursor.test.js` | **新建**：`ensureFlags`、命令解析 |
| `test/provider/acp.test.js` 或扩展现有测试 | auth 错误分类、`formatAuthHint` |
| `docs/design.md` | provider 列表、resume 表 |
| `docs/providers.md` | Cursor 章节 |
| `docs/get-started.md` | 示例 |

## `cursor.js` 设计

### `ensureFlags(command)`

- 将 `command` 拆为 `parts`
- 若不存在子命令 `acp`，在可执行名之后插入 `acp`
- 在 `acp` **之前**插入 `--yolo`、`--approve-mcps`（已有 `-f`/`--force` 时不重复 `--yolo`）
- 示例：
  - `agent` → `agent --yolo --approve-mcps acp`
  - `cursor-agent` → `cursor-agent --yolo --approve-mcps acp`
  - `agent acp` → `agent --yolo --approve-mcps acp`
  - `agent --yolo --approve-mcps acp` → 不变
- **不注入** `--trust`（仅 print 模式）、`-p`（print 模式）
- 写文件 / shell / MCP：CLI `--yolo` + `--approve-mcps`，ACP `session/request_permission` 由 wrapper 自动 allow

### 接口

与 `gemini.js` 相同，导出 `createSession`、`send`、`closeSession`、`run`，内部调用 `acp.js` 并传入 `clientFactory` 或 `provider: "cursor"` 以选用 `CursorNonInteractiveClient`。

## `acp.js` 增强

### 1. `CursorNonInteractiveClient`

继承 `NonInteractiveClient`，实现 Cursor ACP 扩展（agent → client 的请求）：

| 方法 | 类型 | 行为 |
|------|------|------|
| `cursor/ask_question` | 阻塞 | `{ outcome: "answered", answers: [{ questionId, selectedOptionIds: [firstOption.id] }] }` |
| `cursor/create_plan` | 阻塞 | `{ outcome: "accepted" }` |
| `cursor/update_todos` | 通知 | debug 日志，无响应 |
| `cursor/task` | 通知 | debug 日志，无响应 |
| `cursor/generate_image` | 通知 | debug 日志，无响应 |

多选题 `allowMultiple: true` 时，仅选第一个 option（YAGNI；后续可按 label 启发式扩展）。

标准方法保持现有行为：

- `requestPermission` → 第一个 `allow` / `always_allow` 选项
- `sessionUpdate` → 收集 notifications
- `readTextFile` / `writeTextFile` → 保持

**SDK 接入说明**：实现时根据 `@agentclientprotocol/sdk` 的 `Client` 接口或扩展注册方式挂载上述方法；若 SDK 通过动态 method 分发，在 connection 层注册 handler。

### 2. `createSession` 参数扩展

```javascript
createSession({ command, timeout, resume, provider })
```

- `provider === "cursor"` → 使用 `CursorNonInteractiveClient`
- 其他 → `NonInteractiveClient`（copilot、gemini 不变）

### 3. 认证失败检测（全 ACP provider）

新增纯函数（便于单测）：

```javascript
isAuthError(err, childStderr) → boolean
formatAuthHint(provider) → string
```

**检测时机**：`initialize`、`newSession`、`loadSession`、`prompt` 的 catch 路径。

**匹配启发式**（message + stderr，不区分大小写）：

- `unauthorized`, `not authenticated`, `authentication required`
- `login required`, `please log in`, `run .* login`
- ACP error code 若文档/实测有固定 auth code，一并加入

**用户可见输出**（经 main 或 provider 写入 stderr，退出码 202）：

```
[wrapper][error] Authentication required for cursor.
  Run: agent login
  Or set: CURSOR_API_KEY
```

| provider | 提示命令 |
|----------|----------|
| cursor | `agent login` / `CURSOR_API_KEY` |
| copilot | `copilot` 官方登录流程（实现时核对 CLI help） |
| gemini | `gemini` 官方登录流程（实现时核对 CLI help） |

`-d` 时追加原始 error 与 child stderr 片段。

**Cursor 专用**：`initialize` 后调用 `authenticate({ methodId: "cursor_login" })`（ACP 握手，非交互登录；copilot/gemini 不调用）。

### 4. MCP

`session/new` 与 `session/load` 继续传 `mcpServers: []`。Cursor ACP 文档说明可在项目目录启动 `agent` 以使用 `.cursor/mcp.json`；空数组表示由 CLI 按 cwd 自行解析（与 copilot/gemini 一致）。首版不解析 mcp.json 注入 wrapper。

## CLI 变更

### `main.js`

```javascript
DEFAULTS.cursor = "agent --yolo --approve-mcps acp";

providers.cursor = require("./provider/cursor");
```

HELP 增加：

```text
cursor:
  wrapper -t cursor -p "say hi"
  wrapper -t cursor -p "hello" 2>/tmp/sid
  session=$(tail -1 /tmp/sid)
  wrapper -t cursor -s ${session} -p "what did I say?"
```

`-t` 可选值文档更新为：`claude, codex, copilot, gemini, cursor`。

## Session ID 与 Resume 验收标准

| # | 场景 | 期望 |
|---|------|------|
| 1 | `wrapper -t cursor -p "say hi"` | exit 0；stdout 有回答；stderr 最后一行为非空 sessionId |
| 2 | 取 sessionId 后 `wrapper -t cursor -s <id> -p "what did I say?"` | agent 能引用上一轮内容 |
| 3 | `-r` 重试 | 同一进程同一 sessionId，不新建 session |
| 4 | 未登录 | exit 202；stderr 含 `agent login` 提示，不 hang |
| 5 | `-c "cursor-agent"` | 自动变为 `cursor-agent --yolo --approve-mcps acp` |
| 6 | 改文件 / shell 任务 | 工具调用不被权限阻塞 |
| 7 | `-d` | 可见 initialize、authenticate、session id、permission debug |

## 测试策略

### 单元测试

- `cursor.test.js`：`ensureFlags` 各种输入
- `acp.test.js`（或 `test/provider/acp-auth.test.js`）：`isAuthError`、`formatAuthHint`

### 手动验证（需已 `agent login`）

```bash
wrapper -t cursor -p "say hi in one word" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
wrapper -t cursor -s "$session" -p "repeat my first message verbatim"
```

未登录验证：

```bash
# 临时清空 CURSOR_API_KEY 并使用未登录环境
wrapper -t cursor -p "hi"  # 应快速失败并提示 login
```

## 非目标（首版不做）

- Print 模式 provider（`-p --yolo`）
- ACP `authenticate` 主动调用
- `cursor/create_plan` 真实用户审批 UI
- 团队级 MCP（ACP 文档标明 ACP 模式不支持）
- 新退出码；auth 失败仍用 202

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| SDK 未暴露 Cursor 扩展 method 注册 | 实现阶段查 SDK 源码；必要时在 ndJsonStream 层拦截未知 method |
| auth 错误文案因 CLI 版本变化 | 启发式 + 单测 fixture；`-d` 保留原始错误 |
| `session/load` 对旧 session 失效 | 文档说明 session 与账号/工作区绑定；失败时 202 + 清晰 message |

## 参考

- [Cursor CLI ACP 文档](https://cursor.com/cn/docs/cli/acp)
- 现有实现：`src/provider/acp.js`、`src/provider/gemini.js`
- Resume 设计：`docs/superpowers/specs/2026-05-18-resume-session-design.md`
