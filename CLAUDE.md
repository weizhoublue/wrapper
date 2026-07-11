# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Test

```bash
npm install          # install dependencies
npm test             # run all tests
node --test test/log.test.js              # single test file
node --test test/provider/claude.test.js
node --test test/main.test.js
node --test test/provider/cursor.test.js
```

No compilation needed — Node.js runs source directly.

## Architecture

One-shot CLI wrapper for AI coding agents. Spawns Claude via `@anthropic-ai/claude-agent-sdk`, passes prompt, collects output, exits.

- **wrapper** (`src/main.js`): CLI entry, subcommand routing, runs retry loop, manages output
- **cli** (`src/cli/`): `route.js` (top-level), `run.js` (`parseRunArgs`), `throttle-cmd.js` (list/delete)
- **log** (`src/log.js`): `[wrapper][level][timestamp]` format to stderr, info/error/debug levels
- **provider** (`src/provider/`): Each provider exports `createSession` / `send` / `closeSession` (claude, codex, copilot, gemini, cursor)

### CLI

```
wrapper [-h] [-v]
wrapper run <选项...> <提示词>
wrapper throttle [-l] [-d <id>]
```

`run` 提示词为**最后一个参数**（无 `-p`）。旧式 `wrapper -p ...` 已移除，会报错并提示迁移。

`-q, --quota` (default on): detect subscription quota exhaustion via built-in LimitMsg patterns; exit 206 when exhausted and no fallback.
`-n, --no-quota`: disable quota detection; non-zero agent exit codes pass through unchanged.

多 Agent 冗余调用:
```
wrapper run -t copilot -t codex "say hi in one word"
wrapper run -t claude -c "claude-deepseek" -t claude -c "claude-deepseek-flash" "say hi"
```

Throttle 管理:
```
wrapper throttle -l          # 列出冷却记录
wrapper throttle -d 1        # 按编号删除
```

### Key design decisions

- **Cursor** provider: `agent --yolo --approve-mcps acp` + ACP `session/new|load`; `authenticate(cursor_login)` after `initialize`; permissions via `session/request_permission` auto-allow in `acp.js`.
- Claude Agent SDK handles all subprocess communication via pipe. No PTY.
- `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true` for non-interactive mode.
- One-shot: `query()` accepts string prompt (no async iterable needed).
- `result` event from SDK provides `session_id`, `subtype`, `result` text.
- Timeout via `setTimeout` + `query.close()`.
- All logs go to stderr.

## Project Conventions

- Node.js built-in modules only (no extra deps beyond SDK).
- Tests in `test/`, run with Node.js native test runner.
- No TypeScript, plain CommonJS.
- 当产生了架构变化和功能变化，如有必要，请更新 docs 目录下的相关设计文档和使用文档