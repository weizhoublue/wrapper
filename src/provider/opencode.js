const { spawn } = require("child_process");
const readline = require("readline");
const log = require("../log");

function splitCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}

function which(cmd) {
  const { spawnSync } = require("child_process");
  const result = spawnSync("which", [cmd], { stdio: "pipe" });
  return result.status === 0 ? result.stdout.toString().trim() : null;
}

function extractText(events) {
  const parts = [];
  for (const e of events) {
    if (e.type === "text" && e.part?.text) {
      parts.push(e.part.text);
    }
  }
  return parts.join("");
}

function extractErrors(events) {
  const parts = [];
  for (const e of events) {
    if (e.type === "error") {
      const msg = e.error?.data?.message || e.error?.name || JSON.stringify(e.error);
      if (msg) parts.push(msg);
    }
  }
  return parts.join("\n");
}

function extractSessionId(events) {
  for (const e of events) {
    if (e.sessionID) return e.sessionID;
  }
  return null;
}

function inferExitCode(events, exitCode, timedOut) {
  if (timedOut) return 1;
  if (events.some((e) => e.type === "error")) return exitCode || 1;
  return exitCode || 0;
}

const REQUIRED_FLAGS = ["--dangerously-skip-permissions"];

function ensureFlags(args, resume) {
  const out = [...args];

  if (!out.includes("run")) {
    out.unshift("run");
  }

  if (!out.includes("--format")) {
    const runIdx = out.indexOf("run");
    out.splice(runIdx + 1, 0, "--format", "json");
  } else {
    const fmtIdx = out.indexOf("--format");
    if (out[fmtIdx + 1] !== "json") {
      out[fmtIdx + 1] = "json";
    }
  }

  for (const flag of REQUIRED_FLAGS) {
    if (!out.includes(flag)) {
      out.push(flag);
    }
  }

  if (resume && !out.includes("--session")) {
    out.push("--session", resume);
  }

  return out;
}

async function createSession({ command, timeout, resume }) {
  const { command: cmd, args: baseArgs } = splitCommand(command);

  const resolved = which(cmd);
  if (!resolved) {
    throw new Error(`command not found: ${cmd}`);
  }

  const safeArgs = ensureFlags(baseArgs, resume);
  log.debug("opencode: resolved=%s baseArgs=%j safeArgs=%j", resolved, baseArgs, safeArgs);

  return {
    cmd,
    baseArgs: safeArgs,
    sessionId: resume || null,
    deadline: timeout > 0 ? Date.now() + timeout * 1000 : Infinity,
    closed: false,
  };
}

async function send(session, prompt) {
  if (session.closed) throw new Error("session closed");

  const args = [...session.baseArgs];
  if (session.sessionId && !args.includes("--session")) {
    args.push("--session", session.sessionId);
  }
  args.push(prompt);

  log.debug("opencode: spawning %s %j", session.cmd, args);

  return new Promise((resolve, reject) => {
    const child = spawn(session.cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const events = [];
    let childStderr = "";
    let timedOut = false;
    let timer = null;

    if (session.deadline !== Infinity) {
      const remaining = session.deadline - Date.now();
      if (remaining <= 0) {
        resolve({
          stdout: "",
          stderr: "",
          sessionId: session.sessionId,
          exitCode: 1,
          timedOut: true,
        });
        return;
      }
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      }, remaining);
    }

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      try {
        events.push(JSON.parse(line));
      } catch {
        log.debug("opencode: non-JSON line: %s", line.slice(0, 80));
      }
    });

    child.stderr.on("data", (chunk) => { childStderr += chunk.toString(); });

    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);

      const stdout = extractText(events);
      const errors = extractErrors(events);
      const stderr = errors || childStderr.trim();
      const sessionId = extractSessionId(events) || session.sessionId;
      session.sessionId = sessionId;

      log.debug("opencode: exitCode=%d sessionId=%s stdoutLen=%d stderrLen=%d timedOut=%s",
        exitCode, sessionId, stdout.length, stderr.length, timedOut);

      resolve({
        stdout,
        stderr: stderr || undefined,
        sessionId,
        exitCode: inferExitCode(events, exitCode, timedOut),
        timedOut,
      });
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });
}

async function closeSession(session) {
  if (session.closed) return;
  session.closed = true;
  log.debug("opencode: session closed");
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
  extractText,
  extractErrors,
  extractSessionId,
  inferExitCode,
  splitCommand,
};
