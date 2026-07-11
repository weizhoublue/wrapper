# CLI 子命令重构设计文档

**日期：** 2026-07-11  
**分支：** pr/list  
**状态：** 待实现

---

## 概述

将 `wrapper` 从扁平 CLI（`wrapper -p <提示词> [选项]`）重构为子命令结构：

- `wrapper run <选项...> <提示词>` — 运行 AI 编码代理（现有核心逻辑）
- `wrapper throttle` — 查询与管理 quota 冷却状态

**硬切换（breaking change）**：旧写法（顶层 `-p`、无 `run` 子命令）直接报错并提示迁移，不提供兼容别名。

---

## 一、CLI 结构

### 顶层

```
wrapper [-h] [-v]
wrapper run <选项...> <提示词>
wrapper throttle [-l | --list] [-d <id> | --delete <id>] [-h]
```

| 入口 | 行为 |
|------|------|
| `wrapper`（无参数） | 打印顶层 help，exit 0 |
| `wrapper -h` / `wrapper --help` | 打印顶层 help，exit 0 |
| `wrapper -v` / `wrapper --version` | 打印版本号，exit 0 |
| `wrapper run ...` | 执行 agent |
| `wrapper throttle ...` | 管理 throttle 状态 |
| 旧写法（如 `wrapper -p "hi"`、`wrapper -t codex -p "hi"`） | 报错 exit 2，提示改用 `wrapper run` |

### 顶层 help 内容

```
用法: wrapper <子命令> [选项]

子命令:
    run       运行 AI 编码代理（wrapper run -h 查看详情）
    throttle  管理 quota 冷却状态（wrapper throttle -h 查看详情）

全局选项:
    -h, --help      显示此帮助
    -v, --version   显示版本号
```

### 迁移错误示例

```text
$ wrapper -t codex -p "hi"
Error: wrapper now uses subcommands. Did you mean:
  wrapper run -t codex "hi"
```

检测逻辑：第一个 positional 参数不是 `run` / `throttle`，且 argv 中含 `-p` / `--prompt`，或第一个 token 以 `-` 开头且为旧式 run 选项（如 `-t`、`-d`、`-e` 等），则输出迁移提示。

---

## 二、`run` 子命令

### 提示词规则

1. **不提供 `-p` / `--prompt` 选项。**
2. **提示词 = `run` 之后的最后一个 argv token**，原样使用，不参与选项解析。
3. **所有选项必须写在提示词之前。**

```bash
wrapper run -t codex -d "say hi"
wrapper run -t codex -c "my-cmd" -r 2 "say hi"
wrapper run "-fix the bug"
wrapper run -t codex "-fix the bug"
```

### 解析流程

```
argv: node wrapper.js run [option tokens...] <prompt>
                                      ↑ 最后一个 token，verbatim
```

1. 确认子命令为 `run`。
2. 若 `run` 后无参数 → 报错：`missing prompt (last argument)`。
3. 取最后一个 token 为 `prompt`；其前的 tokens 进入选项解析。
4. 选项解析复用现有两阶段逻辑：
   - Phase 1：手动扫描 `-t` / `-c` 对
   - 剥离 quota / throttle 标志（`--no-quota`、`--enable-throttle`、`--throttle-duration`）
   - Phase 2：`node:util` `parseArgs` 解析 `-d`、`-e`、`-x`、`-r`、`-s`、`-o` 等
5. 若选项出现在 prompt 之后（用户把 prompt 写在中间）→ 报错：

```text
Error: prompt must be the last argument. Did you mean:
  wrapper run -t codex "say hi"
```

实现方式：

1. `prompt = args[args.length - 1]`（`run` 之后的最后一个 token）。
2. 对其前的 tokens 做完整选项解析（含 `-t/-c` 扫描与 `node:util` `parseArgs`）。
3. 若选项解析后前缀中仍有未消费的 non-option token（例如用户写了 `wrapper run "say hi" -t codex`，前缀中残留 `"say hi"`），则报错：

```text
Error: prompt must be the last argument. Did you mean:
  wrapper run -t codex "say hi"
```

这样可保证：合法调用中仅最后一个 token 为提示词；误把 prompt 写在选项前的调用会得到明确错误，而非静默把 `-t` 的值当成 prompt。

### `run` 选项（与现有一致）

| 选项 | 说明 |
|------|------|
| `-t, --type <名称>` | 代理类型，可多次指定实现 fallback |
| `-c, --command <命令>` | 须紧跟 `-t` 之后 |
| `-d, --debug` | 调试日志到 stderr |
| `-e, --reg <模式>` | stdout 正则，不匹配则重试 |
| `-x, --exclude <模式>` | stdout 排除正则，匹配则失败不重试 |
| `-q, --quota` | 开启 quota 检测（默认开启） |
| `-n, --no-quota` | 关闭 quota 检测 |
| `--enable-throttle <true\|false>` | throttle 开关（默认 true） |
| `--throttle-duration <分钟>` | 冷却时长（默认 120） |
| `-r, --retry <次数>` | 每 agent 最大重试次数（默认 2） |
| `-s, --resume <id>` | 恢复会话（与多 `-t` 互斥） |
| `-o, --timeout <秒>` | 单次 attempt 超时（默认 3600，0 不限时） |
| `-h, --help` | 显示 run 子命令帮助 |

`run` 的执行逻辑、stdout/stderr 输出规范、退出码（0、200–207）均不变。

### `run` help

从现有 `HELP` 常量迁移：去掉顶层 `-p` 说明；用法改为 `wrapper run <选项...> <提示词>`；保留例子、输出说明、环境变量（`WRAPPER_CONFIG_DIR`）。

---

## 三、`throttle` 子命令

### 选项

| 选项 | 说明 |
|------|------|
| `-l, --list` | 列出 `throttle.json` 中所有记录 |
| `-d, --delete <id>` | 按列表编号删除记录（1-based） |
| `-h, --help` | 显示 throttle 子命令帮助 |

- `--list` 与 `--delete` 互斥；同时指定则报错 exit 2。
- 无子选项时打印 throttle help（不默认执行 list）。

### `--list` 输出格式

读取 `${WRAPPER_CONFIG_DIR}/throttle.json`（默认 `~/.wrapper/throttle.json`）。

- 文件不存在或 `[]`：打印 `No throttle records.` 到 stdout，exit 0。
- 有记录时按数组顺序 1-based 编号，每行一条：

```text
1  type=opencode  command=opencode-cheap  startExhausted=2026-07-08T12:00:00+08:00  endExhausted=2026-07-08T14:00:00+08:00
2  type=codex  command=(default)  startExhausted=...  endExhausted=...
```

- `command` 为 `null` 时显示 `(default)`。
- 时间格式与现有 `toLocalISOString` 一致。

**不修改 `throttle.json` 结构**，不引入持久化 `id` 字段；列表中的编号仅为展示用 1-based 索引。

### `--delete <id>`

- `id` 为 `--list` 输出中的 1-based 序号。
- 通过 `throttle.json.lock` 加锁（复用 `throttle.js` 现有 `acquireLock` / `releaseLock`）。
- 锁内：re-read → 校验 `1 <= id <= records.length` → `splice(id - 1, 1)` → 写回。
- 成功：stderr 打印 `[wrapper][info] deleted throttle record id=N type=... command=...`，exit 0。
- `id` 无效：`Error: no throttle record with id N`，exit 2。
- 锁获取失败：与 `recordExhausted` 一致，warn 后 exit 2。

---

## 四、代码结构

### 推荐方案：子命令模块化

| 文件 | 职责 |
|------|------|
| `src/main.js` | 顶层路由（`-h`/`-v`/子命令分发）；`main()` 执行 run；导出测试用符号 |
| `src/cli/run.js`（新） | `parseRunArgs(argv)`、`RUN_HELP`、迁移错误检测 |
| `src/cli/throttle-cmd.js`（新） | `runThrottleCommand(argv)`、`THROTTLE_HELP` |
| `src/throttle.js` | 新增 `listRecords(throttleFile)`、`deleteRecordByIndex(throttleFile, id)`；锁逻辑内部复用 |

### `main.js` 入口伪代码

```javascript
async function main() {
  const sub = routeSubcommand(process.argv);
  if (sub === "run") {
    const opts = parseRunArgs(process.argv);
    await executeRun(opts); // 现有 main 主体
  } else if (sub === "throttle") {
    runThrottleCommand(process.argv);
  }
}
```

`parseArgs` 重命名为 `parseRunArgs` 并迁至 `src/cli/run.js`；`main.js` 继续 re-export `parseRunArgs`（或别名 `parseArgs`）以保持测试导入路径稳定，或同步更新测试 import。

---

## 五、测试（完备要求）

实现必须附带完整测试套件，`npm test` 全绿为合并门槛。测试分四层：**单元**（解析/模块）、**子命令 CLI**（spawn 进程）、**E2E**（mock provider 走 `main()`）、**smoke**（真实 agent，可选 skip）。

### 5.1 测试文件布局

| 文件 | 职责 |
|------|------|
| `test/cli-route.test.js`（新） | 顶层路由、help、version、迁移错误 |
| `test/cli-run.test.js`（新） | `parseRunArgs` 全量用例（自 `main.test.js` 的 `parseArgs` 迁移并扩展） |
| `test/cli-throttle-cmd.test.js`（新） | `wrapper throttle` 子命令（spawn + 模块直调） |
| `test/throttle-delete.test.js`（新） | `deleteRecordByIndex` / `listRecords` 模块级 |
| `test/main.test.js` | 保留非 CLI 单元测试（`isOutputEmpty`、`buildStderrOutput` 等）；移除已迁出的 `parseArgs` |
| `test/fallback.test.js` | argv 全部改为 `run` 子命令格式 |
| `test/throttle-e2e.test.js` | argv 全部改为 `run` 子命令格式 |
| `test/smoke.test.js` | argv 改为 `run`；新增 throttle smoke |
| `test/throttle.test.js` | 不变（底层模块）；新 delete 用例放 `throttle-delete.test.js` |

**argv 约定：**

- 单元/E2E 直调：`["node", "main.js", "run", ...opts, "prompt"]`
- spawn：`node src/main.js run ... "prompt"`

---

### 5.2 顶层路由 — `test/cli-route.test.js`

通过 `spawnSync` 或导出 `routeCli(argv)` 测试：

| # | 用例 | 期望 |
|---|------|------|
| R1 | `wrapper`（无参数） | stdout 含子命令列表；exit 0 |
| R2 | `wrapper -h` / `wrapper --help` | 顶层 help；含 `run`、`throttle`；exit 0 |
| R3 | `wrapper -v` / `wrapper --version` | stdout = `package.json` version；exit 0 |
| R4 | `wrapper run -h` | run 专用 help；含选项说明；不含顶层 `-p` |
| R5 | `wrapper throttle -h` | throttle 专用 help |
| R6 | `wrapper -p "hi"` | stderr 含迁移提示 + `wrapper run`；exit 2 |
| R7 | `wrapper -t codex -p "hi"` | 同上迁移错误 |
| R8 | `wrapper --prompt "hi"` | 同上迁移错误 |
| R9 | `wrapper -t codex "hi"`（无 `run`） | 迁移错误或 `unknown subcommand`（实现择一，须含 `wrapper run` 提示） |
| R10 | `wrapper unknown` | 未知子命令错误；exit 2 |

---

### 5.3 `parseRunArgs` — `test/cli-run.test.js`

将现有 `test/main.test.js` 中 **全部** `parseArgs` / `parseArgs multi-agent` 用例迁移至此，argv 改为 `run` 格式，prompt 改为**最后一个 token**。并新增/调整如下用例：

#### 5.3.1 提示词（最后参数）

| # | 用例 | 期望 |
|---|------|------|
| P1 | `run "hello"` | `prompt === "hello"` |
| P2 | `run -t codex "say hi"` | `prompt === "say hi"` |
| P3 | `run -t codex -d "say hi"` | `prompt === "say hi"`；`debug === true` |
| P4 | `run -t codex -c "my-cmd" -r 2 "say hi"` | 选项与 prompt 均正确 |
| P5 | `run "-fix bug"` | `prompt === "-fix bug"`（最后 token 不解析为选项） |
| P6 | `run -t codex "-fix bug"` | `prompt === "-fix bug"` |
| P7 | `run`（无后续参数） | throw：`missing prompt` |
| P8 | `run -t codex`（仅选项无 prompt） | throw：`missing prompt` |
| P9 | `run "say hi" -t codex` | throw：`prompt must be the last argument` |
| P10 | `run -p "hi"` | throw：`-p`/`--prompt` 不再支持（明确错误信息） |
| P11 | `run --prompt "hi"` | 同上 |

#### 5.3.2 选项解析（自现有测试迁移，行为不变）

以下用例须全部保留（prompt 位置按 P* 规则调整），断言对象字段与现有一致：

- 默认 `-t` → `claude`；各 type 默认 command（claude/cursor/opencode/codex/copilot）
- `-c` 紧跟 `-t`；`-c` 无 `-t`、`-c` 与 `-t` 间隔其他选项、重复 `-c` → 报错
- `-d`、`-e`/`-x`、`--exclude`、`-r`、`-o 0`、`-s`/`--resume`
- 长选项形式 `--type`、`--command`、`--debug`、`--reg`、`--retry`、`--timeout`、`--resume`
- `retry` 默认 2；`timeout` 默认 3600
- `quota` 默认 true；`-n`/`--no-quota`；`-q`；`-q` 与 `-n` 冲突
- `throttle` 默认 true、duration 120；`--enable-throttle true/false`；无效值 throw
- `--throttle-duration` 正整数校验
- `--no-quota` + throttle enabled → 冲突 throw
- `--no-quota` + `--enable-throttle false` → 允许
- `isCustom` 标志
- 多 `-t` fallback；`-c` 与对应 `-t` 配对
- `--resume` 与多 agent 冲突

#### 5.3.3 特殊 prompt 内容

| # | 用例 | 期望 |
|---|------|------|
| S1 | prompt 含空格、引号转义后的字符串 | 原样保留 |
| S2 | prompt 为空字符串 `run ""` | 允许解析（`prompt === ""`）；run 执行层空输出逻辑不变 |
| S3 | prompt 很长（>1KB 单 token） | 解析不截断 |

---

### 5.4 `throttle` 模块扩展 — `test/throttle-delete.test.js`

在现有 `test/throttle.test.js` 风格（tmp dir + beforeEach 清文件）上新增：

| # | 用例 | 期望 |
|---|------|------|
| T1 | `listRecords` 文件不存在 | 返回 `[]` |
| T2 | `listRecords` 合法数组 | 原样返回 |
| T3 | `listRecords` 非法 JSON / 非数组 | 返回 `[]`（与 `readRecords` 一致） |
| T4 | `deleteRecordByIndex(file, 1)` 单条记录 | 文件变 `[]`；返回被删记录 |
| T5 | `deleteRecordByIndex(file, 2)` 多条记录 | 仅删第 2 条；其余保留、顺序不变 |
| T6 | `deleteRecordByIndex(file, 0)` | throw 或返回错误（无效 id） |
| T7 | `deleteRecordByIndex(file, 99)` | 无效 id 错误 |
| T8 | `deleteRecordByIndex` 空文件 | 无效 id 错误 |
| T9 | 持锁时另一调用 `deleteRecordByIndex` | 等待或失败行为与 `recordExhausted` 锁策略一致；文件不损坏 |
| T10 | 并发两个 `deleteRecordByIndex` 不同 id | 最终 JSON 合法；两条均被删或一次成功一次 id 失效 |

---

### 5.5 `throttle` 子命令 — `test/cli-throttle-cmd.test.js`

使用 `WRAPPER_CONFIG_DIR` 指向 tmp dir，`spawnSync("node", [mainJs, "throttle", ...])`：

| # | 用例 | 期望 |
|---|------|------|
| C1 | `throttle -l` 无文件 | stdout `No throttle records.`；exit 0 |
| C2 | `throttle --list` 空数组 `[]` | 同上 |
| C3 | `throttle -l` 两条记录 | stdout 行首 `1`、`2`；含 `type=`、`command=`、`startExhausted=`、`endExhausted=` |
| C4 | `command: null` 的记录 | 显示 `command=(default)` |
| C5 | `throttle -d 1` 删第一条 | exit 0；文件剩 1 条；stderr 含 deleted 日志 |
| C6 | `throttle --delete 2` 删第二条 | 同上 |
| C7 | `throttle -d 0` / `-d 99` | stderr 错误；exit 2；文件不变 |
| C8 | `throttle -l -d 1` | 互斥错误；exit 2 |
| C9 | `throttle`（无 flag） | 打印 throttle help；exit 0 |
| C10 | `throttle -d 1` 后再 `-l` | 列表编号重新从 1 连续编号 |
| C11 | `throttle -d 1` 锁被占用（预写 lockfile + 活 pid） | exit 2；记录未删 |
| C12 | `WRAPPER_CONFIG_DIR` 自定义路径 | list/delete 读写该目录下 `throttle.json` |

---

### 5.6 E2E 回归 — 更新现有文件

#### `test/fallback.test.js`

- 所有 `runMain([...])` argv 改为 `["run", ..., "<prompt>"]`（prompt 最后）
- 用例语义与数量不减少（fallback 顺序、exit code、stderr 格式、exclude、quota、timeout 等）

#### `test/throttle-e2e.test.js`

- 所有 `runMain` argv 同上迁移
- 保留全部 10 个场景（默认 throttle、disable、207、fallback、写文件、duration、日志等）

#### 新增 E2E（可并入 `throttle-e2e.test.js` 或 `cli-route.test.js`）

| # | 用例 | 期望 |
|---|------|------|
| E1 | `main()` + `["run", "-t", "claude", "-c", "claude-flash", "hi"]` | 与旧 `-p hi` 行为一致 |
| E2 | `main()` 旧 argv `["-p", "hi"]` | 不进入 run；迁移错误 exit 2 |
| E3 | spawn `throttle -l` 后 `throttle -d 1` 再 `-l` | 端到端文件变化正确 |

---

### 5.7 Smoke — `test/smoke.test.js`

| # | 用例 | 期望 |
|---|------|------|
| M1 | `run "say hi in one word"` | `{ skip: !hasClaude }`；exit 0 |
| M2 | `run -t claude -c claude "say yes"` | 同上 |
| M3 | `run -d "say no"` | debug 日志 |
| M4 | `run -e ZZZZNOMATCHZZZ -r 1 "say hi"` | 非 0 exit |
| M5 | `wrapper -p "hi"`（无 run） | exit 2 迁移错误（**不** skip） |
| M6 | `throttle -l` | exit 0（**不**依赖真实 agent） |

---

### 5.8 测试辅助与导出

为可测性，建议导出（或 `module.exports` 仅供测试）：

- `parseRunArgs` — 自 `src/cli/run.js`，`main.js` re-export
- `routeCli(argv)` — 顶层分发，返回 subcommand 或触发 help/exit
- `runThrottleCommand(argv)` — throttle 子命令入口
- `listRecords`、`deleteRecordByIndex` — 自 `src/throttle.js`

**禁止**：为通过测试而削弱迁移检测（旧 `-p` 必须失败）。

---

### 5.9 验收标准

1. `npm test` 全部通过，无 skip 以外的失败（smoke 中 `hasClaude` skip 保留）。
2. `parseArgs` 相关用例 **0 遗漏**迁移到 `cli-run.test.js`。
3. 新增测试 **≥ 40 条**（R+P+S+T+C+M+E 用例合计），覆盖本 spec 第二至五节全部 CLI 变更点。
4. 每个新建测试文件至少包含 **1 个**失败路径（throw / 非 0 exit）断言。
5. CI 无需改动即可跑通（仍用 `node --test test/` 或现有 `npm test` 脚本）。

---

## 六、文档更新

| 文件 | 更新内容 |
|------|----------|
| `README.md` | 示例改为 `wrapper run` |
| `CLAUDE.md` | CLI 说明与子命令结构 |
| `docs/get-started.md` | 入门示例 |
| `docs/design.md` | CLI 接口章节 |
| `docs/throttle.md` | 示例与「手动清理」改为 `wrapper throttle -l` / `-d` |

---

## 七、非目标

- 不保留顶层 `-p` 或旧 CLI 兼容别名
- 不在 `throttle.json` 增加 `id` 字段
- 不新增除 `run`、`throttle` 以外的子命令
- 不改变 run 执行语义、退出码、provider 行为
