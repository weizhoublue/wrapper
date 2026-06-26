# 2026-06-26 Claude Provider Custom Command Support under Root User Design

## 1. 背景与目的
在先前的 PR 中，我们为 Claude provider 引入了 root 用户环境支持，以防止 `claude` 命令在 root 权限下因带有 `--dangerously-skip-permissions` 和 `--permission-mode=bypassPermissions` 选项而报错退出。
然而，当用户在命令行中显式通过 `-c` 或 `--command` 传递自定义参数时，目前的逻辑依然会强制过滤移除这些选项。

为了提高工具的灵活性，需要做以下改进：
1. 若检测到 root 用户，且用户**显式传递**了自定义的 `command`，则不强制移除命令行参数中的选项，尊重用户在命令中的显式决定。
2. 在 root 用户下若用户显式传递的 command 中含有这些选项，在 SDK 的 `sdkOptions` 中也对应地开启相应的权限绕过设置，保持一致。
3. 若使用的是默认 command，依然保持过滤/不加入这些选项。

## 2. 详细设计

### 2.1 参数解析标记
在 `src/main.js` 解析命令行 `-c`/`--command` 时，记录该命令为用户显式传递：
- 在 parsed agent 对象中新增 `isCustom: true` 标记。
- 在 `main` 函数实例化会话时，将 `isCustom` 作为参数传给 `provider.createSession`。

### 2.2 动态参数保留逻辑
在 `src/provider/claude.js` 的 `ensureFlags` 中：
- 当 `isRootUser()` 为 `true` 且 `isCustom` 为 `true` 时，不执行 `removePermissionFlags(out)`。
- 当 `isRootUser()` 为 `true` 且 `isCustom` 为 `false` 时，执行过滤。

### 2.3 动态 SDK 配置项对齐
在 `src/provider/claude.js` 的 `createSession` 中：
- 当为 root 用户且 `isCustom` 为 `true` 时：
  - 检查处理后的 `args` 中是否依然包含 `--permission-mode=bypassPermissions`（或 `--permission-mode bypassPermissions`）。若包含，设置 `sdkOptions.permissionMode = "bypassPermissions"`。
  - 检查处理后的 `args` 中是否包含 `--dangerously-skip-permissions`。若包含，设置 `sdkOptions.allowDangerouslySkipPermissions = true`。

## 3. 验收标准
1. **非 root 环境下**：逻辑不受影响，仍然保持追加默认权限 flag 并启用 SDK 权限绕过。
2. **root 环境 + 默认命令**：不追加且强制移除默认命令中携带的权限 flags，且 SDK `sdkOptions` 不启用权限绕过。
3. **root 环境 + 自定义命令**：
   - 若用户传入的命令中含有权限 flag（如 `-c "claude --dangerously-skip-permissions"`），该 flag 须被原样保留发送至子进程，且 SDK 中对应的属性（如 `allowDangerouslySkipPermissions`）须动态对齐开启。
   - 若用户传入的命令中无权限 flag（如 `-c "claude-custom"`），则不追加这些 flag，且 SDK 属性不开启。
