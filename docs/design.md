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
wrapper -p <prompt> [-t claude] [-c "claude"] [-d] [-s <id>] [-e "regex"] [-r 3] [-o 60]
```

| 参数 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `-p, --prompt` | 是 | - | 用户提示词 |
| `-t, --type` | 否 | `claude` | provider 类型 |
| `-c, --command` | 否 | 跟 `-t` 联动 | 实际执行的命令，支持带参数 |
| `-d, --debug` | 否 | 关 | 开启日志 |
| `-e, --reg` | 否 | 空 | 正则匹配模式 |
| `-r, --retry` | 否 | 3 | 最大重试次数 |
| `-s, --resume` | 否 | 空 | 恢复已有 session ID |
| `-o, --timeout` | 否 | 0（无超时） | 超时秒数 |

## 输出规范

| 输出 | 成功 | 失败 |
|------|------|------|
| stdout | 回答文本（去首尾空行、压缩连续空行） | 最后一次输出 |
| stderr | 思考过程 + session ID（最后一行） | 思考过程 + session ID |
| exit code | 0 | 200-203 |

### 退出码

| 码值 | 含义 |
|------|------|
| 0 | 成功 |
| 200 | 正则不匹配（重试耗尽） |
| 201 | 空输出（重试耗尽） |
| 202 | provider 异常 |
| 203 | 超时 |
| 204 | 命令未找到 |

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

Copilot / Gemini 不使用 `--resume` CLI flag（该 flag 仅在交互模式下有效，与 `--acp` 不兼容）。在 ACP 模式下通过 `session/load` 协议方法恢复 session。

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
3. 超时不触发重试（直接退出 203）

### Session 复用

重试在同一 Claude session 中进行，不创建新会话。Claude 知道上一轮对话上下文，可以给出不同答案。

### 超时

全局绝对超时：deadline 在 session 创建时一次性设定，不随事件流重置，不因重试延长。`-o 0` 表示无超时（deadline = Infinity）。

### 退出码

重试耗尽后根据原因返回不同退出码。

## 日志

- `-d` 关闭：所有日志静默，stderr 只含思考过程 + session ID
- `-d` 开启：`[wrapper][level][timestamp] message` 格式输出到 stderr

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
scripts/
  patch-bundle.js               — 修复 esbuild 打包后的 import_meta.url
Makefile                        — test / build / clean targets
dist/                           — 构建产物（二进制 + bundle）
```

## 后续扩展

- Codex provider：已实现，spawn + NDJSON 解析，见 `src/provider/codex.js`
- Copilot provider：已实现，使用 `@agentclientprotocol/sdk` (ACP)，见 `src/provider/copilot.js` + `src/provider/acp.js`
- Gemini provider：已实现，复用 ACP，见 `src/provider/gemini.js` + `src/provider/acp.js`
