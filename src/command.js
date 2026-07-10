function splitCommand(commandLine) {
  const parts = [];
  let part = "";
  let quote = null;
  let escaped = false;
  let hasPart = false;

  for (const char of commandLine.trim()) {
    if (escaped) {
      part += char;
      escaped = false;
      hasPart = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"') {
        escaped = true;
      } else {
        part += char;
      }
      hasPart = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasPart = true;
    } else if (char === "\\") {
      escaped = true;
      hasPart = true;
    } else if (/\s/.test(char)) {
      if (hasPart) {
        parts.push(part);
        part = "";
        hasPart = false;
      }
    } else {
      part += char;
      hasPart = true;
    }
  }

  if (quote) throw new Error("unclosed quote in command");
  if (escaped) part += "\\";
  if (hasPart) parts.push(part);

  return { command: parts[0] || "", args: parts.slice(1) };
}

module.exports = { splitCommand };
