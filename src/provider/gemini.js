const acp = require("./acp");
const log = require("../log");

// --acp enables Agent Client Protocol mode.
// --approval-mode=yolo auto-approves all actions without interactive prompts.
// --skip-trust skips workspace trust confirmation.
const REQUIRED_FLAGS = ["--acp"];
const REQUIRED_PAIRS = [
  { flag: "--approval-mode", value: "yolo" },
  { flag: "--skip-trust", value: null },
];

function hasFlag(parts, flag) {
  return parts.some((p) => p === flag || p.startsWith(flag + "="));
}

function ensureFlags(command) {
  const parts = command.trim().split(/\s+/);
  for (const flag of REQUIRED_FLAGS) {
    if (!parts.includes(flag)) {
      parts.splice(1, 0, flag);
    }
  }
  for (const { flag, value } of REQUIRED_PAIRS) {
    if (value === null) {
      if (!hasFlag(parts, flag)) parts.push(flag);
    } else {
      const eqForm = flag + "=" + value;
      // already has the correct --flag=value form
      if (parts.includes(eqForm)) continue;
      // remove any incorrect --flag=<wrongvalue> or --flag <wrongvalue>
      const eqIdx = parts.findIndex((p) => p.startsWith(flag + "="));
      if (eqIdx !== -1) {
        parts.splice(eqIdx, 1);
      } else {
        const spaceIdx = parts.indexOf(flag);
        if (spaceIdx !== -1) parts.splice(spaceIdx, 2);
      }
      parts.push(eqForm);
    }
  }
  return parts.join(" ");
}

async function createSession(opts) {
  const command = ensureFlags(opts.command);
  log.debug("gemini provider: creating session command=%s resume=%s", command, opts.resume || "(none)");
  return acp.createSession({ ...opts, command });
}

async function send(session, prompt) {
  return acp.send(session, prompt);
}

async function closeSession(session) {
  return acp.closeSession(session);
}

async function run(opts) {
  const session = await createSession(opts);
  try {
    return await send(session, opts.prompt);
  } finally {
    await closeSession(session);
  }
}

module.exports = { createSession, send, closeSession, run, extractText: acp.extractText, extractThinking: acp.extractThinking, splitCommand: acp.splitCommand };
