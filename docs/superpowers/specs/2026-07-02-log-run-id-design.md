# Log Run ID 设计文档

**日期**: 2026-07-02  
**状态**: 已批准

## 背景

在多并发 CI 场景下，多个 wrapper 进程同时运行，其 debug 日志混合输出到同一流。现有格式无法区分哪条日志属于哪次 CI 调用。

## 目标

在每条 debug/info/error 日志中插入一个固定的 6 位 run ID，使同一次 CI 调用的所有日志可以被快速 grep 过滤。

## 格式变更

```
# 之前
[wrapper][debug][2026-07-02 06:13:29.634][agy][2/2] retry: continuing session ...

# 之后
[wrapper][609634][debug][2026-07-02 06:13:29.634][agy][2/2] retry: ...
```

Run ID 位于 `[wrapper]` 与日志级别之间。

## ID 生成规则

- **时机**: `log.js` 模块被 `require()` 时立即生成，等同于进程启动时刻
- **格式**: 6 位纯数字，秒末3位 + 毫秒3位
- **计算**: `String(seconds % 1000).padStart(3, '0') + String(ms).padStart(3, '0')`
- **示例**: 启动时刻 `06:13:29.634` → ID = `329634`

## 实现方案

### 唯一改动文件：src/log.js

1. 模块顶部，在现有变量声明区添加：

```js
const _d = new Date();
const RUN_ID = String(_d.getSeconds() % 1000).padStart(3, '0') + String(_d.getMilliseconds()).padStart(3, '0');
```

2. write() 函数中，将：

```js
let line = `[wrapper][${level}][${timestamp()}]`;
```

改为：

```js
let line = `[wrapper][${RUN_ID}][${level}][${timestamp()}]`;
```

**改动范围**: 2 行，无 API 变更，无新导出，main.js 不需要修改。

## 权衡

| 项目 | 结论 |
|------|------|
| 唯一性 | 6 位循环（1000s 周期），同一秒内启动的进程可能冲突，实际 CI 场景中概率极低 |
| 可读性 | 短小，grep 友好 |
| 侵入性 | 零侵入，仅 log.js 内部变化 |

## 不在范围内

- 不支持外部传入 ID
- 不增加 CLI 参数
- 不修改输出到 stdout 的任何内容
