# 版本历史

> 本文件记录**正式公开**（1.8.2）及之后的版本变更。正式公开之前的私有迭代见
> [HISTVER_legacy.md](./HISTVER_legacy.md)：其中版本从未发布、不保留源码与产物，记录也可能不完整，
> 仅供追溯参考。

## 版本总表

| 版本 | 日期 | 主题 |
|---|---|---|
| **1.8.2** | 2026-11-02 | 首次公开发布（基线） |

## 1.8.2 — 首次公开发布

- **侧边栏一键重启 / 关闭**：三档模式（等待 / 中断（点名）/ 强制），模式按「强制 > 点名 > 阻塞等待」合并与升级；关闭只退出、不再启动。
- **五个 AI 工具 + `restart-dsh` skill**：`restart_dsh_blocking_wait_safe` / `restart_dsh_roll_call_caution` / `restart_dsh_force_dangerous` / `restart_dsh_force_safeguard` / `restart_dsh_status`。
- **强制重启两步契约**：先 `restart_dsh_force_safeguard` 上保险，再 `restart_dsh_force_dangerous`（审批 → 校验并消费保险 → 重启）；没有保险不会重启，审批被拒时保险保留。
- **检查点与恢复报告**：重启前写有界、脱敏检查点；重启后如实报告未决工具调用、后台任务与恢复状态，不声称无损。
- **`resumableToolCalls` 服务**：让其他插件把一次工具调用挂起到下次启动再回填真实结果，避免平台写入 `TOOL_OUTCOME_UNKNOWN`。
- **强制模式不可阻挡**：独立 detach 回收器在等待超时后强杀 Host（Windows `taskkill /F`，POSIX `SIGKILL`），按模式尝试重新拉起或结束。
- **关机联动（可选）**：安装逃生舱后，关闭对话框可勾选「同时关闭正在运行的逃生舱」，默认不勾选；失败只写日志，绝不阻止关机。
- **验证**：`node --check` 全量通过；`npm test` 58 项全过（session-writer 19 / resumable 22 / checkpoint-holds 9 / force-safeguard 8）。
- **平台**：Web + Desktop（Windows）；已验证运行时 DSH `0.2.1-rc.5`。

## 后续版本

（尚未发布。正式公开后的每次版本变更在此追加，格式：版本号 / 日期 / 变更 / 兼容性。）

## 许可

本文件以 MIT 许可发布，版权归 DX12_XYZ 所有。完整条款见仓库根 [LICENSE](./LICENSE)。

<!-- fused-by: deepseek-v4.1-flash -->

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
