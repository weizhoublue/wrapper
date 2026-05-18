# wrapper v2 设计文档

## 目标

开发一个一次性 CLI 包装器，调用 AI coding agent（Claude / Codex / Copilot）执行用户 prompt 并退出。全程参考 Paseo 代码但不直接引用。

## CLI 接口

```
wrapper -p <prompt> [-t claude] [-c "claude"] [-d] [-s] [-e "regex"] [-r 3] [-o 60]
```

| 参数 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `-p, --prompt` | 是 | - | 用户提示词 |
| `-t, --type` | 否 | `claude` | provider 类型：claude / codex / copilot |
| `-c, --command` | 否 | 跟 `-t` 联动 | 实际执行的二进制命令 |
| `-d, --debug` | 否 | 关 | 开启 debug 日志 |
| `-s, --stderr` | 否 | 关 | 透传子进程 stderr 到自身 stderr |
| `-e, --reg` | 否 | 空 | 对输出做正则匹配，不匹配则重试 |
| `-r, --retry` | 否 | 3 | 最大重试次数 |
| `-o, --timeout` | 否 | 0（无超时） | 超时秒数 |

### `-t` 与 `-c` 联动

| `-t` | `-c` 默认值 |
|------|------------|
| `claude` | `claude` |
| `codex` | `codex` |
| `copilot` | `copilot` |

### 输出行为

**成功时：**

| 输出 | 内容 |
|------|------|
| stdout | 子进程标准输出 |
| stderr（最后一行） | session ID |
| exit code | 子进程返回码 |

**重试耗尽 / 超时 / 子进程异常退出：**

| 输出 | 内容 |
|------|------|
| stdout | 最后一次调用的标准输出 |
| stderr | 子进程标准错误输出 + 最后一行 session ID |
| exit code | 非 0 |

错误场景下，无论 `-s` 是否开启，子进程的 stderr **必须**透传到 wrapper 的 stderr。

### 日志格式（`-d` 开启）

```
[wrapper][debug][2026-05-17 10:07:55] 消息内容
[wrapper][info][2026-05-17 10:07:55] 消息内容
[wrapper][error][2026-05-17 10:07:55] 消息内容
```

所有级别日志均输出到 stderr。

### 重试逻辑

以下情况触发重试（最多 `-r` 次）：

1. **输出为空或纯空白**：子进程 stdout 为空字符串或仅含空白字符
2. **正则不匹配**：指定了 `-e` 且 stdout 不匹配该正则

以上均不满足 → 正常返回。重试耗尽 → 错误输出模式（见上）。

### 超时逻辑

1. 超时秒数 = `-o`，0 表示无超时
2. 超时后 kill 子进程，宣告失败，错误输出模式

## 架构

```
main.js（CLI 参数解析、流程编排、重试/超时）
  └─ provider/
       ├─ interface.js   — 统一接口定义
       ├─ claude.js      — Claude Agent SDK
       ├─ codex.js       — ACP spawn（后续）
       └─ copilot.js     — ACP spawn（后续）
```

### Provider 统一接口

```javascript
// 每个 provider 导出：
run({ command, prompt, timeout }) → Promise<{
  stdout: string,
  stderr: string,        // 子进程 stderr（用于错误透传）
  sessionId: string | null,
  exitCode: number,
}>
```

### Claude provider

- 使用 `@anthropic-ai/claude-agent-sdk` 的 `query()`
- prompt 传字符串（一次性调用，无需 async iterable）
- `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`
- 消费 `for await (msg of query)` 事件流
- `result` 事件到达 → 提取 `session_id`、`subtype`、`result` 文本 + assistant text blocks
- `subtype === 'success'` → exitCode 0，否则 1
- 超时：`AbortController` + `setTimeout` + `query.close()`

### Codex / Copilot provider（后续）

- 使用 `child_process.spawn` + ACP 协议
- `session/new` 获取 session ID
- 超时：`child.kill()`

## 文件结构

```
wrapper/
  package.json
  src/
    main.js               — 入口：参数解析、主流程
    log.js                — 日志模块
    provider/
      interface.js         — provider 接口定义
      claude.js            — Claude Agent SDK 适配
      codex.js             — Codex ACP 适配（后续）
      copilot.js           — Copilot ACP 适配（后续）
  test/
    main.test.js          — 参数解析 + 流程测试
    provider/
      claude.test.js      — Claude provider 测试
```

## 技术栈

- Node.js >= 18
- 零额外依赖（除 `@anthropic-ai/claude-agent-sdk`）
- `child_process`、`http` 等全用内置模块

## 实施顺序

1. Claude provider（SDK，最快验证）
2. Codex provider（ACP spawn）
3. Copilot provider（ACP spawn）
