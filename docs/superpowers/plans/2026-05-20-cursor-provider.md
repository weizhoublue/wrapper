# Cursor Provider（ACP）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `-t cursor` provider，通过 `agent --yolo --approve-mcps acp` 非交互调用 Cursor Agent，可靠输出 sessionId 并支持 `-s` 跨进程 resume；同时增强共享 `acp.js` 的 auth 报错与 Cursor 扩展方法自动通过。

**Architecture:** `cursor.js` thin wrapper（`ensureFlags` → `agent --yolo --approve-mcps acp`）委托 `acp.js`；`acp.js` 按 `provider` 选择 `CursorNonInteractiveClient`；resume 用 ACP `session/load`；auth 失败用 `isAuthError` + `formatAuthHint` 抛出可读错误。

**Tech Stack:** Node.js 18+、CommonJS、`@agentclientprotocol/sdk` ^0.21.1

**Spec:** `docs/superpowers/specs/2026-05-20-cursor-provider-design.md`

---

## 文件结构

| 文件 | 职责 |
|------|------|
| `src/provider/acp.js` | 共享 ACP：auth 工具、Cursor 扩展 Client、`createSession({ provider })` |
| `src/provider/cursor.js` | **新建** — `ensureFlags`、传 `provider: "cursor"` |
| `src/provider/copilot.js` | 传 `provider: "copilot"` |
| `src/provider/gemini.js` | 传 `provider: "gemini"` |
| `src/main.js` | 注册 cursor、DEFAULTS、HELP |
| `test/provider/acp-auth.test.js` | **新建** — `isAuthError`、`formatAuthHint`、`wrapAcpError` |
| `test/provider/cursor.test.js` | **新建** — `ensureFlags` 单元测试 + smoke（skip 无 agent） |
| `test/main.test.js` | cursor 默认 command 解析 |
| `docs/design.md` / `docs/providers.md` / `docs/get-started.md` | 文档 |

---

### Task 1: ACP auth 错误工具函数

**Files:**
- Modify: `src/provider/acp.js`（文件顶部，class 定义之前）
- Create: `test/provider/acp-auth.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/provider/acp-auth.test.js`：

```javascript
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { isAuthError, formatAuthHint, wrapAcpError } = require("../../src/provider/acp");

describe("isAuthError", () => {
  it("matches unauthorized in message", () => {
    assert.strictEqual(isAuthError(new Error("401 Unauthorized"), ""), true);
  });

  it("matches login required in stderr", () => {
    assert.strictEqual(isAuthError(new Error("failed"), "please log in first"), true);
  });

  it("returns false for unrelated errors", () => {
    assert.strictEqual(isAuthError(new Error("connection reset"), "timeout"), false);
  });
});

describe("formatAuthHint", () => {
  it("includes cursor login instructions", () => {
    const hint = formatAuthHint("cursor");
    assert.match(hint, /agent login/i);
    assert.match(hint, /CURSOR_API_KEY/i);
  });

  it("includes copilot hint", () => {
    assert.match(formatAuthHint("copilot"), /copilot/i);
  });
});

describe("wrapAcpError", () => {
  it("wraps auth errors with hint", () => {
    const err = wrapAcpError("cursor", new Error("not authenticated"), "");
    assert.match(err.message, /Authentication required for cursor/i);
    assert.match(err.message, /agent login/i);
  });

  it("rethrows non-auth errors unchanged", () => {
    const orig = new Error("spawn failed");
    const err = wrapAcpError("cursor", orig, "");
    assert.strictEqual(err, orig);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/provider/acp-auth.test.js
```

Expected: FAIL — `isAuthError is not a function` 或 module 无导出

- [ ] **Step 3: 在 `acp.js` 实现并导出**

在 `src/provider/acp.js` 的 `const log = require("../log");` 之后、`class NonInteractiveClient` 之前添加：

```javascript
const AUTH_PATTERNS = [
  /unauthorized/i,
  /not authenticated/i,
  /authentication required/i,
  /login required/i,
  /please log in/i,
  /run\s+.*\s+login/i,
];

const AUTH_HINTS = {
  cursor: "Run: agent login\n  Or set: CURSOR_API_KEY",
  copilot: "Run: copilot (ensure GitHub Copilot CLI is authenticated)",
  gemini: "Run: gemini auth login (or your gemini CLI login command)",
};

function isAuthError(err, childStderr = "") {
  const text = [err?.message, err?.code, String(childStderr)].filter(Boolean).join(" ");
  return AUTH_PATTERNS.some((re) => re.test(text));
}

function formatAuthHint(provider) {
  const hint = AUTH_HINTS[provider] || `Authenticate your ${provider} CLI`;
  return `Authentication required for ${provider}.\n  ${hint}`;
}

function wrapAcpError(provider, err, childStderr = "") {
  if (!isAuthError(err, childStderr)) return err;
  return new Error(formatAuthHint(provider));
}
```

在 `module.exports` 末尾追加导出：

```javascript
module.exports = {
  createSession, send, closeSession, run,
  extractText, extractThinking, splitCommand,
  isAuthError, formatAuthHint, wrapAcpError,
  NonInteractiveClient,
};
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node --test test/provider/acp-auth.test.js
```

Expected: PASS（全部 6 个用例）

- [ ] **Step 5: 提交**

```bash
git add src/provider/acp.js test/provider/acp-auth.test.js
git commit -m "$(cat <<'EOF'
feat(acp): add auth error detection helpers for ACP providers

EOF
)"
```

---

### Task 2: `acp.js` 使用 `wrapAcpError` 并支持 `provider` 参数

**Files:**
- Modify: `src/provider/acp.js` — `createSession`, `send`

- [ ] **Step 1: 修改 `createSession` 签名与错误处理**

将 `async function createSession({ command, timeout, resume })` 改为：

```javascript
async function createSession({ command, timeout, resume, provider = "copilot" }) {
```

在 `initialize`、`loadSession`/`newSession` 的 try/catch 中，失败时：

```javascript
} catch (err) {
  throw wrapAcpError(provider, err, childStderr);
}
```

具体包裹点（每个独立 try/catch 或统一外层 catch）：
- `connection.initialize(...)` 
- `connection.loadSession(...)` 或 `connection.newSession(...)`
- 子进程在 initialize 前退出：检查 `childError` 并 `throw wrapAcpError(...)`

`send` 中 `prompt` catch：

```javascript
} catch (err) {
  if (err.message === "timeout") { ... }
  throw wrapAcpError(session.provider, err, session.childStderr());
}
```

在 `return { child, connection, client, sessionId, ... }` 中增加 `provider` 字段：

```javascript
return {
  child,
  connection,
  client,
  sessionId,
  provider,
  childStderr: () => childStderr,
  ...
};
```

- [ ] **Step 2: 运行全量测试**

```bash
npm test
```

Expected: 现有测试仍 PASS（copilot/gemini 尚未传 provider，默认 `"copilot"` 不影响行为）

- [ ] **Step 3: 提交**

```bash
git add src/provider/acp.js
git commit -m "$(cat <<'EOF'
feat(acp): wrap ACP failures with auth hints and track provider on session

EOF
)"
```

---

### Task 3: `CursorNonInteractiveClient` 与 Cursor 扩展方法

**Files:**
- Modify: `src/provider/acp.js`

- [ ] **Step 1: 添加 `CursorNonInteractiveClient`**

在 `NonInteractiveClient` 类定义之后添加：

```javascript
class CursorNonInteractiveClient extends NonInteractiveClient {
  async askQuestion(params) {
    log.debug("acp: cursor/ask_question title=%s questions=%d",
      params.title || "(none)", params.questions?.length || 0);
    const answers = (params.questions || []).map((q) => ({
      questionId: q.id,
      selectedOptionIds: q.options?.[0]?.id ? [q.options[0].id] : [],
    }));
    return { outcome: { outcome: "answered", answers } };
  }

  async createPlan(params) {
    log.debug("acp: cursor/create_plan name=%s", params.name || "(none)");
    return { outcome: { outcome: "accepted" } };
  }

  async updateTodos(params) {
    log.debug("acp: cursor/update_todos count=%d merge=%s",
      params.todos?.length || 0, params.merge);
  }

  async task(params) {
    log.debug("acp: cursor/task description=%s", params.description || "(none)");
  }

  async generateImage(params) {
    log.debug("acp: cursor/generate_image desc=%s", params.description?.slice(0, 60) || "(none)");
  }
}
```

- [ ] **Step 2: 按 provider 选择 Client**

将：

```javascript
const connection = new acp.ClientSideConnection((_agent) => client, stream);
```

改为：

```javascript
const ClientClass = provider === "cursor" ? CursorNonInteractiveClient : NonInteractiveClient;
const client = new ClientClass();
const connection = new acp.ClientSideConnection((_agent) => client, stream);
```

删除原有的 `const client = new NonInteractiveClient();` 重复行。

- [ ] **Step 3: 核对 SDK 方法名**

安装依赖后检查 SDK 如何将 `cursor/ask_question` 映射到 Client 方法：

```bash
npm install
rg -l "ask_question|askQuestion" node_modules/@agentclientprotocol/sdk
```

若 SDK 使用 snake_case 注册（如 `ask_question`），将类方法名改为与 SDK `Client` 接口一致。若扩展方法不在 `Client` 接口中，在 `ClientSideConnection` 构造后查阅 SDK 文档，用其提供的 extension handler 注册（实现时在 commit message 中记录实际接法）。

- [ ] **Step 4: 导出 `CursorNonInteractiveClient`**

```javascript
module.exports = {
  ...,
  NonInteractiveClient,
  CursorNonInteractiveClient,
};
```

- [ ] **Step 5: 运行测试**

```bash
npm test
```

Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/provider/acp.js
git commit -m "$(cat <<'EOF'
feat(acp): add CursorNonInteractiveClient for Cursor ACP extensions

EOF
)"
```

---

### Task 4: 新建 `cursor.js` provider

**Files:**
- Create: `src/provider/cursor.js`
- Create: `test/provider/cursor.test.js`

- [ ] **Step 1: 写 `ensureFlags` 失败测试**

创建 `test/provider/cursor.test.js`：

```javascript
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { ensureFlags } = require("../../src/provider/cursor");

describe("cursor ensureFlags", () => {
  it("inserts acp after agent", () => {
    assert.strictEqual(ensureFlags("agent"), "agent acp");
  });

  it("inserts acp after cursor-agent", () => {
    assert.strictEqual(ensureFlags("cursor-agent"), "cursor-agent acp");
  });

  it("leaves agent acp unchanged", () => {
    assert.strictEqual(ensureFlags("agent acp"), "agent acp");
  });

  it("leaves custom path with acp unchanged", () => {
    assert.strictEqual(
      ensureFlags("/usr/local/bin/agent acp --api-key x"),
      "/usr/local/bin/agent acp --api-key x",
    );
  });

  it("does not inject print-mode flags", () => {
    const result = ensureFlags("agent");
    assert.ok(!result.includes("--yolo"));
    assert.ok(!result.includes("-p"));
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node --test test/provider/cursor.test.js
```

Expected: FAIL — cannot find module `cursor.js`

- [ ] **Step 3: 实现 `src/provider/cursor.js`**

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
  log.debug("cursor provider: creating session command=%s resume=%s",
    command, opts.resume || "(none)");
  return acp.createSession({ ...opts, command, provider: "cursor" });
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
  createSession, send, closeSession, run,
  ensureFlags,
  extractText: acp.extractText,
  extractThinking: acp.extractThinking,
  splitCommand: acp.splitCommand,
};
```

- [ ] **Step 4: 运行单元测试**

```bash
node --test test/provider/cursor.test.js
```

Expected: PASS（5 个 ensureFlags 用例）

- [ ] **Step 5: 提交**

```bash
git add src/provider/cursor.js test/provider/cursor.test.js
git commit -m "$(cat <<'EOF'
feat(cursor): add cursor provider thin wrapper with ensureFlags

EOF
)"
```

---

### Task 5: copilot / gemini 传入 `provider`

**Files:**
- Modify: `src/provider/copilot.js`
- Modify: `src/provider/gemini.js`

- [ ] **Step 1: 修改 copilot `createSession`**

```javascript
return acp.createSession({ ...opts, command, provider: "copilot" });
```

- [ ] **Step 2: 修改 gemini `createSession`**

```javascript
return acp.createSession({ ...opts, command, provider: "gemini" });
```

- [ ] **Step 3: 运行全量测试**

```bash
npm test
```

Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/provider/copilot.js src/provider/gemini.js
git commit -m "$(cat <<'EOF'
feat(acp): pass provider id for auth hints in copilot and gemini

EOF
)"
```

---

### Task 6: 注册 `cursor` 到 `main.js`

**Files:**
- Modify: `src/main.js`
- Modify: `test/main.test.js`

- [ ] **Step 1: 更新 DEFAULTS 与 providers**

在 `DEFAULTS` 中增加：

```javascript
cursor: "agent acp",
```

在 `providers` 中增加：

```javascript
cursor: require("./provider/cursor"),
```

- [ ] **Step 2: 更新 HELP**

- 第 20 行 provider 列表改为：`claude, codex, copilot, gemini, cursor`
- 在 `gemini:` 示例块后增加：

```javascript
cursor:
  wrapper -t cursor -p "say hi in one word"

  wrapper -t cursor -p "tomorrow will rain" 2>/tmp/sid
  session=$(tail -1 /tmp/sid)
  wrapper -t cursor -s \${session} -p "tell me all what I have said in this session"
```

- [ ] **Step 3: 在 `test/main.test.js` 增加测试**

```javascript
it("resolves default command for cursor type", () => {
  const opts = parseArgs(["node", "main.js", "-p", "hi", "-t", "cursor"]);
  assert.strictEqual(opts.command, "agent acp");
});
```

- [ ] **Step 4: 运行测试**

```bash
node --test test/main.test.js
npm test
```

Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/main.js test/main.test.js
git commit -m "$(cat <<'EOF'
feat(main): register cursor provider and update CLI help

EOF
)"
```

---

### Task 7: Cursor smoke 测试（可选，需 `agent` 已安装登录）

**Files:**
- Modify: `test/provider/cursor.test.js`（追加 describe 块）

- [ ] **Step 1: 追加 smoke 测试（仿 gemini.test.js）**

在 `cursor.test.js` 末尾追加：

```javascript
const { spawn, spawnSync } = require("child_process");
const path = require("path");

const hasAgent = (() => {
  try {
    return spawnSync("which", ["agent"]).status === 0;
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

describe("cursor provider smoke", () => {
  it("completes a simple prompt", { skip: !hasAgent }, async () => {
    const result = await runWrapper(["-t", "cursor", "-p", "say hi in one word", "-d"]);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.trim().length > 0);
    assert.ok(lastLine(result.stderr).length > 0, "stderr ends with session id");
  });

  it("resume preserves session across invocations", { skip: !hasAgent }, async () => {
    const first = await runWrapper(["-t", "cursor", "-d", "-p", "my name is Bob, remember it"]);
    const sid1 = lastLine(first.stderr);
    assert.ok(sid1.length > 0);

    const second = await runWrapper(["-t", "cursor", "-d", "-s", sid1, "-p", "what is my name?"]);
    assert.strictEqual(lastLine(second.stderr), sid1);
    assert.ok(second.stdout.toLowerCase().includes("bob"),
      `expected context recall, got: ${second.stdout.slice(0, 200)}`);
  });
});
```

- [ ] **Step 2: 有 agent 时手动跑 smoke**

```bash
node --test test/provider/cursor.test.js
```

Expected: 单元测试 PASS；smoke 在已 `agent login` 环境 PASS，否则 skip

- [ ] **Step 3: 提交**

```bash
git add test/provider/cursor.test.js
git commit -m "$(cat <<'EOF'
test(cursor): add smoke tests for session id and resume

EOF
)"
```

---

### Task 8: 文档更新

**Files:**
- Modify: `docs/design.md`
- Modify: `docs/providers.md`
- Modify: `docs/get-started.md`
- Modify: `CLAUDE.md`（provider 列表一行）

- [ ] **Step 1: 更新 `docs/design.md`**

- 文件结构 `src/provider/` 增加 `cursor.js`
- Provider Resume 表增加 Cursor 行：`ACP session/load`
- CLI `-t` 说明增加 `cursor`

- [ ] **Step 2: 新增 `docs/providers.md` Cursor 章节**

结构仿 Gemini 章节，包含：
- CLI：`agent` / `cursor-agent`
- 默认命令：`agent acp`
- 为什么用 ACP
- `ensureFlags` 注入 `acp` 子命令
- Session Resume：`session/load`
- Cursor 扩展方法自动通过表
- Auth：假定已登录 + auth 错误提示
- 验证命令

- [ ] **Step 3: 更新 `docs/get-started.md`**

- `-t` 列表加 `cursor`
- 增加 cursor resume 示例（与 gemini 示例并列）

- [ ] **Step 4: 更新 `CLAUDE.md`**

Architecture 段 provider 列表加 cursor；CLI 示例加 `-t cursor`

- [ ] **Step 5: 提交**

```bash
git add docs/design.md docs/providers.md docs/get-started.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: document cursor ACP provider and session resume

EOF
)"
```

---

### Task 9: 端到端验收

- [ ] **Step 1: 全量测试**

```bash
npm test
```

Expected: 全部 PASS（smoke 在无 agent 时 skip）

- [ ] **Step 2: 手动验收（需 `agent login`）**

```bash
node src/main.js -t cursor -p "say hi in one word" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
echo "session=$session"
node src/main.js -t cursor -s "$session" -p "what was my first message about?"
```

Expected: 两次 exit 0；第二次能体现上下文；stderr 最后一行 sessionId 一致

- [ ] **Step 3: 未登录验收（可选）**

在未登录环境：

```bash
env -u CURSOR_API_KEY node src/main.js -t cursor -p "hi" 2>&1 | head -20
```

Expected: exit 202；输出含 `Authentication required for cursor` 与 `agent login`

---

## Spec 覆盖自检

| Spec 要求 | 任务 |
|-----------|------|
| `-t cursor` / `agent acp` 默认 | Task 4, 6 |
| `session/new` + stderr sessionId | Task 2–4, 7, 9 |
| `-s` → `session/load` | Task 2（已有逻辑）, 7, 9 |
| Cursor 扩展自动通过 | Task 3 |
| auth 报错 cursor/copilot/gemini | Task 1, 2, 5 |
| 不调用 authenticate | 无任务（默认不添加） |
| 单元 + smoke 测试 | Task 1, 4, 7 |
| 文档 | Task 8 |

## 风险任务（实现时注意）

- **SDK 扩展方法名**：Task 3 Step 3 必须执行；方法名可能与 `askQuestion` / `ask_question` 不同
- **esbuild 打包**：`main.js` 静态 `providers` 表需包含 `cursor`（与现有一致，Task 6 已覆盖）
