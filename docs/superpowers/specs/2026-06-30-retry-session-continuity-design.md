# Spec: Retry Session Continuity Across Providers

## Goal

Unify `-r` retry semantics so that **all retry attempts within the same agent reuse the same session**. The agent retains conversation context from prior attempts, enabling different answers on regex-mismatch or empty-output retries (e.g. attempt 1 → `Hi`, attempt 2 → `hello`).

Session continuity applies to **every retriable scenario** (regex mismatch, empty output, timeout). It does **not** carry across multi-agent fallback (`-t copilot -t codex`).

## Background / Problem

Observed behavior from debug logs:

```text
[wrapper][info]... agent claude-free attempt session 1/2 session=(pending)
[wrapper][info]... agent claude-free attempt session 2/2 session=04f8916f-a209-45ce-a1f2-c28181200bee
```

Claude already continues the same session on retry because `createSession` runs once and the SDK keeps a long-lived connection. `docs/design.md` documents this for Claude only.

| Provider | Retry session behavior (current) |
|----------|----------------------------------|
| Claude | ✅ Same long-lived `query()` session |
| Copilot / Gemini / Cursor (ACP) | ✅ Same ACP connection + `sessionId` |
| OpenCode | ✅ Updates `session.sessionId`; injects `--session` on next spawn |
| Agy | ✅ Updates `session.sessionId`; injects `--conversation` on next spawn |
| **Codex** | ❌ Each `send` spawns fresh `codex exec ...` without `resume <thread_id>` |

Codex is the only provider that breaks session continuity on retry.

## Decisions (confirmed)

| Topic | Decision |
|-------|----------|
| Retry scenarios | **All** retriable cases continue same session (regex mismatch, empty output, timeout) |
| Cross-agent fallback | **Never** pass session id to the next agent |
| User `-s` | Independent of auto-retry resume: `-s` sets the starting session; attempt 2+ auto-resume within same agent |
| Implementation approach | Provider-level contract (Approach A): fix Codex to mirror OpenCode; document contract; optional debug log in `main.js` |
| Claude / ACP / OpenCode / Agy | No code changes |

## Provider Contract: Retry Session Continuity

Each provider's `createSession` + `send` must satisfy:

1. **Attempt 1**: Create new session when no `-s`; restore from `-s` when user specifies one.
2. **Attempt 2+** (same agent, same `createSession` lifecycle):
   - If `sessionId` is known, subsequent `send` **must** continue on that session.
   - If attempt 1 returned no `sessionId` (rare), attempt 2 starts fresh.
3. **Fallback agents**: Do not pass session id when switching to the next `-t` agent.

### Per-provider mechanics

| Provider | Mechanism | Change |
|----------|-----------|--------|
| Claude | Long-lived SDK `query()`; retry pushes another user message | None |
| Copilot / Gemini / Cursor | ACP long connection; `prompt({ sessionId })` | None |
| OpenCode | Spawn per send; inject `--session` from `session.sessionId` | None |
| Agy | Spawn per send; inject `--conversation` from `session.sessionId` | None |
| Codex | Spawn per send; inject `exec resume <thread_id>` | **Implement** |

## Codex Implementation

Mirror the OpenCode pattern in `src/provider/codex.js`.

### 1. `createSession` return value

Add `sessionId: resume || null` (pre-filled when user passes `-s`).

### 2. New helper: `insertResumeAfterExec(args, sessionId)`

- When `sessionId` is set and `args` does not already contain `resume`, insert `resume <id>` immediately after `exec`.
- Same insertion rules as existing `ensureFlags(args, resume)`; used at `send` time for dynamic retry resume.
- Skip when user `-c` already includes `resume`.

### 3. `send()` changes

```
args = insertResumeAfterExec([...session.baseArgs], session.sessionId)
spawn(cmd, [...args, prompt])
// on close:
extracted = extractSessionId(events)
session.sessionId = extracted || session.sessionId
return { ..., sessionId: session.sessionId }
```

### Command evolution example

| Attempt | Spawn command |
|---------|---------------|
| 1 | `codex exec --json ... <prompt>` |
| 2 (regex retry) | `codex exec resume <thread_id> --json ... <prompt>` |
| 1 with `-s` | `codex exec resume <user-id> --json ... <prompt>` |

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Regex mismatch / empty output retry | Same session; same prompt resent; agent sees prior turn |
| Timeout retry | Same session. Subprocess killed (Codex/OpenCode/Agy) but `thread_id` / session id usually emitted early in NDJSON; next spawn uses resume |
| Attempt 1 never got sessionId | Next attempt starts fresh (no id to resume) |
| Non-zero exit / quota / exclude match | No retry; continuity rule N/A (`main.js` breaks loop) |
| Multi-agent fallback | `closeSession` current agent; next agent fresh `createSession` |
| User `-s` + `-r` | `-s` defines start; retries continue on that session |

## Debug Logging (`main.js`)

When entering a retry attempt and session id is known:

```text
retry: continuing session <sessionId>
```

When session id is still empty:

```text
retry: no session id yet, starting fresh
```

## Files to Change

| File | Change |
|------|--------|
| `src/provider/codex.js` | `insertResumeAfterExec`; `sessionId` on session; dynamic resume in `send` |
| `src/main.js` | Debug log on retry branch |
| `test/provider/codex.test.js` | Unit tests for helper and retry resume (mock spawn, follow `agy.test.js` pattern) |
| `docs/design.md` | Extend "Session 复用" to all providers |
| `docs/providers.md` | Codex retry resume note (if applicable section exists) |

## Testing

### `test/provider/codex.test.js`

- `insertResumeAfterExec`: inserts after `exec`; skips when `resume` present; no-op without id
- **Retry within same session**: two `send()` calls; second spawn args include `resume <thread_id>`
- **No duplicate resume**: `createSession({ resume: userId })` → single resume in args
- **Timeout preserves id**: mock emits `thread.started` then hangs; after timeout `session.sessionId` set; second `send` includes resume

### Optional integration-style test

Mock codex in `test/main.test.js` or `test/fallback.test.js`: `-r 2 -e bad` triggers two `send` calls on same session object with id populated after first call.

### Regression

```bash
npm test
```

## Documentation Update (`docs/design.md`)

Replace Claude-only "Session 复用" with:

> `-r` retries run in the same session for the same agent (not across fallback agents). Claude/ACP use long-lived connections; Codex/OpenCode/Agy spawn a new process per attempt but inject resume parameters (`exec resume`, `--session`, `--conversation`). User `-s` specifies an external session; without `-s`, attempt 1 creates new, attempt 2+ auto-resumes.

## Out of Scope

- Cross-provider session handoff
- Changing retry prompt text (same prompt resent)
- Reconnecting ACP after connection-level failure (existing error paths unchanged)
