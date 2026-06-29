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
    const opts = parseArgs(["node", "main.js", "-p", "hi", "--no-quota"]);
    assert.strictEqual(opts.quota, false);
  });

  it("parses -n short form for --no-quota", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "-n"]);
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
      opencode: { stdout: "", stderr: "free_tier_limit" },
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

  it("matches opencode free_tier_limit in stderr", () => {
    assert.strictEqual(
      isQuotaExceeded("opencode", "", "free_tier_limit"),
      true,
    );
  });

  it("matches opencode account_rate_limit in stdout", () => {
    assert.strictEqual(
      isQuotaExceeded("opencode", "account_rate_limit exceeded", ""),
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
  it("single agent output with agentCommandName and sessionId", () => {
    const result = buildStderrOutput("claude", "sid-1", [
      { commandName: "claude", stdout: "", stderr: "some error" },
    ]);
    assert.ok(result.endsWith("sid-1"));
    const lines = result.split("\n");
    assert.strictEqual(lines[lines.length - 1], "sid-1");
    assert.strictEqual(lines[lines.length - 2], "claude");
  });

  it("multi agent output aggregates all results with labels", () => {
    const result = buildStderrOutput("codex", "sid-2", [
      { commandName: "copilot", stdout: "cop-out", stderr: "cop-err" },
      { commandName: "codex", stdout: "", stderr: "cdx-err" },
    ]);
    const lines = result.split("\n");
    // 最后两行
    assert.strictEqual(lines[lines.length - 1], "sid-2");
    assert.strictEqual(lines[lines.length - 2], "codex");
    // 包含分隔标记
    assert.ok(result.includes("[copilot] stderr:"));
    assert.ok(result.includes("cop-err"));
    assert.ok(result.includes("[copilot] stdout:"));
    assert.ok(result.includes("cop-out"));
    assert.ok(result.includes("[codex] stderr:"));
    assert.ok(result.includes("cdx-err"));
  });

  it("always labels stdout and stderr before agent name", () => {
    const result = buildStderrOutput("claude", "sid-3", [
      { commandName: "claude", stdout: "", stderr: "" },
    ]);
    const lines = result.split("\n");
    assert.strictEqual(lines[lines.length - 1], "sid-3");
    assert.strictEqual(lines[lines.length - 2], "claude");
    assert.ok(result.includes("[claude] stdout:"));
    assert.ok(result.includes("[claude] stderr:"));
    assert.ok(!result.includes("[claude] error:"));
  });

  it("orders stdout, stderr, then wrapper error", () => {
    const result = buildStderrOutput("cursor", "sid-5", [
      {
        commandName: "cursor",
        stdout: "Hello!",
        stderr: "agent stderr line",
        wrapperError: "all 3 attempts exhausted: regex /bad/ not matched",
      },
    ]);
    const stdoutIdx = result.indexOf("[cursor] stdout:");
    const stderrIdx = result.indexOf("[cursor] stderr:");
    const errorIdx = result.indexOf("[cursor] error:");
    assert.ok(stdoutIdx < stderrIdx);
    assert.ok(stderrIdx < errorIdx);
    assert.ok(result.includes("Hello!"));
    assert.ok(result.includes("agent stderr line"));
    assert.ok(result.includes("all 3 attempts exhausted: regex /bad/ not matched"));
    assert.ok(!result.includes("stdout: Hello!"));
  });

  it("includes wrapper failure reason in error section only", () => {
    const result = buildStderrOutput("codex", "sid-4", [
      {
        commandName: "codex",
        stdout: "Hello.",
        stderr: "Reading additional input from stdin...",
        wrapperError: "exclude regex /hello/ matched",
      },
    ]);
    assert.ok(result.includes("[codex] stdout:\nHello."));
    assert.ok(result.includes("[codex] stderr:\nReading additional input from stdin..."));
    assert.ok(result.includes("[codex] error:\nexclude regex /hello/ matched"));
  });

  it("includes quota exceeded wrapper error in error section", () => {
    const result = buildStderrOutput("codex", "sid-q", [
      {
        commandName: "codex",
        stdout: "",
        stderr: "You've hit your usage limit",
        wrapperError: "quota exceeded: /hit your usage limit/i matched",
      },
    ]);
    assert.ok(result.includes("[codex] stderr:\nYou've hit your usage limit"));
    assert.ok(result.includes("[codex] error:\nquota exceeded: /hit your usage limit/i matched"));
  });
});
