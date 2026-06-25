# Spec: Agent Attempt Duration Logging

## 需求背景
在开启 `-d` 调试模式时，项目可能调用多个 fallback 的 Agent，且每个 Agent 可能重试多次。为方便诊断每个 Agent 单次 attempt 的执行效率，需要在每次 Agent 调用（attempt）结束时在 debug 日志中输出本次运行的时间。

## 设计细节

### 修改文件
- [src/main.js](file:///Users/weizhoulan/Documents/git/wrapper/src/main.js)

### 计时方案
使用 Node.js 全局 `performance.now()` 记录单次 `provider.send` 的起始与结束时间差，并在 debug 日志中输出：
- 格式：`agent <agentName> attempt <index> finished, duration: <seconds>s`
- 单位：秒，保留两位小数（如 `12.34s`）

### 逻辑改动示例
在 [src/main.js:L400](file:///Users/weizhoulan/Documents/git/wrapper/src/main.js#L400) 附近：

```javascript
        const attemptStartTime = performance.now();
        try {
          lastResult = await provider.send(session, opts.prompt);
        } catch (err) {
          const duration = ((performance.now() - attemptStartTime) / 1000).toFixed(2);
          log.debug("agent %s attempt %d failed, duration: %ss", agent.commandName, attempt + 1, duration);
          // 现有的异常处理逻辑...
        }

        const duration = ((performance.now() - attemptStartTime) / 1000).toFixed(2);
        log.debug("agent %s attempt %d finished, duration: %ss", agent.commandName, attempt + 1, duration);
```

## 验证方案
- 运行测试用例，确保功能未被破坏。
- 手动执行支持的任一 agent 配合 `-d` 参数，验证 stderr 中是否正确输出了类似 `[wrapper][debug][...] agent <name> attempt 1/3 finished, duration: 1.23s` 的日志。
