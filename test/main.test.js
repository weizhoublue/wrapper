const { describe, it } = require("node:test");
const assert = require("node:assert");

const { isOutputEmpty, canRetry, buildStderrOutput, collapseBlankLines, retryReason, LimitMsg, isQuotaExceeded, quotaReasonBrief, EXIT_OK, EXIT_REGEX_MISMATCH, EXIT_EMPTY_OUTPUT, EXIT_PROVIDER_ERROR, EXIT_TIMEOUT, EXIT_EXCLUDE_MATCH, EXIT_QUOTA_EXCEEDED } = require("../src/main");

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

  it("matches opencode 'usage limit reached' in stderr", () => {
    assert.strictEqual(
      isQuotaExceeded("opencode", "", "usage limit reached"),
      true,
    );
  });

  it("matches opencode 'usage limit reached' in stdout", () => {
    assert.strictEqual(
      isQuotaExceeded("opencode", "usage limit reached", ""),
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
