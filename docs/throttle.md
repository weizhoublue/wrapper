# Throttle 功能说明

当检测到某个 Agent 的 quota 耗尽后，在指定冷却时长内，wrapper 自动跳过对该 Agent 的调用，避免无效请求浪费时间。冷却状态写入本地共享文件，多个 wrapper 进程共享同一份状态。

---

## 启用与关闭

Throttle **默认开启**，无需额外参数。

```bash
# 默认开启（等效于 --enable-throttle true）
wrapper run -t claude -c "claude-deepseek-flash" -t codex "say hi"

# 关闭 throttle
wrapper run -t claude -c "claude-deepseek-flash" -t codex --enable-throttle false "say hi"
```

---

## 选项说明

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--enable-throttle <true\|false>` | 开启或关闭 throttle 功能 | `true` |
| `--throttle-duration <分钟>` | quota 耗尽后的冷却时长（分钟） | `120` |

### 与 `--no-quota` 的冲突

Throttle 依赖 quota 检测机制（`--quota`）。启用 throttle 时若同时传入 `--no-quota`，wrapper 报错退出（exit 2）：

```bash
# 报错退出
wrapper run -t claude "hi" --no-quota

# 正常：先关闭 throttle，再关闭 quota
wrapper run -t claude "hi" --enable-throttle false --no-quota
```

---

## 工作机制

### 冷却状态文件

Throttle 状态保存在 `${WRAPPER_CONFIG_DIR}/throttle.json`（`WRAPPER_CONFIG_DIR` 默认为 `~/.wrapper`）。

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

每个 Agent 由 `type`（如 `claude`、`codex`）和 `command`（`-c` 指定的命令名，无 `-c` 时为 `null`）唯一标识，文件中每个 Agent 最多一条记录。

### 调用流程

```
wrapper 启动
  │
  ├─ 对每个 Agent，调用前先检查 throttle.json
  │     │
  │     ├─ 无记录 → 正常调用 Agent
  │     │
  │     ├─ 有记录且冷却期未结束
  │     │     └─ 跳过该 Agent（记录 throttleSkipped）
  │     │          ├─ 还有下一个 Agent → fallback 继续
  │     │          └─ 没有更多 Agent → exit 207
  │     │
  │     └─ 有记录但冷却期已结束
  │           └─ 删除过期记录 → 正常调用 Agent
  │
  └─ Agent 调用结束
        │
        └─ quota 耗尽检测（isQuotaExceeded）触发
              │
              ├─ throttle.json 中无该 Agent 记录 → 写入新记录
              ├─ 有记录且已过期 → 覆盖为新记录
              └─ 有记录且冷却期内 → 不操作（不重置计时）
```

### 多进程并发安全

多个 wrapper 进程同时读写 `throttle.json` 时，使用 `throttle.json.lock` 文件做互斥锁（`O_EXCL` 原子创建）。获取锁失败时最多重试 10 次，每次间隔 50ms。

---

## Exit Code

| Code | 含义 |
|------|------|
| `206` | Agent quota 耗尽（真实调用触发） |
| `207` | 所有可用 Agent 均被 throttle 跳过 |

---

## 示例场景

### 场景一：多 Agent fallback + throttle

```bash
wrapper run -t claude -c "claude-deepseek-flash" -t codex -t copilot \
  --throttle-duration 30 "say hi in one word"
```

**第一次调用：**
1. 检查 throttle.json → `claude/claude-deepseek-flash` 无记录 → 调用
2. 返回 quota 耗尽（exit 206）→ 写入 throttle.json，冷却至 +30 分钟
3. fallback → 检查 `codex/null` 无记录 → 调用 codex
4. codex 成功 → exit 0，输出结果

**30 分钟内再次调用：**
1. 检查 throttle.json → `claude/claude-deepseek-flash` 冷却期内 → 跳过（warning 日志）
2. 检查 `codex/null` 无记录 → 调用 codex

### 场景二：所有 Agent 均被 throttle

```bash
wrapper run -t claude -c "claude-deepseek-flash" "say hi"
```

若 `claude-deepseek-flash` 处于冷却期：

```
[wrapper][warning] agent claude-deepseek-flash is throttled until 2026-07-08T12:30:00.000Z, skipping
exit 207
```

### 场景三：冷却期结束后自动恢复

冷却截止时间到达后，下次调用时 wrapper 自动删除过期记录并恢复正常调用，无需任何手动操作。

---

## 日志示例

```
# quota 耗尽，写入 throttle 记录
[wrapper][warning][...] agent claude-deepseek-flash quota exhausted, throttle recorded: ~/.wrapper/throttle.json, duration=30min, until=2026-07-08T12:30:00.000Z

# 下次调用命中 throttle
[wrapper][warning][...] agent claude-deepseek-flash is throttled until 2026-07-08T12:30:00.000Z, skipping

# lockfile 竞争
[wrapper][warning][...] throttle lockfile busy, retrying (attempt 2/10)
```

---

## 手动清理

```bash
# 查看当前 throttle 状态（推荐）
wrapper throttle -l
# 首行为 throttle.json 绝对路径，例如：
# /Users/you/.wrapper/throttle.json
# No throttle records.

# 按列表编号删除（1-based）
wrapper throttle -d 1

# 或直接编辑文件
cat ~/.wrapper/throttle.json
echo '[]' > ~/.wrapper/throttle.json
```
