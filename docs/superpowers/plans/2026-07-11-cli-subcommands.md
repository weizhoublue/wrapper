# CLI 子命令重构实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `wrapper` 重构为 `run` / `throttle` 子命令结构；`run` 以最后一个 argv token 为提示词（无 `-p`）；`throttle` 支持 `-l` 列表与 `-d` 删除；旧 CLI 硬切换报错。

**Architecture:** 顶层 `src/cli/route.js` 分发子命令；`src/cli/run.js` 承载 `parseRunArgs`（自 `main.js` 迁出并改 prompt 规则）；`src/cli/throttle-cmd.js` 实现 throttle 子命令；`src/throttle.js` 新增 `listRecords` / `deleteRecordByIndex`；`main.js` 保留 `executeRun` 主体并 re-export 测试符号。

**Tech Stack:** Node.js 内置模块；`node:util` `parseArgs`；Node.js 原生 test runner；CommonJS；无新 npm 依赖。

## Global Constraints

- 纯 CommonJS，不引入任何新的 npm 依赖
- 硬切换：顶层 `-p` / 无 `run` 的旧式调用必须 exit 2 并提示 `wrapper run`
- `run` 子命令**不提供** `-p` / `--prompt`
- 提示词 = `run` 之后**最后一个** argv token，verbatim
- throttle 列表 id 为 1-based 展示序号，**不**改 `throttle.json` 结构
- 配置目录：`WRAPPER_CONFIG_DIR`，默认 `~/.wrapper`；throttle 文件 `${WRAPPER_CONFIG_DIR}/throttle.json`
- 删除 throttle 记录须走 `throttle.json.lock`（与 `recordExhausted` 相同锁逻辑）
- `npm test` 全绿为合并门槛；新增测试 ≥ 40 条（见 spec 第五节）
- 所有日志走 `src/log.js`；测试用 tmp dir，不污染 `~/.wrapper`

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/throttle.js` | 修改 | 新增 `listRecords`、`deleteRecordByIndex` |
| `src/cli/run.js` | **新建** | `RUN_HELP`、`parseRunArgs`、`DEFAULTS` |
| `src/cli/route.js` | **新建** | `TOP_HELP`、`routeCli`、`detectLegacyCli` |
| `src/cli/throttle-cmd.js` | **新建** | `THROTTLE_HELP`、`runThrottleCommand` |
| `src/main.js` | 修改 | 路由、`executeRun`、re-export |
| `test/throttle-delete.test.js` | **新建** | T1–T10 |
| `test/cli-run.test.js` | **新建** | P/S + 自 `main.test.js` 迁移的全部 parseArgs 用例 |
| `test/cli-route.test.js` | **新建** | R1–R10 |
| `test/cli-throttle-cmd.test.js` | **新建** | C1–C12 |
| `test/main.test.js` | 修改 | 移除 `parseArgs` describe |
| `test/fallback.test.js` | 修改 | argv 加 `run`，prompt 置末 |
| `test/throttle-e2e.test.js` | 修改 | 同上 |
| `test/smoke.test.js` | 修改 | M1–M6 |
| `README.md` 等文档 | 修改 | 示例改为新 CLI |

---

## Task 1：`throttle.js` 扩展 `listRecords` / `deleteRecordByIndex`

**Files:**
- Modify: `src/throttle.js`
- Create: `test/throttle-delete.test.js`

**Interfaces:**
- Produces:
  - `listRecords(throttleFile)` → `Array<{type, command, startExhausted, endExhausted}>`
  - `deleteRecordByIndex(throttleFile, id)` → 删除的记录对象；无效 id 或锁失败时 `throw new Error(...)`

- [ ] **Step 1：写失败测试 T1 + T4**

Create `test/throttle-delete.test.js`:

```js
"use strict";
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { listRecords, deleteRecordByIndex } = require("../src/throttle");

let tmpDir;
let throttleFile;

describe("throttle listRecords / deleteRecordByIndex", () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-throttle-del-"));
    throttleFile = path.join(tmpDir, "throttle.json");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    if (fs.existsSync(throttleFile)) fs.unlinkSync(throttleFile);
    const lockFile = throttleFile + ".lock";
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  });

  it("listRecords returns [] when file missing", () => {
    assert.deepStrictEqual(listRecords(throttleFile), []);
  });

  it("deleteRecordByIndex removes first record", () => {
    fs.writeFileSync(throttleFile, JSON.stringify([
      { type: "codex", command: null, startExhausted: "a", endExhausted: "b" },
    ]));
    const deleted = deleteRecordByIndex(throttleFile, 1);
    assert.strictEqual(deleted.type, "codex");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(throttleFile, "utf8")), []);
  });
});
```

- [ ] **Step 2：运行确认失败**

Run: `node --test test/throttle-delete.test.js`
Expected: FAIL — `listRecords is not a function`

- [ ] **Step 3：实现**

在 `src/throttle.js` 末尾、`module.exports` 前添加：

```js
function listRecords(throttleFile) {
  return readRecords(throttleFile);
}

function deleteRecordByIndex(throttleFile, id) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId < 1) {
    throw new Error(`no throttle record with id ${id}`);
  }

  const lockFile = throttleFile + ".lock";
  const locked = acquireLock(lockFile);
  if (!locked) {
    throw new Error("failed to acquire throttle lock");
  }
  try {
    const records = readRecords(throttleFile);
    if (numericId > records.length) {
      throw new Error(`no throttle record with id ${id}`);
    }
    const [deleted] = records.splice(numericId - 1, 1);
    writeRecords(throttleFile, records);
    return deleted;
  } finally {
    releaseLock(lockFile);
  }
}
```

更新 exports：

```js
module.exports = {
  checkThrottle, recordExhausted, toLocalISOString,
  listRecords, deleteRecordByIndex,
};
```

- [ ] **Step 4：补全 T2–T10 测试（spec 5.4 表）后运行**

Run: `node --test test/throttle-delete.test.js`
Expected: PASS（全部 T* 用例）

- [ ] **Step 5：Commit**

```bash
git add src/throttle.js test/throttle-delete.test.js
git commit -m "feat(throttle): add listRecords and deleteRecordByIndex"
```

---

## Task 2：`src/cli/run.js` — `parseRunArgs`

**Files:**
- Create: `src/cli/run.js`
- Create: `test/cli-run.test.js`（先写 P1–P11 核心用例）

**Interfaces:**
- Consumes: `DEFAULT_TIMEOUT` from `main.js` 或 run.js 内复制常量 `3600`、`DEFAULT_THROTTLE_DURATION_MINUTES = 120`
- Produces:
  - `parseRunArgs(argv)` → `{ prompt, debug, reg, exclude, quota, retry, resume, timeout, agents, throttle, throttleDuration }`
  - `RUN_HELP` 字符串
  - `DEFAULTS` 对象（自 `main.js` 迁出）

- [ ] **Step 1：写失败测试 P1、P7、P9、P10**

Create `test/cli-run.test.js`：

```js
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { parseRunArgs } = require("../src/cli/run");

describe("parseRunArgs prompt", () => {
  it("P1: last token is prompt", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "hello"]);
    assert.strictEqual(opts.prompt, "hello");
  });

  it("P7: run with no args throws missing prompt", () => {
    assert.throws(
      () => parseRunArgs(["node", "main.js", "run"]),
      /missing prompt/i,
    );
  });

  it("P9: prompt before options throws", () => {
    assert.throws(
      () => parseRunArgs(["node", "main.js", "run", "say hi", "-t", "codex"]),
      /prompt must be the last argument/i,
    );
  });

  it("P10: -p is rejected", () => {
    assert.throws(
      () => parseRunArgs(["node", "main.js", "run", "-p", "hi"]),
      /(-p|--prompt).*not supported|no longer supported/i,
    );
  });
});
```

- [ ] **Step 2：运行确认失败**

Run: `node --test test/cli-run.test.js`
Expected: FAIL — cannot find module `../src/cli/run`

- [ ] **Step 3：创建 `src/cli/run.js`**

从 `src/main.js` 复制 `DEFAULTS`、`HELP`→`RUN_HELP`（改用法行）、`parseArgs` 逻辑，核心改动：

```js
function parseRunArgs(argv) {
  const runIdx = argv.indexOf("run");
  if (runIdx === -1) throw new Error("internal: parseRunArgs called without run subcommand");

  const runArgs = argv.slice(runIdx + 1);

  // run -h
  if (runArgs.includes("-h") || runArgs.includes("--help")) {
    process.stdout.write(RUN_HELP + "\n");
    process.exit(0);
  }

  if (runArgs.length === 0) {
    throw new Error("missing prompt (last argument)");
  }

  const prompt = runArgs[runArgs.length - 1];
  const optionTokens = runArgs.slice(0, -1);

  if (optionTokens.includes("-p") || optionTokens.includes("--prompt")) {
    throw new Error("option -p/--prompt is no longer supported; put the prompt as the last argument");
  }

  // Phase 1: -t/-c scan on optionTokens only (同 main.js)
  // ... quota/throttle strip on optionTokens ...
  // Phase 2: nodeParseArgs — 移除 prompt 选项，仅 debug/reg/exclude/retry/resume/timeout

  const { values, tokens } = nodeParseArgs({
    args: optionTokens,
    options: {
      debug:   { type: "boolean", short: "d", default: false },
      reg:     { type: "string", short: "e" },
      exclude: { type: "string", short: "x" },
      retry:   { type: "string", short: "r", default: "2" },
      resume:  { type: "string", short: "s" },
      timeout: { type: "string", short: "o", default: "3600" },
    },
    allowPositionals: true,
  });

  // 前缀中残留的 positional = prompt 位置错误
  const leftover = tokens.filter((t) => t.kind === "positional").map((t) => t.value);
  if (leftover.length > 0) {
    throw new Error("prompt must be the last argument");
  }

  return { prompt, /* ...同原 parseArgs 返回字段... */ };
}

module.exports = { parseRunArgs, RUN_HELP, DEFAULTS, DEFAULT_TIMEOUT: 3600 };
```

- [ ] **Step 4：运行 P 用例通过**

Run: `node --test test/cli-run.test.js`
Expected: PASS（P1/P7/P9/P10）

- [ ] **Step 5：迁移 `test/main.test.js` 全部 `parseArgs` / `parseArgs multi-agent` 到 `cli-run.test.js`**

规则：
- import 改为 `require("../src/cli/run")`
- argv 模式：`["node","main.js","run", ...opts, "prompt"]`（prompt **最后**）
- 删除对 `-p` / `--prompt` 的用例；改为最后 token
- 原 `throws on missing -p` → 改为 P7/P8
- 原 `parses all flags` 示例：

```js
const opts = parseRunArgs(["node", "main.js", "run",
  "-t", "claude", "-c", "cc", "-d", "-e", "PASS", "-r", "5", "-o", "30", "test"]);
```

- [ ] **Step 6：运行完整 cli-run 测试**

Run: `node --test test/cli-run.test.js`
Expected: PASS

- [ ] **Step 7：Commit**

```bash
git add src/cli/run.js test/cli-run.test.js
git commit -m "feat(cli): add parseRunArgs with last-token prompt"
```

---

## Task 3：`src/cli/route.js` — 顶层路由

**Files:**
- Create: `src/cli/route.js`
- Create: `test/cli-route.test.js`

**Interfaces:**
- Produces:
  - `routeCli(argv)` → `"run"` | `"throttle"` | `null`（help/version 时 `process.exit`，不返回）
  - `TOP_HELP` 字符串
  - `detectLegacyCli(args)` → `boolean`

- [ ] **Step 1：写失败测试 R2、R6**

```js
const { spawnSync } = require("child_process");
const path = require("path");
const { describe, it } = require("node:test");
const assert = require("node:assert");

const mainJs = path.join(__dirname, "..", "src", "main.js");

function runWrapper(args) {
  return spawnSync("node", [mainJs, ...args], { encoding: "utf8" });
}

describe("cli route", () => {
  it("R2: wrapper -h shows subcommands", () => {
    const r = runWrapper(["-h"]);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /run/);
    assert.match(r.stdout, /throttle/);
  });

  it("R6: wrapper -p hi migration error", () => {
    const r = runWrapper(["-p", "hi"]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /wrapper run/i);
  });
});
```

- [ ] **Step 2：运行确认失败**（main.js 尚未路由）

Run: `node --test test/cli-route.test.js`
Expected: FAIL（`-h` 仍打印旧 help 或 `-p` 不报错）

- [ ] **Step 3：实现 `src/cli/route.js`**

```js
const TOP_HELP = `用法: wrapper <子命令> [选项]

子命令:
    run       运行 AI 编码代理（wrapper run -h 查看详情）
    throttle  管理 quota 冷却状态（wrapper throttle -h 查看详情）

全局选项:
    -h, --help      显示此帮助
    -v, --version   显示版本号
`;

const LEGACY_RUN_FLAGS = new Set([
  "-t", "--type", "-c", "--command", "-d", "--debug",
  "-e", "--reg", "-x", "--exclude", "-q", "--quota", "-n", "--no-quota",
  "-r", "--retry", "-s", "--resume", "-o", "--timeout",
  "--enable-throttle", "--throttle-duration", "-p", "--prompt",
]);

function detectLegacyCli(args) {
  if (args.includes("-p") || args.includes("--prompt")) return true;
  const first = args[0];
  if (first && LEGACY_RUN_FLAGS.has(first)) return true;
  return false;
}

function migrationHint(args) {
  const hasP = args.includes("-p") || args.includes("--prompt");
  if (hasP) {
    const pIdx = args.indexOf("-p") !== -1 ? args.indexOf("-p") : args.indexOf("--prompt");
    const prompt = args[pIdx + 1] || "";
    const rest = args.filter((_, i) => i !== pIdx && i !== pIdx + 1);
    return `wrapper run ${rest.join(" ")} "${prompt}"`.trim();
  }
  return "wrapper run ... <prompt>";
}

function routeCli(argv) {
  const args = argv.slice(2);

  if (args.includes("-v") || args.includes("--version")) {
    const pkg = require("../../package.json");
    process.stdout.write(pkg.version + "\n");
    process.exit(0);
  }

  if (args.length === 0 || (args.length === 1 && (args[0] === "-h" || args[0] === "--help"))) {
    process.stdout.write(TOP_HELP + "\n");
    process.exit(0);
  }

  if (detectLegacyCli(args)) {
    throw new Error(
      `wrapper now uses subcommands. Did you mean:\n  ${migrationHint(args)}`,
    );
  }

  const sub = args[0];
  if (sub === "run" || sub === "throttle") return sub;

  throw new Error(`unknown subcommand: ${sub}. Use wrapper -h for help.`);
}

module.exports = { routeCli, TOP_HELP, detectLegacyCli, migrationHint };
```

- [ ] **Step 4：在 `main.js` 接入路由（最小改动）**

`main.js` 顶部：

```js
const { routeCli } = require("./cli/route");
const { parseRunArgs } = require("./cli/run");
```

`async function main()` 开头：

```js
const sub = routeCli(process.argv);
if (sub === "throttle") {
  const { runThrottleCommand } = require("./cli/throttle-cmd");
  return runThrottleCommand(process.argv);
}
const opts = parseRunArgs(process.argv);
// ... 原 main 主体不变 ...
```

删除 `main.js` 内旧 `parseArgs`、`HELP`、顶层 version/help 逻辑。

- [ ] **Step 5：补全 R1、R3–R5、R7–R10 测试并运行**

Run: `node --test test/cli-route.test.js`
Expected: PASS（throttle 子命令 Task 4 完成前 R5 可先 skip 或期望 help 占位）

- [ ] **Step 6：Commit**

```bash
git add src/cli/route.js src/main.js test/cli-route.test.js
git commit -m "feat(cli): add top-level subcommand routing"
```

---

## Task 4：`src/cli/throttle-cmd.js` — throttle 子命令

**Files:**
- Create: `src/cli/throttle-cmd.js`
- Create: `test/cli-throttle-cmd.test.js`

**Interfaces:**
- Consumes: `listRecords`, `deleteRecordByIndex`, `toLocalISOString` from `src/throttle.js`
- Produces: `runThrottleCommand(argv)` → `number` exit code（0 或 2）

- [ ] **Step 1：写失败测试 C1、C5**

```js
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");

const mainJs = path.join(__dirname, "..", "src", "main.js");
let tmpDir;

describe("cli throttle command", () => {
  before(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-cli-throttle-")); });
  after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  function run(args) {
    return spawnSync("node", [mainJs, "throttle", ...args], {
      encoding: "utf8",
      env: { ...process.env, WRAPPER_CONFIG_DIR: tmpDir },
    });
  }

  it("C1: list empty", () => {
    const r = run(["-l"]);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /No throttle records/);
  });

  it("C5: delete first record", () => {
    fs.writeFileSync(path.join(tmpDir, "throttle.json"), JSON.stringify([
      { type: "codex", command: "x", startExhausted: "a", endExhausted: "b" },
      { type: "claude", command: null, startExhausted: "c", endExhausted: "d" },
    ]));
    const r = run(["-d", "1"]);
    assert.strictEqual(r.status, 0);
    const left = JSON.parse(fs.readFileSync(path.join(tmpDir, "throttle.json"), "utf8"));
    assert.strictEqual(left.length, 1);
    assert.strictEqual(left[0].type, "claude");
  });
});
```

- [ ] **Step 2：运行确认失败**

Run: `node --test test/cli-throttle-cmd.test.js`
Expected: FAIL

- [ ] **Step 3：实现 `src/cli/throttle-cmd.js`**

```js
"use strict";
const path = require("path");
const os = require("os");
const { parseArgs: nodeParseArgs } = require("node:util");
const log = require("../log");
const { listRecords, deleteRecordByIndex } = require("../throttle");

const THROTTLE_HELP = `用法: wrapper throttle [选项]

选项:
    -l, --list            列出 throttle 记录
    -d, --delete <id>     按列表编号删除记录（1-based）
    -h, --help            显示此帮助
`;

function formatRecordLine(id, r) {
  const cmd = r.command == null ? "(default)" : r.command;
  return `${id}  type=${r.type}  command=${cmd}  startExhausted=${r.startExhausted}  endExhausted=${r.endExhausted}`;
}

function runThrottleCommand(argv) {
  const args = argv.slice(argv.indexOf("throttle") + 1);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    process.stdout.write(THROTTLE_HELP + "\n");
    return 0;
  }

  const { values } = nodeParseArgs({
    args,
    options: {
      list:   { type: "boolean", short: "l", default: false },
      delete: { type: "string", short: "d" },
    },
  });

  if (values.list && values.delete) {
    process.stderr.write("Error: --list and --delete are mutually exclusive\n");
    return 2;
  }

  const configDir = process.env.WRAPPER_CONFIG_DIR || path.join(os.homedir(), ".wrapper");
  const throttleFile = path.join(configDir, "throttle.json");

  if (values.list) {
    const records = listRecords(throttleFile);
    if (records.length === 0) {
      process.stdout.write("No throttle records.\n");
    } else {
      records.forEach((r, i) => process.stdout.write(formatRecordLine(i + 1, r) + "\n"));
    }
    return 0;
  }

  if (values.delete) {
    try {
      const deleted = deleteRecordByIndex(throttleFile, values.delete);
      const cmd = deleted.command == null ? "(default)" : deleted.command;
      log.info("deleted throttle record id=%s type=%s command=%s", values.delete, deleted.type, cmd);
      return 0;
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      return 2;
    }
  }

  process.stdout.write(THROTTLE_HELP + "\n");
  return 0;
}

module.exports = { runThrottleCommand, THROTTLE_HELP };
```

- [ ] **Step 4：补全 C2–C4、C6–C12；运行**

Run: `node --test test/cli-throttle-cmd.test.js`
Expected: PASS

- [ ] **Step 5：Commit**

```bash
git add src/cli/throttle-cmd.js test/cli-throttle-cmd.test.js
git commit -m "feat(cli): add throttle list/delete subcommand"
```

---

## Task 5：`main.js` 收尾与 `main.test.js` 清理

**Files:**
- Modify: `src/main.js`
- Modify: `test/main.test.js`

- [ ] **Step 1：从 `main.js` 删除已迁出的 `DEFAULTS`、`HELP`、`parseArgs`**

- [ ] **Step 2：re-export 测试符号**

```js
const { parseRunArgs, DEFAULTS } = require("./cli/run");
const { routeCli } = require("./cli/route");

module.exports = {
  main, parseRunArgs, parseArgs: parseRunArgs, routeCli,
  DEFAULTS,
  // ... 其余不变 ...
};
```

- [ ] **Step 3：从 `test/main.test.js` 删除 `parseArgs` / `parseArgs multi-agent` 两个 describe 块**

- [ ] **Step 4：运行**

Run: `node --test test/main.test.js test/cli-run.test.js`
Expected: PASS

- [ ] **Step 5：Commit**

```bash
git add src/main.js test/main.test.js
git commit -m "refactor: wire run subcommand and clean main exports"
```

---

## Task 6：E2E 与 smoke 回归

**Files:**
- Modify: `test/fallback.test.js`
- Modify: `test/throttle-e2e.test.js`
- Modify: `test/smoke.test.js`

- [ ] **Step 1：批量替换 `fallback.test.js` 中 `runMain` argv**

模式：每个 `runMain([...])` 改为 `runMain(["run", ...opts, prompt])`，prompt 从 `-p` 参数移到末尾。

示例：

```js
// 旧
await runMain(["-t", "copilot", "-t", "codex", "-p", "hi"]);
// 新
await runMain(["run", "-t", "copilot", "-t", "codex", "hi"]);
```

- [ ] **Step 2：同样更新 `throttle-e2e.test.js` 全部 10 个用例**

- [ ] **Step 3：更新 `smoke.test.js`**

```js
// M1
runCommu(["run", "say hi in one word"]);
// M5
runCommu(["-p", "hi"]);  // assert code === 2
// M6
runCommu(["throttle", "-l"]);
```

- [ ] **Step 4：在 `throttle-e2e.test.js` 或 `cli-route.test.js` 添加 E2/E3**

- [ ] **Step 5：全量测试**

Run: `npm test`
Expected: PASS（smoke 中 `hasClaude` skip 可保留）

- [ ] **Step 6：Commit**

```bash
git add test/fallback.test.js test/throttle-e2e.test.js test/smoke.test.js
git commit -m "test: migrate E2E and smoke to run subcommand CLI"
```

---

## Task 7：文档更新

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/get-started.md`
- Modify: `docs/design.md`
- Modify: `docs/throttle.md`

- [ ] **Step 1：全局搜索 `wrapper -p` 与 `wrapper -t` 示例，改为 `wrapper run`**

- [ ] **Step 2：`docs/throttle.md` 手动清理章节改为 `wrapper throttle -l` / `wrapper throttle -d <id>`**

- [ ] **Step 3：`CLAUDE.md` CLI 段更新为子命令结构**

- [ ] **Step 4：Commit**

```bash
git add README.md CLAUDE.md docs/
git commit -m "docs: update CLI examples for run/throttle subcommands"
```

---

## Spec 覆盖自检

| Spec 章节 | 对应 Task |
|-----------|-----------|
| 一、CLI 结构 / 迁移 | Task 3 |
| 二、`run` 子命令 / prompt 规则 | Task 2, 5 |
| 三、`throttle` 子命令 | Task 1, 4 |
| 四、代码结构 | Task 2–5 |
| 五、测试完备 | Task 1–6 |
| 六、文档 | Task 7 |
| 七、非目标 | 全程遵守 |

---

## 验收

```bash
npm test
```

全部通过；`wrapper -p hi` exit 2；`wrapper run -t codex "hi"` 行为与旧版等价。
