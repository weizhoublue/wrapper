const { describe, it } = require("node:test");
const assert = require("node:assert");

const { parseArgs, isOutputEmpty, canRetry, buildStderrOutput, collapseBlankLines, retryReason, LimitMsg, isQuotaExceeded, quotaReasonBrief, DEFAULT_TIMEOUT, EXIT_OK, EXIT_REGEX_MISMATCH, EXIT_EMPTY_OUTPUT, EXIT_PROVIDER_ERROR, EXIT_TIMEOUT, EXIT_EXCLUDE_MATCH, EXIT_QUOTA_EXCEEDED } = require("../src/main");

describe("parseArgs", () => {
  it("parses required -p", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hello"]);
    assert.strictEqual(opts.prompt, "hello");
  });

  it("defaults -t to claude", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi"]);
    assert.strictEqual(opts.agents[0].type, "claude");
    assert.strictEqual(opts.agents[0].commandName, "claude");
  });

  it("defaults timeout to 1 hour", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi"]);
    assert.strictEqual(opts.timeout, DEFAULT_TIMEOUT);
    assert.strictEqual(DEFAULT_TIMEOUT, 3600);
  });

  it("allows -o 0 for no timeout", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "-o", "0"]);
    assert.strictEqual(opts.timeout, 0);
  });

  it("resolves default command for claude type", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi"]);
    assert.strictEqual(opts.agents[0].command, "claude --dangerously-skip-permissions --permission-mode=bypassPermissions");
  });

  it("resolves default command for cursor type", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "-t", "cursor"]);
    assert.strictEqual(opts.agents[0].command, "agent --yolo --approve-mcps acp");
    assert.strictEqual(opts.agents[0].commandName, "cursor");
  });

  it("resolves default command for opencode type", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "-t", "opencode"]);
    assert.strictEqual(opts.agents[0].command, "opencode run --dangerously-skip-permissions --format json");
    assert.strictEqual(opts.agents[0].commandName, "opencode");
  });

  it("respects explicit -c", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "-t", "claude", "-c", "my-claude"]);
    assert.strictEqual(opts.agents[0].command, "my-claude");
    assert.strictEqual(opts.agents[0].commandName, "my-claude");
  });

  it("defaults retry to 2", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi"]);
    assert.strictEqual(opts.retry, 2);
  });

  it("parses all flags", () => {
    const opts = parseArgs(["node", "main.js",
      "-p", "test", "-t", "claude", "-c", "cc", "-d",
      "-e", "PASS", "-r", "5", "-o", "30"]);
    assert.strictEqual(opts.prompt, "test");
    assert.strictEqual(opts.agents[0].type, "claude");
    assert.strictEqual(opts.agents[0].command, "cc");
    assert.strictEqual(opts.debug, true);
    assert.strictEqual(opts.reg, "PASS");
    assert.strictEqual(opts.retry, 5);
    assert.strictEqual(opts.timeout, 30);
  });

  it("long option names work", () => {
    const opts = parseArgs(["node", "main.js",
      "--prompt", "hi", "--type", "claude", "--command", "c",
      "--debug", "--reg", "OK", "--retry", "2", "--timeout", "10"]);
    assert.strictEqual(opts.prompt, "hi");
    assert.strictEqual(opts.agents[0].type, "claude");
    assert.strictEqual(opts.agents[0].command, "c");
    assert.strictEqual(opts.retry, 2);
    assert.strictEqual(opts.timeout, 10);
  });

  it("parses -x / --exclude", () => {
    const opts = parseArgs(["node", "main.js", "-p", "test", "-x", "FAIL"]);
    assert.strictEqual(opts.exclude, "FAIL");
  });

  it("parses long --exclude form", () => {
    const opts = parseArgs(["node", "main.js", "-p", "test", "--exclude", "ERROR"]);
    assert.strictEqual(opts.exclude, "ERROR");
  });

  it("parses -s resume", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "-s", "abc123"]);
    assert.strictEqual(opts.resume, "abc123");
  });

  it("parses --resume long form", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "--resume", "xyz789"]);
    assert.strictEqual(opts.resume, "xyz789");
  });

  it("resume defaults to empty string when not specified", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi"]);
    assert.strictEqual(opts.resume, "");
  });

  it("throws on missing -p when args present", () => {
    assert.throws(() => parseArgs(["node", "main.js", "-t", "codex"]), /required option.*prompt/i);
  });

  it("defaults quota to true", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi"]);
    assert.strictEqual(opts.quota, true);
  });

  it("parses --no-quota", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "--no-quota", "--enable-throttle", "false"]);
    assert.strictEqual(opts.quota, false);
  });

  it("parses -n short form for --no-quota", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "-n", "--enable-throttle", "false"]);
    assert.strictEqual(opts.quota, false);
  });

  it("parses -q to explicitly enable quota", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "-q"]);
    assert.strictEqual(opts.quota, true);
  });

  it("errors on conflicting -q and -n", () => {
    assert.throws(
      () => parseArgs(["node", "main.js", "-p", "hi", "-q", "-n"]),
      /conflicting options: -q\/\--quota and -n\/\--no-quota/,
    );
  });

  it("sets isCustom to true when -c/--command is specified", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "-t", "claude", "-c", "my-claude"]);
    assert.strictEqual(opts.agents[0].isCustom, true);
  });

  it("sets isCustom to undefined/falsy when -c/--command is not specified", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi"]);
    assert.strictEqual(opts.agents[0].isCustom, undefined);
  });

  it("throttle is enabled by default", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi"]);
    assert.strictEqual(opts.throttle, true);
    assert.strictEqual(opts.throttleDuration, 120);
  });

  it("--enable-throttle false sets throttle to false", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "--enable-throttle", "false"]);
    assert.strictEqual(opts.throttle, false);
  });

  it("--enable-throttle true sets throttle to true", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "--enable-throttle", "true"]);
    assert.strictEqual(opts.throttle, true);
  });

  it("--enable-throttle without value throws", () => {
    assert.throws(
      () => parseArgs(["node", "main.js", "-p", "hi", "--enable-throttle"]),
      /--enable-throttle requires a value: true or false/
    );
  });

  it("--enable-throttle with invalid value throws", () => {
    assert.throws(
      () => parseArgs(["node", "main.js", "-p", "hi", "--enable-throttle", "yes"]),
      /--enable-throttle requires a value: true or false/
    );
  });

  it("--throttle-duration sets custom duration", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "--throttle-duration", "60"]);
    assert.strictEqual(opts.throttleDuration, 60);
  });

  it("--throttle-duration with non-integer throws", () => {
    assert.throws(
      () => parseArgs(["node", "main.js", "-p", "hi", "--throttle-duration", "abc"]),
      /throttle-duration must be a positive integer/
    );
  });

  it("--throttle-duration with zero throws", () => {
    assert.throws(
      () => parseArgs(["node", "main.js", "-p", "hi", "--throttle-duration", "0"]),
      /throttle-duration must be a positive integer/
    );
  });

  it("--no-quota with throttle enabled throws conflict error", () => {
    assert.throws(
      () => parseArgs(["node", "main.js", "-p", "hi", "--no-quota"]),
      /--no-quota cannot be used with throttle enabled/
    );
  });

  it("--no-quota with --enable-throttle false is allowed", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "--no-quota", "--enable-throttle", "false"]);
    assert.strictEqual(opts.throttle, false);
    assert.strictEqual(opts.quota, false);
  });
});

describe("parseArgs multi-agent", () => {
  it("parses multiple -t into agents array", () => {
    const opts = parseArgs(["node", "main.js", "-t", "copilot", "-t", "codex", "-p", "hi"]);
    assert.strictEqual(opts.agents.length, 2);
    assert.strictEqual(opts.agents[0].type, "copilot");
    assert.strictEqual(opts.agents[0].commandName, "copilot");
    assert.strictEqual(opts.agents[1].type, "codex");
    assert.strictEqual(opts.agents[1].commandName, "codex");
  });

  it("pairs -c with preceding -t", () => {
    const opts = parseArgs(["node", "main.js", "-t", "claude", "-c", "claude-deepseek", "-t", "copilot", "-p", "hi"]);
    assert.strictEqual(opts.agents[0].command, "claude-deepseek");
    assert.strictEqual(opts.agents[0].commandName, "claude-deepseek");
    assert.strictEqual(opts.agents[1].commandName, "copilot");
  });

  it("uses default command when no -c", () => {
    const opts = parseArgs(["node", "main.js", "-t", "codex", "-t", "copilot", "-p", "hi"]);
    assert.strictEqual(opts.agents[0].command, "codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check");
    assert.ok(opts.agents[1].command.includes("copilot"));
  });

  it("errors on -c before any -t", () => {
    assert.throws(() => parseArgs(["node", "main.js", "-c", "cmd", "-t", "claude", "-p", "hi"]),
      /-c\/--command must follow a -t\/--type option/);
  });

  it("errors on -c separated from -t by other options", () => {
    assert.throws(() => parseArgs(["node", "main.js", "-t", "claude", "-r", "3", "-c", "cmd", "-p", "hi"]),
      /-c\/--command must immediately follow -t\/--type/);
  });

  it("errors on duplicate -c for same -t", () => {
    assert.throws(() => parseArgs(["node", "main.js", "-t", "claude", "-c", "a", "-c", "b", "-p", "hi"]),
      /duplicate -c\/--command for -t/);
  });

  it("errors on resume with multiple agents", () => {
    assert.throws(() => parseArgs(["node", "main.js", "-t", "copilot", "-t", "codex", "-s", "abc", "-p", "hi"]),
      /--resume cannot be used with multiple agents/);
  });

  it("allows resume with single agent", () => {
    const opts = parseArgs(["node", "main.js", "-t", "claude", "-s", "abc", "-p", "hi"]);
    assert.strictEqual(opts.resume, "abc");
    assert.strictEqual(opts.agents.length, 1);
  });
});

describe("isOutputEmpty", () => {
  it("empty string is empty", () => {
    assert.strictEqual(isOutputEmpty(""), true);
  });
  it("whitespace only is empty", () => {
    assert.strictEqual(isOutputEmpty("   \n\t  "), true);
  });
  it("non-whitespace is not empty", () => {
    assert.strictEqual(isOutputEmpty("hello"), false);
  });
});

describe("canRetry", () => {
  it("retry on empty output", () => {
    assert.strictEqual(canRetry("", null), true);
  });
  it("retry on regex mismatch", () => {
    assert.strictEqual(canRetry("hello", /world/), true);
  });
  it("no retry when output non-empty and regex matches", () => {
    assert.strictEqual(canRetry("hello world", /world/), false);
  });
  it("no retry when output non-empty and no regex", () => {
    assert.strictEqual(canRetry("hello", null), false);
  });
});

describe("collapseBlankLines", () => {
  it("collapses 3+ consecutive newlines to 2", () => {
    assert.strictEqual(collapseBlankLines("a\n\n\n\nb"), "a\n\nb");
  });
  it("keeps single blank line", () => {
    assert.strictEqual(collapseBlankLines("a\n\nb"), "a\n\nb");
  });
  it("keeps no blank lines", () => {
    assert.strictEqual(collapseBlankLines("a\nb"), "a\nb");
  });
  it("trims leading blank lines", () => {
    assert.strictEqual(collapseBlankLines("\n\n\n\na\nb"), "a\nb");
  });
  it("trims trailing blank lines", () => {
    assert.strictEqual(collapseBlankLines("a\nb\n\n\n\n"), "a\nb");
  });
});

describe("retryReason", () => {
  it("reports empty output", () => {
    assert.ok(retryReason("", null).includes("empty output"));
  });
  it("reports regex mismatch with pattern", () => {
    const reason = retryReason("hello", /world/);
    assert.ok(reason.includes("world"));
    assert.ok(reason.includes("hello"));
  });
});

describe("exit codes", () => {
  it("has distinct codes above common claude exit codes", () => {
    assert.strictEqual(EXIT_OK, 0);
    assert.strictEqual(EXIT_REGEX_MISMATCH, 200);
    assert.strictEqual(EXIT_EMPTY_OUTPUT, 201);
    assert.strictEqual(EXIT_PROVIDER_ERROR, 202);
    assert.strictEqual(EXIT_TIMEOUT, 203);
  });

  it("has distinct EXIT_EXCLUDE_MATCH exit code", () => {
    assert.strictEqual(EXIT_EXCLUDE_MATCH, 205);
  });

  it("has distinct EXIT_QUOTA_EXCEEDED exit code", () => {
    assert.strictEqual(EXIT_QUOTA_EXCEEDED, 206);
  });
});

describe("LimitMsg", () => {
  it("matches sample output for every agent with a non-empty pattern", () => {
    const samples = {
      claude: { stdout: "", stderr: "FreeUsageLimitError" },
      codex: { stdout: "", stderr: "You've hit your usage limit" },
      copilot: { stdout: "", stderr: "You have exceeded your monthly quota" },
      gemini: { stdout: "", stderr: "You have exhausted your capacity" },
      opencode: { stdout: "", stderr: "OPENCODE_QUOTA_LIMIT" },
    };
    for (const [type, { stdout, stderr }] of Object.entries(samples)) {
      assert.ok(LimitMsg[type], `${type} should have a LimitMsg pattern`);
      assert.strictEqual(isQuotaExceeded(type, stdout, stderr), true, type);
    }
  });

  it("has empty pattern for agents without known quota messages", () => {
    for (const type of ["cursor", "agy"]) {
      assert.strictEqual(LimitMsg[type], "", type);
    }
  });
});

describe("isQuotaExceeded", () => {
  it("matches codex stderr pattern case-insensitively", () => {
    assert.strictEqual(
      isQuotaExceeded("codex", "", "You've hit your usage limit"),
      true,
    );
  });

  it("matches pattern in stdout", () => {
    assert.strictEqual(
      isQuotaExceeded("copilot", "You have exceeded your monthly quota", ""),
      true,
    );
  });

  it("returns false for agents with empty LimitMsg", () => {
    for (const type of ["cursor", "agy"]) {
      assert.strictEqual(
        isQuotaExceeded(type, "", "hit your usage limit"),
        false,
        type,
      );
    }
  });

  it("matches gemini stderr pattern", () => {
    assert.strictEqual(
      isQuotaExceeded("gemini", "", "You have exhausted your capacity"),
      true,
    );
  });

  it("matches claude stderr pattern", () => {
    assert.strictEqual(
      isQuotaExceeded("claude", "", "FreeUsageLimitError"),
      true,
    );
  });

  it("returns false when text does not match", () => {
    assert.strictEqual(
      isQuotaExceeded("codex", "", "some other error"),
      false,
    );
  });

  it("matches opencode quota marker in stderr", () => {
    assert.strictEqual(
      isQuotaExceeded("opencode", "", "OPENCODE_QUOTA_LIMIT"),
      true,
    );
  });

  it("matches opencode quota marker in stdout", () => {
    assert.strictEqual(
      isQuotaExceeded("opencode", "OPENCODE_QUOTA_LIMIT", ""),
      true,
    );
  });

  it("returns false for opencode when quota text does not match", () => {
    assert.strictEqual(
      isQuotaExceeded("opencode", "", "rate limited"),
      false,
    );
  });
});

describe("quotaReasonBrief", () => {
  it("formats quota exceeded message", () => {
    assert.strictEqual(
      quotaReasonBrief("hit your usage limit"),
      "quota exceeded: /hit your usage limit/i matched",
    );
  });
});

describe("buildStderrOutput", () => {
  it("success: stderr block and trailing metadata, no stdout or error", () => {
    const result = buildStderrOutput("claude", "sid-1", {
      commandName: "claude",
      stdout: "ignored",
      stderr: "thinking text",
    }, 0);
    const lines = result.split("\n");
    assert.strictEqual(lines[lines.length - 1], "sid-1");
    assert.strictEqual(lines[lines.length - 2], "claude");
    assert.strictEqual(lines[lines.length - 3], "0");
    assert.strictEqual(lines[lines.length - 4], "[agent session]");
    assert.strictEqual(lines[lines.length - 5], "");
    assert.ok(result.includes("[claude] stderr:\nthinking text"));
    assert.ok(!result.includes("[claude] stdout:"));
    assert.ok(!result.includes("[claude] error:"));
  });

  it("failure: stderr, error, and trailing metadata", () => {
    const result = buildStderrOutput("codex", "sid-2", {
      commandName: "codex",
      stdout: "Hello.",
      stderr: "Reading additional input from stdin...",
      wrapperError: "non-zero exit code 1",
    }, 1);
    assert.ok(result.includes("[codex] stderr:\nReading additional input from stdin..."));
    assert.ok(result.includes("[codex] error:\nnon-zero exit code 1"));
    assert.ok(!result.includes("[codex] stdout:"));
    assert.ok(!result.includes("Hello."));
    assert.strictEqual(result.split("\n").slice(-5).join("\n"), "\n[agent session]\n1\ncodex\nsid-2");
  });

  it("empty stderr: labels present without content lines", () => {
    const result = buildStderrOutput("claude", "sid-3", {
      commandName: "claude",
      stdout: "",
      stderr: "",
    }, 0);
    assert.ok(result.includes("[claude] stderr:"));
    assert.ok(!result.includes("[claude] error:"));
    assert.strictEqual(result.split("\n").slice(-5).join("\n"), "\n[agent session]\n0\nclaude\nsid-3");
  });

  it("does not include other agents (single result only)", () => {
    const result = buildStderrOutput("codex", "sid-4", {
      commandName: "codex",
      stderr: "cdx-err",
    }, 0);
    assert.ok(!result.includes("[copilot]"));
    assert.ok(result.includes("cdx-err"));
  });
});
