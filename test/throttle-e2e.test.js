"use strict";
const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ── Mock providers ──────────────────────────────────────────────────
const providerNames = ["claude", "codex", "copilot", "gemini", "cursor", "opencode", "agy"];
const mockProviders = {};
for (const p of providerNames) {
  const pPath = path.resolve(__dirname, "..", "src", "provider", `${p}.js`);
  mockProviders[p] = {
    createSession: async () => ({ sessionId: `mock-${p}` }),
    send: async () => ({ stdout: `mock-stdout-${p}`, stderr: "", exitCode: 0 }),
    closeSession: async () => {},
  };
  require.cache[pPath] = { id: pPath, filename: pPath, loaded: true, exports: mockProviders[p] };
}

// ── Require after mock ──────────────────────────────────────────────
const log = require("../src/log");
const {
  main,
  EXIT_OK,
  EXIT_QUOTA_EXCEEDED,
  EXIT_THROTTLE_SKIP,
} = require("../src/main");

// ── Helpers ─────────────────────────────────────────────────────────
let tmpDir;
let throttleFile;
let originalExit, originalStdout, originalStderr, originalArgv, originalWriteSync;
let originalEnv, originalPath;
let exitCode, stdoutData, stderrData;

describe("throttle E2E", () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-throttle-e2e-"));
    throttleFile = path.join(tmpDir, "throttle.json");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    log.setDebug(false);
    // reset mocks
    for (const p of providerNames) {
      mockProviders[p].createSession = async () => ({ sessionId: `mock-${p}` });
      mockProviders[p].send = async () => ({ stdout: `mock-stdout-${p}`, stderr: "", exitCode: 0 });
      mockProviders[p].closeSession = async () => {};
    }
    // clean throttle file
    if (fs.existsSync(throttleFile)) fs.unlinkSync(throttleFile);
    const lockFile = throttleFile + ".lock";
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);

    // redirect WRAPPER_CONFIG_DIR to tmp
    originalEnv = process.env.WRAPPER_CONFIG_DIR;
    process.env.WRAPPER_CONFIG_DIR = tmpDir;

    // stub claude-flash on PATH for custom -c validation
    const binDir = path.join(tmpDir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const stub = path.join(binDir, "claude-flash");
    fs.writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(stub, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;

    originalExit = process.exit;
    originalStdout = process.stdout.write;
    originalStderr = process.stderr.write;
    originalArgv = process.argv;
    originalWriteSync = fs.writeSync;
    exitCode = null; stdoutData = ""; stderrData = "";

    process.exit = (code) => { exitCode = code; throw new Error(`ProcessExited:${code}`); };
    process.stdout.write = (c) => { stdoutData += c; };
    process.stderr.write = (c) => { stderrData += c; };
    fs.writeSync = (fd, c, ...a) => {
      if (fd === 2) stderrData += String(c);
      return originalWriteSync(fd, c, ...a);
    };
  });

  afterEach(() => {
    process.exit = originalExit;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    process.argv = originalArgv;
    fs.writeSync = originalWriteSync;
    if (originalEnv === undefined) delete process.env.WRAPPER_CONFIG_DIR;
    else process.env.WRAPPER_CONFIG_DIR = originalEnv;
    process.env.PATH = originalPath;
  });

  async function runMain(args) {
    process.argv = ["node", "main.js", ...args];
    try { await main(); } catch (e) {
      if (!e.message.startsWith("ProcessExited")) throw e;
    }
  }

  // ── Tests ────────────────────────────────────────────────────────

  it("throttle is on by default and does not interfere when no quota exhausted", async () => {
    await runMain(["-t", "claude", "-c", "claude-flash", "-p", "hi"]);
    assert.strictEqual(exitCode, EXIT_OK);
    assert.ok(stdoutData.includes("mock-stdout-claude"));
    assert.ok(!fs.existsSync(throttleFile));
  });

  it("--enable-throttle false skips throttle check even after quota exhausted", async () => {
    // seed an active throttle record
    fs.writeFileSync(throttleFile, JSON.stringify([{
      type: "claude", command: "claude-flash",
      startExhausted: new Date().toISOString(),
      endExhausted: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }]));
    await runMain(["-t", "claude", "-c", "claude-flash", "--enable-throttle", "false", "-p", "hi"]);
    // should call the agent normally (mock returns success)
    assert.strictEqual(exitCode, EXIT_OK);
  });

  it("agent throttled → exit 207 when only one agent", async () => {
    fs.writeFileSync(throttleFile, JSON.stringify([{
      type: "claude", command: "claude-flash",
      startExhausted: new Date().toISOString(),
      endExhausted: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }]));
    await runMain(["-t", "claude", "-c", "claude-flash", "-p", "hi"]);
    assert.strictEqual(exitCode, EXIT_THROTTLE_SKIP);
    assert.ok(stderrData.includes("throttled"));
  });

  it("first agent throttled → fallback to second agent → exit 0", async () => {
    fs.writeFileSync(throttleFile, JSON.stringify([{
      type: "claude", command: "claude-flash",
      startExhausted: new Date().toISOString(),
      endExhausted: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }]));
    await runMain(["-t", "claude", "-c", "claude-flash", "-t", "codex", "-p", "hi"]);
    assert.strictEqual(exitCode, EXIT_OK);
    assert.ok(stdoutData.includes("mock-stdout-codex"));
  });

  it("all agents throttled → exit 207", async () => {
    fs.writeFileSync(throttleFile, JSON.stringify([
      { type: "claude", command: "claude-flash",
        startExhausted: new Date().toISOString(),
        endExhausted: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
      { type: "codex", command: null,
        startExhausted: new Date().toISOString(),
        endExhausted: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
    ]));
    await runMain(["-t", "claude", "-c", "claude-flash", "-t", "codex", "-p", "hi"]);
    assert.strictEqual(exitCode, EXIT_THROTTLE_SKIP);
  });

  it("quota exhausted → writes throttle record to file", async () => {
    mockProviders.claude.send = async () => ({
      stdout: "FreeUsageLimitError: quota exceeded",
      stderr: "",
      exitCode: 1,
    });
    await runMain(["-t", "claude", "-c", "claude-flash", "-p", "hi"]);
    assert.strictEqual(exitCode, EXIT_QUOTA_EXCEEDED);
    assert.ok(fs.existsSync(throttleFile));
    const records = JSON.parse(fs.readFileSync(throttleFile, "utf8"));
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].type, "claude");
    assert.strictEqual(records[0].command, "claude-flash");
    assert.ok(new Date(records[0].endExhausted) > new Date());
  });

  it("--enable-throttle false: quota exhausted does not write throttle.json", async () => {
    mockProviders.claude.send = async () => ({
      stdout: "FreeUsageLimitError: quota exceeded",
      stderr: "",
      exitCode: 1,
    });
    await runMain(["-t", "claude", "-c", "claude-flash", "--enable-throttle", "false", "-p", "hi"]);
    // quota exhausted exit code (206 or similar) but no throttle file written
    assert.ok(!fs.existsSync(throttleFile));
  });

  it("throttle record expires → agent is called normally", async () => {
    // expired record
    fs.writeFileSync(throttleFile, JSON.stringify([{
      type: "claude", command: "claude-flash",
      startExhausted: new Date(Date.now() - 60000).toISOString(),
      endExhausted: new Date(Date.now() - 1000).toISOString(),
    }]));
    await runMain(["-t", "claude", "-c", "claude-flash", "-p", "hi"]);
    assert.strictEqual(exitCode, EXIT_OK);
    assert.ok(stdoutData.includes("mock-stdout-claude"));
    // expired record should be removed
    const records = JSON.parse(fs.readFileSync(throttleFile, "utf8"));
    assert.strictEqual(records.length, 0);
  });

  it("--throttle-duration controls record end time", async () => {
    mockProviders.claude.send = async () => ({
      stdout: "FreeUsageLimitError: quota exceeded",
      stderr: "",
      exitCode: 1,
    });
    await runMain(["-t", "claude", "-c", "claude-flash", "--throttle-duration", "60", "-p", "hi"]);
    const records = JSON.parse(fs.readFileSync(throttleFile, "utf8"));
    const diffMin = (new Date(records[0].endExhausted) - new Date(records[0].startExhausted)) / 60000;
    assert.ok(diffMin >= 59.9 && diffMin <= 60.1);
  });

  it("warning log emitted when throttle record written", async () => {
    mockProviders.claude.send = async () => ({
      stdout: "FreeUsageLimitError: quota exceeded",
      stderr: "",
      exitCode: 1,
    });
    log.setDebug(true);
    await runMain(["-t", "claude", "-c", "claude-flash", "-p", "hi"]);
    assert.ok(stderrData.includes("throttle") || stderrData.includes("throttled"));
  });
});
