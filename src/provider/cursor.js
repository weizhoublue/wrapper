const acp = require("./acp");
const log = require("../log");

// Global agent flags before `acp` subcommand (tool/MCP auto-approve for file edit, shell, etc.)
const FLAGS_BEFORE_ACP = ["--yolo", "--approve-mcps"];

function hasFlag(parts, flag) {
  if (parts.includes(flag)) return true;
  if (flag === "--yolo" && (parts.includes("-f") || parts.includes("--force"))) return true;
  return parts.some((p) => p.startsWith(flag + "="));
}

function ensureFlags(command) {
  const parts = command.trim().split(/\s+/);
  let acpIdx = parts.indexOf("acp");
  if (acpIdx === -1) {
    parts.splice(1, 0, "acp");
    acpIdx = 1;
  }
  const toInsert = FLAGS_BEFORE_ACP.filter((flag) => !hasFlag(parts, flag));
  if (toInsert.length) {
    parts.splice(acpIdx, 0, ...toInsert);
  }
  return parts.join(" ");
}

async function createSession(opts) {
  const command = ensureFlags(opts.command);
  log.debug("cursor provider: creating session command=%s resume=%s",
    command, opts.resume || "(none)");
  return acp.createSession({ ...opts, command, provider: "cursor" });
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

module.exports = {
  createSession,
  send,
  closeSession,
  run,
  ensureFlags,
  extractText: acp.extractText,
  extractThinking: acp.extractThinking,
  splitCommand: acp.splitCommand,
};
