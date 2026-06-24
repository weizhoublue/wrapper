const { describe, it } = require("node:test");
const assert = require("node:assert");

const { extractText, extractThinking, inferAcpExitCode, splitCommand } = require("../../src/provider/acp");

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
