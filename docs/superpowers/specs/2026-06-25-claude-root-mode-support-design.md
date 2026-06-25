# 2026-06-25 Claude Provider Support for Root User Mode Design

## 1. 背景与目的
在 Cloud/容器等环境中，当以 `root` 用户身份运行 CLI 工具时，Claude Code（底层的 `claude` 命令行工具）出于安全沙箱限制，不允许使用跳过权限检测的参数：
`--dangerously-skip-permissions` 和 `--permission-mode=bypassPermissions`。
如果传入这些参数，`claude` 进程将直接报错退出。

本项目当前在 `claude.js` 内部默认向启动命令追加这些权限参数，这会导致在 root 环境下调用失败。
本设计的目的是检测当前是否以 root 用户运行。如果是，则不传入也不追加这些会导致失败的权限参数，以支持在 root 下的正常运行。

## 2. 详细设计

### 2.1 环境检测
在 Node.js 环境下，通过 `process.getuid()` 判断当前用户是否为 `root`（UID 为 `0`）。
为了保证跨平台安全性（如 Windows 环境下 `process.getuid` 不存在），采用以下安全校验：

```javascript
function isRootUser() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}
```

### 2.2 参数清理与过滤
默认配置（`DEFAULTS.claude`）中包含了权限参数，为防止 root 下默认参数导致失败，需要提供清理函数过滤已有参数中的权限 flags：

```javascript
function removePermissionFlags(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dangerously-skip-permissions") {
      continue;
    }
    if (arg === "--permission-mode=bypassPermissions") {
      continue;
    }
    if (arg === "--permission-mode") {
      if (args[i + 1] === "bypassPermissions") {
        i++; // 跳过下一个 args
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}
```

### 2.3 动态参数处理 (`ensureFlags`)
在 `ensureFlags` 中，如果是 root 用户，不追加 `REQUIRED_FLAGS`，同时过滤掉 `args` 中已存在的权限参数，并输出 debug 级别日志。

```javascript
function ensureFlags(args, resume) {
  let out = [...args];
  
  if (isRootUser()) {
    const beforeLen = out.length;
    out = removePermissionFlags(out);
    if (out.length < beforeLen) {
      log.debug("claude provider: running as root user, removed permission flags from args");
    } else {
      log.debug("claude provider: running as root user, skipping default required permission flags");
    }
  } else {
    for (const flag of REQUIRED_FLAGS) {
      if (flag === "--permission-mode=bypassPermissions") {
        const hasPM = out.some((a, i) =>
          a === "--permission-mode=bypassPermissions" ||
          (a === "--permission-mode" && out[i + 1] === "bypassPermissions")
        );
        if (!hasPM) out.push("--permission-mode", "bypassPermissions");
      } else if (!out.includes(flag)) {
        out.push(flag);
      }
    }
  }
  
  if (resume && !out.includes("--resume")) {
    out.push("--resume", resume);
  }
  return out;
}
```

### 2.4 SDK 配置选项处理 (`createSession`)
在 `createSession` 实例化 SDK 的 `sdkOptions` 时，如果为 root 用户，排除 `permissionMode` 和 `allowDangerouslySkipPermissions` 配置项，防止 SDK 在内部运行校验时抛出异常：

```javascript
  const isRoot = isRootUser();
  const sdkOptions = {
    pathToClaudeCodeExecutable: resolved,
    includePartialMessages: true,
  };

  if (!isRoot) {
    sdkOptions.permissionMode = "bypassPermissions";
    sdkOptions.allowDangerouslySkipPermissions = true;
  } else {
    log.debug("claude provider: running as root user, disabling permission bypass in sdkOptions");
  }
```

## 3. 验收标准
1. 在非 root 环境下运行时，参数追加逻辑不受任何影响。
2. 模拟或在 root 用户环境下运行时，输出日志中出现相关的 debug 信息，且最终调用的子进程参数与 `sdkOptions` 中不包含 `--dangerously-skip-permissions` 和 `--permission-mode=bypassPermissions`。
