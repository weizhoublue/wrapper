const { spawn } = require("child_process");
const readline = require("readline");
const log = require("../log");
const { splitCommand } = require("../command");

function which(cmd) {
  const { spawnSync } = require("child_process");
  const result = spawnSync("which", [cmd], { stdio: "pipe" });
  return result.status === 0 ? result.stdout.toString().trim() : null;
}

function extractText(events) {
  const parts = [];
  for (const e of events) {
    if (e.type === "item.completed" && e.item?.type === "agent_message" && e.item.text) {
      parts.push(e.item.text);
    }
  }
  return parts.join("");
}

function extractThinking(events) {
  const parts = [];
  for (const e of events) {
    if (e.type === "item.completed" && e.item?.type === "reasoning" && e.item.text) {
      parts.push(e.item.text);
    }
  }
  return parts.join("");
}

function extractSessionId(events) {
  for (const e of events) {
    if (e.type === "thread.started" && e.thread_id) return e.thread_id;
  }
  return null;
}

// --json and --dangerously-bypass-approvals-and-sandbox are required for
// non-interactive NDJSON output. Without them codex hangs waiting for
// interactive approval or outputs ANSI text we can't parse.
const REQUIRED_FLAGS = ["--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check"];

function ensureFlags(args, resume) {
  const out = [...args];
  if (!out.includes("exec")) {
    out.unshift("exec");
  }

  // Insert "resume <id>" after "exec" if -s was specified and not already present
  if (resume && !out.includes("resume")) {
    const execIdx = out.indexOf("exec");
    out.splice(execIdx + 1, 0, "resume", resume);
  }

  for (const flag of REQUIRED_FLAGS) {
    if (!out.includes(flag)) {
      // Insert --json right after "exec", others append at end
      if (flag === "--json") {
        const execIdx = out.indexOf("exec");
        out.splice(execIdx + 1, 0, flag);
      } else {
        out.push(flag);
      }
    }
  }
  return out;
}

function insertResumeAfterExec(args, sessionId) {
  if (!sessionId || args.includes("resume")) return args;
  const execIdx = args.indexOf("exec");
  if (execIdx < 0) return args;
  const out = [...args];
  out.splice(execIdx + 1, 0, "resume", sessionId);
  return out;
}

async function createSession({ command, timeout, resume }) {
  const { command: cmd, args: baseArgs } = splitCommand(command);

  const resolved = which(cmd);
  if (!resolved) {
    throw new Error(`command not found: ${cmd}`);
  }

  const safeArgs = ensureFlags(baseArgs, resume);
  log.debug("codex: resolved=%s baseArgs=%j safeArgs=%j", resolved, baseArgs, safeArgs);

  return {
    cmd,
    baseArgs: safeArgs,
    sessionId: resume || null,
    deadline: timeout > 0 ? Date.now() + timeout * 1000 : Infinity,
    closed: false,
  };
}

// codex background tasks (model refresh, MCP init) may outlive the
// exec subprocess. Exiting too soon orphans them, producing spurious
// stderr errors. Wait at least this long from spawn before resolving.
const MIN_WAIT_MS = 10000;

async function send(session, prompt) {
  if (session.closed) throw new Error("session closed");

  // Concat base args + prompt (prompt is the final positional argument)
  const args = [...insertResumeAfterExec(session.baseArgs, session.sessionId), prompt];

  log.debug("codex: spawning %s %j", session.cmd, args);

  return new Promise((resolve, reject) => {
    const spawnTime = Date.now();
    const child = spawn(session.cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const events = [];
    let childStderr = "";
    let timedOut = false;
    let timer = null;
    let settled = false;

    function settle(result) {
      if (settled) return;
      settled = true;
      resolve(result);
    }

    function killChild() {
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000).unref();
    }

    function drainAndUnref() {
      try { rl.close(); } catch {}
      try { child.stdout.destroy(); } catch {}
      try { child.stderr.destroy(); } catch {}
      try { child.unref(); } catch {}
    }

    if (session.deadline !== Infinity) {
      const remaining = session.deadline - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        killChild();
        child.on("error", () => {});
        try { child.stdout.destroy(); } catch {}
        try { child.stderr.destroy(); } catch {}
        try { child.unref(); } catch {}
        settle({ stdout: "", stderr: "", sessionId: session.sessionId, exitCode: 1, timedOut: true });
        return;
      }
      timer = setTimeout(() => {
        timedOut = true;
        killChild();
        // Resolve immediately. Do NOT wait for child.on("close"): if codex's
        // tool subprocesses inherited the pipe fd they will keep it open even
        // after codex is SIGKILL'd, so "close" may never fire.
        const stdout = extractText(events);
        const stderr = extractThinking(events) || childStderr.trim();
        const extractedId = extractSessionId(events);
        if (extractedId) session.sessionId = extractedId;
        log.debug("codex: timeout sessionId=%s stdoutLen=%d stderrLen=%d",
          session.sessionId, stdout.length, stderr.length);
        drainAndUnref();
        settle({ stdout, stderr: stderr || undefined, sessionId: session.sessionId, exitCode: 1, timedOut: true });
      }, remaining);
    }

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      try {
        events.push(JSON.parse(line));
      } catch {
        log.debug("codex: non-JSON line: %s", line.slice(0, 80));
      }
    });

    child.stderr.on("data", (chunk) => { childStderr += chunk.toString(); });

    child.on("close", (exitCode) => {
      if (timer) clearTimeout(timer);

      const stdout = extractText(events);
      const stderr = extractThinking(events) || childStderr.trim();
      const extractedId = extractSessionId(events);
      if (extractedId) session.sessionId = extractedId;

      const finish = () => {
        log.debug("codex: exitCode=%d sessionId=%s stdoutLen=%d stderrLen=%d timedOut=%s",
          exitCode, session.sessionId, stdout.length, stderr.length, timedOut);
        settle({
          stdout,
          stderr: stderr || undefined,
          sessionId: session.sessionId,
          exitCode: timedOut ? 1 : (exitCode || 0),
          timedOut,
        });
      };

      if (timedOut) {
        finish();
        return;
      }

      const elapsed = Date.now() - spawnTime;
      const remaining = MIN_WAIT_MS - elapsed;
      if (remaining > 0) {
        // Clamp to global deadline if set
        const maxWait = session.deadline !== Infinity
          ? Math.max(0, session.deadline - Date.now())
          : remaining;
        const wait = Math.min(remaining, maxWait);
        log.debug("codex: min-wait elapsed=%ss remaining=%ss wait=%ss",
          (elapsed / 1000).toFixed(2),
          (remaining / 1000).toFixed(2),
          (wait / 1000).toFixed(2));
        setTimeout(finish, wait);
      } else {
        finish();
      }
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (!settled) reject(err);
    });
  });
}

async function closeSession(session) {
  if (session.closed) return;
  session.closed = true;
  log.debug("codex: session closed");
}

async function run(opts) {
  const session = await createSession(opts);
  try {
    return await send(session, opts.prompt);
  } finally {
    await closeSession(session);
  }
}

module.exports = { createSession, send, closeSession, run, extractText, extractThinking, extractSessionId, splitCommand, ensureFlags, insertResumeAfterExec };
