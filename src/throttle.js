"use strict";
const fs = require("fs");
const path = require("path");
const log = require("./log");

const LOCK_RETRY = 10;
const LOCK_WAIT_MS = 50;
const LOCK_STALE_MS = 5 * 60 * 1000;

function toLocalISOString(date) {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const hh = String(Math.floor(absMin / 60)).padStart(2, "0");
  const mm = String(absMin % 60).padStart(2, "0");
  const local = new Date(date.getTime() + offsetMin * 60 * 1000);
  return local.toISOString().replace("Z", `${sign}${hh}:${mm}`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockFile) {
  for (let i = 0; i < LOCK_RETRY; i++) {
    try {
      createLock(lockFile);
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      if (i > 0) {
        log.warn("throttle lockfile busy, retrying (attempt %d/%d)", i + 1, LOCK_RETRY);
      }
      if (i < LOCK_RETRY - 1) sleep(LOCK_WAIT_MS);
    }
  }
  if (!isStaleLock(lockFile)) {
    log.warn("throttle lock acquisition failed after all retries: %s", lockFile);
    return false;
  }

  log.warn("throttle stale lock detected, removing and retrying: %s", lockFile);
  try {
    fs.unlinkSync(lockFile);
    createLock(lockFile);
    return true;
  } catch {
    log.warn("throttle lock acquisition failed after all retries: %s", lockFile);
    return false;
  }
}

function createLock(lockFile) {
  const fd = fs.openSync(lockFile, "wx");
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
  } catch (err) {
    try { fs.unlinkSync(lockFile); } catch {}
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

function isStaleLock(lockFile) {
  let stat;
  try {
    stat = fs.statSync(lockFile);
  } catch {
    return false;
  }

  try {
    const { pid } = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (err) {
        return err.code === "ESRCH";
      }
    }
  } catch {}

  return Date.now() - stat.mtimeMs >= LOCK_STALE_MS;
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
  log.debug("throttle checkThrottle: agent=%s/%s file=%s records=%d",
    type, command || "(default)", throttleFile, records.length);

  const idx = records.findIndex((r) => matchRecord(r, type, command));

  if (idx === -1) {
    log.debug("throttle checkThrottle: no record found for agent=%s/%s, proceeding", type, command || "(default)");
    return { throttled: false };
  }

  const record = records[idx];
  const endExhausted = new Date(record.endExhausted);

  if (endExhausted > new Date()) {
    log.debug("throttle checkThrottle: agent=%s/%s is within cooldown, throttled until %s",
      type, command || "(default)", toLocalISOString(endExhausted));
    return { throttled: true, endExhausted };
  }

  // 已过期 → 加锁后 double-check，再删除
  log.debug("throttle checkThrottle: record expired for agent=%s/%s (end=%s), cleaning up",
    type, command || "(default)", toLocalISOString(endExhausted));
  const lockFile = throttleFile + ".lock";
  const locked = acquireLock(lockFile);
  if (!locked) {
    log.warn("throttle checkThrottle: lock failed, skipping expired record cleanup for %s/%s",
      type, command || "(default)");
    return { throttled: false };
  }
  try {
    const fresh = readRecords(throttleFile);
    const freshIdx = fresh.findIndex((r) => matchRecord(r, type, command));
    if (freshIdx !== -1) {
      const freshEnd = new Date(fresh[freshIdx].endExhausted);
      if (freshEnd <= new Date()) {
        log.debug("throttle checkThrottle: removing expired record for %s/%s", type, command || "(default)");
        fresh.splice(freshIdx, 1);
        writeRecords(throttleFile, fresh);
      }
    }
  } finally {
    releaseLock(lockFile);
  }

  log.debug("throttle checkThrottle: agent=%s/%s cooldown expired, proceeding", type, command || "(default)");
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
      startExhausted: toLocalISOString(now),
      endExhausted: toLocalISOString(endExhausted),
    });
    writeRecords(throttleFile, records);
    log.warn("throttle recordExhausted: agent=%s/%s start=%s end=%s file=%s",
      type, command || "(default)", toLocalISOString(now), toLocalISOString(endExhausted), throttleFile);
  } finally {
    releaseLock(lockFile);
  }
}

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

module.exports = {
  checkThrottle, recordExhausted, toLocalISOString,
  listRecords, deleteRecordByIndex,
};
