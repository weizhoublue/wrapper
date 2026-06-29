# Spec: Agent Output Character Debug Logging

## Goal

When debug logging is enabled, print the stdout and stderr character counts for each completed agent attempt. Keep the existing duration debug line unchanged, and add separate debug lines for output sizes.

## Scope

Change only the main agent attempt loop in `src/main.js`.

Do not change provider interfaces, final stdout/stderr behavior, retry behavior, fallback behavior, or the existing duration log format.

## Log Format

Existing duration log remains:

```text
agent <name> attempt session <n> finished, duration: <seconds>s
```

After `provider.send(session, opts.prompt)` returns `lastResult`, add two debug log lines:

```text
agent <name> attempt session <n> stdout output chars: <n>
agent <name> attempt session <n> stderr output chars: <n>
```

## Counting Rule

Use JavaScript string `.length`:

```javascript
(lastResult.stdout || "").length
(lastResult.stderr || "").length
```

This counts JavaScript string code units, matching the requested `length` behavior.

## Control Flow

The new logs run once per attempt after `provider.send` returns a result and before result classification.

Covered paths include:

- successful output
- timeout result
- non-zero exit result
- quota-exceeded result
- exclude-regex result
- retry-needed result
- retry-exhausted result, through the last returned attempt result

If `provider.send` throws, keep the existing failed-duration log only. That path does not have a reliable completed `lastResult`, so it must not print output character counts.

## Testing

Add a focused Node test that runs a controlled provider path with debug enabled and known stdout/stderr values. Assert stderr contains:

- the existing duration debug line
- `agent <name> attempt session <n> stdout output chars: <stdout.length>`
- `agent <name> attempt session <n> stderr output chars: <stderr.length>`

Run the full test suite with:

```sh
npm test
```
