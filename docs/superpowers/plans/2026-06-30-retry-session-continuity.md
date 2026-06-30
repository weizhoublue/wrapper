# Retry Session Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify `-r` retry semantics so every provider continues the same session within one agent; implement Codex resume-on-retry and add retry debug logging.

**Architecture:** Provider-level contract — Claude/ACP/OpenCode/Agy already satisfy it. Codex mirrors OpenCode: persist `session.sessionId` after each `send`, inject `exec resume <id>` on subsequent spawns via `insertResumeAfterExec`. `main.js` logs session continuity at retry boundaries. No cross-agent session handoff.

**Tech Stack:** Node.js built-in test runner, CommonJS, `child_process.spawn`, no new dependencies.

## Global Constraints

- Node.js built-in modules only (no extra deps beyond existing SDK).
- Tests in `test/`, run with `node --test`.
- Plain CommonJS, no TypeScript.
- `-r` retries continue same session for **all** retriable cases (regex mismatch, empty output, timeout).
- Session id **never** crosses multi-agent fallback boundaries.
- User `-s` sets starting session; attempt 2+ auto-resumes within same agent when id is known.
- Claude / ACP / OpenCode / Agy: **no code changes**.

---

## File Map

| File | Responsibility |
|------|----------------|
| `src/provider/codex.js` | Add `insertResumeAfterExec`, `sessionId` on session object, dynamic resume in `send` |
| `src/main.js` | Debug log before next retry attempt |
| `test/provider/codex.test.js` | Unit tests for helper + mock-spawn retry resume |
| `test/fallback.test.js` | Optional: retry debug log assertion |
| `docs/design.md` | Extend "Session 复用" to all providers |
| `docs/providers.md` | Codex `-r` auto-resume paragraph under Session Resume |

---

### Task 1: `insertResumeAfterExec` helper

**Files:**
- Modify: `src/provider/codex.js` (add function after `ensureFlags`, export it)
- Modify: `test/provider/codex.test.js`
- Test: `test/provider/codex.test.js`

**Interfaces:**
- Produces: `insertResumeAfterExec(args: string[], sessionId: string | null): string[]`

- [ ] **Step 1: Write the failing tests**

Add to imports in `test/provider/codex.test.js`:

```javascript
const { extractText, extractThinking, extractSessionId, splitCommand, ensureFlags, insertResumeAfterExec } = require("../../src/provider/codex");
```

Append new describe block:

```javascript
describe("Codex provider - insertResumeAfterExec", () => {
  const baseArgs = ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"];

  it("inserts resume after exec when sessionId is set", () => {
    const out = insertResumeAfterExec(baseArgs, "thread-abc-123");
    assert.deepStrictEqual(out, [
      "exec", "resume", "thread-abc-123",
      "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check",
    ]);
  });

  it("returns args unchanged when sessionId is null", () => {
    assert.deepStrictEqual(insertResumeAfterExec(baseArgs, null), baseArgs);
    assert.deepStrictEqual(insertResumeAfterExec(baseArgs, ""), baseArgs);
  });

  it("does not duplicate resume when already present", () => {
    const withResume = ["exec", "resume", "existing-id", "--json"];
    assert.deepStrictEqual(insertResumeAfterExec(withResume, "thread-abc-123"), withResume);
  });

  it("returns args unchanged when exec subcommand is missing", () => {
    const noExec = ["--json", "--skip-git-repo-check"];
    assert.deepStrictEqual(insertResumeAfterExec(noExec, "thread-abc-123"), noExec);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/provider/codex.test.js`

Expected: FAIL — `insertResumeAfterExec is not a function` or import error

- [ ] **Step 3: Implement helper**

Add to `src/provider/codex.js` after `ensureFlags` (before `createSession`):

```javascript
function insertResumeAfterExec(args, sessionId) {
  if (!sessionId || args.includes("resume")) return args;
  const execIdx = args.indexOf("exec");
  if (execIdx < 0) return args;
  const out = [...args];
  out.splice(execIdx + 1, 0, "resume", sessionId);
  return out;
}
```

Add to `module.exports`:

```javascript
module.exports = { createSession, send, closeSession, run, extractText, extractThinking, extractSessionId, splitCommand, ensureFlags, insertResumeAfterExec };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/provider/codex.test.js`

Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/provider/codex.js test/provider/codex.test.js
git commit -m "feat(codex): add insertResumeAfterExec helper for retry resume"
```

---

### Task 2: Codex `send` retry session continuity

**Files:**
- Modify: `src/provider/codex.js` (`createSession`, `send`)
- Modify: `test/provider/codex.test.js` (mock spawn section)

**Interfaces:**
- Consumes: `insertResumeAfterExec(args, sessionId)` from Task 1
- Produces: session object with `sessionId: string | null`; `send()` updates `session.sessionId` and returns `{ sessionId: session.sessionId, ... }`

- [ ] **Step 1: Write failing mock-spawn tests**

Add spawn mock at top of `test/provider/codex.test.js` (same pattern as `test/provider/agy.test.js`):

```javascript
const childProcess = require("child_process");
const originalSpawn = childProcess.spawn;
let mockSpawnFn = null;
childProcess.spawn = (...args) => {
  if (mockSpawnFn) return mockSpawnFn(...args);
  return originalSpawn(...args);
};

const { createSession, send, closeSession, insertResumeAfterExec } = require("../../src/provider/codex");

function makeMockCodexChild(lines, exitCode = 0) {
  const EventEmitter = require("events");
  const readline = require("readline");
  const { Readable } = require("stream");
  const child = new EventEmitter();
  const stdoutStream = new Readable({ read() {} });
  child.stdout = stdoutStream;
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => {
    for (const line of lines) {
      stdoutStream.push(line + "\n");
    }
    stdoutStream.push(null);
    child.emit("close", exitCode);
  });
  return child;
}

function resumeIndex(args) {
  return args.indexOf("resume");
}
```

Append describe block:

```javascript
describe("Codex provider - send retry session continuity", () => {
  it("createSession initializes sessionId from resume option", async () => {
    const session = await createSession({
      command: "node",
      timeout: 10,
      resume: "user-session-id",
    });
    assert.strictEqual(session.sessionId, "user-session-id");
    await closeSession(session);
  });

  it("second send injects resume after first send returns thread_id", async () => {
    const session = await createSession({ command: "node", timeout: 10 });
    const threadId = "019e36ca-9b12-71c3-821a-cdaccf78db35";
    const spawnedArgsList = [];

    mockSpawnFn = (cmd, args) => {
      spawnedArgsList.push([...args]);
      const lines = [
        JSON.stringify({ type: "thread.started", thread_id: threadId }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
      ];
      return makeMockCodexChild(lines);
    };

    try {
      await send(session, "prompt1");
      await send(session, "prompt2");

      assert.strictEqual(spawnedArgsList.length, 2);
      assert.strictEqual(session.sessionId, threadId);
      assert.strictEqual(resumeIndex(spawnedArgsList[0]), -1, "first spawn must not resume");
      assert.ok(resumeIndex(spawnedArgsList[1]) >= 0, "second spawn must include resume");
      assert.strictEqual(spawnedArgsList[1][resumeIndex(spawnedArgsList[1]) + 1], threadId);
      assert.ok(spawnedArgsList[1].includes("prompt2"));
    } finally {
      mockSpawnFn = null;
      await closeSession(session);
    }
  });

  it("does not duplicate resume when createSession already has resume from -s", async () => {
    const resumeId = "existing-session-id";
    const session = await createSession({ command: "node", timeout: 10, resume: resumeId });
    let spawnedArgs = null;

    mockSpawnFn = (cmd, args) => {
      spawnedArgs = [...args];
      return makeMockCodexChild([
        JSON.stringify({ type: "thread.started", thread_id: resumeId }),
      ]);
    };

    try {
      await send(session, "my prompt");
      const resumeCount = spawnedArgs.filter((a) => a === "resume").length;
      assert.strictEqual(resumeCount, 1);
      assert.strictEqual(spawnedArgs[resumeIndex(spawnedArgs) + 1], resumeId);
    } finally {
      mockSpawnFn = null;
      await closeSession(session);
    }
  });

  it("preserves sessionId after timeout when thread.started was emitted", async () => {
    const session = await createSession({ command: "node", timeout: 0 });
    const threadId = "timeout-thread-id";
    let spawnCount = 0;

    mockSpawnFn = () => {
      spawnCount++;
      const EventEmitter = require("events");
    const { Readable } = require("stream");
      const child = new EventEmitter();
      const stdoutStream = new Readable({ read() {} });
      child.stdout = stdoutStream;
      child.stderr = new EventEmitter();
      child.kill = () => {
        process.nextTick(() => child.emit("close", null));
      };
      process.nextTick(() => {
        stdoutStream.push(JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\n");
      });
      return child;
    };

    try {
      const first = await send(session, "prompt1");
      assert.strictEqual(first.timedOut, true);
      assert.strictEqual(session.sessionId, threadId);

      await send(session, "prompt2");
      assert.strictEqual(spawnCount, 2);
    } finally {
      mockSpawnFn = null;
      await closeSession(session);
    }
  });
});
```

Note: For timeout test, `timeout: 0` makes `deadline === Infinity` in current codex — use `timeout: 1` and mock that never closes until killed; OR set `session.deadline = Date.now()` before send to force immediate timeout while events were already parsed. Simpler approach for implementer:

```javascript
const session = await createSession({ command: "node", timeout: 10 });
session.deadline = Date.now(); // force timeout on first send
```

Adjust test accordingly if `timeout: 0` does not trigger timedOut.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/provider/codex.test.js`

Expected: FAIL — `session.sessionId` undefined, second spawn missing `resume`

- [ ] **Step 3: Implement createSession + send changes**

In `createSession`, add `sessionId` to return object:

```javascript
  return {
    cmd,
    baseArgs: safeArgs,
    sessionId: resume || null,
    deadline: timeout > 0 ? Date.now() + timeout * 1000 : Infinity,
    closed: false,
  };
```

In `send`, replace args construction:

```javascript
  const args = [...insertResumeAfterExec(session.baseArgs, session.sessionId), prompt];
```

In `child.on("close", ...)` before `finish()`:

```javascript
      const extractedId = extractSessionId(events);
      if (extractedId) session.sessionId = extractedId;
```

Change resolve to use persisted id:

```javascript
        resolve({
          stdout,
          stderr: stderr || undefined,
          sessionId: session.sessionId,
          exitCode: timedOut ? 1 : (exitCode || 0),
          timedOut,
        });
```

Also update early timeout resolve at line ~121 to return `sessionId: session.sessionId` instead of `null`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/provider/codex.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/provider/codex.js test/provider/codex.test.js
git commit -m "feat(codex): resume session on -r retry within same agent"
```

---

### Task 3: Retry debug logging in `main.js`

**Files:**
- Modify: `src/main.js` (~line 526, before `log.error(... retry needed ...)`)
- Modify: `test/fallback.test.js`

**Interfaces:**
- Consumes: `session.sessionId`, `lastResult.sessionId` from provider after each send
- Produces: debug log lines `retry: continuing session <id>` or `retry: no session id yet, starting fresh`

- [ ] **Step 1: Write failing test**

In `test/fallback.test.js`, add test (follow existing mock provider pattern):

```javascript
  it("logs retry continuing session in debug mode when session id is known", async () => {
    const { main } = require("../src/main");
    let sendCount = 0;
    const originalProviders = require("../src/main").providers;
    // Use existing test harness: mock provider module or stub like other tests in this file.
    // Pattern: register mock where send returns wrong then right stdout, sessionId set on session after first send.

    const stderrChunks = [];
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => { stderrChunks.push(String(chunk)); return origStderrWrite(chunk, ...rest); };

    try {
      await main(["-d", "-r", "2", "-e", "good", "-p", "test", "-t", "claude"]);
    } catch {} finally {
      process.stderr.write = origStderrWrite;
    }

    const debugOutput = stderrChunks.join("");
    assert.ok(debugOutput.includes("retry: continuing session"), debugOutput);
  });
```

Implementer: copy the exact mock-provider stub pattern from the existing test `"logs retry needed and fallback as error level"` in the same file — stub `send` to set `session.sessionId = "mock-session-1"` on first call and return stdout `"bad"` then `"good"`.

Concrete stub sketch matching file conventions:

```javascript
  it("logs retry continuing session in debug mode", async () => {
    let attempt = 0;
    providers.claude.send = async (session, prompt) => {
      attempt++;
      session.sessionId = "mock-session-1";
      if (attempt === 1) {
        return { stdout: "bad", stderr: "", sessionId: "mock-session-1", exitCode: 0 };
      }
      return { stdout: "good", stderr: "", sessionId: "mock-session-1", exitCode: 0 };
    };
    // invoke main with -d -r 2 -e good -p test -t claude
    // capture log.debug output via log module or stderr
  });
```

Check how `test/fallback.test.js` captures log output — use same mechanism (likely stubbing `log.debug` or reading captured stderr from log module).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/fallback.test.js`

Expected: FAIL — debug output missing `retry: continuing session`

- [ ] **Step 3: Add debug log in main.js**

After `logAttemptOutput(...)` and before `log.error(... retry needed ...)`, around line 526:

```javascript
        const continueSessionId = session.sessionId || lastResult.sessionId || "";
        if (continueSessionId) {
          log.debug("retry: continuing session %s", continueSessionId);
        } else {
          log.debug("retry: no session id yet, starting fresh");
        }
        log.error("agent %s attempt session %d: retry needed — %s", agent.commandName, attempt + 1, retryReason(lastResult.stdout, regex));
```

Also add the same debug log before `continue` on timeout retry path (~line 462), when attempt will loop again:

```javascript
          if (attempt + 1 < maxAttempts) {
            const continueSessionId = session.sessionId || lastResult.sessionId || "";
            if (continueSessionId) {
              log.debug("retry: continuing session %s", continueSessionId);
            } else {
              log.debug("retry: no session id yet, starting fresh");
            }
          }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/fallback.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main.js test/fallback.test.js
git commit -m "feat: log session continuity on retry attempts"
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/design.md` (section `### Session 复用`)
- Modify: `docs/providers.md` (Codex `### Session Resume` section ~line 177)

- [ ] **Step 1: Update `docs/design.md`**

Replace lines under `### Session 复用`:

```markdown
### Session 复用

`-r` 重试在同一 agent 的同一 session 中进行，不跨 fallback agent 传递 session id。Claude/ACP 使用长连接复用 session；Codex/OpenCode/Agy 每次 spawn 新进程但在后续 attempt 注入 resume 参数（`exec resume`、`--session`、`--conversation`）。用户 `-s` 指定外部 session；未指定时 attempt 1 新建，attempt 2+ 自动 resume。agent 保留上一轮对话上下文，regex 不匹配重试时更可能给出不同答案。
```

- [ ] **Step 2: Update `docs/providers.md` Codex section**

After the existing `-s` paragraph (~line 179), add:

```markdown
**`-r` 自动 resume：** 未指定 `-s` 时，第一次 `send` 从 NDJSON `thread.started` 取得 `thread_id` 并写入 `session.sessionId`；regex/空输出/超时触发的重试在下次 spawn 时通过 `insertResumeAfterExec` 注入 `exec resume <thread_id>`，与 OpenCode 的 `--session` 重试模式一致。
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`

Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
git add docs/design.md docs/providers.md
git commit -m "docs: document retry session continuity across providers"
```

---

## Plan Self-Review

| Spec requirement | Task |
|------------------|------|
| Codex `insertResumeAfterExec` | Task 1 |
| Codex `sessionId` on create/send | Task 2 |
| Timeout preserves id | Task 2 (timeout test) |
| No duplicate resume with `-s` | Task 2 |
| Debug log on retry | Task 3 |
| `docs/design.md` update | Task 4 |
| `docs/providers.md` update | Task 4 |
| Claude/ACP/OpenCode/Agy unchanged | Global Constraints |
| No cross-agent session | Global Constraints (no task — already true in main.js) |

No placeholders remain. Type names consistent: `session.sessionId`, `insertResumeAfterExec`, `thread_id`.
