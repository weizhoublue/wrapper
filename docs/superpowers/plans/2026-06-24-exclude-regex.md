# Exclude Regex Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `-x, --exclude <模式>` option to immediately fail and stop retrying the current agent if its standard output matches the exclude regex pattern.

**Architecture:** Extend command-line parsing to support the new option, compile the regex in the execution loop, evaluate it immediately on standard output, abort further retries for the matching agent, fallback to subsequent agents if any, and exit with status 205 on final failure.

**Tech Stack:** Node.js, child_process

## Global Constraints

- Option flag `-x, --exclude <模式>` matches output case-insensitively.
- Exclude match applies only to standard output (`stdout`), NOT standard error (`stderr`).
- Exclude match causes immediate failure of the current agent (no further retries).
- Fallback agents (if multiple `-t` options are passed) should still be run sequentially.
- If all agents fail and the final agent failed due to an exclude match, the CLI exits with code 205 (`EXIT_EXCLUDE_MATCH`).
- Git commits must be signed using `git commit -s -S`.

---

### Task 1: Command Line Option Parsing & Exit Code Constant

**Files:**
- Modify: `src/main.js:30-48` (HELP text)
- Modify: `src/main.js:159-194` (parseArgs Options configuration & return object)
- Modify: `src/main.js:225-231` (Define `EXIT_EXCLUDE_MATCH = 205`)
- Modify: `src/main.js:445` (Export `EXIT_EXCLUDE_MATCH`)
- Modify: `test/main.test.js:35-58` (Unit tests for option parsing)
- Modify: `test/main.test.js:185-194` (Unit tests for exit codes)

**Interfaces:**
- Consumes: `node:util`'s `parseArgs`
- Produces: `opts.exclude` (string) as parsed option, and `EXIT_EXCLUDE_MATCH` (number) constant exported from `src/main.js`.

- [ ] **Step 1: Write failing tests in test/main.test.js**
  Add unit tests in `test/main.test.js` to assert option parsing and exit code existence.
  
  ```javascript
  // In describe("parseArgs") in test/main.test.js:
  it("parses -x / --exclude", () => {
    const opts = parseArgs(["node", "main.js", "-p", "test", "-x", "FAIL"]);
    assert.strictEqual(opts.exclude, "FAIL");
  });

  it("parses long --exclude form", () => {
    const opts = parseArgs(["node", "main.js", "-p", "test", "--exclude", "ERROR"]);
    assert.strictEqual(opts.exclude, "ERROR");
  });

  // In describe("exit codes") in test/main.test.js:
  it("has distinct EXIT_EXCLUDE_MATCH exit code", () => {
    assert.strictEqual(EXIT_EXCLUDE_MATCH, 205);
  });
  ```

- [ ] **Step 2: Run test to verify it fails**
  Run: `npm test`
  Expected: FAIL with compilation/reference errors or assertions failing because option/constants don't exist yet.

- [ ] **Step 3: Modify src/main.js to support the option and define exit code**
  
  Modify `HELP` text:
  ```javascript
    -e, --reg <模式>         用于匹配输出的正则表达式(大小写不敏感)，如果不匹配则会重试运行命令 
    -x, --exclude <模式>      用于匹配标准输出的正则表达式(大小写不敏感)，如果匹配成功，则直接宣告当前 agent 失败，并且不再重试该 agent
  ```

  Modify nodeParseArgs configuration in `parseArgs`:
  ```javascript
      exclude:   { type: "string", short: "x" },
  ```

  Modify `parseArgs` return object:
  ```javascript
    return {
      prompt: values.prompt,
      debug: values.debug,
      reg: values.reg || "",
      exclude: values.exclude || "",
      retry: Number.isNaN(retry) ? 3 : retry,
      resume,
      timeout: Number.isNaN(timeout) ? 0 : timeout,
      agents,
    };
  ```

  Define and export `EXIT_EXCLUDE_MATCH`:
  ```javascript
  const EXIT_EXCLUDE_MATCH = 205;
  ```
  And in `module.exports` at the bottom of the file:
  ```javascript
  module.exports = { main, parseArgs, isOutputEmpty, canRetry, buildStderrOutput, collapseBlankLines, retryReason, EXIT_OK, EXIT_REGEX_MISMATCH, EXIT_EMPTY_OUTPUT, EXIT_PROVIDER_ERROR, EXIT_TIMEOUT, EXIT_COMMAND_NOT_FOUND, EXIT_EXCLUDE_MATCH };
  ```

- [ ] **Step 4: Run test to verify Task 1 passes**
  Run: `npm test`
  Expected: PASS for all option-parsing tests (some integration tests might still pass since exclude loop isn't implemented yet).

- [ ] **Step 5: Commit changes**
  Run:
  ```bash
  git add src/main.js test/main.test.js
  git commit -s -S -m "feat: parse -x/--exclude CLI option and define EXIT_EXCLUDE_MATCH"
  ```

---

### Task 2: Core Exclude Matching and Retry Loop Control Flow

**Files:**
- Modify: `src/main.js:235-242` (Add `excludeReason` helper)
- Modify: `src/main.js:255-276` (Compile `excludeRegex` and debug log it)
- Modify: `src/main.js:315-380` (Check exclude regex and break attempt loop)
- Modify: `src/main.js:408-435` (Check `excludeMatched` and exit with 205)
- Modify: `test/fallback.test.js:39-41` (Import `EXIT_EXCLUDE_MATCH`)
- Modify: `test/fallback.test.js:250-294` (Add E2E tests for exclude matching and fallback)

**Interfaces:**
- Consumes: `opts.exclude` option.
- Produces: Correct abort behavior of current agent retry loop when matching, and exit with code 205 if all agents fail (with the last agent failing due to exclude match).

- [ ] **Step 1: Write E2E / Integration tests in test/fallback.test.js**
  Add mock-provider integration tests in `test/fallback.test.js`:

  ```javascript
  // In describe("multi-agent fallback E2E") in test/fallback.test.js:
  it("stops retrying immediately on exclude match", async () => {
    let attempts = 0;
    mockProviders.claude.sendMock = () => {
      attempts++;
      return { stdout: "fatal error block", stderr: "", sessionId: "claude-session", exitCode: 0 };
    };

    await runMain(["-t", "claude", "-p", "hello", "-x", "fatal error", "-r", "3"]);

    assert.strictEqual(attempts, 1);
    assert.strictEqual(exitCode, EXIT_EXCLUDE_MATCH);
  });

  it("falls back to next agent on exclude match of the first agent", async () => {
    mockProviders.claude.sendMock = () => {
      return { stdout: "fatal error block", stderr: "", sessionId: "claude-session", exitCode: 0 };
    };
    let copilotCalled = false;
    mockProviders.copilot.sendMock = () => {
      copilotCalled = true;
      return { stdout: "all fine", stderr: "", sessionId: "copilot-session", exitCode: 0 };
    };

    await runMain(["-t", "claude", "-t", "copilot", "-p", "hello", "-x", "fatal error"]);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(copilotCalled, true);
    assert.ok(stdoutData.includes("all fine"));
  });
  ```

- [ ] **Step 2: Run test to verify they fail**
  Run: `node --test test/fallback.test.js`
  Expected: FAIL (attempts will be 3 instead of 1, and exitCode won't be 205).

- [ ] **Step 3: Modify src/main.js to implement logic**

  Add `excludeReason` helper:
  ```javascript
  function excludeReason(stdout, regex) {
    return `exclude regex /${regex.source}/ matched, stdout: ${stdout.slice(0, 80).replace(/\n/g, "\\n")}`;
  }
  ```

  In `main()`:
  Compile `excludeRegex`:
  ```javascript
  const excludeRegex = opts.exclude ? new RegExp(opts.exclude, "i") : null;
  ```

  Include it in debug log:
  ```javascript
  log.debug("prompt=%s timeout=%ds retry=%d reg=%s exclude=%s",
    opts.prompt.slice(0, 100), opts.timeout, opts.retry, opts.reg || "(none)", opts.exclude || "(none)");
  ```

  In the attempts loop of `main()`, right after `provider.send` call and timeout/exit-code checks:
  ```javascript
        if (excludeRegex && excludeRegex.test(lastResult.stdout)) {
          log.error("agent %s attempt %d: excluded pattern matched — %s", agent.commandName, attempt + 1, excludeReason(lastResult.stdout, excludeRegex));
          allResults.push({
            commandName: agent.commandName,
            stdout: lastResult.stdout || "",
            stderr: lastResult.stderr || "",
            sessionId: session.sessionId || lastResult.sessionId || "",
            excludeMatched: true,
          });
          agentDone = true;
          break; // break retry loop, fallback or exit
        }
  ```

  In exit code determination at the end of `main()`:
  ```javascript
    if (lastAgentResult) {
      if (lastAgentResult.sessionCreationFailed) {
        process.exit(lastAgentResult.commandNotFound ? EXIT_COMMAND_NOT_FOUND : EXIT_PROVIDER_ERROR);
      }
      if (lastAgentResult.sendFailed) {
        process.exit(EXIT_PROVIDER_ERROR);
      }
      if (lastAgentResult.timedOut) {
        process.exit(EXIT_TIMEOUT);
      }
      if (lastAgentResult.exitCode && lastAgentResult.exitCode !== 0) {
        process.exit(lastAgentResult.exitCode);
      }
      if (lastAgentResult.excludeMatched) {
        process.exit(EXIT_EXCLUDE_MATCH);
      }
      if (lastAgentResult.exhausted) {
        const exitCode = isOutputEmpty(lastAgentResult.stdout) ? EXIT_EMPTY_OUTPUT
          : (regex ? EXIT_REGEX_MISMATCH : EXIT_OK);
        process.exit(exitCode);
      }
    }
  ```

- [ ] **Step 4: Run all tests to verify everything passes**
  Run: `npm test`
  Expected: PASS for all 135+ tests.

- [ ] **Step 5: Commit changes**
  Run:
  ```bash
  git add src/main.js test/fallback.test.js
  git commit -s -S -m "feat: implement -x/--exclude logic matching and exit code 205"
  ```
