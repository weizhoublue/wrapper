# Throttle 功能设计文档

**日期：** 2026-07-08  
**分支：** feat/throttle  
**状态：** 待实现

---

## 概述

当检测到某个 Agent 的 quota 耗尽后，在指定冷却时长内，自动跳过对该 Agent 的调用，避免无效请求。throttle 状态通过全局共享文件持久化，支持多个 wrapper 进程并发读写。

---

## 一、CLI 选项

### 新增选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--disable-throttle` | 关闭 throttle 功能 | throttle 默认开启 |
| `--throttle-duration <分钟>` | 冷却时长，单位分钟 | 30 |

### 行为说明

- **throttle 默认开启**，无需显式传 `--enable-throttle`
- `--disable-throttle` 显式关闭 throttle
- 启用 throttle 时，自动强制开启 `--quota`（等同于传了 `-q`）
- 若同时传入 `--no-quota` 且 throttle 未被 `--disable-throttle` 关闭，报错退出（exit 2）
- `--throttle-duration` 须为正整数，否则报错退出（exit 2）

### 冲突示例

```bash
# 报错：--no-quota 与 throttle 冲突
wrapper -t claude -p "hi" --no-quota

# 正常：关闭 throttle 后可以使用 --no-quota
wrapper -t claude -p "hi" --disable-throttle --no-quota
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `CONFIG_DIR` | 配置目录 | `${HOME}/.wrapper` |

Throttle 文件路径固定为 `${CONFIG_DIR}/throttle.json`，不可通过环境变量覆写。

---

## 二、`throttle.js` 模块

### 文件位置

`src/throttle.js`

### throttle.json 数据格式

```json
[
  {
    "type": "claude",
    "command": "claude-deepseek-flash",
    "startExhausted": "2026-07-08T12:00:00.000Z",
    "endExhausted": "2026-07-08T12:30:00.000Z"
  },
  {
    "type": "codex",
    "command": null,
    "startExhausted": "2026-07-08T12:05:00.000Z",
    "endExhausted": "2026-07-08T12:35:00.000Z"
  }
]
```

- 每个 Agent 由 `type` + `command` 唯一标识
- `command` 为 `null` 表示无 `-c` 选项的 Agent
- 每个 Agent 最多一条记录
- `type + command` 组合区分大小写，精确匹配

### 并发安全（lockfile）

- lock 文件路径：`${CONFIG_DIR}/throttle.json.lock`
- 使用 `fs.openSync(lockPath, 'wx')` 原子创建（`O_EXCL` 语义），确保同一时刻只有一个进程持锁
- 获取锁失败时：重试最多 10 次，每次等待 50ms
- 操作完成后：`fs.unlinkSync(lockPath)` 释放锁
- 异常时：finally 块确保锁一定被释放

### 模块 API

#### `checkThrottle(type, command, throttleFile)`

检查某个 Agent 是否处于 throttle 冷却期。

**返回值：**
- `{ throttled: false }` — 无记录，或记录已过期（过期时自动删除该记录）
- `{ throttled: true, endExhausted: Date }` — 仍在冷却期

**副作用：** 若记录已过期，自动从文件中删除该条记录。

#### `recordExhausted(type, command, durationMinutes, throttleFile)`

记录 Agent quota 耗尽事件。

**逻辑：**
- 无记录 → 写入新记录
- 有记录且已过期 → 删除旧记录，写入新记录
- 有记录且仍在冷却期 → **不操作**，保持原记录不变（不重置计时）

---

## 三、`main.js` 集成

### 参数解析

在现有的 `parseArgs` 中增加：

```js
opts.throttle = true;          // 默认开启
opts.throttleDuration = 30;    // 默认 30 分钟
```

解析 `--disable-throttle` 和 `--throttle-duration <n>`，并检测与 `--no-quota` 的冲突。

### Agent 循环中的两个切入点

#### 切入点 1：调用 Agent 前（`checkThrottle`）

```
for each agent:
  if opts.throttle:
    result = checkThrottle(agent.type, agent.command, throttleFile)
    if result.throttled:
      log.warn("agent %s is throttled until %s, skipping", agent.commandName, result.endExhausted)
      allResults.push({ ..., throttleSkipped: true, wrapperError: "throttled until <time>" })
      if 还有下一个 agent:
        continue   // fallback 到下一个
      else:
        exit 207
```

#### 切入点 2：检测到 quota 耗尽后（`recordExhausted`）

```
// 现有逻辑：isQuotaExceeded() → true
if opts.throttle:
  recordExhausted(agent.type, agent.command, opts.throttleDuration, throttleFile)
  log.warn("agent %s quota exhausted, throttled for %d min until %s", ...)
// 继续原有 fallback 逻辑（不变）
```

### 新增 Exit Code

```js
const EXIT_THROTTLE_SKIP = 207;
```

在 `resolveExitCode` 中加入：
```js
if (result.throttleSkipped) return EXIT_THROTTLE_SKIP;
```

在 `module.exports` 中导出 `EXIT_THROTTLE_SKIP`。

### 日志规范

| 事件 | 级别 | 内容 |
|------|------|------|
| `recordExhausted` 写入 | `warning` | throttle 文件路径、冷却时长（分钟）、截止时间（ISO） |
| `checkThrottle` 命中 | `warning` | agent 名称、冷却截止时间（ISO） |
| lockfile 竞争重试 | `warning` | 重试次数、等待时间 |
| `checkThrottle` 过期记录清理 | `debug` | agent 名称、已过期的 endExhausted |

---

## 四、测试策略

### 单元测试 `test/throttle.test.js`

| 测试用例 | 验证点 |
|---------|--------|
| checkThrottle — 无记录 | 返回 `{ throttled: false }` |
| checkThrottle — 记录未过期 | 返回 `{ throttled: true, endExhausted: <Date> }` |
| checkThrottle — 记录已过期 | 自动删除记录，返回 `{ throttled: false }` |
| recordExhausted — 无记录 | 写入新记录，字段正确 |
| recordExhausted — 已过期 | 删除旧记录，写入新记录，计时从当前时间重新开始 |
| recordExhausted — 冷却期内 | 文件内容不变，原记录 endExhausted 不变 |
| lockfile 并发 | 多个并发调用后文件内容最终一致，无损坏 |
| type+command 唯一性 | `claude/null`、`claude/flash`、`codex/null` 互不影响 |

### 端到端测试 `test/throttle-e2e.test.js`

使用 mock provider（参考现有 `test/fallback.test.js` 模式），通过子进程启动 wrapper 并检查 exit code、stderr、throttle.json 状态。

| 测试用例 | 验证点 |
|---------|--------|
| throttle 默认开启 | 不传 `--disable-throttle`，throttle 功能生效 |
| `--disable-throttle` 关闭 | 不读写 throttle.json，quota 耗尽走原有逻辑 |
| `--no-quota` 与 throttle 冲突 | exit 2，stderr 含冲突提示 |
| 单 agent throttle 命中 | exit 207，stderr 含冷却截止时间 |
| 多 agent fallback + throttle | 第一个被 throttle 跳过，成功调用第二个，exit 0 |
| 所有 agent 均被 throttle | exit 207 |
| quota 耗尽后写 throttle.json | 文件包含正确的 type/command/startExhausted/endExhausted |
| 冷却期结束后恢复调用 | 过期记录被删除，agent 正常调用，exit 0 |
| `--throttle-duration` 非正整数 | exit 2，stderr 含参数错误提示 |

---

## 五、示例

```bash
# 默认开启 throttle，冷却 30 分钟
wrapper -t claude -c "claude-deepseek-flash" -t codex -t copilot \
  -p "say hi in one word"

# 自定义冷却时长为 60 分钟
wrapper -t claude -c "claude-deepseek-flash" -t codex \
  --throttle-duration 60 -p "say hi in one word"

# 关闭 throttle
wrapper -t claude -c "claude-deepseek-flash" \
  --disable-throttle -p "say hi in one word"
```

**调用流程示例（多 agent fallback）：**

1. `checkThrottle(claude, claude-deepseek-flash)` → `{ throttled: false }` → 调用
2. Agent 返回 quota 耗尽 → `recordExhausted(claude, claude-deepseek-flash, 30, ...)` → 写入 throttle.json
3. fallback → `checkThrottle(codex, null)` → `{ throttled: false }` → 调用 codex
4. 下次 wrapper 调用时 → `checkThrottle(claude, claude-deepseek-flash)` → `{ throttled: true, endExhausted: ... }` → 跳过，exit 207 或继续 fallback
