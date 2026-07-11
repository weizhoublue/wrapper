const TOP_HELP = `用法: wrapper <子命令> [选项]

子命令:
    run       运行 AI 编码代理（wrapper run -h 查看详情）
    throttle  管理 quota 冷却状态（wrapper throttle -h 查看详情）

全局选项:
    -h, --help      显示此帮助
    -v, --version   显示版本号
`;

const LEGACY_RUN_FLAGS = new Set([
  "-t", "--type", "-c", "--command", "-d", "--debug",
  "-e", "--reg", "-x", "--exclude", "-q", "--quota", "-n", "--no-quota",
  "-r", "--retry", "-s", "--resume", "-o", "--timeout",
  "--enable-throttle", "--throttle-duration", "-p", "--prompt",
]);

function detectLegacyCli(args) {
  if (args.includes("-p") || args.includes("--prompt")) return true;
  const first = args[0];
  if (first && LEGACY_RUN_FLAGS.has(first)) return true;
  return false;
}

function migrationHint(args) {
  const hasP = args.includes("-p") || args.includes("--prompt");
  if (hasP) {
    const pIdx = args.indexOf("-p") !== -1 ? args.indexOf("-p") : args.indexOf("--prompt");
    const prompt = args[pIdx + 1] || "";
    const rest = args.filter((_, i) => i !== pIdx && i !== pIdx + 1);
    return `wrapper run ${rest.join(" ")} "${prompt}"`.trim();
  }
  return "wrapper run ... <prompt>";
}

function routeCli(argv) {
  const args = argv.slice(2);

  if (args.includes("-v") || args.includes("--version")) {
    const pkg = require("../../package.json");
    process.stdout.write(pkg.version + "\n");
    process.exit(0);
  }

  if (args.length === 0 || (args.length === 1 && (args[0] === "-h" || args[0] === "--help"))) {
    process.stdout.write(TOP_HELP + "\n");
    process.exit(0);
  }

  if (detectLegacyCli(args)) {
    throw new Error(
      `wrapper now uses subcommands. Did you mean:\n  ${migrationHint(args)}`,
    );
  }

  const sub = args[0];
  if (sub === "run" || sub === "throttle") return sub;

  throw new Error(`unknown subcommand: ${sub}. Use wrapper -h for help.`);
}

module.exports = { routeCli, TOP_HELP, detectLegacyCli, migrationHint };
