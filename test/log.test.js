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
    assert.match(output, /\[wrapper\]\[info\]\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] hello world\n/);
  });

  it("error writes when debug enabled", () => {
    log.setDebug(true);
    const output = captureLog(() => log.error("fail %d", 500));
    assert.match(output, /\[wrapper\]\[error\].* fail 500\n/);
  });

  it("debug writes when enabled", () => {
    log.setDebug(true);
    const output = captureLog(() => log.debug("secret %s", "xyz"));
    assert.match(output, /\[wrapper\]\[debug\].* secret xyz\n/);
  });

  it("isDebug reflects state", () => {
    assert.strictEqual(log.isDebug(), false);
    log.setDebug(true);
    assert.strictEqual(log.isDebug(), true);
  });
});
