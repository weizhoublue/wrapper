# Design Spec: Agent Quota Detection (`-q`, `--quota`)

## 1. Overview

Add built-in subscription quota exhaustion detection to `wrapper`. When an agent returns a non-zero exit code and its stdout or stderr matches a known quota message pattern, the wrapper marks the agent as quota-exhausted, skips further retries, and either falls back to the next agent or exits with a dedicated code `206`.

Quota detection is enabled by default and can be disabled with `--no-quota`.

## 2. Requirements

### 2.1 `LimitMsg` Dictionary

Add a top-level constant in `src/main.js`:

```javascript
const LimitMsg = {
  claude: "",                                    // unknown — no pattern yet
  codex: "hit your usage limit",
  copilot: "You have exceeded your monthly quota",
  gemini: "You have exhausted your capacity",
  cursor: "",                                    // unknown — no pattern yet
  agy: "",                                       // no stderr pattern; empty output + success exit
};
```

- Keys are agent `type` values (`-t` names).
- Empty string means quota detection is skipped for that agent type.

### 2.2 Detection Conditions

All of the following must be true (`opts.quota === true`):

1. `LimitMsg[agent.type]` is a non-empty string.
2. `lastResult.exitCode !== 0`.
3. `new RegExp(LimitMsg[agent.type], "i")` matches **stdout** or **stderr** (case-insensitive).

Examples from real agent output:

| Agent   | stderr example                          | exit code |
|---------|-----------------------------------------|-----------|
| codex   | `You've hit your usage limit`           | non-zero  |
| copilot | `You have exceeded your monthly quota`  | non-zero  |
| gemini  | `You have exhausted your capacity`      | non-zero  |

Partial substring match is intentional (e.g. codex pattern `hit your usage limit` matches `You've hit your usage limit`).

### 2.3 Behavior on Quota Match

- Stop retrying the current agent immediately (`agentDone = true`, `break`).
- Record result with `quotaExceeded: true` and a descriptive `wrapperError`.
- If a fallback agent exists → continue to the next agent.
- If this was the last agent → exit with `206` (`EXIT_QUOTA_EXCEEDED`).

### 2.4 Stderr Log Visibility

When quota is detected, set:

```text
wrapperError: quota exceeded: /{pattern}/i matched
```

`buildStderrOutput` already renders `wrapperError` under `[{commandName}] error:`, so callers capturing stderr (e.g. `2>/tmp/log`) see a clear quota indication alongside the agent's stdout/stderr:

```text
[codex] stdout:
[codex] stderr:
You've hit your usage limit
[codex] error:
quota exceeded: /hit your usage limit/i matched
```

### 2.5 CLI Option

| Flag | Default | Description |
|------|---------|-------------|
| `-q`, `--quota` | `true` | Enable quota detection |
| `--no-quota` | — | Disable quota detection (`negatable: true`) |

When disabled (`--no-quota`), non-zero exits follow existing behavior: generic `non-zero exit code N` wrapperError and pass-through agent exit code.

## 3. Architecture

### 3.1 Control Flow

Insert quota check inside the per-attempt loop, immediately after the non-zero exit code guard and **before** the generic non-zero failure recording:

```mermaid
graph TD
    A[send returns lastResult] --> B{timedOut?}
    B -- Yes --> C[agentDone, break]
    B -- No --> D{exitCode !== 0?}
    D -- No --> E{exclude matches stdout?}
    D -- Yes --> F{quota enabled AND LimitMsg non-empty AND pattern matches stdout|stderr?}
    F -- Yes --> G[quotaExceeded, wrapperError, agentDone, break]
    F -- No --> H[generic non-zero exit, agentDone, break]
    E --> I{canRetry?}
    G --> J{more agents?}
    H --> J
    J -- Yes --> K[next agent]
    J -- No --> L{quotaExceeded?}
    L -- Yes --> M[exit 206]
    L -- No --> N[existing exit logic]
```

### 3.2 Constants

```javascript
const EXIT_QUOTA_EXCEEDED = 206;
```

Export via `module.exports` alongside existing exit codes.

### 3.3 Helpers

```javascript
function isQuotaExceeded(agentType, stdout, stderr) {
  const pattern = LimitMsg[agentType];
  if (!pattern) return false;
  const re = new RegExp(pattern, "i");
  const text = [stdout || "", stderr || ""].join("\n");
  return re.test(text);
}

function quotaReasonBrief(pattern) {
  return `quota exceeded: /${pattern}/i matched`;
}
```

Export `LimitMsg`, `isQuotaExceeded`, `quotaReasonBrief`, `EXIT_QUOTA_EXCEEDED` for unit tests.

## 4. Implementation Details

### 4.1 `parseArgs`

Add to `nodeParseArgs` options:

```javascript
quota: { type: "boolean", short: "q", default: true, negatable: true }
```

Return `quota: values.quota` in the parsed options object.

Update `HELP` text:

```text
  -q, --quota             检测 agent 订阅额度耗尽（默认开启）；--no-quota 关闭
```

Update debug log line to include `quota=%s`.

### 4.2 Retry Loop (`main`)

Replace the single non-zero exit block with:

```javascript
if (lastResult.exitCode && lastResult.exitCode !== 0) {
  if (opts.quota && isQuotaExceeded(agent.type, lastResult.stdout, lastResult.stderr)) {
    const pattern = LimitMsg[agent.type];
    log.error("agent %s attempt %d: quota exceeded — /%s/i matched",
      agent.commandName, attempt + 1, pattern);
    allResults.push({
      commandName: agent.commandName,
      stdout: lastResult.stdout || "",
      stderr: lastResult.stderr || "",
      sessionId: session.sessionId || lastResult.sessionId || "",
      exitCode: lastResult.exitCode,
      quotaExceeded: true,
      wrapperError: quotaReasonBrief(pattern),
    });
    agentDone = true;
    break;
  }

  // existing generic non-zero exit handling (unchanged)
  log.error("agent %s attempt %d: non-zero exit code %d", ...);
  allResults.push({ ..., wrapperError: `non-zero exit code ${lastResult.exitCode}` });
  agentDone = true;
  break;
}
```

### 4.3 Final Exit

In the all-agents-failed exit block, before other failure checks:

```javascript
if (lastAgentResult.quotaExceeded) {
  process.exit(EXIT_QUOTA_EXCEEDED);
}
```

## 5. Test Strategy

### 5.1 Unit Tests (`test/main.test.js`)

- `parseArgs` defaults `quota` to `true`.
- `--no-quota` sets `quota` to `false`.
- `EXIT_QUOTA_EXCEEDED === 206`.
- `isQuotaExceeded("codex", "", "You've hit your usage limit")` → `true`.
- `isQuotaExceeded("codex", "some stdout", "You've hit your usage limit")` → `true`.
- `isQuotaExceeded("claude", "", "hit your usage limit")` → `false` (empty pattern).
- `quotaReasonBrief("hit your usage limit")` → `quota exceeded: /hit your usage limit/i matched`.
- `buildStderrOutput` includes `[codex] error:\nquota exceeded: /hit your usage limit/i matched`.

### 5.2 Integration Tests (`test/fallback.test.js`)

Using mock providers:

1. **Quota detected, single agent** — codex mock returns `{ exitCode: 1, stderr: "You've hit your usage limit", stdout: "" }` → exit `206`, stderr contains `quota exceeded`.
2. **Quota + fallback** — codex quota-fails, copilot succeeds → exit `0`, codex stderr block shows quota error.
3. **Quota disabled** — same codex mock with `--no-quota` → exit `1`, wrapperError is `non-zero exit code 1`.
4. **Non-zero but no pattern match** — codex mock returns `{ exitCode: 1, stderr: "other error" }` → exit `1`, no quota message.

## 6. Documentation Updates

- `docs/design.md` — document `-q/--quota`, `LimitMsg`, exit code `206`.
- `docs/get-started.md` — optional fallback example mentioning quota fallback.
- `CLAUDE.md` — add `-q` to CLI options list.

## 7. Out of Scope

- Quota detection for `claude`, `cursor`, `agy` until patterns are known.
- Quota detection on `sendFailed` (thrown exceptions) or `sessionCreationFailed` paths.
- Quota detection when exit code is zero.
- Per-user configurable `LimitMsg` patterns via CLI.
