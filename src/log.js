const fs = require("fs");
const util = require("util");

const _start = new Date();
const RUN_ID = String(_start.getSeconds()).padStart(3, "0").slice(-3) + String(_start.getMilliseconds()).padStart(3, "0");

let debugEnabled = false;
let context = { agentName: null, attempt: null, maxAttempts: null };

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const padMs = (n) => String(n).padStart(3, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${padMs(d.getMilliseconds())}`;
}

function sessionLabel() {
  if (context.attempt != null && context.maxAttempts != null) {
    return `${context.attempt}/${context.maxAttempts}`;
  }
  return "-";
}

function write(level, format, ...args) {
  const msg = util.format(format, ...args);
  let line = `[wrapper][${RUN_ID}][${level}][${timestamp()}]`;
  if (context.agentName) {
    line += `[${context.agentName}][${sessionLabel()}]`;
  }
  line += ` ${msg}\n`;
  // Retry on EAGAIN: occurs when test runner puts stderr fd in O_NONBLOCK mode
  // and the pipe buffer is momentarily full under high debug output volume.
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeSync(process.stderr.fd, line);
      return;
    } catch (e) {
      if (e.code !== "EAGAIN" || i === 2) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
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
function warn(format, ...args) {
  write("warning", format, ...args);
}
function setDebug(v) { debugEnabled = v; }
function isDebug() { return debugEnabled; }

function setContext({ agentName, attempt, maxAttempts }) {
  context = { agentName: agentName ?? null, attempt: attempt ?? null, maxAttempts: maxAttempts ?? null };
}

function clearContext() {
  context = { agentName: null, attempt: null, maxAttempts: null };
}

module.exports = { info, error, debug, warn, setDebug, isDebug, setContext, clearContext };
