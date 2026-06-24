---
name: agy-provider
description: Add a new provider for Google Antigravity CLI (agy)
---

# Google Antigravity CLI (agy) Provider Design

This document details the design for adding a new provider `agy` (Google Antigravity CLI) to the `wrapper` project.

## Context and Testing Summary

- `agy` does NOT support the Agent Client Protocol (ACP) JSON-RPC over stdin/stdout.
- `agy` supports a non-interactive `--print` mode to run a single prompt and output the response.
- `agy` requires stdin redirection/closing (e.g. `< /dev/null` or stdin set to `"ignore"`) to prevent it from blocking on the main thread during `read` on stdin.
- `agy` writes internal logs containing the session/conversation ID. By passing `--log-file <path>`, we can capture the log and extract the conversation ID.
- `agy` supports conversation resume via the `--conversation <id>` command-line flag.

## Architecture and Registry Integration

We will implement the provider in a new file `src/provider/agy.js` following the standard wrapper provider signature:

```javascript
createSession({ command, timeout, resume }) → session
send(session, prompt) → { stdout, stderr, sessionId, exitCode }
closeSession(session)
run(opts) → { stdout, stderr, sessionId, exitCode }
```

### 1. Registry changes in `src/main.js`

- In `DEFAULTS`:
  ```javascript
  agy: "agy --dangerously-skip-permissions ",
  ```
- In `providers`:
  ```javascript
  agy: require("./provider/agy"),
  ```

### 2. Implementation details of `src/provider/agy.js`

#### Flag Injection
```javascript
const REQUIRED_FLAGS = ["--dangerously-skip-permissions"];

function ensureFlags(args, resume, logPath) {
  const out = [...args];
  
  // Inject log path
  out.push("--log-file", logPath);

  // Inject required flags
  for (const flag of REQUIRED_FLAGS) {
    if (!out.includes(flag)) {
      out.push(flag);
    }
  }

  // Inject conversation resume if specified and not already present
  if (resume && !out.includes("--conversation")) {
    out.push("--conversation", resume);
  }

  // Inject print mode if no interactive or print mode is present
  const hasPrintMode = out.includes("--print") || out.includes("-p") || 
                       out.includes("--prompt") || out.includes("-i") || 
                       out.includes("--prompt-interactive");
  if (!hasPrintMode) {
    out.push("--print");
  }

  return out;
}
```

#### Session Creation
- Generate a unique temporary file path under `/tmp/agy_session_<timestamp>_<rand>.log`.
- Resolve the `agy` CLI path using `which`. If not found, throw 204 error.
- Return the session state.

#### Command Execution (`send`)
- Spawn `session.cmd` with injected arguments, appending the `prompt` at the end:
  ```javascript
  const child = spawn(session.cmd, [...session.baseArgs, prompt], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  ```
- Collect stdout and stderr streams.
- On process close:
  - Read `/tmp/agy_session_<timestamp>_<rand>.log` if it exists.
  - Parse the conversation ID via RegExp:
    ```javascript
    const match = logContent.match(/Print mode: conversation=([a-f0-9-]+)/i) || 
                  logContent.match(/Created conversation ([a-f0-9-]+)/i);
    const sessionId = match ? match[1] : null;
    ```
  - Clean up the temporary log file.
  - Resolve the prompt response.

## Verification and Testing Plan

We will add a unit test suite under `test/provider/agy.test.js` to verify:
1. Argument builder (`ensureFlags`) behavior with and without custom command/resume.
2. Conversation ID extraction regex logic.
3. Clean-up of temporary files after execution.
