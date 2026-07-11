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

  // T1
  it("listRecords returns [] when file missing", () => {
    assert.deepStrictEqual(listRecords(throttleFile), []);
  });

  // T2
  it("listRecords returns array as-is when file has valid records", () => {
    const records = [
      { type: "codex", command: null, startExhausted: "a", endExhausted: "b" },
      { type: "claude", command: "flash", startExhausted: "c", endExhausted: "d" },
    ];
    fs.writeFileSync(throttleFile, JSON.stringify(records));
    assert.deepStrictEqual(listRecords(throttleFile), records);
  });

  // T3
  it("listRecords returns [] for invalid JSON or non-array", () => {
    fs.writeFileSync(throttleFile, "not json");
    assert.deepStrictEqual(listRecords(throttleFile), []);

    fs.writeFileSync(throttleFile, "{}");
    assert.deepStrictEqual(listRecords(throttleFile), []);
  });

  // T4
  it("deleteRecordByIndex removes first record", () => {
    fs.writeFileSync(throttleFile, JSON.stringify([
      { type: "codex", command: null, startExhausted: "a", endExhausted: "b" },
    ]));
    const deleted = deleteRecordByIndex(throttleFile, 1);
    assert.strictEqual(deleted.type, "codex");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(throttleFile, "utf8")), []);
  });

  // T5
  it("deleteRecordByIndex removes only the targeted record from multiple", () => {
    const records = [
      { type: "codex", command: null, startExhausted: "a", endExhausted: "b" },
      { type: "claude", command: "flash", startExhausted: "c", endExhausted: "d" },
      { type: "opencode", command: "cheap", startExhausted: "e", endExhausted: "f" },
    ];
    fs.writeFileSync(throttleFile, JSON.stringify(records));
    const deleted = deleteRecordByIndex(throttleFile, 2);
    assert.strictEqual(deleted.type, "claude");
    assert.strictEqual(deleted.command, "flash");
    const remaining = JSON.parse(fs.readFileSync(throttleFile, "utf8"));
    assert.strictEqual(remaining.length, 2);
    assert.strictEqual(remaining[0].type, "codex");
    assert.strictEqual(remaining[1].type, "opencode");
  });

  // T6
  it("deleteRecordByIndex throws for id 0", () => {
    fs.writeFileSync(throttleFile, JSON.stringify([
      { type: "codex", command: null, startExhausted: "a", endExhausted: "b" },
    ]));
    assert.throws(
      () => deleteRecordByIndex(throttleFile, 0),
      (err) => err instanceof Error && err.message.includes("no throttle record with id"),
    );
    assert.strictEqual(JSON.parse(fs.readFileSync(throttleFile, "utf8")).length, 1);
  });

  // T7
  it("deleteRecordByIndex throws for out-of-range id", () => {
    fs.writeFileSync(throttleFile, JSON.stringify([
      { type: "codex", command: null, startExhausted: "a", endExhausted: "b" },
    ]));
    assert.throws(
      () => deleteRecordByIndex(throttleFile, 99),
      (err) => err instanceof Error && err.message.includes("no throttle record with id 99"),
    );
    assert.strictEqual(JSON.parse(fs.readFileSync(throttleFile, "utf8")).length, 1);
  });

  // T8
  it("deleteRecordByIndex throws when file is empty", () => {
    fs.writeFileSync(throttleFile, "[]");
    assert.throws(
      () => deleteRecordByIndex(throttleFile, 1),
      (err) => err instanceof Error && err.message.includes("no throttle record with id"),
    );
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(throttleFile, "utf8")), []);
  });

  // T9
  it("deleteRecordByIndex fails when lock is held and does not corrupt file", () => {
    fs.writeFileSync(throttleFile, JSON.stringify([
      { type: "codex", command: null, startExhausted: "a", endExhausted: "b" },
    ]));
    const lockFile = throttleFile + ".lock";
    fs.writeFileSync(lockFile, JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }));

    assert.throws(
      () => deleteRecordByIndex(throttleFile, 1),
      (err) => err instanceof Error && err.message.toLowerCase().includes("lock"),
    );
    assert.strictEqual(JSON.parse(fs.readFileSync(throttleFile, "utf8")).length, 1);
    assert.ok(fs.existsSync(lockFile));
  });

  // T10
  it("concurrent deleteRecordByIndex calls produce valid JSON", async () => {
    fs.writeFileSync(throttleFile, JSON.stringify([
      { type: "codex", command: null, startExhausted: "a", endExhausted: "b" },
      { type: "claude", command: "flash", startExhausted: "c", endExhausted: "d" },
    ]));

    const results = await Promise.allSettled([
      Promise.resolve().then(() => deleteRecordByIndex(throttleFile, 1)),
      Promise.resolve().then(() => deleteRecordByIndex(throttleFile, 2)),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.ok(fulfilled.length >= 1, "at least one delete should succeed");
    assert.strictEqual(fulfilled.length + rejected.length, 2);

    const remaining = JSON.parse(fs.readFileSync(throttleFile, "utf8"));
    assert.ok(Array.isArray(remaining));
    assert.ok(remaining.length <= 1);
    if (rejected.length === 1) {
      assert.ok(rejected[0].reason.message.includes("no throttle record with id"));
    }
  });
});
