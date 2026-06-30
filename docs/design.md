# wrapper 设计文档

## 目标

一次性 CLI 包装器，调用 AI coding agent 执行用户 prompt 并退出。输出干净：stdout = 回答，stderr = 思考过程 + session ID。

## 参考

参考了 https://github.com/getpaseo/paseo 项目中如何同 claude 等 CLI 进行命令交互的代码

## 架构

```
wrapper (main.js)                 Claude Agent SDK               Claude CLI
     |                              |                              |
     |-- createSession() ---------->|                              |
     |   input = async iterable     |-- spawn claude (pipe) ------>|
     |   pump: for await events     |   stdin/stdout JSON stream   |
     |                              |                              |
     |-- send(session, prompt) --->|                              |
     |   input.push(message)        |-- write message to pipe ---->|
     |   poll events for result     |<-- stream events ------------|
     |   extract text/thinking      |                              |
     |<-- {stdout, stderr, id} -----|                              |
     |                              |                              |
     |-- send(session, prompt) --->|  (retry, same session)       |
     |   ...                        |                              |
     |                              |                              |
     |-- closeSession() ---------->|                              |
     |   input.end()                |-- close pipe --------------->|
     |   q.close()                  |                              |
```

## CLI 接口

```
wrapper -p <prompt> [-t type [-c command]] [-t type [-c command]] ... [选项]
```

| 参数 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `-p, --prompt` | 是 | - | 用户提示词 |
| `-t, --type` | 否 | `claude` | provider 类型：`claude` / `codex` / `copilot` / `gemini` / `cursor` / `opencode`（可多次指定以进行冗余备用调用） |
| `-c, --command` | 否 | 跟前一个 `-t` 联动 | 实际执行的命令（必须紧跟在 `-t` 之后，且每个 `-t` 最多只能有一个 `-c`） |
| `-d, --debug` | 否 | 关 | 开启日志 |
| `-e, --reg` | 否 | 空 | 正则匹配模式，不匹配则重试 |
| `-x, --exclude` | 否 | 空 | 排除正则（仅匹配 stdout），匹配则立即宣告当前 agent 失败且不再重试 |
| `-q, --quota` | 否 | 开 | 开启 agent 订阅额度耗尽检测 |
| `-n, --no-quota` | 否 | — | 关闭 agent 订阅额度耗尽检测 |
| `-r, --retry` | 否 | 2 | 最大重试次数（适用于调用的每一个 Agent） |
| `-s, --resume` | 否 | 空 | 恢复已有 session ID（与多 Agent 互斥，仅单 Agent 时可用） |
| `-o, --timeout` | 否 | 3600（1 小时） | 单次 attempt 超时秒数；`0` 表示不限时 |
| `-h, --help` | 否 | - | 显示中文帮助信息 |

## 输出规范

| 输出 | 成功 | 失败 |
|------|------|------|
| stdout | 最终成功（或最后一个失败的）Agent 的回答文本（去首尾空行、压缩连续空行） | 最后一个失败 Agent 的回答文本 |
| stderr | 最后一个 Agent 的 `[agent] stderr:`（失败时另附 `[agent] error:`），倒数第二行为命令名，最后一行为会话 ID | 同上（最后一个失败 Agent） |
| exit code | 最终成功 Agent 的退出码（通常为 0） | 最后一个 Agent 的退出码或重试耗尽退出码（200-206） |

### 退出码

| 码值 | 含义 |
|------|------|
| 0 | 成功 |
| 200 | 正则不匹配（重试耗尽） |
| 201 | 空输出（重试耗尽） |
| 202 | provider 异常 |
| 203 | 超时 |
| 204 | 命令未找到 |
| 205 | 排除正则匹配（stdout 命中 `-x` 模式） |
| 206 | 订阅额度耗尽（非零退出且 stdout/stderr 命中内置 `LimitMsg` 模式） |

退出码从 200 起步，避免和 claude 命令退出码（0/1/2）冲突。

## Provider 设计

### 接口

```javascript
createSession({ command, timeout, resume }) → session
send(session, prompt) → { stdout, stderr, sessionId, exitCode }
closeSession(session)
run({ command, prompt, timeout }) → { stdout, stderr, sessionId, exitCode }  // 便捷方法
```

### Claude 实现

- `createSession`：`which` 检查命令是否存在（不存在直接抛错，退出码 204），创建 AsyncIterable，启动 `query()` 和后台 pump。设定全局绝对 deadline（`Date.now() + timeout*1000`）
- `send`：push 用户消息 → 轮询 events → 找到 result 事件 → 提取文本。检测 pumpError 立即抛出，检测 deadline 超时返回 timedOut
- `closeSession`：`input.end()` + `q.close()`。在所有退出路径中先于 stderr 写入执行，确保 session ID 始终是 stderr 最后一行
- 命令拆分：`splitCommand()` 将 `-c` 值拆为 command + args，有 args 时用 `spawnClaudeCodeProcess`

### Session Resume（`-s` 选项）

不同 provider 的 resume 机制不同，由 provider 内部处理：

| Provider | Resume 机制 | 命令示例 |
|----------|------------|---------|
| Codex | `codex exec resume <id>` 子命令 | `codex exec resume <id> --json ...` |
| Claude | `--resume <id>` CLI flag | `claude ... --resume <id>` |
| Copilot | ACP `session/load` 协议方法 | `connection.loadSession({ sessionId, cwd })` |
| Gemini | ACP `session/load` 协议方法 | `connection.loadSession({ sessionId, cwd })` |
| Cursor | ACP `session/load` 协议方法 | `agent --yolo --approve-mcps acp` + `connection.loadSession({ sessionId, cwd })` |
| OpenCode | `--session <id>` CLI flag | `opencode run --session <id> --format json ...` |

Copilot / Gemini / Cursor 不使用 `--resume` CLI flag（该 flag 仅在交互模式下有效，与 ACP 不兼容）。在 ACP 模式下通过 `session/load` 协议方法恢复 session。OpenCode 使用 `run --session`，与 Codex 的 `exec resume` 类似但 flag 名不同。

### 消息队列 (AsyncMessageInput)

基于 Promise resolver 队列：push 推入消息，SDK 的 AsyncIterator 异步消费。

### 事件泵 (Pump)

后台 `for await (const msg of q)` 持续消费 SDK 事件。与 `send()` 协调：`send()` 轮询共享的 `events` 数组，检测 `result` 事件。

### 文本提取

- `extractText`：assistant text blocks → 拼接。`result.result` 仅在没有 assistant text 时作兜底（避免重复）
- `extractThinking`：thinking/reasoning blocks → 输出到 stderr
- `extractSessionId`：倒序扫描 `session_id`

## 重试机制

### 触发条件

1. 输出为空或纯空白
2. 指定了 `-e` 且 stdout 不匹配该正则
3. 单次 attempt 超时（`-o` > 0 且 `timedOut`），在 `-r` 次数内重试；全部 attempt 超时后退出 203

### 排除匹配（`-x`）

在每次 `send` 返回后、判断是否成功/重试之前，先检查 stdout 是否命中 `-x` 排除正则（大小写不敏感）。若命中，立即宣告当前 agent 失败，不再重试；若有 fallback agent 则继续尝试下一个。

### 失败原因输出

结构化 stderr 固定顺序：`[agent] stderr:`（仅 agent 原始 stderr/thinking）→ `[agent] error:`（wrapper 判定，仅失败时出现）。不含 `[agent] stdout:`。多 Agent fallback 时，中间失败 Agent 的输出不在最终 stderr 中；使用 `-d` 可在调试日志中按 attempt 即时查看 stdout/stderr 全文。

### Session 复用

`-r` 重试在同一 agent 的同一 session 中进行，不跨 fallback agent 传递 session id。Claude/ACP 使用长连接复用 session；Codex/OpenCode/Agy 每次 spawn 新进程但在后续 attempt 注入 resume 参数（`exec resume`、`--session`、`--conversation`）。用户 `-s` 指定外部 session；未指定时 attempt 1 新建，attempt 2+ 自动 resume。agent 保留上一轮对话上下文，regex 不匹配重试时更可能给出不同答案。

### 超时

每次 attempt 开始前重置 deadline（`Date.now() + timeout*1000`），即 `-o` 表示单次 attempt 的超时秒数，重试时重新计时。`-o 0` 表示无超时（deadline = Infinity）。

### 退出码

重试耗尽、排除匹配、订阅额度耗尽或其他失败原因返回不同退出码（含 205 排除正则匹配、206 订阅额度耗尽）。

## 冗余 Fallback 机制

### 机制说明
支持多次指定 `-t` 及紧跟其后的 `-c`。例如：`wrapper -t copilot -t codex -p "hello"`。
1. **顺序尝试**：从第一个指定的 Agent 开始，依次尝试。
2. **提前终止**：一旦某一个 Agent 满足成功条件（非空且匹配正则），则直接退出，后续的 Agent 将不被调用。
3. **依次 fallback**：若当前 Agent 失败（包括会话创建失败、发送失败、超时、非零退出码、订阅额度耗尽、排除正则匹配或重试耗尽），则记录当前 Agent 的输出/错误后，落入下一个 Agent 重新尝试整个重试循环。
4. **互斥约束**：
   - 每一个 `-c` 必须紧跟在 `-t` 之后，否则抛错。
   - 同一个 `-t` 只能指定一个 `-c`，不可重复。
   - `-s, --resume` 仅支持单 Agent 使用，多 Agent 时指定 `-s` 会抛错。

## 日志

- `-d` 关闭：wrapper 日志静默；stderr 只含最后一个 Agent 的 stderr 块 + 命令名 + session ID
- `-d` 开启：`[wrapper][level][timestamp][agentName][attempt/maxAttempts] message` 格式；Agent 执行阶段 info/error/debug 均带 `[agentName][session]` 前缀（未开始 attempt 时 session 为 `-`）
- 每次 attempt 失败时（`-d`），立即 dump 该次 stdout/stderr 全文到 debug 日志，再输出 error 原因行

## 文件结构

```
src/
  main.js                      — CLI 参数解析、重试循环、输出编排
  log.js                       — 日志模块
  provider/
    create-async-input.js       — AsyncIterable 消息队列
    claude.js                   — Claude Agent SDK 适配
    acp.js                      — ACP 共享模块（Codex/Copilot 共用）
    codex.js                    — Codex ACP 适配
    copilot.js                  — Copilot ACP 适配
    gemini.js                   — Gemini ACP 适配（复用 acp.js）
    cursor.js                   — Cursor ACP 适配（复用 acp.js）
    opencode.js                 — OpenCode run + JSON 适配
scripts/
  patch-bundle.js               — 修复 esbuild 打包后的 import_meta.url
Makefile                        — test / build / clean targets
dist/                           — 构建产物（二进制 + bundle）
```

## 后续扩展

- Codex provider：已实现，spawn + NDJSON 解析，见 `src/provider/codex.js`
- Copilot provider：已实现，使用 `@agentclientprotocol/sdk` (ACP)，见 `src/provider/copilot.js` + `src/provider/acp.js`
- Gemini provider：已实现，复用 ACP，见 `src/provider/gemini.js` + `src/provider/acp.js`
- Cursor provider：已实现，复用 ACP，见 `src/provider/cursor.js` + `src/provider/acp.js`
- OpenCode provider：已实现，spawn + NDJSON 解析，见 `src/provider/opencode.js`
