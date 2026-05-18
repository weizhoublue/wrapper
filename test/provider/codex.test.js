const { describe, it } = require("node:test");
const assert = require("node:assert");

const { extractText, extractThinking, extractSessionId, splitCommand } = require("../../src/provider/codex");

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
