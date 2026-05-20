const { describe, it } = require("node:test");
const assert = require("node:assert");
const { isAuthError, formatAuthHint, wrapAcpError } = require("../../src/provider/acp");

describe("isAuthError", () => {
  it("matches unauthorized in message", () => {
    assert.strictEqual(isAuthError(new Error("401 Unauthorized"), ""), true);
  });

  it("matches login required in stderr", () => {
    assert.strictEqual(isAuthError(new Error("failed"), "please log in first"), true);
  });

  it("returns false for unrelated errors", () => {
    assert.strictEqual(isAuthError(new Error("connection reset"), "timeout"), false);
  });
});

describe("formatAuthHint", () => {
  it("includes cursor login instructions", () => {
    const hint = formatAuthHint("cursor");
    assert.match(hint, /agent login/i);
    assert.match(hint, /CURSOR_API_KEY/i);
  });

  it("includes copilot hint", () => {
    assert.match(formatAuthHint("copilot"), /copilot/i);
  });
});

describe("wrapAcpError", () => {
  it("wraps auth errors with hint", () => {
    const err = wrapAcpError("cursor", new Error("not authenticated"), "");
    assert.match(err.message, /Authentication required for cursor/i);
    assert.match(err.message, /agent login/i);
  });

  it("rethrows non-auth errors unchanged", () => {
    const orig = new Error("spawn failed");
    const err = wrapAcpError("cursor", orig, "");
    assert.strictEqual(err, orig);
  });
});
