# wrapper 快速上手

# 快速构建

```bash
npm install
make build          # 构建 4 平台二进制到 dist/
```

`dist/` 下生成：`wrapper-macos-arm64`、`wrapper-linux-x64`、`wrapper-linux-arm64`。

## 基本用法

```bash
# 发送 prompt
node src/main.js -p "分析项目架构"

# 自定义命令
node src/main.js -p "hello" -c "claude-free-remote"

# 恢复会话
node src/main.js -p "continue" -s <session-id>

# 开启 debug 日志
node src/main.js -p "hello" -d

# 正则匹配 + 重试（复用同一 session）
node src/main.js -p "运行测试" -e "PASS" -r 5

# 超时控制
node src/main.js -p "长任务" -o 30

# 查看帮助
node src/main.js -h
```

## CLI 参数

| 参数 | 必填 | 默认值 | 说明 |
|------|:----:|--------|------|
| `-p, --prompt` | 是 | - | 用户提示词 |
| `-t, --type` | 否 | `claude` | provider 类型：claude / codex / copilot / gemini |
| `-c, --command` | 否 | 跟 `-t` 联动 | 实际执行的命令，支持带参数如 `"claude --resume id"` |
| `-d, --debug` | 否 | 关 | 开启日志（所有级别输出到 stderr） |
| `-e, --reg` | 否 | 空 | 正则匹配模式，不匹配则重试 |
| `-r, --retry` | 否 | 3 | 最大重试次数 |
| `-s, --resume` | 否 | 空 | 恢复已有 session ID |
| `-o, --timeout` | 否 | 0（无超时） | 单次调用超时秒数 |
| `-h, --help` | 否 | - | 输出帮助信息 |

## 输出

| 输出 | 内容 |
|------|------|
| stdout | Claude 的回答文本（自动去除首尾空行、压缩连续空行） |
| stderr | 思考过程 + 最后一行 session ID |
| exit code | 0 = 成功，200 = 正则不匹配，201 = 空输出，202 = 异常，203 = 超时，204 = 命令未找到 |

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
```

### 正则匹配 + 重试

```bash
node src/main.js -p "运行测试" -e "PASS" -r 3
# 重试日志会显示具体原因：regex /PASS/ not matched, output: ...
# 退出码 200 表示正则匹配耗尽
```

### 调试

```bash
node src/main.js -p "hello" -d
# -d 输出所有日志到 stderr：attempt 进度、session ID、retry 原因
```

## 依赖

- Node.js >= 18
- Claude CLI 已安装并认证
