const { describe, it } = require("node:test");
const assert = require("node:assert");

const { parseArgs, isOutputEmpty, canRetry, collapseBlankLines, retryReason, EXIT_OK, EXIT_REGEX_MISMATCH, EXIT_EMPTY_OUTPUT, EXIT_PROVIDER_ERROR, EXIT_TIMEOUT } = require("../src/main");

describe("parseArgs", () => {
  it("parses required -p", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hello"]);
    assert.strictEqual(opts.prompt, "hello");
  });

  it("defaults -t to claude", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi"]);
    assert.strictEqual(opts.type, "claude");
  });

  it("resolves default command for claude type", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi"]);
    assert.strictEqual(opts.command, "claude --dangerously-skip-permissions --permission-mode=bypassPermissions");
  });

  it("respects explicit -c", () => {
    const opts = parseArgs(["node", "main.js", "-p", "hi", "-c", "my-claude"]);
    assert.strictEqual(opts.command, "my-claude");
  });

  it("parses all flags", () => {
    const opts = parseArgs(["node", "main.js",
      "-p", "test", "-t", "claude", "-c", "cc", "-d",
      "-e", "PASS", "-r", "5", "-o", "30"]);
    assert.strictEqual(opts.prompt, "test");
    assert.strictEqual(opts.type, "claude");
    assert.strictEqual(opts.command, "cc");
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
    assert.strictEqual(opts.retry, 2);
    assert.strictEqual(opts.timeout, 10);
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
});
