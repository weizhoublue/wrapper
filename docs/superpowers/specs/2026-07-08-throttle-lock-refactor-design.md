# Throttle 锁策略重构设计文档

**日期：** 2026-07-08  
**分支：** feat/throttle  
**状态：** 待实现  
**关联文件：** `src/throttle.js`

---

## 背景

Throttle 是辅助机制，不能因锁的边界问题阻碍 agent 正常调用。**宁愿在边界场景下调用 agent，也不要因 lock 残留或竞争 bug 导致 agent 被永久阻塞。**

当前实现的两个问题：
1. `checkThrottle` 读文件时也加锁，增加不必要的锁竞争——读的准确性可以适当降低
2. 全部重试失败时仍无声无息地继续，不处理残留 lockfile，可能导致后续永远无法获锁

---

## 一、`acquireLock` — 新增 stale lock 自动清除

**当前行为：** 重试 10 次失败后返回 `false`，调用方在无锁状态下继续执行。

**新行为：**

```
重试 10 次（每次间隔 50ms）均失败
  → log.warn("throttle stale lock detected, removing and retrying: %s")
  → fs.unlinkSync(lockFile)（强制删除残留 lockfile）
  → 再尝试 openSync 一次
  → 成功 → 返回 true
  → 仍失败 → log.warn("throttle lock acquisition failed")，返回 false
```

**意图：** 避免因历史遗留 lockfile 导致后续所有调用永久失败。删除后重试保证了 stale lock 只被处理一次，不会无限循环。

---

## 二、`checkThrottle` — 读时无锁，仅写时加锁

**当前行为：** 整个函数全程持锁（读 + 条件写）。

**新行为：**

```
Step 1: 无锁读取 readRecords(throttleFile)
Step 2: 未找到记录 → 直接返回 { throttled: false }
Step 3: 找到记录且 endExhausted > now → 直接返回 { throttled: true, endExhausted }
        （无需写文件，无需加锁）
Step 4: 找到记录且 endExhausted <= now（已过期）：
  4a. acquireLock
  4b. 获锁后再次读取文件（double-check）
  4c. 若该 agent 记录仍存在且仍已过期 → 删除记录，writeRecords
  4d. 若该 agent 记录已被其他进程删除 → 无需写入
  4e. releaseLock（finally 块保证释放）
Step 5: 返回 { throttled: false }
```

**意图：** 纯读路径完全无锁，大幅减少锁竞争。只有"需要修改文件"时才加锁，且加锁后 double-check 避免重复写。读准确性可接受小幅降低（极端情况下读到过期前一刻的状态，会多跳过一次 agent，但下次调用就恢复正常）。

**锁失败时的行为：** 若 `acquireLock` 在过期删除路径上返回 `false`，则跳过删除（残留过期记录），返回 `{ throttled: false }`——不阻塞 agent 调用。

---

## 三、`recordExhausted` — 获锁后 double-check，失败则放弃

**当前行为：** `acquireLock` 失败时仍无锁继续写入。

**新行为：**

```
Step 1: acquireLock
  失败（返回 false）→ log.warn("throttle recordExhausted: lock failed, skipping record")
                    → 直接 return（放弃本次记录，不影响 agent 后续调用）
Step 2: 获锁后再次读取文件（double-check，获取最新状态）
Step 3: 找到记录且 endExhausted > now → 冷却期内，不操作，releaseLock，return
Step 4: 无记录 / 已过期 → 写入新记录，releaseLock
```

**意图：** 锁失败时宁愿放弃本次记录（该次 quota 耗尽不被 throttle），也不冒险无锁写入造成文件损坏。double-check 在获锁后读取，确保写入决策基于最新状态，避免 TOCTOU 问题。

---

## 四、日志规范

| 事件 | 级别 | 消息 |
|------|------|------|
| lockfile 重试（第 2 次起） | `warn` | `throttle lockfile busy, retrying (attempt N/10)` |
| 检测到 stale lock，删除重试 | `warn` | `throttle stale lock detected, removing and retrying: <path>` |
| 全部重试含强删后仍失败 | `warn` | `throttle lock acquisition failed after all retries: <path>` |
| `recordExhausted` 锁失败，放弃记录 | `warn` | `throttle recordExhausted: lock failed, skipping record for <type>/<command>` |
| `checkThrottle` 过期记录清理（无锁读发现过期后的加锁写） | `debug` | `throttle checkThrottle: removing expired record for <type>/<command>` |

---

## 五、测试策略

现有 `test/throttle.test.js` 需更新以下用例：

| 用例 | 变更 |
|------|------|
| `checkThrottle` — 记录已过期 | 验证先无锁读、再加锁写（可通过检查文件被删除来验证结果） |
| `recordExhausted` 锁失败 | 新增：预埋 lockfile → 调用 recordExhausted → 确认文件无变化，函数正常返回 |
| stale lock 自动清除 | 新增：预埋 lockfile（模拟残留）→ 调用 acquireLock（内部 10 次失败后删除）→ 确认最终获锁成功 |
| double-check 一致性 | 新增：并发场景下 checkThrottle 与 recordExhausted 交叉调用，文件最终一致 |
