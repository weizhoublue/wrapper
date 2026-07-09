#!/usr/bin/env node
const { parseArgs: nodeParseArgs } = require("node:util");
const path = require("path");
const os = require("os");
const fs = require("fs");
const log = require("./log");
const { LimitMsg, isQuotaExceeded, quotaReasonBrief } = require("./limit-msg");
const { checkThrottle, recordExhausted, toLocalISOString } = require("./throttle");

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
    -t, --type <名称>                 代理类型: claude, codex, copilot, gemini, cursor, agy, opencode (默认: claude)
                                          可多次指定该选项，实现 fallback 调用 agent
    -c, --command <命令>              执行命令 (须紧跟 -t 之后，默认根据 -t 决定)
    -d, --debug                      开启调试日志输出到 stderr
    -e, --reg <模式>                  匹配标准输出的正则表达式(大小写不敏感)
                                         如果匹配失败，则会重试运行命令 
    -x, --exclude <模式>              匹配标准输出的正则表达式(大小写不敏感)
                                         如果匹配成功，则直接宣告当前 agent 失败，不再重试该 agent
    -q, --quota                      开启 agent 订阅额度耗尽检测（默认开启）
                                         如果 agent 退出失败，且标准输出或标准错误输出中包含额度耗尽提示，
                                         则直接宣告当前 agent 失败，不再重试该 agent
    --enable-throttle <true|false>   开启或关闭 throttle 功能（默认: true）
                                         throttle 开启时，若检测到某 agent quota 耗尽，会在冷却期内跳过对该 agent 的调用
                                         throttle 开启时自动强制开启 --quota，不可与 --no-quota 同时使用
    --throttle-duration <分钟>        quota 耗尽后的冷却时长，单位分钟（默认: 120）
                                         冷却状态跨进程共享在 ~/.wrapper/throttle.json
    -n, --no-quota                   关闭 agent 订阅额度耗尽检测
                                        当前支持 codex copilot gemini
                                        支持定制版 opencode (开源版本会卡住等待而不退出)
                                        不支持 claude 和 cursor（不知道长什么样） 
                                        无法检测 agy（无任何提示）
    -r, --retry <次数>               每个 agent 最大重试次数 ，每次重试都使用前一次的会话来继续(默认: 2)
                                       如果多次指定 -t，每个 agent 有独立的重试次数
                                       如果不满足 -e 选项、-o 选项、 或者命令返回码非0、或者返回空的标准输出，则会重试运行
                                       -x 选项匹配时，直接不重试
    -s, --resume <id>               恢复之前的会话（不能同多次调用 -t 配合）
    -o, --timeout <秒>              单次 attempt 超时秒数，超时后纳入 -r 重试 (默认: 3600，即 1 小时；0 表示不限时)
    -h, --help                      显示此帮助
    -v, --version                   显示版本号

输出:
    stdout  = 最后一个 agent 的标准输出
    stderr  = 最后一个 agent 的标准错误输出（失败时含 [agent] error: 判定原因）
              倒数第三行为退出码，倒数第二行为 agent 命令名，最后一行为会话 ID
              多 agent fallback 时，中间失败 agent 的输出仅在 -d 调试日志中可见
    退出码   = 最后一个 agent 的退出码
              特定退出码：
                0   成功
                200 正则不匹配（-e 选项）
                201 输出为空
                202 provider 内部错误
                203 超时（-o 选项）
                204 命令未找到
                205 排除模式匹配（-x 选项）
                206 quota 耗尽
                207 所有 agent 均被 throttle 跳过（冷却期内）

环境变量：
    WRAPPER_CONFIG_DIR    配置工作目录，默认 ~/.wrapper ， 其中有 throttle.json 用于 throttle 功能的跨进程的记录共享

----------------------------- 例子 ----------------------------

claude:
    wrapper -t claude -c "claude-deepseek-flash" -d -p "say hi in one word"

    wrapper -t claude -c "claude-deepseek-flash" -d -e "bad" -p "what did I just say?"

    wrapper -t claude -c "claude-deepseek-flash" -d  -p "tomorow will rain" 2>/tmp/sid
    session=$(tail -1 /tmp/sid)
    wrapper -t claude -c "claude-deepseek-flash" -s \${session} -d  -p "tell me all what I have said in this session"

codex:
    wrapper -t codex -d  -p "say hi in one word"
    wrapper -t codex -c codex-cheap -d  -p "say hi in one word"

    wrapper -t codex -d  -p "tomorrow will rain" 2>/tmp/sid
    session=$(tail -1 /tmp/sid)
    wrapper -t codex -s \${session} -d -p  "tell me all what I have said in this session ?"

copilot:
    wrapper -t copilot -d -p "say hi in one word"

gemini:
    wrapper -t gemini -d -p "say hi in one word"

agy:
   wrapper -t agy -d -p "say hi in one word"

cursor:
    wrapper -t cursor -d -p "say hi in one word"

    wrapper -t cursor -d -p "tomorrow will rain" 2>/tmp/sid
    session=$(tail -1 /tmp/sid)
    wrapper -t cursor -s \${session} -d -p "tell me all what I have said in this session"

opencode:
    wrapper -t opencode -d -p "say hi in one word"
    wrapper --type opencode -c "opencode-free"  -d -p "hi"

    wrapper -t opencode -d -p "tomorrow will rain" 2>/tmp/sid
    session=$(tail -1 /tmp/sid)
    wrapper -t opencode -s \${session} -d -p "tell me all what I have said in this session"

throttle:
    wrapper -t claude -c "claude-deepseek-flash" -t codex --throttle-duration 60 -p "say hi in one word"
    wrapper -t claude -c "claude-deepseek-flash" --enable-throttle false -p "say hi in one word"

fallback:
    wrapper -t claude -c "claude-deepseek-flash" -t codex -t copilot -d -p  "say hi in one word" 2>/tmp/sid
    agentName=$( sed '$d' /tmp/sid | sed -n '$p' )
    session=$(tail -1 /tmp/sid)

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
      agents[agents.length - 1].isCustom = true;
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

  // Strip quota/throttle flags before strict parse
  let quotaExplicit = null; // null → default true
  let throttleExplicit = null; // null → default true
  let throttleDurationRaw = null;
  const parsedRemainingArgs = [];
  for (let i = 0; i < remainingArgs.length; i++) {
    const arg = remainingArgs[i];
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
    } else if (arg === "--enable-throttle") {
      const val = remainingArgs[++i];
      if (!val || !["true", "false"].includes(val.toLowerCase())) {
        throw new Error("--enable-throttle requires a value: true or false");
      }
      throttleExplicit = val.toLowerCase() === "true";
    } else if (arg === "--throttle-duration") {
      throttleDurationRaw = remainingArgs[++i];
    } else {
      parsedRemainingArgs.push(arg);
    }
  }

  // Validate throttle-duration
  const throttleDuration = throttleDurationRaw !== null
    ? parseInt(throttleDurationRaw, 10)
    : DEFAULT_THROTTLE_DURATION_MINUTES;
  if (throttleDurationRaw !== null && (Number.isNaN(throttleDuration) || throttleDuration <= 0)) {
    throw new Error("--throttle-duration must be a positive integer (minutes)");
  }

  const throttleEnabled = throttleExplicit !== null ? throttleExplicit : true;

  // Conflict: --no-quota + throttle enabled
  if (quotaExplicit === false && throttleEnabled) {
    throw new Error("--no-quota cannot be used with throttle enabled; use --enable-throttle false first");
  }

  // throttle forces quota on
  const quota = throttleEnabled ? true : (quotaExplicit !== null ? quotaExplicit : true);

  // Phase 2: parse remaining options
  const { values } = nodeParseArgs({
    args: parsedRemainingArgs,
    options: {
      prompt:    { type: "string", short: "p" },
      debug:     { type: "boolean", short: "d", default: false },
      reg:       { type: "string", short: "e" },
      exclude:   { type: "string", short: "x" },
      retry:     { type: "string", short: "r", default: "2" },
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
    quota,
    retry: Number.isNaN(retry) ? 2 : retry,
    resume,
    timeout: Number.isNaN(timeout) ? DEFAULT_TIMEOUT : timeout,
    agents,
    throttle: throttleEnabled,
    throttleDuration,
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

const DEFAULT_THROTTLE_DURATION_MINUTES = 120;

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
  const opts = parseArgs(process.argv);
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
      process.exit(exitCode);
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
      process.exit(exitCode);
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
  process.exit(exitCode);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(2);
  });
}

module.exports = { main, parseArgs, isOutputEmpty, canRetry, buildStderrOutput, collapseBlankLines, retryReason, timeoutReasonBrief, LimitMsg, isQuotaExceeded, quotaReasonBrief, DEFAULT_TIMEOUT, EXIT_OK, EXIT_REGEX_MISMATCH, EXIT_EMPTY_OUTPUT, EXIT_PROVIDER_ERROR, EXIT_TIMEOUT, EXIT_COMMAND_NOT_FOUND, EXIT_EXCLUDE_MATCH, EXIT_QUOTA_EXCEEDED, EXIT_THROTTLE_SKIP };
