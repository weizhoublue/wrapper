"use strict";
const fs = require("fs");
const path = require("path");
const log = require("./log");

const LOCK_RETRY = 10;
const LOCK_WAIT_MS = 50;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockFile) {
  for (let i = 0; i < LOCK_RETRY; i++) {
    try {
      const fd = fs.openSync(lockFile, "wx");
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (i > 0) {
        log.warn("throttle lockfile busy, retrying (attempt %d/%d)", i + 1, LOCK_RETRY);
      }
      if (i < LOCK_RETRY - 1) sleep(LOCK_WAIT_MS);
    }
  }
  // 全部重试失败 → 尝试删除 stale lockfile 并再试一次
  log.warn("throttle stale lock detected, removing and retrying: %s", lockFile);
  try {
    fs.unlinkSync(lockFile);
    const fd = fs.openSync(lockFile, "wx");
    fs.closeSync(fd);
    return true;
  } catch {
    log.warn("throttle lock acquisition failed after all retries: %s", lockFile);
    return false;
  }
}

function releaseLock(lockFile) {
  try { fs.unlinkSync(lockFile); } catch {}
}

function readRecords(throttleFile) {
  if (!fs.existsSync(throttleFile)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(throttleFile, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeRecords(throttleFile, records) {
  const dir = path.dirname(throttleFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(throttleFile, JSON.stringify(records, null, 2));
}

function matchRecord(r, type, command) {
  return r.type === type && r.command === (command || null);
}

function checkThrottle(type, command, throttleFile) {
  // Step 1: 无锁读取
  const records = readRecords(throttleFile);
  const idx = records.findIndex((r) => matchRecord(r, type, command));

  if (idx === -1) return { throttled: false };

  const record = records[idx];
  const endExhausted = new Date(record.endExhausted);

  if (endExhausted > new Date()) {
    // 冷却期内，无需写文件，直接返回
    return { throttled: true, endExhausted };
  }

  // 已过期 → 加锁后 double-check，再删除
  const lockFile = throttleFile + ".lock";
  const locked = acquireLock(lockFile);
  try {
    const fresh = readRecords(throttleFile);
    const freshIdx = fresh.findIndex((r) => matchRecord(r, type, command));
    if (freshIdx !== -1) {
      const freshEnd = new Date(fresh[freshIdx].endExhausted);
      if (freshEnd <= new Date()) {
        // 仍过期 → 删除
        log.debug("throttle checkThrottle: removing expired record for %s/%s", type, command);
        fresh.splice(freshIdx, 1);
        writeRecords(throttleFile, fresh);
      }
      // 若 freshEnd > new Date()（极罕见：两次读之间被更新），保持不变
    }
    // 若 freshIdx === -1，已被其他进程删除，无需操作
  } finally {
    if (locked) releaseLock(lockFile);
  }

  return { throttled: false };
}

function recordExhausted(type, command, durationMinutes, throttleFile) {
  const lockFile = throttleFile + ".lock";
  const locked = acquireLock(lockFile);
  if (!locked) {
    log.warn("throttle recordExhausted: lock failed, skipping record for %s/%s", type, command);
    return; // 放弃本次记录，不影响 agent 后续调用
  }
  try {
    // 获锁后 double-check，读取最新状态
    const records = readRecords(throttleFile);
    const idx = records.findIndex((r) => matchRecord(r, type, command));
    if (idx !== -1) {
      const existing = records[idx];
      const end = new Date(existing.endExhausted);
      if (end > new Date()) {
        // 冷却期内 → 不操作
        return;
      }
      // 已过期 → 删除旧记录
      records.splice(idx, 1);
    }
    // 写入新记录
    const now = new Date();
    const endExhausted = new Date(now.getTime() + durationMinutes * 60 * 1000);
    records.push({
      type,
      command: command || null,
      startExhausted: now.toISOString(),
      endExhausted: endExhausted.toISOString(),
    });
    writeRecords(throttleFile, records);
  } finally {
    releaseLock(lockFile);
  }
}

module.exports = { checkThrottle, recordExhausted };
