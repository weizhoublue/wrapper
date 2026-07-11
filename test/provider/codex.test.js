const childProcess = require("child_process");
const originalSpawn = childProcess.spawn;
let mockSpawnFn = null;
childProcess.spawn = (...args) => {
  if (mockSpawnFn) return mockSpawnFn(...args);
  return originalSpawn(...args);
};

const { describe, it } = require("node:test");
const assert = require("node:assert");
const { Readable } = require("stream");

const {
  extractText,
  extractThinking,
  extractSessionId,
  splitCommand,
  ensureFlags,
  insertResumeAfterExec,
  createSession,
  send,
  closeSession,
} = require("../../src/provider/codex");

function makeMockCodexChild(lines, exitCode = 0) {
  const EventEmitter = require("events");
  const child = new EventEmitter();
  const stdoutStream = new Readable({ read() {} });
  child.stdout = stdoutStream;
  child.stderr = new EventEmitter();
  child.kill = () => {};
  child.unref = () => {};
  process.nextTick(() => {
    for (const line of lines) {
      stdoutStream.push(line + "\n");
    }
    stdoutStream.push(null);
    setImmediate(() => child.emit("close", exitCode));
  });
  return child;
}

function resumeIndex(args) {
  return args.indexOf("resume");
}

async function sendWithFastMinWait(session, prompt) {
  // Speed up the post-exit MIN_WAIT_MS delay so tests don't take 10 s.
  // Temporarily set deadline to Infinity so the deadline timer is never
  // registered — otherwise any deadline >= 1000 ms also gets sped up to 0 ms,
  // causing it to fire before events are processed and breaking session-id tests.
  const origSetTimeout = global.setTimeout;
  const savedDeadline = session.deadline;
  session.deadline = Infinity;
  global.setTimeout = (fn, ms, ...rest) => {
    if (ms >= 1000) return origSetTimeout(fn, 0, ...rest);
    return origSetTimeout(fn, ms, ...rest);
  };
  try {
    return await send(session, prompt);
  } finally {
    global.setTimeout = origSetTimeout;
    session.deadline = savedDeadline;
  }
}

describe("Codex provider - extractText", () => {
  it("extracts text from agent_message items", () => {
    const events = [
      { type: "thread.started", thread_id: "abc123" },
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Hello " } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "World" } },
      { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10 } },
    ];
    assert.strictEqual(extractText(events), "Hello World");
  });

  it("ignores non-agent-message items", () => {
    const events = [
      { type: "thread.started", thread_id: "x" },
      { type: "item.completed", item: { id: "t1", type: "tool_call", text: "ls" } },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "done" } },
    ];
    assert.strictEqual(extractText(events), "done");
  });

  it("returns empty for no agent messages", () => {
    assert.strictEqual(extractText([]), "");
    assert.strictEqual(extractText([{ type: "turn.started" }]), "");
  });
});

describe("Codex provider - extractThinking", () => {
  it("extracts reasoning items", () => {
    const events = [
      { type: "item.completed", item: { id: "r1", type: "reasoning", text: "step 1\n" } },
      { type: "item.completed", item: { id: "r2", type: "reasoning", text: "step 2" } },
    ];
    assert.strictEqual(extractThinking(events), "step 1\nstep 2");
  });

  it("returns empty when no reasoning", () => {
    const events = [
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "hi" } },
    ];
    assert.strictEqual(extractThinking(events), "");
  });
});

describe("Codex provider - extractSessionId", () => {
  it("extracts thread_id from thread.started", () => {
    const events = [
      { type: "thread.started", thread_id: "019e36ca-9b12-71c3-821a-cdaccf78db35" },
      { type: "turn.started" },
    ];
    assert.strictEqual(extractSessionId(events), "019e36ca-9b12-71c3-821a-cdaccf78db35");
  });

  it("returns null when no thread.started", () => {
    assert.strictEqual(extractSessionId([]), null);
    assert.strictEqual(extractSessionId([{ type: "turn.started" }]), null);
  });
});

describe("Codex provider - splitCommand", () => {
  it("parses codex exec with flags", () => {
    const result = splitCommand("codex exec --json --dangerously-bypass-approvals-and-sandbox");
    assert.deepStrictEqual(result, {
      command: "codex",
      args: ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox"],
    });
  });
});

describe("Codex provider - ensureFlags", () => {
  it("prepends exec for bare custom commands", () => {
    assert.deepStrictEqual(ensureFlags([], ""), [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
    ]);
  });
});

describe("Codex provider - insertResumeAfterExec", () => {
  const baseArgs = ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"];

  it("inserts resume after exec when sessionId is set", () => {
    const out = insertResumeAfterExec(baseArgs, "thread-abc-123");
    assert.deepStrictEqual(out, [
      "exec", "resume", "thread-abc-123",
      "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check",
    ]);
  });

  it("returns args unchanged when sessionId is null", () => {
    assert.deepStrictEqual(insertResumeAfterExec(baseArgs, null), baseArgs);
    assert.deepStrictEqual(insertResumeAfterExec(baseArgs, ""), baseArgs);
  });

  it("does not duplicate resume when already present", () => {
    const withResume = ["exec", "resume", "existing-id", "--json"];
    assert.deepStrictEqual(insertResumeAfterExec(withResume, "thread-abc-123"), withResume);
  });

  it("returns args unchanged when exec subcommand is missing", () => {
    const noExec = ["--json", "--skip-git-repo-check"];
    assert.deepStrictEqual(insertResumeAfterExec(noExec, "thread-abc-123"), noExec);
  });
});

describe("Codex provider - send retry session continuity", () => {
  it("createSession initializes sessionId from resume option", async () => {
    const session = await createSession({
      command: "node",
      timeout: 10,
      resume: "user-session-id",
    });
    assert.strictEqual(session.sessionId, "user-session-id");
    await closeSession(session);
  });

  it("second send injects resume after first send returns thread_id", async () => {
    const session = await createSession({ command: "node", timeout: 10 });
    const threadId = "019e36ca-9b12-71c3-821a-cdaccf78db35";
    const spawnedArgsList = [];

    mockSpawnFn = (cmd, args) => {
      spawnedArgsList.push([...args]);
      const lines = [
        JSON.stringify({ type: "thread.started", thread_id: threadId }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }),
      ];
      return makeMockCodexChild(lines);
    };

    try {
      await sendWithFastMinWait(session, "prompt1");
      await sendWithFastMinWait(session, "prompt2");

      assert.strictEqual(spawnedArgsList.length, 2);
      assert.strictEqual(session.sessionId, threadId);
      assert.strictEqual(resumeIndex(spawnedArgsList[0]), -1, "first spawn must not resume");
      assert.ok(resumeIndex(spawnedArgsList[1]) >= 0, "second spawn must include resume");
      assert.strictEqual(spawnedArgsList[1][resumeIndex(spawnedArgsList[1]) + 1], threadId);
      assert.ok(spawnedArgsList[1].includes("prompt2"));
    } finally {
      mockSpawnFn = null;
      await closeSession(session);
    }
  });

  it("does not duplicate resume when createSession already has resume from -s", async () => {
    const resumeId = "existing-session-id";
    const session = await createSession({ command: "node", timeout: 10, resume: resumeId });
    let spawnedArgs = null;

    mockSpawnFn = (cmd, args) => {
      spawnedArgs = [...args];
      return makeMockCodexChild([
        JSON.stringify({ type: "thread.started", thread_id: resumeId }),
      ]);
    };

    try {
      await sendWithFastMinWait(session, "my prompt");
      const resumeCount = spawnedArgs.filter((a) => a === "resume").length;
      assert.strictEqual(resumeCount, 1);
      assert.strictEqual(spawnedArgs[resumeIndex(spawnedArgs) + 1], resumeId);
    } finally {
      mockSpawnFn = null;
      await closeSession(session);
    }
  });

  it("resolves timedOut=true without waiting for close when descendants hold pipe fd", async () => {
    // Simulate codex tool subprocesses keeping the pipe fd open after SIGKILL.
    // Use plain send() — not sendWithFastMinWait — so the deadline timer fires naturally.
    const killSignals = [];
    mockSpawnFn = () => {
      const EventEmitter = require("events");
      const { Readable } = require("stream");
      const child = new EventEmitter();
      const stdoutStream = new Readable({ read() {} }); // never ends
      child.stdout = stdoutStream;
      child.stderr = new EventEmitter();
      child.unref = () => {};
      child.kill = (signal) => killSignals.push(signal || "SIGTERM");
      // "close" deliberately never emitted (descendants hold pipe fd)
      return child;
    };

    const session = await createSession({ command: "node", timeout: 10 });
    session.deadline = Date.now() + 150;

    try {
      const start = Date.now();
      const result = await send(session, "test prompt"); // plain send, not sendWithFastMinWait
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

  it("preserves sessionId after timeout when thread.started was emitted", async () => {
    const session = await createSession({ command: "node", timeout: 10 });
    session.deadline = Date.now() + 50;
    const threadId = "timeout-thread-id";
    let spawnCount = 0;

    mockSpawnFn = () => {
      const spawnNum = ++spawnCount;
      const EventEmitter = require("events");
      const child = new EventEmitter();
      const stdoutStream = new Readable({ read() {} });
      child.stdout = stdoutStream;
      child.stderr = new EventEmitter();
      child.unref = () => {};

      if (spawnNum === 1) {
        // First spawn: close only via kill (triggered by the deadline timer).
        child.kill = () => {
          process.nextTick(() => child.emit("close", null));
        };
        process.nextTick(() => {
          stdoutStream.push(JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\n");
        });
      } else {
        // Second spawn: auto-close via stream end + setImmediate so that
        // sendWithFastMinWait (which disables the deadline timer) can still
        // complete via the normal close → MIN_WAIT path.
        child.kill = () => {};
        process.nextTick(() => {
          stdoutStream.push(JSON.stringify({ type: "thread.started", thread_id: threadId }) + "\n");
          stdoutStream.push(null); // end of stream
          setImmediate(() => child.emit("close", 0));
        });
      }
      return child;
    };

    try {
      // Use plain send() so the 50 ms deadline fires naturally.
      // sendWithFastMinWait would set deadline=Infinity and prevent the timeout.
      const first = await send(session, "prompt1");
      assert.strictEqual(first.timedOut, true);
      assert.strictEqual(session.sessionId, threadId);

      session.deadline = Date.now() + 60000;
      await sendWithFastMinWait(session, "prompt2");
      assert.strictEqual(spawnCount, 2);
    } finally {
      mockSpawnFn = null;
      await closeSession(session);
    }
  });
});
