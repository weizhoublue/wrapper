# wrapper 开发文档

## 构建

```bash
npm install          # 安装依赖
npm test             # 运行所有测试
make build           # 构建 4 平台二进制到 dist/
```

构建流程：`esbuild` 打包为单文件 CJS → `scripts/patch-bundle.js` 修复 import_meta.url → `pkg` 注入 Node.js 运行时生成独立二进制。

无需编译——Node.js 直接执行。

## 测试

```bash
npm test                                    # 所有测试
node --test test/log.test.js                # 日志模块
node --test test/main.test.js               # 参数解析 + 流程
node --test test/provider/claude.test.js    # Claude provider
node --test test/provider/gemini.test.js    # Gemini provider 集成测试
node --test test/smoke.test.js              # 集成测试（需 claude CLI）
```

## 项目结构

```
src/
  main.js               — 入口：参数解析、主流程、重试逻辑、输出编排
  log.js                — 日志模块（仅 -d 开启时输出）
  provider/
    create-async-input.js — AsyncIterable 消息队列（push/end/iterable）
    claude.js            — Claude Agent SDK 适配
    codex.js             — Codex spawn + NDJSON 适配
    copilot.js           — Copilot ACP 适配
    gemini.js            — Gemini ACP 适配（复用 acp.js）
    cursor.js            — Cursor ACP 适配（复用 acp.js）
test/
  log.test.js
  main.test.js
  provider/
    claude.test.js
    gemini.test.js
  smoke.test.js
```

## 核心设计

### Provider 接口

```javascript
// Session 模式（支持重试复用同一 session）
provider.createSession({ command, timeout }) → session
provider.send(session, prompt) → { stdout, stderr, sessionId, exitCode }
provider.closeSession(session)

// 便捷一次性调用（内部 createSession → send → closeSession）
provider.run({ command, prompt, timeout }) → { stdout, stderr, sessionId, exitCode }
```

### Session 复用

重试时复用同一个 Claude session，不会每次创建新会话：
- `createSession` 创建 session 和后台 pump（消费 SDK 事件流）
- retry 循环中调用 `send(session, prompt)` 在同一会话中发送新消息
- `closeSession` 关闭 session 和 pump

### 命令参数拆分

`-c` 参数支持带参数的命令（如 `"claude-free-remote --resume <id>"`）。`splitCommand()` 按空格拆分为 command + args。有 args 时使用 `spawnClaudeCodeProcess` 自定义 spawn，无 args 时直接用 `pathToClaudeCodeExecutable`。

### 输出收集

- **stdout**：assistant text blocks（最终回答），`result.result` 仅作兜底
- **stderr**：thinking/reasoning blocks（思考过程）
- **session ID**：从 SDK 事件的 `session_id` 字段提取

### 命令验证

`createSession` 内部用 `which` 检查命令是否存在。不存在则抛出 `command not found: <cmd>`，main.js 返回退出码 204。

### 超时机制

全局绝对超时：deadline 在 `createSession` 时一次性设定 (`Date.now() + timeout*1000`)，不随新事件重置，不因重试延长。超时到达 → 立即返回，不重试，退出码 203。

### 重试逻辑

`canRetry(stdout, regex)`：
- 输出为空或纯空白 → 重试
- 指定 regex 且不匹配 → 重试

`retryReason(stdout, regex)` 生成详细原因日志。重试时 `-d` 开启会同时打印上次尝试的完整 stdout/stderr。

### 空行处理

`collapseBlankLines(text)`：
- 连续 3 个以上空行 → 压缩为 2 个
- 去除首尾空行

### 退出码

| 码值 | 含义 |
|------|------|
| 0 | 成功 |
| 200 | 正则不匹配（重试耗尽） |
| 201 | 空输出（重试耗尽） |
| 202 | provider 异常 |
| 203 | 超时 |
| 204 | 命令未找到 |

退出码从 200 起步，避免和 claude 命令自身退出码（0/1/2）冲突。

### 日志

- 格式：`[wrapper][level][YYYY-MM-DD HH:MM:SS] message`
- `-d` 关闭：所有日志静默，stderr 仅包含思考过程 + session ID
- `-d` 开启：info/debug/error 全部输出到 stderr

### Provider 加载

```javascript
const providers = {
  claude: require("./provider/claude"),
  codex: require("./provider/codex"),
  copilot: require("./provider/copilot"),
  gemini: require("./provider/gemini"),
  cursor: require("./provider/cursor"),
};
const provider = providers[opts.type];
```

静态 lookup table 替代原动态 `require(\`./provider/${opts.type}\`)`，确保 esbuild 打包时所有 provider 被正确包含。

## Claude provider 细节

### SDK 事件流

1. SDK `query()` 启动，传入 `AsyncIterable<SDKUserMessage>`
2. 后台 pump `for await (const msg of q)` 消费事件
3. `send()` 通过 `input.push()` 发送用户消息，轮询 `session.events` 等待 `result`
4. 两阶段 idle 检测：无限等待首事件 → 新事件重置 timer → `result` 立即返回

### 文本提取

- `extractText(events)`：提取 `assistant` 消息中的 `text` 类型 content block。避免重复：`result.result` 仅在没有 assistant text 时作兜底
- `extractThinking(events)`：提取 `assistant` 消息中的 `thinking` 类型 content block，输出到 stderr
- `extractSessionId(events)`：从后往前扫描事件的 `session_id` 字段
