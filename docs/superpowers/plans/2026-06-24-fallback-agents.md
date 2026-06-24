# Fallback Agents 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持多个 Agent 冗余调用，前一个失败时自动 fallback 到下一个。

**Architecture:** 两阶段 argv 解析（手动扫描 -t/-c 配对 + parseArgs 解析其余选项），main() 中外层 agent 循环 + 内层 retry 循环，stderr 聚合所有已尝试 Agent 的输出。

**Tech Stack:** Node.js, CommonJS, node:util parseArgs

## Global Constraints

- Node.js 内置模块 + SDK 依赖，无额外 deps
- Plain CommonJS，无 TypeScript
- 测试用 `node --test`
- 所有日志到 stderr
- Provider 接口不变（`createSession`/`send`/`closeSession`）

---

### Task 1: parseArgs 支持多 Agent 解析

**Files:**
- Modify: `src/main.js:68-109` (parseArgs 函数)
- Test: `test/main.test.js`

**Interfaces:**
- Consumes: `DEFAULTS` 对象（已有）
- Produces: `parseArgs(argv)` 返回 `{ prompt, debug, reg, retry, resume, timeout, agents: [{ type, command, commandName }] }`

- [ ] **Step 1: 更新现有 parseArgs 测试以适配新返回值结构**

现有测试直接访问 `opts.type` 和 `opts.command`，需改为 `opts.agents[0].type` 和 `opts.agents[0].command`。同时新增 `commandName` 断言。

```js
// test/main.test.js - 更新现有测试
describe("parseArgs", () => {
  it("parses required -p", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hello"]);
    assert.strictEqual(opts.prompt, "hello");
  });

  it("defaults -t to claude", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi"]);
    assert.strictEqual(opts.agents[0].type, "claude");
    assert.strictEqual(opts.agents[0].commandName, "claude");
  });

  it("resolves default command for claude type", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi"]);
    assert.strictEqual(opts.agents[0].command, "claude --dangerously-skip-permissions --permission-mode=bypassPermissions");
  });

  it("resolves default command for cursor type", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "-t", "cursor"]);
    assert.strictEqual(opts.agents[0].command, "agent --yolo --approve-mcps acp");
    assert.strictEqual(opts.agents[0].commandName, "cursor");
  });

  it("respects explicit -c", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "-t", "claude", "-c", "my-claude"]);
    assert.strictEqual(opts.agents[0].command, "my-claude");
    assert.strictEqual(opts.agents[0].commandName, "my-claude");
  });

  it("parses all flags", () => {
    const opts = parseArgs(["node", "main.js",
      "-p", "test", "-t", "claude", "-c", "cc", "-d",
      "-e", "PASS", "-r", "5", "-o", "30"]);
    assert.strictEqual(opts.prompt, "test");
    assert.strictEqual(opts.agents[0].type, "claude");
    assert.strictEqual(opts.agents[0].command, "cc");
    assert.strictEqual(opts.debug, true);
    assert.strictEqual(opts.reg, "PASS");
    assert.strictEqual(opts.retry, 5);
    assert.strictEqual(opts.timeout, 30);
  });

  it("long option names work", () => {
    const opts = parseArgs(["node", "main.js",
      "--prompt", "hi", "--type", "claude", "--command", "c",
      "--debug", "--reg", "OK", "--retry", "2", "--timeout", "10"]);
    assert.strictEqual(opts.prompt, "hi");
    assert.strictEqual(opts.retry, 2);
    assert.strictEqual(opts.timeout, 10);
  });

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

  it("throws on missing -p when args present", () => {
    assert.throws(() => parseArgs(["node", "main.js", "-t", "codex"]), /required option.*prompt/i);
  });
});
```

- [ ] **Step 2: 新增多 Agent 解析测试**

```js
// test/main.test.js - 新增 describe 块
describe("parseArgs multi-agent", () => {
  it("parses multiple -t into agents array", () => {
    const opts = parseArgs(["node", "main.js", "-t", "copilot", "-t", "codex", "-p", "hi"]);
    assert.strictEqual(opts.agents.length, 2);
    assert.strictEqual(opts.agents[0].type, "copilot");
    assert.strictEqual(opts.agents[0].commandName, "copilot");
    assert.strictEqual(opts.agents[1].type, "codex");
    assert.strictEqual(opts.agents[1].commandName, "codex");
  });

  it("pairs -c with preceding -t", () => {
    const opts = parseArgs(["node", "main.js", "-t", "claude", "-c", "claude-deepseek", "-t", "copilot", "-p", "hi"]);
    assert.strictEqual(opts.agents[0].command, "claude-deepseek");
    assert.strictEqual(opts.agents[0].commandName, "claude-deepseek");
    assert.strictEqual(opts.agents[1].commandName, "copilot");
  });

  it("uses default command when no -c", () => {
    const opts = parseArgs(["node", "main.js", "-t", "codex", "-t", "copilot", "-p", "hi"]);
    assert.strictEqual(opts.agents[0].command, "codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check");
    assert.ok(opts.agents[1].command.includes("copilot"));
  });

  it("errors on -c before any -t", () => {
    assert.throws(() => parseArgs(["node", "main.js", "-c", "cmd", "-t", "claude", "-p", "hi"]),
      /-c\/--command must follow a -t\/--type option/);
  });

  it("errors on -c separated from -t by other options", () => {
    assert.throws(() => parseArgs(["node", "main.js", "-t", "claude", "-r", "3", "-c", "cmd", "-p", "hi"]),
      /-c\/--command must immediately follow -t\/--type/);
  });

  it("errors on duplicate -c for same -t", () => {
    assert.throws(() => parseArgs(["node", "main.js", "-t", "claude", "-c", "a", "-c", "b", "-p", "hi"]),
      /duplicate -c\/--command for -t/);
  });

  it("errors on resume with multiple agents", () => {
    assert.throws(() => parseArgs(["node", "main.js", "-t", "copilot", "-t", "codex", "-s", "abc", "-p", "hi"]),
      /--resume cannot be used with multiple agents/);
  });

  it("allows resume with single agent", () => {
    const opts = parseArgs(["node", "main.js", "-t", "claude", "-s", "abc", "-p", "hi"]);
    assert.strictEqual(opts.resume, "abc");
    assert.strictEqual(opts.agents.length, 1);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `node --test test/main.test.js`
Expected: 现有测试因 `opts.type` → `opts.agents[0].type` 变更而失败；新测试因 parseArgs 尚未修改而失败。

- [ ] **Step 4: 实现新 parseArgs**

```js
// src/main.js - 替换 parseArgs 函数 (第 68-109 行)
function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }

  // Phase 1: 手动扫描提取 -t/-c 配对
  const agents = [];
  const remainingArgs = [];
  let lastToken = null; // 追踪上一个 token 是否是 -t <value>

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-t" || arg === "--type") {
      const value = args[++i];
      if (!value) throw new Error("missing value for -t/--type");
      agents.push({ type: value, command: null, commandName: value });
      lastToken = "type";
      continue;
    }

    if (arg === "-c" || arg === "--command") {
      const value = args[++i];
      if (!value) throw new Error("missing value for -c/--command");
      if (agents.length === 0) {
        throw new Error("-c/--command must follow a -t/--type option");
      }
      if (lastToken !== "type") {
        if (agents[agents.length - 1].command !== null) {
          throw new Error(`duplicate -c/--command for -t ${agents[agents.length - 1].type}`);
        }
        throw new Error("-c/--command must immediately follow -t/--type");
      }
      agents[agents.length - 1].command = value;
      agents[agents.length - 1].commandName = value;
      lastToken = "command";
      continue;
    }

    remainingArgs.push(arg);
    lastToken = "other";
  }

  // 无 -t 时默认 claude
  if (agents.length === 0) {
    agents.push({ type: "claude", command: null, commandName: "claude" });
  }

  // 解析默认 command
  for (const agent of agents) {
    if (agent.command === null) {
      agent.command = DEFAULTS[agent.type] || agent.type;
    }
  }

  // Phase 2: parseArgs 解析其余选项
  const { values } = nodeParseArgs({
    args: remainingArgs,
    options: {
      prompt:    { type: "string", short: "p" },
      debug:     { type: "boolean", short: "d", default: false },
      reg:       { type: "string", short: "e" },
      retry:     { type: "string", short: "r", default: "3" },
      resume:    { type: "string", short: "s" },
      timeout:   { type: "string", short: "o", default: "0" },
      help:      { type: "boolean", short: "h", default: false },
    },
  });

  if (!values.prompt) {
    throw new Error("required option '--prompt, -p' not specified. Use -h for help.");
  }

  const retry = parseInt(values.retry, 10);
  const timeout = parseInt(values.timeout, 10);
  const resume = values.resume || "";

  if (agents.length > 1 && resume) {
    throw new Error("--resume cannot be used with multiple agents");
  }

  return {
    prompt: values.prompt,
    debug: values.debug,
    reg: values.reg || "",
    retry: Number.isNaN(retry) ? 3 : retry,
    resume,
    timeout: Number.isNaN(timeout) ? 0 : timeout,
    agents,
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `node --test test/main.test.js`
Expected: 所有测试通过

- [ ] **Step 6: Commit**

```bash
git add src/main.js test/main.test.js
git commit -s -S -m "feat: parseArgs support multi-agent -t/-c pairing"
```

---

### Task 2: 更新 HELP 文本和 buildStderrOutput

**Files:**
- Modify: `src/main.js:13-66` (HELP 常量)
- Modify: `src/main.js:121-126` (buildStderrOutput 函数)
- Test: `test/main.test.js`

**Interfaces:**
- Consumes: 无
- Produces: `buildStderrOutput(agentCommandName, sessionId, agentResults)` — agentResults 为 `[{ commandName, stdout, stderr }]` 数组

- [ ] **Step 1: 编写 buildStderrOutput 新签名的测试**

```js
// test/main.test.js - 替换现有 buildStderrOutput 测试（如有），或新增
describe("buildStderrOutput", () => {
  it("single agent output with agentCommandName and sessionId", () => {
    const result = buildStderrOutput("claude", "sid-1", [
      { commandName: "claude", stdout: "", stderr: "some error" },
    ]);
    assert.ok(result.endsWith("sid-1"));
    const lines = result.split("\n");
    assert.strictEqual(lines[lines.length - 1], "sid-1");
    assert.strictEqual(lines[lines.length - 2], "claude");
  });

  it("multi agent output aggregates all results with labels", () => {
    const result = buildStderrOutput("codex", "sid-2", [
      { commandName: "copilot", stdout: "cop-out", stderr: "cop-err" },
      { commandName: "codex", stdout: "", stderr: "cdx-err" },
    ]);
    const lines = result.split("\n");
    // 最后两行
    assert.strictEqual(lines[lines.length - 1], "sid-2");
    assert.strictEqual(lines[lines.length - 2], "codex");
    // 包含分隔标记
    assert.ok(result.includes("[copilot] stderr:"));
    assert.ok(result.includes("cop-err"));
    assert.ok(result.includes("[copilot] stdout:"));
    assert.ok(result.includes("cop-out"));
    assert.ok(result.includes("[codex] stderr:"));
    assert.ok(result.includes("cdx-err"));
  });

  it("skips empty stdout/stderr sections", () => {
    const result = buildStderrOutput("claude", "sid-3", [
      { commandName: "claude", stdout: "", stderr: "" },
    ]);
    const lines = result.split("\n");
    assert.strictEqual(lines[lines.length - 1], "sid-3");
    assert.strictEqual(lines[lines.length - 2], "claude");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/main.test.js`
Expected: FAIL — buildStderrOutput 签名不匹配

- [ ] **Step 3: 实现新 buildStderrOutput 和 HELP 文本**

```js
// src/main.js - 替换 HELP 常量 (第 13-66 行)
const HELP = `用法: wrapper -p <提示词> [选项]

一次性 AI 编码代理 CLI 封装器。

必填:
  -p, --prompt <文本>     用户提示词

选项:
  -t, --type <名称>       代理类型: claude, codex, copilot, gemini, cursor (默认: claude)
                          可多次指定以实现冗余调用
  -c, --command <命令>     执行命令 (须紧跟 -t 之后，默认根据 -t 决定)
  -d, --debug             开启调试日志输出到 stderr
  -e, --reg <模式>        用于匹配输出的正则表达式
  -r, --retry <次数>       最大重试次数 (默认: 3)
  -s, --resume <id>       恢复之前的会话
  -o, --timeout <秒>      超时时间，单位秒 (默认: 0，不限时)
  -h, --help              显示此帮助

输出:
  stdout  = 子进程标准输出
  stderr  = 子进程标准错误 + 代理命令名 (倒数第二行) + 会话 ID (最后一行)
  退出码  = 子进程退出码

示例:
  wrapper -t copilot -t codex -p "say hi in one word"
  wrapper -t claude -c "claude-deepseek" -t claude -c "claude-deepseek-flash" -p "say hi"
  wrapper -t copilot -t codex -r 3 -p "say hi in one word"
`;

// src/main.js - 替换 buildStderrOutput 函数 (第 121-126 行)
function buildStderrOutput(agentCommandName, sessionId, agentResults) {
  const parts = [];

  for (const r of agentResults) {
    if (r.stderr) {
      parts.push(`[${r.commandName}] stderr:`);
      parts.push(r.stderr);
    }
    if (r.stdout) {
      parts.push(`[${r.commandName}] stdout:`);
      parts.push(r.stdout);
    }
  }

  if (agentCommandName) parts.push(agentCommandName);
  if (sessionId) parts.push(sessionId);
  return parts.join("\n");
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/main.test.js`
Expected: 所有测试通过

- [ ] **Step 5: Commit**

```bash
git add src/main.js test/main.test.js
git commit -s -S -m "feat: update HELP to Chinese, buildStderrOutput supports multi-agent aggregation"
```

---

### Task 3: main() 双层循环 + 多 Agent Fallback 逻辑

**Files:**
- Modify: `src/main.js:145-241` (main 函数)
- Modify: `src/main.js:250` (module.exports)

**Interfaces:**
- Consumes: `parseArgs()` 返回 `{ agents, prompt, debug, reg, retry, resume, timeout }`
- Consumes: `buildStderrOutput(agentCommandName, sessionId, agentResults)`
- Consumes: provider `createSession`/`send`/`closeSession` 接口（不变）
- Produces: 最终 stdout/stderr/exit code 输出

- [ ] **Step 1: 实现 main() 双层循环**

```js
// src/main.js - 替换 main 函数 (第 145-241 行)
async function main() {
  const opts = parseArgs(process.argv);

  if (opts.debug) log.setDebug(true);

  log.info("wrapper starting: agents=%d", opts.agents.length);
  for (const a of opts.agents) {
    log.debug("  agent type=%s command=%s commandName=%s", a.type, a.command, a.commandName);
  }
  log.debug("prompt=%s timeout=%ds retry=%d reg=%s",
    opts.prompt.slice(0, 100), opts.timeout, opts.retry, opts.reg || "(none)");

  const providers = {
    claude: require("./provider/claude"),
    codex: require("./provider/codex"),
    copilot: require("./provider/copilot"),
    gemini: require("./provider/gemini"),
    cursor: require("./provider/cursor"),
  };

  const regex = opts.reg ? new RegExp(opts.reg) : null;
  const allResults = []; // { commandName, stdout, stderr }

  for (let agentIdx = 0; agentIdx < opts.agents.length; agentIdx++) {
    const agent = opts.agents[agentIdx];
    const provider = providers[agent.type];
    if (!provider) {
      log.error("unknown provider type: %s", agent.type);
      process.exit(EXIT_PROVIDER_ERROR);
    }

    log.info("trying agent %d/%d: %s (%s)", agentIdx + 1, opts.agents.length, agent.commandName, agent.type);

    let session;
    try {
      session = await provider.createSession({
        command: agent.command,
        timeout: opts.timeout,
        resume: opts.resume,
      });
    } catch (err) {
      log.error("failed to create session for %s: %s", agent.commandName, err.message);
      allResults.push({ commandName: agent.commandName, stdout: "", stderr: err.message });
      if (agentIdx < opts.agents.length - 1) continue; // fallback to next agent
      // last agent — exit
      process.stdout.write("\n");
      process.stderr.write(buildStderrOutput(agent.commandName, "", allResults) + "\n");
      process.exit(err.message.startsWith("command not found") ? EXIT_COMMAND_NOT_FOUND : EXIT_PROVIDER_ERROR);
    }

    let lastResult = null;
    let agentSuccess = false;
    let agentDone = false; // 是否因 timeout/error/non-zero exit 跳出 retry 循环

    try {
      for (let attempt = 0; attempt <= opts.retry; attempt++) {
        log.info("agent %s attempt %d/%d session=%s", agent.commandName, attempt + 1, opts.retry + 1, session.sessionId || "(pending)");

        try {
          lastResult = await provider.send(session, opts.prompt);
        } catch (err) {
          log.error("provider send failed for %s: %s", agent.commandName, err.message);
          allResults.push({ commandName: agent.commandName, stdout: lastResult?.stdout || "", stderr: err.message });
          agentDone = true;
          break; // fallback to next agent
        }

        if (lastResult.timedOut) {
          log.error("agent %s attempt %d: timed out after %ds", agent.commandName, attempt + 1, opts.timeout);
          allResults.push({ commandName: agent.commandName, stdout: lastResult.stdout || "", stderr: lastResult.stderr || "" });
          agentDone = true;
          break; // fallback to next agent
        }

        if (lastResult.exitCode && lastResult.exitCode !== 0) {
          log.error("agent %s attempt %d: non-zero exit code %d", agent.commandName, attempt + 1, lastResult.exitCode);
          allResults.push({ commandName: agent.commandName, stdout: lastResult.stdout || "", stderr: lastResult.stderr || "" });
          agentDone = true;
          break; // fallback to next agent
        }

        if (!canRetry(lastResult.stdout, regex)) {
          // 成功
          agentSuccess = true;
          allResults.push({ commandName: agent.commandName, stdout: lastResult.stdout || "", stderr: lastResult.stderr || "" });
          break;
        }

        log.info("agent %s attempt %d: retry needed — %s", agent.commandName, attempt + 1, retryReason(lastResult.stdout, regex));
        log.debug("attempt %d stdout:\n%s", attempt + 1, lastResult.stdout || "(empty)");
        log.debug("attempt %d stderr:\n%s", attempt + 1, lastResult.stderr || "(empty)");
      }

      // retry 用完但未标记 agentDone
      if (!agentSuccess && !agentDone) {
        log.error("agent %s: all %d attempts exhausted: %s", agent.commandName, opts.retry + 1, retryReason(lastResult.stdout, regex));
        allResults.push({ commandName: agent.commandName, stdout: lastResult?.stdout || "", stderr: lastResult?.stderr || "" });
      }
    } finally {
      try { await provider.closeSession(session); } catch {}
    }

    if (agentSuccess) {
      const out = collapseBlankLines(lastResult.stdout);
      process.stdout.write(out);
      if (!out.endsWith("\n")) process.stdout.write("\n");
      process.stderr.write(buildStderrOutput(agent.commandName, lastResult.sessionId, allResults) + "\n");
      process.exit(lastResult.exitCode || EXIT_OK);
    }

    log.info("agent %s failed, %s", agent.commandName,
      agentIdx < opts.agents.length - 1 ? "falling back to next agent" : "no more agents");
  }

  // 所有 agent 失败
  const lastAgent = opts.agents[opts.agents.length - 1];
  const lastAgentResult = allResults[allResults.length - 1];
  const out = collapseBlankLines(lastAgentResult?.stdout || "");
  process.stdout.write(out);
  if (!out.endsWith("\n")) process.stdout.write("\n");
  process.stderr.write(buildStderrOutput(lastAgent.commandName, lastAgentResult?.sessionId || "", allResults) + "\n");

  const exitCode = isOutputEmpty(lastAgentResult?.stdout || "") ? EXIT_EMPTY_OUTPUT
    : (regex ? EXIT_REGEX_MISMATCH : EXIT_OK);
  process.exit(exitCode || EXIT_PROVIDER_ERROR);
}
```

- [ ] **Step 2: 更新 module.exports**

```js
// src/main.js - 替换 module.exports 行
module.exports = { parseArgs, isOutputEmpty, canRetry, buildStderrOutput, collapseBlankLines, retryReason, EXIT_OK, EXIT_REGEX_MISMATCH, EXIT_EMPTY_OUTPUT, EXIT_PROVIDER_ERROR, EXIT_TIMEOUT, EXIT_COMMAND_NOT_FOUND };
```

exports 不变，保持现有导出。

- [ ] **Step 3: 运行所有测试**

Run: `node --test test/main.test.js`
Expected: 所有测试通过

- [ ] **Step 4: Commit**

```bash
git add src/main.js
git commit -s -S -m "feat: main() multi-agent fallback loop"
```

---

### Task 4: 更新文档

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/design.md`（如需要）

**Interfaces:**
- Consumes: 无
- Produces: 无

- [ ] **Step 1: 更新 CLAUDE.md 的 CLI 用法和架构描述**

在 `CLAUDE.md` 的 CLI 部分添加多 Agent 用法示例，Architecture 部分说明 fallback 机制：

```markdown
### CLI

```
wrapper -p <prompt> [-t type [-c cmd]] [-t type [-c cmd]] ... [-d] [-s id] [-e "regex"] [-r 3] [-o 60]
```

多 Agent 冗余调用:
```
wrapper -t copilot -t codex -p "say hi in one word"
wrapper -t claude -c "claude-deepseek" -t claude -c "claude-deepseek-flash" -p "say hi"
```
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -s -S -m "docs: update CLI usage for multi-agent fallback"
```

---

### Task 5: 端到端验证

- [ ] **Step 1: 运行全部测试**

Run: `npm test`
Expected: 所有测试通过

- [ ] **Step 2: 手动验证 help 输出**

Run: `node src/main.js -h`
Expected: 显示中文帮助文本，包含多 Agent 示例

- [ ] **Step 3: 验证错误检测**

Run: `node src/main.js -t claude -c a -c b -p hi`
Expected: 报错 `duplicate -c/--command for -t claude`

Run: `node src/main.js -c cmd -t claude -p hi`
Expected: 报错 `-c/--command must follow a -t/--type option`

Run: `node src/main.js -t claude -r 3 -c cmd -p hi`
Expected: 报错 `-c/--command must immediately follow -t/--type`

Run: `node src/main.js -t copilot -t codex -s abc -p hi`
Expected: 报错 `--resume cannot be used with multiple agents`
