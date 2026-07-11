#!/usr/bin/env node
const path = require("path");
const os = require("os");
const fs = require("fs");
const log = require("./log");
const { LimitMsg, isQuotaExceeded, quotaReasonBrief } = require("./limit-msg");
const { checkThrottle, recordExhausted, toLocalISOString } = require("./throttle");
const { splitCommand } = require("./command");
const { routeCli } = require("./cli/route");
const { parseRunArgs, DEFAULTS } = require("./cli/run");

function which(cmd) {
  const { spawnSync } = require("child_process");
  try {
    const result = spawnSync("which", [cmd], { stdio: "pipe" });
    return result.status === 0 ? result.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}


const DEFAULT_TIMEOUT = 3600; // 1 hour per attempt

function isOutputEmpty(stdout) {
  return stdout.trim() === "";
}

function canRetry(stdout, regex) {
  if (isOutputEmpty(stdout)) return true;
  if (regex && !regex.test(stdout)) return true;
  return false;
}

function resolveExitCode(result, regex) {
  if (!result) return EXIT_PROVIDER_ERROR;
  if (result.sessionCreationFailed) {
    return result.commandNotFound ? EXIT_COMMAND_NOT_FOUND : EXIT_PROVIDER_ERROR;
  }
  if (result.sendFailed) return EXIT_PROVIDER_ERROR;
  if (result.timedOut) return EXIT_TIMEOUT;
  if (result.throttleSkipped) return EXIT_THROTTLE_SKIP;
  if (result.quotaExceeded) return EXIT_QUOTA_EXCEEDED;
  if (result.exitCode && result.exitCode !== 0) return result.exitCode;
  if (result.excludeMatched) return EXIT_EXCLUDE_MATCH;
  if (result.exhausted) {
    return isOutputEmpty(result.stdout) ? EXIT_EMPTY_OUTPUT
      : (regex ? EXIT_REGEX_MISMATCH : EXIT_OK);
  }
  return result.exitCode ?? EXIT_OK;
}

function buildStderrOutput(agentCommandName, sessionId, result, exitCode) {
  const parts = [];
  const name = result.commandName;

  parts.push("");
  parts.push(`[${name}] stderr:`);
  if (result.stderr) parts.push(result.stderr);
  if (result.wrapperError) {
    parts.push("");
    parts.push(`[${name}] error:`);
    parts.push(result.wrapperError);
  }

  parts.push("");
  parts.push("[agent session]");
  parts.push(String(exitCode));
  if (agentCommandName) parts.push(agentCommandName);
  if (sessionId) parts.push(sessionId);
  return parts.join("\n");
}

const EXIT_OK = 0;
const EXIT_REGEX_MISMATCH = 200;
const EXIT_EMPTY_OUTPUT = 201;
const EXIT_PROVIDER_ERROR = 202;
const EXIT_TIMEOUT = 203;
const EXIT_COMMAND_NOT_FOUND = 204;
const EXIT_EXCLUDE_MATCH = 205;
const EXIT_QUOTA_EXCEEDED = 206;
const EXIT_THROTTLE_SKIP = 207;

function collapseBlankLines(text) {
  return text.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

function retryReason(stdout, regex) {
  if (isOutputEmpty(stdout)) return "empty output";
  if (regex) return `regex /${regex.source}/ not matched, stdout: ${stdout.slice(0, 80).replace(/\n/g, "\\n")}`;
  return "unknown";
}

function retryReasonBrief(stdout, regex) {
  if (isOutputEmpty(stdout)) return "empty output";
  if (regex) return `regex /${regex.source}/ not matched`;
  return "unknown";
}

function timeoutReasonBrief(seconds) {
  return `timed out after ${seconds}s`;
}

function excludeReason(stdout, regex) {
  return `exclude regex /${regex.source}/ matched, stdout: ${stdout.slice(0, 80).replace(/\n/g, "\\n")}`;
}

function excludeReasonBrief(regex) {
  return `exclude regex /${regex.source}/ matched`;
}

function exhaustedReason(stdout, regex, maxAttempts) {
  return `all ${maxAttempts} attempts exhausted: ${retryReasonBrief(stdout, regex)}`;
}

function logAttemptOutput(agentName, attempt, stdout, stderr) {
  log.debug("agent %s attempt session %d stdout:\n%s", agentName, attempt, stdout || "(empty)");
  log.debug("agent %s attempt session %d stderr:\n%s", agentName, attempt, stderr || "(empty)");
}

async function main() {
  const sub = routeCli(process.argv);
  if (sub === "throttle") {
    const { runThrottleCommand } = require("./cli/throttle-cmd");
    return runThrottleCommand(process.argv);
  }
  const opts = parseRunArgs(process.argv);
  const configDir = process.env.WRAPPER_CONFIG_DIR || path.join(os.homedir(), ".wrapper");
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  const throttleFile = path.join(configDir, "throttle.json");

  // Validate custom commands existence early
  for (const agent of opts.agents) {
    if (agent.command !== DEFAULTS[agent.type] && agent.command !== agent.type) {
      const { command: cmd } = splitCommand(agent.command);
      if (!which(cmd)) {
        process.stderr.write(`Error: command not found: ${cmd}\n`);
        process.exit(EXIT_COMMAND_NOT_FOUND);
      }
    }
  }

  if (opts.debug) log.setDebug(true);

  log.info("wrapper starting: agents=%d", opts.agents.length);
  for (const a of opts.agents) {
    log.debug("  agent type=%s command=%s commandName=%s", a.type, a.command, a.commandName);
  }
  log.debug("prompt=%s timeout=%ds retry=%d reg=%s exclude=%s quota=%s",
    opts.prompt.slice(0, 100), opts.timeout, opts.retry, opts.reg || "(none)", opts.exclude || "(none)", opts.quota);
  log.debug("config dir=%s (WRAPPER_CONFIG_DIR=%s)", configDir, process.env.WRAPPER_CONFIG_DIR || "(unset, using default)");
  log.debug("throttle=%s duration=%dmin file=%s",
    opts.throttle ? "enabled" : "disabled", opts.throttleDuration, throttleFile);

  const providers = {
    claude: require("./provider/claude"),
    codex: require("./provider/codex"),
    copilot: require("./provider/copilot"),
    gemini: require("./provider/gemini"),
    cursor: require("./provider/cursor"),
    agy: require("./provider/agy"),
    opencode: require("./provider/opencode"),
  };

  const regex = opts.reg ? new RegExp(opts.reg, "i") : null;
  const excludeRegex = opts.exclude ? new RegExp(opts.exclude, "i") : null;
  const allResults = []; // { commandName, stdout, stderr, sessionId, ... }

  for (let agentIdx = 0; agentIdx < opts.agents.length; agentIdx++) {
    const agent = opts.agents[agentIdx];
    const provider = providers[agent.type];
    if (!provider) {
      process.stderr.write(`Error: unknown provider type: ${agent.type}\n`);
      process.exit(EXIT_PROVIDER_ERROR);
    }

    log.info("trying agent %d/%d: %s (%s)", agentIdx + 1, opts.agents.length, agent.commandName, agent.type);
    log.setContext({ agentName: agent.commandName });

    // --- throttle check ---
    if (opts.throttle) {
      const throttleCommand = agent.isCustom ? agent.command : null;
      const tr = checkThrottle(agent.type, throttleCommand, throttleFile);
      if (tr.throttled) {
        log.warn("agent %s is throttled until %s, skipping", agent.commandName, toLocalISOString(tr.endExhausted));
        allResults.push({
          commandName: agent.commandName,
          stdout: "",
          stderr: "",
          sessionId: "",
          throttleSkipped: true,
          wrapperError: `throttled until ${toLocalISOString(tr.endExhausted)}`,
        });
        if (agentIdx < opts.agents.length - 1) {
          log.error("agent %s throttled, falling back to next agent", agent.commandName);
          continue;
        }
        process.stdout.write("\n");
        const lastEntry = allResults[allResults.length - 1];
        process.stderr.write(buildStderrOutput(agent.commandName, "", lastEntry, EXIT_THROTTLE_SKIP) + "\n");
        process.exit(EXIT_THROTTLE_SKIP);
      }
    }
    // --- end throttle check ---

    let session;
    try {
      session = await provider.createSession({
        command: agent.command,
        timeout: opts.timeout,
        resume: opts.resume,
        isCustom: agent.isCustom || false,
      });
    } catch (err) {
      logAttemptOutput(agent.commandName, 1, "", "");
      log.error("failed to create session for %s: %s", agent.commandName, err.message);
      allResults.push({
        commandName: agent.commandName,
        stdout: "",
        stderr: "",
        sessionId: "",
        sessionCreationFailed: true,
        commandNotFound: err.message.startsWith("command not found"),
        wrapperError: `session creation failed: ${err.message}`,
      });
      if (agentIdx < opts.agents.length - 1) {
        log.error("agent %s failed, falling back to next agent", agent.commandName);
        continue;
      }
      // last agent — exit
      process.stdout.write("\n");
      const lastEntry = allResults[allResults.length - 1];
      const exitCode = err.message.startsWith("command not found") ? EXIT_COMMAND_NOT_FOUND : EXIT_PROVIDER_ERROR;
      process.stderr.write(buildStderrOutput(agent.commandName, "", lastEntry, exitCode) + "\n");
      return exitCode;
    }

    let lastResult = null;
    let agentSuccess = false;
    let agentDone = false; // whether broke retry loop due to timeout/error/non-zero exit

    try {
      const maxAttempts = Math.max(1, opts.retry);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        log.setContext({ agentName: agent.commandName, attempt: attempt + 1, maxAttempts });
        log.debug("agent %s attempt session %d/%d command=%s", agent.commandName, attempt + 1, maxAttempts, agent.command);
        log.info("agent %s attempt session %d/%d session=%s", agent.commandName, attempt + 1, maxAttempts, session.sessionId || "(pending)");

        if (opts.timeout > 0 && session.deadline !== undefined) {
          session.deadline = Date.now() + opts.timeout * 1000;
        }

        const attemptStartTime = performance.now();
        try {
          lastResult = await provider.send(session, opts.prompt);
        } catch (err) {
          const duration = ((performance.now() - attemptStartTime) / 1000).toFixed(2);
          log.debug("agent %s attempt session %d failed, duration: %ss", agent.commandName, attempt + 1, duration);
          logAttemptOutput(agent.commandName, attempt + 1, lastResult?.stdout, lastResult?.stderr);
          log.error("provider send failed for %s: %s", agent.commandName, err.message);
          allResults.push({
            commandName: agent.commandName,
            stdout: lastResult?.stdout || "",
            stderr: lastResult?.stderr || "",
            sessionId: session?.sessionId || "",
            sendFailed: true,
            wrapperError: `provider send failed: ${err.message}`,
          });
          agentDone = true;
          break; // fallback to next agent
        }

        const duration = ((performance.now() - attemptStartTime) / 1000).toFixed(2);
        log.debug("agent %s attempt session %d finished, duration: %s seconds", agent.commandName, attempt + 1, duration);
        log.debug("agent %s attempt session %d stdout output chars: %d",
          agent.commandName, attempt + 1, (lastResult.stdout || "").length);
        log.debug("agent %s attempt session %d stderr output chars: %d",
          agent.commandName, attempt + 1, (lastResult.stderr || "").length);

        if (lastResult.timedOut) {
          logAttemptOutput(agent.commandName, attempt + 1, lastResult.stdout, lastResult.stderr);
          log.error("agent %s attempt session %d: timed out after %ds", agent.commandName, attempt + 1, opts.timeout);
          if (attempt + 1 >= maxAttempts) {
            allResults.push({
              commandName: agent.commandName,
              stdout: lastResult.stdout || "",
              stderr: lastResult.stderr || "",
              sessionId: session.sessionId || lastResult.sessionId || "",
              timedOut: true,
              wrapperError: timeoutReasonBrief(opts.timeout),
            });
            agentDone = true;
          } else {
            const continueSessionId = session.sessionId || lastResult.sessionId || "";
            if (continueSessionId) {
              log.debug("retry: continuing session %s", continueSessionId);
            } else {
              log.debug("retry: no session id yet, starting fresh");
            }
          }
          continue;
        }

        if (lastResult.exitCode && lastResult.exitCode !== 0) {
          if (opts.quota && isQuotaExceeded(agent.type, lastResult.stdout, lastResult.stderr)) {
            const pattern = LimitMsg[agent.type];
            logAttemptOutput(agent.commandName, attempt + 1, lastResult.stdout, lastResult.stderr);
            log.error("agent %s attempt session %d: quota exceeded — /%s/i matched",
              agent.commandName, attempt + 1, pattern);
            allResults.push({
              commandName: agent.commandName,
              stdout: lastResult.stdout || "",
              stderr: lastResult.stderr || "",
              sessionId: session.sessionId || lastResult.sessionId || "",
              exitCode: lastResult.exitCode,
              quotaExceeded: true,
              wrapperError: quotaReasonBrief(pattern),
            });
            if (opts.throttle) {
              const throttleCommand = agent.isCustom ? agent.command : null;
              recordExhausted(agent.type, throttleCommand, opts.throttleDuration, throttleFile);
              log.error("agent %s quota exhausted, throttle recorded: %s, duration=%dmin, until=%s",
                agent.commandName, throttleFile, opts.throttleDuration,
                toLocalISOString(new Date(Date.now() + opts.throttleDuration * 60 * 1000)));
            }
            agentDone = true;
            break;
          }

          logAttemptOutput(agent.commandName, attempt + 1, lastResult.stdout, lastResult.stderr);
          log.error("agent %s attempt session %d: non-zero exit code %d", agent.commandName, attempt + 1, lastResult.exitCode);
          allResults.push({
            commandName: agent.commandName,
            stdout: lastResult.stdout || "",
            stderr: lastResult.stderr || "",
            sessionId: session.sessionId || lastResult.sessionId || "",
            exitCode: lastResult.exitCode,
            wrapperError: `non-zero exit code ${lastResult.exitCode}`,
          });
          agentDone = true;
          break; // fallback to next agent
        }

        if (excludeRegex && excludeRegex.test(lastResult.stdout)) {
          const reason = excludeReason(lastResult.stdout, excludeRegex);
          logAttemptOutput(agent.commandName, attempt + 1, lastResult.stdout, lastResult.stderr);
          log.error("agent %s attempt session %d: excluded pattern matched — %s", agent.commandName, attempt + 1, reason);
          allResults.push({
            commandName: agent.commandName,
            stdout: lastResult.stdout || "",
            stderr: lastResult.stderr || "",
            sessionId: session.sessionId || lastResult.sessionId || "",
            excludeMatched: true,
            wrapperError: excludeReasonBrief(excludeRegex),
          });
          agentDone = true;
          break; // break retry loop, fallback or exit
        }

        if (!canRetry(lastResult.stdout, regex)) {
          // success
          agentSuccess = true;
          allResults.push({
            commandName: agent.commandName,
            stdout: lastResult.stdout || "",
            stderr: lastResult.stderr || "",
            sessionId: session.sessionId || lastResult.sessionId || "",
          });
          break;
        }

        logAttemptOutput(agent.commandName, attempt + 1, lastResult.stdout, lastResult.stderr);
        const continueSessionId = session.sessionId || lastResult.sessionId || "";
        if (continueSessionId) {
          log.debug("retry: continuing session %s", continueSessionId);
        } else {
          log.debug("retry: no session id yet, starting fresh");
        }
        log.error("agent %s attempt session %d: retry needed — %s", agent.commandName, attempt + 1, retryReason(lastResult.stdout, regex));
      }

      // retry exhausted but not marked agentDone
      if (!agentSuccess && !agentDone) {
        log.error("agent %s: all %d attempt session exhausted: %s", agent.commandName, maxAttempts, retryReason(lastResult.stdout, regex));
        allResults.push({
          commandName: agent.commandName,
          stdout: lastResult?.stdout || "",
          stderr: lastResult?.stderr || "",
          sessionId: session.sessionId || lastResult?.sessionId || "",
          exhausted: true,
          wrapperError: exhaustedReason(lastResult?.stdout || "", regex, maxAttempts),
        });
      }
    } finally {
      try { await provider.closeSession(session); } catch {}
    }

    if (agentSuccess) {
      const out = collapseBlankLines(lastResult.stdout);
      process.stdout.write(out);
      if (!out.endsWith("\n")) process.stdout.write("\n");
      const lastEntry = allResults[allResults.length - 1];
      const exitCode = lastResult.exitCode || EXIT_OK;
      process.stderr.write(buildStderrOutput(agent.commandName, lastResult.sessionId || session.sessionId, lastEntry, exitCode) + "\n");
      return exitCode;
    }

    log.error("agent %s failed, %s", agent.commandName,
      agentIdx < opts.agents.length - 1 ? "falling back to next agent" : "no more agents");
  }

  log.clearContext();

  // all agents failed
  const lastAgent = opts.agents[opts.agents.length - 1];
  const lastAgentResult = allResults[allResults.length - 1];
  const out = collapseBlankLines(lastAgentResult?.stdout || "");
  process.stdout.write(out);
  if (!out.endsWith("\n")) process.stdout.write("\n");
  const exitCode = resolveExitCode(lastAgentResult, regex);
  process.stderr.write(buildStderrOutput(lastAgent.commandName, lastAgentResult?.sessionId || "", lastAgentResult, exitCode) + "\n");
  return exitCode;
}

if (require.main === module) {
  main()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((err) => {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exitCode = 2;
    });
}

module.exports = {
  main,
  parseRunArgs,
  parseArgs: parseRunArgs,
  routeCli,
  DEFAULTS,
  isOutputEmpty,
  canRetry,
  buildStderrOutput,
  collapseBlankLines,
  retryReason,
  timeoutReasonBrief,
  LimitMsg,
  isQuotaExceeded,
  quotaReasonBrief,
  DEFAULT_TIMEOUT,
  EXIT_OK,
  EXIT_REGEX_MISMATCH,
  EXIT_EMPTY_OUTPUT,
  EXIT_PROVIDER_ERROR,
  EXIT_TIMEOUT,
  EXIT_COMMAND_NOT_FOUND,
  EXIT_EXCLUDE_MATCH,
  EXIT_QUOTA_EXCEEDED,
  EXIT_THROTTLE_SKIP,
};
