# 多 Agent Fallback 冗余调用设计

## 概述

支持在命令行中指定多个 Agent，按顺序尝试调用。当前面的 Agent 失败时，自动 fallback 到下一个 Agent；如果某个 Agent 成功，则直接结束。

## 命令行语法

### 多 `-t`/`-c` 配对

通过多次指定 `-t` 来声明多个 Agent，每个 `-t` 可选紧跟一个 `-c` 指定命令：

```bash
# 基本轮转：先尝试 copilot，失败则尝试 codex
wrapper -t copilot -t codex -p "say hi in one word"

# 带自定义命令的轮转
wrapper -t claude -c "claude-deepseek" -t claude -c "claude-deepseek-flash" -p "say hi in one word"

# 共享选项（retry/timeout/reg）适用于每个 Agent
wrapper -t copilot -t codex -r 3 -p "say hi in one word"
```

### 配对规则

- `-c`/`--command` 必须紧跟在 `-t`/`--type` 之后，不能被其他选项隔断
- 每个 `-t` 最多跟一个 `-c`
- 没有 `-c` 的 `-t` 使用该类型的默认 command

### 校验错误

| 情况 | 错误消息 |
|------|---------|
| `-c` 前无 `-t` | `-c/--command must follow a -t/--type option` |
| `-c` 与 `-t` 间被其他选项隔断 | `-c/--command must immediately follow -t/--type` |
| 一个 `-t` 后出现两个 `-c` | `duplicate -c/--command for -t <type>` |
| 多 Agent + `--resume` | `--resume cannot be used with multiple agents` |

### 向后兼容

单个 `-t` 的行为与现有行为完全一致。未指定 `-t` 时默认 `claude`。

## 解析实现

### 两阶段解析

**阶段一**：手动扫描 argv，提取 `-t`/`-c` 配对，构建 `agents[]` 数组：

- 遇到 `-t`/`--type` → 创建新 agent slot `{type: value, command: null}`
- 遇到 `-c`/`--command` → 检查是否紧跟 `-t <value>` 之后且 command 尚未设置，满足则设置，否则报错
- 其他 token → 收集到 `remainingArgs[]`

**阶段二**：用 `node:util parseArgs` 解析 `remainingArgs[]`（`-p`、`-d`、`-e`、`-r`、`-o`、`-s`）。

### 返回值结构

```js
{
  prompt, debug, reg, retry, resume, timeout,
  agents: [
    { type: "copilot", command: "copilot --acp ...", commandName: "copilot" },
    { type: "codex",   command: "codex exec ...",    commandName: "codex" },
  ]
}
```

- `commandName`：用户 `-c` 指定的值，未指定则为 `-t` 类型名
- `command`：完整的执行命令字符串（从 `-c` 或 DEFAULTS 解析）

## 执行流程

### 双层循环

```
外层：遍历 agents[] 中的每个 agent
  创建 session
  内层：retry 循环（attempt 0 ~ retry）
    调用 provider.send()
    判断成功/失败
  closeSession
```

### 失败判定（触发 fallback）

以下任一条件触发 fallback 到下一个 Agent：

1. retry 全部用完且 stdout 为空
2. retry 全部用完且 regex 不匹配
3. timeout — 直接 fallback，不继续 retry
4. provider send 抛异常 — 直接 fallback，不继续 retry
5. 非零 exit code — 直接 fallback，不继续 retry

### 成功判定

`canRetry()` 返回 false 且 exitCode === 0。

### 结果收集

维护 `allResults[]` 数组，记录每个 agent 每次尝试的结果 `{agentCommandName, stdout, stderr, sessionId}`，用于最终 stderr 聚合输出。

## 输出规范

### stdout

- 成功：输出成功 Agent 的 stdout
- 全部失败：输出最后一个 Agent 的 stdout

### stderr 格式

所有情况统一格式，聚合所有已尝试 Agent 的输出：

```
[copilot] stderr:
copilot的stderr内容
[copilot] stdout:
copilot的stdout内容
[codex] stderr:
codex的stderr内容
codex
session-id-456
```

- 最后两行始终是：agentCommandName + sessionId
- agentCommandName = 成功 agent 的 commandName（或全部失败时最后一个 agent 的 commandName）
- sessionId = 成功 agent 的 sessionId（或全部失败时最后一个 agent 的 sessionId）

### agentCommandName 值

- 用户指定了 `-c` → 输出 `-c` 的值（如 `claude-deepseek`）
- 未指定 `-c` → 输出 `-t` 的类型名（如 `codex`）
- 无论单 Agent 还是多 Agent 模式都输出

### exit code

- 成功：成功 agent 的 exitCode（通常为 0）
- 全部失败：最后一个 agent 的退出码（遵循现有 `EXIT_*` 常量逻辑）

## 帮助文本

帮助文本改为中文：

```
用法: wrapper -p <提示词> [选项]

一次性 AI 编码代理 CLI 封装器。

必填:
  -p, --prompt <文本>     用户提示词

选项:
  -t, --type <名称>       代理类型: claude, codex, copilot, gemini, cursor (默认: claude)
                          可多次指定以实现冗余调用
  -c, --command <命令>     执行命令 (须紧跟 -t 之后，默认根据 -t 决定)
  -d, --debug             开启调试日志输出到 stderr
  -e, --reg <模式>        用于匹配输出的正则表达式
  -r, --retry <次数>       最大重试次数 (默认: 3)
  -s, --resume <id>       恢复之前的会话
  -o, --timeout <秒>      超时时间，单位秒 (默认: 0，不限时)
  -h, --help              显示此帮助

输出:
  stdout  = 子进程标准输出
  stderr  = 子进程标准错误 + 代理命令名 (倒数第二行) + 会话 ID (最后一行)
  退出码  = 子进程退出码

示例:
  wrapper -t copilot -t codex -p "say hi in one word"
  wrapper -t claude -c "claude-deepseek" -t claude -c "claude-deepseek-flash" -p "say hi"
  wrapper -t copilot -t codex -r 3 -p "say hi in one word"
```

## 互斥约束

- `--resume` / `-s` 与多 Agent 模式互斥。`agents.length > 1` 且 `resume` 非空时报错。

## 不改动的部分

- Provider 层接口不变（`createSession`/`send`/`closeSession`）
- `log.js` 不变
- 现有 exit code 常量不变
- 各 provider 实现文件不变

## 测试计划

### parseArgs 测试

- 多个 `-t` 正确解析为 `agents[]`
- `-t` + `-c` 配对正确
- 无 `-c` 时使用默认 command
- 错误组合报错（4 种情况）
- 多 Agent + resume 互斥
- 单 Agent 向后兼容（`agents.length === 1`）
- `commandName` 正确（-c 值 vs -t 类型名）

### buildStderrOutput 测试

- 多 agent 结果聚合格式正确
- agentCommandName + sessionId 在最后两行
- 分隔标记格式正确

### 现有测试适配

- `parseArgs` 返回值结构变化（增加 `agents[]`，移除顶层 `type`/`command`），需更新现有测试
