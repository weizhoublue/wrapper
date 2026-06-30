const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const log = require("../log");

function splitCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  return { command: parts[0], args: parts.slice(1) };
}

function which(cmd) {
  const { spawnSync } = require("child_process");
  try {
    const result = spawnSync("which", [cmd], { stdio: "pipe" });
    return result.status === 0 ? result.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

const REQUIRED_FLAGS = ["--dangerously-skip-permissions"];
const PRINT_MODE_FLAGS = ["--print", "-p", "--prompt", "-i", "--prompt-interactive"];

function hasPrintMode(args) {
  return PRINT_MODE_FLAGS.some((flag) => args.includes(flag));
}

function insertConversationBeforePrint(args, sessionId) {
  if (!sessionId || args.includes("--conversation")) return [...args];
  const out = [...args];
  const printIdx = out.findIndex((a) => PRINT_MODE_FLAGS.includes(a));
  if (printIdx >= 0) {
    out.splice(printIdx, 0, "--conversation", sessionId);
  } else {
    out.push("--conversation", sessionId);
  }
  return out;
}

function ensureFlags(args, resume, logPath) {
  const out = [...args];
  
  // Inject log path
  if (!out.includes("--log-file")) {
    out.push("--log-file", logPath);
  }

  // Inject required flags
  for (const flag of REQUIRED_FLAGS) {
    if (!out.includes(flag)) {
      out.push(flag);
    }
  }

  // Inject conversation resume if specified
  if (resume && !out.includes("--conversation")) {
    out.push("--conversation", resume);
  }

  // Inject print mode if no interactive or print mode is present
  if (!hasPrintMode(out)) {
    out.push("--print");
  }

  return out;
}

function extractSessionIdFromLog(logPath) {
  try {
    if (!fs.existsSync(logPath)) return null;
    const logContent = fs.readFileSync(logPath, "utf8");
    const match = logContent.match(/Print mode: conversation=([a-f0-9-]+)/i) || 
                  logContent.match(/Created conversation ([a-f0-9-]+)/i);
    return match ? match[1] : null;
  } catch (err) {
    log.error("agy: failed to read log file %s: %s", logPath, err.message);
    return null;
  }
}

async function createSession({ command, timeout, resume }) {
  const { command: cmd, args: baseArgs } = splitCommand(command);

  const resolved = which(cmd);
  if (!resolved) {
    throw new Error(`command not found: ${cmd}`);
  }

  const logFilename = `agy_session_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.log`;
  const logPath = path.join(os.tmpdir(), logFilename);

  const safeArgs = ensureFlags(baseArgs, resume, logPath);
  log.debug("agy: resolved=%s baseArgs=%j safeArgs=%j logPath=%s", resolved, baseArgs, safeArgs, logPath);

  return {
    cmd: resolved,
    baseArgs: safeArgs,
    logPath,
    deadline: timeout > 0 ? Date.now() + timeout * 1000 : Infinity,
    closed: false,
    sessionId: resume || null,
  };
}

async function send(session, prompt) {
  if (session.closed) throw new Error("session closed");

  const args = insertConversationBeforePrint(session.baseArgs, session.sessionId);
  args.push(prompt);
  log.debug("agy: spawning %s %j", session.cmd, args);

  if (session.deadline !== Infinity && session.deadline - Date.now() <= 0) {
    return { stdout: "", stderr: "", sessionId: session.sessionId, exitCode: 1, timedOut: true };
  }

  return new Promise((resolve, reject) => {
    const child = spawn(session.cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let childStdout = "";
    let childStderr = "";
    let timedOut = false;
    let timer = null;

    if (session.deadline !== Infinity) {
      const remaining = session.deadline - Date.now();
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
      }, remaining);
    }

    child.stdout.on("data", (chunk) => { childStdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { childStderr += chunk.toString(); });

    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);

      const sessionId = extractSessionIdFromLog(session.logPath) || session.sessionId;
      session.sessionId = sessionId;
      
      // Clean up the log file
      try {
        if (fs.existsSync(session.logPath)) {
          fs.unlinkSync(session.logPath);
        }
      } catch (err) {
        log.error("agy: failed to delete log file %s: %s", session.logPath, err.message);
      }

      resolve({
        stdout: childStdout,
        stderr: childStderr.trim() || undefined,
        sessionId,
        exitCode: timedOut ? 1 : (exitCode || 0),
        timedOut,
      });
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      try {
        if (fs.existsSync(session.logPath)) {
          fs.unlinkSync(session.logPath);
        }
      } catch {}
      reject(err);
    });
  });
}

async function closeSession(session) {
  if (session.closed) return;
  session.closed = true;
  try {
    if (fs.existsSync(session.logPath)) {
      fs.unlinkSync(session.logPath);
    }
  } catch {}
  log.debug("agy: session closed");
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
  extractSessionIdFromLog,
  insertConversationBeforePrint,
};
