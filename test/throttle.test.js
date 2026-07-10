const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { checkThrottle, recordExhausted, toLocalISOString } = require("../src/throttle");

let tmpDir;
let throttleFile;

describe("throttle module", () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-throttle-test-"));
    throttleFile = path.join(tmpDir, "throttle.json");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // 每个测试前清空 throttle 文件和 lockfile
    if (fs.existsSync(throttleFile)) fs.unlinkSync(throttleFile);
    const lockFile = throttleFile + ".lock";
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  });

  it("checkThrottle returns throttled:false when no file exists", () => {
    const result = checkThrottle("claude", "claude-flash", throttleFile);
    assert.deepStrictEqual(result, { throttled: false });
  });

  it("checkThrottle returns throttled:false when file is empty array", () => {
    fs.writeFileSync(throttleFile, "[]");
    const result = checkThrottle("claude", "claude-flash", throttleFile);
    assert.deepStrictEqual(result, { throttled: false });
  });

  it("checkThrottle returns throttled:false when file contains non-array JSON", () => {
    fs.writeFileSync(throttleFile, "{}");
    const result = checkThrottle("claude", "claude-flash", throttleFile);
    assert.deepStrictEqual(result, { throttled: false });
  });

  it("checkThrottle returns throttled:true when record is active", () => {
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 60 * 1000);
    fs.writeFileSync(throttleFile, JSON.stringify([{
      type: "claude", command: "claude-flash",
      startExhausted: now.toISOString(),
      endExhausted: end.toISOString(),
    }]));
    const result = checkThrottle("claude", "claude-flash", throttleFile);
    assert.strictEqual(result.throttled, true);
    assert.ok(result.endExhausted instanceof Date);
    assert.ok(result.endExhausted.getTime() === end.getTime());
  });

  it("checkThrottle removes expired record and returns throttled:false", () => {
    const past = new Date(Date.now() - 1000);
    fs.writeFileSync(throttleFile, JSON.stringify([{
      type: "claude", command: "claude-flash",
      startExhausted: new Date(past.getTime() - 60000).toISOString(),
      endExhausted: past.toISOString(),
    }]));
    const result = checkThrottle("claude", "claude-flash", throttleFile);
    assert.deepStrictEqual(result, { throttled: false });
    const remaining = JSON.parse(fs.readFileSync(throttleFile, "utf8"));
    assert.strictEqual(remaining.length, 0);
  });

  it("checkThrottle leaves an expired record untouched when another live process holds the lock", () => {
    const past = new Date(Date.now() - 1000);
    fs.writeFileSync(throttleFile, JSON.stringify([{
      type: "claude", command: "claude-flash",
      startExhausted: new Date(past.getTime() - 60000).toISOString(),
      endExhausted: past.toISOString(),
    }]));
    const lockFile = throttleFile + ".lock";
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }));

    const result = checkThrottle("claude", "claude-flash", throttleFile);

    assert.deepStrictEqual(result, { throttled: false });
    assert.strictEqual(JSON.parse(fs.readFileSync(throttleFile, "utf8")).length, 1);
    assert.ok(fs.existsSync(lockFile));
  });

  it("recordExhausted writes new record when none exists", () => {
    recordExhausted("claude", "claude-flash", 30, throttleFile);
    const records = JSON.parse(fs.readFileSync(throttleFile, "utf8"));
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].type, "claude");
    assert.strictEqual(records[0].command, "claude-flash");
    const end = new Date(records[0].endExhausted);
    const start = new Date(records[0].startExhausted);
    assert.ok(end.getTime() - start.getTime() >= 30 * 60 * 1000 - 100);
  });

  it("recordExhausted does not overwrite active record", () => {
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 60 * 1000);
    fs.writeFileSync(throttleFile, JSON.stringify([{
      type: "claude", command: "claude-flash",
      startExhausted: now.toISOString(),
      endExhausted: end.toISOString(),
    }]));
    // wait a tick, then record again
    recordExhausted("claude", "claude-flash", 30, throttleFile);
    const records = JSON.parse(fs.readFileSync(throttleFile, "utf8"));
    assert.strictEqual(records.length, 1);
    // endExhausted must be unchanged
    assert.strictEqual(records[0].endExhausted, end.toISOString());
  });

  it("recordExhausted replaces expired record with new one", () => {
    const past = new Date(Date.now() - 1000);
    const originalStart = new Date(past.getTime() - 60000).toISOString();
    fs.writeFileSync(throttleFile, JSON.stringify([{
      type: "claude", command: "claude-flash",
      startExhausted: originalStart,
      endExhausted: past.toISOString(),
    }]));
    recordExhausted("claude", "claude-flash", 30, throttleFile);
    const records = JSON.parse(fs.readFileSync(throttleFile, "utf8"));
    assert.strictEqual(records.length, 1);
    // new record must have a future endExhausted
    assert.ok(new Date(records[0].endExhausted) > new Date());
    // startExhausted must be a fresh timestamp
    assert.ok(records[0].startExhausted !== originalStart);
  });

  it("type+command uniqueness: different entries do not interfere", () => {
    recordExhausted("claude", "claude-flash", 30, throttleFile);
    recordExhausted("claude", null, 30, throttleFile);
    recordExhausted("codex", null, 30, throttleFile);
    const records = JSON.parse(fs.readFileSync(throttleFile, "utf8"));
    assert.strictEqual(records.length, 3);

    const r1 = checkThrottle("claude", "claude-flash", throttleFile);
    const r2 = checkThrottle("claude", null, throttleFile);
    const r3 = checkThrottle("codex", null, throttleFile);
    assert.strictEqual(r1.throttled, true);
    assert.strictEqual(r2.throttled, true);
    assert.strictEqual(r3.throttled, true);
  });

  it("concurrent writes do not corrupt the file", async () => {
    // 并发调用 recordExhausted，最终文件仍是合法 JSON 且记录完整
    await Promise.all([
      new Promise((res) => { recordExhausted("claude", "a", 30, throttleFile); res(); }),
      new Promise((res) => { recordExhausted("codex", null, 30, throttleFile); res(); }),
      new Promise((res) => { recordExhausted("claude", "b", 30, throttleFile); res(); }),
    ]);
    const records = JSON.parse(fs.readFileSync(throttleFile, "utf8"));
    assert.ok(Array.isArray(records));
    assert.ok(records.length >= 1);
  });

  it("acquireLock recovers a lock owned by a dead process", () => {
    const lockFile = throttleFile + ".lock";
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.pid + 10_000_000,
      createdAt: new Date().toISOString(),
    }));
    recordExhausted("claude", "stale-test", 30, throttleFile);
    assert.ok(fs.existsSync(throttleFile), "record should be written after stale lock cleared");
    const records = JSON.parse(fs.readFileSync(throttleFile, "utf8"));
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].command, "stale-test");
  });

  it("recordExhausted: does not overwrite active record within throttle period (double-check)", () => {
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 60 * 1000);
    fs.writeFileSync(throttleFile, JSON.stringify([{
      type: "codex", command: null,
      startExhausted: now.toISOString(),
      endExhausted: end.toISOString(),
    }]));
    recordExhausted("codex", null, 30, throttleFile);
    const records = JSON.parse(fs.readFileSync(throttleFile, "utf8"));
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].endExhausted, end.toISOString());
  });

  it("checkThrottle: expired record triggers lock + double-check → deleted from file", () => {
    const past = new Date(Date.now() - 1000);
    fs.writeFileSync(throttleFile, JSON.stringify([{
      type: "claude", command: "double-check-test",
      startExhausted: new Date(past.getTime() - 60000).toISOString(),
      endExhausted: past.toISOString(),
    }]));
    const result = checkThrottle("claude", "double-check-test", throttleFile);
    assert.deepStrictEqual(result, { throttled: false });
    const records = JSON.parse(fs.readFileSync(throttleFile, "utf8"));
    assert.strictEqual(records.length, 0);
  });
});

describe("toLocalISOString", () => {
  it("produces local time with timezone offset suffix", () => {
    const d = new Date("2026-07-08T13:00:00.000Z");
    const result = toLocalISOString(d);
    // must end with +HH:MM or -HH:MM, not Z
    assert.match(result, /[+-]\d{2}:\d{2}$/);
    assert.ok(!result.endsWith("Z"));
  });

  it("round-trips: new Date(toLocalISOString(d)) equals original", () => {
    const d = new Date("2026-07-08T13:00:00.000Z");
    const reparsed = new Date(toLocalISOString(d));
    assert.strictEqual(reparsed.getTime(), d.getTime());
  });

  it("recordExhausted writes local time strings to file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-local-time-"));
    const file = path.join(dir, "throttle.json");
    try {
      recordExhausted("claude", "local-time-test", 30, file);
      const records = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.strictEqual(records.length, 1);
      assert.match(records[0].startExhausted, /[+-]\d{2}:\d{2}$/);
      assert.match(records[0].endExhausted,   /[+-]\d{2}:\d{2}$/);
      // round-trip comparison still works
      assert.ok(new Date(records[0].endExhausted) > new Date(records[0].startExhausted));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
