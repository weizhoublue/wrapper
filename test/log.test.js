const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const os = require("os");

describe("log", () => {
  let tmpFile, log;

  function captureLog(fn) {
    const fd = fs.openSync(tmpFile, "w");
    const origFd = process.stderr.fd;
    process.stderr.fd = fd;
    try { fn(); } finally { process.stderr.fd = origFd; fs.closeSync(fd); }
    return fs.readFileSync(tmpFile, "utf-8");
  }

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `wrapper-test-${Date.now()}.log`);
    delete require.cache[require.resolve("../src/log")];
    log = require("../src/log");
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it("info is silent when debug disabled", () => {
    const output = captureLog(() => log.info("hello %s", "world"));
    assert.strictEqual(output, "");
  });

  it("error is silent when debug disabled", () => {
    const output = captureLog(() => log.error("fail %d", 500));
    assert.strictEqual(output, "");
  });

  it("debug is silent when disabled", () => {
    const output = captureLog(() => log.debug("secret"));
    assert.strictEqual(output, "");
  });

  it("info writes when debug enabled", () => {
    log.setDebug(true);
    const output = captureLog(() => log.info("hello %s", "world"));
    assert.match(output, /\[wrapper\]\[info\]\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] hello world\n/);
  });

  it("error writes when debug enabled", () => {
    log.setDebug(true);
    const output = captureLog(() => log.error("fail %d", 500));
    assert.match(output, /\[wrapper\]\[error\].* fail 500\n/);
  });

  it("debug writes when enabled", () => {
    log.setDebug(true);
    const output = captureLog(() => log.debug("secret %s", "xyz"));
    assert.match(output, /\[wrapper\]\[debug\]\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] secret xyz\n/);
  });

  it("isDebug reflects state", () => {
    assert.strictEqual(log.isDebug(), false);
    log.setDebug(true);
    assert.strictEqual(log.isDebug(), true);
  });

  it("prefix includes agent and session when context set", () => {
    log.setDebug(true);
    log.setContext({ agentName: "codex", attempt: 1, maxAttempts: 3 });
    const output = captureLog(() => log.debug("spawn"));
    assert.match(output, /\[wrapper\]\[debug\]\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\]\[codex\]\[1\/3\] spawn\n/);
  });

  it("prefix uses dash session when attempt not set", () => {
    log.setDebug(true);
    log.setContext({ agentName: "codex" });
    const output = captureLog(() => log.info("trying"));
    assert.match(output, /\[wrapper\]\[info\].*\[codex\]\[-\] trying\n/);
  });

  it("prefix omits agent bracket when no context", () => {
    log.setDebug(true);
    log.clearContext();
    const output = captureLog(() => log.info("wrapper starting"));
    assert.match(output, /\[wrapper\]\[info\]\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}\] wrapper starting\n/);
    assert.doesNotMatch(output, /\[codex\]/);
  });

  it("error level gets context prefix", () => {
    log.setDebug(true);
    log.setContext({ agentName: "codex", attempt: 2, maxAttempts: 3 });
    const output = captureLog(() => log.error("non-zero exit code 1"));
    assert.match(output, /\[wrapper\]\[error\].*\[codex\]\[2\/3\] non-zero exit code 1\n/);
  });
});
