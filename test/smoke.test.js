const { describe, it } = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const hasClaude = (() => {
  try {
    const { status } = spawnSync("which", ["claude"]);
    return status === 0;
  } catch { return false; }
})();

const mainJs = path.join(__dirname, "..", "src", "main.js");
const smokeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "wrapper-smoke-"));

function runCommu(args = []) {
  return new Promise((resolve) => {
    const child = spawn("node", [mainJs, ...args], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, WRAPPER_CONFIG_DIR: smokeConfigDir },
      stdio: "pipe",
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => stdout += d.toString());
    child.stderr.on("data", (d) => stderr += d.toString());
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("wrapper smoke", () => {
  it("starts and completes a simple prompt", { skip: !hasClaude }, async () => {
    const result = await runCommu(["-p", "say hi in one word"]);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.length > 0, "has stdout");
    assert.ok(result.stderr.length > 0, "has session id in stderr");
  });

  it("accepts custom command", { skip: !hasClaude }, async () => {
    const result = await runCommu(["-t", "claude", "-c", "claude", "-p", "say yes"]);
    assert.strictEqual(result.code, 0);
  });

  it("debug flag enables debug output", { skip: !hasClaude }, async () => {
    const result = await runCommu(["-p", "say no", "-d"]);
    assert.ok(result.stderr.includes("[wrapper]") && /\[wrapper\]\[\d{6}\]\[debug\]/.test(result.stderr), "has debug log in stderr");
    assert.match(
      result.stderr,
      /\[wrapper\]\[\d{6}\]\[debug\].* finished, duration: \d+\.\d+ seconds/,
      "stderr should log the attempt duration"
    );
  });

  it("retry on regex mismatch", { skip: !hasClaude }, async () => {
    const result = await runCommu(["-p", "say hi in one word", "-e", "ZZZZNOMATCHZZZ", "-r", "1"]);
    assert.notStrictEqual(result.code, 0);
  });
});
