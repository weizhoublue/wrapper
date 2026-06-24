# OpenCode Provider（ACP）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `-t opencode` provider，通过 `opencode acp` 非交互调用 OpenCode Agent，可靠输出 `ses_...` sessionId 并支持 `-s` 跨进程 resume。

**Architecture:** `opencode.js` thin wrapper（`ensureFlags` → `opencode acp`）委托共享 `acp.js`；`acp.js` 在 `provider === "opencode"` 时调用 `authenticate({ methodId: "opencode-login" })`；resume 用 ACP `session/load`；权限由 `NonInteractiveClient.requestPermission` 自动 allow。

**Tech Stack:** Node.js 18+、CommonJS、`@agentclientprotocol/sdk` ^0.21.1、OpenCode CLI ≥1.17（本机需 `opencode auth login` 做 smoke）

**Spec:** `docs/superpowers/specs/2026-06-24-opencode-provider-design.md`

## Global Constraints

- 默认命令：`opencode acp`（**不**使用 `opencode run`）
- Provider 名：`-t opencode`
- 认证 ACP methodId：`opencode-login`
- Resume：ACP `session/load`（不用 CLI `-s`）
- Client：首版 `NonInteractiveClient`（无 OpenCode 专用扩展 Client）
- `LimitMsg.opencode` 保持 `""`（首版不做配额检测）
- 仅 Node.js 内置模块 + 现有 `@agentclientprotocol/sdk`；plain CommonJS
- 测试：`node --test`；smoke 用 `{ skip: !hasOpencode }`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/provider/opencode.js` | **新建** — `ensureFlags`、传 `provider: "opencode"` |
| `src/provider/acp.js` | `opencode` 认证分支、`AUTH_HINTS.opencode` |
| `src/main.js` | `DEFAULTS.opencode`、`providers.opencode`、HELP |
| `test/provider/opencode.test.js` | **新建** — `ensureFlags` 单测 + 可选 smoke |
| `test/provider/acp-auth.test.js` | 补 `formatAuthHint("opencode")` 测试 |
| `test/main.test.js` | 默认 command 解析 |
| `test/fallback.test.js` | mock 列表加 opencode；unknown provider 用其他类型 |
| `docs/providers.md` | OpenCode 章节 |
| `docs/design.md` | provider 列表、resume 表 |
| `docs/get-started.md` | 示例与默认命令表 |

---

### Task 1: `acp.js` 增加 OpenCode 认证

**Files:**
- Modify: `src/provider/acp.js:19-23`（`AUTH_HINTS`）、`src/provider/acp.js:249-255`（authenticate 分支）
- Modify: `test/provider/acp-auth.test.js`

**Interfaces:**
- Consumes: 现有 `withDeadline`、`connection.authenticate`
- Produces: `AUTH_HINTS.opencode`；`createSession({ provider: "opencode" })` 在 initialize 后调用 `authenticate({ methodId: "opencode-login" })`

- [ ] **Step 1: 写失败测试**

在 `test/provider/acp-auth.test.js` 的 `describe("formatAuthHint")` 内追加：

```javascript
  it("includes opencode login instructions", () => {
    const hint = formatAuthHint("opencode");
    assert.match(hint, /opencode auth login/i);
  });
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/provider/acp-auth.test.js
```

Expected: FAIL — hint 不含 `opencode auth login`

- [ ] **Step 3: 修改 `src/provider/acp.js`**

在 `AUTH_HINTS` 对象中追加：

```javascript
  opencode: "Run: opencode auth login",
```

将 authenticate 分支从：

```javascript
    if (provider === "cursor") {
      await withDeadline(
        connection.authenticate({ methodId: "cursor_login" }),
        deadline,
      );
      log.debug("acp: cursor authenticate ok");
    }
```

改为：

```javascript
    if (provider === "cursor") {
      await withDeadline(
        connection.authenticate({ methodId: "cursor_login" }),
        deadline,
      );
      log.debug("acp: cursor authenticate ok");
    } else if (provider === "opencode") {
      await withDeadline(
        connection.authenticate({ methodId: "opencode-login" }),
        deadline,
      );
      log.debug("acp: opencode authenticate ok");
    }
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test test/provider/acp-auth.test.js
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/provider/acp.js test/provider/acp-auth.test.js
git commit -m "feat(acp): add opencode-login authenticate handshake"
```

---

### Task 2: 新建 `opencode.js` provider

**Files:**
- Create: `src/provider/opencode.js`
- Create: `test/provider/opencode.test.js`

**Interfaces:**
- Consumes: `acp.createSession({ ...opts, command, provider: "opencode" })`、`acp.send`、`acp.closeSession`
- Produces: `ensureFlags(command: string) → string`；`createSession/send/closeSession/run` 与 gemini.js 同签名

- [ ] **Step 1: 写失败测试**

创建 `test/provider/opencode.test.js`：

```javascript
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const { ensureFlags } = require("../../src/provider/opencode");

describe("opencode ensureFlags", () => {
  it("inserts acp subcommand after opencode", () => {
    assert.strictEqual(ensureFlags("opencode"), "opencode acp");
  });

  it("leaves existing acp unchanged", () => {
    assert.strictEqual(ensureFlags("opencode acp"), "opencode acp");
  });

  it("does not inject run or dangerously-skip-permissions", () => {
    const result = ensureFlags("opencode");
    assert.ok(!result.includes("run"));
    assert.ok(!result.includes("dangerously-skip-permissions"));
  });
});

const hasOpencode = (() => {
  try {
    return spawnSync("which", ["opencode"]).status === 0;
  } catch { return false; }
})();

const mainJs = path.join(__dirname, "..", "..", "src", "main.js");

function runWrapper(args = []) {
  return new Promise((resolve) => {
    const child = spawn("node", [mainJs, ...args], {
      cwd: path.join(__dirname, "..", ".."),
      env: process.env,
      stdio: "pipe",
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => stdout += d.toString());
    child.stderr.on("data", (d) => stderr += d.toString());
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function lastLine(text) {
  return text.trim().split("\n").pop().trim();
}

describe("opencode provider smoke", () => {
  it("completes a simple prompt", { skip: !hasOpencode }, async () => {
    const result = await runWrapper(["-t", "opencode", "-p", "say hi in one word", "-o", "120"]);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.trim().length > 0);
    const sid = lastLine(result.stderr);
    assert.match(sid, /^ses_/);
  });

  it("resume preserves session across invocations", { skip: !hasOpencode }, async () => {
    const first = await runWrapper(["-t", "opencode", "-p", "my name is Bob, remember it", "-o", "120"]);
    const sid1 = lastLine(first.stderr);
    assert.match(sid1, /^ses_/);

    const second = await runWrapper(["-t", "opencode", "-s", sid1, "-p", "what is my name?", "-o", "120"]);
    assert.strictEqual(lastLine(second.stderr), sid1);
    assert.ok(second.stdout.toLowerCase().includes("bob"),
      `expected context recall, got: ${second.stdout.slice(0, 200)}`);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/provider/opencode.test.js
```

Expected: FAIL — `Cannot find module '../../src/provider/opencode'`

- [ ] **Step 3: 创建 `src/provider/opencode.js`**

```javascript
const acp = require("./acp");
const log = require("../log");

function ensureFlags(command) {
  const parts = command.trim().split(/\s+/);
  if (!parts.includes("acp")) {
    parts.splice(1, 0, "acp");
  }
  return parts.join(" ");
}

async function createSession(opts) {
  const command = ensureFlags(opts.command);
  log.debug("opencode provider: creating session command=%s resume=%s",
    command, opts.resume || "(none)");
  return acp.createSession({ ...opts, command, provider: "opencode" });
}

async function send(session, prompt) {
  return acp.send(session, prompt);
}

async function closeSession(session) {
  return acp.closeSession(session);
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
  extractText: acp.extractText,
  extractThinking: acp.extractThinking,
  splitCommand: acp.splitCommand,
};
```

- [ ] **Step 4: 运行 ensureFlags 单测**

```bash
node --test test/provider/opencode.test.js --test-name-pattern="ensureFlags"
```

Expected: PASS（smoke 仍 skip 或 fail 直到 Task 3 注册 main）

- [ ] **Step 5: Commit**

```bash
git add src/provider/opencode.js test/provider/opencode.test.js
git commit -m "feat(provider): add opencode ACP thin wrapper"
```

---

### Task 3: 在 `main.js` 注册 provider

**Files:**
- Modify: `src/main.js:22-29`（DEFAULTS）、`:39`（HELP type 列表）、`:88-99`（HELP 示例）、`:317-324`（providers）
- Modify: `test/main.test.js`

**Interfaces:**
- Consumes: `require("./provider/opencode")`
- Produces: `parseArgs(["-t", "opencode"])` → `command === "opencode acp"`

- [ ] **Step 1: 写失败测试**

在 `test/main.test.js` 追加：

```javascript
  it("resolves default command for opencode type", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "-t", "opencode"]);
    assert.strictEqual(opts.agents[0].command, "opencode acp");
    assert.strictEqual(opts.agents[0].commandName, "opencode");
  });
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/main.test.js --test-name-pattern="opencode"
```

Expected: FAIL — command 不是 `opencode acp`

- [ ] **Step 3: 修改 `src/main.js`**

`DEFAULTS` 追加：

```javascript
  opencode: "opencode acp",
```

HELP 中 `-t` 说明改为包含 `opencode`：

```text
    -t, --type <名称>        代理类型: claude, codex, copilot, gemini, cursor, agy, opencode (默认: claude)
```

在 `cursor:` 示例块之后追加：

```text
opencode:
    wrapper -t opencode -p "say hi in one word"

    wrapper -t opencode -p "tomorrow will rain" 2>/tmp/sid
    session=$(tail -1 /tmp/sid)
    wrapper -t opencode -s \${session} -p "tell me all what I have said in this session"
```

`providers` 对象追加：

```javascript
    opencode: require("./provider/opencode"),
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test test/main.test.js --test-name-pattern="opencode"
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main.js test/main.test.js
git commit -m "feat(main): register opencode provider and default command"
```

---

### Task 4: 更新 fallback 测试

**Files:**
- Modify: `test/fallback.test.js:7`、`:256-260`

**Interfaces:**
- Consumes: Task 3 注册的 `opencode` provider
- Produces: fallback 测试可 mock `opencode`；unknown provider 用非注册类型

- [ ] **Step 1: 更新 mock provider 列表**

`test/fallback.test.js` 第 7 行：

```javascript
const providers = ["claude", "codex", "copilot", "gemini", "cursor", "opencode"];
```

- [ ] **Step 2: 修改 unknown provider 测试**

将：

```javascript
  it("unknown provider type prints error and exits with provider error code", async () => {
    await runMain(["-t", "opencode", "-p", "hello"]);
    assert.strictEqual(exitCode, EXIT_PROVIDER_ERROR);
    assert.ok(stderrData.includes("Error: unknown provider type: opencode"));
  });
```

改为：

```javascript
  it("unknown provider type prints error and exits with provider error code", async () => {
    await runMain(["-t", "notaprovider", "-p", "hello"]);
    assert.strictEqual(exitCode, EXIT_PROVIDER_ERROR);
    assert.ok(stderrData.includes("Error: unknown provider type: notaprovider"));
  });
```

- [ ] **Step 3: 追加 opencode fallback 测试（可选但推荐）**

```javascript
  it("falls back to opencode when earlier agent fails", async () => {
    mockProviders.claude.sendMock = () => ({
      stdout: "", stderr: "fail", sessionId: "claude-session", exitCode: 1,
    });
    mockProviders.opencode.sendMock = () => ({
      stdout: "from opencode", stderr: "", sessionId: "ses_mock", exitCode: 0,
    });

    await runMain(["-t", "claude", "-t", "opencode", "-p", "hello"]);

    assert.strictEqual(exitCode, EXIT_OK);
    assert.ok(stdoutData.includes("from opencode"));
    assert.ok(stderrData.endsWith("opencode\nses_mock\n"));
  });
```

- [ ] **Step 4: 运行 fallback 测试**

```bash
node --test test/fallback.test.js
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add test/fallback.test.js
git commit -m "test(fallback): register opencode mock and fix unknown provider case"
```

---

### Task 5: 文档更新

**Files:**
- Modify: `docs/providers.md`（概览表 + OpenCode 章节）
- Modify: `docs/design.md`（provider 列表、目录树、resume 表）
- Modify: `docs/get-started.md`（`-t` 说明、默认命令表、示例）

- [ ] **Step 1: 更新 `docs/providers.md`**

在概览第一段 provider 列表加入 `opencode`。

在默认命令块追加：

```bash
# opencode
opencode acp
```

在 provider 对比表追加一行：

| opencode | ACP | `@agentclientprotocol/sdk` | `acp` 子命令 | ACP `session/load` | `inferAcpExitCode()` + 子进程码 |

新增 **OpenCode** 章节（结构对标 Cursor/Gemini）。

- [ ] **Step 2: 更新 `docs/design.md`**

- `-t` 可选值加入 `opencode`
- 目录树 `src/provider/` 加入 `opencode.js`
- provider 列表段落加入 opencode 一行
- resume 机制表加入 opencode / `session/load`

- [ ] **Step 3: 更新 `docs/get-started.md`**

- `-t` 说明加入 `opencode`
- 默认命令表加入 `opencode | opencode acp`
- 追加 opencode 使用示例（含 resume）

- [ ] **Step 4: 全量测试**

```bash
npm test
```

Expected: 全部 PASS（smoke 在无 opencode 环境 skip）

- [ ] **Step 5: Commit**

```bash
git add docs/providers.md docs/design.md docs/get-started.md
git commit -m "docs: add OpenCode ACP provider guide"
```

---

## Spec 覆盖自检

| Spec 要求 | 对应 Task |
|-----------|-----------|
| `opencode.js` thin wrapper | Task 2 |
| `ensureFlags` → `opencode acp` | Task 2 |
| `authenticate(opencode-login)` | Task 1 |
| `AUTH_HINTS.opencode` | Task 1 |
| `NonInteractiveClient` | Task 2（默认，无新 Client） |
| `DEFAULTS` / `providers` / HELP | Task 3 |
| `ensureFlags` 单测 | Task 2 |
| smoke + resume | Task 2 |
| fallback 含 opencode | Task 4 |
| `docs/providers.md` 等 | Task 5 |
| `LimitMsg.opencode === ""` | 无需改动（已存在） |

## 手动验收（实现完成后）

```bash
# 需 opencode auth login
wrapper -t opencode -p "say hi in one word" -d
wrapper -t opencode -p "hi" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
wrapper -t opencode -s "$session" -p "what did I say?"
wrapper -t claude -t opencode -p "hello"   # fallback 链
```
