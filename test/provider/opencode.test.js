const { describe, it } = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("child_process");
const { EventEmitter } = require("events");
const { Readable } = require("stream");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Wrap spawn before requiring provider so the provider captures the wrapper.
const childProcess = require("child_process");
const originalSpawn = childProcess.spawn;
let mockSpawnFn = null;
childProcess.spawn = (...args) => {
  if (mockSpawnFn) return mockSpawnFn(...args);
  return originalSpawn(...args);
};

const {
  ensureFlags,
  extractText,
  extractErrors,
  extractSessionId,
  inferExitCode,
  splitCommand,
  createSession,
  send,
  closeSession,
} = require("../../src/provider/opencode");
const { isQuotaExceeded } = require("../../src/limit-msg");

describe("opencode ensureFlags", () => {
  it("inserts run and required flags for bare args", () => {
    assert.deepStrictEqual(
      ensureFlags([]),
      ["run", "--format", "json", "--auto", "--standalone"],
    );
  });

  it("preserves existing run subcommand", () => {
    assert.deepStrictEqual(
      ensureFlags(["run"]),
      ["run", "--format", "json", "--auto", "--standalone"],
    );
  });

  it("forces --format json", () => {
    assert.deepStrictEqual(
      ensureFlags(["run", "--format", "text"]),
      ["run", "--format", "json", "--auto", "--standalone"],
    );
  });

  it("does not add --standalone when --server is given", () => {
    assert.deepStrictEqual(
      ensureFlags(["run", "--server", "http://127.0.0.1:4096"]),
      ["run", "--format", "json", "--server", "http://127.0.0.1:4096", "--auto"],
    );
  });

  it("recognizes --server=<url> and --standalone=<value> forms", () => {
    assert.deepStrictEqual(
      ensureFlags(["run", "--server=http://127.0.0.1:4096"]),
      ["run", "--format", "json", "--server=http://127.0.0.1:4096", "--auto"],
    );
    assert.deepStrictEqual(
      ensureFlags(["run", "--standalone=true"]),
      ["run", "--format", "json", "--standalone=true", "--auto"],
    );
  });

  it("does not repeat --format, --auto or --session given as --flag=value or -s", () => {
    assert.deepStrictEqual(
      ensureFlags(["run", "--format=default", "--auto=true", "-s", "ses_user"], "ses_resume"),
      ["run", "--format=json", "--auto=true", "-s", "ses_user", "--standalone"],
    );
  });

  it("adds --session when resume is provided", () => {
    assert.deepStrictEqual(
      ensureFlags(["run"], "ses_abc123"),
      ["run", "--format", "json", "--auto", "--standalone", "--session", "ses_abc123"],
    );
  });
});

describe("opencode JSON parsing", () => {
  it("extractText joins type:text events", () => {
    const events = [
      { type: "text", part: { text: "Hello " }, sessionID: "ses_1" },
      { type: "text", part: { text: "World" }, sessionID: "ses_1" },
    ];
    assert.strictEqual(extractText(events), "Hello World");
  });

  it("extractSessionId reads sessionID from events", () => {
    const events = [
      { type: "step_start", sessionID: "ses_xyz" },
      { type: "text", part: { text: "hi" }, sessionID: "ses_xyz" },
    ];
    assert.strictEqual(extractSessionId(events), "ses_xyz");
  });

  it("extractErrors formats v2 error type and message", () => {
    const events = [
      {
        type: "error",
        sessionID: "ses_1",
        error: { type: "provider.no-route", message: "Model unavailable: nonexistent/foo", response: { body: "{...}" } },
      },
    ];
    assert.strictEqual(extractErrors(events), "provider.no-route: Model unavailable: nonexistent/foo");
  });

  it("extractErrors handles missing type or message", () => {
    assert.strictEqual(extractErrors([{ type: "error", error: { message: "boom" } }]), "boom");
    assert.strictEqual(
      extractErrors([{ type: "error", error: { type: "unknown" } }]),
      '{"type":"unknown"}',
    );
    assert.strictEqual(extractErrors([{ type: "error" }]), "");
  });

  it("inferExitCode returns 1 on error events", () => {
    const events = [{ type: "error", error: { type: "unknown", message: "Fail" } }];
    assert.strictEqual(inferExitCode(events, 0, false), 1);
  });
});

describe("opencode splitCommand", () => {
  it("parses opencode run with flags", () => {
    const result = splitCommand("opencode run --format json --dangerously-skip-permissions");
    assert.deepStrictEqual(result, {
      command: "opencode",
      args: ["run", "--format", "json", "--dangerously-skip-permissions"],
    });
  });
});

describe("opencode send - timeout when descendants hold pipe fd", () => {
  it("resolves timedOut=true without waiting for close event", async () => {
    // Simulate the scenario where opencode spawns tool subprocesses that
    // inherit the stdout pipe fd. Even after opencode is SIGKILL'd the
    // descendants keep the pipe open, so child.on("close") never fires.
    const killSignals = [];
    mockSpawnFn = () => {
      const child = new EventEmitter();
      const stdoutStream = new Readable({ read() {} }); // never ends
      child.stdout = stdoutStream;
      child.stderr = new EventEmitter();
      child.unref = () => {};
      child.kill = (signal) => killSignals.push(signal || "SIGTERM");
      // "close" is deliberately never emitted
      return child;
    };

    const session = await createSession({ command: "node", timeout: 10 });
    session.deadline = Date.now() + 150;

    try {
      const start = Date.now();
      const result = await send(session, "test prompt");
      const elapsed = Date.now() - start;

      assert.strictEqual(result.timedOut, true, "should report timedOut");
      assert.strictEqual(result.exitCode, 1, "exit code should be 1 on timeout");
      assert.ok(elapsed >= 100, `should wait until deadline, elapsed=${elapsed}ms`);
      assert.ok(elapsed < 1000, `should not block waiting for close, elapsed=${elapsed}ms`);
      assert.ok(killSignals.includes("SIGTERM"), "should have sent SIGTERM to child");
    } finally {
      mockSpawnFn = null;
      await closeSession(session);
    }
  });

  it("resolves immediately when deadline is already past at send() call time", async () => {
    const killSignals = [];
    mockSpawnFn = () => {
      const child = new EventEmitter();
      child.stdout = new Readable({ read() {} });
      child.stderr = new EventEmitter();
      child.unref = () => {};
      child.kill = (signal) => killSignals.push(signal || "SIGTERM");
      return child;
    };

    const session = await createSession({ command: "node", timeout: 10 });
    session.deadline = Date.now() - 1; // already expired

    try {
      const start = Date.now();
      const result = await send(session, "test prompt");
      const elapsed = Date.now() - start;

      assert.strictEqual(result.timedOut, true);
      assert.strictEqual(result.exitCode, 1);
      assert.ok(elapsed < 200, `should resolve nearly immediately, elapsed=${elapsed}ms`);
      assert.ok(killSignals.includes("SIGTERM"), "should have killed the spawned child");
    } finally {
      mockSpawnFn = null;
      await closeSession(session);
    }
  });
});

describe("opencode send - v2 quota error", () => {
  it("surfaces the provider.* error type so quota detection matches", async () => {
    mockSpawnFn = () => {
      const child = new EventEmitter();
      const event = {
        type: "error",
        sessionID: "ses_quota",
        error: { type: "provider.free-limit", message: "Free usage exceeded" },
      };
      child.stdout = Readable.from([JSON.stringify(event) + "\n"]);
      child.stdout.on("end", () => setImmediate(() => child.emit("close", 1)));
      child.stderr = new EventEmitter();
      child.unref = () => {};
      child.kill = () => {};
      return child;
    };

    const session = await createSession({ command: "node", timeout: 10 });
    try {
      const result = await send(session, "test prompt");
      assert.strictEqual(result.exitCode, 1);
      assert.strictEqual(result.sessionId, "ses_quota");
      assert.strictEqual(result.stderr, "provider.free-limit: Free usage exceeded");
      assert.strictEqual(isQuotaExceeded("opencode", result.stdout, result.stderr), true);
    } finally {
      mockSpawnFn = null;
      await closeSession(session);
    }
  });
});

describe("opencode send - session flag", () => {
  it("does not add --session when the command already has -s", async () => {
    let spawnedArgs = null;
    mockSpawnFn = (cmd, args) => {
      spawnedArgs = args;
      const child = new EventEmitter();
      child.stdout = Readable.from([]);
      child.stdout.on("end", () => setImmediate(() => child.emit("close", 0)));
      child.stderr = new EventEmitter();
      child.unref = () => {};
      child.kill = () => {};
      return child;
    };

    const session = await createSession({ command: "node run -s ses_user", timeout: 10 });
    session.sessionId = "ses_user"; // as after a timed-out attempt
    try {
      await send(session, "continue");
      assert.ok(!spawnedArgs.includes("--session"), `unexpected --session in ${JSON.stringify(spawnedArgs)}`);
    } finally {
      mockSpawnFn = null;
      await closeSession(session);
    }
  });
});

const hasOpencode = (() => {
  try {
    return spawnSync("which", ["opencode"]).status === 0;
  } catch { return false; }
})();

// Live smoke calls OpenCode API; opt in to avoid flaky/slow default test runs.
const runOpencodeSmoke = hasOpencode && process.env.WRAPPER_OPENCODE_SMOKE === "1";

const mainJs = path.join(__dirname, "..", "..", "src", "main.js");

function runWrapper(args = [], env = process.env) {
  return new Promise((resolve) => {
    const child = spawn("node", [mainJs, ...args], {
      cwd: path.join(__dirname, "..", ".."),
      env,
      stdio: "pipe",
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => stdout += d.toString());
    child.stderr.on("data", (d) => stderr += d.toString());
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function lastLine(text) {
  return text.trim().split("\n").pop().trim();
}

describe("opencode e2e - fake v2 binary", () => {
  it("v2 quota error → exit 206 and throttle record", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-opencode-e2e-"));
    try {
      const binDir = path.join(tmpDir, "bin");
      fs.mkdirSync(binDir);
      const argsFile = path.join(tmpDir, "argv");
      const event = {
        type: "error",
        sessionID: "ses_fake",
        error: { type: "provider.free-limit", message: "Free usage exceeded" },
      };
      fs.writeFileSync(path.join(binDir, "opencode"),
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\necho '${JSON.stringify(event)}'\nexit 1\n`);
      fs.chmodSync(path.join(binDir, "opencode"), 0o755);

      const result = await runWrapper(["run", "-t", "opencode", "say hi"], {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
        WRAPPER_CONFIG_DIR: tmpDir,
      });

      assert.strictEqual(result.code, 206, result.stderr);
      assert.deepStrictEqual(fs.readFileSync(argsFile, "utf8").trimEnd().split("\n"),
        ["run", "--standalone", "--auto", "--format", "json", "say hi"]);
      assert.strictEqual(lastLine(result.stderr), "ses_fake");
      const records = JSON.parse(fs.readFileSync(path.join(tmpDir, "throttle.json"), "utf8"));
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0].type, "opencode");
      assert.ok(new Date(records[0].endExhausted) > new Date());
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("opencode provider smoke", () => {
  it("completes a simple prompt", { skip: !runOpencodeSmoke }, async () => {
    const result = await runWrapper(["run", "-t", "opencode", "-d", "say hi in one word"]);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.trim().length > 0);
    const sid = lastLine(result.stderr);
    assert.match(sid, /^ses_/);
  });

  it("resume preserves session across invocations", { skip: !runOpencodeSmoke }, async () => {
    const first = await runWrapper(["run", "-t", "opencode", "-d", "my name is Bob, remember it"]);
    const sid1 = lastLine(first.stderr);
    assert.match(sid1, /^ses_/);

    const second = await runWrapper(["run", "-t", "opencode", "-d", "-s", sid1, "what is my name?"]);
    assert.strictEqual(lastLine(second.stderr), sid1);
    assert.ok(second.stdout.toLowerCase().includes("bob"),
      `expected context recall, got: ${second.stdout.slice(0, 200)}`);
  });
});
