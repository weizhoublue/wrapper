# Spec: GitHub Actions Node 24 Migration

## 需求背景
GitHub Actions 运行环境正在废弃 Node 20 并全面迁移至 Node 24 运行时。当前项目工作流中使用的较旧版本 Action（如 `actions/checkout@v4`、`actions/setup-node@v4` 等）内置声明了 Node 20 运行时，这在执行时会产生废弃警告，并在 2026 年 9 月后导致工作流失败。需要将所有核心 Action 升级至原生支持 Node 24 的最新主版本。

## 设计细节

### 修改文件
- [.github/workflows/build.yml](file:///Users/weizhoulan/Documents/git/wrapper/.github/workflows/build.yml)
- [.github/workflows/pr.yml](file:///Users/weizhoulan/Documents/git/wrapper/.github/workflows/pr.yml)
- [.github/workflows/release.yml](file:///Users/weizhoulan/Documents/git/wrapper/.github/workflows/release.yml)

### 版本更新对照表
| Action | 原版本 | 新版本 |
| :--- | :--- | :--- |
| `actions/checkout` | `v4` | `v7` |
| `actions/setup-node` | `v4` | `v6` |
| `actions/cache` | `v4` | `v6` |
| `actions/upload-artifact` | `v4` | `v6` |
| `actions/download-artifact` | `v4` | `v6` |
| `softprops/action-gh-release` | `v2` | `v3` |

## 验证方案
- 检查 YAML 文件格式是否正确，无语法错误。
- 提交代码到 GitHub 后，触发相关工作流，确认构建、测试、Release 流畅执行且无 Node 20 废弃警告。
