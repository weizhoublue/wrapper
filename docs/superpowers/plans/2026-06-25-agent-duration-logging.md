# Agent Attempt Duration Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record the start and end times of each agent's execution attempt and output the duration in the debug logs when debug mode is enabled.

**Architecture:** Use the global `performance.now()` in `src/main.js` to measure elapsed time for the asynchronous call to `provider.send` for each attempt. If the call succeeds or fails, calculate the difference in seconds (retaining two decimal places) and print a debug message.

**Tech Stack:** Node.js (v18+)

## Global Constraints
- Node.js global `performance.now()` is available since v16.0.0 and will be used without importing `perf_hooks`.
- Format of elapsed time must be in seconds with two decimal places (e.g. `1.23s`).
- Output the logs using `log.debug` only when the debug flag `-d` is provided.

---

### Task 1: Update Smoke Test to Verify Duration Logging

**Files:**
- Modify: `test/smoke.test.js`

**Interfaces:**
- Consumes: Existing test structure in `test/smoke.test.js`
- Produces: A new test assertion checking for attempt duration logging in stderr when `-d` is active

- [ ] **Step 1: Write the failing test assertion**

  Edit `test/smoke.test.js` to assert that the stderr contains the duration message on debug runs.
  Update the test case `debug flag enables debug output` to:

  ```javascript
    it("debug flag enables debug output", { skip: !hasClaude }, async () => {
      const result = await runCommu(["-p", "say no", "-d"]);
      assert.ok(result.stderr.includes("[wrapper][debug]"), "has debug log in stderr");
      assert.match(
        result.stderr,
        /\[wrapper\]\[debug\].* finished, duration: \d+\.\d+s/,
        "stderr should log the attempt duration"
      );
    });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm test`
  Expected: Test `debug flag enables debug output` fails because the duration pattern `/finished, duration: \d+\.\d+s/` is not found in stderr.

- [ ] **Step 3: Commit the test changes**

  ```bash
  git add test/smoke.test.js
  git commit -m "test: add assertion to verify attempt duration logging in debug mode"
  ```

---

### Task 2: Implement Attempt Duration Logging in Main CLI Flow

**Files:**
- Modify: `src/main.js`

**Interfaces:**
- Consumes: `provider.send` call in `src/main.js`
- Produces: Logged durations in stderr for each attempt

- [ ] **Step 1: Implement the minimal code in src/main.js**

  Locate the `try` block for `provider.send` inside the attempt loop in `src/main.js` (around line 400).
  Replace the block with the following logic that tracks execution duration using `performance.now()`:

  ```javascript
        const attemptStartTime = performance.now();
        try {
          lastResult = await provider.send(session, opts.prompt);
        } catch (err) {
          const duration = ((performance.now() - attemptStartTime) / 1000).toFixed(2);
          log.debug("agent %s attempt %d failed, duration: %ss", agent.commandName, attempt + 1, duration);
          log.error("provider send failed for %s: %s", agent.commandName, err.message);
          allResults.push({
            commandName: agent.commandName,
            stdout: lastResult?.stdout || "",
            stderr: lastResult?.stderr || "",
            sessionId: session?.sessionId || "",
            sendFailed: true,
            wrapperError: `provider send failed: ${err.message}`,
          });
          agentDone = true;
          break; // fallback to next agent
        }

        const duration = ((performance.now() - attemptStartTime) / 1000).toFixed(2);
        log.debug("agent %s attempt %d finished, duration: %ss", agent.commandName, attempt + 1, duration);
  ```

- [ ] **Step 2: Run test to verify it passes**

  Run: `npm test`
  Expected: All 186 tests (or including the new assertion) pass successfully.

- [ ] **Step 3: Commit implementation**

  ```bash
  git add src/main.js
  git commit -m "feat: log agent attempt duration under debug mode"
  ```
