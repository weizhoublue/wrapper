const { describe, it } = require("node:test");
const assert = require("node:assert");

// Mock the SDK before requiring claude provider
let queryOptionsUsed = null;
const sdkPath = require.resolve("@anthropic-ai/claude-agent-sdk");
require.cache[sdkPath] = {
  id: sdkPath,
  filename: sdkPath,
  loaded: true,
  exports: {
    query: (args) => {
      queryOptionsUsed = args.options;
      return (async function* () {})();
    }
  }
};

const claudePath = require.resolve("../../src/provider/claude");
delete require.cache[claudePath];

const { createSession, closeSession, extractText, extractThinking, extractSessionId, splitCommand, isRootUser, removePermissionFlags, ensureFlags } = require("../../src/provider/claude");

describe("Claude provider - extractText", () => {
  it("extracts text from assistant messages", () => {
    const events = [
      { type: "assistant", message: { content: [{ type: "text", text: "Hello " }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "World" }] } },
      { type: "result", subtype: "success", result: "" },
    ];
    assert.strictEqual(extractText(events), "Hello World");
  });

  it("avoids duplicating result text when assistant text exists", () => {
    const events = [
      { type: "assistant", message: { content: [{ type: "text", text: "prefix" }] } },
      { type: "result", subtype: "success", result: "prefix", session_id: "abc123" },
    ];
    assert.strictEqual(extractText(events), "prefix");
  });

  it("falls back to result text when no assistant text", () => {
    const events = [
      { type: "result", subtype: "success", result: "fallback result", session_id: "abc" },
    ];
    assert.strictEqual(extractText(events), "fallback result");
  });

  it("ignores non-text content blocks", () => {
    const events = [
      { type: "assistant", message: { content: [
        { type: "text", text: "a" },
        { type: "tool_use", name: "read", input: {} },
        { type: "text", text: "b" },
      ]} },
      { type: "result", subtype: "success", result: "" },
    ];
    assert.strictEqual(extractText(events), "ab");
  });
});

describe("Claude provider - extractThinking", () => {
  it("extracts thinking blocks", () => {
    const events = [
      { type: "assistant", message: { content: [
        { type: "thinking", thinking: "Let me analyze..." },
        { type: "text", text: "answer" },
      ]} },
    ];
    assert.strictEqual(extractThinking(events), "Let me analyze...");
  });

  it("returns empty when no thinking blocks", () => {
    const events = [
      { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } },
    ];
    assert.strictEqual(extractThinking(events), "");
  });
});

describe("Claude provider - extractSessionId", () => {
  it("extracts session_id from result event", () => {
    const events = [
      { type: "system", subtype: "init", session_id: "first" },
      { type: "result", subtype: "success", result: "", session_id: "final" },
    ];
    assert.strictEqual(extractSessionId(events), "final");
  });

  it("returns null when no session_id", () => {
    const events = [
      { type: "assistant", message: { content: [] } },
    ];
    assert.strictEqual(extractSessionId(events), null);
  });
});

describe("splitCommand", () => {
  it("splits command without args", () => {
    const result = splitCommand("claude");
    assert.deepStrictEqual(result, { command: "claude", args: [] });
  });

  it("splits command with args", () => {
    const result = splitCommand("claude-free-remote --resume abc-123");
    assert.deepStrictEqual(result, { command: "claude-free-remote", args: ["--resume", "abc-123"] });
  });

  it("trims whitespace", () => {
    const result = splitCommand("  claude --verbose  ");
    assert.deepStrictEqual(result, { command: "claude", args: ["--verbose"] });
  });
});

describe("isRootUser", () => {
  it("returns true if process.getuid() is 0", () => {
    const origGetuid = process.getuid;
    process.getuid = () => 0;
    try {
      assert.strictEqual(isRootUser(), true);
    } finally {
      process.getuid = origGetuid;
    }
  });

  it("returns false if process.getuid() is not 0", () => {
    const origGetuid = process.getuid;
    if (origGetuid) {
      process.getuid = () => 1000;
      try {
        assert.strictEqual(isRootUser(), false);
      } finally {
        process.getuid = origGetuid;
      }
    }
  });
});

describe("removePermissionFlags", () => {
  it("filters out permission bypass flags from string array", () => {
    const input = [
      "--dangerously-skip-permissions",
      "--permission-mode=bypassPermissions",
      "--permission-mode",
      "bypassPermissions",
      "some-other-arg"
    ];
    assert.deepStrictEqual(removePermissionFlags(input), ["some-other-arg"]);
  });

  it("leaves other flags untouched", () => {
    const input = ["claude", "--resume", "abc-123"];
    assert.deepStrictEqual(removePermissionFlags(input), ["claude", "--resume", "abc-123"]);
  });
});

describe("ensureFlags", () => {
  it("skips appending and filters existing bypass flags when running as root", () => {
    const origGetuid = process.getuid;
    process.getuid = () => 0; // Simulate root
    try {
      const input = ["claude", "--dangerously-skip-permissions", "--resume", "abc"];
      const out = ensureFlags(input, "def");
      assert.deepStrictEqual(out, ["claude", "--resume", "abc"]);
    } finally {
      process.getuid = origGetuid;
    }
  });

  it("appends required flags when not running as root", () => {
    const origGetuid = process.getuid;
    if (origGetuid) {
      process.getuid = () => 1000; // Simulate non-root
      try {
        const input = ["claude"];
        const out = ensureFlags(input);
        assert.ok(out.includes("--dangerously-skip-permissions"));
        assert.ok(out.includes("--permission-mode"));
      } finally {
        process.getuid = origGetuid;
      }
    }
  });

  it("does not filter flags when running as root and isCustom is true", () => {
    const origGetuid = process.getuid;
    process.getuid = () => 0; // Simulate root
    try {
      const input = ["--dangerously-skip-permissions", "--resume", "abc"];
      const out = ensureFlags(input, "def", true);
      assert.deepStrictEqual(out, ["--dangerously-skip-permissions", "--resume", "abc"]);
    } finally {
      process.getuid = origGetuid;
    }
  });
});

describe("Claude provider - createSession", () => {
  it("includes permission bypass in sdkOptions when not running as root", async () => {
    const origGetuid = process.getuid;
    process.getuid = () => 1000; // non-root
    queryOptionsUsed = null;
    
    try {
      await createSession({ command: "node", timeout: 10 });
      assert.ok(queryOptionsUsed);
      assert.strictEqual(queryOptionsUsed.permissionMode, "bypassPermissions");
      assert.strictEqual(queryOptionsUsed.allowDangerouslySkipPermissions, true);
    } finally {
      process.getuid = origGetuid;
    }
  });

  it("omits permission bypass and logs debug when running as root", async () => {
    const origGetuid = process.getuid;
    process.getuid = () => 0; // root
    queryOptionsUsed = null;
    
    const log = require("../../src/log");
    const originalDebug = log.debug;
    const isDebugEnabled = log.isDebug();
    log.setDebug(true);
    let debugLogged = false;
    log.debug = (format, ...args) => {
      if (format.includes("running as root user, disabling permission bypass")) {
        debugLogged = true;
      }
      originalDebug(format, ...args);
    };

    try {
      await createSession({ command: "node", timeout: 10 });
      assert.ok(queryOptionsUsed);
      assert.strictEqual(queryOptionsUsed.permissionMode, undefined);
      assert.strictEqual(queryOptionsUsed.allowDangerouslySkipPermissions, undefined);
      assert.strictEqual(debugLogged, true);
    } finally {
      process.getuid = origGetuid;
      log.debug = originalDebug;
      log.setDebug(isDebugEnabled);
    }
  });

  it("enables permission bypass in sdkOptions when running as root with isCustom=true and options are present in command", async () => {
    const origGetuid = process.getuid;
    process.getuid = () => 0; // root
    queryOptionsUsed = null;
    try {
      await createSession({
        command: "node --dangerously-skip-permissions --permission-mode=bypassPermissions",
        timeout: 10,
        isCustom: true
      });
      assert.ok(queryOptionsUsed);
      assert.strictEqual(queryOptionsUsed.permissionMode, "bypassPermissions");
      assert.strictEqual(queryOptionsUsed.allowDangerouslySkipPermissions, true);
    } finally {
      process.getuid = origGetuid;
    }
  });

  it("omits permission bypass in sdkOptions when running as root with isCustom=true but options are NOT present in command", async () => {
    const origGetuid = process.getuid;
    process.getuid = () => 0; // root
    queryOptionsUsed = null;
    try {
      await createSession({
        command: "node",
        timeout: 10,
        isCustom: true
      });
      assert.ok(queryOptionsUsed);
      assert.strictEqual(queryOptionsUsed.permissionMode, undefined);
      assert.strictEqual(queryOptionsUsed.allowDangerouslySkipPermissions, undefined);
    } finally {
      process.getuid = origGetuid;
    }
  });
});

describe("Claude provider - closeSession", () => {
  it("does not hang forever when pump never resolves (guards against hung subprocess)", async () => {
    // claude's closeSession awaits session.pump. If the subprocess is stuck and
    // q.close() doesn't forcefully kill it, pump hangs forever. The fix caps
    // the wait at 5 s then force-kills. This test speeds up that guard to 10 ms.
    const origSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...rest) => {
      if (ms === 5000) return origSetTimeout(fn, 10, ...rest); // 5 s → 10 ms
      return origSetTimeout(fn, ms, ...rest);
    };

    const fakeSession = {
      closed: false,
      input: { end: () => {} },
      q: { close: () => {} },
      childRef: { current: null },
      pump: new Promise(() => {}), // hangs forever – simulates a stuck subprocess
    };

    try {
      const start = Date.now();
      await closeSession(fakeSession);
      const elapsed = Date.now() - start;

      assert.strictEqual(fakeSession.closed, true, "session should be marked closed");
      assert.ok(elapsed < 500, `closeSession should complete quickly, elapsed=${elapsed}ms`);
    } finally {
      global.setTimeout = origSetTimeout;
    }
  });

  it("force-kills the subprocess after the pump guard fires", async () => {
    const killSignals = [];
    const mockChild = { kill: (sig) => killSignals.push(sig || "SIGTERM") };

    const origSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...rest) => {
      if (ms === 5000) return origSetTimeout(fn, 10, ...rest); // 5 s → 10 ms
      if (ms === 2000) return origSetTimeout(fn, 10, ...rest); // SIGKILL delay → 10 ms
      return origSetTimeout(fn, ms, ...rest);
    };

    const fakeSession = {
      closed: false,
      input: { end: () => {} },
      q: { close: () => {} },
      childRef: { current: mockChild },
      pump: new Promise(() => {}),
    };

    try {
      await closeSession(fakeSession);
      // Allow the unrefed SIGKILL setTimeout to fire
      await new Promise((r) => setTimeout(r, 50));
      assert.ok(killSignals.includes("SIGTERM"), "should SIGTERM the subprocess");
    } finally {
      global.setTimeout = origSetTimeout;
    }
  });
});
