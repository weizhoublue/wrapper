# wrapper v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 开发一次性 CLI 包装器 wrapper，通过 Claude Agent SDK 调用 Claude CLI 执行 prompt 并退出。

**Architecture:** 单入口 main.js 解析 CLI 参数、选 provider、执行重试循环、管理输出。provider 通过统一接口 `run({command, prompt, timeout}) → {stdout, stderr, sessionId, exitCode}` 封装不同 AI agent 的调用方式。

**Tech Stack:** Node.js >= 18, `@anthropic-ai/claude-agent-sdk`, 零额外依赖。

---

### Task 1: 项目初始化

**Files:**
- Create: `package.json`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "wrapper",
  "version": "2.0.0",
  "description": "One-shot CLI wrapper for AI coding agents",
  "bin": { "wrapper": "./src/main.js" },
  "scripts": {
    "test": "node --test test/*.test.js test/**/*.test.js",
    "start": "node src/main.js"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.133"
  }
}
```

- [ ] **Step 2: 安装依赖并验证**

```bash
npm install
node -e "require('@anthropic-ai/claude-agent-sdk'); console.log('SDK OK')"
```

Expected: `SDK OK`

- [ ] **Step 3: 创建 .gitignore**

```
node_modules/
wrapper
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json .gitignore
git commit -m "feat: init wrapper v2 project"
```

---

### Task 2: 日志模块

**Files:**
- Create: `src/log.js`
- Test: `test/log.test.js`

- [ ] **Step 1: 写日志模块测试**

```javascript
const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

describe("log", () => {
  let tmpFile, log;

  function captureLog(fn) {
    const fd = fs.openSync(tmpFile, "w");
    const origFd = process.stderr.fd;
    process.stderr.fd = fd;
    try { fn(); } finally { process.stderr.fd = origFd; fs.closeSync(fd); }
    return fs.readFileSync(tmpFile, "utf-8");
  }

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `wrapper-test-${Date.now()}.log`);
    delete require.cache[require.resolve("../src/log")];
    log = require("../src/log");
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it("info writes formatted message", () => {
    const output = captureLog(() => log.info("hello %s", "world"));
    assert.match(output, /\[wrapper\]\[info\]\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] hello world\n/);
  });

  it("error writes formatted message", () => {
    const output = captureLog(() => log.error("fail %d", 500));
    assert.match(output, /\[wrapper\]\[error\].* fail 500\n/);
  });

  it("debug does not write when disabled", () => {
    const output = captureLog(() => log.debug("secret"));
    assert.strictEqual(output, "");
  });

  it("debug writes when enabled", () => {
    log.setDebug(true);
    const output = captureLog(() => log.debug("secret %s", "xyz"));
    assert.match(output, /\[wrapper\]\[debug\].* secret xyz\n/);
  });

  it("isDebug reflects state", () => {
    assert.strictEqual(log.isDebug(), false);
    log.setDebug(true);
    assert.strictEqual(log.isDebug(), true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/log.test.js
```

Expected: FAIL — `Cannot find module '../src/log'`

- [ ] **Step 3: 实现 src/log.js**

```javascript
const fs = require("fs");
const util = require("util");

let debugEnabled = false;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(level, format, ...args) {
  const msg = util.format(format, ...args);
  fs.writeSync(process.stderr.fd, `[wrapper][${level}][${timestamp()}] ${msg}\n`);
}

function info(format, ...args) { write("info", format, ...args); }
function error(format, ...args) { write("error", format, ...args); }
function debug(format, ...args) {
  if (!debugEnabled) return;
  write("debug", format, ...args);
}
function setDebug(v) { debugEnabled = v; }
function isDebug() { return debugEnabled; }

module.exports = { info, error, debug, setDebug, isDebug };
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test test/log.test.js
```

Expected: 5/5 PASS

- [ ] **Step 5: Commit**

```bash
git add src/log.js test/log.test.js
git commit -m "feat: add log module"
```

---

### Task 3: Claude provider

**Files:**
- Create: `src/provider/claude.js`
- Test: `test/provider/claude.test.js`

- [ ] **Step 1: 写 Claude provider 单元测试（extractText 逻辑）**

```javascript
const { describe, it } = require("node:test");
const assert = require("node:assert");

// Test extractText helper in isolation (exported for testing)
const { extractText } = require("../../src/provider/claude");

describe("Claude provider - extractText", () => {
  it("extracts text from assistant messages", () => {
    const events = [
      { type: "assistant", message: { content: [{ type: "text", text: "Hello " }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "World" }] } },
      { type: "result", subtype: "success", result: "" },
    ];
    assert.strictEqual(extractText(events), "Hello World");
  });

  it("includes result text on success", () => {
    const events = [
      { type: "assistant", message: { content: [{ type: "text", text: "prefix" }] } },
      { type: "result", subtype: "success", result: "final", session_id: "abc123" },
    ];
    assert.strictEqual(extractText(events), "prefixfinal");
  });

  it("ignores non-text content blocks", () => {
    const events = [
      { type: "assistant", message: { content: [
        { type: "text", text: "a" },
        { type: "tool_use", name: "read", input: {} },
        { type: "text", text: "b" },
      ] } },
      { type: "result", subtype: "success", result: "" },
    ];
    assert.strictEqual(extractText(events), "ab");
  });

  it("extracts session_id from result event", () => {
    const { extractSessionId } = require("../../src/provider/claude");
    const events = [
      { type: "assistant", message: { content: [] } },
      { type: "system", subtype: "init", session_id: "first" },
      { type: "result", subtype: "success", result: "", session_id: "final" },
    ];
    assert.strictEqual(extractSessionId(events), "final");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/provider/claude.test.js
```

Expected: FAIL

- [ ] **Step 3: 实现 src/provider/claude.js**

```javascript
const { query } = require("@anthropic-ai/claude-agent-sdk");
const log = require("../log");

function extractText(events) {
  const parts = [];
  for (const msg of events) {
    if (msg.type === "assistant") {
      for (const block of msg.message?.content || []) {
        if (block.type === "text") parts.push(block.text);
      }
    } else if (msg.type === "result" && msg.subtype === "success") {
      if (msg.result) parts.push(msg.result);
    }
  }
  return parts.join("");
}

function extractSessionId(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].session_id) return events[i].session_id;
  }
  return null;
}

async function run({ command, prompt, timeout }) {
  const events = [];

  const q = query({
    prompt,
    options: {
      pathToClaudeCodeExecutable: command,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
    },
  });

  log.debug("claude provider: command=%s prompt=%s", command, prompt.slice(0, 80));

  let done = false;
  let timer = null;

  try {
    if (timeout > 0) {
      timer = setTimeout(() => {
        if (!done) {
          log.error("claude provider: timeout after %ds", timeout);
          q.close?.();
        }
      }, timeout * 1000);
    }

    for await (const msg of q) {
      events.push(msg);
      if (msg.type === "result") {
        done = true;
        break;
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    done = true;
  }

  const stdout = extractText(events);
  const sessionId = extractSessionId(events);

  const resultEvent = events.find((e) => e.type === "result");
  const exitCode = resultEvent && resultEvent.subtype === "success" ? 0 : 1;

  log.debug("claude provider: exitCode=%d sessionId=%s stdoutLen=%d",
    exitCode, sessionId, stdout.length);

  return { stdout, stderr: "", sessionId, exitCode };
}

module.exports = { run, extractText, extractSessionId };
```

- [ ] **Step 4: 运行单元测试确认通过**

```bash
node --test test/provider/claude.test.js
```

Expected: 4/4 PASS

- [ ] **Step 5: Commit**

```bash
git add src/provider/claude.js test/provider/claude.test.js
git commit -m "feat: add Claude provider"
```

---

### Task 4: 主入口 (main.js) — 参数解析 + 主流程

**Files:**
- Create: `src/main.js`
- Test: `test/main.test.js`

- [ ] **Step 1: 写参数解析 + 流程测试**

```javascript
const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert");

// Import parseArgs and helper functions
const { parseArgs, isOutputEmpty, canRetry } = require("../src/main");

describe("parseArgs", () => {
  it("parses required -p", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hello"]);
    assert.strictEqual(opts.prompt, "hello");
  });

  it("defaults -t to claude", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi"]);
    assert.strictEqual(opts.type, "claude");
  });

  it("resolves default command for claude type", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi"]);
    assert.strictEqual(opts.command, "claude");
  });

  it("respects explicit -c", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "-c", "my-claude"]);
    assert.strictEqual(opts.command, "my-claude");
  });

  it("parses all flags", () => {
    const opts = parseArgs(["node", "main.js",
      "-p", "test", "-t", "claude", "-c", "cc", "-d", "-s",
      "-e", "PASS", "-r", "5", "-o", "30"]);
    assert.strictEqual(opts.prompt, "test");
    assert.strictEqual(opts.type, "claude");
    assert.strictEqual(opts.command, "cc");
    assert.strictEqual(opts.debug, true);
    assert.strictEqual(opts.forwardStderr, true);
    assert.strictEqual(opts.reg, "PASS");
    assert.strictEqual(opts.retry, 5);
    assert.strictEqual(opts.timeout, 30);
  });

  it("long option names work", () => {
    const opts = parseArgs(["node", "main.js",
      "--prompt", "hi", "--type", "claude", "--command", "c",
      "--debug", "--stderr", "--reg", "OK", "--retry", "2", "--timeout", "10"]);
    assert.strictEqual(opts.prompt, "hi");
    assert.strictEqual(opts.retry, 2);
    assert.strictEqual(opts.timeout, 10);
  });

  it("throws on missing -p", () => {
    assert.throws(() => parseArgs(["node", "main.js"]), /required option.*prompt/i);
  });
});

describe("isOutputEmpty", () => {
  it("empty string is empty", () => {
    assert.strictEqual(isOutputEmpty(""), true);
  });
  it("whitespace only is empty", () => {
    assert.strictEqual(isOutputEmpty("   \n\t  "), true);
  });
  it("non-whitespace is not empty", () => {
    assert.strictEqual(isOutputEmpty("hello"), false);
  });
});

describe("canRetry", () => {
  it("retry on empty output", () => {
    assert.strictEqual(canRetry("", null), true);
  });
  it("retry on regex mismatch", () => {
    assert.strictEqual(canRetry("hello", /world/), true);
  });
  it("no retry when output non-empty and regex matches", () => {
    assert.strictEqual(canRetry("hello world", /world/), false);
  });
  it("no retry when output non-empty and no regex", () => {
    assert.strictEqual(canRetry("hello", null), false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/main.test.js
```

Expected: FAIL — `Cannot find module '../src/main'`

- [ ] **Step 3: 实现 src/main.js**

```javascript
#!/usr/bin/env node
const { parseArgs: nodeParseArgs } = require("node:util");
const log = require("./log");

const DEFAULTS = {
  claude: "claude",
  codex: "codex",
  copilot: "copilot",
};

function parseArgs(argv) {
  const { values } = nodeParseArgs({
    args: argv.slice(2),
    options: {
      prompt:    { type: "string", short: "p" },
      type:      { type: "string", short: "t", default: "claude" },
      command:   { type: "string", short: "c" },
      debug:     { type: "boolean", short: "d", default: false },
      stderr:    { type: "boolean", short: "s", default: false },
      reg:       { type: "string", short: "e" },
      retry:     { type: "string", short: "r", default: "3" },
      timeout:   { type: "string", short: "o", default: "0" },
    },
  });

  if (!values.prompt) {
    throw new Error("required option '--prompt, -p' not specified");
  }

  const command = values.command || DEFAULTS[values.type] || values.type;
  const retry = parseInt(values.retry, 10);
  const timeout = parseInt(values.timeout, 10);

  return {
    prompt: values.prompt,
    type: values.type,
    command,
    debug: values.debug,
    forwardStderr: values.stderr,
    reg: values.reg || "",
    retry: Number.isNaN(retry) ? 3 : retry,
    timeout: Number.isNaN(timeout) ? 0 : timeout,
  };
}

function isOutputEmpty(stdout) {
  return stdout.trim() === "";
}

function canRetry(stdout, regex) {
  if (isOutputEmpty(stdout)) return true;
  if (regex && !regex.test(stdout)) return true;
  return false;
}

function buildStderrOutput(sessionId, childStderr) {
  const parts = [];
  if (childStderr) parts.push(childStderr);
  if (sessionId) parts.push(sessionId);
  return parts.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.debug) log.setDebug(true);

  log.info("wrapper starting: type=%s command=%s", opts.type, opts.command);
  log.debug("prompt=%s timeout=%ds retry=%d reg=%s",
    opts.prompt.slice(0, 100), opts.timeout, opts.retry, opts.reg || "(none)");

  const provider = require(`./provider/${opts.type}`);

  const regex = opts.reg ? new RegExp(opts.reg) : null;
  let lastResult = null;

  for (let attempt = 0; attempt <= opts.retry; attempt++) {
    log.info("attempt %d/%d", attempt + 1, opts.retry + 1);

    try {
      lastResult = await provider.run({
        command: opts.command,
        prompt: opts.prompt,
        timeout: opts.timeout,
      });
    } catch (err) {
      log.error("provider run failed: %s", err.message);
      lastResult = { stdout: "", stderr: err.message, sessionId: null, exitCode: 1 };
    }

    if (!canRetry(lastResult.stdout, regex)) {
      // success
      process.stdout.write(lastResult.stdout);
      if (lastResult.sessionId) {
        process.stderr.write(`${lastResult.sessionId}\n`);
      }
      if (opts.forwardStderr && lastResult.stderr) {
        process.stderr.write(lastResult.stderr);
      }
      process.exit(lastResult.exitCode);
    }

    log.info("attempt %d: retry needed (output empty=%s, regex match=%s)",
      attempt + 1, isOutputEmpty(lastResult.stdout),
      regex ? regex.test(lastResult.stdout) : "n/a");
  }

  // all retries exhausted
  log.error("all %d attempts exhausted", opts.retry + 1);
  process.stdout.write(lastResult.stdout || "");
  process.stderr.write(buildStderrOutput(lastResult.sessionId, lastResult.stderr) + "\n");
  process.exit(lastResult.exitCode || 1);
}

main().catch((err) => {
  log.error("fatal: %s", err.message);
  process.exit(2);
});

module.exports = { parseArgs, isOutputEmpty, canRetry, buildStderrOutput };
```

- [ ] **Step 4: 运行单元测试确认通过**

```bash
node --test test/main.test.js
```

Expected: ~11 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main.js test/main.test.js
git commit -m "feat: add main entry with arg parsing and retry flow"
```

---

### Task 5: 集成测试 (smoke test)

**Files:**
- Create: `test/smoke.test.js`

- [ ] **Step 1: 写 smoke test**

```javascript
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const { spawn } = require("child_process");
const { unlinkSync } = require("fs");

describe("wrapper smoke", () => {
  const hasClaude = (() => {
    try {
      const { status } = require("child_process").spawnSync("which", ["claude"]);
      return status === 0;
    } catch { return false; }
  })();

  it("starts and completes a simple prompt", { skip: !hasClaude }, async () => {
    const result = await runCommu(["-p", "say hi in one word"]);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.length > 0, "has stdout");
    assert.ok(result.stderr.length > 0, "has session id in stderr");
  });

  it("accepts custom command", { skip: !hasClaude }, async () => {
    const result = await runCommu(["-p", "say yes", "-c", "claude"]);
    assert.strictEqual(result.code, 0);
  });

  it("debug flag enables debug output", { skip: !hasClaude }, async () => {
    const result = await runCommu(["-p", "say no", "-d"]);
    assert.ok(result.stderr.includes("[wrapper][debug]"), "has debug log in stderr");
  });

  it("retry on empty output (-e NEEDLE)", { skip: !hasClaude }, async () => {
    // Use a regex that's extremely unlikely to match
    const result = await runCommu(["-p", "say hi in one word", "-e", "ZZZZNOMATCHZZZ", "-r", "1"]);
    // Should fail after retries
    assert.notStrictEqual(result.code, 0);
  });
});

function runCommu(args = []) {
  return new Promise((resolve) => {
    const child = spawn("node", ["src/main.js", ...args], {
      cwd: process.cwd(),
      env: process.env,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => stdout += d);
    child.stderr.on("data", (d) => stderr += d);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
```

- [ ] **Step 2: 运行测试**

```bash
node --test test/smoke.test.js
```

Expected: 如果 claude 可用 → 4 PASS；如果不可用 → 全部 skip

- [ ] **Step 3: Commit**

```bash
git add test/smoke.test.js
git commit -m "test: add smoke test"
```

---

### Task 6: 更新文档

**Files:**
- Create: `docs/dev.md`
- Create: `docs/get-started.md`

- [ ] **Step 1: 写开发文档 docs/dev.md**

```markdown
# wrapper 开发文档

## 构建

```bash
npm install          # 安装依赖
npm test             # 运行所有测试
```

无需编译——Node.js 直接执行。

## 测试

```bash
npm test                              # 所有测试
node --test test/log.test.js          # 日志模块
node --test test/main.test.js         # 参数解析 + 流程
node --test test/provider/claude.test.js  # Claude provider
node --test test/smoke.test.js        # 集成测试（需 claude CLI）
```

## 项目结构

```
src/
  main.js               — 入口：参数解析、主流程、重试逻辑
  log.js                — 日志模块
  provider/
    claude.js            — Claude Agent SDK 适配
    claude.js            — Codex ACP 适配（后续）
    copilot.js           — Copilot ACP 适配（后续）
test/
  log.test.js
  main.test.js
  provider/claude.test.js
  smoke.test.js
```

## 核心设计

### Provider 模式

每个 provider 导出 `run({ command, prompt, timeout }) → { stdout, stderr, sessionId, exitCode }`。主流程不关心 provider 内部实现。

### 重试逻辑

`canRetry(stdout, regex)`:
- 输出为空或纯空白 → 重试
- 指定 regex 且不匹配 → 重试

### 输出规则

- 成功：stdout = 子进程输出，stderr 最后一行 = session ID
- 失败：stdout = 最后一次输出，stderr = 子进程 stderr + session ID（强制透传）
```

- [ ] **Step 2: 写用户指南 docs/get-started.md**

```markdown
# wrapper 快速上手

## 安装

```bash
git clone <repo>
cd wrapper
npm install
npm link   # 可选：全局安装 wrapper 命令
```

## 基本用法

```bash
# 发送 prompt 给 Claude
wrapper -p "分析项目架构"

# 自定义命令
wrapper -p "hello" -c "claude-free-remote --skip-dangerous"

# 开启 debug
wrapper -p "hello" -d

# 透传子进程 stderr
wrapper -p "hello" -s

# 正则匹配 + 重试
wrapper -p "运行测试" -e "PASS" -r 5

# 超时控制
wrapper -p "长任务" -o 30

# 全套参数
wrapper -p "任务" -c "claude" -d -s -e "成功" -r 3 -o 60
```

## 输出

- **stdout**：Claude 的标准输出
- **stderr 最后一行**：本次会话的 session ID
- **退出码**：Claude 命令的退出码

## 依赖

- Node.js >= 18
- Claude CLI 已安装并认证
```

- [ ] **Step 3: Commit**

```bash
git add docs/dev.md docs/get-started.md
git commit -m "docs: add dev and get-started guides"
```

---

## Verification

完成所有 task 后：

```bash
npm test                          # 所有单元测试通过
node --test test/smoke.test.js    # smoke test（需 claude）

# 真实调用验证
node src/main.js -p "say hi in one word" -d
# stdout: Hi
# stderr: [wrapper][info]... / [wrapper][debug]... / <session_id>
# exit code: 0
```
