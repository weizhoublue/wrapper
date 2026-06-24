const { describe, it } = require("node:test");
const assert = require("node:assert");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const {
  ensureFlags,
  extractText,
  extractErrors,
  extractSessionId,
  inferExitCode,
  splitCommand,
} = require("../../src/provider/opencode");

describe("opencode ensureFlags", () => {
  it("inserts run and required flags for bare args", () => {
    assert.deepStrictEqual(
      ensureFlags([]),
      ["run", "--format", "json", "--dangerously-skip-permissions"],
    );
  });

  it("preserves existing run subcommand", () => {
    assert.deepStrictEqual(
      ensureFlags(["run"]),
      ["run", "--format", "json", "--dangerously-skip-permissions"],
    );
  });

  it("forces --format json", () => {
    assert.deepStrictEqual(
      ensureFlags(["run", "--format", "text"]),
      ["run", "--format", "json", "--dangerously-skip-permissions"],
    );
  });

  it("adds --session when resume is provided", () => {
    assert.deepStrictEqual(
      ensureFlags(["run"], "ses_abc123"),
      ["run", "--format", "json", "--dangerously-skip-permissions", "--session", "ses_abc123"],
    );
  });
});

describe("opencode JSON parsing", () => {
  it("extractText joins type:text events", () => {
    const events = [
      { type: "text", part: { text: "Hello " }, sessionID: "ses_1" },
      { type: "text", part: { text: "World" }, sessionID: "ses_1" },
    ];
    assert.strictEqual(extractText(events), "Hello World");
  });

  it("extractSessionId reads sessionID from events", () => {
    const events = [
      { type: "step_start", sessionID: "ses_xyz" },
      { type: "text", part: { text: "hi" }, sessionID: "ses_xyz" },
    ];
    assert.strictEqual(extractSessionId(events), "ses_xyz");
  });

  it("extractErrors collects error messages", () => {
    const events = [
      { type: "error", error: { name: "APIError", data: { message: "rate limited" } } },
    ];
    assert.strictEqual(extractErrors(events), "rate limited");
  });

  it("inferExitCode returns 1 on error events", () => {
    const events = [{ type: "error", error: { name: "Fail" } }];
    assert.strictEqual(inferExitCode(events, 0, false), 1);
  });
});

describe("opencode splitCommand", () => {
  it("parses opencode run with flags", () => {
    const result = splitCommand("opencode run --format json --dangerously-skip-permissions");
    assert.deepStrictEqual(result, {
      command: "opencode",
      args: ["run", "--format", "json", "--dangerously-skip-permissions"],
    });
  });
});

const hasOpencode = (() => {
  try {
    return spawnSync("which", ["opencode"]).status === 0;
  } catch { return false; }
})();

// Live smoke calls OpenCode API; opt in to avoid flaky/slow default test runs.
const runOpencodeSmoke = hasOpencode && process.env.WRAPPER_OPENCODE_SMOKE === "1";

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

describe("opencode provider smoke", () => {
  it("completes a simple prompt", { skip: !runOpencodeSmoke }, async () => {
    const result = await runWrapper(["-t", "opencode", "-p", "say hi in one word", "-d"]);
    assert.strictEqual(result.code, 0);
    assert.ok(result.stdout.trim().length > 0);
    const sid = lastLine(result.stderr);
    assert.match(sid, /^ses_/);
  });

  it("resume preserves session across invocations", { skip: !runOpencodeSmoke }, async () => {
    const first = await runWrapper(["-t", "opencode", "-d", "-p", "my name is Bob, remember it"]);
    const sid1 = lastLine(first.stderr);
    assert.match(sid1, /^ses_/);

    const second = await runWrapper(["-t", "opencode", "-d", "-s", sid1, "-p", "what is my name?"]);
    assert.strictEqual(lastLine(second.stderr), sid1);
    assert.ok(second.stdout.toLowerCase().includes("bob"),
      `expected context recall, got: ${second.stdout.slice(0, 200)}`);
  });
});
