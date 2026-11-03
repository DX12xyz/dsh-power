# 私有包时期变更记录（legacy）

> 本文件只记录**正式公开之前**的私有迭代，仅供追溯参考：
>
> - 这些版本从未公开发布；本套文档所在的仓库不随附这些历史时期的源码与 `.tgz` 产物（大部分私有版本的实物仍可在 `.del/` 归档与拆分归档目录里找到，仅作参考），收版后的正式产物由本仓库 `deliver/releases/` 提供；
> - 记录可能不完整，**不作为对外契约**，行为以当前版本为准；
> - 正式公开后的变更记录见 [HISTVER.md](./HISTVER.md)。

> 来源说明：本文的 1.7.4 系列条目（hotfix 逐条与 1.7.4 及更早版本摘要）誊抄自 `.del/pod/restart-bundle/README.md`（与 `local-dsh-restart-bundle-1.7.5-hotfix.8.tgz` 内 README 同源）。

## 版本历史（@local/dsh-power）

> 当前版本：**1.8.2**（由 `1.8.1-hotfix.2` 收版，v0.0.1）。本文件按时间倒序记录 1.7.5 基线 → `1.7.5-hotfix.1…9` → `1.8.0` → `1.8.0-hotfix.1` → `1.8.1` → `1.8.1-hotfix.1` → `1.8.1-hotfix.2` → `1.8.2`（正式版）的变化；更早的 1.7.0–1.7.3 只保留一句话摘要，1.7.4 线的 hotfix 逐条记录见下文「1.7.4（合并包时期，restart-bundle）」一节。
>
> 相关文档：[./README.md](./README.md) · [./TECHDOC.md](./TECHDOC.md)

## 版本总表

| 版本 | 主题 | 一句话 |
|---|---|---|
| **1.8.2（正式版，v0.0.1）** | 收版 | `1.8.1-hotfix.2` 的内容收进正式版（版本按 1.8.1 + 0.0.1 = 1.8.2）；强制重启先审批、再校验/消费保险；无兜底联动；行为零变更 |
| **1.8.1-hotfix.2** | 顺序调整 | 强制重启先审批、后校验/消费保险；审批被拒保险保留；移除 hotfix.1 的待办收件箱放行分支 |
| 1.8.1-hotfix.1（已被 hotfix.2 取代） | 待办放行（已移除） | 曾让无保险的强重启先发起审批，以便离线拒绝进入待办；hotfix.2 已移除该放行 |
| **1.8.1** | 正式发版 | 1.8.0-hotfix.1 的收版；无行为变更 |
| **1.8.0-hotfix.1** | 界面 | 进度圈的圆环改为 SVG 几何，修复桌面版（Chromium）显示为椭圆 |
| **1.8.0** | 正式发版 | 版本统一为 1.8.0，文档拆分为 README / TECHDOC / HISTVER / THIRD_PARTY_NOTICES；无行为变更 |
| 1.7.5-hotfix.9 | 拆分 | 电源与逃生舱拆成两个独立包；关机联动改为可选 `closeEscapePod` |
| 1.7.5-hotfix.8 | 逃生舱 | 逃生舱设置页、关闭门禁、冻结模式与 pod 单例 |
| 1.7.5-hotfix.7 | 运行设置 | 设置页保存改写入 `settings.json`，不再触发插件重载 |
| 1.7.5-hotfix.6 | shell | `podc_run` / `podc_exec` 支持 `powershell` / `cmd` / `bash` |
| 1.7.5-hotfix.5 | steer | 跨重启结果在运行中回合里用 `steer` 自动送达，idle 用 `followup` |
| 1.7.5-hotfix.4 | 通知 | 修复点名完成通知的 `interruptedResults` 引用错误 |
| 1.7.5-hotfix.3 | 回合关闭保护 | 不再向已关闭的回合追加 `tool/result`，改为消息送达 |
| 1.7.5-hotfix.2 | 超时通知 | 点名超时的 AI 也收到中断通知；恢复报告补 `heldToolCalls` |
| 1.7.5-hotfix.1 | 组件化 | 逃生舱组件进包；恢复 `resumableToolCalls` 跨重启回填 |
| **1.7.5（基线正式版）** | 基线正式版 | 合并 1.7.4 线的强制回收器、boot 对账、外部 CLI、点名限时 |

> 内部锚点索引：[1.8.2](#1822026-11-02) · [1.8.1-hotfix.2](#181-hotfix22026-11-02) · [1.8.1-hotfix.1](#181-hotfix12026-11-02已在-hotfix2-移除该放行) · [1.8.1](#1812026-11-01正式版) · [1.8.0-hotfix.1](#180-hotfix12026-11-01) · [1.8.0](#1802026-11-01正式版) · [1.7.5-hotfix.9](#175-hotfix9拆分版) · [1.7.5-hotfix.8](#175-hotfix8) · [1.7.5-hotfix.7](#175-hotfix7) · [1.7.5-hotfix.6](#175-hotfix6) · [1.7.5-hotfix.5](#175-hotfix5) · [1.7.5-hotfix.4](#175-hotfix4) · [1.7.5-hotfix.3](#175-hotfix3) · [1.7.5-hotfix.2](#175-hotfix2) · [1.7.5-hotfix.1](#175-hotfix1) · [1.7.5](#175基线正式版) · [1.7.4（合并包时期）](#174合并包时期restart-bundle) · [更早的版本](#更早的版本174-及以前)

## 逐版本详情

### 1.8.2（2026-11-02）

- **收版**：去掉 `-hotfix.N` 后缀，版本号回到正式号 **1.8.2**（`1.8.1` + `0.0.1`）。`package.json` 的 `version`、`host/constants.js` 的 `PLUGIN_VERSION`、各文件头注释与文档标题里的版本标识同步；`restart_dsh_*` 工具名、API、配置字段不变。
- **内容即 `1.8.1-hotfix.2`，行为零变更**——之前的 hotfix 迭代整体收进正式版；执行顺序、审批被拒保险保留、重放路径、强制保险工具行为等详见下节 [1.8.1-hotfix.2](#181-hotfix22026-11-02)。本节仅列出收版特有条目：
  - 版本号同步清单：`package.json`、`host/constants.js`、各文件头注释与文档标题。
  - **无兜底联动**：不包含 `1.8.1-hotfix.1` 的待办收件箱放行分支（该分支已在 hotfix.2 移除）。离线时审批被注意力插件自动拒绝并进入待办收件箱，这就是离线时的保底路径；不再有额外联动代码。
  - 验证：`node --check`（index.js、client.js、host/*.js、force-reaper.mjs、relauncher*.mjs、quit-desktop.mjs、scripts/*.mjs）；`npm test` session-writer 19 / resumable 22 / checkpoint-holds 9 / force-safeguard 8（共 58）全过。

#### 变更

- 版本号从 `1.8.1-hotfix.2` 提升为 `1.8.2`；所有版本标识同步更新。
- 行为、API、工具名、配置字段零变更。

#### 动机

- hotfix 系列已稳定，收进正式版以便后续按语义化版本继续迭代。

#### 兼容性

- 与 `1.8.1-hotfix.2` 完全等价；与任何 1.8.x 或 1.7.5-hotfix.9 的调用方式完全兼容。
- `restart_dsh_force_safeguard` → `restart_dsh_force_dangerous` 的两步契约不变。

#### 迁移

- 装后必须重启 DSH（Host 半身改动需重启生效）。
- 无需更改任何 AI prompt、skill 或外部脚本。

### 1.8.1-hotfix.2（2026-11-02）

- **顺序调整**：`restart_dsh_force_dangerous` 改为「先审批，再判断保险」：
  1. 先 `authorize()`（完全访问免审批，否则一次审批）；
  2. 审批通过后才校验并消费 `restart_dsh_force_safeguard` 上的保险；
  3. 有保险才 `requestRestart()`；没有保险返回「已通过审批，但尚未完成强制重启保险：请先调用 `restart_dsh_force_safeguard` 并批准，然后重试本次强重启。」，不会重启。
- **移除待办放行分支**：删除 hotfix.1 的两个待办/注意力判定函数及 guard / forceTool 中的全部分支与相关文案。离线时审批被注意力插件自动拒绝并进入待办收件箱，这就是离线时的保底路径；不再有额外联动代码。
- **审批被拒时保险保留**：guard 不再消费保险，只负责在其它非传输工具调用后重新锁定；审批被拒后可直接重试强制重启。
- **重放路径**：`run_code` 与 `todo_execute` 是传输层，外层不重锁，嵌套调用仍逐个校验；`todo_execute` 重放强重启时可消费上保险后已武装的保险，审批沿用待办的一次性授权，不会二次弹窗。
- 强制保险工具行为不变（上保险、审批一次、可被消费一次）；人类强制仍由长按 5 秒确认，不需要 AI 保险。
- 验证：`node --check`；session-writer 19 / resumable 22 / checkpoint-holds 9 / force-safeguard 8 全过。

#### 变更

- `restart_dsh_force_dangerous` 内部执行顺序由「先校验保险 → 再审批」改为「先审批 → 再校验/消费保险」。
- 删除 hotfix.1 引入的两个待办/注意力判定函数、guard 和 forceTool 中的所有放行分支及相关文案。
- guard 不再在审批被拒时消费保险。

#### 动机

- hotfix.1 的待办放行依赖审批前消费保险，导致审批被拒时保险被提前消费、无法直接重试；本版本修复该缺陷并简化流程。

#### 兼容性

- 对 AI 调用方契约不变：仍然必须先 `restart_dsh_force_safeguard` 再 `restart_dsh_force_dangerous`。
- 错误消息文本无变化（无保险时的引导文案保持原样）。
- 离线场景下审批被注意力插件自动拒绝并进入待办收件箱，行为与 hotfix.1 最终效果一致。

#### 迁移

- 无需修改任何调用方代码或 prompt。
- 装后必须重启 DSH。

### 1.8.1-hotfix.1（2026-11-02，已在 hotfix.2 移除该放行）

- **待办收件箱放行**：检测到待办收件箱服务已启用且自动入队开启时，非完全权限下的强重启不再被 guard 直接拦截——guard 放行到工具体，由工具体分流：
  - 完全访问：不发起审批，提示先上保险；
  - 用户在线：不发起审批，提示“离线时这次请求才会自动进待办”；
  - 用户离线：发起一次审批，注意力插件自动拒绝后这次强重启随拒绝进入待办收件箱，错误里追加说明；
  - **保险仍然必须**：没有已消费的 safeguard，任何路径都不会真正重启。
- 有保险时的原流程（`authorize → requestRestart → holdToolCall`）与挂起语义不变。
- **hotfix.2 移除**：该放行依赖审批前消费保险，导致审批被拒时保险被提前消费；hotfix.2 改为先审批、后校验保险，并删除全部分支与文案。
- 验证（历史）：`node --check`；session-writer 19 / resumable 22 / checkpoint-holds 9 全过；另以假 ctx 冒烟 8 个场景（无待办服务仍锁、待办服务关闭仍锁、完全访问不审批、在线不审批、离线 rejected 恰好一次审批并追加说明、离线 allowed-once 仍不重启、有保险原路径、插入其他工具仍重锁）。

#### 变更

- guard 新增两个待办/注意力判定函数，forceTool 新增四条分流分支。
- 离线场景下强重启可经审批自动拒绝进入待办收件箱。

#### 动机

- 让离线用户的强重启请求不被 guard 直接拦截，而是通过待办收件箱保留。

#### 兼容性

- 已被 hotfix.2 整体移除；从 hotfix.1 到 hotfix.2 或更高版本，待办放行分支消失，离线保底回归注意力插件自动拒绝路径。

#### 迁移

- 无需手动操作；装好即生效。

### 1.8.1（2026-11-01，正式版）

- 版本由 `1.8.0-hotfix.1` 提升为 **1.8.1**（正式版）。内容与 1.8.0-hotfix.1 完全一致：
  进度圈改为 SVG 圆环（修桌面版椭圆）并补回 `dirname` 导入；无 API、工具、配置变更。

#### 变更

- 版本号从 `1.8.0-hotfix.1` 提升为 `1.8.1`。
- 行为、API、工具、配置零变更。

#### 动机

- hotfix.1 修复已验证稳定，收进正式版本号。

#### 兼容性

- 与 `1.8.0-hotfix.1` 完全等价。

#### 迁移

- 装后必须重启 DSH。

### 1.8.0-hotfix.1（2026-11-01）

- **修复**：重启/关机全屏进度卡片里的旋转圈，在 DSH 桌面版（Electron/Chromium）显示为椭圆，网页版（Firefox）正常。
- **修复**：`index.js` 漏了 `dirname` 的导入（`node:path` 只导入了 `join`），桌面版经插件发起重启时会抛 `dirname is not defined`，重启不会执行；已补回 `import { dirname, join } from 'node:path'`。这条对 1.8.0 同样成立，属于 1.8.0 的回归。
- **原因**：圆环用 CSS `border` + `border-radius:50%` 绘制，而 spinner 是 column flex 的子项且没有 `flex:none`；桌面窗口较矮时卡片触发 `max-height`，spinner 被 flex-shrink 压成非正方形盒子，非正方形盒子上的圆角必然渲染为椭圆。
- **改法**：改用内联 SVG 圆环（`viewBox="0 0 31 31"`、`r=14.25`、`stroke-width=2.5`、四分之一弧 `stroke-dasharray="22.384 67.151"`），并给 `.dshrd-spinner` 加 `flex:0 0 auto`；SVG 几何只做等比缩放，盒子被压缩也不会变形。31px 保持旧 border-box 尺寸（26px 内容 + 2×2.5px 边框），视觉大小不变。
- 无 API、工具、配置变更；`npm test` 19 + 22 + 9 全绿。

#### SVG 圆环几何参数对照

| 参数 | 值 | 说明 |
|---|---|---|
| `viewBox` | `"0 0 31 31"` | 保持旧 border-box 尺寸 |
| `r` | `14.25` | 圆心到描边中心距离 |
| `stroke-width` | `2.5` | 描边宽度 |
| `stroke-dasharray` | `"22.384 67.151"` | 四分之一弧长 / 剩余弧长 |
| 31px 构成 | 26px 内容 + 2×2.5px 边框 | 与旧 CSS border-box 尺寸一致 |
| `.dshrd-spinner` | `flex:0 0 auto` | 防止 flex-shrink 压扁盒子 |

#### dirname 回归说明

- 1.8.0 将 `index.js` 的 `node:path` 导入改为仅导入 `join`，遗漏了 `dirname`。
- 桌面版（Electron）经插件发起重启时调用路径包含 `dirname`，抛出 `ReferenceError: dirname is not defined`，重启流程中止。
- Web 版未触发该路径，因此 1.8.0 在 Web 上表现正常，但桌面版无法重启。
- 本 hotfix 补回 `import { dirname, join } from 'node:path'`，同时适用于 1.8.0 的回滚修复。

#### 变更

- 进度圈实现从 CSS border 改为内联 SVG。
- `index.js` 补回 `dirname` 导入。

#### 动机

- 修复桌面版进度圈椭圆变形与重启失败两个阻塞问题。

#### 兼容性

- 纯视觉与内部导入修复；API、工具、配置零变更。

#### 迁移

- 装后必须重启 DSH。

#### 关键文件

- `client.js`：SVG 圆环模板与 `.dshrd-spinner` 样式。
- `index.js`：`dirname` 导入修复。

#### 测试

- `npm test`：session-writer 19 + resumable 22 + checkpoint-holds 9 = 50 条全绿。

### 1.8.0（2026-11-01，正式版）

- 版本统一为 **1.8.0**：`package.json`、`index.js` / `client.js` 头注释、`cordis.patch.yml` 顶部注释、`THIRD_PARTY_NOTICES.md`、README 与本文档。
- 文档拆分：`README.md` 改为 GitHub 风格项目介绍；新增 `TECHDOC.md`（架构/状态机/API/配置/状态文件/安全/测试）与 `HISTVER.md`（本文件）；`THIRD_PARTY_NOTICES.md` 保留并核对，补充运行时依赖说明。
- `package.json` 的 `files` 增加 `TECHDOC.md`、`HISTVER.md`；**无代码行为变更**（与 1.7.5-hotfix.9 等价）。

#### 变更

- 版本号从 `1.7.5-hotfix.9` 提升为 `1.8.0`。
- 文档由单 README 拆分为 README / TECHDOC / HISTVER / THIRD_PARTY_NOTICES 四份。
- `package.json` 的 `files` 数组新增 `TECHDOC.md`、`HISTVER.md`。

#### 动机

- 合并包拆分完成后恢复正式语义化版本号；文档拆分以提升可维护性。

#### 兼容性

- 与 `1.7.5-hotfix.9` 代码行为完全等价。

#### 迁移

- 装后必须重启 DSH。

#### 关键文件

- `package.json`、`index.js`、`client.js`、`cordis.patch.yml`、`THIRD_PARTY_NOTICES.md`、`README.md`、`TECHDOC.md`、`HISTVER.md`。

### 1.7.5-hotfix.9（拆分版）

- 从合并包拆出两个独立插件：`@local/dsh-power`（本包，`restart_dsh_*` 工具名不变）与 `@local/dsh-escape-pod`（1.0.0-hotfix.9）。本包移除逃生舱的 import、Cordis 行、`exports`/`files` 子路径与设置区块。
- `/api/dsh-restart/config` 回到 `{ ok, rollCallWaitMs, writable, persisted }`，`POST` 只接受 `{ rollCallWaitMs }`；设置页标题改为「电源设置」，只保留点名等待。
- 新增 `GET /api/dsh-restart/pod` → `{ ok, available }` 与 `POST /api/dsh-restart/shutdown` 的可选 `closeEscapePod`：只有显式 `true` 才在 DSH 退出前 `await escapePod.shutdown('dsh-power shutdown')`，失败只写日志、不阻止关机；关闭完成页显示「本页面与后端服务连接已断开，DSH已退出」，勾选过逃生舱时再加「运行的逃生舱已关闭」。

#### 变更

- 合并包拆分为 `@local/dsh-power`（本包）与 `@local/dsh-escape-pod`（1.0.0-hotfix.9）。
- 本包移除逃生舱相关 import、Cordis 行、`exports`/`files` 子路径与设置区块。
- `/api/dsh-restart/config` 响应体回到 `{ ok, rollCallWaitMs, writable, persisted }`，`POST` 只接受 `{ rollCallWaitMs }`。
- 设置页标题改为「电源设置」，只保留点名等待配置项。
- 新增 `GET /api/dsh-restart/pod` → `{ ok, available }`。
- `POST /api/dsh-restart/shutdown` 新增可选字段 `closeEscapePod`。

#### 动机

- 电源与逃生舱职责分离，各自独立发版、独立测试。

#### 兼容性

- `restart_dsh_*` 工具名、参数、返回值不变。
- 关机联动由默认行为改为可选：需显式传 `closeEscapePod: true` 才会关闭逃生舱。
- 设置页 URL 不变，但内容缩减为仅点名等待。

#### 迁移

- 装后必须重启 DSH。
- 若此前依赖关机时自动关闭逃生舱，需在关闭对话框中勾选「同时关闭正在运行的逃生舱」或在 API 调用中传 `closeEscapePod: true`。
- 逃生舱插件需单独安装 `@local/dsh-escape-pod`（1.0.0-hotfix.9 或更高）。

#### closeEscapePod 迁移说明

| 场景 | 1.7.5-hotfix.8 及以前 | 1.7.5-hotfix.9 起 |
|---|---|---|
| 关机时是否关闭逃生舱 | 默认关闭 | 默认不关闭，需显式 `closeEscapePod: true` |
| 关闭失败是否阻止关机 | 否（只写日志） | 否（只写日志），行为不变 |
| 关闭完成页文案 | 「本页面与后端服务连接已断开，DSH已退出」 | 同上；勾选过逃生舱时追加「运行的逃生舱已关闭」 |

#### 关键文件

- `index.js`：移除逃生舱 import 与 Cordis 行。
- `package.json`：移除逃生舱 `exports`/`files` 子路径与设置区块。
- `host/routes.js`：`/api/dsh-restart/config`、`/api/dsh-restart/pod`、`/api/dsh-restart/shutdown`。
- `client.js`：设置页标题与关闭对话框勾选逻辑。

### 1.7.5-hotfix.8

- 设置页新增「逃生舱」区块（启用、冻结模式、冻结时长 1–1440 分钟、再生次数 0–3），与电源设置共用保存按钮；写逃生舱自己的 `<dataRoot>/settings.json`，与电源的运行设置完全独立。
- 新增关闭门禁与冻结运行时：DSH 断开（最后一个认证客户端）10 秒后冻结所有运行中命令、回连自动解冻；每个 episode 到点消耗一次再生，耗尽后杀全部 job 并退出 pod；pod 单例监听，重复实例退出 0。
- 新增 `pod-settings` 11 条、`pod-freeze-policy` 22 条测试；实测门禁拒绝与冻结/解冻（`pod.log` 可查）。

#### 变更

- 设置页新增逃生舱配置区块：启用开关、冻结模式、冻结时长（1–1440 分钟）、再生次数（0–3）。
- 逃生舱设置写入 `<dataRoot>/settings.json`，与电源运行设置 `<DSH_HOME>/.dsh-restart/settings.json` 完全独立。
- 新增关闭门禁：最后一个认证客户端断开 10 秒后冻结所有运行中命令。
- 新增冻结运行时：回连自动解冻；每个 episode 到点消耗一次再生，耗尽后杀全部 job 并退出 pod。
- pod 单例监听：重复实例退出码 0。

#### 动机

- 为逃生舱提供独立的设置入口与运行时生命周期管理。

#### 兼容性

- 电源设置不受影响；逃生舱设置为新增功能。

#### 迁移

- 无迁移操作；新设置项有合理默认值。

#### 关键文件

- `client.js`：逃生舱设置页 UI。
- `host/pod-settings.js`：逃生舱设置读写。
- `host/pod-freeze-policy.js`：冻结/解冻/再生逻辑。
- `host/pod-gate.js`：关闭门禁。

#### 测试

- `pod-settings`：11 条。
- `pod-freeze-policy`：22 条。
- 实测门禁拒绝与冻结/解冻（`pod.log` 可查）。

### 1.7.5-hotfix.7

- 设置页保存改为写运行设置 `<DSH_HOME>/.dsh-restart/settings.json`，**不再编辑 profile patch**，因此保存不会触发热重载、不会 dispose 正在运行的 Agent/Session。
- 启动时按 mtime 决定运行设置与 patch 谁生效：运行设置更新则覆盖 patch；patch 之后被手工编辑则 patch 重新生效。
- `checkpoint-holds` 测试增加到 9 条（范围、round-trip、坏文件容错、mtime 优先级）；人工验证保存后 `restart.log` 没有新 `boot`、当前回合未中断。

#### 变更

- 设置页保存目标从 profile patch (`cordis.patch.yml`) 改为运行设置文件 `<DSH_HOME>/.dsh-restart/settings.json`。
- 保存不再触发插件热重载，不会 dispose 正在运行的 Agent/Session。
- 启动时按 mtime 决定运行设置与 patch 的优先级。

#### 动机

- 避免设置页保存导致正在运行的会话中断。

#### 兼容性

- 运行设置与 patch 通过 mtime 自动协调；手工编辑 patch 后 patch 重新生效。

#### 迁移

- 无手动迁移；首次保存即生成运行设置文件。

#### 关键文件

- `host/checkpoint-holds.js`：运行设置读写与 mtime 比较。
- `client.js`：设置页保存逻辑。

#### 测试

- `checkpoint-holds`：9 条（范围、round-trip、坏文件容错、mtime 优先级）。
- 人工验证：保存后 `restart.log` 没有新 `boot`、当前回合未中断。

### 1.7.5-hotfix.6

- 合并包内 `podc_run` / `podc_exec` 新增 `shell: powershell | cmd | bash`（默认 `powershell`）：`cmd.exe /d /s /c`、`bash --noprofile --norc -c`，bash 按 `bashPath` → `DSH_ESCAPE_POD_BASH` → DSH ops 自带 PortableGit → PATH 的顺序发现。
- 规避 Windows 系统 Git 2.49 的 bash 在受限令牌下崩溃；新增 `escape-pod-shell` 7 条测试，三种 shell 与中文管道实测通过。

#### 变更

- `podc_run` / `podc_exec` 新增 `shell` 参数，支持 `powershell`（默认）、`cmd`、`bash`。
- `cmd` 使用 `cmd.exe /d /s /c`。
- `bash` 使用 `bash --noprofile --norc -c`。
- bash 发现顺序：`bashPath` 配置 → `DSH_ESCAPE_POD_BASH` 环境变量 → DSH ops 自带 PortableGit → PATH。

#### 动机

- 规避 Windows 系统 Git 2.49 的 bash 在受限令牌下崩溃的问题。

#### 兼容性

- 默认 `powershell`，行为与之前一致。
- `cmd` 和 `bash` 为新增选项，不影响现有调用。

#### 迁移

- 无需迁移；新参数可选。

#### 关键文件

- `host/escape-pod-shell.js`：shell 发现与执行逻辑。

#### 测试

- `escape-pod-shell`：7 条（三种 shell 与中文管道实测通过）。

### 1.7.5-hotfix.5

- `host/session-writer.js` 的 `deliverAsMessage`：Agent 正在运行时用 `agent.steer(UserMessage)`（下一步边界被 claim），idle 时用 `agent.followup(UserMessage)`；跨重启结果无需用户手动发送即可进入回合。
- `session-writer` 测试增至 19 条（新增 idle → followup 用例）；实测 40 tick 任务跨点名重启后结果自动出现。

#### 变更

- `deliverAsMessage` 根据 Agent 状态选择送达方式：运行中用 `steer`，idle 用 `followup`。
- 跨重启结果自动进入回合，无需用户手动发送。

#### 动机

- 确保跨重启结果在任何 Agent 状态下都能正确送达。

#### 兼容性

- 对调用方透明；行为改进不影响现有流程。

#### 迁移

- 无迁移操作。

#### 关键文件

- `host/session-writer.js`：`deliverAsMessage` 实现。

#### 测试

- `session-writer`：19 条（新增 idle → followup 用例）。
- 实测：40 tick 任务跨点名重启后结果自动出现。

### 1.7.5-hotfix.4

- 修复点名完成通知的 `"interruptedResults is not defined"`：`index.js` 的 `completionText` 提前解析 `interruptedResults`，发起者不再投递失败。
- 完成 15 秒点名覆盖实测：超时 AI 收到 `coordinated_timeout` 通知，发起者收到完成通知，可恢复调用结果回填成功。

#### 变更

- `index.js` 的 `completionText` 提前解析 `interruptedResults` 变量。

#### 动机

- 修复点名完成通知因引用未定义变量而投递失败的 bug。

#### 兼容性

- 纯 bug 修复；行为回归到预期状态。

#### 迁移

- 无迁移操作。

#### 关键文件

- `index.js`：`completionText` 模板与 `interruptedResults` 解析。

#### 测试

- 15 秒点名覆盖实测：超时 AI 收到 `coordinated_timeout` 通知，发起者收到完成通知，可恢复调用结果回填成功。

### 1.7.5-hotfix.3

- `host/session-writer.js` 新增 `turnIsClosed()`：回合已关闭时不再向 `turn/end` 之后追加/替换 `tool/result`，真实结果改用 `agent.steer` / `agent.followup` 以 `<dsh_resumable_tool_result …>` 信封送达；`host/resumable.js` 新增 `deliveredAsMessage` 结算（不设 `resultSeq`）。
- 修复 hotfix.1 回填把会话日志写坏的事故；persisted-only 或 agent 不在时转为 deferred 重试。

#### 变更

- `host/session-writer.js` 新增 `turnIsClosed()` 检测函数。
- 回合已关闭时，真实结果改用 `agent.steer` / `agent.followup` 以 `<dsh_resumable_tool_result …>` 信封送达。
- `host/resumable.js` 新增 `deliveredAsMessage` 结算类型（不设 `resultSeq`）。
- persisted-only 或 agent 不在时转为 deferred 重试。

#### 动机

- 修复 hotfix.1 回填把会话日志写坏的事故；避免向已关闭回合追加无效 `tool/result`。

#### 兼容性

- 对调用方透明；结算类型扩展不影响现有流程。

#### 迁移

- 无迁移操作。

#### 关键文件

- `host/session-writer.js`：`turnIsClosed()`、信封送达逻辑。
- `host/resumable.js`：`deliveredAsMessage` 结算。

#### 测试

- 人工验证：回合关闭后回填不再写坏会话日志。

### 1.7.5-hotfix.2

- 点名限时到点后，除发起者外仍未就绪的 AI 也会收到中断通知（新增 `coordinatedNotifyTimedOut`，默认开启，通知标签 `mode="coordinated_timeout"`）；完成通知汇总成功/失败数。
- 检查点与恢复报告新增 `heldToolCalls`（按会话）与 `totals.heldToolCalls`，把 `resumableToolCalls` 接管的调用写成「可恢复调用」，不再误报「本会话没有未决工具调用或后台任务」。

#### 变更

- 新增 `coordinatedNotifyTimedOut` 配置（默认开启）。
- 点名超时 AI 收到 `mode="coordinated_timeout"` 通知。
- 完成通知汇总成功/失败数。
- 检查点与恢复报告新增 `heldToolCalls`（按会话）与 `totals.heldToolCalls`。
- `resumableToolCalls` 接管的调用在报告中显示为「可恢复调用」。

#### 动机

- 让超时 AI 明确知道自己被中断；恢复报告准确反映可恢复调用状态。

#### 兼容性

- `coordinatedNotifyTimedOut` 默认开启，行为向后兼容。
- 恢复报告字段扩展，不影响现有消费者。

#### 迁移

- 无迁移操作。

#### 关键文件

- `index.js`：`coordinatedNotifyTimedOut` 逻辑、完成通知汇总。
- `host/checkpoint-holds.js`：`heldToolCalls` 写入。
- `host/resumable.js`：可恢复调用结算。

#### 测试

- 人工验证：超时 AI 收到通知，恢复报告显示可恢复调用。

### 1.7.5-hotfix.1

- 逃生舱组件化进合并包：新增第二个组件、独立开关、`escape-pod/` 子路径与图标；后台 job 跨 DSH 重启继续运行。
- 恢复 `resumableToolCalls` 服务（`host/resumable.js` + `host/session-writer.js` + boot 恢复/结算）：插件可持有工具调用并在下次启动回填真实结果；前台 `podc_exec` 跨重启回填实测通过，未出现 `TOOL_OUTCOME_UNKNOWN`。

#### 变更

- 逃生舱组件化进合并包：新增第二个组件、独立开关、`escape-pod/` 子路径与图标。
- 后台 job 跨 DSH 重启继续运行。
- 恢复 `resumableToolCalls` 服务：插件可持有工具调用并在下次启动回填真实结果。

#### 动机

- 将逃生舱纳入合并包统一管理；恢复跨重启工具调用回填能力。

#### 兼容性

- `resumableToolCalls` 为新增服务，不影响现有工具。

#### 迁移

- 无迁移操作。

#### 关键文件

- `host/resumable.js`：`resumableToolCalls` 服务实现。
- `host/session-writer.js`：boot 恢复/结算。
- `escape-pod/`：逃生舱组件目录。

#### 测试

- 前台 `podc_exec` 跨重启回填实测通过，未出现 `TOOL_OUTCOME_UNKNOWN`。

### 1.7.5（基线正式版）

- 合并 1.7.4-hotfix.4–11：强制重启/关闭不可阻挡（独立 detached 回收器 `force-reaper.mjs`，`taskkill /F` 强杀后自动拉起；桌面版结束并重开应用）。
- boot 时对上次强制尝试的 spec / marker / lock 对账并写 `lastForceOutcome`，失败进入 `hold`；新增单文件 `status.json` 快照、外部恢复 CLI `scripts/restart-cli.mjs`、`forceDryRun` 演练开关。
- 点名工具定名 `restart_dsh_roll_call_caution`，新增 `rollCallWaitMs` 限时等待（默认 120000，`0` = 永久）；人类文案统一为「等待 / 中断 / 强制」，全等待更名为阻塞等待。

#### 变更

- 合并 1.7.4-hotfix.4–11 全部内容。
- 强制重启/关闭不可阻挡：独立 detached 回收器 `force-reaper.mjs`，`taskkill /F` 强杀后自动拉起；桌面版结束并重开应用。
- boot 时对上次强制尝试的 spec / marker / lock 对账并写 `lastForceOutcome`，失败进入 `hold`。
- 新增单文件 `status.json` 快照。
- 新增外部恢复 CLI `scripts/restart-cli.mjs`。
- 新增 `forceDryRun` 演练开关。
- 点名工具定名 `restart_dsh_roll_call_caution`。
- 新增 `rollCallWaitMs` 限时等待（默认 120000 ms，`0` = 永久等待）。
- 人类文案统一为「等待 / 中断 / 强制」，全等待更名为阻塞等待。

#### 动机

- 整合 1.7.4 线所有 hotfix，形成稳定基线版本。

#### 兼容性

- 与 1.7.4-hotfix.11 行为等价。

#### 迁移

- 装后必须重启 DSH。

#### 关键文件

- `force-reaper.mjs`：独立 detached 回收器。
- `scripts/restart-cli.mjs`：外部恢复 CLI。
- `host/status.js`：`status.json` 快照与 `lastForceOutcome` 对账。
- `index.js`：`restart_dsh_roll_call_caution` 工具、`rollCallWaitMs` 配置。

### 1.7.4（合并包时期，restart-bundle）

拆分前的 `@local/dsh-restart-bundle`（本插件前身）1.7.4 线共 12 个版本：`1.7.4` 本体 + `hotfix.1`–`hotfix.11`。以下条目按版本倒序，逐条事实**誊抄**自归档的 `.del/pod/restart-bundle/README.md`「版本」节（与 `local-dsh-restart-bundle-1.7.5-hotfix.8.tgz` 内 README 同源）；各版本括号内的时刻为对应归档 tgz 的文件 mtime（`.del/DSH-Plugin-tgz-history-20261030/`，无 release note 可交叉验证）。1.7.4 本体与 1.7.3 及更早的一句话摘要见下一节「更早的版本」。

- **`hotfix.4` 与 `hotfix.11` 不另立小节**：两者内容已完整收录在上文 [1.7.5（基线正式版）](#175基线正式版) 的变更清单里（强制回收器 / boot 对账 / 外部 CLI / `forceDryRun` 来自 hotfix.4–5；阻塞等待更名与人类文案改写来自 hotfix.11），此处不重复。另注：归档同时留有 `-hotfix.11.tgz`（2026-10-30 22:45）与 `-hotfix.11-rebuilt.tgz`（23:04）两份同版本号实物（文案措辞与打包工具不同），哪份被 1.7.5 继承**无法验证**。

#### 1.7.4-hotfix.10（2026-10-30 22:41）

- 超时结果补齐展示面——`status.json` 的 `lastRestart` 增加 `timedOutCount` / `timedOutSessionIds`，点名完成 toast 在超时后显示「仍有 N 个 AI 未进入就绪状态」；其余同 hotfix.9。

#### 1.7.4-hotfix.9（2026-10-30 22:39）

- 点名限时结果持久化——`lastRestart` 与 `safeState` 记录 `timedOutSessions` / `timedOutCount`，状态接口与 CLI 在 intent 删除后仍能看到超时 AI；投递完成后刷新 `status.json`，不再保留上一轮的重启摘要。

#### 1.7.4-hotfix.8（2026-10-30 22:29）

- 点名工具更名为 `restart_dsh_roll_call_caution`（旧名 `restart_dsh_roll_call_safe`）；新增 `rollCallWaitMs` 点名限时等待（默认 120000，`0` = 永久等待，范围 0..3600000），等待用尽就继续重启，并在 intent、状态接口与完成通知里记录仍未进入等待的 AI。
- 插件详情页新增「点名等待」设置面板（`configEditor` 写回配置行 + Loader 重新加载）；`package.json` description 与 `locale/{zh,en}.json` 的标题/描述瘦身为面向人类的短说明，逐年 hotfix 历史只保留在当时的 README。

#### 1.7.4-hotfix.7（2026-10-30 21:11）

- boot 对账时，普通等待/点名重启的 relaunch marker 只被清理，不再覆盖持久化的 `lastForceOutcome`（此前会被误记为 `specPresent:false` 的最后一次「强制」结果）；其余同 hotfix.6。

#### 1.7.4-hotfix.6（2026-10-30 21:04）

- `lastForceOutcome` 与 `hold` 跨 boot 持久化（上次强制重启的对账结果不再被下一次启动清空），确认成功时解除早先失败留下的 hold；其余同 hotfix.5。

#### 1.7.4-hotfix.5（2026-10-30 20:14）

- 新增外部 CLI `scripts/restart-cli.mjs`（`status` / `relaunch` / `clear-stale` / `unhold`，Host 死后也能诊断与拉起）；boot 时对上次强制重启的 spec / marker / lock 做对账并写 `lastForceOutcome`，失败或未知结果进入 `hold`；新增单文件 `status.json` 快照；新增 `forceDryRun` 演练开关；强制前 fail-closed 校验 relaunch 目标并写入 reaper spec。
- 上述结构借鉴 `hxh230802/dsh-tray-restart`（MIT，见 `THIRD_PARTY_NOTICES.md`）。

#### 1.7.4-hotfix.3（2026-10-25 23:55）

- 修复恢复报告延迟投递后的 resume 计数——报告在 `agent/created` 投递后会把 `missing` 修正为 `resumed`、`pending` 转为 `delivered`，状态工具不再显示「未恢复 1 个会话」。

#### 1.7.4-hotfix.2（2026-10-25 22:35）

- 重启前写有界、脱敏的 checkpoint（session / 未决工具调用 / 后台 job）；重启后向受影响会话投递恢复报告，明确工具结果未知、后台任务不可接回；状态接口与 `restart_dsh_status` 增加 checkpoint/resume 计数。
- 不包含 freeze / 逃生舱 / Caution / 待办。

#### 1.7.4-hotfix.1（2026-10-24 04:28）

- 关闭等待增加硬上限（`shutdownMaxWaitMs` 默认 5 分钟，`0` 恢复无限）与取消后宽限（`shutdownGraceMs`）。
- testMode 路由接入 Host / Origin / 鉴权校验；新增只读 `restart_dsh_status` 工具；人类重启/关闭可填写原因。
- 长按仅主键并在失焦/隐藏/指针取消时取消；入口回退槽修复「DOM 失联后无入口」；关闭完成判定改为连续失败；`bootId` 缺失有兜底；relauncher 改为 marker 握手；配置夹取、日志轮转、状态清理与 `activeNotSafeAgents` 修正。

### 更早的版本（1.7.4 及以前）

| 版本 | 要点 |
|---|---|
| 1.7.4 | 人类菜单「重启 / 关闭」+ 弹窗内下拉「等待 / 中断 / 强制」；关闭同样三选一但不再启动；桌面版新增 `quit-desktop.mjs`。 |
| 1.7.3 | 测试版：菜单简化、关闭三模式、账号行布局修复、桌面关闭 helper（hotfix 未改版本号）。 |
| 1.7.2 | 四个 AI 工具改名；人类按钮挂到侧边栏 settingsArea；等待可取消、中断二次确认、强制长按 5 秒；人类强制不需要 AI 保险。 |
| 1.7.1 | 等待模式改为 `workspace-write` 及以上免审批；点名激活期间等待类工具临时免审批；就绪状态文本修正。 |
| 1.7.0 | 三种重启模式 + 强制保险 + 模式化通知与客户端红色强制 toast。 |
| 1.6.x | 三模块拆分、AI 重启工具、预设恢复、等待其他 AI 等。 |

## 版本号命名说明

- `1.7.5-hotfix.N` 是拆分前的迭代标识；
- 1.8.0 起恢复正式版本号，`1.8.1-hotfix.N` 是 1.8.1 上的 hotfix 迭代标识，已在 **1.8.2（正式版，v0.0.1）** 整体收进正式版（版本 = 1.8.1 + 0.0.1）；
- 现有代码注释里的 `hotfix.N` 是历史改动标记，不一定是当前版本号。

## 许可

本文件以 MIT 许可发布，版权归 DX12_XYZ 所有。完整条款见仓库根 [LICENSE](./LICENSE)。

<!-- fused-by: deepseek-v4.1-flash -->

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
