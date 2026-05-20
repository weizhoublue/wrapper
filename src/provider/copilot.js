const acp = require("./acp");
const log = require("../log");

// --acp is required for ACP protocol; without it copilot starts in
// interactive TUI and won't respond to JSON-RPC handshake.
// --allow-* / --no-ask-user prevent interactive permission prompts.
const REQUIRED_FLAGS = [
  "--acp",
  "--allow-all-tools",
  "--allow-all-paths",
  "--allow-all-urls",
  "--no-ask-user",
];

function ensureFlags(command) {
  const parts = command.trim().split(/\s+/);
  for (const flag of REQUIRED_FLAGS) {
    if (!parts.includes(flag)) {
      if (flag === "--acp") {
        parts.splice(1, 0, flag);
      } else {
        parts.push(flag);
      }
    }
  }
  return parts.join(" ");
}

async function createSession(opts) {
  const command = ensureFlags(opts.command);
  log.debug("copilot provider: creating session command=%s resume=%s", command, opts.resume || "(none)");
  return acp.createSession({ ...opts, command, provider: "copilot" });
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
