# agy Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new CLI provider `agy` (Google Antigravity CLI) to the `wrapper` project.

**Architecture:** Implement the provider in `src/provider/agy.js` using direct `child_process.spawn`. Run `agy` in `--print` mode with stdin closed (`stdio: ["ignore", "pipe", "pipe"]`) to prevent blocking, and redirect logs to a temp file using `--log-file` to extract the session/conversation ID.

**Tech Stack:** Node.js (builtin `child_process`, `fs`, `path`, `os`, `readline`).

## Global Constraints
- Do not use any external dependencies not already in `package.json`.
- Preserve existing comments and docstrings.
- Always use `git commit -s` (sign-off) and `-S` (GPG-sign).
- Use concise, single-line English summaries for commit messages.

---

### Task 1: Create `src/provider/agy.js`

**Files:**
- Create: `src/provider/agy.js`

**Interfaces:**
- Consumes: none
- Produces: `createSession`, `send`, `closeSession`, `run` functions exported from `src/provider/agy.js`

- [ ] **Step 1: Write the provider file `src/provider/agy.js`**

Create the file `/Users/weizhoulan/Documents/git/wrapper/src/provider/agy.js` with the following content:

```javascript
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const log = require("../log");

function splitCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}

function which(cmd) {
  const { spawnSync } = require("child_process");
  try {
    const result = spawnSync("which", [cmd], { stdio: "pipe" });
    return result.status === 0 ? result.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

const REQUIRED_FLAGS = ["--dangerously-skip-permissions"];

function ensureFlags(args, resume, logPath) {
  const out = [...args];
  
  // Inject log path
  if (!out.includes("--log-file")) {
    out.push("--log-file", logPath);
  }

  // Inject required flags
  for (const flag of REQUIRED_FLAGS) {
    if (!out.includes(flag)) {
      out.push(flag);
    }
  }

  // Inject conversation resume if specified
  if (resume && !out.includes("--conversation")) {
    out.push("--conversation", resume);
  }

  // Inject print mode if no interactive or print mode is present
  const hasPrintMode = out.includes("--print") || out.includes("-p") || 
                       out.includes("--prompt") || out.includes("-i") || 
                       out.includes("--prompt-interactive");
  if (!hasPrintMode) {
    out.push("--print");
  }

  return out;
}

function extractSessionIdFromLog(logPath) {
  try {
    if (!fs.existsSync(logPath)) return null;
    const logContent = fs.readFileSync(logPath, "utf8");
    const match = logContent.match(/Print mode: conversation=([a-f0-9-]+)/i) || 
                  logContent.match(/Created conversation ([a-f0-9-]+)/i);
    return match ? match[1] : null;
  } catch (err) {
    log.error("agy: failed to read log file %s: %s", logPath, err.message);
    return null;
  }
}

async function createSession({ command, timeout, resume }) {
  const { command: cmd, args: baseArgs } = splitCommand(command);

  const resolved = which(cmd);
  if (!resolved) {
    throw new Error(`command not found: ${cmd}`);
  }

  const logFilename = `agy_session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.log`;
  const logPath = path.join(os.tmpdir(), logFilename);

  const safeArgs = ensureFlags(baseArgs, resume, logPath);
  log.debug("agy: resolved=%s baseArgs=%j safeArgs=%j logPath=%s", resolved, baseArgs, safeArgs, logPath);

  return {
    cmd,
    baseArgs: safeArgs,
    logPath,
    deadline: timeout > 0 ? Date.now() + timeout * 1000 : Infinity,
    closed: false,
    sessionId: resume || null,
  };
}

async function send(session, prompt) {
  if (session.closed) throw new Error("session closed");

  const args = [...session.baseArgs, prompt];
  log.debug("agy: spawning %s %j", session.cmd, args);

  return new Promise((resolve, reject) => {
    const child = spawn(session.cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let childStdout = "";
    let childStderr = "";
    let timedOut = false;
    let timer = null;

    if (session.deadline !== Infinity) {
      const remaining = session.deadline - Date.now();
      if (remaining <= 0) {
        resolve({ stdout: "", stderr: "", sessionId: null, exitCode: 1, timedOut: true });
        return;
      }
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      }, remaining);
    }

    child.stdout.on("data", (chunk) => { childStdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { childStderr += chunk.toString(); });

    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);

      // Give a tiny delay for log sync
      setTimeout(() => {
        const sessionId = extractSessionIdFromLog(session.logPath) || session.sessionId;
        
        // Clean up the log file
        try {
          if (fs.existsSync(session.logPath)) {
            fs.unlinkSync(session.logPath);
          }
        } catch (err) {
          log.error("agy: failed to delete log file %s: %s", session.logPath, err.message);
        }

        resolve({
          stdout: childStdout,
          stderr: childStderr.trim() || undefined,
          sessionId,
          exitCode: timedOut ? 1 : (exitCode || 0),
          timedOut,
        });
      }, 50);
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

async function closeSession(session) {
  if (session.closed) return;
  session.closed = true;
  try {
    if (fs.existsSync(session.logPath)) {
      fs.unlinkSync(session.logPath);
    }
  } catch {}
  log.debug("agy: session closed");
}

async function run(opts) {
  const session = await createSession(opts);
  try {
    return await send(session, opts.prompt);
  } finally {
    await closeSession(session);
  }
}

module.exports = {
  createSession,
  send,
  closeSession,
  run,
  ensureFlags,
  extractSessionIdFromLog
};
```

- [ ] **Step 2: Commit changes**

Run:
```bash
git add src/provider/agy.js
git commit -s -S -m "feat: add agy provider implementation"
```

---

### Task 2: Register `agy` in `src/main.js` and Update Docs

**Files:**
- Modify: `src/main.js`
- Modify: `docs/providers.md`

**Interfaces:**
- Consumes: `src/provider/agy.js`
- Produces: registered `agy` default command and type mapping in `src/main.js`

- [ ] **Step 1: Modify `src/main.js` to register `agy`**

Modify `/Users/weizhoulan/Documents/git/wrapper/src/main.js` to:
1. Add `agy` default command inside `DEFAULTS` around line 21:
```javascript
const DEFAULTS = {
  claude: "claude --dangerously-skip-permissions --permission-mode=bypassPermissions",
  codex: "codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check",
  copilot: "copilot --acp --allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user",
  gemini: "gemini --acp --approval-mode=yolo --skip-trust",
  cursor: "agent --yolo --approve-mcps acp",
  agy: "agy --dangerously-skip-permissions ",
};
```

2. Register the provider mapping in `providers` around line 261:
```javascript
  const providers = {
    claude: require("./provider/claude"),
    codex: require("./provider/codex"),
    copilot: require("./provider/copilot"),
    gemini: require("./provider/gemini"),
    cursor: require("./provider/cursor"),
    agy: require("./provider/agy"),
  };
```

3. Update help text `HELP` around line 37 to list `agy`:
```javascript
  -t, --type <名称>        代理类型: claude, codex, copilot, gemini, cursor, agy (默认: claude)
```

- [ ] **Step 2: Update `docs/providers.md` to add `agy` documentation**

Modify `/Users/weizhoulan/Documents/git/wrapper/docs/providers.md` to add the `agy` section before `添加新 Provider` (around line 426):

```markdown
## agy

### CLI 工具

[Google Antigravity CLI](https://github.com/google/antigravity)（CLI 命令：`agy`）。

### 为什么不用 ACP

`agy` 暂不支持 ACP。通过 `--print` 模式进行非交互调用。由于 `agy` 会在主线程阻塞读取 stdin，我们通过 `stdio: ["ignore", "pipe", "pipe"]` 将 stdin 重定向，并在进程退出后读取自定义日志路径以获取 `conversation ID` 实现会话恢复。

### 必需 flag（自动注入）

| flag | 作用 | 注入位置 |
|------|------|---------|
| `--dangerously-skip-permissions` | 自动批准工具调用权限 | 默认命令或 args |
| `--log-file <path>` | 输出详细运行日志（包含 conversation ID） | 自动注入 |
| `--print` | 单次输出模式 | 自动注入 |
| `--conversation <id>` | 恢复指定会话 | `-s` 注入 |
```

- [ ] **Step 3: Commit changes**

Run:
```bash
git add src/main.js docs/providers.md
git commit -s -S -m "feat: register agy provider and update documentation"
```

---

### Task 3: Create tests for `agy` provider

**Files:**
- Create: `test/provider/agy.test.js`

**Interfaces:**
- Consumes: `src/provider/agy.js`
- Produces: test suite validating argument parsing, conversation extraction, and cleanup

- [ ] **Step 1: Write `test/provider/agy.test.js`**

Create the file `/Users/weizhoulan/Documents/git/wrapper/test/provider/agy.test.js` with the following content:

```javascript
const { test, describe } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const agy = require("../../src/provider/agy");

describe("agy provider tests", () => {
  test("ensureFlags should correctly inject required arguments", () => {
    const args = ["--model", "gemini-3.5-flash"];
    const logPath = "/tmp/test.log";
    const result = agy.ensureFlags(args, "sess-123", logPath);

    assert.ok(result.includes("--dangerously-skip-permissions"));
    assert.ok(result.includes("--log-file"));
    assert.ok(result.includes(logPath));
    assert.ok(result.includes("--conversation"));
    assert.ok(result.includes("sess-123"));
    assert.ok(result.includes("--print"));
  });

  test("extractSessionIdFromLog should extract conversation ID correctly", () => {
    const logPath = path.join(os.tmpdir(), "agy_test_extract.log");
    fs.writeFileSync(logPath, "I0624 13:06:30.091346  9408 printmode.go:156] Print mode: conversation=ec656ddf-9ab5-4fe6-b191-9c0ed6168ee8, sending message\n");

    const sessId = agy.extractSessionIdFromLog(logPath);
    assert.strictEqual(sessId, "ec656ddf-9ab5-4fe6-b191-9c0ed6168ee8");

    try { fs.unlinkSync(logPath); } catch {}
  });
});
```

- [ ] **Step 2: Run test suite**

Run:
```bash
node --test test/provider/agy.test.js
```
Expected: All tests pass.

- [ ] **Step 3: Commit changes**

Run:
```bash
git add test/provider/agy.test.js
git commit -s -S -m "test: add agy provider tests"
```
