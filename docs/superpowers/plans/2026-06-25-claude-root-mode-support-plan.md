# Claude Provider Support for Root User Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow running the Claude Code wrapper in root user environments by detecting the root identity and filtering out conflicting permission bypass flags.

**Architecture:** Detect UID via `process.getuid()`. If root (UID === 0), strip bypass flags from the child process command line and omit permission bypass configs from `sdkOptions`. Provide debug logs for auditing.

**Tech Stack:** Node.js, built-in Node test runner.

## Global Constraints

- Avoid using `cd` in terminal steps.
- Maintain existing codebase style.
- Only touch relevant files to support this request.
- Run `npm test` to verify changes.

---

### Task 1: Environment Detection and Argument Filtering Helpers

**Files:**
- Modify: [src/provider/claude.js](file:///Users/weizhoulan/Documents/git/wrapper/src/provider/claude.js) (add and export helper functions)
- Modify: [test/provider/claude.test.js](file:///Users/weizhoulan/Documents/git/wrapper/test/provider/claude.test.js) (write unit tests for helpers)

**Interfaces:**
- Produces: `isRootUser(): boolean`
- Produces: `removePermissionFlags(args: string[]): string[]`

- [ ] **Step 1: Write failing tests**

  Open [test/provider/claude.test.js](file:///Users/weizhoulan/Documents/git/wrapper/test/provider/claude.test.js), import `isRootUser` and `removePermissionFlags` from `../../src/provider/claude`, and add test suites for them:

  ```javascript
  const { isRootUser, removePermissionFlags } = require("../../src/provider/claude");

  describe("isRootUser", () => {
    it("returns true if process.getuid() is 0", () => {
      const origGetuid = process.getuid;
      process.getuid = () => 0;
      try {
        assert.strictEqual(isRootUser(), true);
      } finally {
        process.getuid = origGetuid;
      }
    });

    it("returns false if process.getuid() is not 0", () => {
      const origGetuid = process.getuid;
      if (origGetuid) {
        process.getuid = () => 1000;
        try {
          assert.strictEqual(isRootUser(), false);
        } finally {
          process.getuid = origGetuid;
        }
      }
    });
  });

  describe("removePermissionFlags", () => {
    it("filters out permission bypass flags from string array", () => {
      const input = [
        "--dangerously-skip-permissions",
        "--permission-mode=bypassPermissions",
        "--permission-mode",
        "bypassPermissions",
        "some-other-arg"
      ];
      assert.deepStrictEqual(removePermissionFlags(input), ["some-other-arg"]);
    });

    it("leaves other flags untouched", () => {
      const input = ["claude", "--resume", "abc-123"];
      assert.deepStrictEqual(removePermissionFlags(input), ["claude", "--resume", "abc-123"]);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm test`
  Expected: FAIL with `isRootUser is not a function` or similar import resolution errors.

- [ ] **Step 3: Write minimal implementation**

  Open [src/provider/claude.js](file:///Users/weizhoulan/Documents/git/wrapper/src/provider/claude.js), add `isRootUser` and `removePermissionFlags` definitions at the top and export them in `module.exports`:

  ```javascript
  function isRootUser() {
    return typeof process.getuid === "function" && process.getuid() === 0;
  }

  function removePermissionFlags(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--dangerously-skip-permissions") {
        continue;
      }
      if (arg === "--permission-mode=bypassPermissions") {
        continue;
      }
      if (arg === "--permission-mode") {
        if (args[i + 1] === "bypassPermissions") {
          i++;
          continue;
        }
      }
      out.push(arg);
    }
    return out;
  }
  ```

  And add them to `module.exports`:
  ```javascript
  module.exports = {
    createSession,
    send,
    closeSession,
    run,
    extractText,
    extractThinking,
    extractSessionId,
    splitCommand,
    isRootUser,
    removePermissionFlags
  };
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run: `npm test`
  Expected: PASS.

- [ ] **Step 5: Commit changes**

  Run:
  ```bash
  git add src/provider/claude.js test/provider/claude.test.js
  git commit -s -S -m "feat: add root detection and flag cleanup helpers"
  ```

---

### Task 2: Update Argument Injection (`ensureFlags`)

**Files:**
- Modify: [src/provider/claude.js](file:///Users/weizhoulan/Documents/git/wrapper/src/provider/claude.js) (update `ensureFlags` logic and export it)
- Modify: [test/provider/claude.test.js](file:///Users/weizhoulan/Documents/git/wrapper/test/provider/claude.test.js) (write tests for `ensureFlags`)

**Interfaces:**
- Consumes: `isRootUser(): boolean`
- Consumes: `removePermissionFlags(args: string[]): string[]`
- Produces: `ensureFlags(args: string[], resume?: string): string[]`

- [ ] **Step 1: Write failing tests**

  Open [test/provider/claude.test.js](file:///Users/weizhoulan/Documents/git/wrapper/test/provider/claude.test.js), import `ensureFlags` from `../../src/provider/claude` (if not already), and add test cases:

  ```javascript
  const { ensureFlags } = require("../../src/provider/claude");

  describe("ensureFlags", () => {
    it("skips appending and filters existing bypass flags when running as root", () => {
      const origGetuid = process.getuid;
      process.getuid = () => 0; // Simulate root
      try {
        const input = ["claude", "--dangerously-skip-permissions", "--resume", "abc"];
        const out = ensureFlags(input, "def");
        assert.deepStrictEqual(out, ["claude", "--resume", "abc", "--resume", "def"]);
      } finally {
        process.getuid = origGetuid;
      }
    });

    it("appends required flags when not running as root", () => {
      const origGetuid = process.getuid;
      if (origGetuid) {
        process.getuid = () => 1000; // Simulate non-root
        try {
          const input = ["claude"];
          const out = ensureFlags(input);
          assert.ok(out.includes("--dangerously-skip-permissions"));
          assert.ok(out.includes("--permission-mode"));
        } finally {
          process.getuid = origGetuid;
        }
      }
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `npm test`
  Expected: FAIL on `skips appending and filters existing bypass flags when running as root` because `ensureFlags` doesn't filter/skip flags for root yet.

- [ ] **Step 3: Modify `ensureFlags` implementation**

  Open [src/provider/claude.js](file:///Users/weizhoulan/Documents/git/wrapper/src/provider/claude.js), update the `ensureFlags` function to use `isRootUser()` and `removePermissionFlags(args)`:

  ```javascript
  function ensureFlags(args, resume) {
    let out = [...args];
    if (isRootUser()) {
      const beforeLen = out.length;
      out = removePermissionFlags(out);
      if (out.length < beforeLen) {
        log.debug("claude provider: running as root user, removed permission flags from args");
      } else {
        log.debug("claude provider: running as root user, skipping default required permission flags");
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

  Also export `ensureFlags` in `module.exports` if it is not already exported.

- [ ] **Step 4: Run test to verify it passes**

  Run: `npm test`
  Expected: PASS.

- [ ] **Step 5: Commit changes**

  Run:
  ```bash
  git add src/provider/claude.js test/provider/claude.test.js
  git commit -s -S -m "feat: handle root mode flag filtering in ensureFlags"
  ```

---

### Task 3: Adjust SDK Options in `createSession`

**Files:**
- Modify: [src/provider/claude.js](file:///Users/weizhoulan/Documents/git/wrapper/src/provider/claude.js) (update `createSession`'s `sdkOptions`)

**Interfaces:**
- Consumes: `isRootUser(): boolean`

- [ ] **Step 1: Write implementation**

  Open [src/provider/claude.js](file:///Users/weizhoulan/Documents/git/wrapper/src/provider/claude.js) and modify the `sdkOptions` construction inside `createSession`:

  ```javascript
  const isRoot = isRootUser();
  const sdkOptions = {
    pathToClaudeCodeExecutable: resolved,
    includePartialMessages: true,
  };

  if (!isRoot) {
    sdkOptions.permissionMode = "bypassPermissions";
    sdkOptions.allowDangerouslySkipPermissions = true;
  } else {
    log.debug("claude provider: running as root user, disabling permission bypass in sdkOptions");
  }
  ```

- [ ] **Step 2: Run all tests**

  Run: `npm test`
  Expected: PASS.

- [ ] **Step 3: Commit changes**

  Run:
  ```bash
  git add src/provider/claude.js
  git commit -s -S -m "feat: exclude bypass permissions in sdkOptions when running as root"
  ```
