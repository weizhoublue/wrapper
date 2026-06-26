# Claude Provider Custom Command Support under Root User Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to use custom Claude commands under the root user environment without having their permission flags forcefully stripped, and align the SDK options accordingly.

**Architecture:** Update `parseArgs` in `src/main.js` to tag agents that use explicitly passed custom commands with `isCustom: true`, and pass this flag to `createSession`. In `src/provider/claude.js`, conditionally skip argument stripping if `isCustom` is true, and align `sdkOptions` parameters based on the presence of the flags in the command arguments.

**Tech Stack:** Node.js, JavaScript

## Global Constraints

- **Mandatory Signing**: Always use `git commit -s` (sign-off) and `-S` (GPG-sign).
- **One-Line Summary**: Use a concise, single-line English summary for `-m`. No extended descriptions.
- **Human-Only Attribution**: Strictly prohibit AI attribution (e.g., "Co-authored-by") or any AI-related signatures.
- **Protect Default Branch**: Unless explicitly requested by the user, no code changes should be applied to the default branch.

---

### Task 1: Command Line Parsing & Session Creation Argument Passing

**Files:**
- Modify: `src/main.js`
- Modify: `test/main.test.js`

**Interfaces:**
- Consumes: None
- Produces: `agent.isCustom` flag in parser output, passed to `provider.createSession({ ..., isCustom })`.

- [ ] **Step 1: Write the failing tests in `test/main.test.js`**

Add these tests to the `parseArgs` describe block in `test/main.test.js`:
```javascript
  it("sets isCustom to true when -c/--command is specified", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "-t", "claude", "-c", "my-claude"]);
    assert.strictEqual(opts.agents[0].isCustom, true);
  });

  it("sets isCustom to undefined/falsy when -c/--command is not specified", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi"]);
    assert.strictEqual(opts.agents[0].isCustom, undefined);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/main.test.js`
Expected: FAIL with assertion errors for the new tests.

- [ ] **Step 3: Write minimal implementation in `src/main.js`**

Modify `src/main.js` at line 166-168 to set `isCustom: true`:
```javascript
      agents[agents.length - 1].command = value;
      agents[agents.length - 1].commandName = value;
      agents[agents.length - 1].isCustom = true;
      lastToken = "command";
```

And modify `src/main.js` at line 366-370 to pass `isCustom`:
```javascript
      session = await provider.createSession({
        command: agent.command,
        timeout: opts.timeout,
        resume: opts.resume,
        isCustom: agent.isCustom || false,
      });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/main.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main.js test/main.test.js
git commit -s -S -m "feat: parse and pass isCustom command flag"
```

---

### Task 2: Claude Provider Custom Command Support in Root Mode

**Files:**
- Modify: `src/provider/claude.js`
- Modify: `test/provider/claude.test.js`

**Interfaces:**
- Consumes: `isCustom` flag passed into `createSession({ ..., isCustom })`
- Produces: Dynamic execution args and `sdkOptions` based on `isCustom` and user-provided flags.

- [ ] **Step 1: Write the failing tests in `test/provider/claude.test.js`**

Add these tests to `test/provider/claude.test.js`:

Under `describe("ensureFlags", ...)`:
```javascript
  it("does not filter flags when running as root and isCustom is true", () => {
    const origGetuid = process.getuid;
    process.getuid = () => 0; // Simulate root
    try {
      const input = ["--dangerously-skip-permissions", "--resume", "abc"];
      const out = ensureFlags(input, "def", true);
      assert.deepStrictEqual(out, ["--dangerously-skip-permissions", "--resume", "abc"]);
    } finally {
      process.getuid = origGetuid;
    }
  });
```

Under `describe("Claude provider - createSession", ...)`:
```javascript
  it("enables permission bypass in sdkOptions when running as root with isCustom=true and options are present in command", async () => {
    const origGetuid = process.getuid;
    process.getuid = () => 0; // root
    queryOptionsUsed = null;
    try {
      await createSession({
        command: "node --dangerously-skip-permissions --permission-mode=bypassPermissions",
        timeout: 10,
        isCustom: true
      });
      assert.ok(queryOptionsUsed);
      assert.strictEqual(queryOptionsUsed.permissionMode, "bypassPermissions");
      assert.strictEqual(queryOptionsUsed.allowDangerouslySkipPermissions, true);
    } finally {
      process.getuid = origGetuid;
    }
  });

  it("omits permission bypass in sdkOptions when running as root with isCustom=true but options are NOT present in command", async () => {
    const origGetuid = process.getuid;
    process.getuid = () => 0; // root
    queryOptionsUsed = null;
    try {
      await createSession({
        command: "node",
        timeout: 10,
        isCustom: true
      });
      assert.ok(queryOptionsUsed);
      assert.strictEqual(queryOptionsUsed.permissionMode, undefined);
      assert.strictEqual(queryOptionsUsed.allowDangerouslySkipPermissions, undefined);
    } finally {
      process.getuid = origGetuid;
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/provider/claude.test.js`
Expected: FAIL with assertion errors for the new tests.

- [ ] **Step 3: Write minimal implementation in `src/provider/claude.js`**

Modify `ensureFlags` parameter signature and root condition in `src/provider/claude.js`:
```javascript
function ensureFlags(args, resume, isCustom) {
  let out = [...args];
  if (isRootUser()) {
    if (isCustom) {
      log.debug("claude provider: running as root user with custom command, respecting user flags");
    } else {
      const beforeLen = out.length;
      out = removePermissionFlags(out);
      if (out.length < beforeLen) {
        log.debug("claude provider: running as root user, removed permission flags from args");
      } else {
        log.debug("claude provider: running as root user, skipping default required permission flags");
      }
    }
  } else {
    for (const flag of REQUIRED_FLAGS) {
      if (flag === "--permission-mode=bypassPermissions") {
        const hasPM = out.some((a, i) =>
          a === "--permission-mode=bypassPermissions" ||
          (a === "--permission-mode" && out[i + 1] === "bypassPermissions")
        );
        if (!hasPM) out.push("--permission-mode", "bypassPermissions");
      } else if (!out.includes(flag)) {
        out.push(flag);
      }
    }
  }
  // Append --resume if specified and not already present
  if (resume && !out.includes("--resume")) {
    out.push("--resume", resume);
  }
  return out;
}
```

Modify `createSession` in `src/provider/claude.js` to accept `isCustom` and pass it, and adjust `sdkOptions`:
```javascript
async function createSession({ command, timeout, resume, isCustom }) {
  const { command: cmd, args: rawArgs } = splitCommand(command);
  const args = ensureFlags(rawArgs, resume, isCustom);

  const resolved = which(cmd);
  if (!resolved) {
    throw new Error(`command not found: ${cmd}`);
  }
  log.debug("claude provider: command resolved to %s", resolved);

  const input = createAsyncMessageInput();

  const isRoot = isRootUser();
  const sdkOptions = {
    pathToClaudeCodeExecutable: resolved,
    includePartialMessages: true,
  };

  if (!isRoot) {
    sdkOptions.permissionMode = "bypassPermissions";
    sdkOptions.allowDangerouslySkipPermissions = true;
  } else {
    if (isCustom) {
      const hasPermissionBypass = args.some((a, i) =>
        a === "--permission-mode=bypassPermissions" ||
        (a === "--permission-mode" && args[i + 1] === "bypassPermissions")
      );
      const hasSkipPermissions = args.includes("--dangerously-skip-permissions");

      if (hasPermissionBypass) {
        sdkOptions.permissionMode = "bypassPermissions";
      }
      if (hasSkipPermissions) {
        sdkOptions.allowDangerouslySkipPermissions = true;
      }
      log.debug("claude provider: running as root user with custom command, set sdkOptions dynamically: permissionMode=%s, allowDangerouslySkip=%s",
        sdkOptions.permissionMode, sdkOptions.allowDangerouslySkipPermissions);
    } else {
      log.debug("claude provider: running as root user, disabling permission bypass in sdkOptions");
    }
  }

  if (args.length > 0) {
    sdkOptions.spawnClaudeCodeProcess = (spawnOpts) => {
      log.debug("spawning: command=%s args=%j", cmd, [...args, ...spawnOpts.args]);
      return spawn(cmd, [...args, ...spawnOpts.args], {
        cwd: spawnOpts.cwd,
        env: spawnOpts.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    };
  }

  log.debug("claude provider: creating session command=%s args=%j", cmd, args);

  const q = query({ prompt: input.iterable, options: sdkOptions });

  const session = {
    input,
    q,
    events: [],
    sessionId: null,
    cmd,
    args,
    timeout,
    deadline: timeout > 0 ? Date.now() + timeout * 1000 : Infinity,
    closed: false,
  };

  // Start background pump
  session.pump = (async () => {
    try {
      for await (const msg of q) {
        session.events.push(msg);
        if (msg.session_id) session.sessionId = msg.session_id;
      }
    } catch (err) {
      session.pumpError = err;
      log.error("claude pump error: %s", err.message);
    }
  })();

  return session;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/provider/claude.test.js`
Expected: PASS

Verify all tests in the suite:
Run: `npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/provider/claude.js test/provider/claude.test.js
git commit -s -S -m "feat: keep options for custom commands in root user environment"
```
