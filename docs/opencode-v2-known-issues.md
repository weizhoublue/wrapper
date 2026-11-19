# OpenCode v2 适配后的已知缺陷

wrapper 已适配 OpenCode v2（验证版本 v2.3.2）：解析 v2 的 error 事件、按 `provider.*` 类型识别 quota、注入 `--auto` 与 `--standalone`。以下问题源于 OpenCode v2 自身行为，wrapper 无法彻底解决。

源码位置均相对 OpenCode 仓库 `packages/`。

## 1. 模型启动永不结束的后台任务时，run 不退出

```bash
wrapper run -t opencode "启动 dev server 并告诉我端口"
```

- 现象：模型用 shell 工具以 `background: true` 启动 `npm run dev`、`python -m http.server` 之类的命令。回答已经输出，但 `opencode run` 继续等待后台任务结束，期间输出 `background_wait` 事件。wrapper 只能等到 `-o` 超时，返回 203，并按 `-r` 续跑。默认 `-o 3600 -r 2`（共 2 次 attempt）最坏 2 小时后失败；`-o 0` 时永远不退出。
- 原因：
  - run 在回答结束后等待本次 prompt 启动的全部后台 job（`cli/src/run/noninteractive.ts` 的 `lifecycle()`）。
  - 后台 shell 未指定 timeout 时不限时（`core/src/tool/plugin/shell.ts`，`background ? (input.timeout ?? 0)`）；前台命令超过 2 分钟会转入后台而不是被终止；subagent 总是在后台运行。
  - OpenCode 没有"不等后台任务"的开关。
- 已验证：
  - `wrapper run -t opencode -o 40 -r 0 "<启动后台 http.server 的提示词>"`：stdout 已有回答，但 40 秒后退出码为 203。
  - `--standalone` 下超时 SIGTERM 或 SIGKILL 后，私有 server 与后台进程都会退出，不会残留。
- 可选缓解（未实现）：收到 `background_wait` 事件且 jobs 全为 `kind: "shell"` 时，再等一段宽限时间后主动结束并按成功返回。代价是丢失后台任务结束后模型的后续回答。

## 2. 普通限流（429）只能等 OpenCode 内部重试结束

```bash
wrapper run -t opencode -t codex "fix the bug"
```

- 现象：provider 返回不带 quota 特征的 429 时，OpenCode 归类为 `provider.rate-limit` 并在内部重试，最多 10 次，间隔从 2 秒指数增长、单次上限 10 秒（约 84 秒）；服务端带 retry-after 时，每次间隔最长 15 分钟。期间 wrapper 收不到错误，fallback 被推迟。重试用完后 OpenCode 以退出码 1 结束，wrapper 直接 fallback，不按 `-r` 重试；若等待超过 `-o`，则按超时返回 203，并按 `-r` 续跑。
- 若 provider 在订阅额度耗尽时也只返回普通 429，wrapper 识别不出 quota：不返回 206，不记录 throttle，下次调用仍会先尝试 opencode。
- 原因：重试策略在 `core/src/model-retry.ts`，配置中没有关闭重试的选项；quota 分类在 `ai/src/provider-error.ts`，wrapper 只能依赖其结果。
- 可选缓解（未实现）：流式读取 JSON，收到 `retry` 事件即结束进程。代价是无法区分短暂限流和额度耗尽，会误触发 fallback 或 throttle。

## 3. 网络不可达时只能等超时

```bash
wrapper run -t opencode -t codex -o 600 "..."
```

- 现象：DNS 解析失败或本机没有到 provider 的网络路由（ENOTFOUND、EAI_AGAIN、ENETUNREACH、EHOSTUNREACH、ENETDOWN）时，OpenCode 静默重试，最长 1 小时。wrapper 每个 attempt 都要等满 `-o` 才返回 203；上例 `-r 2` 共 2 次 attempt，20 分钟后才 fallback 到 codex，默认 `-o 3600` 时为 2 小时。
- 连接被拒绝（ECONNREFUSED，例如本地代理进程已退出）不在此列：按第 2 条的普通重试约 84 秒后以退出码 1 结束，wrapper 随即 fallback。
- 原因：同第 2 条，重试无法关闭。

## 4. 超时时拿不到正在生成的文本

```bash
wrapper run -t opencode -o 120 "写一份完整的设计文档"
```

- 现象：超时时正在生成的那一段文本不会出现在 stdout 中。
- 原因：`type: "text"` 事件在一段文本结束后才整段输出。

## 5. `-s` 的语义变化

- id 不存在时，OpenCode 用该 id 新建空 session，不报错；模型看不到预期的上下文。可选缓解（未实现）：调用前用 `opencode session export <id>` 检查 session 是否存在。
- 恢复已有 session 时，在该 session 原来的目录中运行，而不是 wrapper 当前目录，且无法覆盖（`cli/src/session-target.ts`）。

```bash
cd /repoB && wrapper run -t opencode -s ses_xxx "继续"   # ses_xxx 在 /repoA 创建，实际在 /repoA 中执行
```

## 6. 权限与交互输入

- `--auto` 只自动批准"未被显式 deny"的权限；用户 OpenCode 配置中显式 deny 的规则仍然生效。
- 需要用户填写表单的请求（如 MCP elicitation）在非交互 run 中直接失败，退出码 1，wrapper 直接 fallback 到下一个 agent，不按 `-r` 重试。question 类表单会被取消，模型继续执行。

## 7. `--standalone` 的代价

- 每个 attempt 启动一个私有 server，比连接后台 service 多 3～4 秒（实测 6.5 秒对比 2.7 秒）。
- 如需连接后台 service 或远程 server，可在 `-c` 中显式加 `--server <url>`，wrapper 不再注入 `--standalone`。此时：
  - server 使用它自己进程的环境：`OPENCODE_CONFIG*`、provider API key 以及 shell 工具的环境变量都以 server 为准，wrapper 侧设置的不生效；
  - server 版本与客户端不一致时只在 stderr 打印 warning，继续运行；
  - 超时时 wrapper 先发 SIGTERM，run 会先中断 session、删除 shell job 再退出。若中断在 2 秒内没完成，被 SIGKILL 后 session 可能在 server 中继续运行，之后 `-r` 续跑会把新提示词插入这个仍在运行的 session。

## 8. 不再支持 OpenCode v1 与定制版

- 原定制版输出的 `OPENCODE_QUOTA_LIMIT` 标记已不再识别；v2 为 client/server 重写，旧补丁无法移植。v2 遇到可识别的额度耗尽会直接失败，不再需要该补丁。
- wrapper 注入的 `--standalone` 是 v2 才有的 flag（`--auto` 在 v1 已存在）。
- `-c` 自定义的包装脚本需按 v2 参数格式调整：`--model` 等 run 参数必须写在 `run` 之后，思考强度用 `--model=<provider/model>#<variant>` 指定，v2 没有 `--variant`；写在 `run` 之前会报 `Unrecognized flag`，退出码 1。
