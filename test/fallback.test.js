const { describe, it, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Mock the providers
const providers = ["claude", "codex", "copilot", "gemini", "cursor", "opencode"];
const mockProviders = {};

for (const p of providers) {
  const pPath = path.resolve(__dirname, "..", "src", "provider", `${p}.js`);
  mockProviders[p] = {
    createSession: async (opts) => {
      if (mockProviders[p].createSessionMock) {
        return mockProviders[p].createSessionMock(opts);
      }
      return { sessionId: `mock-session-${p}` };
    },
    send: async (session, prompt) => {
      if (mockProviders[p].sendMock) {
        return mockProviders[p].sendMock(session, prompt);
      }
      return { stdout: `mock-stdout-${p}`, stderr: "", sessionId: session.sessionId, exitCode: 0 };
    },
    closeSession: async (session) => {
      if (mockProviders[p].closeSessionMock) {
        return mockProviders[p].closeSessionMock(session);
      }
    }
  };
  require.cache[pPath] = {
    id: pPath,
    filename: pPath,
    loaded: true,
    exports: mockProviders[p]
  };
}

// Require main after mocking providers
const log = require("../src/log");
const { main, EXIT_OK, EXIT_TIMEOUT, EXIT_PROVIDER_ERROR, EXIT_COMMAND_NOT_FOUND, EXIT_EXCLUDE_MATCH, EXIT_REGEX_MISMATCH, EXIT_QUOTA_EXCEEDED } = require("../src/main");


describe("multi-agent fallback E2E", () => {
  let tmpDir;
  let originalConfigDir;
  let originalExit;
  let originalWrite;
  let originalErrWrite;
  let originalArgv;
  let originalWriteSync;

  let exitCode = null;
  let stdoutData = "";
  let stderrData = "";

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-fallback-e2e-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    log.setDebug(false);
    originalConfigDir = process.env.WRAPPER_CONFIG_DIR;
    process.env.WRAPPER_CONFIG_DIR = tmpDir;
    const throttleFile = path.join(tmpDir, "throttle.json");
    if (fs.existsSync(throttleFile)) fs.unlinkSync(throttleFile);
    const lockFile = throttleFile + ".lock";
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);

    // Reset provider mocks
    for (const p of providers) {
      mockProviders[p].createSessionMock = null;
      mockProviders[p].sendMock = null;
      mockProviders[p].closeSessionMock = null;
    }

    originalExit = process.exit;
    originalWrite = process.stdout.write;
    originalErrWrite = process.stderr.write;
    originalArgv = process.argv;
    originalWriteSync = fs.writeSync;

    exitCode = null;
    stdoutData = "";
    stderrData = "";

    process.exit = (code) => {
      exitCode = code;
      throw new Error(`ProcessExited: ${code}`);
    };

    process.stdout.write = (chunk) => {
      stdoutData += chunk;
    };

    process.stderr.write = (chunk) => {
      stderrData += chunk;
    };

    fs.writeSync = (fd, chunk, ...args) => {
      if (fd === process.stderr.fd || fd === 2) {
        stderrData += String(chunk);
      }
      return originalWriteSync(fd, chunk, ...args);
    };
  });

  afterEach(() => {
    process.exit = originalExit;
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrWrite;
    process.argv = originalArgv;
    fs.writeSync = originalWriteSync;
    if (originalConfigDir === undefined) delete process.env.WRAPPER_CONFIG_DIR;
    else process.env.WRAPPER_CONFIG_DIR = originalConfigDir;
  });

  async function runMain(args) {
    process.argv = ["node", "main.js", ...args];
    try {
      await main();
    } catch (err) {
      if (!err.message.startsWith("ProcessExited")) {
        throw err;
      }
    }
  }

  it("first agent succeeds, subsequent agents are ignored", async () => {
    let copilotCalled = false;
    mockProviders.copilot.createSessionMock = () => {
      copilotCalled = true;
      return { sessionId: "copilot-session" };
    };

    await runMain(["-t", "claude", "-t", "copilot", "-p", "hello"]);

    assert.strictEqual(exitCode, 0);
    assert.ok(stdoutData.includes("mock-stdout-claude"));
    assert.strictEqual(copilotCalled, false);
    // Stderr should print the last session's final details
    assert.ok(stderrData.includes("claude"));
    assert.ok(stderrData.includes("mock-session-claude"));
  });

  it("first agent fails session creation, second agent succeeds", async () => {
    mockProviders.claude.createSessionMock = () => {
      throw new Error("command not found: claude");
    };

    await runMain(["-t", "claude", "-t", "copilot", "-p", "hello"]);

    assert.strictEqual(exitCode, 0);
    assert.ok(stdoutData.includes("mock-stdout-copilot"));
    assert.ok(!stderrData.includes("[claude] error:"));
    assert.ok(!stderrData.includes("session creation failed: command not found: claude"));
    assert.ok(stderrData.endsWith("[agent session]\n0\ncopilot\nmock-session-copilot\n"));
  });

  it("first agent fails provider send, second agent succeeds", async () => {
    mockProviders.claude.sendMock = () => {
      throw new Error("send error");
    };

    await runMain(["-t", "claude", "-t", "copilot", "-p", "hello"]);

    assert.strictEqual(exitCode, 0);
    assert.ok(stdoutData.includes("mock-stdout-copilot"));
    assert.ok(!stderrData.includes("[claude] error:"));
    assert.ok(!stderrData.includes("provider send failed: send error"));
    assert.ok(stderrData.endsWith("[agent session]\n0\ncopilot\nmock-session-copilot\n"));
  });

  it("first agent times out, second agent succeeds", async () => {
    mockProviders.claude.sendMock = (session) => {
      return { stdout: "timeout output", stderr: "timeout stderr", sessionId: session.sessionId, exitCode: 1, timedOut: true };
    };

    await runMain(["-t", "claude", "-t", "copilot", "-p", "hello"]);

    assert.strictEqual(exitCode, 0);
    assert.ok(stdoutData.includes("mock-stdout-copilot"));
    assert.ok(!stderrData.includes("timeout output"));
    assert.ok(!stderrData.includes("timeout stderr"));
    assert.ok(!stderrData.includes("[claude] error:"));
    assert.ok(stderrData.endsWith("[agent session]\n0\ncopilot\nmock-session-copilot\n"));
  });

  it("first agent exits with non-zero code, second agent succeeds", async () => {
    mockProviders.claude.sendMock = (session) => {
      return { stdout: "fail output", stderr: "fail stderr", sessionId: session.sessionId, exitCode: 5, timedOut: false };
    };

    await runMain(["-t", "claude", "-t", "copilot", "-p", "hello"]);

    assert.strictEqual(exitCode, 0);
    assert.ok(stdoutData.includes("mock-stdout-copilot"));
    assert.ok(!stderrData.includes("fail output"));
    assert.ok(!stderrData.includes("fail stderr"));
    assert.ok(!stderrData.includes("[claude] error:"));
    assert.ok(stderrData.endsWith("[agent session]\n0\ncopilot\nmock-session-copilot\n"));
  });

  it("all agents fail session creation", async () => {
    mockProviders.claude.createSessionMock = () => {
      throw new Error("command not found: claude");
    };
    mockProviders.copilot.createSessionMock = () => {
      throw new Error("session failed");
    };

    await runMain(["-t", "claude", "-t", "copilot", "-p", "hello"]);

    assert.strictEqual(exitCode, EXIT_PROVIDER_ERROR);
    assert.ok(!stderrData.includes("[claude] error:"));
    assert.ok(stderrData.includes("[copilot] error:"));
    assert.ok(stderrData.includes("session creation failed: session failed"));
    assert.ok(stderrData.endsWith("[agent session]\n202\ncopilot\n"));
  });

  it("all agents fail provider send", async () => {
    mockProviders.claude.sendMock = () => {
      throw new Error("send fail 1");
    };
    mockProviders.copilot.sendMock = () => {
      throw new Error("send fail 2");
    };

    await runMain(["-t", "claude", "-t", "copilot", "-p", "hello"]);

    assert.strictEqual(exitCode, EXIT_PROVIDER_ERROR);
    assert.ok(!stderrData.includes("[claude] error:"));
    assert.ok(!stderrData.includes("provider send failed: send fail 1"));
    assert.ok(stderrData.includes("[copilot] error:"));
    assert.ok(stderrData.includes("provider send failed: send fail 2"));
  });

  it("all agents time out", async () => {
    mockProviders.claude.sendMock = (session) => {
      return { stdout: "out 1", stderr: "err 1", sessionId: session.sessionId, exitCode: 1, timedOut: true };
    };
    mockProviders.copilot.sendMock = (session) => {
      return { stdout: "out 2", stderr: "err 2", sessionId: session.sessionId, exitCode: 1, timedOut: true };
    };

    await runMain(["-t", "claude", "-t", "copilot", "-p", "hello"]);

    assert.strictEqual(exitCode, EXIT_TIMEOUT);
    assert.ok(stdoutData.includes("out 2"));
    assert.ok(!stderrData.includes("[claude]"));
    assert.ok(stderrData.includes("[copilot] stderr:\nerr 2"));
    assert.ok(stderrData.includes("[copilot] error:"));
    assert.ok(stderrData.includes("timed out after"));
    assert.ok(stderrData.endsWith("[agent session]\n203\ncopilot\nmock-session-copilot\n"));
  });

  it("unknown provider type prints error and exits with provider error code", async () => {
    await runMain(["-t", "nonexistent", "-p", "hello"]);
    assert.strictEqual(exitCode, EXIT_PROVIDER_ERROR);
    assert.ok(stderrData.includes("Error: unknown provider type: nonexistent"));
  });

  it("falls back to opencode when earlier agent fails", async () => {
    mockProviders.claude.sendMock = () => ({
      stdout: "", stderr: "fail", sessionId: "claude-session", exitCode: 1,
    });
    mockProviders.opencode.sendMock = () => ({
      stdout: "from opencode", stderr: "", sessionId: "ses_mock", exitCode: 0,
    });

    await runMain(["-t", "claude", "-t", "opencode", "-p", "hello"]);

    assert.strictEqual(exitCode, EXIT_OK);
    assert.ok(stdoutData.includes("from opencode"));
    assert.ok(stderrData.endsWith("[agent session]\n0\nopencode\nses_mock\n"));
  });

  it("case-insensitive regex matching", async () => {
    mockProviders.claude.sendMock = () => {
      return { stdout: "Hi", stderr: "", sessionId: "claude-session", exitCode: 0 };
    };

    await runMain(["-t", "claude", "-p", "hello", "-e", "hi"]);

    assert.strictEqual(exitCode, 0);
    assert.ok(stdoutData.includes("Hi"));
  });

  it("retry count constraint works (total attempts)", async () => {
    let attempts = 0;
    mockProviders.claude.sendMock = () => {
      attempts++;
      return { stdout: "not matching", stderr: "", sessionId: "claude-session", exitCode: 0 };
    };

    await runMain(["-t", "claude", "-p", "hello", "-e", "match_nothing", "-r", "3"]);

    assert.strictEqual(attempts, 3);
  });

  it("retries on timeout up to -r limit", async () => {
    let attempts = 0;
    mockProviders.claude.sendMock = () => {
      attempts++;
      return { stdout: "", stderr: "", sessionId: "claude-session", exitCode: 1, timedOut: true };
    };

    await runMain(["-t", "claude", "-p", "hello", "-r", "3", "-o", "1"]);

    assert.strictEqual(attempts, 3);
    assert.strictEqual(exitCode, EXIT_TIMEOUT);
    assert.ok(stderrData.includes("timed out after 1s"));
  });

  it("succeeds after timeout on earlier attempt", async () => {
    let attempts = 0;
    mockProviders.claude.sendMock = () => {
      attempts++;
      if (attempts < 2) {
        return { stdout: "", stderr: "", sessionId: "claude-session", exitCode: 1, timedOut: true };
      }
      return { stdout: "ok", stderr: "", sessionId: "claude-session", exitCode: 0, timedOut: false };
    };

    await runMain(["-t", "claude", "-p", "hello", "-r", "3", "-o", "1"]);

    assert.strictEqual(attempts, 2);
    assert.strictEqual(exitCode, EXIT_OK);
    assert.ok(stdoutData.includes("ok"));
  });

  it("logs retry needed and fallback as error level", async () => {
    mockProviders.claude.sendMock = () => {
      return { stdout: "wrong output", stderr: "", sessionId: "claude-session", exitCode: 0 };
    };
    mockProviders.copilot.sendMock = () => {
      return { stdout: "correct", stderr: "", sessionId: "copilot-session", exitCode: 0 };
    };

    await runMain(["-t", "claude", "-t", "copilot", "-p", "hello", "-e", "correct", "-r", "2", "-d"]);

    assert.ok(/\[wrapper\]\[\d{6}\]\[error\]/.test(stderrData), "Should print error level logs");
    assert.ok(stderrData.includes("retry needed"), "Should log retry needed");
    assert.ok(stderrData.includes("failed, falling back to next agent"), "Should log fallback at error level");
  });

  it("logs stdout and stderr output character counts in debug mode", async () => {
    mockProviders.claude.sendMock = (session) => {
      return {
        stdout: "Hello\n世界",
        stderr: "err!",
        sessionId: session.sessionId,
        exitCode: 0,
      };
    };

    await runMain(["-t", "claude", "-p", "hello", "-d"]);

    assert.strictEqual(exitCode, EXIT_OK);
    assert.ok(
      /agent claude attempt session 1 finished, duration: \d+\.\d{2} seconds/.test(stderrData),
      "should keep existing duration debug log",
    );
    assert.ok(
      stderrData.includes("agent claude attempt session 1 stdout output chars: 8"),
      "should log stdout .length character count",
    );
    assert.ok(
      stderrData.includes("agent claude attempt session 1 stderr output chars: 4"),
      "should log stderr .length character count",
    );
  });

  it("reports regex mismatch failure in stderr without debug", async () => {
    mockProviders.claude.sendMock = () => {
      return { stdout: "Hello!", stderr: "", sessionId: "claude-session", exitCode: 0 };
    };

    await runMain(["-t", "claude", "-p", "hello", "-e", "bad", "-r", "2"]);

    assert.strictEqual(exitCode, EXIT_REGEX_MISMATCH);
    assert.ok(!stderrData.includes("[claude] stdout:"));
    assert.ok(!stderrData.includes("Hello!"));
    assert.ok(stderrData.includes("[claude] stderr:"));
    assert.ok(stderrData.includes("[claude] error:"));
    assert.ok(stderrData.includes("all 2 attempts exhausted: regex /bad/ not matched"));
    assert.ok(!/\[wrapper\]\[\d{6}\]\[error\]/.test(stderrData), "wrapper logs should stay silent without -d");
  });

  it("stops retrying immediately on exclude match", async () => {
    let attempts = 0;
    mockProviders.claude.sendMock = () => {
      attempts++;
      return { stdout: "fatal error block", stderr: "", sessionId: "claude-session", exitCode: 0 };
    };

    await runMain(["-t", "claude", "-p", "hello", "-x", "fatal error", "-r", "3"]);

    assert.strictEqual(attempts, 1);
    assert.strictEqual(exitCode, EXIT_EXCLUDE_MATCH);
    assert.ok(stderrData.includes("[claude] error:"));
    assert.ok(stderrData.includes("exclude regex /fatal error/ matched"));
  });

  it("falls back to next agent on exclude match of the first agent", async () => {
    mockProviders.claude.sendMock = () => {
      return { stdout: "fatal error block", stderr: "", sessionId: "claude-session", exitCode: 0 };
    };
    let copilotCalled = false;
    mockProviders.copilot.sendMock = () => {
      copilotCalled = true;
      return { stdout: "all fine", stderr: "", sessionId: "copilot-session", exitCode: 0 };
    };

    await runMain(["-t", "claude", "-t", "copilot", "-p", "hello", "-x", "fatal error"]);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(copilotCalled, true);
    assert.ok(stdoutData.includes("all fine"));
  });

  it("exits 206 when codex quota pattern matches on non-zero exit", async () => {
    mockProviders.codex.sendMock = () => ({
      stdout: "",
      stderr: "You've hit your usage limit",
      sessionId: "codex-session",
      exitCode: 1,
    });

    await runMain(["-t", "codex", "-p", "hello"]);

    assert.strictEqual(exitCode, EXIT_QUOTA_EXCEEDED);
    assert.ok(stderrData.includes("[codex] error:"));
    assert.ok(stderrData.includes("quota exceeded: /hit your usage limit/i matched"));
  });

  it("exits 206 when copilot quota pattern matches on non-zero exit", async () => {
    mockProviders.copilot.sendMock = () => ({
      stdout: "Error: You have exceeded your monthly quota (Request ID: abc)",
      stderr: "",
      sessionId: "copilot-session",
      exitCode: 1,
    });

    await runMain(["-t", "copilot", "-p", "hello"]);

    assert.strictEqual(exitCode, EXIT_QUOTA_EXCEEDED);
    assert.ok(stderrData.includes("[copilot] error:"));
    assert.ok(stderrData.includes("quota exceeded: /You have exceeded your monthly quota/i matched"));
  });

  it("does not treat quota text as quota when exit code is 0", async () => {
    mockProviders.copilot.sendMock = () => ({
      stdout: "Here is a note: You have exceeded your monthly quota in the docs.",
      stderr: "",
      sessionId: "copilot-session",
      exitCode: 0,
    });

    await runMain(["-t", "copilot", "-p", "hello"]);

    assert.strictEqual(exitCode, 0);
    assert.ok(!stderrData.includes("quota exceeded"));
  });

  it("exits 206 when gemini quota pattern matches on non-zero exit", async () => {
    mockProviders.gemini.sendMock = () => ({
      stdout: "",
      stderr: "You have exhausted your capacity",
      sessionId: "gemini-session",
      exitCode: 1,
    });

    await runMain(["-t", "gemini", "-p", "hello"]);

    assert.strictEqual(exitCode, EXIT_QUOTA_EXCEEDED);
    assert.ok(stderrData.includes("[gemini] error:"));
    assert.ok(stderrData.includes("quota exceeded: /You have exhausted your capacity/i matched"));
  });

  it("exits 206 when claude quota pattern matches on non-zero exit", async () => {
    mockProviders.claude.sendMock = () => ({
      stdout: "",
      stderr: "FreeUsageLimitError",
      sessionId: "claude-session",
      exitCode: 1,
    });

    await runMain(["-t", "claude", "-p", "hello"]);

    assert.strictEqual(exitCode, EXIT_QUOTA_EXCEEDED);
    assert.ok(stderrData.includes("[claude] error:"));
    assert.ok(stderrData.includes("quota exceeded: /FreeUsageLimitError/i matched"));
  });

  it("exits 206 when opencode free usage exceeded matches on non-zero exit", async () => {
    mockProviders.opencode.sendMock = () => ({
      stdout: "",
      stderr: "Free usage exceeded",
      sessionId: "opencode-session",
      exitCode: 1,
    });

    await runMain(["-t", "opencode", "-p", "hello"]);

    assert.strictEqual(exitCode, EXIT_QUOTA_EXCEEDED);
    assert.ok(stderrData.includes("[opencode] error:"));
    assert.ok(stderrData.includes("quota exceeded: /Free usage exceeded|usage limit reached|Rate limit exceeded|Subscription quota exceeded/i matched"));
  });

  it("exits 206 when opencode rate limit exceeded matches on non-zero exit", async () => {
    mockProviders.opencode.sendMock = () => ({
      stdout: "",
      stderr: "Rate limit exceeded",
      sessionId: "opencode-session",
      exitCode: 1,
    });

    await runMain(["-t", "opencode", "-p", "hello"]);

    assert.strictEqual(exitCode, EXIT_QUOTA_EXCEEDED);
    assert.ok(stderrData.includes("[opencode] error:"));
    assert.ok(stderrData.includes("quota exceeded: /Free usage exceeded|usage limit reached|Rate limit exceeded|Subscription quota exceeded/i matched"));
  });

  it("falls back to next agent when first agent hits quota", async () => {
    mockProviders.codex.sendMock = () => ({
      stdout: "",
      stderr: "You've hit your usage limit",
      sessionId: "codex-session",
      exitCode: 1,
    });
    let copilotCalled = false;
    mockProviders.copilot.sendMock = () => {
      copilotCalled = true;
      return { stdout: "all fine", stderr: "", sessionId: "copilot-session", exitCode: 0 };
    };

    await runMain(["-t", "codex", "-t", "copilot", "-p", "hello"]);

    assert.strictEqual(exitCode, 0);
    assert.strictEqual(copilotCalled, true);
    assert.ok(!stderrData.includes("quota exceeded: /hit your usage limit/i matched"));
    assert.ok(stdoutData.includes("all fine"));
    assert.ok(stderrData.endsWith("[agent session]\n0\ncopilot\ncopilot-session\n"));
  });

  it("final stderr contains only last successful agent without debug", async () => {
    mockProviders.codex.sendMock = () => ({
      stdout: "",
      stderr: "codex-stderr-content",
      sessionId: "codex-sid",
      exitCode: 1,
    });
    mockProviders.cursor.sendMock = (session) => ({
      stdout: "hello",
      stderr: "cursor-thinking",
      sessionId: session.sessionId,
      exitCode: 0,
    });

    await runMain(["-t", "codex", "-t", "cursor", "-p", "hi"]);

    assert.strictEqual(exitCode, EXIT_OK);
    assert.ok(stderrData.includes("[cursor] stderr:\ncursor-thinking"));
    assert.ok(!stderrData.includes("codex-stderr-content"));
    assert.ok(!stderrData.includes("[codex] stderr:"));
    assert.ok(stderrData.endsWith("[agent session]\n0\ncursor\nmock-session-cursor\n"));
  });

  it("debug logs codex stdout/stderr immediately on non-zero exit before fallback", async () => {
    mockProviders.codex.sendMock = () => ({
      stdout: "",
      stderr: "Reading additional input from stdin...",
      sessionId: "codex-sid",
      exitCode: 1,
    });
    mockProviders.cursor.sendMock = () => ({
      stdout: "ok",
      stderr: "",
      sessionId: "cursor-sid",
      exitCode: 0,
    });

    await runMain(["-t", "codex", "-t", "cursor", "-p", "hi", "-d"]);

    assert.ok(
      stderrData.includes("agent codex attempt session 1 stderr:\nReading additional input from stdin..."),
      "should dump codex stderr before fallback",
    );
    assert.ok(stderrData.includes("[codex][1/2]"), "should include context prefix");
    assert.ok(
      stderrData.indexOf("Reading additional input from stdin...") < stderrData.indexOf("trying agent 2/2"),
      "codex stderr dump should precede cursor attempt",
    );
    assert.ok(stderrData.includes("[codex][1/2]") && stderrData.includes("non-zero exit code 1"));
  });

  it("logs command on each retry attempt in debug mode", async () => {
    let attempts = 0;
    mockProviders.claude.sendMock = () => {
      attempts++;
      return {
        stdout: "Hi",
        stderr: "",
        sessionId: "claude-session",
        exitCode: 0,
      };
    };

    await runMain(["-t", "claude", "-p", "hello", "-e", "bad", "-r", "2", "-d"]);

    assert.strictEqual(attempts, 2);
    assert.ok(
      stderrData.includes("[claude][1/2] agent claude attempt session 1/2 command=claude"),
      "attempt 1 should log command",
    );
    assert.ok(
      stderrData.includes("[claude][2/2] agent claude attempt session 2/2 command=claude"),
      "attempt 2 should log command",
    );
  });

  it("logs retry continuing session in debug mode when session id is known", async () => {
    let attempts = 0;
    mockProviders.claude.sendMock = (session) => {
      attempts++;
      session.sessionId = session.sessionId || "mock-session-claude";
      if (attempts === 1) {
        return { stdout: "bad", stderr: "", sessionId: "mock-session-claude", exitCode: 0 };
      }
      return { stdout: "good match", stderr: "", sessionId: "mock-session-claude", exitCode: 0 };
    };

    await runMain(["-t", "claude", "-p", "hello", "-e", "good", "-r", "2", "-d"]);

    assert.strictEqual(attempts, 2);
    assert.strictEqual(exitCode, EXIT_OK);
    assert.ok(stderrData.includes("retry: continuing session mock-session-claude"));
  });

  it("passes through exit code when --no-quota", async () => {
    mockProviders.codex.sendMock = () => ({
      stdout: "",
      stderr: "You've hit your usage limit",
      sessionId: "codex-session",
      exitCode: 1,
    });

    await runMain(["-t", "codex", "-p", "hello", "--no-quota", "--enable-throttle", "false"]);

    assert.strictEqual(exitCode, 1);
    assert.ok(stderrData.includes("non-zero exit code 1"));
    assert.ok(!stderrData.includes("quota exceeded"));
  });

  it("passes through exit code when -n", async () => {
    mockProviders.codex.sendMock = () => ({
      stdout: "",
      stderr: "You've hit your usage limit",
      sessionId: "codex-session",
      exitCode: 1,
    });

    await runMain(["-t", "codex", "-p", "hello", "-n", "--enable-throttle", "false"]);

    assert.strictEqual(exitCode, 1);
    assert.ok(stderrData.includes("non-zero exit code 1"));
    assert.ok(!stderrData.includes("quota exceeded"));
  });

  it("does not treat non-matching non-zero exit as quota", async () => {
    mockProviders.codex.sendMock = () => ({
      stdout: "",
      stderr: "some other error",
      sessionId: "codex-session",
      exitCode: 1,
    });

    await runMain(["-t", "codex", "-p", "hello"]);

    assert.strictEqual(exitCode, 1);
    assert.ok(stderrData.includes("non-zero exit code 1"));
    assert.ok(!stderrData.includes("quota exceeded"));
  });

  it("prints version and exits", async () => {
    await runMain(["-v"]);
    assert.strictEqual(exitCode, 0);
    const pkg = require("../package.json");
    assert.strictEqual(stdoutData.trim(), pkg.version);
  });
});
