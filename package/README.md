# DSH 电源（@local/dsh-power）

> 把 DSH 的重启与关闭变成等待、中断、强制三档可控操作。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/license-MIT-2da44e)](./LICENSE)

版本 1.8.2 · MIT · Web + Desktop（Windows）

---

## 目录

- [为什么需要它](#为什么需要它) · [特性速览](#特性速览) · [安装](#安装) · [快速开始](#快速开始)
- [使用要点](#使用要点)（确认交互 / 关闭 DSH 与逃生舱联动）
- [工具 / 功能一览](#工具--功能一览)
- [配置](#配置) · [常见问题](#常见问题) · [目录结构](#目录结构)
- [已知限制](#已知限制) · [文档索引](#文档索引) · [许可](#许可)

## 为什么需要它

**结论：改一次配置历来只有「杀进程 / 关终端重开」，还得手动掐好几路 AI 的时机；DSH 电源把它变成等待 / 中断 / 强制三档可控操作，重启前后各有如实报告。**

在 DSH 里让一次改动生效，历来只有「杀进程 / 关终端再重开」一条路：后台任务与运行中的 AI 回合被粗暴打断，工具调用结果不可知；而 DSH 里往往同时运行着多个 AI，手动掐时机既不知道谁在收尾，也不知道谁已被打断。

DSH 电源把它变成有语义、可协调、可恢复的操作：人类在侧边栏一点即可等待所有 AI 收尾后重启，或点名催促、强制中断；AI 也可通过 `restart_dsh_*` 工具发起同样的流程，模式按「强制 > 点名 > 阻塞等待」合并与升级；关闭 DSH 走同样的三档，并可选择同时关闭正在运行的逃生舱。重启前写有界、脱敏检查点，重启后向受影响会话如实报告未决工具调用、后台任务与恢复状态；`resumableToolCalls` 服务让其他插件把一次工具调用挂起到下次启动再回填真实结果，避免平台写入 `TOOL_OUTCOME_UNKNOWN`。

## 特性速览

- **三档重启模式**：等待（阻塞等待）、中断（点名）、强制，按「强制 > 点名 > 阻塞等待」合并升级。
- **三档关闭模式**：同样的等待 / 中断 / 强制，但只关闭、不再启动；等待有硬上限（默认 5 分钟），到点取消剩余 AI 并在宽限后退出。
- **人类入口**：侧边栏底部「DSH电源」图标按钮（网页版与桌面版共用同一 DOM），菜单只有「重启 / 关闭」。
- **点名（roll-call）**：向未就绪的运行中 AI 广播插话，要求其停止派生子代理/工具并进入就绪状态；默认最多等 120 秒，到点继续重启并如实记录仍未就绪的 AI。
- **设置页「电源设置」**：插件详情页内调整点名等待时间，写入运行设置并立即生效，不触发插件热重载。
- **关机联动**：安装逃生舱插件时，关闭对话框显示「同时关闭正在运行的逃生舱」（默认不勾选）；仅勾选时 DSH 退出前调用逃生舱 `shutdown()`，失败只写日志、绝不阻止关机。
- **AI 工具与 skill**：五个 `restart_dsh_*` 工具 + `restart-dsh` skill；强制重启的完整审批与保险链路见下文「权限速览」；人类强制用 5 秒长按确认。
- **跨重启检查点与恢复报告**：重启前写有界、脱敏检查点；重启后如实报告未决工具调用、后台任务与恢复状态。
- **`resumableToolCalls` 服务**：让其他插件把一次工具调用挂起到下次启动再回填真实结果，避免平台写入 `TOOL_OUTCOME_UNKNOWN`。
- **强制模式不可阻挡**：独立 detach 回收器在等待超时后强杀 Host（Windows `taskkill /F`，POSIX `SIGKILL`），按模式尝试重新拉起或结束；回收器无法启动时 Host 仍自毁，但自动拉起可能失败。
- **可诊断**：`restart.log`、`status.json`、boot 对账 / hold、外部恢复 CLI `scripts/restart-cli.mjs`。

## 安装

### 最小命令

要求：本机验证过的运行时为 DSH 0.2.1-rc.5（Web，Windows）；Web + Desktop（Windows）版本均可。

首次安装可用插件管理器：

```text
plugin_manager install_bundle target=<本包目录或 .tgz 的绝对路径>
```

推荐直接使用 CLI（首次安装适用）：

```powershell
dsh plugin --profile web add "file:<绝对路径>/local-dsh-power-1.8.2.tgz"
```

### 从仓库下载部署

本仓库的 `releases/` 目录（GitHub 上对应 Releases 页面）直接提供该版本的 `.tgz`，无需本地构建：

1. 下载 `local-dsh-power-1.8.2.tgz`；
2. 安装：

   ```powershell
   dsh plugin --profile web add "file:<下载目录>\local-dsh-power-1.8.2.tgz"
   ```

3. 重启 DSH（Host 半身生效；Client 半身刷新页面即可）。

### 关键注意事项

- 桌面版把 `--profile web` 换成对应的 profile 名。
- 安装后**重启 DSH**：Host 半身的改动必须重启才生效；Client 半身会热更新。
- 卸载后 `$DSH_HOME/.dsh-restart/`（checkpoint、status.json、运行设置）会保留；确认不再需要时手动清理。

> 安装后不要在 AI 回合运行期间手工编辑 `cordis.patch.yml`：当前 DSH 的 profile patch 热重载会 dispose 正在运行的 Agent/Session（表现为「会话不可用」、会话从列表消失）。改配置请用插件设置页（1.7.5-hotfix.7 起不会重载），或等回合结束后再改，或改完重启 DSH。

### 装好判据

安装后**重启 DSH**，两处各验一行：

- **Client 半身**：侧边栏底部出现「DSH电源」按钮，菜单只有「重启 / 关闭」两项；
- **Host 半身**：会话里调用 `restart_dsh_status`——只读、无副作用、无需审批，能返回当前阶段与运行中 AI 即为生效。

### 版本与兼容性

- 当前版本 **1.8.2**：强制重启遵循「先审批，再校验并消费保险」，审批被拒时保险保留；没有保险时返回「先上保险」的引导错误，不会重启。无 API、配置字段变更。
- 不发布到 npm；通过 `.tgz` 或本地目录安装。
- 无 npm 运行时依赖；`client.js` 的 React 由 DSH 网页版客户端运行时注入。
- 平台支持 **Web + Desktop（Windows）**；桌面版额外使用 `relauncher-desktop.mjs` 与 `quit-desktop.mjs` 处理 Electron 外壳。
- 逃生舱是另一个独立包（`@local/dsh-escape-pod`），本包不依赖它、也不替它写 profile 行；关机联动为可选能力，见「关闭 DSH 与逃生舱联动」。

## 快速开始

### 人类最短路径

```text
1. 侧边栏底部点「DSH电源」按钮，菜单只有「重启 / 关闭」两项
2. 选「重启」→ 模式下拉默认「等待」，可另选「中断 / 强制」，可填可选原因（出现在重启后的通知里）
3. 确认 → 阻塞等待：所有其他运行中 AI 完成当前回合后自动重启
4. 重启期间页面短暂断开连接，随后自动恢复；默认不打开新标签页（openBrowserOnRelaunch 可改）
```

### AI 最短路径

```text
1) restart_dsh_status              # 只读查询：阶段、运行中 AI（最多 50 条）、待执行重启/关闭、上次结果；无副作用、无需审批
2) restart_dsh_blocking_wait_safe  # 等待所有其他运行中 AI 完成当前回合后重启；不中断任何 AI，最推荐
```

如需强制（AI 侧）：链路为 `restart_dsh_force_safeguard` 上保险 → `restart_dsh_force_dangerous` 执行；完整审批、保险与权限顺序见下文「权限速览」。

## 使用要点

### 确认交互

- **等待**：确认框可取消；确认后阻塞等待重启。
- **中断**：点「下一步」后再确认一次（二次确认），随后点名重启。
- **强制**：红色警告；**确认按钮需长按 5 秒**，按住期间按钮闪烁加速并显示剩余秒数；中途松开、移出、窗口失焦、页面隐藏或按 Escape 即取消。满 5 秒自动提交。
- 长按只接受鼠标主键；人类发起的强制重启/关闭由长按确认，**不需要 AI 侧强制保险**，也不受 AI 权限限制。
- 按钮挂载：客户端插件把按钮追加到侧边栏 `div[class*="_settingsArea"]`，并用 `sidebar.footer.action` 槽位备用——侧边栏 DOM 变化时也始终有入口；连接状态非 `connected` 时侧边栏按钮隐藏并关闭菜单。
- 强制模式完成时显示红色警告 toast（含被中断数量与通知结果）。

### 关闭 DSH 与逃生舱联动

关闭对话框与重启一样三选一（默认「等待」），但**只关闭、不再启动**：**等待**＝等运行中 AI 完成当前回合后关闭（最长 `shutdownMaxWaitMs`，默认 5 分钟；`0` = 无限）；**中断**＝广播要求运行中 AI 停止、全部停止后关闭；**强制**＝立即中断运行中 AI 并关闭（可能丢失进度）。

- 三种模式都会在模式下拉框下方显示「**同时关闭正在运行的逃生舱**」复选框，**红色样式**；仅安装了逃生舱插件（Host 服务 `escapePod` 存在）时显示，默认不勾选。
- 勾选后关闭请求带 `closeEscapePod: true`；DSH 退出前调用 `await escapePod.shutdown('dsh-power shutdown')`，最多等 5 秒；结果只写日志，绝不阻止关机。
- **重启流程不关闭逃生舱**：逃生舱里的命令随 DSH 重启继续运行。
- 关闭完成页显示「本页面与后端服务连接已断开，DSH已退出」；勾选过逃生舱再显示一行「运行的逃生舱已关闭」。
- 桌面版关闭时 Host 先启动 `quit-desktop.mjs` 终止 Electron 外壳再退出自身，正常路径下窗口随应用一起关闭，避免「DSH 后端错误」恢复弹窗（helper 启动失败只写日志）。

## 工具 / 功能一览

| 名称 | 一句话 | 详见 |
|---|---|---|
| `restart_dsh_blocking_wait_safe` | 阻塞等待：等所有其他运行中 AI 完成当前回合后重启 | [状态与持久化](./TECHDOC.md#3-状态与持久化) |
| `restart_dsh_roll_call_caution` | 点名：广播插话给未就绪的运行中 AI，全部就绪后重启 | [状态与持久化](./TECHDOC.md#3-状态与持久化) |
| `restart_dsh_force_dangerous` | 强制：先审批，再校验并消费保险，立即中断 AI 并重启 | [安全模型](./TECHDOC.md#4-安全模型) |
| `restart_dsh_force_safeguard` | 强制保险：为下一次强制工具调用上保险，可被消费一次 | [安全模型](./TECHDOC.md#4-安全模型) |
| `restart_dsh_status` | 只读状态查询，无副作用、无需审批 | [工具与 API 参考](./TECHDOC.md#2-工具与-api-参考) |
| `restart-dsh`（skill） | 插件加载时注册；有重启诉求或同意以重启解决时按其规则选模式 | [架构](./TECHDOC.md#1-架构) |

人类界面三档与 AI 名称的对应关系：

| 人类界面 | AI 工具 | AI 名称 | 行为 |
|---|---|---|---|
| **等待** | `restart_dsh_blocking_wait_safe` | 阻塞等待 | 等所有其他运行中 AI 完成当前回合后重启；不中断任何 AI；**最推荐** |
| **中断** | `restart_dsh_roll_call_caution` | 点名 | 广播要求未就绪 AI 停止并加入就绪状态；所有活跃 AI 就绪后重启，最多等 `rollCallWaitMs`（默认 120 秒，`0` = 永久等待） |
| **强制** | `restart_dsh_force_dangerous` | 强制 | **先审批，通过后再校验并消费保险**；立即中断所有未就绪的运行中 AI 并重启，不等待完成；没有保险不会重启 |
| —（人类长按即保险） | `restart_dsh_force_safeguard` | 强制保险 | 只对紧接着的下一次工具调用有效（`run_code` / `todo_execute` 传输层外层不重锁，嵌套调用仍逐个校验） |
| — | `restart_dsh_status` | 只读状态 | 查看阶段、运行中 AI、待执行重启/关闭与上次结果；无副作用、无需审批 |

人类界面用「等待 / 中断 / 强制」三词；AI 工具与通知用「阻塞等待 / 点名 / 强制 / 强制保险」。

三档的确认交互 / 超时行为 / 取消，速查如下（细节一并见上文「确认交互」与下文「权限速览」）：

| 档位 | 确认交互 | 超时行为 | 能否取消 |
|---|---|---|---|
| **等待** | 确认框可取消；确认后阻塞等待重启 | —（等所有其他运行中 AI 完成当前回合后重启） | 确认框可取消 |
| **中断** | 点「下一步」后再确认一次（二次确认），随后点名重启 | 最多等 `rollCallWaitMs`（默认 120 秒，`0` = 永久等待）；到点继续重启并如实记录仍未就绪的 AI | —（确认流程见上文「确认交互」） |
| **强制** | 红色警告；确认按钮需长按 5 秒，按住期间按钮闪烁加速并显示剩余秒数 | 无（不等待 AI 完成，立即中断所有未就绪的运行中 AI 并重启） | 长按中途松开、移出、窗口失焦、页面隐藏或按 Escape 即取消；满 5 秒自动提交 |

> 五个 AI 工具**不声明 `timeoutMs`**，`@deepseek-ai/dsh-tool-call-timeout-policy` 因而不给挂起的重启调用设截止时间；挂起调用只在重启失败或回合取消时提前返回错误。

### 权限速览

- 等待/点名对 `workspace-write` 及以上免审批；点名待执行期间等待类工具对所有权限临时免审批。
- 强制与强制保险只在完全访问（`danger-full-access` + `approval: never`）免审批，其他权限各需一次审批；顺序固定为审批 → 校验并消费保险 → 重启，无保险返回「先上保险」引导错误、不重启。保险只对紧接着的下一次工具调用有效；审批被拒时保险保留，可稍后重试。

「人类入口 vs AI 工具 vs 免审批权限」对照（完整 3×4 矩阵见 [TECHDOC · 安全模型](./TECHDOC.md#4-安全模型)）：

| 入口 / 工具 | 免审批条件 | 权限不足时 |
|---|---|---|
| 侧边栏按钮（人类） | 不受 AI 权限限制：等待/中断走普通确认，强制由长按 5 秒确认，**不需要 AI 侧强制保险** | — |
| `restart_dsh_blocking_wait_safe` / `restart_dsh_roll_call_caution` | `workspace-write` 及以上免审批 | 一次审批 |
| `restart_dsh_force_safeguard` / `restart_dsh_force_dangerous` | 仅完全访问（`danger-full-access` + `approval: never`）免审批 | 一次审批（强制：审批通过后再校验并消费保险，无保险不重启） |
| `restart_dsh_status` | 任何权限免审批（无副作用、不触发任何操作） | — |

注：点名待执行期间存在临时免审批窗口——等待类工具（阻塞等待/点名）对所有权限临时免审批，重启完成、取消或升级为强制后恢复；强制保险/强制不受该窗口影响。

- 完整矩阵见 [TECHDOC · 安全模型](./TECHDOC.md#4-安全模型)。

### 检查点与恢复报告

这不是进程冻结：不恢复进程、不接回工具或后台任务，只保存有界状态并在重启后如实报告。

- 重启前在 `$DSH_HOME/.dsh-restart/checkpoint.json` 写有界、脱敏的检查点：live session、Agent 状态与预设、lastSeq、当前回合内未闭合的 `tool/call`（排除 `restart_dsh_*` 自身与 `resumableToolCalls` 接管的调用）、后台 job；参数只保存 `argsHash` + 脱敏预览。
- 重启后投递恢复报告：请求者/被强制中断的 AI 追加到完成/中断通知；其他会话 live 时 `agent.inject`，否则在 `agent/created` 时投递一次。
- 报告明确「未决工具调用结果未知、可能已中断」「后台任务无法接回、需重新执行或检查输出」，不会声称无损；由 `resumableToolCalls` 接管的调用单独写成「可恢复调用」。

检查点是 `version: 1` schema，带 `CHECKPOINT_LIMITS` 硬上限：

| 限制 | 值 |
|---|---|
| sessions（会话数） | 200 |
| 每 session 未决调用 | 20 |
| 未决调用总数 | 200 |
| 每 session 后台 job | 10 |
| preview（参数预览） | 400 字符（敏感键名打码） |

超出上限会置 `totals.truncated=true`；检查点写失败不阻断重启。

### resumableToolCalls 服务

Host 服务 `ctx.get('resumableToolCalls')`，供其他插件重启时挂起自己的工具调用：

- `hold(callId, { tool, hint, deadlineMs })` 在重启检查点之前同步落盘到 `$DSH_HOME/.dsh-restart/resumable-holds.json`，返回 release 回调；`deadlineMs` 上限 24 小时。
- 新进程 boot 先恢复 holds，立刻给未结算调用写如实的 provisional 结果（抢在 resume 写 `TOOL_OUTCOME_UNKNOWN` 之前）；`complete` / `fail` 在会话日志里只生效一次，回合已关闭时改用 `agent.steer` / `agent.followup` 以消息送达。
- 本包停用/未安装时服务不存在，其他插件持有的调用退化为平台默认行为。

### 强制模式与外部恢复 CLI

- 强制重启/关闭完成必要工作（检查点、意图文件、有界 flush）后，启动独立 detach 的 `force-reaper.mjs` 回收器并自毁；回收器最多等 `forceKillAfterMs`（默认 2500ms）让 Host 优雅退出，超时用 `taskkill /F /PID`（POSIX `SIGKILL`）强杀（不带 `/T`，避免连带杀掉回收器自己），最多尝试 3 次、每次间隔 400ms 并确认死亡。
- 强制重启：Host 死亡后网页版由回收器按原命令重新拉起，桌面版先结束 Electron 外壳再重开应用；强制关闭：Host 死亡即完成，桌面版同时结束外壳。
- boot 对上次强制尝试的 spec / marker / lock 对账并写 `lastForceOutcome`；结果为 `error` / `no-marker` 时置 `hold`（`{ active, reason, at, requestId, detail }`）作为 fail-closed 标记，可在 `status.json` 与 CLI 看到，直到显式强制请求或 CLI `unhold` 清除。它不拦截等待 / 点名重启，也不阻止 CLI 的 `relaunch`。
- 外部 CLI `scripts/restart-cli.mjs` 零依赖 Node ESM：`status` / `relaunch` / `clear-stale` / `unhold`，Host 已死也能诊断拉起。`forceDryRun` 打开时强制模式只写 `force-dry-run.json` 并返回「未执行」，不创建 pending、不武装回收器、不杀进程。

四个子命令语义：

| 子命令 | 作用 |
|---|---|
| `status` | 只读诊断：读取 `status.json` 快照（含 `hold`、`lastForceOutcome` 等）；Host 已死后也能读 |
| `relaunch` | Host 死亡后的显式恢复：重新拉起 Host；属破坏性操作，不会被本包自动执行 |
| `clear-stale` | 带 `--yes` 才执行的破坏性清理，同样只用于 Host 死亡后的显式恢复 |
| `unhold` | 显式清除 boot 对账留下的 `hold` 标记（也可被显式强制请求清除） |

## 配置

常用字段（`cordis.patch.yml` 的 `dsh-power` 行 config，可选）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `rollCallWaitMs` | `120000` | 点名广播后最多等待的毫秒数；`0` = 永久等待 |
| `shutdownMaxWaitMs` | `300000` | 等待/中断关闭等待运行中 AI 的上限（默认 5 分钟）；`0` = 无限 |
| `openBrowserOnRelaunch` | `false` | 网页版 relaunch 是否新开浏览器标签页 |
| `forceKillAfterMs` | `2500` | 强制回收器等待 Host 优雅退出的上限，超时强杀 |
| `unlockTtlMs` | `300000` | 一次强制保险的有效期 |
| `forceDryRun` | `false` | 演练开关：强制模式只写 `force-dry-run.json`，不创建 pending、不武装回收器、不杀进程 |

完整字段表（含取值范围，共 21 个字段）见 [TECHDOC · 配置字段](./TECHDOC.md#5-配置字段)。

### 设置页「电源设置」

入口：**插件管理 → 本插件详情页**（`plugins.bundle.config` 槽位，key = `@local/dsh-power`）。

- 摘要行直接显示当前「点名等待：N 秒（0 = 永久等待）」，不打开设置也能看到；面板只有一个「点名等待时间」数字输入框（允许 `0` 或 `1..3600` 秒）与「保存」按钮，`0` = 永久等待。
- 读取：`GET /api/dsh-restart/config` → `{ ok, rollCallWaitMs, writable, persisted }`；保存：`POST /api/dsh-restart/config` 只提交 `{ rollCallWaitMs }`（秒 × 1000），写入 `<DSH_HOME>/.dsh-restart/settings.json`，立即生效，**不修改 `cordis.patch.yml`、不触发插件热重载**。
- 值非法返回 400（指明字段名），写入失败返回 500，不会半成功返回 `ok`。
- mtime 优先级：运行设置 mtime 晚于 profile patch 时覆盖 patch 的 `rollCallWaitMs`；之后手工编辑 patch（mtime 更新）则 patch 重新生效，避免旧运行设置掩盖新的手工配置。
- 该面板不改重启模式、权限或强制保险规则；静态写法等价于 profile patch 行里的 `rollCallWaitMs`。
- 逃生舱的设置（冻结模式、冻结时长、再生次数等）已随拆分移到独立包，本页**不再有「逃生舱」区块**。

## 常见问题

- **重启会不会关闭逃生舱？** 不会。重启不调用逃生舱的 `shutdown()`，逃生舱命令随 DSH 重启继续运行；只有勾选「同时关闭正在运行的逃生舱」才关闭，失败只写日志、绝不阻止关机。
- **强制重启为什么还要先上保险？** 强制先走审批，通过后再校验并消费保险，无保险不会重启；完整顺序与权限矩阵见「权限速览」。保险只对紧接着的下一次工具调用有效。
- **点名会等到什么时候？** 默认最多 120 秒（`rollCallWaitMs`，`0` = 永久等待）；到点继续重启，仍未就绪的 AI 如实记为超时，不会声称其已完成。
- **可以手工编辑 `cordis.patch.yml` 改配置吗？** 不要在 AI 回合运行期间改：profile patch 热重载会 dispose 正在运行的 Agent/Session（表现为「会话不可用」、会话从列表消失）。改配置请用插件设置页（1.7.5-hotfix.7 起不会重载），或等回合结束后再改，或改完重启 DSH。
- **设置页与 `cordis.patch.yml` 里的 `rollCallWaitMs` 谁生效？** 按 mtime 优先级：运行设置文件的 mtime 晚于 profile patch 时覆盖 patch 值；之后手工编辑 patch（mtime 更新）则 patch 重新生效，避免旧运行设置掩盖新的手工配置。
- **重启期间我的其他工具调用与后台任务怎么办？** 不会被接回：恢复报告明确「未决工具调用结果未知、可能已中断」「后台任务无法接回、需重新执行或检查输出」，不会声称无损；被 `resumableToolCalls` 接管的调用单独写成「可恢复调用」。
- **安装后需要重启 DSH 吗？** 需要：Host 半身的改动必须重启才生效，Client 半身会热更新。

## 目录结构

| 文件 / 目录 | 作用 |
|---|---|
| `index.js` | Host 半身：三模式状态机（合并/升级/退化）、人类请求、点名广播与限时等待、检查点/意图、重启后通知、`/api/dsh-restart/*`、`resumableToolCalls` 服务 |
| `host/ai.js` | 五个 AI 工具、权限与审批、强制保险状态机与全局 guard（先审批、后校验/消费保险）、`restart-dsh` skill 注册 |
| `host/constants.js` | 工具名、模式名（AI 名/人类名）、就绪状态定义、skill 文本 |
| `host/human.js` | 人类入口的 Host 侧（界面由 `client.js` 渲染） |
| `host/resumable.js` | `resumableToolCalls` 注册表：hold / complete / fail / status、deadline、provisional 结算与 boot 恢复 |
| `host/session-writer.js` | 把 held 调用的结果写进 Session 日志：live append 通道、persistence 写句柄、写锁竞争时等待 |
| `client.js` | 网页版客户端：settingsArea「DSH电源」按钮 + 备用槽位、重启/关闭菜单、模式下拉、长按 5 秒、关机对话框逃生舱复选框、等待/失败/关闭页、插件详情页「电源设置」 |
| `relauncher.mjs` / `relauncher-desktop.mjs` | 网页版 / 桌面版 relaunch helper；网页版通过 marker 文件与 Host 握手 |
| `quit-desktop.mjs` | 桌面版关闭 helper：Host 退出前终止 Electron 外壳 |
| `force-reaper.mjs` | 独立 detached 强制回收器：等待优雅退出超时后强杀 Host，再按模式重新拉起或结束 Electron 外壳 |
| `scripts/restart-cli.mjs` | 外部诊断/恢复 CLI（零依赖 ESM）：`status` / `relaunch` / `clear-stale` / `unhold` |
| `cordis.patch.yml` | 单行 `dsh-power` 行声明与配置说明 |
| `locale/*.json` | 插件管理器标题/描述（zh/en） |
| `test/*.test.mjs` | Node 单元测试（不进 tgz） |

## 已知限制

- 检查点是有界、脱敏快照：不恢复进程、不接回后台任务；超上限时置 `totals.truncated=true`，恢复报告如实声明「结果未知」（见「检查点与恢复报告」）。
- 强制回收器无法启动时，Host 仍会自毁，但自动拉起可能失败。
- boot 对账失败的 `hold` 是 fail-closed 标记：不拦截等待 / 点名重启，也不阻止 CLI `relaunch`，需显式强制请求或 `restart-cli unhold` 清除（见「强制模式与外部恢复 CLI」）。
- 五个 AI 工具不声明 `timeoutMs`：挂起的重启调用只在重启失败或回合取消时提前返回错误。

## 文档索引

| 文档 | 读者 | 内容 |
|---|---|---|
| [README.md](./README.md) | 所有人 | 定位、特性、安装、最小上手、使用要点与配置速览 |
| [HISTVER.md](./HISTVER.md) | 维护者 | 正式公开（1.8.2）及之后的版本变更与兼容性说明 |
| [HISTVER_legacy.md](./HISTVER_legacy.md) | 维护者 | 正式公开前的私有迭代记录（逐版本详情、早期版本表、版本号命名说明），仅供参考 |
| [TECHDOC.md](./TECHDOC.md) | 开发者/运维 | 架构、重启/关闭状态机、点名与就绪状态、检查点、`resumableToolCalls`、force reaper、API 路由表、配置字段表、状态文件、安全与测试方法 |
| [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) | 所有人 | 第三方归属（dsh-tray-restart，MIT）、MIT 许可原文与运行时依赖说明；摘要见上文「许可」 |

## 许可

本文件以 MIT 许可发布，版权归 DX12_XYZ 所有。完整条款见仓库根 [LICENSE](./LICENSE)。

Copyright (c) 2026 DX12_XYZ

设计与结构上借鉴了 [hxh230802/dsh-tray-restart](https://github.com/hxh230802/dsh-tray-restart)（MIT，Copyright (c) 2026 dsh-tray-restart contributors）——仅借鉴设计思想，未复制源代码。完整的 MIT 许可原文、归属声明与依赖说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

<!-- fused-by: deepseek-v4.1-flash -->

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
