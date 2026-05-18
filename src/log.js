const fs = require("fs");
const util = require("util");

let debugEnabled = false;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function write(level, format, ...args) {
  const msg = util.format(format, ...args);
  fs.writeSync(process.stderr.fd, `[wrapper][${level}][${timestamp()}] ${msg}\n`);
}

function info(format, ...args) {
  if (!debugEnabled) return;
  write("info", format, ...args);
}
function error(format, ...args) {
  if (!debugEnabled) return;
  write("error", format, ...args);
}
function debug(format, ...args) {
  if (!debugEnabled) return;
  write("debug", format, ...args);
}
function setDebug(v) { debugEnabled = v; }
function isDebug() { return debugEnabled; }

module.exports = { info, error, debug, setDebug, isDebug };
