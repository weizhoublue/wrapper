const { parseArgs: nodeParseArgs } = require("node:util");

const DEFAULT_TIMEOUT = 3600; // 1 hour per attempt
const DEFAULT_THROTTLE_DURATION_MINUTES = 120;

const DEFAULTS = {
  claude: "claude --dangerously-skip-permissions --permission-mode=bypassPermissions",
  codex: "codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check",
  copilot: "copilot --acp --allow-all-tools --allow-all-paths --allow-all-urls --no-ask-user",
  gemini: "gemini --acp --approval-mode=yolo --skip-trust",
  cursor: "agent --yolo --approve-mcps acp",
  agy: "agy --dangerously-skip-permissions ",
  opencode: "opencode run --dangerously-skip-permissions --format json",
};

const RUN_HELP = `用法: wrapper run <选项...> <提示词>

一次性 AI 编码代理 CLI 封装器。

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
                                        检测开启时，如果 api 返回结果显示额度耗尽，则不再重试该 agent，直接 fallback 到下一个 agent
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
    wrapper run -t claude -c "claude-deepseek-flash" -d "say hi in one word"

    wrapper run -t claude -c "claude-deepseek-flash" -d -e "bad" "what did I just say?"

    wrapper run -t claude -c "claude-deepseek-flash" -d "tomorow will rain" 2>/tmp/sid
    session=$(tail -1 /tmp/sid)
    wrapper run -t claude -c "claude-deepseek-flash" -s \${session} -d "tell me all what I have said in this session"

codex:
    wrapper run -t codex -d "say hi in one word"
    wrapper run -t codex -c codex-cheap -d "say hi in one word"

    wrapper run -t codex -d "tomorrow will rain" 2>/tmp/sid
    session=$(tail -1 /tmp/sid)
    wrapper run -t codex -s \${session} -d "tell me all what I have said in this session ?"

copilot:
    wrapper run -t copilot -d "say hi in one word"

gemini:
    wrapper run -t gemini -d "say hi in one word"

agy:
   wrapper run -t agy -d "say hi in one word"

cursor:
    wrapper run -t cursor -d "say hi in one word"

    wrapper run -t cursor -d "tomorrow will rain" 2>/tmp/sid
    session=$(tail -1 /tmp/sid)
    wrapper run -t cursor -s \${session} -d "tell me all what I have said in this session"

opencode:
    wrapper run -t opencode -d "say hi in one word"
    wrapper run --type opencode -c "opencode-free" -d "hi"

    wrapper run -t opencode -d "tomorrow will rain" 2>/tmp/sid
    session=$(tail -1 /tmp/sid)
    wrapper run -t opencode -s \${session} -d "tell me all what I have said in this session"

throttle:
    wrapper run -t claude -c "claude-deepseek-flash" -t codex --throttle-duration 60 "say hi in one word"
    wrapper run -t claude -c "claude-deepseek-flash" --enable-throttle false "say hi in one word"

fallback:
    wrapper run -t claude -c "claude-deepseek-flash" -t codex -t copilot -d "say hi in one word" 2>/tmp/sid
    agentName=$( sed '$d' /tmp/sid | sed -n '$p' )
    session=$(tail -1 /tmp/sid)

debug:
    wrapper run -t claude -c "claude-deepseek-flash" -d "tomorow will rain" 2>/tmp/sid
    agentName=$( sed '$d' /tmp/sid | sed -n '$p' )
    session=$(tail -1 /tmp/sid)
    echo ""
    cat /tmp/sid
    grep "attempt session" /tmp/sid
`;

function parseRunArgs(argv) {
  const runIdx = argv.indexOf("run");
  if (runIdx === -1) {
    throw new Error("internal: parseRunArgs called without run subcommand");
  }

  const runArgs = argv.slice(runIdx + 1);

  if (runArgs.includes("-h") || runArgs.includes("--help")) {
    process.stdout.write(RUN_HELP + "\n");
    process.exit(0);
  }

  if (runArgs.length === 0) {
    throw new Error("missing prompt (last argument)");
  }

  if (runArgs.length === 1 && runArgs[0] === "--enable-throttle") {
    throw new Error("--enable-throttle requires a value: true or false");
  }

  const OPTION_TAKES_VALUE = new Set([
    "-t", "--type", "-c", "--command",
    "-e", "--reg", "-x", "--exclude",
    "-r", "--retry", "-s", "--resume", "-o", "--timeout",
    "--enable-throttle", "--throttle-duration",
  ]);

  if (runArgs.length >= 2 && OPTION_TAKES_VALUE.has(runArgs[runArgs.length - 2])) {
    const prefix = runArgs.slice(0, -2);
    if (prefix.some((t) => !t.startsWith("-"))) {
      throw new Error("prompt must be the last argument");
    }
    throw new Error("missing prompt (last argument)");
  }

  const prompt = runArgs[runArgs.length - 1];
  const optionTokens = runArgs.slice(0, -1);

  if (optionTokens.includes("-p") || optionTokens.includes("--prompt")) {
    throw new Error("option -p/--prompt is no longer supported; put the prompt as the last argument");
  }

  // Phase 1: manual scan to extract -t/-c pairs
  const agents = [];
  const remainingArgs = [];
  let lastToken = null;

  for (let i = 0; i < optionTokens.length; i++) {
    const arg = optionTokens[i];

    if (arg === "-t" || arg === "--type") {
      const value = optionTokens[++i];
      if (!value) throw new Error("missing value for -t/--type");
      agents.push({ type: value, command: null, commandName: value });
      lastToken = "type";
      continue;
    }

    if (arg === "-c" || arg === "--command") {
      const value = optionTokens[++i];
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

  if (agents.length === 0) {
    agents.push({ type: "claude", command: null, commandName: "claude" });
  }

  for (const agent of agents) {
    if (agent.command === null) {
      agent.command = DEFAULTS[agent.type] || agent.type;
    }
  }

  let quotaExplicit = null;
  let throttleExplicit = null;
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

  const throttleDuration = throttleDurationRaw !== null
    ? parseInt(throttleDurationRaw, 10)
    : DEFAULT_THROTTLE_DURATION_MINUTES;
  if (throttleDurationRaw !== null && (Number.isNaN(throttleDuration) || throttleDuration <= 0)) {
    throw new Error("--throttle-duration must be a positive integer (minutes)");
  }

  const throttleEnabled = throttleExplicit !== null ? throttleExplicit : true;

  if (quotaExplicit === false && throttleEnabled) {
    throw new Error("--no-quota cannot be used with throttle enabled; use --enable-throttle false first");
  }

  const quota = throttleEnabled ? true : (quotaExplicit !== null ? quotaExplicit : true);

  const { values, positionals } = nodeParseArgs({
    args: parsedRemainingArgs,
    options: {
      debug:     { type: "boolean", short: "d", default: false },
      reg:       { type: "string", short: "e" },
      exclude:   { type: "string", short: "x" },
      retry:     { type: "string", short: "r", default: "2" },
      resume:    { type: "string", short: "s" },
      timeout:   { type: "string", short: "o", default: String(DEFAULT_TIMEOUT) },
    },
    allowPositionals: true,
  });

  if (positionals.length > 0) {
    throw new Error("prompt must be the last argument");
  }

  const retry = parseInt(values.retry, 10);
  const timeout = parseInt(values.timeout, 10);
  const resume = values.resume || "";

  if (agents.length > 1 && resume) {
    throw new Error("--resume cannot be used with multiple agents");
  }

  return {
    prompt,
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

module.exports = {
  parseRunArgs,
  RUN_HELP,
  DEFAULTS,
  DEFAULT_TIMEOUT,
};
