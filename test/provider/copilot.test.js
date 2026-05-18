const { describe, it } = require("node:test");
const assert = require("node:assert");

const copilot = require("../../src/provider/copilot");

describe("Copilot provider - interface", () => {
  it("exports createSession", () => {
    assert.strictEqual(typeof copilot.createSession, "function");
  });

  it("exports send", () => {
    assert.strictEqual(typeof copilot.send, "function");
  });

  it("exports closeSession", () => {
    assert.strictEqual(typeof copilot.closeSession, "function");
  });

  it("exports run", () => {
    assert.strictEqual(typeof copilot.run, "function");
  });

  it("exports extractText", () => {
    assert.strictEqual(typeof copilot.extractText, "function");
  });

  it("exports extractThinking", () => {
    assert.strictEqual(typeof copilot.extractThinking, "function");
  });

  it("exports splitCommand", () => {
    assert.strictEqual(typeof copilot.splitCommand, "function");
  });
});

describe("Copilot provider - extractText (ACP)", () => {
  it("extracts text from response content blocks", () => {
    const response = {
      stopReason: "end_turn",
      content: [{ type: "text", text: "Hello from Copilot" }],
    };
    assert.strictEqual(copilot.extractText([], response), "Hello from Copilot");
  });

  it("returns empty for non-text blocks", () => {
    const response = {
      stopReason: "end_turn",
      content: [
        { type: "tool_call", name: "bash", input: {} },
      ],
    };
    assert.strictEqual(copilot.extractText([], response), "");
  });
});

describe("Copilot provider - splitCommand", () => {
  it("parses copilot with ACP flag", () => {
    const result = copilot.splitCommand("copilot --acp --verbose");
    assert.deepStrictEqual(result, {
      command: "copilot",
      args: ["--acp", "--verbose"],
    });
  });
});
