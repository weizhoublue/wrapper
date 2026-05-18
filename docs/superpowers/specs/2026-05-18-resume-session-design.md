# Resume Session 功能设计

## 目标

添加 `-s --resume <session_id>` 选项，支持恢复已有会话继续对话。

## CLI

```
-s, --resume <id>       Resume a previous session
```

与 `-r --retry`（重试次数）独立，互不冲突。

## Provider 行为

### Codex

| 场景 | 生成命令 |
|------|---------|
| 无 `-c`，有 `-s` | `codex exec resume <id> --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check <prompt>` |
| `-c "codex-new"`，有 `-s` | `codex-new exec resume <id> --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check <prompt>` |

`resume <id>` 插在 `exec` 之后、`--json` 之前。

### Claude

| 场景 | 生成命令 |
|------|---------|
| 无 `-c`，有 `-s` | `claude --dangerously-skip-permissions --permission-mode=bypassPermissions --resume <id>` |
| `-c "claude-free"`，有 `-s` | `claude-free --dangerously-skip-permissions --permission-mode=bypassPermissions --resume <id>` |

`--resume <id>` 追加在末尾。

### Copilot

| 场景 | 生成命令 |
|------|---------|
| 无 `-c`，有 `-s` | `copilot --acp --allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user --resume <id>` |
| `-c "copilot-custom"`，有 `-s` | `copilot-custom --acp --allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user --resume <id>` |

`--resume <id>` 追加在末尾。

## 注入规则

- `resume` 由 provider 的 `ensureFlags` / `ensureFlags` 负责注入
- 已有 `resume`（用户 `-c` 自带）则跳过，不重复注入
- 不做额外冲突校验，执行成败由 CLI 工具决定
- `-s` 不改变 DEFAULTS，仅在 `-s` 指定时注入

## 修改文件

| 文件 | 改动 |
|------|------|
| `src/main.js` | `parseArgs` 新增 `-s`，HELP 更新，`createSession` 传 `resume` |
| `src/provider/codex.js` | `ensureFlags(args, resume)` 在 `exec` 后插入 `resume <id>` |
| `src/provider/claude.js` | `ensureFlags(args, resume)` 追加 `--resume <id>` |
| `src/provider/copilot.js` | `ensureFlags(command, resume)` 追加 `--resume <id>` |
| `test/main.test.js` | 新增 `-s` 解析测试 |
| `docs/providers.md` | 更新 resume 说明 |

## 验证

```bash
# Codex resume
wrapper -t codex -p "tomorrow is monday" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
wrapper -t codex -s ${session} -p "tell me what I said"

# Claude resume
wrapper -t claude -c 'claude-free' -p "hello" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
wrapper -t claude -c 'claude-free' -s ${session} -p "what did I say?"

# 自定义 -c + resume（codex）
wrapper -t codex -c "codex exec --sandbox read-only" -s ${session} -p "continue"
```
