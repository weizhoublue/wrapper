const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  extractText,
  extractThinking,
  inferAcpExitCode,
  splitCommand,
  send,
  terminateChild,
} = require("../../src/provider/acp");

describe("ACP - extractText", () => {
  it("extracts text from agent_message_chunk notifications", () => {
    const notifications = [
      {
        type: "session_update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello " },
          },
        },
      },
      {
        type: "session_update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "World" },
          },
        },
      },
    ];
    assert.strictEqual(extractText(notifications, null), "Hello World");
  });

  it("extracts text from response content blocks", () => {
    const response = {
      stopReason: "end_turn",
      content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "World" },
      ],
    };
    assert.strictEqual(extractText([], response), "Hello World");
  });

  it("combines notification and response text", () => {
    const notifications = [
      {
        type: "session_update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "streaming " },
          },
        },
      },
    ];
    const response = {
      stopReason: "end_turn",
      content: [{ type: "text", text: "final" }],
    };
    assert.strictEqual(extractText(notifications, response), "streaming final");
  });

  it("ignores non-text notification types", () => {
    const notifications = [
      {
        type: "session_update",
        params: {
          update: {
            sessionUpdate: "tool_call",
            title: "reading file",
            status: "completed",
          },
        },
      },
      {
        type: "session_update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "answer" },
          },
        },
      },
    ];
    assert.strictEqual(extractText(notifications, null), "answer");
  });

  it("returns empty string for empty input", () => {
    assert.strictEqual(extractText([], null), "");
    assert.strictEqual(extractText([], {}), "");
    assert.strictEqual(extractText([], { content: [] }), "");
  });

  it("ignores non-text content blocks in response", () => {
    const response = {
      stopReason: "end_turn",
      content: [
        { type: "text", text: "a" },
        { type: "tool_call", name: "read", input: {} },
        { type: "text", text: "b" },
      ],
    };
    assert.strictEqual(extractText([], response), "ab");
  });
});

describe("ACP - extractThinking", () => {
  it("extracts thinking from agent_thought_chunk notifications", () => {
    const notifications = [
      {
        type: "session_update",
        params: {
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { thought: "Let me analyze..." },
          },
        },
      },
    ];
    assert.strictEqual(extractThinking(notifications, null), "Let me analyze...");
  });

  it("extracts thinking from response reasoning blocks", () => {
    const response = {
      stopReason: "end_turn",
      content: [
        { type: "reasoning", reasoning: "step 1" },
        { type: "reasoning", reasoning: "step 2" },
      ],
    };
    assert.strictEqual(extractThinking([], response), "step 1step 2");
  });

  it("extracts thinking from response thinking blocks", () => {
    const response = {
      stopReason: "end_turn",
      content: [{ type: "thinking", thinking: "thought" }],
    };
    assert.strictEqual(extractThinking([], response), "thought");
  });

  it("returns empty when no thinking content", () => {
    const notifications = [
      {
        type: "session_update",
        params: {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "plain text" },
          },
        },
      },
    ];
    assert.strictEqual(extractThinking(notifications, null), "");
  });
});

describe("ACP - inferAcpExitCode", () => {
  it("returns 0 for successful end_turn with normal output", () => {
    assert.strictEqual(
      inferAcpExitCode("copilot", { stopReason: "end_turn" }, "hello", "", ""),
      0,
    );
  });

  it("returns 1 for non-end_turn stopReason", () => {
    assert.strictEqual(
      inferAcpExitCode("copilot", { stopReason: "refusal" }, "no", "", ""),
      1,
    );
  });

  it("returns 1 when stdout starts with Error:", () => {
    assert.strictEqual(
      inferAcpExitCode(
        "copilot",
        { stopReason: "end_turn" },
        "Error: You have exceeded your monthly quota (Request ID: x)",
        "",
        "",
      ),
      1,
    );
  });

  it("returns 1 when stdout starts with provider limit message", () => {
    assert.strictEqual(
      inferAcpExitCode(
        "copilot",
        { stopReason: "end_turn" },
        "You have exceeded your monthly quota (Request ID: x)",
        "",
        "",
      ),
      1,
    );
  });

  it("returns 0 when limit phrase appears only mid-output", () => {
    assert.strictEqual(
      inferAcpExitCode(
        "copilot",
        { stopReason: "end_turn" },
        "Docs mention You have exceeded your monthly quota in billing FAQ.",
        "",
        "",
      ),
      0,
    );
  });
});

describe("ACP - splitCommand", () => {
  it("splits command without args", () => {
    const result = splitCommand("codex");
    assert.deepStrictEqual(result, { command: "codex", args: [] });
  });

  it("splits command with args", () => {
    const result = splitCommand("copilot --acp --verbose");
    assert.deepStrictEqual(result, {
      command: "copilot",
      args: ["--acp", "--verbose"],
    });
  });

  it("trims whitespace", () => {
    const result = splitCommand("  codex --model gpt-5  ");
    assert.deepStrictEqual(result, {
      command: "codex",
      args: ["--model", "gpt-5"],
    });
  });
});

describe("ACP - session lifecycle", () => {
  it("does not send a prompt after its deadline expires", async () => {
    let promptCalled = false;
    const result = await send({
      closed: false,
      client: { notifications: [] },
      deadline: Date.now() - 1,
      childStderr: () => "",
      sessionId: "session-1",
      provider: "copilot",
      childExitCode: () => null,
      connection: {
        prompt: async () => {
          promptCalled = true;
          return { stopReason: "end_turn", content: [] };
        },
      },
    }, "hello");

    assert.strictEqual(promptCalled, false);
    assert.strictEqual(result.timedOut, true);
  });

  it("clears its timeout after a prompt completes", async () => {
    const originalSetTimeout = global.setTimeout;
    const originalClearTimeout = global.clearTimeout;
    const timer = {};
    let clearedTimer;
    global.setTimeout = () => timer;
    global.clearTimeout = (value) => { clearedTimer = value; };

    try {
      await send({
        closed: false,
        client: { notifications: [] },
        deadline: Date.now() + 60_000,
        childStderr: () => "",
        sessionId: "session-1",
        provider: "copilot",
        childExitCode: () => null,
        connection: {
          prompt: async () => ({ stopReason: "end_turn", content: [] }),
        },
      }, "hello");
    } finally {
      global.setTimeout = originalSetTimeout;
      global.clearTimeout = originalClearTimeout;
    }

    assert.strictEqual(clearedTimer, timer);
  });

  it("terminates a child process with SIGTERM", () => {
    const signals = [];
    terminateChild({ kill: (signal) => signals.push(signal) });
    assert.deepStrictEqual(signals, ["SIGTERM"]);
  });

  it("kills child process immediately when timeout fires before prompt responds", async () => {
    // Verify the fix: when a prompt hangs past the deadline the child is
    // SIGTERM'd so that abandoned responsePromises don't leave a zombie process.
    const childKillSignals = [];
    const mockChild = { kill: (sig) => childKillSignals.push(sig || "SIGTERM") };

    const result = await send({
      closed: false,
      client: { notifications: [] },
      deadline: Date.now() + 150,
      childStderr: () => "",
      sessionId: "session-kill",
      provider: "copilot",
      childExitCode: () => null,
      child: mockChild,
      connection: {
        prompt: () => new Promise(() => {}), // hangs forever
      },
    }, "hello");

    assert.strictEqual(result.timedOut, true, "should report timedOut");
    assert.strictEqual(result.sessionId, "session-kill");
    assert.ok(childKillSignals.includes("SIGTERM"),
      `expected SIGTERM on child, got: ${JSON.stringify(childKillSignals)}`);
  });
});
