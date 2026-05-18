// Patch esbuild bundle: fix import_meta.url for pkg compatibility.
// esbuild converts `import.meta.url` to `import_meta.url` but defines
// `import_meta = {}`. createRequire needs a valid file URL, so we
// inject __filename-based resolution.
const fs = require("fs");
const path = require("path");

const file = process.argv[2] || "dist/wrapper-bundle.js";
let content = fs.readFileSync(file, "utf8");

// Replace all occurrences of empty import_meta with one that has a valid url
content = content.replace(
  /\bimport_meta\s*=\s*\{\s*\}/g,
  'import_meta = { url: require("url").pathToFileURL(__filename).href }'
);

fs.writeFileSync(file, content);
console.log("patched:", file);
