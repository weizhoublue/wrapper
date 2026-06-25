const { query } = require("@anthropic-ai/claude-agent-sdk");
const { createAsyncMessageInput } = require("./create-async-input");
const { spawn } = require("child_process");
const log = require("../log");

function splitCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}

function extractText(events) {
  const parts = [];
  for (const msg of events) {
    if (msg.type === "assistant") {
      for (const block of msg.message?.content || []) {
        if (block.type === "text") parts.push(block.text);
      }
    }
  }
  if (parts.length === 0) {
    for (const msg of events) {
      if (msg.type === "result" && msg.subtype === "success" && msg.result) {
        parts.push(msg.result);
      }
    }
  }
  return parts.join("");
}

function extractThinking(events) {
  const parts = [];
  for (const msg of events) {
    if (msg.type === "assistant") {
      for (const block of msg.message?.content || []) {
        if (block.type === "thinking" && block.thinking) {
          parts.push(block.thinking);
        }
      }
    }
  }
  return parts.join("");
}

function extractSessionId(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].session_id) return events[i].session_id;
  }
  return null;
}

function which(cmd) {
  const { spawnSync } = require("child_process");
  const result = spawnSync("which", [cmd], { stdio: "pipe" });
  return result.status === 0 ? result.stdout.toString().trim() : null;
}

// --dangerously-skip-permissions and --permission-mode=bypassPermissions are
// required for non-interactive mode. Without them claude may prompt for
// permissions and hang waiting for stdin input.
const REQUIRED_FLAGS = ["--dangerously-skip-permissions", "--permission-mode=bypassPermissions"];

function ensureFlags(args, resume) {
  let out = [...args];
  if (isRootUser()) {
    const beforeLen = out.length;
    out = removePermissionFlags(out);
    if (out.length < beforeLen) {
      log.debug("claude provider: running as root user, removed permission flags from args");
    } else {
      log.debug("claude provider: running as root user, skipping default required permission flags");
    }
  } else {
    for (const flag of REQUIRED_FLAGS) {
      if (flag === "--permission-mode=bypassPermissions") {
        const hasPM = out.some((a, i) =>
          a === "--permission-mode=bypassPermissions" ||
          (a === "--permission-mode" && out[i + 1] === "bypassPermissions")
        );
        if (!hasPM) out.push("--permission-mode", "bypassPermissions");
      } else if (!out.includes(flag)) {
        out.push(flag);
      }
    }
  }
  // Append --resume if specified and not already present
  if (resume && !out.includes("--resume")) {
    out.push("--resume", resume);
  }
  return out;
}

async function createSession({ command, timeout, resume }) {
  const { command: cmd, args: rawArgs } = splitCommand(command);
  const args = ensureFlags(rawArgs, resume);

  const resolved = which(cmd);
  if (!resolved) {
    throw new Error(`command not found: ${cmd}`);
  }
  log.debug("claude provider: command resolved to %s", resolved);

  const input = createAsyncMessageInput();

  const isRoot = isRootUser();
  const sdkOptions = {
    pathToClaudeCodeExecutable: resolved,
    includePartialMessages: true,
  };

  if (!isRoot) {
    sdkOptions.permissionMode = "bypassPermissions";
    sdkOptions.allowDangerouslySkipPermissions = true;
  } else {
    log.debug("claude provider: running as root user, disabling permission bypass in sdkOptions");
  }

  if (args.length > 0) {
    sdkOptions.spawnClaudeCodeProcess = (spawnOpts) => {
      log.debug("spawning: command=%s args=%j", cmd, [...args, ...spawnOpts.args]);
      return spawn(cmd, [...args, ...spawnOpts.args], {
        cwd: spawnOpts.cwd,
        env: spawnOpts.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    };
  }

  log.debug("claude provider: creating session command=%s args=%j", cmd, args);

  const q = query({ prompt: input.iterable, options: sdkOptions });

  const session = {
    input,
    q,
    events: [],
    sessionId: null,
    cmd,
    args,
    timeout,
    deadline: timeout > 0 ? Date.now() + timeout * 1000 : Infinity,
    closed: false,
  };

  // Start background pump
  session.pump = (async () => {
    try {
      for await (const msg of q) {
        session.events.push(msg);
        if (msg.session_id) session.sessionId = msg.session_id;
      }
    } catch (err) {
      session.pumpError = err;
      log.error("claude pump error: %s", err.message);
    }
  })();

  return session;
}

async function send(session, prompt) {
  if (session.closed) throw new Error("session closed");

  // Clear events from previous turn
  session.events.length = 0;
  const prevLen = 0;

  log.debug("claude provider: sending prompt=%s", prompt.slice(0, 80));

  session.input.push({
    type: "user",
    message: { role: "user", content: prompt },
    parent_tool_use_id: null,
  });

  // Wait for result event (global deadline from session creation)
  while (true) {
    if (session.pumpError) throw session.pumpError;

    const currentLen = session.events.length;

    for (let i = prevLen; i < currentLen; i++) {
      if (session.events[i].type === "result") {
        const events = session.events.slice(prevLen);
        const stdout = extractText(events);
        const stderr = extractThinking(events);
        const exitCode = session.events[i].subtype === "success" ? 0 : 1;
        log.debug("claude provider: exitCode=%d sessionId=%s stdoutLen=%d stderrLen=%d",
          exitCode, session.sessionId, stdout.length, stderr.length);
        return { stdout, stderr, sessionId: session.sessionId, exitCode };
      }
    }

    if (Date.now() >= session.deadline) {
      const events = session.events.slice(prevLen);
      const stdout = extractText(events);
      const stderr = extractThinking(events);
      log.debug("claude provider: timeout reached");
      return { stdout, stderr, sessionId: session.sessionId, exitCode: 1, timedOut: true };
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function closeSession(session) {
  if (session.closed) return;
  session.closed = true;
  log.debug("claude provider: closing session");
  session.input.end();
  session.q?.close?.();
  try { await session.pump; } catch {}
}

async function run(opts) {
  const session = await createSession(opts);
  try {
    return await send(session, opts.prompt);
  } finally {
    await closeSession(session);
  }
}
function isRootUser() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function removePermissionFlags(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dangerously-skip-permissions") {
      continue;
    }
    if (arg === "--permission-mode=bypassPermissions") {
      continue;
    }
    if (arg === "--permission-mode") {
      if (args[i + 1] === "bypassPermissions") {
        i++;
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}

module.exports = {
  createSession,
  send,
  closeSession,
  run,
  extractText,
  extractThinking,
  extractSessionId,
  splitCommand,
  isRootUser,
  removePermissionFlags,
  ensureFlags
};

