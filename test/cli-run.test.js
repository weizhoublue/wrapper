const { describe, it } = require("node:test");
const assert = require("node:assert");
const { parseRunArgs, DEFAULT_TIMEOUT } = require("../src/cli/run");

describe("parseRunArgs prompt", () => {
  it("P1: last token is prompt", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "hello"]);
    assert.strictEqual(opts.prompt, "hello");
  });

  it("P2: prompt after options", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-t", "codex", "say hi"]);
    assert.strictEqual(opts.prompt, "say hi");
    assert.strictEqual(opts.agents[0].type, "codex");
  });

  it("P3: prompt after -d flag", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-t", "codex", "-d", "say hi"]);
    assert.strictEqual(opts.prompt, "say hi");
    assert.strictEqual(opts.debug, true);
  });

  it("P4: complex options with prompt last", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-t", "codex", "-c", "my-cmd", "-r", "2", "say hi"]);
    assert.strictEqual(opts.prompt, "say hi");
    assert.strictEqual(opts.agents[0].type, "codex");
    assert.strictEqual(opts.agents[0].command, "my-cmd");
    assert.strictEqual(opts.retry, 2);
  });

  it("P5: prompt starting with dash is not parsed as option", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-fix bug"]);
    assert.strictEqual(opts.prompt, "-fix bug");
  });

  it("P6: dash-prefixed prompt after options", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-t", "codex", "-fix bug"]);
    assert.strictEqual(opts.prompt, "-fix bug");
  });

  it("P7: run with no args throws missing prompt", () => {
    assert.throws(
      () => parseRunArgs(["node", "main.js", "run"]),
      /missing prompt/i,
    );
  });

  it("P8: run with only options throws missing prompt", () => {
    assert.throws(
      () => parseRunArgs(["node", "main.js", "run", "-t", "codex"]),
      /missing prompt/i,
    );
  });

  it("P9: prompt before options throws", () => {
    assert.throws(
      () => parseRunArgs(["node", "main.js", "run", "say hi", "-t", "codex"]),
      /prompt must be the last argument/i,
    );
  });

  it("P10: -p is rejected", () => {
    assert.throws(
      () => parseRunArgs(["node", "main.js", "run", "-p", "hi"]),
      /(-p|--prompt).*not supported|no longer supported/i,
    );
  });

  it("P11: --prompt is rejected", () => {
    assert.throws(
      () => parseRunArgs(["node", "main.js", "run", "--prompt", "hi"]),
      /(-p|--prompt).*not supported|no longer supported/i,
    );
  });
});

describe("parseRunArgs special prompt content", () => {
  it("S1: prompt with spaces preserved verbatim", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "say hello world"]);
    assert.strictEqual(opts.prompt, "say hello world");
  });

  it("S1b: prompt with quotes preserved verbatim", () => {
    const opts = parseRunArgs(["node", "main.js", "run", '"quoted text"']);
    assert.strictEqual(opts.prompt, '"quoted text"');
  });

  it("S2: empty string prompt is allowed", () => {
    const opts = parseRunArgs(["node", "main.js", "run", ""]);
    assert.strictEqual(opts.prompt, "");
  });

  it("S3: long prompt is not truncated", () => {
    const longPrompt = "x".repeat(2048);
    const opts = parseRunArgs(["node", "main.js", "run", longPrompt]);
    assert.strictEqual(opts.prompt, longPrompt);
    assert.strictEqual(opts.prompt.length, 2048);
  });
});

describe("parseRunArgs", () => {
  it("defaults -t to claude", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "hi"]);
    assert.strictEqual(opts.agents[0].type, "claude");
    assert.strictEqual(opts.agents[0].commandName, "claude");
  });

  it("defaults timeout to 1 hour", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "hi"]);
    assert.strictEqual(opts.timeout, DEFAULT_TIMEOUT);
    assert.strictEqual(DEFAULT_TIMEOUT, 3600);
  });

  it("allows -o 0 for no timeout", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-o", "0", "hi"]);
    assert.strictEqual(opts.timeout, 0);
  });

  it("resolves default command for claude type", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "hi"]);
    assert.strictEqual(opts.agents[0].command, "claude --dangerously-skip-permissions --permission-mode=bypassPermissions");
  });

  it("resolves default command for cursor type", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-t", "cursor", "hi"]);
    assert.strictEqual(opts.agents[0].command, "agent --yolo --approve-mcps acp");
    assert.strictEqual(opts.agents[0].commandName, "cursor");
  });

  it("resolves default command for opencode type", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-t", "opencode", "hi"]);
    assert.strictEqual(opts.agents[0].command, "opencode run --dangerously-skip-permissions --format json");
    assert.strictEqual(opts.agents[0].commandName, "opencode");
  });

  it("respects explicit -c", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-t", "claude", "-c", "my-claude", "hi"]);
    assert.strictEqual(opts.agents[0].command, "my-claude");
    assert.strictEqual(opts.agents[0].commandName, "my-claude");
  });

  it("defaults retry to 2", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "hi"]);
    assert.strictEqual(opts.retry, 2);
  });

  it("parses all flags", () => {
    const opts = parseRunArgs(["node", "main.js", "run",
      "-t", "claude", "-c", "cc", "-d",
      "-e", "PASS", "-r", "5", "-o", "30", "test"]);
    assert.strictEqual(opts.prompt, "test");
    assert.strictEqual(opts.agents[0].type, "claude");
    assert.strictEqual(opts.agents[0].command, "cc");
    assert.strictEqual(opts.debug, true);
    assert.strictEqual(opts.reg, "PASS");
    assert.strictEqual(opts.retry, 5);
    assert.strictEqual(opts.timeout, 30);
  });

  it("long option names work", () => {
    const opts = parseRunArgs(["node", "main.js", "run",
      "--type", "claude", "--command", "c",
      "--debug", "--reg", "OK", "--retry", "2", "--timeout", "10", "hi"]);
    assert.strictEqual(opts.prompt, "hi");
    assert.strictEqual(opts.agents[0].type, "claude");
    assert.strictEqual(opts.agents[0].command, "c");
    assert.strictEqual(opts.retry, 2);
    assert.strictEqual(opts.timeout, 10);
  });

  it("parses -x / --exclude", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-x", "FAIL", "test"]);
    assert.strictEqual(opts.exclude, "FAIL");
  });

  it("parses long --exclude form", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "--exclude", "ERROR", "test"]);
    assert.strictEqual(opts.exclude, "ERROR");
  });

  it("parses -s resume", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-s", "abc123", "hi"]);
    assert.strictEqual(opts.resume, "abc123");
  });

  it("parses --resume long form", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "--resume", "xyz789", "hi"]);
    assert.strictEqual(opts.resume, "xyz789");
  });

  it("resume defaults to empty string when not specified", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "hi"]);
    assert.strictEqual(opts.resume, "");
  });

  it("throws on missing prompt when only options present", () => {
    assert.throws(() => parseRunArgs(["node", "main.js", "run", "-t", "codex"]), /missing prompt/i);
  });

  it("defaults quota to true", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "hi"]);
    assert.strictEqual(opts.quota, true);
  });

  it("parses --no-quota", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "--no-quota", "--enable-throttle", "false", "hi"]);
    assert.strictEqual(opts.quota, false);
  });

  it("parses -n short form for --no-quota", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-n", "--enable-throttle", "false", "hi"]);
    assert.strictEqual(opts.quota, false);
  });

  it("parses -q to explicitly enable quota", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-q", "hi"]);
    assert.strictEqual(opts.quota, true);
  });

  it("errors on conflicting -q and -n", () => {
    assert.throws(
      () => parseRunArgs(["node", "main.js", "run", "-q", "-n", "hi"]),
      /conflicting options: -q\/\--quota and -n\/\--no-quota/,
    );
  });

  it("sets isCustom to true when -c/--command is specified", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-t", "claude", "-c", "my-claude", "hi"]);
    assert.strictEqual(opts.agents[0].isCustom, true);
  });

  it("sets isCustom to undefined/falsy when -c/--command is not specified", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "hi"]);
    assert.strictEqual(opts.agents[0].isCustom, undefined);
  });

  it("throttle is enabled by default", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "hi"]);
    assert.strictEqual(opts.throttle, true);
    assert.strictEqual(opts.throttleDuration, 120);
  });

  it("--enable-throttle false sets throttle to false", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "--enable-throttle", "false", "hi"]);
    assert.strictEqual(opts.throttle, false);
  });

  it("--enable-throttle true sets throttle to true", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "--enable-throttle", "true", "hi"]);
    assert.strictEqual(opts.throttle, true);
  });

  it("--enable-throttle without value throws", () => {
    assert.throws(
      () => parseRunArgs(["node", "main.js", "run", "--enable-throttle"]),
      /--enable-throttle requires a value: true or false/
    );
  });

  it("--enable-throttle with invalid value throws", () => {
    assert.throws(
      () => parseRunArgs(["node", "main.js", "run", "--enable-throttle", "yes", "hi"]),
      /--enable-throttle requires a value: true or false/
    );
  });

  it("--throttle-duration sets custom duration", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "--throttle-duration", "60", "hi"]);
    assert.strictEqual(opts.throttleDuration, 60);
  });

  it("--throttle-duration with non-integer throws", () => {
    assert.throws(
      () => parseRunArgs(["node", "main.js", "run", "--throttle-duration", "abc", "hi"]),
      /throttle-duration must be a positive integer/
    );
  });

  it("--throttle-duration with zero throws", () => {
    assert.throws(
      () => parseRunArgs(["node", "main.js", "run", "--throttle-duration", "0", "hi"]),
      /throttle-duration must be a positive integer/
    );
  });

  it("--no-quota with throttle enabled throws conflict error", () => {
    assert.throws(
      () => parseRunArgs(["node", "main.js", "run", "--no-quota", "hi"]),
      /--no-quota cannot be used with throttle enabled/
    );
  });

  it("--no-quota with --enable-throttle false is allowed", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "--no-quota", "--enable-throttle", "false", "hi"]);
    assert.strictEqual(opts.throttle, false);
    assert.strictEqual(opts.quota, false);
  });
});

describe("parseRunArgs multi-agent", () => {
  it("parses multiple -t into agents array", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-t", "copilot", "-t", "codex", "hi"]);
    assert.strictEqual(opts.agents.length, 2);
    assert.strictEqual(opts.agents[0].type, "copilot");
    assert.strictEqual(opts.agents[0].commandName, "copilot");
    assert.strictEqual(opts.agents[1].type, "codex");
    assert.strictEqual(opts.agents[1].commandName, "codex");
  });

  it("pairs -c with preceding -t", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-t", "claude", "-c", "claude-deepseek", "-t", "copilot", "hi"]);
    assert.strictEqual(opts.agents[0].command, "claude-deepseek");
    assert.strictEqual(opts.agents[0].commandName, "claude-deepseek");
    assert.strictEqual(opts.agents[1].commandName, "copilot");
  });

  it("uses default command when no -c", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-t", "codex", "-t", "copilot", "hi"]);
    assert.strictEqual(opts.agents[0].command, "codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check");
    assert.ok(opts.agents[1].command.includes("copilot"));
  });

  it("errors on -c before any -t", () => {
    assert.throws(() => parseRunArgs(["node", "main.js", "run", "-c", "cmd", "-t", "claude", "hi"]),
      /-c\/--command must follow a -t\/--type option/);
  });

  it("errors on -c separated from -t by other options", () => {
    assert.throws(() => parseRunArgs(["node", "main.js", "run", "-t", "claude", "-r", "3", "-c", "cmd", "hi"]),
      /-c\/--command must immediately follow -t\/--type/);
  });

  it("errors on duplicate -c for same -t", () => {
    assert.throws(() => parseRunArgs(["node", "main.js", "run", "-t", "claude", "-c", "a", "-c", "b", "hi"]),
      /duplicate -c\/--command for -t/);
  });

  it("errors on resume with multiple agents", () => {
    assert.throws(() => parseRunArgs(["node", "main.js", "run", "-t", "copilot", "-t", "codex", "-s", "abc", "hi"]),
      /--resume cannot be used with multiple agents/);
  });

  it("allows resume with single agent", () => {
    const opts = parseRunArgs(["node", "main.js", "run", "-t", "claude", "-s", "abc", "hi"]);
    assert.strictEqual(opts.resume, "abc");
    assert.strictEqual(opts.agents.length, 1);
  });
});
