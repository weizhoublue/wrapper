const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const childProcess = require("child_process");

// Wrap spawn before requiring agy provider
const originalSpawn = childProcess.spawn;
let mockSpawnFn = null;
childProcess.spawn = (...args) => {
  if (mockSpawnFn) return mockSpawnFn(...args);
  return originalSpawn(...args);
};

const {
  createSession,
  send,
  closeSession,
  run,
  ensureFlags,
  extractSessionIdFromLog
} = require("../../src/provider/agy");

describe("agy - ensureFlags", () => {
  it("injects log path and required flags", () => {
    const args = ensureFlags([], null, "/tmp/dummy.log");
    assert.ok(args.includes("--log-file"));
    assert.ok(args.includes("/tmp/dummy.log"));
    assert.ok(args.includes("--dangerously-skip-permissions"));
    assert.ok(args.includes("--print"));
  });

  it("injects conversation resume if specified", () => {
    const args = ensureFlags([], "a0b1c2-d3e4", "/tmp/dummy.log");
    assert.ok(args.includes("--conversation"));
    assert.ok(args.includes("a0b1c2-d3e4"));
  });

  it("does not duplicate print mode if already exists", () => {
    const args = ensureFlags(["-p"], null, "/tmp/dummy.log");
    assert.ok(!args.includes("--print"));
  });
});

describe("agy - extractSessionIdFromLog", () => {
  const tempFile = path.join(os.tmpdir(), "agy_test_log.txt");

  it("extracts session ID from Print mode log", () => {
    fs.writeFileSync(tempFile, "Some log before\nPrint mode: conversation=a0b1c2-d3e4-f5a6\nSome log after");
    const id = extractSessionIdFromLog(tempFile);
    assert.strictEqual(id, "a0b1c2-d3e4-f5a6");
    fs.unlinkSync(tempFile);
  });

  it("extracts session ID from Created conversation log", () => {
    fs.writeFileSync(tempFile, "Created conversation a0b1c2-d3e4-f5a6\nMore logs");
    const id = extractSessionIdFromLog(tempFile);
    assert.strictEqual(id, "a0b1c2-d3e4-f5a6");
    fs.unlinkSync(tempFile);
  });

  it("returns null if not found", () => {
    fs.writeFileSync(tempFile, "random log content");
    const id = extractSessionIdFromLog(tempFile);
    assert.strictEqual(id, null);
    fs.unlinkSync(tempFile);
  });
});

describe("agy - createSession", () => {
  it("resolves command absolute path", async () => {
    const session = await createSession({ command: "node", timeout: 10 });
    assert.ok(path.isAbsolute(session.cmd), `Expected absolute path, got ${session.cmd}`);
    assert.strictEqual(session.closed, false);
    assert.strictEqual(session.sessionId, null);
  });

  it("throws error for non-existent command", async () => {
    await assert.rejects(
      createSession({ command: "non-existent-cmd-xyz" }),
      /command not found/
    );
  });
});

describe("agy - send", () => {
  it("constructs arguments dynamically and cleans up logs on close", async () => {
    const session = await createSession({ command: "node", timeout: 10 });
    
    let spawnedArgs = null;
    let spawnedCmd = null;

    mockSpawnFn = (cmd, args, opts) => {
      spawnedCmd = cmd;
      spawnedArgs = args;

      const EventEmitter = require("events");
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      
      fs.writeFileSync(session.logPath, "Created conversation a0b1c2-d3e4-f5a6");

      process.nextTick(() => {
        child.emit("close", 0);
      });

      return child;
    };

    try {
      const result = await send(session, "my prompt");
      assert.ok(spawnedArgs.includes("my prompt"));
      assert.strictEqual(result.sessionId, "a0b1c2-d3e4-f5a6");
      assert.strictEqual(session.sessionId, "a0b1c2-d3e4-f5a6");
      assert.strictEqual(fs.existsSync(session.logPath), false, "log file should be deleted on close");
    } finally {
      mockSpawnFn = null;
      if (fs.existsSync(session.logPath)) {
        fs.unlinkSync(session.logPath);
      }
    }
  });

  it("cleans up log file on error", async () => {
    const session = await createSession({ command: "node", timeout: 10 });
    
    mockSpawnFn = (cmd, args, opts) => {
      const EventEmitter = require("events");
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      
      fs.writeFileSync(session.logPath, "dummy");

      process.nextTick(() => {
        child.emit("error", new Error("spawn error"));
      });

      return child;
    };

    try {
      await assert.rejects(send(session, "my prompt"), /spawn error/);
      assert.strictEqual(fs.existsSync(session.logPath), false, "log file should be deleted on error");
    } finally {
      mockSpawnFn = null;
      if (fs.existsSync(session.logPath)) {
        fs.unlinkSync(session.logPath);
      }
    }
  });
});
