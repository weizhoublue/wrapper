"use strict";
const path = require("path");
const os = require("os");
const { parseArgs: nodeParseArgs } = require("node:util");
const log = require("../log");
const { listRecords, deleteRecordByIndex } = require("../throttle");

const THROTTLE_HELP = `用法: wrapper throttle [选项]

选项:
    -l, --list            列出 throttle 记录
    -d, --delete <id>     按列表编号删除记录（1-based）
    -h, --help            显示此帮助
`;

function formatRecordLine(id, r) {
  const cmd = r.command == null ? "(default)" : r.command;
  return `${id}  type=${r.type}  command=${cmd}  startExhausted=${r.startExhausted}  endExhausted=${r.endExhausted}`;
}

function throttleFilePathLine(throttleFile) {
  return path.resolve(throttleFile) + "\n";
}

function runThrottleCommand(argv) {
  const args = argv.slice(argv.indexOf("throttle") + 1);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    process.stdout.write(THROTTLE_HELP + "\n");
    return 0;
  }

  const { values } = nodeParseArgs({
    args,
    options: {
      list:   { type: "boolean", short: "l", default: false },
      delete: { type: "string", short: "d" },
    },
  });

  if (values.list && values.delete) {
    process.stderr.write("Error: --list and --delete are mutually exclusive\n");
    return 2;
  }

  const configDir = process.env.WRAPPER_CONFIG_DIR || path.join(os.homedir(), ".wrapper");
  const throttleFile = path.join(configDir, "throttle.json");

  if (values.list) {
    const records = listRecords(throttleFile);
    process.stdout.write(throttleFilePathLine(throttleFile));
    if (records.length === 0) {
      process.stdout.write("No throttle records.\n");
    } else {
      records.forEach((r, i) => process.stdout.write(formatRecordLine(i + 1, r) + "\n"));
    }
    return 0;
  }

  if (values.delete) {
    process.stderr.write(throttleFilePathLine(throttleFile));
    try {
      const deleted = deleteRecordByIndex(throttleFile, values.delete);
      const cmd = deleted.command == null ? "(default)" : deleted.command;
      const prevDebug = log.isDebug();
      log.setDebug(true);
      log.info("deleted throttle record id=%s type=%s command=%s", values.delete, deleted.type, cmd);
      log.setDebug(prevDebug);
      return 0;
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      return 2;
    }
  }

  process.stdout.write(THROTTLE_HELP + "\n");
  return 0;
}

module.exports = { runThrottleCommand, THROTTLE_HELP };
