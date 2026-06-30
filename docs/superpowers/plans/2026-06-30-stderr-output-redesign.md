# Stderr Output Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Slim final stderr to the last agent only; dump stdout/stderr immediately on every failed attempt when `-d` is on; add `[agentName][attempt/maxAttempts]` context prefix to all wrapper logs during agent execution.

**Architecture:** Extend `src/log.js` with `setContext`/`clearContext` so provider logs inherit prefixes without signature changes. Refactor `buildStderrOutput` to accept a single result (no multi-agent aggregation). Add `logAttemptOutput` in `src/main.js` and call it from every failure branch before error lines. Set/clear log context around each agent and attempt in the main loop.

**Tech Stack:** Node.js built-in modules only, `node:test`, existing provider mocks in `test/fallback.test.js`.

## Global Constraints

- Final stderr: last agent only; include `[agent] stderr:`; on failure include `[agent] error:`; **never** emit `[agent] stdout:` in final stderr.
- Intermediate fallback agent output: discarded from final stderr without `-d`; visible in debug dumps with `-d`.
- Log prefix when context set: `[wrapper][level][timestamp][agentName][session]` where `session` is `attempt/maxAttempts` or `-`.
- Context prefix applies to **info, error, and debug** when `agentName` is set.
- Provider interfaces unchanged; no new CLI flags.
- Run tests with `npm test` or `node --test test/<file>.test.js`.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/log.js` | Context-aware log prefix |
| `src/main.js` | `buildStderrOutput`, `logAttemptOutput`, context lifecycle, failure dumps |
| `test/log.test.js` | Context prefix unit tests |
| `test/main.test.js` | `buildStderrOutput` single-result tests |
| `test/fallback.test.js` | E2E: final stderr slim, debug dumps, context prefix |
| `docs/design.md` | Output spec |
| `docs/get-started.md` | Output table |
| `src/main.js` HELP | Output section text |

---

### Task 1: Log Context Prefix

**Files:**
- Modify: `src/log.js`
- Modify: `test/log.test.js`

**Interfaces:**
- Produces: `setContext({ agentName, attempt, maxAttempts })`, `clearContext()`, updated prefix in `write()`

- [ ] **Step 1: Write failing context tests**

Add to `test/log.test.js`:

```javascript
  it("prefix includes agent and session when context set", () => {
    log.setDebug(true);
    log.setContext({ agentName: "codex", attempt: 1, maxAttempts: 3 });
    const output = captureLog(() => log.debug("spawn"));
    assert.match(output, /\[wrapper\]\[debug\]\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]\[codex\]\[1\/3\] spawn\n/);
  });

  it("prefix uses dash session when attempt not set", () => {
    log.setDebug(true);
    log.setContext({ agentName: "codex" });
    const output = captureLog(() => log.info("trying"));
    assert.match(output, /\[wrapper\]\[info\].*\[codex\]\[-\] trying\n/);
  });

  it("prefix omits agent bracket when no context", () => {
    log.setDebug(true);
    log.clearContext();
    const output = captureLog(() => log.info("wrapper starting"));
    assert.match(output, /\[wrapper\]\[info\]\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] wrapper starting\n/);
    assert.doesNotMatch(output, /\[codex\]/);
  });

  it("error level gets context prefix", () => {
    log.setDebug(true);
    log.setContext({ agentName: "codex", attempt: 2, maxAttempts: 3 });
    const output = captureLog(() => log.error("non-zero exit code 1"));
    assert.match(output, /\[wrapper\]\[error\].*\[codex\]\[2\/3\] non-zero exit code 1\n/);
  });
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `node --test test/log.test.js`

Expected: FAIL — `setContext is not a function`

- [ ] **Step 3: Implement context in log.js**

Replace `src/log.js` with:

```javascript
const fs = require("fs");
const util = require("util");

let debugEnabled = false;
let context = { agentName: null, attempt: null, maxAttempts: null };

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const padMs = (n) => String(n).padStart(3, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${padMs(d.getMilliseconds())}`;
}

function sessionLabel() {
  if (context.attempt != null && context.maxAttempts != null) {
    return `${context.attempt}/${context.maxAttempts}`;
  }
  return "-";
}

function write(level, format, ...args) {
  const msg = util.format(format, ...args);
  let line = `[wrapper][${level}][${timestamp()}]`;
  if (context.agentName) {
    line += `[${context.agentName}][${sessionLabel()}]`;
  }
  line += ` ${msg}\n`;
  fs.writeSync(process.stderr.fd, line);
}

function info(format, ...args) {
  if (!debugEnabled) return;
  write("info", format, ...args);
}
function error(format, ...args) {
  if (!debugEnabled) return;
  write("error", format, ...args);
}
function debug(format, ...args) {
  if (!debugEnabled) return;
  write("debug", format, ...args);
}
function setDebug(v) { debugEnabled = v; }
function isDebug() { return debugEnabled; }

function setContext({ agentName, attempt, maxAttempts }) {
  context = { agentName: agentName ?? null, attempt: attempt ?? null, maxAttempts: maxAttempts ?? null };
}

function clearContext() {
  context = { agentName: null, attempt: null, maxAttempts: null };
}

module.exports = { info, error, debug, setDebug, isDebug, setContext, clearContext };
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `node --test test/log.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/log.js test/log.test.js
git commit -m "$(cat <<'EOF'
feat(log): add agent/session context prefix for wrapper logs

EOF
)"
```

---

### Task 2: Refactor buildStderrOutput to Single Result

**Files:**
- Modify: `test/main.test.js` (`describe("buildStderrOutput")`)
- Modify: `src/main.js` (`buildStderrOutput` function)

**Interfaces:**
- Consumes: none new
- Produces: `buildStderrOutput(agentCommandName, sessionId, result)` where `result` is `{ commandName, stdout, stderr, wrapperError? }`

- [ ] **Step 1: Replace buildStderrOutput tests**

Replace the entire `describe("buildStderrOutput", ...)` block in `test/main.test.js` with:

```javascript
describe("buildStderrOutput", () => {
  it("success: stderr block and trailing metadata, no stdout or error", () => {
    const result = buildStderrOutput("claude", "sid-1", {
      commandName: "claude",
      stdout: "ignored",
      stderr: "thinking text",
    });
    const lines = result.split("\n");
    assert.strictEqual(lines[lines.length - 1], "sid-1");
    assert.strictEqual(lines[lines.length - 2], "claude");
    assert.ok(result.includes("[claude] stderr:\nthinking text"));
    assert.ok(!result.includes("[claude] stdout:"));
    assert.ok(!result.includes("[claude] error:"));
  });

  it("failure: stderr, error, and trailing metadata", () => {
    const result = buildStderrOutput("codex", "sid-2", {
      commandName: "codex",
      stdout: "Hello.",
      stderr: "Reading additional input from stdin...",
      wrapperError: "non-zero exit code 1",
    });
    assert.ok(result.includes("[codex] stderr:\nReading additional input from stdin..."));
    assert.ok(result.includes("[codex] error:\nnon-zero exit code 1"));
    assert.ok(!result.includes("[codex] stdout:"));
    assert.ok(!result.includes("Hello."));
    assert.strictEqual(result.split("\n").slice(-2).join("\n"), "codex\nsid-2");
  });

  it("empty stderr: labels present without content lines", () => {
    const result = buildStderrOutput("claude", "sid-3", {
      commandName: "claude",
      stdout: "",
      stderr: "",
    });
    assert.ok(result.includes("[claude] stderr:"));
    assert.ok(!result.includes("[claude] error:"));
    assert.strictEqual(result.split("\n").slice(-2).join("\n"), "claude\nsid-3");
  });

  it("does not include other agents (single result only)", () => {
    const result = buildStderrOutput("codex", "sid-4", {
      commandName: "codex",
      stderr: "cdx-err",
    });
    assert.ok(!result.includes("[copilot]"));
    assert.ok(result.includes("cdx-err"));
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `node --test test/main.test.js`

Expected: FAIL — still aggregates array / still includes stdout section

- [ ] **Step 3: Implement single-result buildStderrOutput**

In `src/main.js`, replace `buildStderrOutput`:

```javascript
function buildStderrOutput(agentCommandName, sessionId, result) {
  const parts = [];
  const name = result.commandName;

  parts.push(`[${name}] stderr:`);
  if (result.stderr) parts.push(result.stderr);
  if (result.wrapperError) {
    parts.push(`[${name}] error:`);
    parts.push(result.wrapperError);
  }

  if (agentCommandName) parts.push(agentCommandName);
  if (sessionId) parts.push(sessionId);
  return parts.join("\n");
}
```

- [ ] **Step 4: Run tests and verify buildStderrOutput tests pass**

Run: `node --test test/main.test.js`

Expected: `buildStderrOutput` tests PASS (main E2E may still fail until Task 3 updates call sites)

- [ ] **Step 5: Commit**

```bash
git add src/main.js test/main.test.js
git commit -m "$(cat <<'EOF'
refactor: buildStderrOutput emits last agent stderr only

EOF
)"
```

---

### Task 3: logAttemptOutput, Context Lifecycle, Call Sites

**Files:**
- Modify: `src/main.js` (main loop, helpers, `buildStderrOutput` call sites)

**Interfaces:**
- Consumes: `log.setContext`, `log.clearContext` from Task 1
- Produces: `logAttemptOutput(agentName, attempt, stdout, stderr)` — module-local helper in `main.js`

- [ ] **Step 1: Add logAttemptOutput helper**

Add before `async function main()` in `src/main.js`:

```javascript
function logAttemptOutput(agentName, attempt, stdout, stderr) {
  log.debug("agent %s attempt session %d stdout:\n%s", agentName, attempt, stdout || "(empty)");
  log.debug("agent %s attempt session %d stderr:\n%s", agentName, attempt, stderr || "(empty)");
}
```

- [ ] **Step 2: Set context in main loop**

At start of each agent iteration (after `const agent = opts.agents[agentIdx]`):

```javascript
    log.setContext({ agentName: agent.commandName });
```

At start of each attempt (inside `for (let attempt = 0; ...)`):

```javascript
        log.setContext({ agentName: agent.commandName, attempt: attempt + 1, maxAttempts: maxAttempts });
```

After agent loop completes (before `// all agents failed`):

```javascript
  log.clearContext();
```

- [ ] **Step 3: Wire logAttemptOutput on all failure paths**

Replace duplicate timeout/retry debug dumps with `logAttemptOutput`. Add calls before error logs on paths that lack dumps:

| Location | Action |
|----------|--------|
| `provider.send` catch | `logAttemptOutput(agent.commandName, attempt + 1, lastResult?.stdout, lastResult?.stderr)` before error |
| `lastResult.timedOut` (before continue/break) | `logAttemptOutput(...)` — remove old `log.debug("attempt %d stdout:...")` lines |
| non-zero exit (after quota check fails) | `logAttemptOutput(...)` before `log.error("non-zero exit code")` |
| exclude matched | `logAttemptOutput(...)` before exclude error |
| retry needed | `logAttemptOutput(...)` — remove old duplicate dump lines |
| createSession catch | set context `{ agentName }`, `logAttemptOutput(agent.commandName, 0, "", "")`, then error |

For createSession failure use attempt `0` in dump message only if needed, or skip attempt number and use agent-level context `[-]` — prefer:

```javascript
      log.setContext({ agentName: agent.commandName });
      logAttemptOutput(agent.commandName, 1, "", "");
```

(session creation is before attempt loop; context stays `[agent][-]`)

- [ ] **Step 4: Update buildStderrOutput call sites**

Success path (~line 536):

```javascript
      const lastEntry = allResults[allResults.length - 1];
      process.stderr.write(buildStderrOutput(agent.commandName, lastResult.sessionId || session.sessionId, lastEntry) + "\n");
```

Last agent session-creation fail (~line 392):

```javascript
      const lastEntry = allResults[allResults.length - 1];
      process.stderr.write(buildStderrOutput(agent.commandName, "", lastEntry) + "\n");
```

All agents failed (~line 550):

```javascript
  process.stderr.write(buildStderrOutput(lastAgent.commandName, lastAgentResult?.sessionId || "", lastAgentResult) + "\n");
```

- [ ] **Step 5: Run full test suite**

Run: `npm test`

Expected: most tests pass; fallback E2E may need Task 4 updates if assertions check multi-agent stderr aggregation

- [ ] **Step 6: Commit**

```bash
git add src/main.js
git commit -m "$(cat <<'EOF'
feat: dump attempt output on failure and set log context in main loop

EOF
)"
```

---

### Task 4: Fallback E2E Tests

**Files:**
- Modify: `test/fallback.test.js`

**Interfaces:**
- Consumes: updated `buildStderrOutput`, context prefix, `logAttemptOutput` behavior

- [ ] **Step 1: Add test — final stderr excludes failed fallback agent (no -d)**

```javascript
  it("final stderr contains only last successful agent without debug", async () => {
    mockProviders.codex.sendMock = () => ({
      stdout: "",
      stderr: "codex-stderr-content",
      sessionId: "codex-sid",
      exitCode: 1,
    });
    mockProviders.cursor.sendMock = (session) => ({
      stdout: "hello",
      stderr: "cursor-thinking",
      sessionId: session.sessionId,
      exitCode: 0,
    });

    await runMain(["-t", "codex", "-t", "cursor", "-p", "hi"]);

    assert.strictEqual(exitCode, EXIT_OK);
    assert.ok(stderrData.includes("[cursor] stderr:\ncursor-thinking"));
    assert.ok(!stderrData.includes("codex-stderr-content"));
    assert.ok(!stderrData.includes("[codex] stderr:"));
    assert.ok(stderrData.endsWith("cursor\nmock-session-cursor\n"));
  });
```

- [ ] **Step 2: Add test — debug dumps codex stderr on non-zero exit before fallback**

```javascript
  it("debug logs codex stdout/stderr immediately on non-zero exit before fallback", async () => {
    mockProviders.codex.sendMock = () => ({
      stdout: "",
      stderr: "Reading additional input from stdin...",
      sessionId: "codex-sid",
      exitCode: 1,
    });
    mockProviders.cursor.sendMock = () => ({
      stdout: "ok",
      stderr: "",
      sessionId: "cursor-sid",
      exitCode: 0,
    });

    await runMain(["-t", "codex", "-t", "cursor", "-p", "hi", "-d"]);

    const codexErrorIdx = stderrData.indexOf("[codex][1/3]") !== -1
      ? stderrData.indexOf("non-zero exit code 1")
      : stderrData.indexOf("non-zero exit code 1");
    const codexStderrDumpIdx = stderrData.indexOf("agent codex attempt session 1 stderr:\nReading additional input from stdin...");
    assert.ok(codexStderrDumpIdx !== -1, "should dump codex stderr before fallback");
    assert.ok(codexStderrDumpIdx < codexErrorIdx || stderrData.indexOf("non-zero exit code 1") > codexStderrDumpIdx);
    assert.ok(stderrData.includes("[codex][1/3]"), "should include context prefix");
    assert.ok(stderrData.includes("trying agent 2/4") || stderrData.includes("trying agent 2/2"), "cursor attempt follows");
  });
```

Adjust `-r` default (3) so prefix is `[codex][1/3]`. Agent count is 2 so message is `trying agent 2/2`.

Fix assertion:

```javascript
    assert.ok(stderrData.includes("[wrapper][error]") && stderrData.includes("[codex][1/3]") && stderrData.includes("non-zero exit code 1"));
    assert.ok(stderrData.indexOf("Reading additional input from stdin...") < stderrData.indexOf("trying agent 2/2"));
```

- [ ] **Step 3: Update existing tests that assert multi-agent stderr aggregation**

Search `test/fallback.test.js` for `[copilot] stderr:` alongside `[codex]` in final stderr block expectations. Update to match single-agent final stderr or split debug vs final assertions.

Run: `grep -n "copilot.*stderr\|aggregat" test/fallback.test.js`

Update any test expecting both agents in **final** stderr (post-`ProcessExited` structured block) to expect only the last agent.

- [ ] **Step 4: Run fallback tests**

Run: `node --test test/fallback.test.js`

Expected: PASS

- [ ] **Step 5: Run full suite**

Run: `npm test`

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add test/fallback.test.js
git commit -m "$(cat <<'EOF'
test: cover slim final stderr and debug failure dumps

EOF
)"
```

---

### Task 5: Documentation

**Files:**
- Modify: `docs/design.md` (Output spec / 失败原因输出 / 日志 sections)
- Modify: `docs/get-started.md` (Output table)
- Modify: `src/main.js` (HELP `输出:` section ~lines 66-68)

- [ ] **Step 1: Update design.md**

Under output spec, replace multi-agent aggregation description with:

- Final stderr: last agent `[stderr:]` + optional `[error:]` + commandName + sessionId
- No `[stdout:]` in final stderr
- Intermediate agents: visible only with `-d` debug dumps
- Log prefix: `[agentName][attempt/maxAttempts]` on info/error/debug when context set

- [ ] **Step 2: Update get-started.md output table**

Change stderr row to match spec.

- [ ] **Step 3: Update HELP text in main.js**

```javascript
输出:
    stdout  = 最后一个 agent 的标准输出
    stderr  = 最后一个 agent 的标准错误输出（失败时含 [agent] error: 判定原因）
              倒数第二行为 agent 命令名，最后一行为会话 ID
              多 agent fallback 时，中间失败 agent 的输出仅在 -d 调试日志中可见
    退出码   = 最后一个 agent 的退出码
```

- [ ] **Step 4: Run full test suite**

Run: `npm test`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add docs/design.md docs/get-started.md src/main.js
git commit -m "$(cat <<'EOF'
docs: describe slim stderr output and contextual debug logging

EOF
)"
```

---

## Spec Self-Review

| Spec requirement | Task |
|------------------|------|
| Final stderr last agent only | Task 2, 3 call sites |
| No stdout section in final stderr | Task 2 |
| Failure format B (stderr + error) | Task 2 |
| Intermediate agents discarded without -d | Task 4 test |
| Debug immediate dump all failure paths | Task 3 |
| Context prefix info/error/debug | Task 1, 3 |
| Provider unchanged | Task 1 context inheritance |
| Docs updated | Task 5 |
| Breaking change documented | Task 5 |

No placeholders remain. Types consistent: `buildStderrOutput(agentCommandName, sessionId, result)` throughout Tasks 2–4.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-30-stderr-output-redesign.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks

**2. Inline Execution** — implement tasks in this session with checkpoints

Which approach?
