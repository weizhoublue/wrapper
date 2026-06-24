# wrapper 快速上手

# 快速构建

```bash
npm install
make build          # 构建 4 平台二进制到 dist/
```

`dist/` 下生成：`wrapper-macos-arm64`、`wrapper-linux-x64`、`wrapper-linux-arm64`。

## 基本用法

```bash
# 发送 prompt (默认使用 claude)
node src/main.js -p "分析项目架构"

# 自定义命令 (必须紧跟在 -t 之后)
node src/main.js -t claude -c "claude-free-remote" -p "hello"

# 多 Agent 冗余调用
node src/main.js -t copilot -t codex -p "say hi in one word"

# 多 Agent 自定义命令调用
node src/main.js -t claude -c "claude-deepseek" -t claude -c "claude-deepseek-flash" -p "hello"

# 恢复会话 (仅支持单 Agent)
node src/main.js -t claude -s <session-id> -p "continue"

# 开启 debug 日志
node src/main.js -p "hello" -d

# 正则匹配 + 重试（调用的每个 Agent 均会在此条件下进行重试）
node src/main.js -p "运行测试" -e "PASS" -r 5

# 排除正则：stdout 命中则立即失败当前 agent（不重试），可配合 fallback
node src/main.js -t claude -t codex -p "hello" -x "usage limit|error"

# 超时控制
node src/main.js -p "长任务" -o 30

# 查看帮助 (中文帮助信息)
node src/main.js -h
```

## CLI 参数

| 参数 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `-p, --prompt` | 是 | - | 用户提示词 |
| `-t, --type` | 否 | `claude` | provider 类型：claude / codex / copilot / gemini / cursor / opencode（可指定多次以实现冗余调用） |
| `-c, --command` | 否 | 跟 `-t` 联动 | 实际执行的命令（必须紧随在 `-t` 之后且每个 `-t` 仅限一个 `-c`） |
| `-d, --debug` | 否 | 关 | 开启日志（所有级别输出到 stderr） |
| `-e, --reg` | 否 | 空 | 正则匹配模式，不匹配则重试 |
| `-x, --exclude` | 否 | 空 | 排除正则（仅匹配 stdout），匹配则立即宣告当前 agent 失败且不再重试 |
| `-r, --retry` | 否 | 3 | 最大重试次数（适用于调用的每一个 Agent） |
| `-s, --resume` | 否 | 空 | 恢复已有 session ID（与多 Agent 互斥，仅单 Agent 可用） |
| `-o, --timeout` | 否 | 3600（1 小时） | 单次 attempt 超时秒数；`0` 表示不限时 |
| `-h, --help` | 否 | - | 输出中文帮助信息 |

## 输出

| 输出 | 内容 |
|------|------|
| stdout | 最终成功（或最后一个失败的）Agent 的标准输出回答文本（去首尾空行、压缩连续空行） |
| stderr | 每个 agent 固定输出 `[agent] stdout:`、`[agent] stderr:`（仅 agent 原始输出）；失败时另附 `[agent] error:`（wrapper 判定原因）。倒数第二行为最终 Agent 命令名，最后一行为 Session ID |
| exit code | 0 = 成功，200 = 正则不匹配，201 = 空输出，202 = 异常，203 = 超时，204 = 命令未找到，205 = 排除正则匹配 |

## 使用例子

### 基本调用并提取 session ID

```bash
node src/main.js -p "say hi" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
```

### 恢复会话（`-s`）

`-s <session_id>` 统一接口，各 provider 自动处理 resume 机制：

```bash
# 先获取 session ID（stderr 最后一行）
node src/main.js -p "say hi" 2>/tmp/sid
session=$(tail -1 /tmp/sid)

# Codex（内部执行 codex exec resume <id>）
node src/main.js -t codex -s ${session} -p "继续上次对话"

# Claude（内部追加 --resume <id> flag）
node src/main.js -t claude -c 'claude-free-remote' -s ${session} -p "继续上次对话"

# Copilot（内部使用 ACP session/load 协议）
node src/main.js -t copilot -s ${session} -p "继续上次对话"

# Gemini（内部使用 ACP session/load 协议）
node src/main.js -t gemini -s ${session} -p "继续上次对话"

# Cursor（内部使用 ACP session/load 协议）
node src/main.js -t cursor -s ${session} -p "继续上次对话"
```

### 正则匹配 + 重试

```bash
node src/main.js -p "运行测试" -e "PASS" -r 3
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
node src/main.js -p "hello" -d
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
node src/main.js -t cursor -p "say hi in one word"

# 提取 session ID 并恢复会话
node src/main.js -t cursor -p "tomorrow will rain" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
node src/main.js -t cursor -s "$session" -p "what did I say earlier?"

# 自定义可执行文件（ensureFlags 仍会补全缺失 flag）
node src/main.js -t cursor -c "cursor-agent" -p "refactor src/foo.js"
```

### OpenCode 快速示例

```bash
node src/main.js -t opencode -p "say hi in one word"

node src/main.js -t opencode -p "tomorrow will rain" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
node src/main.js -t opencode -s "$session" -p "what did I say earlier?"
```

## 依赖

- Node.js >= 18
- 对应 provider 的 CLI 已安装并认证（Claude：`claude`；Cursor：`agent` + `agent login`；OpenCode：`opencode` + `opencode auth login`）
