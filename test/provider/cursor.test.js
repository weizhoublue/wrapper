const { describe, it } = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const { ensureFlags } = require("../../src/provider/cursor");

describe("cursor ensureFlags", () => {
  it("inserts acp and permission flags after agent", () => {
    assert.strictEqual(ensureFlags("agent"), "agent --yolo --approve-mcps acp");
  });

  it("inserts flags after cursor-agent", () => {
    assert.strictEqual(ensureFlags("cursor-agent"), "cursor-agent --yolo --approve-mcps acp");
  });

  it("adds missing flags when only acp present", () => {
    assert.strictEqual(ensureFlags("agent acp"), "agent --yolo --approve-mcps acp");
  });

  it("leaves existing yolo and adds approve-mcps", () => {
    assert.strictEqual(ensureFlags("agent --yolo acp"), "agent --yolo --approve-mcps acp");
  });

  it("does not duplicate flags", () => {
    assert.strictEqual(
      ensureFlags("agent --yolo --approve-mcps acp"),
      "agent --yolo --approve-mcps acp",
    );
  });

  it("does not inject print-mode -p", () => {
    const result = ensureFlags("agent");
    assert.ok(!result.includes(" -p"));
    assert.ok(!result.endsWith("-p"));
  });

  it("does not inject --trust (print-only)", () => {
    assert.ok(!ensureFlags("agent").includes("--trust"));
  });
});

const hasAgent = (() => {
  try {
    return spawnSync("which", ["agent"]).status === 0;
  } catch { return false; }
})();

const mainJs = path.join(__dirname, "..", "..", "src", "main.js");

function runWrapper(args = []) {
  return new Promise((resolve) => {
    const child = spawn("node", [mainJs, ...args], {
      cwd: path.join(__dirname, "..", ".."),
      env: process.env,
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

describe("cursor provider smoke", () => {
  it("completes a simple prompt", { skip: !hasAgent }, async () => {
    const result = await runWrapper(["-t", "cursor", "-p", "say hi in one word", "-d"]);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.trim().length > 0);
    assert.ok(lastLine(result.stderr).length > 0, "stderr ends with session id");
  });

  it("resume preserves session across invocations", { skip: !hasAgent }, async () => {
    const first = await runWrapper(["-t", "cursor", "-d", "-p", "my name is Bob, remember it"]);
    const sid1 = lastLine(first.stderr);
    assert.ok(sid1.length > 0);

    const second = await runWrapper(["-t", "cursor", "-d", "-s", sid1, "-p", "what is my name?"]);
    assert.strictEqual(lastLine(second.stderr), sid1);
    assert.ok(second.stdout.toLowerCase().includes("bob"),
      `expected context recall, got: ${second.stdout.slice(0, 200)}`);
  });
});
