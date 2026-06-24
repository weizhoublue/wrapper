const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");
const path = require("path");
const fs = require("fs");

// Mock the providers
const providers = ["claude", "codex", "copilot", "gemini", "cursor"];
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
const { main, EXIT_OK, EXIT_TIMEOUT, EXIT_PROVIDER_ERROR, EXIT_COMMAND_NOT_FOUND } = require("../src/main");

describe("multi-agent fallback E2E", () => {
  let originalExit;
  let originalWrite;
  let originalErrWrite;
  let originalArgv;
  let originalWriteSync;

  let exitCode = null;
  let stdoutData = "";
  let stderrData = "";

  beforeEach(() => {
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
    // Stderr should contain stderr log/output of all agents
    assert.ok(stderrData.includes("[claude] stderr:"));
    assert.ok(stderrData.includes("command not found: claude"));
    // Final agent is copilot
    assert.ok(stderrData.endsWith("copilot\nmock-session-copilot\n"));
  });

  it("first agent fails provider send, second agent succeeds", async () => {
    mockProviders.claude.sendMock = () => {
      throw new Error("send error");
    };

    await runMain(["-t", "claude", "-t", "copilot", "-p", "hello"]);

    assert.strictEqual(exitCode, 0);
    assert.ok(stdoutData.includes("mock-stdout-copilot"));
    assert.ok(stderrData.includes("[claude] stderr:"));
    assert.ok(stderrData.includes("send error"));
    assert.ok(stderrData.endsWith("copilot\nmock-session-copilot\n"));
  });

  it("first agent times out, second agent succeeds", async () => {
    mockProviders.claude.sendMock = (session) => {
      return { stdout: "timeout output", stderr: "timeout stderr", sessionId: session.sessionId, exitCode: 1, timedOut: true };
    };

    await runMain(["-t", "claude", "-t", "copilot", "-p", "hello"]);

    assert.strictEqual(exitCode, 0);
    assert.ok(stdoutData.includes("mock-stdout-copilot"));
    assert.ok(stderrData.includes("[claude] stdout:"));
    assert.ok(stderrData.includes("timeout output"));
    assert.ok(stderrData.includes("[claude] stderr:"));
    assert.ok(stderrData.includes("timeout stderr"));
    assert.ok(stderrData.endsWith("copilot\nmock-session-copilot\n"));
  });

  it("first agent exits with non-zero code, second agent succeeds", async () => {
    mockProviders.claude.sendMock = (session) => {
      return { stdout: "fail output", stderr: "fail stderr", sessionId: session.sessionId, exitCode: 5, timedOut: false };
    };

    await runMain(["-t", "claude", "-t", "copilot", "-p", "hello"]);

    assert.strictEqual(exitCode, 0);
    assert.ok(stdoutData.includes("mock-stdout-copilot"));
    assert.ok(stderrData.includes("[claude] stdout:"));
    assert.ok(stderrData.includes("fail output"));
    assert.ok(stderrData.includes("[claude] stderr:"));
    assert.ok(stderrData.includes("fail stderr"));
    assert.ok(stderrData.endsWith("copilot\nmock-session-copilot\n"));
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
    assert.ok(stderrData.includes("[claude] stderr:"));
    assert.ok(stderrData.includes("command not found: claude"));
    assert.ok(stderrData.includes("[copilot] stderr:"));
    assert.ok(stderrData.includes("session failed"));
    assert.ok(stderrData.endsWith("copilot\n"));
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
    assert.ok(stderrData.includes("[claude] stderr:"));
    assert.ok(stderrData.includes("send fail 1"));
    assert.ok(stderrData.includes("[copilot] stderr:"));
    assert.ok(stderrData.includes("send fail 2"));
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
    assert.ok(stderrData.includes("[claude] stdout:\nout 1"));
    assert.ok(stderrData.includes("[claude] stderr:\nerr 1"));
    assert.ok(stderrData.includes("[copilot] stdout:\nout 2"));
    assert.ok(stderrData.includes("[copilot] stderr:\nerr 2"));
    assert.ok(stderrData.endsWith("copilot\nmock-session-copilot\n"));
  });

  it("unknown provider type prints error and exits with provider error code", async () => {
    await runMain(["-t", "opencode", "-p", "hello"]);
    assert.strictEqual(exitCode, EXIT_PROVIDER_ERROR);
    assert.ok(stderrData.includes("Error: unknown provider type: opencode"));
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

  it("logs retry needed and fallback as error level", async () => {
    mockProviders.claude.sendMock = () => {
      return { stdout: "wrong output", stderr: "", sessionId: "claude-session", exitCode: 0 };
    };
    mockProviders.copilot.sendMock = () => {
      return { stdout: "correct", stderr: "", sessionId: "copilot-session", exitCode: 0 };
    };

    await runMain(["-t", "claude", "-t", "copilot", "-p", "hello", "-e", "correct", "-r", "2", "-d"]);

    assert.ok(stderrData.includes("[wrapper][error]"), "Should print error level logs");
    assert.ok(stderrData.includes("retry needed"), "Should log retry needed");
    assert.ok(stderrData.includes("failed, falling back to next agent"), "Should log fallback at error level");
  });

  it("prints version and exits", async () => {
    await runMain(["-v"]);
    assert.strictEqual(exitCode, 0);
    const pkg = require("../package.json");
    assert.strictEqual(stdoutData.trim(), pkg.version);
  });
});
