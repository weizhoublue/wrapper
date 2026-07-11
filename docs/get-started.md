# wrapper 快速上手

# 快速构建

```bash
npm install
make build          # 构建 4 平台二进制到 dist/
```

`dist/` 下生成：`wrapper-macos-arm64`、`wrapper-linux-x64`、`wrapper-linux-arm64`。

## 基本用法

```bash
# 发送 prompt（默认 claude）；提示词为最后一个参数
node src/main.js run "分析项目架构"

# 自定义命令 (必须紧跟在 -t 之后)
node src/main.js run -t claude -c "claude-free-remote" "hello"

# 多 Agent 冗余调用
node src/main.js run -t copilot -t codex "say hi in one word"

# 多 Agent 自定义命令调用
node src/main.js run -t claude -c "claude-deepseek" -t claude -c "claude-deepseek-flash" "hello"

# 恢复会话 (仅支持单 Agent)
node src/main.js run -t claude -s <session-id> "continue"

# 开启 debug 日志
node src/main.js run -d "hello"

# 正则匹配 + 重试
node src/main.js run -e "PASS" -r 5 "运行测试"

# 排除正则
node src/main.js run -t claude -t codex -x "usage limit|error" "hello"

# 超时控制
node src/main.js run -o 30 "长任务"

# throttle 管理
node src/main.js throttle -l
node src/main.js throttle -d 1

# 帮助
node src/main.js -h              # 顶层子命令
node src/main.js run -h          # run 选项
node src/main.js throttle -h     # throttle 选项
```

## CLI 参数（`wrapper run`）

| 参数 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `<提示词>` | 是 | - | **最后一个** argv token（无 `-p`） |
| `-t, --type` | 否 | `claude` | provider 类型（可多次冗余调用） |
| `-c, --command` | 否 | 跟 `-t` 联动 | 实际命令（须紧跟 `-t`） |
| `-d, --debug` | 否 | 关 | 开启日志 |
| `-e, --reg` | 否 | 空 | 正则不匹配则重试 |
| `-x, --exclude` | 否 | 空 | stdout 命中则失败不重试 |
| `-r, --retry` | 否 | 2 | 最大重试次数 |
| `-s, --resume` | 否 | 空 | 恢复 session（与多 Agent 互斥） |
| `-o, --timeout` | 否 | 3600 | 单次 attempt 超时；`0` 不限时 |
| `-h, --help` | 否 | - | run 子命令帮助 |

## 输出

| 输出 | 内容 |
|------|------|
| stdout | 最终成功（或最后一个失败的）Agent 的标准输出回答文本（去首尾空行、压缩连续空行） |
| stderr | 最后一个 agent 的 `[agent] stderr:`（失败时含 `[agent] error:`）；倒数第五行为空行，倒数第四行为 `[agent session]`，倒数第三行为退出码，倒数第二行为命令名，最后一行为 Session ID。多 agent fallback 时中间失败 agent 的输出仅在 `-d` 调试日志中可见 |
| exit code | 0 = 成功，200 = 正则不匹配，201 = 空输出，202 = 异常，203 = 超时，204 = 命令未找到，205 = 排除正则匹配 |

## 使用例子

### 基本调用并提取 session ID

```bash
node src/main.js run "say hi" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
```

### 恢复会话（`-s`）

`-s <session_id>` 统一接口，各 provider 自动处理 resume 机制：

```bash
# 先获取 session ID（stderr 最后一行）
node src/main.js run "say hi" 2>/tmp/sid
session=$(tail -1 /tmp/sid)

# Codex（内部执行 codex exec resume <id>）
node src/main.js -t codex -s ${session} "继续上次对话"

# Claude（内部追加 --resume <id> flag）
node src/main.js -t claude -c 'claude-free-remote' -s ${session} "继续上次对话"

# Copilot（内部使用 ACP session/load 协议）
node src/main.js -t copilot -s ${session} "继续上次对话"

# Gemini（内部使用 ACP session/load 协议）
node src/main.js -t gemini -s ${session} "继续上次对话"

# Cursor（内部使用 ACP session/load 协议）
node src/main.js -t cursor -s ${session} "继续上次对话"
```

### 正则匹配 + 重试

```bash
node src/main.js run "运行测试" -e "PASS" -r 3
# 重试日志会显示具体原因：regex /PASS/ not matched, output: ...
# 退出码 200 表示正则匹配耗尽
```

### 失败原因输出（`[agent] error:`）

结构化 stderr 固定分段，便于区分 agent 输出与 wrapper 提示：

```
[cursor] stdout:
Hello!
[cursor] stderr:
xxxxx
[cursor] error:
all 3 attempts exhausted: regex /bad/ not matched
```

- `stdout` / `stderr` 段仅含 agent 原始输出（无内容时仍保留标签行）
- `error` 段仅含 wrapper 判定原因（无需 `-d`）

### 调试

```bash
node src/main.js run "hello" -d
# -d 输出所有日志到 stderr：attempt 进度、session ID、retry 原因
```

## 各 Provider 默认命令

不指定 `-c` 时，由 `-t` 决定实际启动命令：

| `-t` | 默认 `-c` |
|------|-----------|
| `claude` | `claude --dangerously-skip-permissions --permission-mode=bypassPermissions` |
| `codex` | `codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check` |
| `copilot` | `copilot --acp --allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user` |
| `gemini` | `gemini --acp --approval-mode=yolo --skip-trust` |
| `cursor` | `agent --yolo --approve-mcps acp` |
| `opencode` | `opencode run --dangerously-skip-permissions --format json` |

`cursor` 使用 ACP 模式，适合改文件、跑 shell、用 MCP；需事先执行 `agent login` 或配置 `CURSOR_API_KEY`。详见 [providers.md](./providers.md#cursor)。

`opencode` 使用 `run --format json` 模式（类似 codex）；需事先执行 `opencode auth login`。详见 [providers.md](./providers.md#opencode)。

### Cursor 快速示例

```bash
# 基本调用（自动注入 --yolo --approve-mcps acp）
node src/main.js -t cursor "say hi in one word"

# 提取 session ID 并恢复会话
node src/main.js -t cursor "tomorrow will rain" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
node src/main.js -t cursor -s "$session" "what did I say earlier?"

# 自定义可执行文件（ensureFlags 仍会补全缺失 flag）
node src/main.js -t cursor -c "cursor-agent" "refactor src/foo.js"
```

### OpenCode 快速示例

```bash
node src/main.js -t opencode "say hi in one word"

node src/main.js -t opencode "tomorrow will rain" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
node src/main.js -t opencode -s "$session" "what did I say earlier?"
```

## 依赖

- Node.js >= 18
- 对应 provider 的 CLI 已安装并认证（Claude：`claude`；Cursor：`agent` + `agent login`；OpenCode：`opencode` + `opencode auth login`）
