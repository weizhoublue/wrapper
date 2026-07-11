const { spawnSync } = require("child_process");
const path = require("path");
const { describe, it } = require("node:test");
const assert = require("node:assert");

const mainJs = path.join(__dirname, "..", "src", "main.js");
const pkg = require("../package.json");

function runWrapper(args) {
  return spawnSync("node", [mainJs, ...args], { encoding: "utf8" });
}

describe("cli route", () => {
  it("R1: wrapper no args shows subcommands", () => {
    const r = runWrapper([]);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /run/);
    assert.match(r.stdout, /throttle/);
  });

  it("R2: wrapper -h shows subcommands", () => {
    const r = runWrapper(["-h"]);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /run/);
    assert.match(r.stdout, /throttle/);
  });

  it("R2b: wrapper --help shows subcommands", () => {
    const r = runWrapper(["--help"]);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /run/);
    assert.match(r.stdout, /throttle/);
  });

  it("R3: wrapper -v shows version", () => {
    const r = runWrapper(["-v"]);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), pkg.version);
  });

  it("R3b: wrapper --version shows version", () => {
    const r = runWrapper(["--version"]);
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), pkg.version);
  });

  it("R4: wrapper run -h shows run help", () => {
    const r = runWrapper(["run", "-h"]);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /wrapper run/);
    assert.doesNotMatch(r.stdout, /-p, --prompt/);
  });

  it("R5: wrapper throttle -h shows throttle help", () => {
    const r = runWrapper(["throttle", "-h"]);
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /wrapper throttle/);
  });

  it("R6: wrapper -p hi migration error", () => {
    const r = runWrapper(["-p", "hi"]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /wrapper run/i);
  });

  it("R7: wrapper -t codex -p hi migration error", () => {
    const r = runWrapper(["-t", "codex", "-p", "hi"]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /wrapper run/i);
  });

  it("R8: wrapper --prompt hi migration error", () => {
    const r = runWrapper(["--prompt", "hi"]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /wrapper run/i);
  });

  it("R9: wrapper -t codex hi migration error", () => {
    const r = runWrapper(["-t", "codex", "hi"]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /wrapper run/i);
  });

  it("R10: wrapper unknown subcommand error", () => {
    const r = runWrapper(["unknown"]);
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /unknown subcommand/i);
  });
});
