# Spec: Stderr Output Redesign & Contextual Debug Logging

## Goal

Improve stderr observability in two ways:

1. **Final stderr (always emitted):** Output only the **last agent's** stderr (plus wrapper error on failure) and the two trailing metadata lines. Stop aggregating all fallback agents into the final stderr block.
2. **Debug logging (`-d`):** On every failed attempt, immediately dump that attempt's stdout and stderr into wrapper logs so failures align chronologically with their cause. Add `[agentName][attempt/maxAttempts]` to all wrapper log lines (`info` / `error` / `debug`) when agent context is set.

## Background / Problem

Current behavior:

- `buildStderrOutput` aggregates **every** tried agent's `[name] stdout:`, `[name] stderr:`, and optional `[name] error:` into one block at process exit. With multi-agent fallback, the final stderr is long and hard to scan.
- Debug logs dump stdout/stderr content only on **timeout** and **retry-needed** paths. Other failures (e.g. non-zero exit code) log character counts only; content appears only in the final aggregated stderr block at the end.
- Without `-d`, intermediate failed agents' output is mixed into final stderr; with `-d`, failure output and failure reason are temporally separated.

## Decisions (confirmed)

| Topic | Decision |
|-------|----------|
| Final stderr on last-agent failure | Keep `[agent] stderr:` + `[agent] error:` + commandName + sessionId |
| Final stderr on success | `[agent] stderr:` + commandName + sessionId (no `error:` line) |
| Final stderr stdout section | **Remove** — do not emit `[agent] stdout:` in final stderr |
| Intermediate fallback agents (no `-d`) | Output **discarded** from final stderr; only last agent appears |
| Intermediate fallback agents (with `-d`) | Full stdout/stderr visible via immediate debug dumps per failed attempt |
| Log context prefix | `[agentName][attempt/maxAttempts]` on **info, error, and debug** when context is set |
| Implementation approach | Minimal change (Approach A): refactor `buildStderrOutput` + add dump helper + log context |

## Final Stderr Format

Emitted once at process exit (success or all-failed), after stdout is written.

### Last agent succeeded

```text
[<commandName>] stderr:
<agent stderr / thinking content>
<commandName>
<sessionId>
```

### Last agent failed

```text
[<commandName>] stderr:
<agent raw stderr>
[<commandName>] error:
<wrapperError>
<commandName>
<sessionId>
```

Examples of `wrapperError`:

- `non-zero exit code 1`
- `timed out after 3600s`
- `quota exceeded: /pattern/i matched`
- `exclude pattern matched: /pattern/i`
- `session creation failed: ...`
- `provider send failed: ...`
- `all 3 attempts exhausted: ...`

### Multi-agent fallback (codex fails → cursor succeeds, no `-d`)

Final stderr contains **only cursor's block** + trailing lines. Codex output is not present.

### Metadata lines (unchanged semantics)

- **Last line:** session ID (may be empty)
- **Second-to-last line:** final agent's `commandName`

Scripts using `tail -1` / `sed '$d' | tail -1` continue to work.

## API Change: `buildStderrOutput`

```javascript
// Before
buildStderrOutput(agentCommandName, sessionId, agentResults[])

// After
buildStderrOutput(agentCommandName, sessionId, result)
// result: { commandName, stdout, stderr, wrapperError? }
```

- `stdout` remains on the result object for internal/debug use but is **not** written to final stderr.
- Call sites pass the **last relevant result** only (success result or last failure result).
- Remove multi-agent aggregation loop.

## Debug: Immediate Attempt Failure Dump

When `-d` is enabled, on **every attempt failure** (before moving to retry, next agent, or exit), emit:

```text
[wrapper][debug][timestamp][<agentName>][<attempt>/<maxAttempts>] agent <name> attempt session <n> stdout:
<full stdout or (empty)>

[wrapper][debug][timestamp][<agentName>][<attempt>/<maxAttempts>] agent <name> attempt session <n> stderr:
<full stderr or (empty)>
```

Then emit the existing `[wrapper][error][...]` reason line (also with context prefix).

**Order:** stdout dump → stderr dump → error reason.

### Failure paths that must call the dump helper

| Path | Previously dumped content? | After |
|------|---------------------------|-------|
| Retry needed (empty / regex mismatch) | Yes | Keep |
| Timeout | Yes | Keep |
| Non-zero exit code | No | **Add** |
| Quota exceeded | No | **Add** |
| Exclude regex matched | No | **Add** |
| `provider.send` throws | No | **Add** if partial `lastResult` available; else dump `(empty)` |
| `createSession` throws | No | **Add** with `(empty)` outputs |
| Retry exhausted | Last attempt usually covered by retry-needed dump | Keep; ensure last attempt is covered |

Extract a helper, e.g. `logAttemptOutput(agentName, attempt, maxAttempts, stdout, stderr)`, called from all failure branches. Consolidate duplicate dump lines in timeout/retry paths to use the same helper.

### Character-count debug lines

Keep existing lines after successful `send` return:

```text
agent <name> attempt session <n> stdout output chars: <n>
agent <name> attempt session <n> stderr output chars: <n>
```

They inherit the new context prefix automatically.

## Log Context Prefix (`log.js`)

Add contextual prefix to all log levels when agent context is active.

### Format

```text
[wrapper][<level>][<timestamp>][<agentName>][<session>] <message>
```

- `<session>` = `<attempt>/<maxAttempts>` during an attempt (e.g. `1/3`)
- `<session>` = `-` when agent is known but no attempt is active (e.g. before first attempt of an agent, or during `createSession` before attempt counter is set)

### API

```javascript
setContext({ agentName, attempt, maxAttempts })  // attempt/maxAttempts optional
clearContext()
```

Implement in `write()`: append `[agentName][session]` when `agentName` is set.

### Context lifecycle in `main.js`

| Phase | Context |
|-------|---------|
| Startup / parse / validation | No context (legacy prefix) |
| Enter agent loop, before attempts | `{ agentName, attempt: undefined }` → `[agent][-]` |
| Start attempt N | `{ agentName, attempt: N, maxAttempts }` |
| After agent loop iteration | Update or clear as appropriate |
| Process end | `clearContext()` |

Provider modules (`claude.js`, `codex.js`, `acp.js`, etc.) require **no signature changes** — they call `log.debug` as today; context is set by `main.js` before `createSession` / `send` and inherited automatically.

### Example timeline

```text
[wrapper][info][2026-06-30 06:14:39] wrapper starting: agents=4
[wrapper][info][2026-06-30 06:14:39][codex][-] trying agent 1/4: codex (codex)
[wrapper][debug][2026-06-30 06:14:39][codex][-] codex: spawning ...
[wrapper][info][2026-06-30 06:14:39][codex][1/3] agent codex attempt session 1/3 session=...
[wrapper][debug][2026-06-30 06:14:39][codex][1/3] agent codex attempt session 1 stdout:
(empty)
[wrapper][debug][2026-06-30 06:14:39][codex][1/3] agent codex attempt session 1 stderr:
Reading additional input from stdin...
[wrapper][error][2026-06-30 06:14:39][codex][1/3] agent codex attempt session 1: non-zero exit code 1
[wrapper][error][2026-06-30 06:14:39][codex][-] agent codex failed, falling back to next agent
[wrapper][info][2026-06-30 06:14:39][cursor][-] trying agent 2/4: cursor (cursor)
```

Note: `trying agent 2/4` remains in the **message** (fallback index). Prefix `[session]` is always **attempt/maxAttempts within the current agent**, not fallback index.

## Unchanged

- stdout: last agent's answer text only
- Exit codes and failure classification logic
- Provider interfaces (`createSession` / `send` / `closeSession`)
- Retry / fallback / quota / exclude behavior
- Direct `process.stderr.write` for fatal errors (`Error: command not found`, etc.)

## Breaking Changes

1. Final stderr no longer lists all fallback agents. Consumers that parsed multiple `[agent] stdout:` / `[agent] stderr:` blocks must use `-d` logs for historical attempts or inspect stdout for the final answer only.
2. Final stderr no longer includes `[agent] stdout:` section at all.
3. Debug log line prefix format changes when context is set (additive fields; greps for old exact prefix may need updating).

Document in `docs/design.md`, `docs/get-started.md`, and HELP text in `main.js`.

## Files to Change

| File | Change |
|------|--------|
| `src/log.js` | `setContext`, `clearContext`, prefix in `write()` |
| `src/main.js` | `buildStderrOutput` signature; `logAttemptOutput` helper; set/clear context; dump on all failure paths; update call sites |
| `test/log.test.js` | Context prefix tests |
| `test/main.test.js` | `buildStderrOutput` single-result tests; remove multi-agent aggregation test |
| `test/fallback.test.js` | Final stderr single-agent; debug dump on non-zero exit; context prefix in logs |
| `docs/design.md` | Output spec section |
| `docs/get-started.md` | Output table |

## Testing

### Unit: `buildStderrOutput`

- Success: stderr block + trailing lines, no `error:`, no `stdout:`
- Failure: stderr + error + trailing lines
- Empty stderr: labels present, no content lines between labels

### Unit: `log.js` context

- No context → old prefix
- `{ agentName: 'codex' }` → `[codex][-]`
- `{ agentName: 'codex', attempt: 1, maxAttempts: 3 }` → `[codex][1/3]`
- Applies to info, error, debug

### Integration: fallback + `-d`

- Agent 1 non-zero exit: debug logs contain agent 1 stdout/stderr before error line; prefix `[agent1][1/3]`
- Agent 2 success: final stderr contains only agent 2 block

### Integration: fallback, no `-d`

- Final stderr has no agent 1 content

Run: `npm test`

## Out of Scope

- Streaming agent stderr to wrapper stderr in real time (without `-d`)
- New CLI flags for verbose stderr aggregation
- Changing provider log message text (only prefix changes via context)
