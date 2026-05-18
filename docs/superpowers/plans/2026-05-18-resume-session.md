# Resume Session 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 添加 `-s --resume <session_id>` 选项，恢复已有会话继续对话

**Architecture:** `parseArgs` 解析新选项 → 传入 `createSession({..., resume})` → 各 provider 的 `ensureFlags` 在命令中注入 `resume` / `--resume`

**Tech Stack:** Node.js (built-in modules only)

---

### Task 1: parseArgs 新增 `-s --resume` 选项

**Files:**
- Modify: `src/main.js:38-77` (parseArgs), `src/main.js:11-36` (HELP), `src/main.js:139-142` (createSession call)

- [ ] **Step 1: 修改 parseArgs 选项定义**

在 `src/main.js` 的 `nodeParseArgs` options 中新增 `resume`（约第 48-57 行），在 `retry` 之后：

```javascript
retry:     { type: "string", short: "r", default: "3" },
resume:    { type: "string", short: "s" },
timeout:   { type: "string", short: "o", default: "0" },
```

- [ ] **Step 2: 修改 parseArgs 返回值**

在返回对象中新增 `resume` 字段（约第 68-76 行）：

```javascript
return {
  prompt: values.prompt,
  type: values.type,
  command,
  debug: values.debug,
  reg: values.reg || "",
  retry: Number.isNaN(retry) ? 3 : retry,
  resume: values.resume || "",
  timeout: Number.isNaN(timeout) ? 0 : timeout,
};
```

- [ ] **Step 3: 更新 HELP 文本**

在 HELP 的 Options 区域新增一行（约第 22 行，`-r --retry` 之后）：

```javascript
  -s, --resume <id>       Resume a previous session
```

- [ ] **Step 4: 传 resume 给 createSession**

修改 `main()` 中的 `createSession` 调用（约第 139-142 行）：

```javascript
session = await provider.createSession({
  command: opts.command,
  timeout: opts.timeout,
  resume: opts.resume,
});
```

- [ ] **Step 5: 运行现有测试确认不破坏**

```bash
npm test
```

Expected: 所有现有测试通过（新选项尚未有测试覆盖，但不引入回归）。

- [ ] **Step 6: 提交**

```bash
git add src/main.js
git commit -s -S -m "feat: add -s --resume option to parseArgs"
```

---

### Task 2: Codex provider — 注入 `resume <id>` 子命令

**Files:**
- Modify: `src/provider/codex.js:48-64` (ensureFlags), `src/provider/codex.js:66-83` (createSession)

- [ ] **Step 1: 修改 ensureFlags 签名和逻辑**

将 `ensureFlags(args)` 改为 `ensureFlags(args, resume)`，在 `exec` 检测之后、REQUIRED_FLAGS 循环之前插入 resume 逻辑：

```javascript
function ensureFlags(args, resume) {
  const out = [...args];
  // Only inject for "codex exec" subcommand
  if (!out.includes("exec")) return out;

  // Insert "resume <id>" after "exec" if -s was specified and not already present
  if (resume && !out.includes("resume")) {
    const execIdx = out.indexOf("exec");
    out.splice(execIdx + 1, 0, "resume", resume);
  }

  for (const flag of REQUIRED_FLAGS) {
    if (!out.includes(flag)) {
      // Insert --json right after "exec" (or after "exec resume <id>"), others append at end
      if (flag === "--json") {
        const execIdx = out.indexOf("exec");
        out.splice(execIdx + 1, 0, flag);
      } else {
        out.push(flag);
      }
    }
  }
  return out;
}
```

- [ ] **Step 2: 修改 createSession 传递 resume**

`createSession` 解构新增 `resume`，传给 `ensureFlags`：

```javascript
async function createSession({ command, timeout, resume }) {
  const { command: cmd, args: baseArgs } = splitCommand(command);

  const resolved = which(cmd);
  if (!resolved) {
    throw new Error(`command not found: ${cmd}`);
  }

  const safeArgs = ensureFlags(baseArgs, resume);
  log.debug("codex: resolved=%s baseArgs=%j safeArgs=%j", resolved, baseArgs, safeArgs);

  return {
    cmd,
    baseArgs: safeArgs,
    deadline: timeout > 0 ? Date.now() + timeout * 1000 : Infinity,
    closed: false,
  };
}
```

- [ ] **Step 3: 运行测试**

```bash
npm test
```

Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add src/provider/codex.js
git commit -s -S -m "feat: codex provider injects resume subcommand from -s"
```

---

### Task 3: Claude provider — 注入 `--resume <id>` flag

**Files:**
- Modify: `src/provider/claude.js:62-76` (ensureFlags), `src/provider/claude.js:78-83` (createSession)

- [ ] **Step 1: 修改 ensureFlags 签名和逻辑**

将 `ensureFlags(args)` 改为 `ensureFlags(args, resume)`，在末尾追加 resume 逻辑：

```javascript
function ensureFlags(args, resume) {
  const out = [...args];
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
  // Append --resume if -s was specified and not already present
  if (resume && !out.includes("--resume")) {
    out.push("--resume", resume);
  }
  return out;
}
```

- [ ] **Step 2: 修改 createSession 传递 resume**

`createSession` 解构新增 `resume`，传给 `ensureFlags`：

```javascript
async function createSession({ command, timeout, resume }) {
  const { command: cmd, args: rawArgs } = splitCommand(command);
  const args = ensureFlags(rawArgs, resume);
  // ... 其余不变
```

- [ ] **Step 3: 运行测试**

```bash
npm test
```

Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add src/provider/claude.js
git commit -s -S -m "feat: claude provider injects --resume flag from -s"
```

---

### Task 4: Copilot provider — 注入 `--resume <id>` flag

**Files:**
- Modify: `src/provider/copilot.js:15-27` (ensureFlags), `src/provider/copilot.js:29-33` (createSession)

- [ ] **Step 1: 修改 ensureFlags 签名和逻辑**

将 `ensureFlags(command)` 改为 `ensureFlags(command, resume)`，在末尾追加 resume 逻辑：

```javascript
function ensureFlags(command, resume) {
  const parts = command.trim().split(/\s+/);
  for (const flag of REQUIRED_FLAGS) {
    if (!parts.includes(flag)) {
      if (flag === "--acp") {
        parts.splice(1, 0, flag);
      } else {
        parts.push(flag);
      }
    }
  }
  // Append --resume if -s was specified and not already present
  if (resume && !parts.includes("--resume")) {
    parts.push("--resume", resume);
  }
  return parts.join(" ");
}
```

- [ ] **Step 2: 修改 createSession 传递 resume**

`createSession` 解构新增 `resume`，传给 `ensureFlags`：

```javascript
async function createSession(opts) {
  const command = ensureFlags(opts.command, opts.resume);
  log.debug("copilot provider: creating session command=%s", command);
  return acp.createSession({ ...opts, command });
}
```

- [ ] **Step 3: 运行测试**

```bash
npm test
```

Expected: 通过。

- [ ] **Step 4: 提交**

```bash
git add src/provider/copilot.js
git commit -s -S -m "feat: copilot provider injects --resume flag from -s"
```

---

### Task 5: 测试

**Files:**
- Modify: `test/main.test.js:6-52` (parseArgs describe block)

- [ ] **Step 1: 新增 `-s` 解析测试**

在 `parseArgs` describe 块中新增测试用例（在 "long option names work" 测试之后）：

```javascript
it("parses -s resume", () => {
  const opts = parseArgs(["node", "main.js", "-p", "hi", "-s", "abc123"]);
  assert.strictEqual(opts.resume, "abc123");
});

it("parses --resume long form", () => {
  const opts = parseArgs(["node", "main.js", "-p", "hi", "--resume", "xyz789"]);
  assert.strictEqual(opts.resume, "xyz789");
});

it("resume defaults to empty string when not specified", () => {
  const opts = parseArgs(["node", "main.js", "-p", "hi"]);
  assert.strictEqual(opts.resume, "");
});
```

- [ ] **Step 2: 运行测试确认通过**

```bash
npm test
```

Expected: 所有测试通过（含新增的 3 个）。

- [ ] **Step 3: 提交**

```bash
git add test/main.test.js
git commit -s -S -m "test: add -s --resume parse tests"
```

---

### Task 6: 更新文档

**Files:**
- Modify: `docs/providers.md`

- [ ] **Step 1: 更新概览表格和默认命令说明**

在 `docs/providers.md` 中更新各 provider 的必需 flag 表格，新增 resume 相关行。

在 Codex 的必需 flag 表格（约第 143-150 行）新增一行：

```
| `resume <id>`（由 `-s` 注入） | 恢复已有 session，插入在 `exec` 之后、`--json` 之前 | `exec` 之后 |
```

在 Claude 的必需 flag 表格（约第 50-57 行）新增一行：

```
| `--resume <id>`（由 `-s` 注入） | 恢复已有 session | 末尾 |
```

在 Copilot 的必需 flag 表格（约第 223-231 行）新增一行：

```
| `--resume <id>`（由 `-s` 注入） | 恢复已有 session | 末尾 |
```

- [ ] **Step 2: 提交**

```bash
git add docs/providers.md
git commit -s -S -m "docs: add --resume flag documentation for all providers"
```

---

## Verification

全部实现完成后运行：

```bash
npm test
```

手动验证（需实际安装各 CLI 工具）：

```bash
# Codex resume
wrapper -t codex -p "tomorrow is monday" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
wrapper -t codex -s ${session} -p "tell me what I said"

# Claude resume
wrapper -t claude -c 'claude-free' -p "hello" 2>/tmp/sid
session=$(tail -1 /tmp/sid)
wrapper -t claude -c 'claude-free' -s ${session} -p "what did I say?"
```
