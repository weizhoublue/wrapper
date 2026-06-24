# Quota Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect agent subscription quota exhaustion via built-in `LimitMsg` patterns, skip retries, surface a clear `[agent] error:` message in stderr, fallback when possible, and exit `206` when no fallback remains.

**Architecture:** Add `LimitMsg` dictionary and `isQuotaExceeded()` helper in `src/main.js`, parse `-q/--quota` (default on, `--no-quota` off), branch inside the existing non-zero exit guard before generic failure recording, and exit with `EXIT_QUOTA_EXCEEDED = 206` when `quotaExceeded` is set on the last result.

**Tech Stack:** Node.js built-in test runner, `node:util` `parseArgs` with `negatable: true`

## Global Constraints

- `LimitMsg` patterns: `codex: "hit your usage limit"`, `copilot: "You have exceeded your monthly quota"`, `gemini: "You have exhausted your capacity"`; `claude`, `cursor`, `agy` remain `""` (no detection).
- Quota detection requires non-zero `exitCode` AND case-insensitive regex match in **stdout ∪ stderr**.
- Quota detection is enabled by default (`quota: true`); `--no-quota` disables it.
- On quota match: no retry, `wrapperError: quota exceeded: /{pattern}/i matched`, fallback if more agents, else exit `206`.
- When `--no-quota`: keep existing `non-zero exit code N` wrapperError and pass-through agent exit code.
- Out of scope: `sendFailed` / `sessionCreationFailed` paths, zero exit code, user-configurable patterns via CLI.

---

### Task 1: CLI Parsing, Constants, and Helper Unit Tests

**Files:**
- Modify: `src/main.js:30-48` (HELP text)
- Modify: `src/main.js:160-196` (`parseArgs` options and return object)
- Modify: `src/main.js:228-234` (add `EXIT_QUOTA_EXCEEDED = 206` after `EXIT_EXCLUDE_MATCH`)
- Modify: `src/main.js:235-258` (add `LimitMsg`, `isQuotaExceeded`, `quotaReasonBrief` after exit code constants)
- Modify: `src/main.js:491` (`module.exports`)
- Modify: `test/main.test.js:4` (import new symbols)
- Modify: `test/main.test.js:195-207` (exit code test)
- Modify: `test/main.test.js` (new `describe` blocks for quota parsing and helpers)

**Interfaces:**
- Consumes: `node:util` `parseArgs` with `negatable: true`
- Produces: `opts.quota` (`boolean`, default `true`), `LimitMsg` (`object`), `isQuotaExceeded(agentType, stdout, stderr)` → `boolean`, `quotaReasonBrief(pattern)` → `string`, `EXIT_QUOTA_EXCEEDED` (`206`)

- [ ] **Step 1: Write failing tests in `test/main.test.js`**

Update import line:

```javascript
const { parseArgs, isOutputEmpty, canRetry, buildStderrOutput, collapseBlankLines, retryReason, isQuotaExceeded, quotaReasonBrief, LimitMsg, EXIT_OK, EXIT_REGEX_MISMATCH, EXIT_EMPTY_OUTPUT, EXIT_PROVIDER_ERROR, EXIT_TIMEOUT, EXIT_EXCLUDE_MATCH, EXIT_QUOTA_EXCEEDED } = require("../src/main");
```

Add to `describe("parseArgs")`:

```javascript
  it("defaults quota to true", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi"]);
    assert.strictEqual(opts.quota, true);
  });

  it("parses --no-quota", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "--no-quota"]);
    assert.strictEqual(opts.quota, false);
  });
```

Add new `describe("isQuotaExceeded")`:

```javascript
describe("isQuotaExceeded", () => {
  it("matches codex stderr pattern case-insensitively", () => {
    assert.strictEqual(
      isQuotaExceeded("codex", "", "You've hit your usage limit"),
      true,
    );
  });

  it("matches pattern in stdout", () => {
    assert.strictEqual(
      isQuotaExceeded("copilot", "You have exceeded your monthly quota", ""),
      true,
    );
  });

  it("returns false for agents with empty LimitMsg", () => {
    assert.strictEqual(
      isQuotaExceeded("claude", "", "hit your usage limit"),
      false,
    );
  });

  it("returns false when text does not match", () => {
    assert.strictEqual(
      isQuotaExceeded("codex", "", "some other error"),
      false,
    );
  });
});
```

Add to `describe("exit codes")`:

```javascript
  it("has distinct EXIT_QUOTA_EXCEEDED exit code", () => {
    assert.strictEqual(EXIT_QUOTA_EXCEEDED, 206);
  });
```

Add new `describe("quotaReasonBrief")`:

```javascript
describe("quotaReasonBrief", () => {
  it("formats quota exceeded message", () => {
    assert.strictEqual(
      quotaReasonBrief("hit your usage limit"),
      "quota exceeded: /hit your usage limit/i matched",
    );
  });
});
```

Add to `describe("buildStderrOutput")`:

```javascript
  it("includes quota exceeded wrapper error in error section", () => {
    const result = buildStderrOutput("codex", "sid-q", [
      {
        commandName: "codex",
        stdout: "",
        stderr: "You've hit your usage limit",
        wrapperError: "quota exceeded: /hit your usage limit/i matched",
      },
    ]);
    assert.ok(result.includes("[codex] stderr:\nYou've hit your usage limit"));
    assert.ok(result.includes("[codex] error:\nquota exceeded: /hit your usage limit/i matched"));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/main.test.js`

Expected: FAIL — `isQuotaExceeded is not a function`, `EXIT_QUOTA_EXCEEDED` undefined, or `opts.quota` undefined.

- [ ] **Step 3: Implement parsing, constants, and helpers in `src/main.js`**

Add after `DEFAULTS` block (before `HELP`):

```javascript
const LimitMsg = {
  claude: "",
  codex: "hit your usage limit",
  copilot: "You have exceeded your monthly quota",
  gemini: "You have exhausted your capacity",
  cursor: "",
  agy: "",
};
```

Add HELP line after `-x, --exclude`:

```javascript
  -q, --quota             检测 agent 订阅额度耗尽（默认开启）；--no-quota 关闭
```

In `parseArgs` `nodeParseArgs` options:

```javascript
      quota:     { type: "boolean", short: "q", default: true, negatable: true },
```

In `parseArgs` return object:

```javascript
    quota: values.quota,
```

After `EXIT_EXCLUDE_MATCH`:

```javascript
const EXIT_QUOTA_EXCEEDED = 206;
```

Add helpers after `excludeReasonBrief`:

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

Update `module.exports`:

```javascript
module.exports = { main, parseArgs, isOutputEmpty, canRetry, buildStderrOutput, collapseBlankLines, retryReason, LimitMsg, isQuotaExceeded, quotaReasonBrief, EXIT_OK, EXIT_REGEX_MISMATCH, EXIT_EMPTY_OUTPUT, EXIT_PROVIDER_ERROR, EXIT_TIMEOUT, EXIT_COMMAND_NOT_FOUND, EXIT_EXCLUDE_MATCH, EXIT_QUOTA_EXCEEDED };
```

- [ ] **Step 4: Run test to verify Task 1 passes**

Run: `node --test test/main.test.js`

Expected: PASS for all tests in this file.

- [ ] **Step 5: Commit**

```bash
git add src/main.js test/main.test.js
git commit -m "feat: add quota detection CLI option, helpers, and unit tests"
```

---

### Task 2: Core Quota Detection in Retry Loop and E2E Tests

**Files:**
- Modify: `src/main.js:284-285` (debug log includes `quota`)
- Modify: `src/main.js:377-389` (non-zero exit branch — insert quota check before generic handler)
- Modify: `src/main.js:459-474` (final exit — check `quotaExceeded` before `exitCode` pass-through)
- Modify: `test/fallback.test.js:41` (import `EXIT_QUOTA_EXCEEDED`)
- Modify: `test/fallback.test.js` (add 4 integration tests after exclude tests)

**Interfaces:**
- Consumes: `opts.quota`, `isQuotaExceeded(agent.type, lastResult.stdout, lastResult.stderr)`, `LimitMsg[agent.type]`, `quotaReasonBrief(pattern)`
- Produces: `allResults[].quotaExceeded === true` with `wrapperError` set; `process.exit(EXIT_QUOTA_EXCEEDED)` when last agent quota-fails

- [ ] **Step 1: Write failing integration tests in `test/fallback.test.js`**

Update import:

```javascript
const { main, EXIT_OK, EXIT_TIMEOUT, EXIT_PROVIDER_ERROR, EXIT_COMMAND_NOT_FOUND, EXIT_EXCLUDE_MATCH, EXIT_REGEX_MISMATCH, EXIT_QUOTA_EXCEEDED } = require("../src/main");
```

Add tests after exclude tests:

```javascript
  it("exits 206 when codex quota pattern matches on non-zero exit", async () => {
    mockProviders.codex.sendMock = () => ({
      stdout: "",
      stderr: "You've hit your usage limit",
      sessionId: "codex-session",
      exitCode: 1,
    });

    await runMain(["-t", "codex", "-p", "hello"]);

    assert.strictEqual(exitCode, EXIT_QUOTA_EXCEEDED);
    assert.ok(stderrData.includes("[codex] error:"));
    assert.ok(stderrData.includes("quota exceeded: /hit your usage limit/i matched"));
  });

  it("falls back to next agent when first agent hits quota", async () => {
    mockProviders.codex.sendMock = () => ({
      stdout: "",
      stderr: "You've hit your usage limit",
      sessionId: "codex-session",
      exitCode: 1,
    });
    let copilotCalled = false;
    mockProviders.copilot.sendMock = () => {
      copilotCalled = true;
      return { stdout: "all fine", stderr: "", sessionId: "copilot-session", exitCode: 0 };
    };

    await runMain(["-t", "codex", "-t", "copilot", "-p", "hello"]);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(copilotCalled, true);
    assert.ok(stderrData.includes("quota exceeded: /hit your usage limit/i matched"));
    assert.ok(stdoutData.includes("all fine"));
  });

  it("passes through exit code when --no-quota", async () => {
    mockProviders.codex.sendMock = () => ({
      stdout: "",
      stderr: "You've hit your usage limit",
      sessionId: "codex-session",
      exitCode: 1,
    });

    await runMain(["-t", "codex", "-p", "hello", "--no-quota"]);

    assert.strictEqual(exitCode, 1);
    assert.ok(stderrData.includes("non-zero exit code 1"));
    assert.ok(!stderrData.includes("quota exceeded"));
  });

  it("does not treat non-matching non-zero exit as quota", async () => {
    mockProviders.codex.sendMock = () => ({
      stdout: "",
      stderr: "some other error",
      sessionId: "codex-session",
      exitCode: 1,
    });

    await runMain(["-t", "codex", "-p", "hello"]);

    assert.strictEqual(exitCode, 1);
    assert.ok(stderrData.includes("non-zero exit code 1"));
    assert.ok(!stderrData.includes("quota exceeded"));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/fallback.test.js`

Expected: FAIL — exit code `1` instead of `206`, or missing `quota exceeded` in stderr.

- [ ] **Step 3: Implement quota branch in `src/main.js`**

Update debug log:

```javascript
  log.debug("prompt=%s timeout=%ds retry=%d reg=%s exclude=%s quota=%s",
    opts.prompt.slice(0, 100), opts.timeout, opts.retry, opts.reg || "(none)", opts.exclude || "(none)", opts.quota);
```

Replace the non-zero exit block (lines ~377-389) with:

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

          log.error("agent %s attempt %d: non-zero exit code %d", agent.commandName, attempt + 1, lastResult.exitCode);
          allResults.push({
            commandName: agent.commandName,
            stdout: lastResult.stdout || "",
            stderr: lastResult.stderr || "",
            sessionId: session.sessionId || lastResult.sessionId || "",
            exitCode: lastResult.exitCode,
            wrapperError: `non-zero exit code ${lastResult.exitCode}`,
          });
          agentDone = true;
          break;
        }
```

In final exit block, insert **before** the `exitCode` pass-through check:

```javascript
    if (lastAgentResult.quotaExceeded) {
      process.exit(EXIT_QUOTA_EXCEEDED);
    }
```

Order must be: `quotaExceeded` → then `exitCode` pass-through → then `excludeMatched` → etc.

- [ ] **Step 4: Run all tests**

Run: `npm test`

Expected: PASS for entire test suite.

- [ ] **Step 5: Commit**

```bash
git add src/main.js test/fallback.test.js
git commit -m "feat: detect agent quota exhaustion and exit 206"
```

---

### Task 3: Documentation Updates

**Files:**
- Modify: `docs/design.md:40-71` (CLI table, exit code table, failure description)
- Modify: `CLAUDE.md:28-32` (CLI options list)

**Interfaces:**
- Consumes: implemented behavior from Tasks 1–2
- Produces: updated user-facing docs

- [ ] **Step 1: Update `docs/design.md`**

Add to CLI options table:

```markdown
| `-q, --quota` | 否 | 开 | 检测 agent 订阅额度耗尽；`--no-quota` 关闭 |
```

Update exit code range in output table: `200-206`

Add to exit code table:

```markdown
| 206 | 订阅额度耗尽（非零退出且 stdout/stderr 命中内置 `LimitMsg` 模式） |
```

Update failure description line (~147) to mention `206` quota exhaustion.

- [ ] **Step 2: Update `CLAUDE.md`**

Add to CLI block after `-x`:

```
wrapper -p <prompt> ... [-q|--no-quota] ...
```

And in options description area, add:

```
-q, --quota (default on, --no-quota to disable): detect subscription quota exhaustion via built-in LimitMsg patterns; exit 206 when exhausted and no fallback.
```

- [ ] **Step 3: Verify docs match implementation**

Run: `npm test`

Expected: PASS (docs-only change, no code impact).

- [ ] **Step 4: Commit**

```bash
git add docs/design.md CLAUDE.md
git commit -m "docs: document quota detection option and exit code 206"
```

---

## Self-Review Checklist

| Spec requirement | Task |
|------------------|------|
| `LimitMsg` dictionary | Task 1 |
| `-q/--quota` default on, `--no-quota` off | Task 1 |
| Non-zero exit + stdout∪stderr match | Task 2 |
| No retry on quota match | Task 2 |
| `wrapperError` in stderr output | Task 1 (unit) + Task 2 (E2E) |
| Fallback to next agent | Task 2 |
| Exit `206` when no fallback | Task 2 |
| `--no-quota` pass-through | Task 2 |
| claude/cursor/agy empty (no detection) | Task 1 unit test |
| Documentation | Task 3 |
| Out of scope items not implemented | N/A |
