# Agent Output Character Debug Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add debug-only stdout and stderr character-count logs for each completed agent attempt.

**Architecture:** Keep provider interfaces unchanged. Use the existing `src/main.js` attempt loop, immediately after the existing duration debug log and before result classification, so every returned `lastResult` path logs the same two lines. Tests use the existing mocked provider setup in `test/fallback.test.js`.

**Tech Stack:** Node.js, `node:test`, existing `src/log.js` debug logger.

---

## File Structure

- Modify: `test/fallback.test.js`
  - Add one focused E2E test under `describe("multi-agent fallback E2E", ...)`.
  - Reuse existing provider mocks, `runMain`, and captured `stderrData`.
- Modify: `src/main.js`
  - Add two `log.debug` calls after the current successful-attempt duration log.
  - Use `(lastResult.stdout || "").length` and `(lastResult.stderr || "").length`.

No new helper function is needed. The counting rule is single-use and clearer inline.

### Task 1: Add Failing Debug Log Test

**Files:**
- Modify: `test/fallback.test.js`

- [ ] **Step 1: Add the failing test**

Add this test inside `describe("multi-agent fallback E2E", ...)`, near the existing debug test `logs retry needed and fallback as error level`:

```javascript
  it("logs stdout and stderr output character counts in debug mode", async () => {
    mockProviders.claude.sendMock = (session) => {
      return {
        stdout: "Hello\n世界",
        stderr: "err!",
        sessionId: session.sessionId,
        exitCode: 0,
      };
    };

    await runMain(["-t", "claude", "-p", "hello", "-d"]);

    assert.strictEqual(exitCode, EXIT_OK);
    assert.ok(
      /agent claude attempt session 1 finished, duration: \d+\.\d{2}s/.test(stderrData),
      "should keep existing duration debug log",
    );
    assert.ok(
      stderrData.includes("agent claude attempt session 1 stdout output chars: 8"),
      "should log stdout .length character count",
    );
    assert.ok(
      stderrData.includes("agent claude attempt session 1 stderr output chars: 4"),
      "should log stderr .length character count",
    );
  });
```

`"Hello\n世界".length` is `8`; `"err!".length` is `4`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```sh
npm test -- test/fallback.test.js
```

Expected: FAIL. The new test should fail because stderr does not contain:

```text
agent claude attempt session 1 stdout output chars: 8
agent claude attempt session 1 stderr output chars: 4
```

### Task 2: Add Output Character Debug Logs

**Files:**
- Modify: `src/main.js:427-428`

- [ ] **Step 1: Implement the minimal logging change**

Change this block in `src/main.js`:

```javascript
        const duration = ((performance.now() - attemptStartTime) / 1000).toFixed(2);
        log.debug("agent %s attempt session %d finished, duration: %ss", agent.commandName, attempt + 1, duration);
```

to:

```javascript
        const duration = ((performance.now() - attemptStartTime) / 1000).toFixed(2);
        log.debug("agent %s attempt session %d finished, duration: %ss", agent.commandName, attempt + 1, duration);
        log.debug("agent %s attempt session %d stdout output chars: %d",
          agent.commandName, attempt + 1, (lastResult.stdout || "").length);
        log.debug("agent %s attempt session %d stderr output chars: %d",
          agent.commandName, attempt + 1, (lastResult.stderr || "").length);
```

Do not add these logs inside the `catch (err)` block for `provider.send`; that path has no reliable completed output result.

- [ ] **Step 2: Run the focused test and verify it passes**

Run:

```sh
npm test -- test/fallback.test.js
```

Expected: PASS for `test/fallback.test.js`.

- [ ] **Step 3: Run the full test suite**

Run:

```sh
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Review the diff**

Run:

```sh
git diff -- src/main.js test/fallback.test.js
```

Expected:

- `test/fallback.test.js` has one new debug-mode test.
- `src/main.js` keeps the existing duration log unchanged.
- `src/main.js` adds exactly two new debug logs after the duration log.
- No provider files or final stderr aggregation code changed.

- [ ] **Step 5: Commit implementation**

Run:

```sh
git add src/main.js test/fallback.test.js
git commit -s -S -m "feat: log agent output character counts"
```

Expected: signed commit with no AI attribution.

## Verification Checklist

- Debug disabled behavior is unchanged because `log.debug` is silent unless `-d` is set.
- Existing duration debug line remains byte-for-byte unchanged.
- Counts use JavaScript `.length`, not byte length.
- `provider.send` throw path does not print output character-count lines.
- Full test suite passes with `npm test`.
