# OpenCode Provider（ACP）设计

## 目标

为 wrapper 新增 **OpenCode CLI** provider（`-t opencode`），通过 **ACP** 非交互调用，与 cursor / gemini / copilot 对齐：

1. 一次性执行 prompt 并退出（与现有 provider 一致）
2. **可靠获取 `sessionId`**（`ses_xxx` 格式），写入 stderr 最后一行
3. 通过 `-s <sessionId>` **跨进程恢复会话**（ACP `session/load`）
4. 同进程内 **重试复用同一 session**（现有 retry 循环）

## 背景与调研结论

### OpenCode CLI 能力

| 子命令 | 用途 | wrapper 选用 |
|--------|------|-------------|
| `opencode acp` | 启动 ACP server（stdio JSON-RPC） | **是** |
| `opencode run --dangerously-skip-permissions` | 单次非交互执行（可选 `--format json`） | 否（首版） |

### ACP 对接实测（opencode 1.17.9）

| 步骤 | 结果 |
|------|------|
| `initialize` | ✅ protocolVersion=1 |
| `authenticate({ methodId: "opencode-login" })` | ✅ |
| `session/new` | ✅ 返回 `sessionId`（如 `ses_10707e79...`） |
| `loadSession` capability | ✅ 支持 `-s` resume |
| `session/prompt` | ✅ 协议层正常；本地测试曾因模型 rate limit 超时（属 API 限额，非 ACP 不兼容） |

### 方案选型（已决策）

曾评估三条路线：

- **A：ACP**（`opencode acp`）— **已选**
- B：Run + JSON（`opencode run --format json`）— 类似 codex，未选
- C：Agy 式日志解析 — OpenCode 无 `--log-file`，且 JSON 事件已含 sessionID，未选

## 已确认决策

| 项 | 决策 |
|----|------|
| 集成方式 | ACP（`opencode acp`） |
| 实现路径 | **方案 1**：`opencode.js` thin wrapper + 增强共享 `acp.js` |
| Provider 名 | `-t opencode` |
| 默认命令 | `opencode acp` |
| 认证 | `initialize` 后 `authenticate({ methodId: "opencode-login" })` |
| 权限 | ACP `requestPermission` 自动 allow（`NonInteractiveClient`） |
| Resume | ACP `session/load`（不用 CLI `-s`） |
| 配额检测 | `LimitMsg.opencode` 暂留 `""` |

## 架构

```
wrapper (main.js)
    │
    ▼
opencode.js          ensureFlags → "opencode acp"
    │
    ▼
acp.js               spawn + NonInteractiveClient
    │                authenticate(opencode-login) when provider=opencode
    │
    ▼
opencode acp         initialize → authenticate → session/new|load → session/prompt
```

### 会话流程

1. `createSession`：spawn `opencode acp`，`initialize`，`authenticate(opencode-login)`
2. 无 `-s`：`session/new` → 得到 `sessionId`
3. 有 `-s`：`session/load({ sessionId, cwd, mcpServers: [] })` → 保持原 id
4. `send`：`session/prompt`，收集 `session/update` 流式内容
5. `closeSession`：SIGTERM 子进程
6. stderr 最后一行输出 `sessionId`（main.js 现有逻辑）

### 与现有 provider 对齐

| Provider | 通信 | Resume | 认证 ACP 握手 |
|----------|------|--------|--------------|
| copilot | ACP | `session/load` | 无 |
| gemini | ACP | `session/load` | 无 |
| cursor | ACP | `session/load` | `cursor_login` |
| **opencode** | ACP | `session/load` | `opencode-login` |

## 文件变更

| 文件 | 改动 |
|------|------|
| `src/provider/opencode.js` | **新建**：`ensureFlags`、委托 `acp.createSession/send/closeSession` |
| `src/provider/acp.js` | `provider === "opencode"` 时 `authenticate(opencode-login)`；`AUTH_HINTS.opencode` |
| `src/main.js` | `DEFAULTS.opencode`、`providers.opencode`、HELP |
| `test/provider/opencode.test.js` | **新建**：`ensureFlags` 单测 + 可选 smoke |
| `test/fallback.test.js` | 更新 opencode 相关断言 |
| `docs/providers.md` | 新增 OpenCode 章节 |
| `docs/design.md` | provider 列表、resume 表 |
| `docs/get-started.md` | 示例 |

## `opencode.js` 设计

### `ensureFlags(command)`

- 将 `command` 拆为 `parts`
- 若不存在子命令 `acp`，在可执行名之后插入 `acp`
- 示例：
  - `opencode` → `opencode acp`
  - `opencode acp` → 不变
- **不注入** `--dangerously-skip-permissions`（仅 `run` 子命令支持；ACP 模式由 `requestPermission` 处理）
- **不注入** `run`、`--format json`

### 接口

与 `gemini.js` 相同，导出 `createSession`、`send`、`closeSession`、`run`，内部调用 `acp.js` 并传入 `provider: "opencode"`。

## `acp.js` 增强

### 1. 认证（对齐 cursor）

在 `createSession` 中，`initialize` 成功后：

```javascript
if (provider === "cursor") {
  await connection.authenticate({ methodId: "cursor_login" });
} else if (provider === "opencode") {
  await connection.authenticate({ methodId: "opencode-login" });
}
```

### 2. AUTH_HINTS

```javascript
opencode: "Run: opencode auth login",
```

### 3. Client 选择

首版使用 **`NonInteractiveClient`**（与 copilot/gemini 相同）。若实现阶段发现 OpenCode 专有 ACP 扩展 RPC 导致 hang，再评估专用 Client。

标准方法保持现有行为：

- `requestPermission` → 第一个 `allow` / `always_allow` 选项
- `sessionUpdate` → 收集 notifications
- `readTextFile` / `writeTextFile` → 保持

### 4. MCP

`session/new` 与 `session/load` 继续传 `mcpServers: []`。由 OpenCode CLI 按 cwd 自行解析项目 MCP 配置。

## CLI 变更

### `main.js`

```javascript
DEFAULTS.opencode = "opencode acp";

providers.opencode = require("./provider/opencode");
```

HELP 增加：

```text
opencode:
  wrapper -t opencode -p "say hi"
  wrapper -t opencode -p "hello" 2>/tmp/sid
  session=$(tail -1 /tmp/sid)
  wrapper -t opencode -s ${session} -p "what did I say?"
```

`-t` 可选值文档更新为包含 `opencode`。

## Session ID 与 Resume 验收标准

| # | 场景 | 期望 |
|---|------|------|
| 1 | `wrapper -t opencode -p "say hi"` | exit 0；stdout 有回答；stderr 最后一行为非空 `ses_...` |
| 2 | 取 sessionId 后 `wrapper -t opencode -s <id> -p "what did I say?"` | agent 能引用上一轮内容 |
| 3 | `-r` 重试 | 同一进程同一 sessionId，不新建 session |
| 4 | 未登录 | exit 202；stderr 含 `opencode auth login` 提示，不 hang |
| 5 | `-c "opencode"` | 自动变为 `opencode acp` |
| 6 | 改文件 / shell 任务 | 工具调用不被权限阻塞 |
| 7 | `-d` | 可见 initialize、authenticate、session id、permission debug |
| 8 | fallback 链含 opencode | 前一 agent 失败后正确 fallback 到 opencode |
| 9 | 命令不存在 | exit 204 |

## 测试策略

### 单元测试

- `opencode.test.js`：`ensureFlags` 各种输入
- 扩展 `acp-auth.test.js`：`formatAuthHint("opencode")`（如适用）

### 手动验证（需已 `opencode auth login`）

```bash
wrapper -t opencode -p "say hi in one word" -d
wrapper -t opencode -p "hi" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
wrapper -t opencode -s "$session" -p "repeat my first message verbatim"
```

未登录验证：

```bash
wrapper -t opencode -p "hi"  # 应快速失败并提示 login
```

### CI

- 单测不依赖 opencode 二进制；smoke 测试使用 `{ skip: !hasOpencode }`

## 非目标（首版不做）

- `opencode run` spawn + JSON 模式
- agy 式 `--log-file` 日志解析
- OpenCode 专有 ACP 扩展 handler（除非实现中阻塞）
- 自定义 `LimitMsg` 配额模式
- wrapper 侧解析 mcp.json 注入

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| API rate limit 导致 prompt 超时 | 文档说明需可用模型；合理默认 timeout；失败 exit 1 |
| auth methodId 变更 | 实现时核对 `initialize.authMethods` |
| `session/load` 对旧 session 失效 | 文档说明 session 与工作区绑定；失败 202 + 清晰 message |
| SDK 未暴露扩展 method | 首版用 NonInteractiveClient；`-d` 保留原始错误 |

## 参考

- 现有实现：`src/provider/acp.js`、`src/provider/gemini.js`、`src/provider/cursor.js`
- OpenCode CLI：`opencode acp`、`opencode auth login`
- Resume 设计：`docs/superpowers/specs/2026-05-18-resume-session-design.md`
- Cursor ACP 设计：`docs/superpowers/specs/2026-05-20-cursor-provider-design.md`
