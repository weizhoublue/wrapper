const { describe, it } = require("node:test");
const assert = require("node:assert");

const { extractText, extractThinking, extractSessionId, splitCommand, isRootUser, removePermissionFlags } = require("../../src/provider/claude");

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

