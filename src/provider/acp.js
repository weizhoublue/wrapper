const { spawn } = require("child_process");
const { Writable, Readable } = require("stream");
const fs = require("fs");
const path = require("path");
const acp = require("@agentclientprotocol/sdk");
const log = require("../log");

const AUTH_PATTERNS = [
  /unauthorized/i,
  /not authenticated/i,
  /authentication required/i,
  /auth_required/i,
  /login required/i,
  /please log in/i,
  /run\s+.*\s+login/i,
];

const AUTH_HINTS = {
  cursor: "Run: agent login\n  Or set: CURSOR_API_KEY",
  copilot: "Run: copilot (ensure GitHub Copilot CLI is authenticated)",
  gemini: "Run: gemini auth login (or your gemini CLI login command)",
};

function isAuthError(err, childStderr = "") {
  const text = [err?.message, err?.code, String(childStderr)].filter(Boolean).join(" ");
  return AUTH_PATTERNS.some((re) => re.test(text));
}

function formatAuthHint(provider) {
  const hint = AUTH_HINTS[provider] || `Authenticate your ${provider} CLI`;
  return `Authentication required for ${provider}.\n  ${hint}`;
}

function wrapAcpError(provider, err, childStderr = "") {
  if (!isAuthError(err, childStderr)) return err;
  return new Error(formatAuthHint(provider));
}

class NonInteractiveClient {
  constructor() {
    this.notifications = [];
  }

  async requestPermission(params) {
    log.debug("acp: permission requested name=%s options=%d",
      params.toolCall?.title || "(none)", params.options?.length || 0);

    const allowOption = params.options?.find((o) =>
      o.kind === "allow" || o.kind === "always_allow"
    ) || params.options?.[0];

    if (allowOption) {
      this.notifications.push({ type: "permission", params, outcome: "allow" });
      return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
    }
    this.notifications.push({ type: "permission", params, outcome: "cancelled" });
    return { outcome: { outcome: "cancelled" } };
  }

  async sessionUpdate(params) {
    this.notifications.push({ type: "session_update", params });
  }

  async readTextFile(params) {
    try {
      const content = fs.readFileSync(params.path, "utf8");
      return { content };
    } catch {
      throw new acp.RequestError.resourceNotFound(params.path);
    }
  }

  async writeTextFile(params) {
    fs.mkdirSync(path.dirname(params.path), { recursive: true });
    fs.writeFileSync(params.path, params.content, "utf8");
    return {};
  }
}

class CursorNonInteractiveClient extends NonInteractiveClient {
  async askQuestion(params) {
    log.debug("acp: cursor/ask_question title=%s questions=%d",
      params.title || "(none)", params.questions?.length || 0);
    const answers = (params.questions || []).map((q) => ({
      questionId: q.id,
      selectedOptionIds: q.options?.[0]?.id ? [q.options[0].id] : [],
    }));
    return { outcome: { outcome: "answered", answers } };
  }

  async createPlan(params) {
    log.debug("acp: cursor/create_plan name=%s", params.name || "(none)");
    return { outcome: { outcome: "accepted" } };
  }

  async updateTodos(params) {
    log.debug("acp: cursor/update_todos count=%d merge=%s",
      params.todos?.length || 0, params.merge);
  }

  async task(params) {
    log.debug("acp: cursor/task description=%s", params.description || "(none)");
  }

  async generateImage(params) {
    log.debug("acp: cursor/generate_image desc=%s",
      (params.description || "(none)").slice(0, 60));
  }
}

function splitCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}

function which(cmd) {
  const { spawnSync } = require("child_process");
  const result = spawnSync("which", [cmd], { stdio: "pipe" });
  return result.status === 0 ? result.stdout.toString().trim() : null;
}

function extractText(notifications, response) {
  const parts = [];

  for (const n of notifications) {
    if (n.type !== "session_update") continue;
    const update = n.params?.update;
    if (!update) continue;

    if (update.sessionUpdate === "agent_message_chunk") {
      const c = update.content;
      if (c?.type === "text" && c.text) parts.push(c.text);
    }
  }

  for (const block of response?.content || []) {
    if (block.type === "text" && block.text) parts.push(block.text);
  }

  return parts.join("");
}

function extractThinking(notifications, response) {
  const parts = [];

  for (const n of notifications) {
    if (n.type !== "session_update") continue;
    const update = n.params?.update;
    if (!update) continue;

    if (update.sessionUpdate === "agent_thought_chunk") {
      const c = update.content;
      if (c?.thought) parts.push(c.thought);
    }
  }

  for (const block of response?.content || []) {
    if (block.type === "reasoning" || block.type === "thinking") {
      const text = block.reasoning || block.thinking || block.text || "";
      if (text) parts.push(text);
    }
  }

  return parts.join("");
}

async function createSession({ command, timeout, resume, provider = "copilot" }) {
  const { command: cmd, args } = splitCommand(command);

  const resolved = which(cmd);
  if (!resolved) {
    throw new Error(`command not found: ${cmd}`);
  }
  log.debug("acp: resolved command=%s args=%j provider=%s", resolved, args, provider);

  const child = spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  let childStderr = "";
  child.stderr.on("data", (chunk) => { childStderr += chunk.toString(); });

  let childError = null;
  child.on("error", (err) => { childError = err; });

  const ClientClass = provider === "cursor" ? CursorNonInteractiveClient : NonInteractiveClient;
  const client = new ClientClass();
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );
  const connection = new acp.ClientSideConnection((_agent) => client, stream);

  const deadline = timeout > 0 ? Date.now() + timeout * 1000 : Infinity;

  try {
    if (childError) {
      throw childError;
    }

    const initResult = await withDeadline(
      connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      }),
      deadline,
    );
    log.debug("acp: initialized v%d agent=%s", initResult.protocolVersion,
      JSON.stringify(initResult.agentInfo));

    if (provider === "cursor") {
      await withDeadline(
        connection.authenticate({ methodId: "cursor_login" }),
        deadline,
      );
      log.debug("acp: cursor authenticate ok");
    }

    let sessionId;
    if (resume) {
      await withDeadline(
        connection.loadSession({ sessionId: resume, cwd: process.cwd(), mcpServers: [] }),
        deadline,
      );
      sessionId = resume;
      log.debug("acp: loaded session id=%s", sessionId);
    } else {
      const sessionResult = await withDeadline(
        connection.newSession({ cwd: process.cwd(), mcpServers: [] }),
        deadline,
      );
      sessionId = sessionResult.sessionId;
      log.debug("acp: new session id=%s", sessionId);
    }

    return {
      child,
      connection,
      client,
      sessionId,
      provider,
      childStderr: () => childStderr,
      childError: () => childError,
      deadline,
      closed: false,
    };
  } catch (err) {
    const wrapped = wrapAcpError(provider, err, childStderr);
    if (childStderr.trim()) {
      try {
        wrapped.message = `${wrapped.message}. Stderr:\n${childStderr.trim()}`;
      } catch {
        const newErr = new Error(`${wrapped.message}. Stderr:\n${childStderr.trim()}`);
        newErr.code = wrapped.code;
        throw newErr;
      }
    }
    throw wrapped;
  }
}

async function send(session, prompt) {
  if (session.closed) throw new Error("session closed");

  session.client.notifications.length = 0;

  log.debug("acp: sending prompt=%s", prompt.slice(0, 80));

  const timeoutMs = session.deadline === Infinity
    ? 0
    : Math.max(0, session.deadline - Date.now());

  if (timeoutMs < 0) {
    return { stdout: "", stderr: session.childStderr(), sessionId: session.sessionId, exitCode: 1, timedOut: true };
  }

  try {
    const responsePromise = session.connection.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: prompt }],
    });

    let response;
    if (timeoutMs > 0) {
      response = await Promise.race([
        responsePromise,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutMs)
        ),
      ]);
    } else {
      response = await responsePromise;
    }

    const stdout = extractText(session.client.notifications, response);
    const stderr = extractThinking(session.client.notifications, response);

    log.debug("acp: stopReason=%s stdoutLen=%d", response.stopReason, stdout.length);

    return { stdout, stderr: stderr || session.childStderr(), sessionId: session.sessionId, exitCode: 0 };
  } catch (err) {
    if (err.message === "timeout") {
      log.debug("acp: timeout");
      return { stdout: "", stderr: session.childStderr(), sessionId: session.sessionId, exitCode: 1, timedOut: true };
    }
    throw wrapAcpError(session.provider, err, session.childStderr());
  }
}

async function closeSession(session) {
  if (session.closed) return;
  session.closed = true;
  log.debug("acp: closing");
  try {
    session.child.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try { session.child.kill("SIGKILL"); } catch {}
  }, 2000).unref();
}

async function run(opts) {
  const session = await createSession(opts);
  try {
    return await send(session, opts.prompt);
  } finally {
    await closeSession(session);
  }
}

async function withDeadline(promise, deadline) {
  if (deadline === Infinity) return promise;
  const timeoutMs = Math.max(0, deadline - Date.now());
  if (timeoutMs <= 0) throw new Error("deadline exceeded before request");
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("acp request timed out")), timeoutMs)
    ),
  ]);
}

module.exports = {
  createSession,
  send,
  closeSession,
  run,
  extractText,
  extractThinking,
  splitCommand,
  isAuthError,
  formatAuthHint,
  wrapAcpError,
  NonInteractiveClient,
  CursorNonInteractiveClient,
};
