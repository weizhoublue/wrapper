#!/usr/bin/env node
const { parseArgs: nodeParseArgs } = require("node:util");
const log = require("./log");
const { LimitMsg, isQuotaExceeded, quotaReasonBrief } = require("./limit-msg");

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


const DEFAULT_TIMEOUT = 3600; // 1 hour per attempt

const DEFAULTS = {
  claude: "claude --dangerously-skip-permissions --permission-mode=bypassPermissions",
  codex: "codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check",
  copilot: "copilot --acp --allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user",
  gemini: "gemini --acp --approval-mode=yolo --skip-trust",
  cursor: "agent --yolo --approve-mcps acp",
  agy: "agy --dangerously-skip-permissions ",
  opencode: "opencode run --dangerously-skip-permissions --format json",
};

const HELP = `用法: wrapper -p <提示词> [选项]

一次性 AI 编码代理 CLI 封装器。

必填:
    -p, --prompt <文本>     用户提示词

选项:
    -t, --type <名称>        代理类型: claude, codex, copilot, gemini, cursor, agy, opencode (默认: claude)
                            可多次指定该选项，实现 fallback 调用 agent
    -c, --command <命令>     执行命令 (须紧跟 -t 之后，默认根据 -t 决定)
    -d, --debug             开启调试日志输出到 stderr
    -e, --reg <模式>         匹配标准输出的正则表达式(大小写不敏感)
                                如果匹配失败，则会重试运行命令 
    -x, --exclude <模式>     匹配标准输出的正则表达式(大小写不敏感)
                                如果匹配成功，则直接宣告当前 agent 失败，不再重试该 agent
    -q, --quota             开启 agent 订阅额度耗尽检测（默认开启）
                                  如果 agent 退出失败，且标准输出或标准错误输出中包含额度耗尽提示，
                                  则直接宣告当前 agent 失败，不再重试该 agent
    -n, --no-quota          关闭 agent 订阅额度耗尽检测
                                  当前支持 codex copilot gemini
                                  还不支持 claude cursor （不知道长什么样） 
                                  这些无法检测  agy（无任何提示）   opencode（卡住不退出）
    -r, --retry <次数>       每个 agent 最大重试次数 (默认: 3)
                                如果多次指定 -t，每个 agent 有独立的重试次数
                                如果不满足 -e 选项、-o 选项、 或者命令返回码非0、或者返回空的标准输出，则会重试运行
                                -x 选项匹配时，直接不重试
    -s, --resume <id>       恢复之前的会话（不能同多次调用 -t 配合）
    -o, --timeout <秒>      单次 attempt 超时秒数，超时后纳入 -r 重试 (默认: 3600，即 1 小时；0 表示不限时)
    -h, --help              显示此帮助
    -v, --version           显示版本号

输出:
    stdout  = 最后一个 agent 的标准输出
    stderr  = 所有 agent 的标准输出和错误输出 + 最终成功的 agent 名字 (倒数第二行) + 会话 ID (最后一行)
    退出码   = 最后一个 agent 的退出码

例子:
    wrapper -t claude -c "claude-deepseek-flash" -p "say hi in one word"

    wrapper -t claude -c "claude-deepseek-flash" -e "bingo|Bingo" -p "please say bingo in english"

    wrapper -t claude -c "claude-deepseek-flash"  -p "tomorow will rain" 2>/tmp/sid
    session=$(tail -1 /tmp/sid)
    wrapper -t claude -c "claude-deepseek-flash" -s \${session} -p "tell me all what I have said in this session"

多 agent fallback 例子:
    wrapper -t claude -c "claude-deepseek-flash" -t codex -t copilot -d -p  "say hi in one word" 2>/tmp/sid
    agentName=$( sed '$d' /tmp/sid | sed -n '$p' )
    session=$(tail -1 /tmp/sid)

codex:
    wrapper -t codex -p "say hi in one word"

    wrapper -t codex  -p "tomorrow will rain" 2>/tmp/sid
    session=$(tail -1 /tmp/sid)
    wrapper -t codex -s \${session} -p  "tell me all what I have said in this session ?"

copilot:
    wrapper -t copilot -p "say hi in one word"

gemini:
    wrapper -t gemini -p "say hi in one word"

agy:
   wrapper -t agy -p "say hi in one word"

cursor:
    wrapper -t cursor -p "say hi in one word"

    wrapper -t cursor -p "tomorrow will rain" 2>/tmp/sid
    session=$(tail -1 /tmp/sid)
    wrapper -t cursor -s \${session} -p "tell me all what I have said in this session"

opencode:
    wrapper -t opencode -p "say hi in one word"

    wrapper -t opencode -p "tomorrow will rain" 2>/tmp/sid
    session=$(tail -1 /tmp/sid)
    wrapper -t opencode -s \${session} -p "tell me all what I have said in this session"

debug:
    wrapper -t claude -c "claude-deepseek-flash" -d -p "tomorow will rain" 2>/tmp/sid
    agentName=$( sed '$d' /tmp/sid | sed -n '$p' )
    session=$(tail -1 /tmp/sid)
    echo ""
    cat /tmp/sid
    grep "attempt session" /tmp/sid
`;

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.includes("-v") || args.includes("--version")) {
    const pkg = require("../package.json");
    process.stdout.write(pkg.version + "\n");
    process.exit(0);
  }

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    process.stdout.write(HELP + "\n");
    process.exit(0);
  }

  // Phase 1: manual scan to extract -t/-c pairs
  const agents = [];
  const remainingArgs = [];
  let lastToken = null; // tracks whether previous token was -t <value>

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-t" || arg === "--type") {
      const value = args[++i];
      if (!value) throw new Error("missing value for -t/--type");
      agents.push({ type: value, command: null, commandName: value });
      lastToken = "type";
      continue;
    }

    if (arg === "-c" || arg === "--command") {
      const value = args[++i];
      if (!value) throw new Error("missing value for -c/--command");
      if (agents.length === 0) {
        throw new Error("-c/--command must follow a -t/--type option");
      }
      if (lastToken !== "type") {
        if (agents[agents.length - 1].command !== null) {
          throw new Error(`duplicate -c/--command for -t ${agents[agents.length - 1].type}`);
        }
        throw new Error("-c/--command must immediately follow -t/--type");
      }
      agents[agents.length - 1].command = value;
      agents[agents.length - 1].commandName = value;
      lastToken = "command";
      continue;
    }

    remainingArgs.push(arg);
    lastToken = "other";
  }

  // Default to claude when no -t specified
  if (agents.length === 0) {
    agents.push({ type: "claude", command: null, commandName: "claude" });
  }

  // Resolve default commands
  for (const agent of agents) {
    if (agent.command === null) {
      agent.command = DEFAULTS[agent.type] || agent.type;
    }
  }

  // Strip -q/--quota and -n/--no-quota before strict parse (symmetric boolean flags)
  let quotaExplicit = null; // null → default true
  const parsedRemainingArgs = [];
  for (const arg of remainingArgs) {
    if (arg === "--no-quota" || arg === "-n") {
      if (quotaExplicit === true) {
        throw new Error("conflicting options: -q/--quota and -n/--no-quota");
      }
      quotaExplicit = false;
    } else if (arg === "--quota" || arg === "-q") {
      if (quotaExplicit === false) {
        throw new Error("conflicting options: -q/--quota and -n/--no-quota");
      }
      quotaExplicit = true;
    } else {
      parsedRemainingArgs.push(arg);
    }
  }

  // Phase 2: parse remaining options
  const { values } = nodeParseArgs({
    args: parsedRemainingArgs,
    options: {
      prompt:    { type: "string", short: "p" },
      debug:     { type: "boolean", short: "d", default: false },
      reg:       { type: "string", short: "e" },
      exclude:   { type: "string", short: "x" },
      retry:     { type: "string", short: "r", default: "3" },
      resume:    { type: "string", short: "s" },
      timeout:   { type: "string", short: "o", default: String(DEFAULT_TIMEOUT) },
      help:      { type: "boolean", short: "h", default: false },
    },
  });

  if (!values.prompt) {
    throw new Error("required option '--prompt, -p' not specified. Use -h for help.");
  }

  const retry = parseInt(values.retry, 10);
  const timeout = parseInt(values.timeout, 10);
  const resume = values.resume || "";

  if (agents.length > 1 && resume) {
    throw new Error("--resume cannot be used with multiple agents");
  }

  return {
    prompt: values.prompt,
    debug: values.debug,
    reg: values.reg || "",
    exclude: values.exclude || "",
    quota: quotaExplicit !== null ? quotaExplicit : true,
    retry: Number.isNaN(retry) ? 3 : retry,
    resume,
    timeout: Number.isNaN(timeout) ? DEFAULT_TIMEOUT : timeout,
    agents,
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

function buildStderrOutput(agentCommandName, sessionId, agentResults) {
  const parts = [];

  for (const r of agentResults) {
    parts.push(`[${r.commandName}] stdout:`);
    if (r.stdout) parts.push(r.stdout);
    parts.push(`[${r.commandName}] stderr:`);
    if (r.stderr) parts.push(r.stderr);
    if (r.wrapperError) {
      parts.push(`[${r.commandName}] error:`);
      parts.push(r.wrapperError);
    }
  }

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

async function main() {
  const opts = parseArgs(process.argv);

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

    let session;
    try {
      session = await provider.createSession({
        command: agent.command,
        timeout: opts.timeout,
        resume: opts.resume,
      });
    } catch (err) {
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
      process.stderr.write(buildStderrOutput(agent.commandName, "", allResults) + "\n");
      process.exit(err.message.startsWith("command not found") ? EXIT_COMMAND_NOT_FOUND : EXIT_PROVIDER_ERROR);
    }

    let lastResult = null;
    let agentSuccess = false;
    let agentDone = false; // whether broke retry loop due to timeout/error/non-zero exit

    try {
      const maxAttempts = Math.max(1, opts.retry);
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
        log.debug("agent %s attempt session %d finished, duration: %ss", agent.commandName, attempt + 1, duration);

        if (lastResult.timedOut) {
          log.error("agent %s attempt session %d: timed out after %ds", agent.commandName, attempt + 1, opts.timeout);
          log.debug("attempt %d stdout:\n%s", attempt + 1, lastResult.stdout || "(empty)");
          log.debug("attempt %d stderr:\n%s", attempt + 1, lastResult.stderr || "(empty)");
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
          }
          continue;
        }

        if (lastResult.exitCode && lastResult.exitCode !== 0) {
          if (opts.quota && isQuotaExceeded(agent.type, lastResult.stdout, lastResult.stderr)) {
            const pattern = LimitMsg[agent.type];
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
            agentDone = true;
            break;
          }

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

        log.error("agent %s attempt session %d: retry needed — %s", agent.commandName, attempt + 1, retryReason(lastResult.stdout, regex));
        log.debug("attempt session %d stdout:\n%s", attempt + 1, lastResult.stdout || "(empty)");
        log.debug("attempt session %d stderr:\n%s", attempt + 1, lastResult.stderr || "(empty)");
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
      process.stderr.write(buildStderrOutput(agent.commandName, lastResult.sessionId || session.sessionId, allResults) + "\n");
      process.exit(lastResult.exitCode || EXIT_OK);
    }

    log.error("agent %s failed, %s", agent.commandName,
      agentIdx < opts.agents.length - 1 ? "falling back to next agent" : "no more agents");
  }

  // all agents failed
  const lastAgent = opts.agents[opts.agents.length - 1];
  const lastAgentResult = allResults[allResults.length - 1];
  const out = collapseBlankLines(lastAgentResult?.stdout || "");
  process.stdout.write(out);
  if (!out.endsWith("\n")) process.stdout.write("\n");
  process.stderr.write(buildStderrOutput(lastAgent.commandName, lastAgentResult?.sessionId || "", allResults) + "\n");

  if (lastAgentResult) {
    if (lastAgentResult.sessionCreationFailed) {
      process.exit(lastAgentResult.commandNotFound ? EXIT_COMMAND_NOT_FOUND : EXIT_PROVIDER_ERROR);
    }
    if (lastAgentResult.sendFailed) {
      process.exit(EXIT_PROVIDER_ERROR);
    }
    if (lastAgentResult.timedOut) {
      process.exit(EXIT_TIMEOUT);
    }
    if (lastAgentResult.quotaExceeded) {
      process.exit(EXIT_QUOTA_EXCEEDED);
    }
    if (lastAgentResult.exitCode && lastAgentResult.exitCode !== 0) {
      process.exit(lastAgentResult.exitCode);
    }
    if (lastAgentResult.excludeMatched) {
      process.exit(EXIT_EXCLUDE_MATCH);
    }
    if (lastAgentResult.exhausted) {
      const exitCode = isOutputEmpty(lastAgentResult.stdout) ? EXIT_EMPTY_OUTPUT
        : (regex ? EXIT_REGEX_MISMATCH : EXIT_OK);
      process.exit(exitCode);
    }
  }
  process.exit(EXIT_PROVIDER_ERROR);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(2);
  });
}

module.exports = { main, parseArgs, isOutputEmpty, canRetry, buildStderrOutput, collapseBlankLines, retryReason, timeoutReasonBrief, LimitMsg, isQuotaExceeded, quotaReasonBrief, DEFAULT_TIMEOUT, EXIT_OK, EXIT_REGEX_MISMATCH, EXIT_EMPTY_OUTPUT, EXIT_PROVIDER_ERROR, EXIT_TIMEOUT, EXIT_COMMAND_NOT_FOUND, EXIT_EXCLUDE_MATCH, EXIT_QUOTA_EXCEEDED };
