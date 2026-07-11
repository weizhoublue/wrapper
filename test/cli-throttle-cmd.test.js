"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");

const mainJs = path.join(__dirname, "..", "src", "main.js");
let tmpDir;

function throttleFile(dir = tmpDir) {
  return path.join(dir, "throttle.json");
}

function expectedThrottlePath(dir = tmpDir) {
  return path.resolve(throttleFile(dir));
}

function lockFile(dir = tmpDir) {
  return path.join(dir, "throttle.json.lock");
}

function writeRecords(records, dir = tmpDir) {
  fs.writeFileSync(throttleFile(dir), JSON.stringify(records));
}

describe("cli throttle command", () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-cli-throttle-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const tf = throttleFile();
    if (fs.existsSync(tf)) fs.unlinkSync(tf);
    const lf = lockFile();
    if (fs.existsSync(lf)) fs.unlinkSync(lf);
  });

  function run(args, env = {}) {
    return spawnSync("node", [mainJs, "throttle", ...args], {
      encoding: "utf8",
      env: { ...process.env, WRAPPER_CONFIG_DIR: tmpDir, ...env },
    });
  }

  it("C1: list empty when file missing", () => {
    const r = run(["-l"]);
    assert.strictEqual(r.status, 0);
    const lines = r.stdout.trimEnd().split("\n");
    assert.strictEqual(lines[0], expectedThrottlePath());
    assert.strictEqual(lines[1], "No throttle records.");
  });

  it("C2: --list with empty array", () => {
    writeRecords([]);
    const r = run(["--list"]);
    assert.strictEqual(r.status, 0);
    const lines = r.stdout.trimEnd().split("\n");
    assert.strictEqual(lines[0], expectedThrottlePath());
    assert.strictEqual(lines[1], "No throttle records.");
  });

  it("C3: list two records with expected format", () => {
    writeRecords([
      { type: "opencode", command: "opencode-cheap", startExhausted: "2026-07-08T12:00:00+08:00", endExhausted: "2026-07-08T14:00:00+08:00" },
      { type: "codex", command: "codex-fast", startExhausted: "2026-07-09T10:00:00+08:00", endExhausted: "2026-07-09T12:00:00+08:00" },
    ]);
    const r = run(["-l"]);
    assert.strictEqual(r.status, 0);
    const lines = r.stdout.trimEnd().split("\n");
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[0], expectedThrottlePath());
    assert.match(lines[1], /^1  type=opencode  command=opencode-cheap  startExhausted=/);
    assert.match(lines[1], /endExhausted=/);
    assert.match(lines[2], /^2  type=codex  command=codex-fast  startExhausted=/);
    assert.match(lines[2], /endExhausted=/);
  });

  it("C4: null command shows (default)", () => {
    writeRecords([
      { type: "claude", command: null, startExhausted: "a", endExhausted: "b" },
    ]);
    const r = run(["-l"]);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /command=\(default\)/);
  });

  it("C5: delete first record", () => {
    writeRecords([
      { type: "codex", command: "x", startExhausted: "a", endExhausted: "b" },
      { type: "claude", command: null, startExhausted: "c", endExhausted: "d" },
    ]);
    const r = run(["-d", "1"]);
    assert.strictEqual(r.status, 0);
    const left = JSON.parse(fs.readFileSync(throttleFile(), "utf8"));
    assert.strictEqual(left.length, 1);
    assert.strictEqual(left[0].type, "claude");
    assert.match(r.stderr, new RegExp(`^${expectedThrottlePath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
    assert.match(r.stderr, /deleted throttle record id=1 type=codex command=x/);
  });

  it("C6: --delete second record", () => {
    writeRecords([
      { type: "codex", command: "x", startExhausted: "a", endExhausted: "b" },
      { type: "claude", command: "flash", startExhausted: "c", endExhausted: "d" },
    ]);
    const r = run(["--delete", "2"]);
    assert.strictEqual(r.status, 0);
    const left = JSON.parse(fs.readFileSync(throttleFile(), "utf8"));
    assert.strictEqual(left.length, 1);
    assert.strictEqual(left[0].type, "codex");
    assert.match(r.stderr, new RegExp(`^${expectedThrottlePath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n`));
    assert.match(r.stderr, /deleted throttle record id=2 type=claude command=flash/);
  });

  it("C7a: delete id 0 is invalid", () => {
    writeRecords([
      { type: "codex", command: null, startExhausted: "a", endExhausted: "b" },
    ]);
    const r = run(["-d", "0"]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /no throttle record with id 0/);
    assert.strictEqual(JSON.parse(fs.readFileSync(throttleFile(), "utf8")).length, 1);
  });

  it("C7b: delete id 99 is invalid", () => {
    writeRecords([
      { type: "codex", command: null, startExhausted: "a", endExhausted: "b" },
    ]);
    const r = run(["-d", "99"]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /no throttle record with id 99/);
    assert.strictEqual(JSON.parse(fs.readFileSync(throttleFile(), "utf8")).length, 1);
  });

  it("C8: list and delete are mutually exclusive", () => {
    writeRecords([
      { type: "codex", command: null, startExhausted: "a", endExhausted: "b" },
    ]);
    const r = run(["-l", "-d", "1"]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /mutually exclusive/);
    assert.strictEqual(JSON.parse(fs.readFileSync(throttleFile(), "utf8")).length, 1);
  });

  it("C9: no flags shows throttle help", () => {
    const r = run([]);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /wrapper throttle/);
    assert.match(r.stdout, /--list/);
    assert.match(r.stdout, /--delete/);
  });

  it("C10: list renumbers after delete", () => {
    writeRecords([
      { type: "codex", command: "x", startExhausted: "a", endExhausted: "b" },
      { type: "claude", command: null, startExhausted: "c", endExhausted: "d" },
    ]);
    const del = run(["-d", "1"]);
    assert.strictEqual(del.status, 0);
    const list = run(["-l"]);
    assert.strictEqual(list.status, 0);
    const lines = list.stdout.trimEnd().split("\n");
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0], expectedThrottlePath());
    assert.match(lines[1], /^1  type=claude  command=\(default\)/);
  });

  it("C11: delete fails when lock is held", () => {
    writeRecords([
      { type: "codex", command: null, startExhausted: "a", endExhausted: "b" },
    ]);
    fs.writeFileSync(lockFile(), JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
    }));
    const r = run(["-d", "1"]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /lock/i);
    assert.strictEqual(JSON.parse(fs.readFileSync(throttleFile(), "utf8")).length, 1);
  });

  it("C12: WRAPPER_CONFIG_DIR custom path", () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-cli-throttle-custom-"));
    try {
      writeRecords([
        { type: "opencode", command: "cheap", startExhausted: "s", endExhausted: "e" },
      ], customDir);

      const list = spawnSync("node", [mainJs, "throttle", "-l"], {
        encoding: "utf8",
        env: { ...process.env, WRAPPER_CONFIG_DIR: customDir },
      });
      assert.strictEqual(list.status, 0);
      assert.strictEqual(list.stdout.trimEnd().split("\n")[0], expectedThrottlePath(customDir));
      assert.match(list.stdout, /type=opencode  command=cheap/);

      const del = spawnSync("node", [mainJs, "throttle", "-d", "1"], {
        encoding: "utf8",
        env: { ...process.env, WRAPPER_CONFIG_DIR: customDir },
      });
      assert.strictEqual(del.status, 0);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(throttleFile(customDir), "utf8")), []);
    } finally {
      fs.rmSync(customDir, { recursive: true, force: true });
    }
  });
});
