#!/usr/bin/env node
const { parseArgs: nodeParseArgs } = require("node:util");
const log = require("./log");

const DEFAULTS = {
  claude: "claude --dangerously-skip-permissions --permission-mode=bypassPermissions",
  codex: "codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check",
  copilot: "copilot --acp --allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user",
  gemini: "gemini --acp --approval-mode=yolo --skip-trust",
  cursor: "agent --yolo --approve-mcps acp",
};

const HELP = `Usage: wrapper -p <prompt> [options]

One-shot CLI wrapper for AI coding agents.

Required:
  -p, --prompt <text>     User prompt

Options:
  -t, --type <name>       Provider type: claude, codex, copilot, gemini, cursor (default: claude)
  -c, --command <cmd>     Command to execute (default: depends on -t)
  -d, --debug             Enable debug logging to stderr
  -e, --reg <pattern>     Regex pattern to match against output
  -r, --retry <n>         Max retry count (default: 3)
  -s, --resume <id>       Resume a previous session
  -o, --timeout <sec>     Timeout in seconds (default: 0, no timeout)
  -h, --help              Show this help

Output:
  stdout  = child process stdout
  stderr  = child process stderr + session ID (last line)
  exit code = child process exit code

Examples:
  wrapper -t claude -c "claude-free" -p "say hi in one word"

  wrapper -t claude -c "claude-free" -e "bingo|Bingo" -p "please say bingo in english"

  wrapper -t claude -c "claude-free" -p "tomorow will rain" 2>/tmp/sid
  session=$(tail -1 /tmp/sid)
  wrapper -t claude -c "claude-free" -s \${session} -p "tell me all what I have said in this session"

codex:
  wrapper -t codex -p "say hi in one word"

  wrapper -t codex  -p "tomorrow will rain" 2>/tmp/sid
  session=$(tail -1 /tmp/sid)
  wrapper -t codex -s \${session} -p  "tell me all what I have said in this session ?"

copilot:
  wrapper -t copilot -p "say hi in one word"

gemini:
  wrapper -t gemini -p "say hi in one word"

cursor:
  wrapper -t cursor -p "say hi in one word"

  wrapper -t cursor -p "tomorrow will rain" 2>/tmp/sid
  session=$(tail -1 /tmp/sid)
  wrapper -t cursor -s \${session} -p "tell me all what I have said in this session"

debug:
  wrapper -t claude -c "claude-free" -d -p "say hi in one word"
`;

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }

  const { values } = nodeParseArgs({
    args,
    options: {
      prompt:    { type: "string", short: "p" },
      type:      { type: "string", short: "t", default: "claude" },
      command:   { type: "string", short: "c" },
      debug:     { type: "boolean", short: "d", default: false },
      reg:       { type: "string", short: "e" },
      retry:     { type: "string", short: "r", default: "3" },
      resume:    { type: "string", short: "s" },
      timeout:   { type: "string", short: "o", default: "0" },
      help:      { type: "boolean", short: "h", default: false },
    },
  });

  if (!values.prompt) {
    throw new Error("required option '--prompt, -p' not specified. Use -h for help.");
  }

  const command = values.command || DEFAULTS[values.type] || values.type;
  const retry = parseInt(values.retry, 10);
  const timeout = parseInt(values.timeout, 10);

  return {
    prompt: values.prompt,
    type: values.type,
    command,
    debug: values.debug,
    reg: values.reg || "",
    retry: Number.isNaN(retry) ? 3 : retry,
    resume: values.resume || "",
    timeout: Number.isNaN(timeout) ? 0 : timeout,
  };
}

function isOutputEmpty(stdout) {
  return stdout.trim() === "";
}

function canRetry(stdout, regex) {
  if (isOutputEmpty(stdout)) return true;
  if (regex && !regex.test(stdout)) return true;
  return false;
}

function buildStderrOutput(sessionId, childStderr) {
  const parts = [];
  if (childStderr) parts.push(childStderr);
  if (sessionId) parts.push(sessionId);
  return parts.join("\n");
}

const EXIT_OK = 0;
const EXIT_REGEX_MISMATCH = 200;
const EXIT_EMPTY_OUTPUT = 201;
const EXIT_PROVIDER_ERROR = 202;
const EXIT_TIMEOUT = 203;
const EXIT_COMMAND_NOT_FOUND = 204;

function collapseBlankLines(text) {
  return text.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

function retryReason(stdout, regex) {
  if (isOutputEmpty(stdout)) return "empty output";
  if (regex) return `regex /${regex.source}/ not matched, stdout: ${stdout.slice(0, 80).replace(/\n/g, "\\n")}`;
  return "unknown";
}

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.debug) log.setDebug(true);

  log.info("wrapper starting: type=%s command=%s", opts.type, opts.command);
  log.debug("prompt=%s timeout=%ds retry=%d reg=%s",
    opts.prompt.slice(0, 100), opts.timeout, opts.retry, opts.reg || "(none)");

  const providers = {
    claude: require("./provider/claude"),
    codex: require("./provider/codex"),
    copilot: require("./provider/copilot"),
    gemini: require("./provider/gemini"),
    cursor: require("./provider/cursor"),
  };
  const provider = providers[opts.type];
  if (!provider) {
    log.error("unknown provider type: %s", opts.type);
    process.exit(EXIT_PROVIDER_ERROR);
  }

  const regex = opts.reg ? new RegExp(opts.reg) : null;
  let lastResult = null;

  // Create session once — reuse across retries
  let session;
  try {
    session = await provider.createSession({
      command: opts.command,
      timeout: opts.timeout,
      resume: opts.resume,
    });
  } catch (err) {
    log.error("failed to create session: %s", err.message);
    process.exit(err.message.startsWith("command not found") ? EXIT_COMMAND_NOT_FOUND : EXIT_PROVIDER_ERROR);
  }

  try {
    for (let attempt = 0; attempt <= opts.retry; attempt++) {
      log.info("attempt %d/%d session=%s", attempt + 1, opts.retry + 1, session.sessionId || "(pending)");

      try {
        lastResult = await provider.send(session, opts.prompt);
      } catch (err) {
        log.error("provider send failed: %s", err.message);
        await provider.closeSession(session);
        const out = collapseBlankLines(lastResult?.stdout || "");
        process.stdout.write(out);
        if (!out.endsWith("\n")) process.stdout.write("\n");
        process.stderr.write(buildStderrOutput(lastResult?.sessionId, err.message) + "\n");
        process.exit(EXIT_PROVIDER_ERROR);
      }

      if (lastResult.timedOut) {
        log.error("attempt %d: timed out after %ds", attempt + 1, opts.timeout);
        await provider.closeSession(session);
        const out = collapseBlankLines(lastResult.stdout || "");
        process.stdout.write(out);
        if (!out.endsWith("\n")) process.stdout.write("\n");
        process.stderr.write(buildStderrOutput(lastResult.sessionId, lastResult.stderr) + "\n");
        process.exit(EXIT_TIMEOUT);
      }

      if (!canRetry(lastResult.stdout, regex)) {
        await provider.closeSession(session);
        const out = collapseBlankLines(lastResult.stdout);
        process.stdout.write(out);
        if (!out.endsWith("\n")) process.stdout.write("\n");
        process.stderr.write(buildStderrOutput(lastResult.sessionId, lastResult.stderr) + "\n");
        process.exit(lastResult.exitCode || EXIT_OK);
      }

      log.info("attempt %d: retry needed — %s", attempt + 1, retryReason(lastResult.stdout, regex));
      log.debug("attempt %d stdout:\n%s", attempt + 1, lastResult.stdout || "(empty)");
      log.debug("attempt %d stderr:\n%s", attempt + 1, lastResult.stderr || "(empty)");
    }

    // all retries exhausted
    const reason = retryReason(lastResult.stdout, regex);
    log.error("all %d attempts exhausted: %s", opts.retry + 1, reason);

    await provider.closeSession(session);
    const out = collapseBlankLines(lastResult.stdout || "");
    process.stdout.write(out);
    if (!out.endsWith("\n")) process.stdout.write("\n");
    process.stderr.write(buildStderrOutput(lastResult.sessionId, lastResult.stderr) + "\n");

    const exitCode = isOutputEmpty(lastResult.stdout) ? EXIT_EMPTY_OUTPUT
      : (regex ? EXIT_REGEX_MISMATCH : EXIT_OK);
    process.exit(exitCode || EXIT_PROVIDER_ERROR);
  } catch (err) {
    try { await provider.closeSession(session); } catch {}
    log.error("unexpected error: %s", err.message);
    process.exit(EXIT_PROVIDER_ERROR);
  }
}

if (require.main === module) {
  main().catch((err) => {
    log.error("fatal: %s", err.message);
    process.exit(2);
  });
}

module.exports = { parseArgs, isOutputEmpty, canRetry, buildStderrOutput, collapseBlankLines, retryReason, EXIT_OK, EXIT_REGEX_MISMATCH, EXIT_EMPTY_OUTPUT, EXIT_PROVIDER_ERROR, EXIT_TIMEOUT, EXIT_COMMAND_NOT_FOUND };
