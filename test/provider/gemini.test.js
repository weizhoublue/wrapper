const { describe, it } = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("child_process");
const path = require("path");

const hasGemini = (() => {
  try {
    const { status } = spawnSync("which", ["gemini"]);
    return status === 0;
  } catch { return false; }
})();

const mainJs = path.join(__dirname, "..", "..", "src", "main.js");

function runCommu(args = []) {
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

function extractSessionIds(stderr) {
  const re = /attempt \d+\/\d+ session=([^\s]+)/g;
  const ids = [];
  let m;
  while ((m = re.exec(stderr)) !== null) {
    ids.push(m[1]);
  }
  return ids;
}

function lastLine(text) {
  return text.trim().split("\n").pop().trim();
}

describe("gemini provider smoke", () => {
  it("starts and completes a simple prompt", { skip: !hasGemini }, async () => {
    const result = await runCommu(["-t", "gemini", "-p", "say hi in one word", "-d"]);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.trim().length > 0, "has stdout");
    const ids = extractSessionIds(result.stderr);
    assert.strictEqual(ids.length, 1, "has one session id");
  });

  it("accepts custom command", { skip: !hasGemini }, async () => {
    const result = await runCommu(["-t", "gemini", "-c", "gemini", "-p", "say yes", "-d"]);
    assert.strictEqual(result.code, 0);
  });

  it("retry attempts reuse the same session id", { skip: !hasGemini }, async () => {
    const result = await runCommu([
      "-t", "gemini", "-d", "-r", "1",
      "-e", "no_bingo",
      "-p", "say hi in one word ? reply me in english",
    ]);
    const ids = extractSessionIds(result.stderr);
    assert.ok(ids.length >= 2, `expected >=2 attempts, got ${ids.length}`);
    const unique = new Set(ids);
    assert.strictEqual(unique.size, 1,
      `all attempts should share same session id, got: ${ids.join(", ")}`);
  });

  it("resume preserves session id across invocations", { skip: !hasGemini }, async () => {
    // First call: create a session with context
    const first = await runCommu(["-t", "gemini", "-d", "-p", "my name is Alice, remember it"]);
    const sid1 = lastLine(first.stderr);
    assert.ok(sid1.length > 0, "first call has session id");

    // Second call: resume the same session
    const second = await runCommu(["-t", "gemini", "-d", "-s", sid1, "-p", "what is my name?"]);
    const sid2 = lastLine(second.stderr);

    assert.strictEqual(sid2, sid1,
      `resume session id should match: ${sid1} vs ${sid2}`);
    assert.ok(second.stdout.toLowerCase().includes("alice"),
      `resumed session should recall context, got: ${second.stdout.slice(0, 200)}`);
  });
});
