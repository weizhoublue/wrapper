const { describe, it } = require("node:test");
const assert = require("node:assert");

const { splitCommand } = require("../src/command");

describe("splitCommand", () => {
  it("keeps quoted argument values together", () => {
    assert.deepStrictEqual(
      splitCommand('agent --model "gpt 5" --label \'daily run\''),
      {
        command: "agent",
        args: ["--model", "gpt 5", "--label", "daily run"],
      },
    );
  });

  it("supports escaped whitespace", () => {
    assert.deepStrictEqual(
      splitCommand("agent --label daily\\ run"),
      { command: "agent", args: ["--label", "daily run"] },
    );
  });

  it("rejects an unclosed quote", () => {
    assert.throws(() => splitCommand('agent --model "gpt 5'), /unclosed quote/i);
  });
});
