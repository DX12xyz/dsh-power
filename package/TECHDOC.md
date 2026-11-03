# DSH 电源 · 技术文档（TECHDOC）

> **文档状态**
>
> - 适用版本：`@local/dsh-power` **1.8.2**（v0.0.1）。
> - 验证运行时：DSH **0.2.1-rc.5**（Web，Windows）；Web + Desktop（Windows）版本均可。
> - 最后校对时间：2026-11-03。
> - 读者：开发者 / 运维。本文只描述已实现的代码行为，接口、常量与行为一律以源码为准。
> - 源码为准的文件清单：`index.js`、`host/*.js`、`client.js`、`force-reaper.mjs`、`relauncher*.mjs`、`scripts/restart-cli.mjs`。
> - 版本标识：`package.json` 的 `version` 与 `host/constants.js` 的 `PLUGIN_VERSION` 均为 `1.8.2`。
> - 配套文档：[README](./README.md) 负责定位、安装与最小上手；[HISTVER](./HISTVER.md) 负责版本演进与兼容性说明（正式公开基线及之后的版本）；文中按版本号引用的私有时期记录（如「HISTVER 1.7.5-hotfix.N 的记录」）已迁至 [HISTVER_legacy.md](./HISTVER_legacy.md)，仅供参考、不作为对外契约。

## 目录

- [1. 架构](#1-架构)
  - [1.1 两个半身](#11-两个半身)
  - [1.2 清单与 Cordis patch 行](#12-清单与-cordis-patch-行)
  - [1.3 客户端入口](#13-客户端入口)
  - [1.4 辅助进程](#14-辅助进程)
  - [1.5 平台与 home](#15-平台与-home)
  - [1.6 源码文件清单](#16-源码文件清单)
  - [1.7 与逃生舱的边界](#17-与逃生舱的边界)
  - [1.8 组件与数据流](#18-组件与数据流)
  - [1.9 一次重启的完整时序](#19-一次重启的完整时序)
  - [1.10 包属性与安装](#110-包属性与安装)
- [2. 工具与 API 参考](#2-工具与-api-参考)
  - [2.1 五个 AI 工具](#21-五个-ai-工具)
  - [2.2 restart-dsh skill 与调用超时](#22-restart-dsh-skill-与调用超时)
  - [2.3 HTTP API 路由](#23-http-api-路由)
  - [2.4 testMode 自测路由](#24-testmode-自测路由)
  - [2.5 closeEscapePod 流程](#25-closeescapepod-流程)
  - [2.6 工具调用链与挂起结束](#26-工具调用链与挂起结束)
- [3. 状态与持久化](#3-状态与持久化)
  - [3.1 重启状态机](#31-重启状态机)
  - [3.2 关闭状态机](#32-关闭状态机)
  - [3.3 点名与就绪状态](#33-点名与就绪状态)
  - [3.4 检查点与恢复报告](#34-检查点与恢复报告)
  - [3.5 resumableToolCalls](#35-resumabletoolcalls)
  - [3.6 状态文件](#36-状态文件)
  - [3.7 运行设置的 mtime 优先级](#37-运行设置的-mtime-优先级)
- [4. 安全模型](#4-安全模型)
  - [4.1 权限与审批](#41-权限与审批)
  - [4.2 强制保险](#42-强制保险)
  - [4.3 界面确认](#43-界面确认)
  - [4.4 路由与外部调用](#44-路由与外部调用)
  - [4.5 强制模式与 force reaper](#45-强制模式与-force-reaper)
- [5. 配置字段](#5-配置字段)
  - [5.1 配置表](#51-配置表)
  - [5.2 运行设置](#52-运行设置)
- [6. 测试与验证](#6-测试与验证)
  - [6.1 语法检查](#61-语法检查)
  - [6.2 四套 Node 测试](#62-四套-node-测试)
  - [6.3 覆盖范围](#63-覆盖范围)
  - [6.4 沙箱与打包注意](#64-沙箱与打包注意)
  - [6.5 验证清单与跨版本校对](#65-验证清单与跨版本校对)
- [7. 附录](#7-附录)
  - [7.1 常量表](#71-常量表)
  - [7.2 错误码与标记](#72-错误码与标记)
  - [7.3 术语表](#73-术语表)
  - [7.4 已知边界](#74-已知边界)

常用落点：进程结构见 [1.1](#11-两个半身)，路由见 [2.3](#23-http-api-路由)，状态文件见 [3.6](#36-状态文件)，权限矩阵见 [4.1](#41-权限与审批)，全部数值常量见 [7.1](#71-常量表)。

## 1. 架构

本包在进程层面分为 Host 半身与 Client 半身：Host（`index.js` + `host/*.js`）持有全部状态机、工具、权限判断、路由与持久化；Client（`client.js`）只负责浏览器侧界面并通过 `/api/dsh-restart/*` 与 Host 通信。两者之外还有 4 个 detach 辅助进程与 1 个零依赖外部 CLI，用于跨进程重启、强制回收与 Host 死亡后的诊断。

### 1.1 两个半身

| 半身 | 入口 | 职责 |
|---|---|---|
| Host | `index.js` + `host/*.js` | 重启/关闭状态机、五个 AI 工具、权限与审批、点名广播、检查点与恢复报告、`/api/dsh-restart/*` 路由、`resumableToolCalls` 服务、启动对账 |
| Client | `client.js` | 侧边栏按钮与菜单、重启/关闭对话框、长按 5 秒确认、等待/失败/关闭页、toast、插件详情页「电源设置」 |

`index.js` 的 Cordis 依赖声明为 `inject = ['tools', 'agents', 'sessions', 'skills']`。网页版相关能力按需注入：

| 注入项 | 用途 |
|---|---|
| `connection` | 注册 fetch 路由 |
| `webServer` | `testMode` 自测路由 |
| `approval` | 权限不足时请求审批 |
| `escapePod` | 可选，关机联动 |
| `sessionPersistence` | 会话 flush |

`profileContext` 用于取 DSH home 与 profile patch 路径。

### 1.2 清单与 Cordis patch 行

`package.json` 的 `dsh` 段声明了 bundle 与 client：

```json
{
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "immediately": true,
    "inject": ["@deepseek-ai/dsh-client-ui-sidebar", "@deepseek-ai/dsh-client-ui-layout"]
  }
}
```

`cordis.patch.yml` 只有一行 `insert`：

```yaml
# 节选自 cordis.patch.yml；该文件仅有这一段 insert 声明
- insert:
    - id: dsh-power
      name: '@local/dsh-power'
      config:
        rollCallWaitMs: 120000
```

**Client 半身的发现方式**：Loader 读取包清单的 `dsh.client` 段，把 `client.js` 作为网页版客户端插件加载（`platform: web`、`immediately: true`），并预先注入 sidebar / layout 两个客户端 UI 包。因此一个 Host 行就够，不需要为 Client 另写 patch 行。

### 1.3 客户端入口

`client.js` 通过 `window.__ModuleLoader__.load({ id: '@local/dsh-power', factory })` 注册，客户端 `inject = ['slots', 'locale', 'connection']`：

- **主入口**：`startDomPowerWatch()` 用 `MutationObserver` 把「DSH电源」图标按钮追加到侧边栏 footer 的 `div[class*="_settingsArea"]`（网页版与桌面版共用该 DOM）。
- **备用入口**：`sidebar.footer.action` 槽位（id `restart-dsh-power`），settingsArea 长时间不出现时仍有入口。
- **覆盖层**：`shell.overlay` 槽位（id `restart-dsh-overlay`）承载菜单、对话框、进度页、失败页、关闭完成页与 toast。
- **设置页**：`plugins.bundle.config` 槽位、key = `@local/dsh-power`，标题「电源设置」。
- 连接状态不是 `connected` 时隐藏侧边栏按钮并关闭菜单；`bootId` 变化后轮询 `/api/dsh-restart/status` 判定重启完成并刷新页面。

进度页里的旋转圈由内联 SVG 绘制（`progressSpinner()`：`viewBox="0 0 31 31"`、`r=14.25`、`stroke-width=2.5`，高亮弧是四分之一周长 `stroke-dasharray="22.384 67.151"`，`rotate(-135 15.5 15.5)` 对齐旧的 `border-top` 位置）。**不要改回 CSS 边框圆环**：桌面版（Chromium）在窗口较矮时会把 column flex 里的 spinner 压缩，非正方形盒子上的 `border-radius:50%` 必然画成椭圆；SVG 的 `viewBox` + `preserveAspectRatio` 只做等比缩放，`flex:0 0 auto` 则阻止压缩。31px 的盒子保持旧 border-box 的尺寸（26px 内容 + 2×2.5px 边框），视觉大小不变。

`host/human.js` 只记录一行日志（人类入口由 `client.js` 渲染），不创建托盘项、不 patch Electron。

界面流程与客户端反馈（只写源文档明确写出的行为）：

- 菜单只有「重启 / 关闭」两项；重启弹窗用下拉选「等待 / 中断 / 强制」，**默认「等待」**，可填写可选原因（会出现在重启后的通知里）。
- 关闭弹窗同样三选一，但只关闭、不再启动；模式下拉框下方是「同时关闭正在运行的逃生舱」复选框（**红色样式**，仅 Host 服务 `escapePod` 存在时显示，默认不勾选）。
- 等待：确认框可取消；中断：点「下一步」后再确认一次；强制：红色警告，确认按钮需长按 5 秒，**满 5 秒自动提交**（取消条件见 [4.3](#43-界面确认)）。
- 重启期间页面会短暂断开连接，随后自动恢复；默认不会打开新标签页（`openBrowserOnRelaunch` 可改）。
- 强制模式完成时显示红色警告 toast（含被中断数量与通知结果）。
- 关闭完成页显示「本页面与后端服务连接已断开，DSH已退出」；勾选过逃生舱时其下再显示「运行的逃生舱已关闭」。

### 1.4 辅助进程

| 文件 | 启动方 | 作用 |
|---|---|---|
| `relauncher.mjs` | Host（detach） | 网页版重启：等旧 Host PID 退出，用同一 node/args/cwd 启动新 Host；通过 `relaunch-ready.json` marker 与 Host 握手 |
| `relauncher-desktop.mjs` | Host（detach，`ELECTRON_RUN_AS_NODE=1`） | 桌面版重启：结束 Electron 外壳 → 等旧 Host 退出 → 重开桌面应用 |
| `quit-desktop.mjs` | Host（detach） | 桌面版关闭：Host 退出前结束 Electron 外壳，避免「DSH 后端错误」弹窗 |
| `force-reaper.mjs` | Host（detach） | 强制重启/关闭：等待优雅退出超时后强杀 Host，再按模式重新拉起或结束外壳 |
| `scripts/restart-cli.mjs` | 人工/脚本 | 零依赖 ESM CLI：`status` / `relaunch` / `clear-stale` / `unhold`，Host 已死也能用 |

### 1.5 平台与 home

- `detectDesktopShell()`：`process.argv` 中出现 `/dsh-desktop-host/`（反斜杠先归一为 `/`）即判定桌面版；否则为 `web`。
- home 解析顺序：

| 顺序 | 来源 |
|---|---|
| 1 | `config.home` |
| 2 | `ctx.get('profileContext').home` |
| 3 | `DSH_HOME` |
| 4 | `~/.dsh` |

- 状态目录：`<home>/.dsh-restart/`。

### 1.6 源码文件清单

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

### 1.7 与逃生舱的边界

- 逃生舱是独立插件 `@local/dsh-escape-pod`（版本见其 `package.json`）。两个包各自独立发布与安装，本文件只用包名与版本事实提及它，不做跨包链接。
- 本包**不 import** 它、不读它的设置文件、不注册它的行。
- 唯一联动：
  - `GET /api/dsh-restart/pod` 报告 `escapePod` 服务是否存在；
  - `POST /api/dsh-restart/shutdown` 的可选 `closeEscapePod:true` 在 DSH 退出前调用 `escapePod.shutdown('dsh-power shutdown')`。
- 重启不关闭逃生舱：逃生舱里的命令随 DSH 重启继续运行。
- 逃生舱的冻结/再生、`pod_*` 工具、设置页与生命周期都在独立包内，不在本文档范围内。

关掉逃生舱的完整链路见 [2.5](#25-closeescapepod-流程)。

### 1.8 组件与数据流

下图只画源文档明确写出的组件与文件流向；实际调用顺序以源码为准。

```text
[1] 入口
    人类界面 client.js  ── POST /api/dsh-restart/request  /  shutdown
    AI 模型             ── restart_dsh_* 工具（先审批 / 强制保险）
                         │
[2] Host 半身（index.js + host/*.js）
    requestRestart()    唯一的 pending 记录（合并 / 升级 / 退化）
    maybeFinalize()     等待 / 点名广播 / 限时 / 静默期
    finalizeRestart()   checkpoint.json → restart-intent.json → status.json 快照
                         │
[3] 退出与拉起（按平台与模式四选一）
    ├─ 网页版重启：relaunch-spec.json → relauncher.mjs
    │              （等旧 Host PID 退出，同 node/args/cwd 拉起新 Host，
    │                用 relaunch-ready.json marker 与 Host 握手）
    ├─ 桌面版重启：relauncher-desktop.mjs
    │              （结束 Electron 外壳 → 等旧 Host 退出 → 重开应用）
    ├─ 强制重启：  force-reaper-spec.json → force-reaper.mjs
    │              （等 forceKillAfterMs，超时 taskkill /F 强杀，再按 spec 拉起）
    └─ 强制关闭：  同上的回收器；Host 死亡即完成，桌面版同时结束外壳
                         │
[4] 新 boot
    restart-intent.json → 按模式投递通知 → 写 state.lastRestart
    → 刷新 status.json → 删除 intent
    强制模式：boot 对账 → lastForceOutcome / hold
    resumableToolCalls：恢复 holds → 写 provisional 结果
```

组件与状态文件的读写关系（`写入方` 直接来自 [3.6](#36-状态文件) 的表格）：

| 组件 | 读取（源文档明示） | 写入 |
|---|---|---|
| Host（`index.js` + `host/*.js`） | `restart-intent.json`（新 boot 投递）、`resumable-holds.json`（boot 恢复）、force spec / marker / lock（boot 对账）、`settings.json` 与 profile patch（mtime 比较） | `restart.log`、`state.json`、`status.json`、`settings.json`、`checkpoint.json`、`restart-intent.json`、`relaunch-spec.json`、`force-reaper-spec.json`、`force-dry-run.json` |
| `resumableToolCalls`（Host 服务） | `resumable-holds.json`（boot 恢复） | `resumable-holds.json` |
| `relauncher.mjs` | `relaunch-spec.json` | `relaunch-ready.json`（marker）、`relaunch.log` |
| `relauncher-desktop.mjs` | — | `relaunch-desktop.log` |
| `quit-desktop.mjs` | — | `quit-desktop.log` |
| `force-reaper.mjs` | `force-reaper-spec.json` | `relaunch-ready.json`（marker）、`force-relaunch.lock` |
| `scripts/restart-cli.mjs` | `status.json`（Host 死后） | 通过命令执行 `relaunch` / `clear-stale` / `unhold` |

表中「—」表示源文档没有写明该组件的读写，不要据此推断它不读写。

### 1.9 一次重启的完整时序

把源文档「重启状态机」（等待与收尾、重启后投递）、「resumableToolCalls」与「强制模式与 force reaper」（boot 对账）的事实串成一条时间线；跨进程的先后关系以源码为准。

1. **发起**：人类界面 `POST /api/dsh-restart/request`（服务端固定 `source: 'ui'`），或 AI 调用 `restart_dsh_*` 工具（强制路径先审批、再校验并消费保险）。`requestRestart()` 建立唯一的 `pending` 记录并写入 `requesters[]`。
2. **合并与升级**：相同 `(sessionId, source)` 的重复请求只更新发起者记录；模式按「强制 > 点名 > 阻塞等待」升级；点名模式下非第一发起者退化为阻塞等待（速查表见 [3.1.2](#312-请求合并与升级)）。
3. **等待循环**：`maybeFinalize()` 每 `pollMs`（默认 150ms）检查一次——safe 等 `blockingRunningAgents(pending)` 为空；coordinated 每轮广播 `broadcastSafeStateRequest()`，到 `coordinatedDeadlineAt` 立即收尾并把仍未就绪的 AI 记为超时，否则等 `activeNotSafeAgents(pending)` 为空；dangerous 不等待，请求路径直接安排收尾。
4. **静默期**：条件满足后还要经过 `graceMs`（默认 750ms，`lastIdleAt`），避免刚好在回合边界抖动。
5. **收尾（`finalizeRestart()`）**：`resolveLaunch()` → `captureCheckpoint()` 写 `checkpoint.json` → 计算 `interrupted` / `timedOutSessions` → 写 `restart-intent.json` → 立即写 `status.json` 快照 → 按平台与模式退出。
6. **强制路径**：`spawnForceReaper()` → 有界 flush（`min(dangerousFlushTimeoutMs, 800ms)`）→ `hardKillSelf()`；回收器等 `forceKillAfterMs`（默认 2500ms）后强杀 Host，再按 spec 拉起或结束外壳。
7. **桌面版路径**：flush → `spawnDesktopRelauncher()` → `scheduleDesktopRelaunchGuard()`；`desktopRelaunchTimeoutMs`（默认 25000ms）内应用没重启就回滚 `pending`、失败 held 调用并发失败通知。
8. **网页版路径**：写 `relaunch-spec.json` → `spawnRelauncher()`（等与本次 `requestId` 匹配的 readiness marker，最多 3 秒）→ flush → `appExit(0)`，同时挂 `exitWatchdogMs`（默认 5000ms）看门狗，超时 `process.exit(0)`。
9. **进程退出**：重启请求者不会被主动 cancel——它们正挂在自己的重启工具调用里，进程退出（以及新进程的 resume repair）就是该调用的结束方式。
10. **新 boot 对账**（强制模式）：读上次的 reaper spec / marker / lock，写 `state.lastForceOutcome`；结果不是 `relaunched` / `done` / `in-progress` 时置 `state.hold`（fail-closed 诊断标记，不拦截等待/点名重启，见 [4.5.3](#453-boot-对账与-hold)）。
11. **新 boot 恢复 holds**：`resumableToolCalls` 先恢复 `resumable-holds.json`，立即写 provisional 结果，抢在 Session resume 写入平台合成 closer（synthetic closer）之前。
12. **投递通知**：在 `appReady`（或 `bootDeliveryDelayMs` 默认 1800ms 后）按模式投递 `<dsh_restart_interrupted>` / `<dsh_restart_completed>`；投递时恢复会话的 Agent 预设与模型路由，失败会在通知中告警。
13. **落账**：把结果写回 `state.lastRestart`（`results`、`interruptedResults`、`safeState`、`timedOutSessions`、`resume` 计数），刷新 `status.json`，删除 `restart-intent.json`；客户端在 `bootId` 变化后轮询 `/api/dsh-restart/status` 判定重启完成并刷新页面。

同一条链路在失败时的分支：任何一步抛错都会删除 intent/checkpoint、记录 `state.lastError`、清空 `pending`，把错误写回挂起的重启工具调用；没有挂起调用时给发起者发失败通知。

关闭（`requestShutdown()`）走的是另一条链路：清空 pending 并把挂起的重启调用以 `<dsh_restart_failed>` 结束 → 初始化 `shutdownState` → 等 250ms → 三档等待/取消 → `flushAll()` → 可选关闭逃生舱 → `exitForShutdown()`。逐步细节见 [3.2](#32-关闭状态机)。

### 1.10 包属性与安装

| 项 | 事实 |
|---|---|
| 包名 / 版本 | `@local/dsh-power` **1.8.2** |
| 分发方式 | `private` 包，不发布到 npm；通过 `.tgz` 或本地目录安装 |
| 运行时依赖 | 无 npm 运行时依赖；`client.js` 的 React 由 DSH 网页版客户端运行时注入 |
| 平台 | Web + Desktop（Windows）；桌面版额外用 `relauncher-desktop.mjs` 与 `quit-desktop.mjs` 处理 Electron 外壳 |
| 安装（插件管理器） | `plugin_manager install_bundle target=<本包目录或 .tgz 的绝对路径>` |
| 安装（CLI，推荐） | `dsh plugin --profile web add "file:<绝对路径>/local-dsh-power-1.8.2.tgz"`；桌面版把 `--profile web` 换成对应的 profile 名 |
| 生效条件 | 安装后**重启 DSH**：Host 半身改动必须重启才生效；Client 半身会热更新 |
| 配置热重载风险 | 不要在 AI 回合运行期间手工编辑 `cordis.patch.yml`：当前 DSH 的 profile patch 热重载会 dispose 正在运行的 Agent/Session（见 [7.4](#74-已知边界)） |

安装与最小上手的完整叙述见 [README](./README.md)；版本演进与转正说明见 [HISTVER](./HISTVER.md)（正式公开基线；正式公开之前的私有时期见 [HISTVER_legacy.md](./HISTVER_legacy.md)，仅作追溯参考）。

## 2. 工具与 API 参考

对外接口分三层：五个 AI 工具与一个 skill（供模型调用）、六条挂在 `connection.fetch` 上的生产路由（供人类界面调用）、以及仅在 `testMode` 下挂载的自测路由（供自动化测试）。全部工具与路由都不暴露「关闭 DSH」的 AI 入口。

### 2.1 五个 AI 工具

| 人类界面 | AI 工具 | AI 名称 | 行为 |
|---|---|---|---|
| **等待** | `restart_dsh_blocking_wait_safe` | 阻塞等待 | 等所有其他运行中 AI 完成当前回合后重启；不中断任何 AI；**最推荐** |
| **中断** | `restart_dsh_roll_call_caution` | 点名 | 广播要求未就绪 AI 停止并加入就绪状态；所有活跃 AI 就绪后重启，最多等 `rollCallWaitMs`（默认 120 秒，`0` = 永久等待） |
| **强制** | `restart_dsh_force_dangerous` | 强制 | **先审批，通过后再校验并消费保险**；立即中断所有未就绪的运行中 AI 并重启，不等待完成；没有保险不会重启 |
| —（人类长按即保险） | `restart_dsh_force_safeguard` | 强制保险 | 只对紧接着的下一次工具调用有效（`run_code` / `todo_execute` 传输层外层不重锁，嵌套调用仍逐个校验） |
| — | `restart_dsh_status` | 只读状态 | 查看阶段、运行中 AI、待执行重启/关闭与上次结果；无副作用、无需审批 |

人类界面只使用「等待 / 中断 / 强制」三词；AI 工具与通知使用「阻塞等待 / 点名 / 强制 / 强制保险」。

工具级权限（完整 3×4 矩阵见 [4.1](#41-权限与审批)）：

| 工具 | 权限与审批 |
|---|---|
| `restart_dsh_blocking_wait_safe` | `workspace-write` 及以上免审批；`read-only` 或其他一次审批* |
| `restart_dsh_roll_call_caution` | `workspace-write` 及以上免审批；`read-only` 或其他一次审批* |
| `restart_dsh_force_safeguard` | 只在完全访问（`danger-full-access` + `approval: never`）免审批，否则一次审批 |
| `restart_dsh_force_dangerous` | 只在完全访问免审批，否则一次审批；审批通过后才校验并消费保险，无保险不重启 |
| `restart_dsh_status` | 无副作用、无需审批 |

\* 带星号的一格适用「临时免审批窗口」，完整定义与门禁条件见 [4.1](#41-权限与审批)。

### 2.2 restart-dsh skill 与调用超时

- `restart-dsh` skill 在插件加载时注册（注册点在 `host/ai.js`，工具名、模式名、就绪状态定义与 skill 文本在 `host/constants.js`）。
- 当用户要求重启 DSH、某项改动提示需要重启，或用户同意以重启解决问题时，AI 应加载该 skill 并按其中规则选择模式。
- 五个 AI 工具**不声明 `timeoutMs`**，所以 `@deepseek-ai/dsh-tool-call-timeout-policy` 不会给挂起的重启调用设置截止时间。挂起调用只在重启失败或回合取消时提前返回错误。
- `restart_dsh_status` 随时可查只读状态：当前阶段、运行中 AI（最多 50 条）、待执行重启、关闭等待上限/截止时间、最近一次重启摘要与 checkpoint/resume 计数；不触发任何操作、不需要审批。

### 2.3 HTTP API 路由

路由注册在 DSH 的 `connection.fetch` 通道上，沿用该通道的连接鉴权；客户端以同源 `credentials: 'same-origin'` 访问。

| 方法 | 路径 | 请求体 | 响应 | 说明 |
|---|---|---|---|---|
| `GET` | `/api/dsh-restart/status` | — | `statusValue()` | 只读状态：`phase`、`shuttingDown`、`pending`、`runningAgents`、`shutdown`、`agents`（原始列表；AI 工具侧截断见本节表注）、`lastRestart`、`hold`、`lastError`、`rollCallWaitMs`、`testMode` |
| `POST` | `/api/dsh-restart/request` | `{ mode?, confirmed?, reason? }` | `{ ok, accepted, phase, requestId?, mode?, message, status }` | 人类界面发起的重启；服务端固定 `source: 'ui'`。`mode` ∈ `safe\|coordinated\|dangerous`（其他值按 `safe`）。强制模式必须 `confirmed: true`，否则 400 |
| `POST` | `/api/dsh-restart/shutdown` | `{ mode?, confirmed?, reason?, closeEscapePod? }` | `{ ok, shuttingDown: true, mode, closeEscapePod }` | 仅人类界面；强制关闭必须 `confirmed: true`，否则 400。Handler 立即返回，250ms 后执行关闭流程（状态机内部时序见 [3.2](#32-关闭状态机)）；已在关闭中则返回 `alreadyShuttingDown: true` |
| `GET` | `/api/dsh-restart/pod` | — | `{ ok: true, available: boolean }` | `available=true` 当且仅当 `ctx.get('escapePod')` 存在且 `shutdown` 是函数 |
| `GET` | `/api/dsh-restart/config` | — | `{ ok, rollCallWaitMs, writable, persisted }` | 设置页读取；`persisted` 表示运行设置文件里是否有值 |
| `POST` | `/api/dsh-restart/config` | `{ rollCallWaitMs: number }` | `{ ok, rollCallWaitMs, writable, persisted: true }` | **只接受这一个字段**；值必须是 `0` 或 `1000..3600000` 的整数，否则 400；写运行设置失败 500 |

注（`agents` 字段）：HTTP 路由返回原始列表；AI 工具侧由 `projectStatusSummary()` 截到 50 条，并给出 `agentsTotal` / `agentsTruncated`。

### 2.4 testMode 自测路由

`testMode: true` 且 `webServer`、`connection` 都存在时，额外注册 `/dsh-restart-test/*`（`status`、`state`、`diagnostics`、`create-session`、`start-turn`、`trigger`、`tool-call`、`cancel-turn`、`relaunch-check`、`shutdown`）。每个 handler 先调用 `scope.connection.requestRejection({ headers })`，返回 401/403 时直接拒绝；校验本身抛错也按 403 fail-closed。

这组路由让脚本能驱动会话、回合与工具调用，从而验证点名、强制中断与 relaunch 行为；生产环境不应打开 `testMode`。

### 2.5 closeEscapePod 流程

1. 人类在关闭对话框勾选「同时关闭正在运行的逃生舱」；复选框只在 `GET /api/dsh-restart/pod` 返回 `available:true` 时渲染，默认不勾选，三档模式都显示。
2. 客户端提交 `POST /api/dsh-restart/shutdown`，body 带 `closeEscapePod: true`（仅显式 `true` 生效）。
3. Host 在真正退出前调用 `await escapePod.shutdown('dsh-power shutdown')`：
   - 服务不存在 → 记 `escape pod not closed: escapePod service is not available` 并跳过；
   - 与 `sleep(5000)` 竞速，超时记 `escape pod shutdown timed out after 5000ms; continuing to exit`；
   - 抛错只记 `escape pod shutdown failed: ...`。
4. 无论结果如何都继续退出；逃生舱异常绝不阻止 DSH 关机。
5. 重启流程不调用该服务：重启不关闭逃生舱。

三条日志原文（逐字）：

```text
escape pod not closed: escapePod service is not available
escape pod shutdown timed out after 5000ms; continuing to exit
escape pod shutdown failed: ...
```

### 2.6 工具调用链与挂起结束

五个工具的语义、副作用与挂起方式的差别集中在一张表里（审批细则见 [4.1](#41-权限与审批)，保险状态见 [4.2](#42-强制保险)）：

| 工具 | 人类对应 | 审批 | 副作用 | 挂起与结束 |
|---|---|---|---|---|
| `restart_dsh_blocking_wait_safe` | 等待 | `workspace-write` 及以上免审批，否则一次审批 | 建立/合并 `pending`，把发起者加入 `safeStateSessions` | 调用挂起到重启完成；只在重启失败或回合取消时提前返回错误 |
| `restart_dsh_roll_call_caution` | 中断（点名） | 同上 | 建立/升级为 `coordinated`，触发广播；非第一发起者退化为阻塞等待 | 同上；点名超时的 AI 由通知如实记录，不会声称其「已完成」 |
| `restart_dsh_force_dangerous` | 强制 | 只在完全访问免审批，否则一次审批 | 审批通过后校验并消费保险，随后 `requestRestart()` 走 `dangerous` | 同上；被强制中断的 AI 由平台 repair 补 `interrupted` 与 `TOOL_OUTCOME_UNKNOWN`（被 holds 接管的除外） |
| `restart_dsh_force_safeguard` | —（人类长按即保险） | 只在完全访问免审批，否则一次审批 | 给「紧接着的下一次工具调用」上保险，可被消费一次 | 调用后保险进入待消费状态；有效期 `unlockTtlMs`（默认 300000ms） |
| `restart_dsh_status` | — | 无需审批 | 无副作用（只读） | 只读快照：运行中 AI 列表截到 50 条，并给出 `agentsTotal` / `agentsTruncated` |

三条链路的固定顺序：

- **等待 / 点名**：`requestRestart()` → `pending` → 等待循环（`pollMs`）→ `finalizeRestart()`。
- **强制**：`authorize()`（审批）→ 校验并消费 `restart_dsh_force_safeguard` 的保险 → `requestRestart()`；HISTVER 把有保险时的原流程记作 `authorize → requestRestart → holdToolCall`，挂起语义不变。
- **关闭**：只有认证的 UI 路由 `POST /api/dsh-restart/shutdown`，没有对应 AI 工具；关闭进行中时重启请求返回 `accepted:false`。

挂起调用的四种结束方式（源文档写明的全部出口）：

1. 重启成功：进程退出后由新进程的 resume repair 结束该调用，发起者在新进程投递阶段（`appReady` 或 `bootDeliveryDelayMs` 后）收到 `<dsh_restart_completed>`。
2. 强制模式：被中断的 AI 先收到 `<dsh_restart_interrupted mode="force_dangerous">`，发起者再收到完成通知。
3. 重启失败：错误写回挂起的工具调用；没有挂起调用时给发起者发失败通知。
4. 关闭清空 pending：所有挂起的重启工具调用以 `<dsh_restart_failed>` 结束。

> 五个工具都**不声明 `timeoutMs`**，`@deepseek-ai/dsh-tool-call-timeout-policy` 因此不会给挂起的重启调用设置截止时间；「挂起多久」由上面四种结束方式决定，而不是由超时决定。

## 3. 状态与持久化

本包有三个状态机（重启、关闭、点名/就绪）与两类跨重启载体：重启前的 `checkpoint.json` + `restart-intent.json`，以及 `resumableToolCalls` 的 `resumable-holds.json`。所有状态文件都落在 `<home>/.dsh-restart/`，Host 是被杀死的对象，所以这些文件必须能在没有 Host 的情况下被外部 CLI 读取。

### 3.1 重启状态机

#### 3.1.1 待执行记录

`requestRestart()` 维护唯一的 `pending` 记录：

| 字段 | 含义 |
|---|---|
| `requestId` | 本次重启的 UUID |
| `requesters[]` | 每个发起者：`sessionId`、`source`（`ui` / `tool`）、`mode`、`reason`、`requestedAt` |
| `mode` | 当前生效模式，初值取首个请求；按「强制 > 点名 > 阻塞等待」升级 |
| `phase` | `pending` → `restarting` |
| `coordinatedDeadlineAt` | 点名限时截止；`null` 表示永久等待（`rollCallWaitMs=0`） |
| `firstCoordinatorSessionId` | 点名第一发起者；UI 发起时固定为 `'ui'` |
| `safeStateSessions` | 已进入就绪状态的 session id 集合 |
| `broadcastSent` / `broadcastTotal` | 每个 AI 的插话次数/时间与总广播次数 |
| `uiRequested` | 是否有过人类界面请求 |

同一时刻只存在一个 `pending` 记录，所有模式差异都体现在它的字段与 `phase` 上，不存在并行的两套重启流程。

#### 3.1.2 请求合并与升级

- 同一时间只执行一个待重启请求；相同 `(sessionId, source)` 的重复请求只更新发起者记录，不重复计数。
- 模式升级：`force` 覆盖一切；`coordinated` 覆盖 `safe`（并把 `coordinatedDeadlineAt` 设为当前时间 + `rollCallWaitMs`）；已在 `coordinated` 时后来的点名只加入就绪状态。
- **非第一发起者退化**：点名模式下，若 `firstCoordinatorSessionId` 已存在且与本次请求者不同，本次调用只把该会话加入 `safeStateSessions`（退化为阻塞等待），不再触发广播。
- 发起者加入就绪状态：使用等待/点名工具 → 加入；使用强制工具 → 从集合中移除自己（强制发起者不因这次调用进入就绪状态，但实际执行强制重启的发起者按定义属于就绪状态，见通知）。
- 已有 `pending.phase === 'restarting'` 时：
  - 新的强制请求加入在途流程；若在途是强制模式则重新武装 reaper，否则不额外拉起（避免双启动）。
  - 新的等待/点名请求不排队，直接返回「已在重启流程中」。
- 关闭进行中（`shutdownInProgress`）时，重启请求返回 `accepted:false`。

把上面的规则按「本次请求 vs 已存在的 pending」整理成速查表（每行都能在上一组条目里找到出处）：

| 情形 | 结果 |
|---|---|
| 相同 `(sessionId, source)` 重复请求 | 只更新发起者记录，不重复计数；仍是同一个 `pending` |
| 新请求为 `force`，已存在 `safe` / `coordinated` | `force` 覆盖一切，模式升为强制 |
| 新请求为 `coordinated`，已存在 `safe` | 覆盖为点名，并把 `coordinatedDeadlineAt` 设为「当前时间 + `rollCallWaitMs`」 |
| 已在 `coordinated` 时又收到点名 | 后来的点名只加入就绪状态，不重复触发广播 |
| 点名请求者不是第一发起者 | 只把该会话加入 `safeStateSessions`（退化为阻塞等待） |
| 已有 `pending.phase === 'restarting'` 时收到强制请求 | 加入在途流程；在途是强制则重新武装 reaper，否则不额外拉起（避免双启动） |
| 已有 `pending.phase === 'restarting'` 时收到等待/点名 | 不排队，直接返回「已在重启流程中」 |
| `shutdownInProgress` 为真 | 重启请求返回 `accepted:false` |

模式升级只看「强制 > 点名 > 阻塞等待」；同一时刻只存在一个 `pending`，所以任何一次升级都发生在同一条记录上，不存在两条并行流程。

#### 3.1.3 等待与收尾

`maybeFinalize()` 由 `setInterval(..., pollMs)` 驱动：

1. **safe**：`blockingRunningAgents(pending)`（除发起者外的运行中 AI）为空才继续。
2. **coordinated**：每轮先 `broadcastSafeStateRequest()` 广播；若 `rollCallExpired()`（`coordinatedDeadlineAt` 已到）则立即收尾，把仍未就绪的 AI 记为超时；否则等 `activeNotSafeAgents(pending)` 为空。
3. **dangerous**：不等待，请求路径直接安排收尾。
4. 条件满足后还需经过 `graceMs` 静默期（`lastIdleAt`），避免刚好在回合边界抖动。

`finalizeRestart()` 的顺序：

1. `resolveLaunch()`：取 `config.launch` 或当前进程的 `execPath` / `args` / `cwd`；网页版默认补 `--no-open`（`openBrowserOnRelaunch=true` 时不补）。
2. `captureCheckpoint()` → 写 `checkpoint.json`；失败只记日志，不阻断重启。
3. 计算 `interrupted`（强制模式下未就绪的运行中 AI）与 `timedOutSessions`（点名限时到点仍未就绪的 AI）。
4. 写 `restart-intent.json`（含 mode、requesters、safeStateSessions、broadcast、deadline、timedOut、interrupted、checkpoint 摘要、在途重启工具调用）。
5. 立即写 `status.json` 快照（进程随时可能被杀，先留下「restarting」）。
6. 分路径退出：
   - **force**：`spawnForceReaper()` → 有界 flush（`min(dangerousFlushTimeoutMs, 800ms)`）→ `hardKillSelf()`。
   - **desktop**：flush → `spawnDesktopRelauncher()` → `scheduleDesktopRelaunchGuard()`（`desktopRelaunchTimeoutMs` 内应用没重启就回滚 pending、失败 held 调用/发失败通知）。
   - **web**：写 `relaunch-spec.json` → `spawnRelauncher()`（等与本次 `requestId` 匹配的 readiness marker，最多 3 秒）→ flush → `appExit(0)`，同时挂 `exitWatchdogMs` 看门狗，超时 `process.exit(0)`。
7. 任何一步抛错：删除 intent/checkpoint、记录 `state.lastError`、清空 pending，把错误写回挂起的重启工具调用；没有挂起调用时给发起者发失败通知。

重启请求者不会被主动 cancel：他们正挂在自己的重启工具调用里，进程退出（以及新进程的 resume repair）就是该调用的结束方式。

#### 3.1.4 重启后投递

新进程启动时读取 `restart-intent.json`，在 `appReady`（或 `bootDeliveryDelayMs` 后）按模式投递：

- **force**：先给每个 `interrupted` AI 发 `<dsh_restart_interrupted mode="force_dangerous">`，再给所有发起者发 `<dsh_restart_completed mode="force_dangerous">`。
- **coordinated**：发起者收到完成通知，包含广播次数、就绪状态成员、超时 AI；`coordinatedNotifyTimedOut=true` 时还给超时且非发起者的 AI 发 `<dsh_restart_interrupted mode="coordinated_timeout">`。
- **safe**：发起者收到完成通知。
- 投递时恢复会话的 Agent 预设与模型路由；失败会在通知中告警。
- 最后把结果写回 `state.lastRestart`（`results`、`interruptedResults`、`safeState`、`timedOutSessions`、`resume` 计数），刷新 `status.json`，删除 intent。

投递失败不会静默：失败会被写进通知文本与 `state.lastError`，供 `restart_dsh_status` 与 `status.json` 查询。

### 3.2 关闭状态机

`requestShutdown(mode, reason, closeEscapePod)` 由认证的 UI 路由触发（没有对应 AI 工具）。三档关闭与重启同名但只关闭、不再启动：

| 人类界面 | 行为 |
|---|---|
| **等待** | 等运行中 AI 完成当前回合后关闭（最长 `shutdownMaxWaitMs`，默认 5 分钟；`0` = 无限） |
| **中断** | 广播要求运行中 AI 停止，所有活跃 AI 停止后关闭 |
| **强制** | 立即中断运行中 AI 并关闭（可能丢失进度） |

1. 若存在 pending 重启：清空 pending，把所有挂起的重启工具调用以 `<dsh_restart_failed>` 结束，删除 intent。否则那些调用会永远挂起，等待循环也永远结束不了。
2. 初始化 `shutdownState`：`mode`、`requestedAt`、`reason`、`waitTimeoutMs = shutdownMaxWaitMs`、`deadlineAt`（`0` 时为 `null`）、`phase='waiting'`、`broadcastSent`。
3. 等 250ms 让 HTTP 响应先刷出（HTTP handler 的返回时序见 [2.3](#23-http-api-路由) 路由表 shutdown 行）。
4. **force**：立即 `cancelRunningAgents('force shutdown')` → `phase='flushing'` → 写 `status.json` → `spawnForceReaper(..., 'shutdown')` → 有界 flush → 可选关闭逃生舱 → `hardKillSelf()`。
5. **safe / coordinated**：coordinated 每轮广播停止请求；循环等待 `runningAgents().length === 0`。到 `deadlineAt` 仍未结束时置 `timedOut=true`、`phase='cancelling'`，取消剩余 AI，再等 `shutdownGraceMs`；仍未结束只记日志并继续退出。
6. `phase='flushing'` → `flushAll()`。
7. 可选 `closeEscapePodForShutdown('dsh-power shutdown')`。
8. `exitForShutdown()`：桌面版先 detach `quit-desktop.mjs` 结束外壳并短暂等待，再退出 Host；网页版直接退出。

关闭完成后页面显示「本页面与后端服务连接已断开，DSH已退出」；若勾选过逃生舱，其下再显示「运行的逃生舱已关闭」。

关闭状态的阶段取值（来自上面逐步描述里的 `phase` 赋值）：

| `shutdownState.phase` | 何时进入 | 离开条件 |
|---|---|---|
| `waiting` | 初始化 `shutdownState` 时（第 2 步） | 运行中 AI 归零、到达 `deadlineAt`，或 force 模式不进入等待循环 |
| `cancelling` | 到达 `deadlineAt` 仍未结束：置 `timedOut=true` | 取消剩余 AI，再等 `shutdownGraceMs`；仍未结束只记日志并继续退出 |
| `flushing` | force 路径在取消后立即进入；safe / coordinated 在等待结束后进入 | `flushAll()` 完成 |
| 退出 | `flushAll()` 与可选的逃生舱关闭之后 | `exitForShutdown()` 退出 Host（桌面版先 detach `quit-desktop.mjs` 结束外壳并短暂等待） |

`force` 关闭在初始化后立即取消运行中 AI 并进入 `flushing`，不进入等待循环：`cancelRunningAgents('force shutdown')` → `phase='flushing'` → 写 `status.json` → `spawnForceReaper(..., 'shutdown')` → 有界 flush → 可选关闭逃生舱 → `hardKillSelf()`。

关闭与重启的差异对照：

| 维度 | 重启 | 关闭 |
|---|---|---|
| 入口 | 人类 UI 路由 + 五个 AI 工具 | 只有认证的 UI 路由 `POST /api/dsh-restart/shutdown`，没有对应 AI 工具 |
| 三档语义 | 等待 / 点名收尾后**拉起新进程** | 同名三档，但只关闭、不再启动 |
| 等待上限 | 点名受 `rollCallWaitMs` 限制；safe 没有硬上限 | 等待 / 中断受 `shutdownMaxWaitMs`（默认 300000ms，`0` = 无限）限制，到点置 `timedOut` 并取消剩余 AI |
| 逃生舱 | 不调用 `escapePod.shutdown()`，逃生舱命令随重启继续运行 | 可选 `closeEscapePod:true`，与 `sleep(5000)` 竞速，异常只写日志 |
| 完成反馈 | `bootId` 变化后轮询判定并刷新页面 | 页面显示「本页面与后端服务连接已断开，DSH已退出」，勾选过逃生舱时再显示「运行的逃生舱已关闭」 |
| 桌面版收尾 | `relauncher-desktop.mjs` 结束外壳后重开应用 | `quit-desktop.mjs` 结束外壳，避免「DSH 后端错误」弹窗 |

关闭前若存在 pending 重启，会先把挂起的重启工具调用以 `<dsh_restart_failed>` 结束并删除 intent——否则那些调用会永远挂起，等待循环也永远结束不了。

### 3.3 点名与就绪状态

#### 3.3.1 定义

> 使用过【阻塞等待】或【点名】工具，以及强制重启的发起者，属于就绪状态；被强制中断的 AI 不属于就绪状态。

代码中的具体规则：

- `requestRestart()` 对 `safe` / `coordinated` 请求者执行 `safeStateSessions.add(sessionId)`。
- `dangerous` 请求者从集合中删除自己。
- 实际执行强制重启的发起者在通知/`summarizeSafeState()` 中按就绪状态统计（与 `intent.requesters` 的 `mode` 无关，所有类型的发起者都会列入 safe members）。
- 被强制中断且未预先进入就绪状态的 AI 记录在 `intent.interrupted`；点名超时的 AI 记录在 `intent.timedOutSessions`，二者都不属于就绪状态。

#### 3.3.2 广播

- 广播使用 `agent.steer(...)`，消息包裹在 `<dsh_restart_coordination mode="coordinated">` 中，要求目标 AI 停止派生子代理/工具、不要开始新任务，并调用 `restart_dsh_blocking_wait_safe` 加入就绪状态（也可调用点名工具，但非第一发起者会退化）。
- 只发给正在运行、且既不在此次 `requesters`、也不在 `safeStateSessions` 里的 AI；当某个 AI 停止运行后，它在 `broadcastSent` 里的计数会被清空，以便下一回合重新广播。
- **只在目标 AI 的下一个 step 边界被消费**；卡在长工具调用中的 AI 要等该调用结束，因此可能等待较久（预期行为）。
- 对同一 AI 的重复插话受 `coordinatedResendMs`（默认 20 秒）与 `coordinatedMaxResends`（默认 5 次）限制。
- 人类选择「中断」时，人类是点名第一发起者（`firstCoordinatorSessionId='ui'`），后续 AI 点名退化为阻塞等待。

广播门禁与节流（逐条对应上面的条目）：

| 维度 | 规则 | 相关参数 |
|---|---|---|
| 发送对象 | 正在运行、且既不在此次 `requesters`、也不在 `safeStateSessions` 里的 AI（含子代理 / 工作流子代理） | — |
| 发送方式 | `agent.steer(...)`，消息包裹在 `<dsh_restart_coordination mode="coordinated">` 中 | — |
| 送达时机 | 只在目标 AI 的下一个 step 边界被消费；卡在长工具调用里的 AI 要等该调用结束 | — |
| 重发间隔 | 对同一 AI 的重复插话最小间隔 | `coordinatedResendMs`（默认 20000ms） |
| 重发上限 | 对同一 AI 的重复插话最大次数 | `coordinatedMaxResends`（默认 5 次） |
| 计数复位 | 某个 AI 停止运行后，它在 `broadcastSent` 里的计数被清空，下一回合可重新广播 | — |
| 第一发起者 | 人类选择「中断」时人类即第一发起者（`firstCoordinatorSessionId='ui'`），之后 AI 的点名退化为阻塞等待 | — |
| 限时 | 到 `coordinatedDeadlineAt` 后不再等，继续重启并把仍未就绪的 AI 记为超时 | `rollCallWaitMs`（默认 120000ms，`0` = 永久等待） |

#### 3.3.3 限时

- `rollCallWaitMs`（默认 120000，`0` = 永久等待）在 pending 记录上转成 `coordinatedDeadlineAt`。
- 到点后不再等，继续重启；仍在运行且不在就绪状态的 AI 计入 `timedOutSessions`。
- 这些信息会出现在：`restart-intent.json`、`lastRestart.timedOutSessions`、`/api/dsh-restart/status` 的 `pending.coordinatedDeadlineAt` / `pending.waitingRemainingMs` 与 `lastRestart.timedOutCount` / `timedOutSessionIds`、完成通知、等待页「剩余 N 秒后不再等待」。
- 等待页/完成通知从不声称这些 AI「已完成」。

### 3.4 检查点与恢复报告

#### 3.4.1 检查点

- 文件：`<home>/.dsh-restart/checkpoint.json`，schema `version: 1`。
- 采集：live session、`agentStatus`、`agentPreset`、`lastSeq`、当前回合内**未闭合**的 `tool/call`、后台 job 视图。
- 排除：
  - `restart_dsh_*` 自身调用（它们由重启流程自己结束）；
  - 已被 `resumableToolCalls` 接管的调用（按会话写成 `heldToolCalls`，不是未知调用）。
- 脱敏：每个未决调用只保存 `callId`、`name`、`argsHash`（sha256）、`argsPreview`（400 字符上限、敏感键名打码）、`seq`；不保存完整参数。
- 上限（`CHECKPOINT_LIMITS`）：

| 限制 | 值 |
|---|---|
| sessions | 200 |
| 每 session 未决调用 | 20 |
| 未决调用总数 | 200 |
| 每 session 后台 job | 10 |
| preview | 400 字符 |

超出会置 `totals.truncated=true`。检查点写失败不阻断重启。

检查点的采集项与脱敏字段分开看：

| 采集项 | 内容 |
|---|---|
| live session | 当前存活的会话 |
| `agentStatus` | Agent 状态 |
| `agentPreset` | 会话的 Agent 预设 |
| `lastSeq` | 会话日志的最后序号 |
| 未闭合 `tool/call` | 当前回合内尚未闭合的工具调用 |
| 后台 job 视图 | 会话可见的后台任务 |

| 脱敏字段（每个未决调用） | 含义 | 规则 |
|---|---|---|
| `callId` | 工具调用标识 | 原样 |
| `name` | 工具名 | 原样 |
| `argsHash` | 参数哈希 | sha256 |
| `argsPreview` | 参数预览 | 400 字符上限；敏感键名打码 |
| `seq` | 调用序号 | 原样 |

`schema` 为 `version: 1`；上表的 5 个字段是每个未决调用保存的全部内容，**不保存完整参数**。检查点里另有两个 totals 类标记：任一上限被超出时置 `totals.truncated=true`；按会话被 `resumableToolCalls` 接管的调用另计入 `totals.heldToolCalls`（HISTVER 1.7.5-hotfix.2 的记录），并在恢复报告里写成「可恢复调用」。

#### 3.4.2 恢复报告

- `buildResumeReport(checkpoint, liveSessionIds)` 逐会话给出 `restored`、`openToolCalls`、`heldToolCalls`、`jobs`、`needsReport`。
- `needsReport` 条件：有未决调用、有后台 job、有 `resumableToolCalls` 接管的调用，或会话未恢复。
- 投递：
  - 重启请求者/被中断 AI：追加到对应的完成/中断通知文本；
  - 其他需要报告的会话：live 时 `agent.inject`，否则停放在 `pendingResumeReports`，等 `agent/created` 时投递一次，并把 `resume.pending` 减一、`delivered` 加一；
  - 报告内容明确「未决工具调用结果未知、可能已中断」「后台任务无法接回」；`heldToolCalls` 写成「可恢复调用：N 个已由 resumableToolCalls 接管……结果会在结算后自动写回，请不要重跑」；
  - 只有 calls / jobs / held 全为 0 时，才说「本会话没有未决工具调用或后台任务」；会话是否恢复另行报告。
- `lastRestart.checkpoint` 与 `lastRestart.resume` 只暴露计数与状态，不返回完整参数/输出/路径。

恢复报告的触发条件与文本约定：

| 项 | 规则 |
|---|---|
| `needsReport` | 满足任一条件：有未决调用、有后台 job、有 `resumableToolCalls` 接管的调用、或会话未恢复 |
| 对象：请求者 / 被中断 AI | 追加到对应的完成 / 中断通知文本 |
| 对象：其他会话 | live 时 `agent.inject`；否则停放在 `pendingResumeReports`，等 `agent/created` 时投递一次，并把 `resume.pending` 减一、`delivered` 加一 |
| 未决调用文本 | 「未决工具调用结果未知、可能已中断」 |
| 后台任务文本 | 「后台任务无法接回」（需重新执行或检查输出） |
| 可恢复调用文本 | 「可恢复调用：N 个已由 resumableToolCalls 接管……结果会在结算后自动写回，请不要重跑」 |
| 「没有未决」文本 | 只有 calls / jobs / held 全为 0 时才会出现「本会话没有未决工具调用或后台任务」；会话是否恢复另行报告 |

#### 3.4.3 不是冻结

本包只做检查点与报告：不恢复进程、不接回工具或后台任务、没有 freeze/thaw。逃生舱的冻结/再生属于独立包 `@local/dsh-escape-pod` 的能力（见其 README），本包不 import 它、也不替它执行任何操作。

### 3.5 resumableToolCalls

Host 服务名 `resumableToolCalls`（`ctx.get('resumableToolCalls')`），由 `index.js` 注册、`host/resumable.js` 实现：

| 方法 | 行为 |
|---|---|
| `hold(callId, { tool, hint, deadlineMs })` | 同步落盘到 `resumable-holds.json` 后才返回 release 回调；`tool` 必填；`deadlineMs` 夹取到 1..24h（24h = 86400000ms，无效值按上限）；注册表最多 64 条；`callId` ≤ 200 字符、`tool` ≤ 120、hint ≤ 4096 字节 |
| `complete(callId, result)` | 写真实结果；内容替换（surface replacement）只做一次；若会话写句柄被 resume 占用则等待/重试，最终失败按 deadline 结算 |
| `fail(callId, reason)` | 用平台原文与错误码结算：`ToolOutcomeUnknownError` / `TOOL_OUTCOME_UNKNOWN`；reason ≤ 400 字符 |
| `status()` | 只读快照：`{ service, bootId, holds[], held, deferred, settled }`；每条 hold 含 `callId`、`sessionId`、`tool`、`status`、`deadlineAt`、`pendingWritten`、`deferredReason`、`closerRewritten`，不返回参数/结果内容 |

机制：

1. `hold` 在重启检查点写入**之前**持久化 hold，因此新 boot 知道该调用应由原 owner 回答。
2. 新进程 boot 先恢复 holds，并立即写一条 provisional 结果，抢在 Session resume 写入平台合成 closer 之前；随后 resume 不会再把该调用标成未知。
3. `complete` / `fail` 在会话日志里只生效一次；平台 closer 已抢先时做 content-replace；已经写入不同真实结果时跳过而不是覆盖。
4. **回合已关闭时**不向 `turn/end` 之后追加 `tool/result`：`host/session-writer.js` 的 `turnIsClosed()` 判定后，改为 `agent.steer(UserMessage)`（agent 正在运行，下一步边界被 claim）或 `agent.followup(UserMessage)`（idle），消息带 `<dsh_resumable_tool_result call=… kind=…>` 信封；结算记为 `deliveredAsMessage`（不设 `resultSeq`）。
5. 持久化文件：`$DSH_HOME/.dsh-restart/resumable-holds.json`，schema `{ version: 1, bootId, holds: [...] }`；版本不符时丢弃并记日志。
6. 检查点排除这些 `callId`，并把按会话分组的 `heldToolCalls` 写进报告（`host/resumable.js` 的 `heldBySession()`）。
7. 本包未安装/被停用时服务不存在，其他插件的持有调用退化为平台默认的 `TOOL_OUTCOME_UNKNOWN` 行为。

结算竞态一览（`host/session-writer.js` 的判定顺序，把上面的「机制」逐条展开）：

| 场景 | 行为 |
|---|---|
| live 会话、写句柄空闲 | 走会话自己的写句柄，追加真实结果 |
| 会话写句柄被 resume 占用 | 等待 / 重试，最终失败按 deadline 结算 |
| 只有持久化记录（persisted-only）或 agent 不在 | 转为 deferred 重试（HISTVER 1.7.5-hotfix.3 的记录） |
| 平台已写合成 closer | 做 content-replace 把 closer 换成真实结果；替换只做一次 |
| 已写入不同的真实结果 | 跳过，不覆盖 |
| 回合已关闭（`turnIsClosed()`） | 不向 `turn/end` 之后追加 `tool/result`：agent 正在运行时 `agent.steer(UserMessage)`，idle 时 `agent.followup(UserMessage)`；消息带 `<dsh_resumable_tool_result call=… kind=…>` 信封，结算记为 `deliveredAsMessage`（不设 `resultSeq`） |
| 注册表满 / deadline 非法 | `deadlineMs` 夹取到 1..24h（无效值按上限）；注册表最多 64 条 |
| 持久化文件版本不符 | 丢弃并记日志 |

### 3.6 状态文件

状态目录：`<home>/.dsh-restart/`（默认 `$DSH_HOME/.dsh-restart/`）。

| 文件 | 写入方 | 内容 / 用途 |
|---|---|---|
| `restart.log` | Host | 追加式日志，带时间戳与 PID；超过 1 MiB 轮转为 `restart.log.1`（只保留一个备份） |
| `state.json` | Host | 持久状态：`version`、`bootId`、`bootStartedAt`、`pid`、`home`、`profile`、`lastRestart`、`lastError`、`lastForceOutcome`、`hold` |
| `status.json` | Host | 单文件、人可读快照：`version`、`at`、`bootId`、`pid`、`platform`、`phase`、`pending{requestId,mode,phase,requesters,safeStateCount,forceReaperArmed}`、`forceDryRun`、`hold`、`lastForceOutcome`、`lastError`、`lastRestart{requestId,mode,tookMs,completedAt,timedOutCount,timedOutSessionIds}`、`paths{...}`；外部 CLI 在 Host 死后读它 |
| `settings.json` | Host（设置页保存） | 运行设置 `{ rollCallWaitMs }`，不写回 patch |
| `checkpoint.json` | Host（重启前） | 有界、脱敏的检查点（见 [3.4](#34-检查点与恢复报告)） |
| `restart-intent.json` | Host（重启前） | 本次重启的持久意图；新 boot 投递完成后删除；未完成的重启由它恢复通知 |
| `resumable-holds.json` | `resumableToolCalls` | `{ version: 1, bootId, holds: [...] }`；hold/结算状态，boot 时恢复 |
| `relaunch-spec.json` | Host（网页版重启） | 传给 `relauncher.mjs` 的启动参数；helper 就绪后删除 |
| `relaunch-ready.json` | relauncher / force reaper | 原子写 marker：`started`（helper 存活）、`relaunched`（新进程已拉起）、`done`（强制关闭完成）、`error`（失败详情） |
| `relaunch.log` | relauncher | 网页版拉起过程日志 |
| `relaunch-desktop.log` | desktop relauncher | 桌面版拉起过程日志 |
| `quit-desktop.log` | quit helper | 桌面版关闭外壳日志 |
| `force-reaper-spec.json` | Host（强制模式） | 回收器 spec：`version`、`requestId`、`mode`、`platform`、`hostPid`、`mainPid?`、`killAfterMs`、`killGraceMs`、`relaunchDelayMs`、`relaunch?`、`appExecutable?`、`appDir?`、`validation{ok,detail}`、`markerPath`、`logPath`、`lockPath` |
| `force-relaunch.lock` | force reaper | 防重复拉起锁 |
| `force-dry-run.json` | Host（`forceDryRun`） | 强制演练记录：时间、mode、reason、platform、launch、`wouldArmReaper`、plan |

按生命周期归类（只列源文档明确写出的时序）：

| 文件 | 生命周期 |
|---|---|
| `state.json` | 持久：`bootId`、`pid`、`home`、`profile`、`lastRestart`、`lastError`、`lastForceOutcome`、`hold` 跨 boot 保留 |
| `status.json` | 快照：每次刷新覆盖重写；Host 随时可能被杀，所以 `finalizeRestart()` 里先写一次 `restarting` |
| `restart-intent.json` | 一次性：重启前写；新 boot 投递完成后删除；收尾抛错时也删除 |
| `checkpoint.json` | 一次性：重启前写；`finalizeRestart()` 抛错时删除；写失败只记日志、不阻断重启 |
| `resumable-holds.json` | 跨 boot：`hold` 时同步落盘，boot 时恢复；schema 版本不符时丢弃并记日志 |
| `settings.json` | 持久：设置页保存写它，不回写 patch |
| `relaunch-spec.json` | 一次性：网页版重启前写，helper 就绪后删除 |
| `relaunch-ready.json` | 握手 marker：`started` / `relaunched` / `done` / `error`；普通等待/点名的 marker 只被清理，不覆盖持久化的强制对账结果 |
| `force-reaper-spec.json` | 每次强制尝试写一次；boot 对账时读取 |
| `force-relaunch.lock` | 防重复拉起；`in-progress` 表示回收器仍持有锁 |
| `restart.log` | 追加式：超过 1 MiB 轮转为 `restart.log.1`（只保留一个备份） |
| `force-dry-run.json` | `forceDryRun=true` 时的演练记录；不清 `hold`、不创建 pending |

`hold` 的清除只有两条路：显式强制请求，或 `scripts/restart-cli.mjs unhold`。它**不拦截**等待/点名重启，也不阻止 CLI 的 `relaunch`。

### 3.7 运行设置的 mtime 优先级

`rollCallWaitMs` 有两个来源：profile patch 行里的静态值，和设置页写入的 `settings.json`。两者靠文件 mtime 决定谁生效，比较发生在启动期（`runtimeRollCallWaitOverride()`）：

| 情形 | 生效值 |
|---|---|
| `settings.json` 的 mtime 晚于 profile patch | 运行设置覆盖 patch 里的 `rollCallWaitMs` |
| patch 在启动后被手工编辑（mtime 更新） | patch 重新生效 |
| 从未保存过运行设置 | patch 里的静态值（本包 `cordis.patch.yml` 行写的是 `120000`） |

设计目的：避免旧运行设置掩盖新的手工配置——改过 patch 就表示以 patch 为准，直到设置页再次保存。设置页保存走的是另一条路径：只写 `settings.json` 并立即更新内存 `cfg.rollCallWaitMs`，下一次状态查询/截止时间计算就使用新值，不重写 patch、不触发 Loader 重新加载。

字段格式、允许值与接口行为见 [5.2](#52-运行设置)。

## 4. 安全模型

安全模型分三层：Cordis 权限与审批（Host 侧、按工具）、强制保险（AI 侧、只对一次调用）、界面长按（人类侧、绕过 AI 规则）。外部入口只有经 `connection.fetch` 鉴权的路由，关闭 DSH 的能力不对 AI 暴露。

### 4.1 权限与审批

| 会话权限（sandbox / approval） | 等待（阻塞等待） | 中断（点名） | 强制保险 | 强制 |
|---|---|---|---|---|
| `danger-full-access` + `never` | 免审批 | 免审批 | 免审批 | 免审批（随后校验保险；无保险不重启） |
| `workspace-write` | **免审批** | **免审批** | 一次审批 | 一次审批（随后校验保险；无保险不重启） |
| `read-only` 或其他 | 一次审批* | 一次审批* | 一次审批 | 一次审批（随后校验保险；无保险不重启） |

\* **临时免审批窗口**：只要存在待执行的点名重启，本次重启期间等待类工具（阻塞等待/点名）对所有权限免审批；重启完成、取消或升级为强制后恢复。强制保险/强制不受该窗口影响。

- 强制重启的执行顺序固定为：审批（完全访问免审批）→ 校验并消费保险 → `requestRestart()`；审批被拒时保险保留，没有保险时不会重启。
- 工具通过 `ctx.approval.request` 请求审批；没有审批通道且权限不足时拒绝执行并说明原因。
- 人类发起的强制重启/关闭不需要 AI 保险，也不受 AI 权限限制；界面长按 5 秒即人类确认。

把带星号的「临时免审批窗口」展开成四个要素（矩阵里带 `*` 的两格即此窗口）：

| 要素 | 规则 |
|---|---|
| 触发条件 | 只要存在待执行的点名重启（`pending` 处于点名模式） |
| 覆盖范围 | 等待类工具（阻塞等待 / 点名）在本次重启期间对所有权限免审批 |
| 不覆盖 | 强制保险与强制工具不受该窗口影响，仍按 3×4 矩阵走审批 |
| 恢复时机 | 重启完成、取消，或升级为强制之后 |

### 4.2 强制保险

1. 无论权限如何（包括完全访问），AI 都必须先调用 `restart_dsh_force_safeguard` 上保险。没有保险时，强制重启会先走审批，审批通过后返回「先上保险」的引导错误，不会重启。
2. 保险只对**紧接着的下一次工具调用**有效，且必须是 `restart_dsh_force_dangerous`。`run_code` 与 `todo_execute` 是传输层，外层调用不重锁；它们内部的嵌套调用仍逐个校验。
3. 在此之前使用任何其他工具、命令、技能、子代理，或回合结束、进程重启，都会重新锁定。
4. 强制重启先审批，审批通过后才校验并消费保险；审批被拒时保险保留，可稍后重试。
5. **除非有额外需求，否则不要使用强制重启。**

实现：全局 `ctx.tools.guard` 只负责重新锁定，不再消费保险；强制工具在 `authorize()` 成功后调用 `consumeSafeguard()` 校验 TTL 并删除记录，随后才 `requestRestart()`。`run_code` 与 `todo_execute` 外层豁免，但每个嵌套子调用分别受 guard 约束。

无保险且审批通过时返回的原文：

> 已通过审批，但尚未完成强制重启保险：请先调用 `restart_dsh_force_safeguard` 并批准，然后重试本次强重启。

保险有效期 `unlockTtlMs`（默认 300000ms）；审批被拒时保险保留，可稍后重试。因为 guard 只在非传输工具调用后重新锁定，`todo_execute` 重放强重启时，上保险后外层调用不会把保险提前重锁掉。

保险状态与强制工具的行为对应：

| 保险状态 | 强制工具的行为 |
|---|---|
| 未上保险 | 先走审批；审批通过后返回「先上保险」的引导错误，不重启 |
| 已上保险（未过期） | 审批通过后校验并消费一次，随后 `requestRestart()`；消费后立即失效 |
| 已过期（超过 `unlockTtlMs`） | 审批后被拒绝，不重启（见 [6.3](#63-覆盖范围) 的 `force-safeguard` 用例） |
| 审批被拒 | 保险保留，可稍后重试强制重启 |
| 上了保险但先调用了其他工具 / 回合结束 / 进程重启 | 重新锁定（保险失效），需要重新上保险 |

`run_code` 与 `todo_execute` 重放强重启时：外层调用不重锁，嵌套调用仍逐个校验；`todo_execute` 可消费上保险后已武装的保险，审批沿用待办的一次性授权，不会二次弹窗（HISTVER 1.8.1-hotfix.2 的记录）。

### 4.3 界面确认

- 强制确认按钮需长按 5 秒：按住期间闪烁加速并显示剩余秒数；松开、移出、窗口失焦、页面隐藏、`pointercancel`、Escape 均取消；只接受鼠标主键。
- 中断模式需「下一步」二次确认；等待模式可取消。
- 背景点击关闭对话框、Escape 关闭菜单/对话框/失败页。

确认动作与取消条件对照：

| 操作 | 提交条件 | 取消条件 |
|---|---|---|
| 强制（人类） | 长按满 5 秒自动提交；只接受鼠标主键 | 松开、移出、窗口失焦、页面隐藏、`pointercancel`、Escape |
| 中断（人类） | 点「下一步」后再确认一次 | 背景点击关闭对话框 / Escape |
| 等待（人类） | 确认框确认 | 确认框可取消 |

人类发起的强制重启 / 强制关闭由长按确认，不需要 AI 侧强制保险，也不受 AI 权限限制。

### 4.4 路由与外部调用

- 所有生产路由经 `connection.fetch` 注册，随 DSH 连接鉴权；`shutdown` 只能由认证界面触发，没有 AI 工具暴露它。
- 自测路由只在 `testMode` + `webServer` + `connection` 同时存在时挂载，且每个请求先做 `requestRejection` 校验（fail-closed 403）。
- 关机联动对逃生舱有 5 秒上限；异常只写日志，不影响 DSH 退出。
- 本包不改写安装目录、不做等长文本补丁、不改 `app.asar`；`scripts/restart-cli.mjs` 的破坏性操作（`relaunch` / `clear-stale --yes`）用于 Host 死亡后的显式恢复，不会被本包自动执行。

入口与鉴权对照：

| 入口 | 鉴权 | 能否触发关闭 | 说明 |
|---|---|---|---|
| 生产路由 `/api/dsh-restart/*` | `connection.fetch` 通道的连接鉴权；客户端同源 `credentials: 'same-origin'` | 能：仅 `POST /api/dsh-restart/shutdown`，强制必须 `confirmed: true` | 关闭没有 AI 工具入口 |
| 自测路由 `/dsh-restart-test/*` | 每个 handler 先 `scope.connection.requestRejection({ headers })`；401/403 直接拒绝；校验本身抛错也按 403 fail-closed | 能（含 `shutdown` handler），仅 `testMode` 下挂载 | 需要 `testMode` + `webServer` + `connection` 同时存在 |
| AI 工具 `restart_dsh_*` | 权限矩阵（[4.1](#41-权限与审批)）+ 强制保险 | 不能：没有对应的关闭工具 | 关闭能力不对 AI 暴露 |
| 外部 CLI `scripts/restart-cli.mjs` | 不经过 HTTP，Host 已死也能用 | 不能：命令集只有 `status` / `relaunch` / `clear-stale` / `unhold` | `relaunch` / `clear-stale --yes` 是显式恢复，不会被本包自动执行 |

### 4.5 强制模式与 force reaper

#### 4.5.1 触发与武装

AI 路径顺序固定：审批 → 校验并消费保险 → `requestRestart()`。

1. **审批**：强制工具先调用 `authorize()` 请求审批（完全访问免审批，否则一次审批）。
2. **校验并消费保险**：审批通过后才校验并消费 `restart_dsh_force_safeguard` 上的保险，随后才 `requestRestart()`。
3. **无保险时**：返回「已通过审批，但尚未完成强制重启保险：请先调用 `restart_dsh_force_safeguard` 并批准，然后重试本次强重启。」，不会重启。

**guard 职责**：全局 `ctx.tools.guard` **不再在审批前消费保险**，它只负责在非传输工具调用后重新锁定；`run_code` 与 `todo_execute` 是传输层，外层不重锁，嵌套调用仍逐个经过 guard（因此 `todo_execute` 重放强重启时，上保险后外层调用不会把保险提前重锁掉）。

**TTL 与重放**：保险有效期 `unlockTtlMs`（默认 300000ms），只对一次调用有效；审批被拒时保险保留，可稍后重试。

- 人类路径：界面长按 5 秒就是确认，不需要 AI 保险。
- `spawnForceReaper(record, launch, 'restart'|'shutdown')` 写 `force-reaper-spec.json`，detach 启动 `force-reaper.mjs`；spawn 失败时在 Windows 上回退到 `cmd.exe /c start "" /b ...`，仍失败则记录并继续自毁。

#### 4.5.2 回收器行为

- 等待 `killAfterMs`（来自 `forceKillAfterMs`，默认 2500）让 Host 优雅退出；超时后强杀。
- Windows 使用 `taskkill /F /PID <pid>`（**不带 `/T`**，避免连带杀掉回收器自己）；POSIX 使用 `SIGKILL`。最多尝试 3 次、每次间隔 400ms，并确认进程死亡。
- 重启模式：确认 Host 死亡后按 spec 重新拉起同一命令；桌面路径先结束 Electron 外壳（`mainPid`）再重开应用，避免单实例锁吞掉新应用。
- 关闭模式：Host 死亡即完成；桌面版同时结束外壳。
- marker 原子写入（临时文件 + rename）：`{ requestId, status: 'done'|'relaunched'|'error', pid, at, childPid?, detail? }`；Host 从不解析回收器日志来判断就绪。
- 独立锁文件 `force-relaunch.lock` 防止重复拉起。

#### 4.5.3 boot 对账与 hold

- 启动时 `reconcileForceArtifacts()` 读取上次的 reaper spec / marker / lock，写 `state.lastForceOutcome`。
- 对账结果不是 `relaunched` / `done` / `in-progress` 时（例如 `error`、`no-marker`，或 marker 状态未知），设置 `state.hold = { active: true, reason: 'last-force-<status>', at, requestId, detail }`，作为 fail-closed 诊断标记；`in-progress` 表示回收器仍持有锁，不产生 hold。
- `hold` 会出现在 `/api/dsh-restart/status`、`status.json` 与 `scripts/restart-cli.mjs status` 中；显式强制请求会清除它，`scripts/restart-cli.mjs unhold` 也可清除。
- **实现注意**：当前代码里的 `hold` 是持久化的对账/诊断标记，**不会拦截**等待/点名重启，也不阻止 CLI 的 `relaunch`；不要把它当成自动行为的硬门禁。
- `lastForceOutcome` 与 `hold` 跨 boot 持久化；普通等待/点名的 relaunch marker 只被清理，不覆盖持久化的强制对账结果。
- 强制请求在 `forceDryRun=true` 时只写 `force-dry-run.json`（含 plan 与目标 launch），不创建 pending、不武装回收器、不杀进程、不清 hold。

boot 对账结果与动作的对应：

| 对账结果 | 写入 `state.lastForceOutcome` | 是否产生 `hold` | 说明 |
|---|---|---|---|
| `relaunched` | 是 | 否 | 新进程已拉起 |
| `done` | 是 | 否 | 强制关闭已完成 |
| `in-progress` | 是 | 否 | 回收器仍持有锁 |
| `error` | 是 | 是 | `reason: 'last-force-error'`，带 `at` / `requestId` / `detail` |
| `no-marker` | 是 | 是 | 找不到 marker；`reason: 'last-force-no-marker'` |
| marker 状态未知 | 是 | 是 | 按 fail-closed 处理，与 `error` / `no-marker` 同类 |

`force-reaper-spec.json` 里的 `validation{ok,detail}`、`killAfterMs`、`killGraceMs`、`relaunchDelayMs`、`relaunch?`、`appExecutable?`、`appDir?`、`markerPath`、`logPath`、`lockPath` 是 spec 的完整字段清单（见 [3.6](#36-状态文件)）；对账读取其中的 spec / marker / lock，具体判定以源码为准。

## 5. 配置字段

所有字段都在 `cordis.patch.yml` 行 `config` 里可选；`normalizeConfig()` 逐个夹取。数值字段规则：非数字/`NaN`/`Infinity`/负数 → 默认值；小于下限 → 下限；大于上限 → 上限。

### 5.1 配置表

| 字段 | 默认 | 范围 / 类型 | 说明 |
|---|---|---|---|
| `graceMs` | 750 | 0..10000 | 重启条件满足后的静默期 |
| `pollMs` | 150 | 50..60000 | 重启条件轮询间隔 |
| `bootDeliveryDelayMs` | 1800 | 0..60000 | 新进程启动后投递重启后通知的延迟 |
| `flushTimeoutMs` | 3000 | 100..30000 | 普通重启退出前的会话保存预算 |
| `dangerousFlushTimeoutMs` | 1500 | 100..30000 | 强制重启退出前的会话保存预算（实际再与 800ms 取小） |
| `forceKillAfterMs` | 2500 | 500..30000 | 回收器等待优雅退出的上限，超时强杀 Host |
| `exitWatchdogMs` | 5000 | 500..30000 | 请求优雅退出后的强制退出看门狗 |
| `shutdownMaxWaitMs` | 300000 | `0` 或 5000..3600000 | 等待/中断关闭等待运行中 AI 的上限；`0` = 无限 |
| `shutdownGraceMs` | 3000 | 0..60000 | 达到关闭上限并取消剩余 AI 后的落定宽限 |
| `unlockTtlMs` | 300000 | 1000..86400000 | 一次强制保险的有效期 |
| `coordinatedResendMs` | 20000 | 1000..600000 | 对同一个 AI 重复发送点名插话的最小间隔 |
| `coordinatedMaxResends` | 5 | 0..20 | 对同一个 AI 重复发送点名插话的最大次数 |
| `rollCallWaitMs` | 120000 | 0..3600000 | 点名广播后最多等待的毫秒数；`0` = 永久等待 |
| `dangerousNotifyInterrupted` | true | 布尔（`!== false`） | 强制重启后是否向每个被中断的 AI 投递通知 |
| `coordinatedNotifyTimedOut` | true | 布尔（`!== false`） | 点名超时后是否给未就绪且未记录为被中断的 AI 发中断通知 |
| `openBrowserOnRelaunch` | false | 布尔（`=== true`） | 网页版 relaunch 是否新开浏览器标签页 |
| `desktopRelaunchTimeoutMs` | 25000 | 5000..120000 | 桌面应用未在预期时间内重启时回滚并报错 |
| `forceDryRun` | false | 布尔（`=== true`） | 强制重启只演练：写 `force-dry-run.json`，不创建 pending、不武装回收器、不杀进程 |
| `testMode` | false | 布尔（`=== true`） | 暴露 `/dsh-restart-test/*` 自测路由（仍要求 Host/Origin/连接鉴权） |
| `home` | 启动器 `profileContext.home` | 字符串 | DSH home 覆盖路径 |
| `launch` | 当前进程 argv | `{ execPath?, args?, cwd? }` | 网页版 relaunch 命令覆盖 |

两处布尔判定写法要区分：`!== false` 表示「只要不是显式 false 就开启」，`=== true` 表示「必须显式为 true 才开启」。本表中以 `0` 表示无限 / 永久等待的字段有两个：`shutdownMaxWaitMs`（0 = 无限）与 `rollCallWaitMs`（0 = 永久等待），其余数值字段的 `0` 都落在各自下限之外，会被夹到下限或按无效值回落默认值。

补充一个同源事实：`rollCallWaitMs` 同样以 `0` 表示「永久等待」（见 [3.3.3](#333-限时) 与本表），它与 `shutdownMaxWaitMs` 的差别是作用对象不同（点名 vs 关闭等待），不是取值规则的差别。

`normalizeConfig()` 的夹取示例（按上面的数值规则与本表的上下限推导，规则本身不改写）：

| 输入（以 `pollMs` 为例：默认 150、范围 50..60000） | 结果 |
|---|---|
| `"abc"`（非数字） | 150（默认值） |
| `NaN` | 150（默认值） |
| `Infinity` | 150（默认值） |
| `-10`（负数） | 150（默认值） |
| `10`（小于下限 50） | 50（下限） |
| `99999`（大于上限 60000） | 60000（上限） |
| `200`（范围内） | 200 |

同一条规则适用于所有数值字段；`shutdownMaxWaitMs` 与 `rollCallWaitMs` 的 `0` 属于各自的合法取值/特例（见上表），不会被当成非法值夹取。

字段生效位置对照（把 21 个字段与本文用到的常量串起来）：

| 字段 | 生效位置 / 用途 |
|---|---|
| `graceMs` | 重启条件满足后的静默期（`lastIdleAt`） |
| `pollMs` | `maybeFinalize()` 的 `setInterval` 轮询间隔 |
| `bootDeliveryDelayMs` | 新进程投递重启后通知的延迟（源文档：在 `appReady` 或 `bootDeliveryDelayMs` 之后投递） |
| `flushTimeoutMs` | 普通重启退出前的会话保存预算 |
| `dangerousFlushTimeoutMs` | 强制重启退出前的保存预算，实际取 `min(..., 800ms)` |
| `forceKillAfterMs` | 回收器 spec 的 `killAfterMs`；等待 Host 优雅退出的上限 |
| `exitWatchdogMs` | `appExit(0)` 之后的强制退出看门狗 |
| `shutdownMaxWaitMs` | `shutdownState.waitTimeoutMs` / `deadlineAt` |
| `shutdownGraceMs` | 达到关闭上限并取消剩余 AI 后的落定宽限 |
| `unlockTtlMs` | 强制保险的有效期 |
| `coordinatedResendMs` | 点名插话的最小间隔 |
| `coordinatedMaxResends` | 点名插话的最大次数 |
| `rollCallWaitMs` | `pending.coordinatedDeadlineAt`；也是 `cordis.patch.yml` 行里的静态值 |
| `dangerousNotifyInterrupted` | 强制重启后是否给每个被中断的 AI 投递通知 |
| `coordinatedNotifyTimedOut` | 点名超时后是否给未就绪 AI 发 `coordinated_timeout` 通知 |
| `openBrowserOnRelaunch` | 网页版 relaunch 是否补 `--no-open`（`true` 时不补） |
| `desktopRelaunchTimeoutMs` | `scheduleDesktopRelaunchGuard()` 的回滚窗口 |
| `forceDryRun` | 只写 `force-dry-run.json`，不创建 pending / 不武装回收器 / 不杀进程 / 不清 hold |
| `testMode` | 是否挂载 `/dsh-restart-test/*` |
| `home` | DSH home 覆盖路径；状态目录为 `<home>/.dsh-restart/` |
| `launch` | `resolveLaunch()` 的网页版 relaunch 命令覆盖 |

### 5.2 运行设置

- 文件：`<home>/.dsh-restart/settings.json`，目前唯一字段 `{ "rollCallWaitMs": <ms> }`。
- 允许值：`0` 或 `1000..3600000` 的整数（即界面上的 0 或 1..3600 秒）。
- `POST /api/dsh-restart/config` 写入后立即更新内存 `cfg.rollCallWaitMs`，下一次状态查询/截止时间计算就使用新值；不重写 patch、不触发 Loader 重新加载。
- 启动时 `runtimeRollCallWaitOverride()` 比较 `settings.json` 与 profile patch 的 mtime：运行设置更新时覆盖 patch；patch 之后被手工编辑（mtime 更新）则 patch 重新生效。

设置页「电源设置」的接口与界面约定：

- 入口：插件管理 → 本插件详情页（`plugins.bundle.config` 槽位，key = `@local/dsh-power`）。
- 标题「电源设置」；摘要行直接显示当前「点名等待：N 秒（0 = 永久等待）」，不打开设置也能看到。
- 面板只有一个「点名等待时间」数字输入框（允许 `0` 或 `1..3600` 秒）和「保存」按钮；`0` = 永久等待。
- 读取：`GET /api/dsh-restart/config` → `{ ok, rollCallWaitMs, writable, persisted }`。
- 保存：`POST /api/dsh-restart/config` 只提交 `{ rollCallWaitMs }`（秒 × 1000），写入 `<DSH_HOME>/.dsh-restart/settings.json`，立即生效；**不修改 `cordis.patch.yml`、不触发插件热重载**。
- 值非法返回 400（指明字段名），写入失败返回 500，不会半成功返回 `ok`。
- 优先级：运行设置文件的 mtime 晚于 profile patch 时覆盖 patch 里的 `rollCallWaitMs`；之后手工编辑 patch（mtime 更新）则 patch 重新生效，避免旧运行设置掩盖新的手工配置。
- 该面板不改变重启模式、权限或强制保险规则；等价的静态写法仍是 profile patch 行里的 `rollCallWaitMs`。

## 6. 测试与验证

验证手段分两层：`node --check` 覆盖全部 Host/Client 入口文件，四套 Node 测试覆盖写入竞态、`resumableToolCalls`、检查点与强制保险；合计 19 + 22 + 9 + 8 = 58 个用例。测试是纯 Node 脚本，不依赖 Cordis 运行时上下文。

### 6.1 语法检查

```powershell
# 假设当前位于仓库根目录；按实际包目录调整
cd pod/dsh-power
node --check index.js
node --check client.js
node --check host/ai.js
node --check host/constants.js
node --check host/human.js
node --check host/resumable.js
node --check host/session-writer.js
```

语法检查覆盖 `index.js`、`client.js` 与 `host/` 下五个模块；辅助进程（`force-reaper.mjs`、`relauncher*.mjs`、`quit-desktop.mjs`）与 `scripts/restart-cli.mjs` 不在这个列表里。

### 6.2 四套 Node 测试

```powershell
node test/session-writer.test.mjs   # 19 passed
node test/resumable.test.mjs        # 22 passed
node test/checkpoint-holds.test.mjs # 9 passed
node test/force-safeguard.test.mjs  # 8 passed
# 或一次跑完：
npm test
```

### 6.3 覆盖范围

| 测试 | 覆盖 |
|---|---|
| `test/session-writer.test.mjs`（19） | 跨重启结果写入竞态：live Session 走自己的写句柄；resume 占用写句柄时 deferred 并重试；平台已写 synthetic closer 时做 content-replace；不同真实结果跳过；回合已关闭时不写日志而是 `steer`/`followup` |
| `test/resumable.test.mjs`（22） | `resumableToolCalls` 的 hold/complete/fail、deadline 夹取、持久化文件、boot 恢复与 provisional 结算（假时钟、假日志写入器，不创建 Cordis 上下文） |
| `test/checkpoint-holds.test.mjs`（9） | 检查点排除 `restart_dsh_*` 与 held 调用、`heldToolCalls` 计数、恢复报告「可恢复调用」文本、运行设置的范围/round-trip/坏文件容错/mtime 优先级 |
| `test/force-safeguard.test.mjs`（8） | 强制重启「先审批、后校验/消费保险」：无保险+审批通过报「先上保险」且不重启；有保险+审批通过重启且只消费一次；审批被拒保险保留；无额外服务行为一致；safeguard 仍正常；`todo_execute` 重放传输层不重锁保险；过期保险在审批后被拒绝且不重启 |

按功能点倒排（同一批用例的另一种看法）：

| 功能点 | 覆盖它的测试 |
|---|---|
| 跨重启结果写入竞态、写句柄竞争、content-replace、回合已关闭改消息送达 | `session-writer`（19） |
| `resumableToolCalls` 的 hold / complete / fail、deadline 夹取、持久化、boot 恢复与 provisional 结算 | `resumable`（22） |
| 检查点排除 `restart_dsh_*` 与 held 调用、`heldToolCalls` 计数、恢复报告文本、运行设置范围 / round-trip / 坏文件容错 / mtime 优先级 | `checkpoint-holds`（9） |
| 强制「先审批、后校验/消费保险」、审批被拒保险保留、传输层重放、过期保险 | `force-safeguard`（8） |

合计 19 + 22 + 9 + 8 = 58 个用例，与 [HISTVER](./HISTVER.md) 的 1.8.2 验证记录一致。

### 6.4 沙箱与打包注意

> 本机 Windows 沙箱下 `node --test <file>` 可能因测试运行器需要管道派生子进程而报 `spawn EPERM`；直接 `node test/...` 或 `node --test --test-isolation=none test/...` 等价可跑。四套测试不进入 `.tgz`（`files` 未包含 `test`）。

这条限制只影响测试运行器的进程派生方式，不涉及插件运行时；打包时 `test/` 被排除，因此安装包里不会带测试文件。

### 6.5 验证清单与跨版本校对

`1.8.2` 的验证范围（源文档 HISTVER）：`node --check`（`index.js`、`client.js`、`host/*.js`、`force-reaper.mjs`、`relauncher*.mjs`、`quit-desktop.mjs`、`scripts/*.mjs`）；`npm test` 为 session-writer 19 / resumable 22 / checkpoint-holds 9 / force-safeguard 8（共 58）全过。

这与 [6.1](#61-语法检查) 的命令清单口径不同：TECHDOC 源文档的语法检查清单只列 `index.js`、`client.js` 与 `host/` 下五个模块，而版本记录的 `node --check` 还覆盖了辅助进程与 `scripts/*.mjs`。两处来源并存，本文不改写任一清单，实际执行范围以源码与发布记录为准。

与本文条目的对照检查清单：

| 检查项 | 判据 | 本文落点 |
|---|---|---|
| 语法 | `node --check` 覆盖入口文件 | [6.1](#61-语法检查) |
| 单测 | 四套 Node 测试 58 个用例全过，或 `npm test` 一次跑完 | [6.2](#62-四套-node-测试)、[6.3](#63-覆盖范围) |
| 设置页保存 | 保存后 `restart.log` 没有新 `boot`、当前回合未中断（HISTVER 1.7.5-hotfix.7 的人工验证口径） | [5.2](#52-运行设置)、[3.7](#37-运行设置的-mtime-优先级) |
| 重启完成 | `bootId` 变化后客户端轮询 `/api/dsh-restart/status` 判定完成并刷新页面 | [1.3](#13-客户端入口) |
| 强制结果 | `status.json` 与 `scripts/restart-cli.mjs status` 中查看 `lastForceOutcome` / `hold` | [4.5.3](#453-boot-对账与-hold)、[3.6](#36-状态文件) |

## 7. 附录

### 7.1 常量表

关键默认值汇总（字段含义见 [5.1](#51-配置表)）：

| 常量 / 字段 | 默认值 | 范围 / 备注 |
|---|---|---|
| `graceMs` | 750 | 0..10000 |
| `pollMs` | 150 | 50..60000 |
| `bootDeliveryDelayMs` | 1800 | 0..60000 |
| `flushTimeoutMs` | 3000 | 100..30000 |
| `dangerousFlushTimeoutMs` | 1500 | 100..30000；实际再与 800ms 取小 |
| `forceKillAfterMs` | 2500 | 500..30000 |
| `exitWatchdogMs` | 5000 | 500..30000 |
| `shutdownMaxWaitMs` | 300000 | `0` 或 5000..3600000；`0` = 无限 |
| `shutdownGraceMs` | 3000 | 0..60000 |
| `unlockTtlMs` | 300000 | 1000..86400000 |
| `coordinatedResendMs` | 20000 | 1000..600000 |
| `coordinatedMaxResends` | 5 | 0..20 |
| `rollCallWaitMs` | 120000 | 0..3600000；`0` = 永久等待 |
| `desktopRelaunchTimeoutMs` | 25000 | 5000..120000 |
| `dangerousNotifyInterrupted` | true | 布尔（`!== false`） |
| `coordinatedNotifyTimedOut` | true | 布尔（`!== false`） |
| `openBrowserOnRelaunch` | false | 布尔（`=== true`） |
| `forceDryRun` | false | 布尔（`=== true`） |
| `testMode` | false | 布尔（`=== true`） |

`CHECKPOINT_LIMITS`（检查点硬上限，见 [3.4.1](#341-检查点)）：

| 限制 | 值 |
|---|---|
| sessions | 200 |
| 每 session 未决调用 | 20 |
| 未决调用总数 | 200 |
| 每 session 后台 job | 10 |
| preview | 400 字符 |

`resumableToolCalls` 与界面相关上限：

| 项 | 值 |
|---|---|
| `hold` 的 `deadlineMs` | 夹取到 1..24h（无效值按上限 24 小时；24h = 86400000ms） |
| 注册表条目上限 | 64 条 |
| `callId` 长度 | ≤ 200 字符 |
| `tool` 长度 | ≤ 120 字符 |
| `hint` 大小 | ≤ 4096 字节 |
| `fail` 的 `reason` 长度 | ≤ 400 字符 |
| `argsPreview` 上限 | 400 字符 |
| `restart.log` 轮转阈值 | 1 MiB（轮转为 `restart.log.1`，只保留一个备份） |
| 回收器强杀尝试 | 最多 3 次、每次间隔 400ms |
| 强制模式的会话保存预算 | `min(dangerousFlushTimeoutMs, 800ms)` |
| 网页版等待 readiness marker | 最多 3 秒 |
| 强制确认长按 | 5 秒 |
| 逃生舱关机竞速 | `sleep(5000)`，即 5 秒上限 |
| AI 工具侧运行中 AI 列表 | 截到 50 条，并给出 `agentsTotal`/`agentsTruncated` |
| 关闭状态机等待 HTTP 响应刷出 | 250ms（`requestShutdown()` 第 3 步）；关闭流程内部等待，详见本节表注 |

注：HTTP 路由表 shutdown 行的等待时长与状态机内部一致，均为 250ms（源码 `requestShutdown()` 的 `await sleep(250)`，目的是让 HTTP 响应先刷出）；见 [2.3](#23-http-api-路由) 与 [3.2](#32-关闭状态机)。旧版路由表曾写 150ms，已按源码统一。

环境变量、路径与版本标识：

| 项 | 值 |
|---|---|
| `DSH_HOME` | home 解析顺序的第 3 位；状态目录默认 `$DSH_HOME/.dsh-restart/` |
| `~/.dsh` | home 解析顺序的最后一位 |
| `<home>/.dsh-restart/` | 状态目录：`restart.log`、`state.json`、`status.json`、`settings.json`、`checkpoint.json`、`restart-intent.json`、`resumable-holds.json` 与 relaunch / force 相关文件都在这里 |
| `ELECTRON_RUN_AS_NODE=1` | 桌面版 relaunch helper（`relauncher-desktop.mjs`）的启动环境 |
| `package.json` 的 `version` / `host/constants.js` 的 `PLUGIN_VERSION` | 当前同步为 `1.8.2`（HISTVER 记录） |

### 7.2 错误码与标记

| 标识 | 类别 | 含义 | 出处 |
|---|---|---|---|
| `TOOL_OUTCOME_UNKNOWN` | 平台结果标记 | 平台在会话恢复时写入的「工具结果未知」 | [3.5](#35-resumabletoolcalls)、[7.4](#74-已知边界) |
| `ToolOutcomeUnknownError` | 结算错误码 | `fail(callId, reason)` 用平台原文与错误码结算时的错误名 | [3.5](#35-resumabletoolcalls) |
| `dsh_restart_failed` | 通知信封 | 关闭流程清空 pending 时，把所有挂起的重启工具调用以此结束 | [3.2](#32-关闭状态机) |
| `dsh_restart_interrupted` | 通知信封 | 强制重启后发给每个 `interrupted` AI；点名超时且非发起者时带 `mode="coordinated_timeout"` | [3.1.4](#314-重启后投递) |
| `dsh_restart_completed` | 通知信封 | 发给所有发起者的完成通知 | [3.1.4](#314-重启后投递) |
| `dsh_restart_coordination` | 通知信封 | 点名广播的包裹标记，要求目标 AI 停止派生并进入就绪状态 | [3.3.2](#332-广播) |
| `dsh_resumable_tool_result` | 通知信封 | 回合已关闭时改用 `steer`/`followup` 投递的结果信封 | [3.5](#35-resumabletoolcalls) |
| `coordinated_timeout` | 模式标记 | 点名超时的中断通知模式值 | [3.1.4](#314-重启后投递) |
| `alreadyShuttingDown` | 路由响应字段 | 关闭请求已在关闭中时返回 `alreadyShuttingDown: true` | [2.3](#23-http-api-路由) |
| `already-installed` | 安装错误 | 网页版 `install_bundle` 对已安装同名包直接报错，升级必须走 CLI | [README](./README.md) |
| `spawn EPERM` | 测试环境错误 | Windows 沙箱下 `node --test <file>` 派生子进程失败 | [6.4](#64-沙箱与打包注意) |
| `hold` | 状态标记 | `state.hold = { active: true, reason, at, requestId, detail }`，boot 对账的 fail-closed 诊断标记 | [4.5.3](#453-boot-对账与-hold) |
| `last-force-<status>` | hold 原因模板 | 由上次强制尝试的对账状态拼成 | [4.5.3](#453-boot-对账与-hold) |
| `started` | marker 状态 | helper 存活 | [3.6](#36-状态文件) |
| `relaunched` | marker 状态 | 新进程已拉起；也是 boot 对账的合格结果之一 | [4.5.3](#453-boot-对账与-hold) |
| `done` | marker 状态 | 强制关闭完成 | [3.6](#36-状态文件) |
| `error` | marker 状态 | 失败详情，会导出 `hold` | [4.5.3](#453-boot-对账与-hold) |
| `in-progress` | 对账状态 | 回收器仍持有锁，不产生 hold | [4.5.3](#453-boot-对账与-hold) |
| `no-marker` | 对账状态 | 找不到 marker 时的状态名，会导出 `hold` | [4.5.3](#453-boot-对账与-hold) |
| `deliveredAsMessage` | 结算标记 | 结果以消息形式投递（不设 `resultSeq`） | [3.5](#35-resumabletoolcalls) |
| `totals.truncated` | 检查点标记 | 任一上限被超出时置 `true` | [3.4.1](#341-检查点) |
| `pending` / `restarting` | 阶段值 | `pending.phase` 的两个取值 | [3.1.1](#311-待执行记录) |
| `force-dry-run.json` | 演练文件 | `forceDryRun=true` 时只写这个文件，返回「未执行」 | [4.5.3](#453-boot-对账与-hold) |
| `accepted: false` | 路由响应值 | 关闭进行中（`shutdownInProgress`）时重启请求的返回 | [3.1.2](#312-请求合并与升级) |
| `totals.heldToolCalls` | 检查点计数 | 按会话被 `resumableToolCalls` 接管的调用计数（HISTVER 1.7.5-hotfix.2） | [3.4.1](#341-检查点) |
| `lastForceOutcome` | 状态字段 | boot 对账结果，与 `hold` 一起写在 `state.json` / `status.json` | [4.5.3](#453-boot-对账与-hold) |
| `interrupted` | intent 字段 | 强制模式下未就绪、被记为中断的运行中 AI | [3.1.3](#313-等待与收尾) |
| `timedOutSessions` | intent / lastRestart 字段 | 点名限时到点仍未就绪的 AI | [3.3.3](#333-限时) |
| 引导错误文案 | 提示文案 | 「已通过审批，但尚未完成强制重启保险：请先调用 `restart_dsh_force_safeguard` 并批准，然后重试本次强重启。」 | [4.2](#42-强制保险) |
| `escape pod not closed: escapePod service is not available` | 日志文案 | 逃生舱服务不存在时跳过关闭 | [2.5](#25-closeescapepod-流程) |
| `escape pod shutdown timed out after 5000ms; continuing to exit` | 日志文案 | 逃生舱关闭超过 5 秒 | [2.5](#25-closeescapepod-流程) |
| `escape pod shutdown failed: ...` | 日志文案 | 逃生舱关闭抛错 | [2.5](#25-closeescapepod-流程) |

### 7.3 术语表

| 术语 | 定义 |
|---|---|
| Host 半身 | `index.js` + `host/*.js`。持有状态机、AI 工具、路由、`resumableToolCalls` 与启动对账；改动必须重启 DSH 才生效 |
| Client 半身 | `client.js`，经 `window.__ModuleLoader__` 加载的网页版客户端插件；负责侧边栏按钮、菜单、对话框、进度/失败/关闭页与设置页，会热更新 |
| 阻塞等待 / safe | 等所有其他运行中 AI 完成当前回合后重启，不中断任何 AI |
| 点名 / coordinated（roll-call） | 向未就绪的运行中 AI 广播插话，要求停止派生子代理/工具并进入就绪状态 |
| 强制 / dangerous | 先审批，通过后校验并消费保险；立即中断所有未就绪的运行中 AI 并重启 |
| 就绪状态（safe state） | 使用过阻塞等待或点名工具、以及强制重启的发起者属于就绪状态；被强制中断的 AI 不属于 |
| 强制保险（safeguard） | 强制重启前的必需前置授权，只对紧接着的下一次工具调用有效，有效期 `unlockTtlMs` |
| 检查点（checkpoint） | `checkpoint.json`，有界、脱敏的未决状态快照；不做进程冻结 |
| 恢复报告（resume report） | `buildResumeReport()` 生成的逐会话未决状态说明，重启后投递一次 |
| hold | boot 对账后写入 `state.hold` 的 fail-closed 诊断标记；**不拦截**等待/点名重启，也不阻止 CLI `relaunch` |
| marker | `relaunch-ready.json` 中原子写的握手记录（`started` / `relaunched` / `done` / `error`）；Host 不靠回收器日志判断就绪 |
| reaper（force reaper） | `force-reaper.mjs`：detach 的回收器，等待优雅退出超时后强杀 Host 并按模式重新拉起或结束外壳 |
| provisional 结果 | 新 boot 恢复 holds 后立即写入的临时结果，抢在 Session resume 写入平台 closer 之前 |
| closer | 平台在 Session resume 时写入的合成结局；被它抢先时本包做 content-replace |
| PTC | 使用 `run_code` 的执行形态；其程序级 deadline 可能中止长时间等待（点名、审批） |
| 传输层 | `run_code` 与 `todo_execute`：外层调用不重锁保险，嵌套子调用仍逐个受 `ctx.tools.guard` 约束 |
| `authorize()` | 强制工具的审批入口；完全访问免审批，否则一次审批 |
| `consumeSafeguard()` | 审批通过后校验 TTL 并删除保险记录的函数；此前 `guard` 不再消费保险 |
| `guard` | 全局 `ctx.tools.guard`：只负责在非传输工具调用后重新锁定保险 |
| `flushAll()` | 退出前保存所有会话的调用（有界预算来自 `flushTimeoutMs` / `dangerousFlushTimeoutMs`） |
| boot 对账（reconcile） | 启动时 `reconcileForceArtifacts()` 读上次的 reaper spec / marker / lock，写 `lastForceOutcome` 并可能置 `hold` |
| intent（`restart-intent.json`） | 本次重启的持久意图；新 boot 据此投递通知后删除 |
| pending 记录 | `requestRestart()` 维护的唯一待执行记录，所有模式差异都体现在它的字段与 `phase` 上 |
| relaunch | 进程级重启动作：网页版由 `relauncher.mjs`、桌面版由 `relauncher-desktop.mjs` 拉起新 Host / 重开应用 |

### 7.4 已知边界

- **广播送达**：点名使用 steering，只在目标 AI 的下一个 step 边界消费；长工具调用会推迟送达。
- **“活跃 AI”包含子代理**：所有 live Agent（含子代理/工作流子代理）都计入；点名要求它们进入就绪状态，强制会把未就绪的运行中子代理记为被中断并尝试通知。
- **强制中断方式**：进程退出即中断；会话在下次恢复时由平台 repair 补上 `interrupted` 回合结束标记与 `TOOL_OUTCOME_UNKNOWN` 工具结果（被 `resumableToolCalls` 接管的调用除外）。
- **PTC 模式**：`run_code` 程序本身有默认 120 秒、上限 600 秒的程序级 deadline；长时间等待（点名、审批）可能被程序 deadline 中止，优先 native 模式或提高程序超时。
- **profile patch 热重载**：当前 DSH 0.2.1-rc.5 在回合运行时手工编辑 `cordis.patch.yml` 会 dispose 正在运行的 Agent/Session；设置页保存不受影响（写运行设置）。
- **桌面版**：依赖 Electron 外壳的 `process.ppid` 与 `quit-desktop.mjs`；外壳被系统/等待软件拦截时，`desktopRelaunchTimeoutMs` 后回滚并报错。
- **桌面应用重启失败**：`state.lastError` 记录原因，挂起的工具调用收到失败文本；用户可手动重开应用。
- **关机联动上限**：`closeEscapePod` 只与 `sleep(5000)` 竞速，超时或抛错只写日志，绝不阻止 DSH 退出；重启流程不调用逃生舱的 `shutdown()`。
- **没有进程冻结/恢复**：只保存有界检查点并如实报告，不承诺无损。
- **`hold` 不是门禁**：它只是 boot 对账后的持久化诊断标记，不拦截等待/点名重启，也不阻止 CLI 的 `relaunch`；清除只有显式强制请求或 `scripts/restart-cli.mjs unhold` 两条路。
- **检查点是有界的**：sessions 200、每会话未决调用 20、未决调用总数 200、每会话后台 job 10、preview 400 字符；超限只置 `totals.truncated=true`，报告如实但不承诺完整。
- **回收器可能启动失败**：spawn 失败时 Windows 回退到 `cmd.exe /c start "" /b ...`，仍失败则只记录并继续自毁——Host 仍会退出，但自动拉起可能失败。
- **网页版握手的 3 秒窗口**：`spawnRelauncher()` 只等与本次 `requestId` 匹配的 readiness marker 最多 3 秒，然后继续退出；`exitWatchdogMs` 是最后兜底，Host 从不解析回收器日志来判断就绪。
- **演练不改变诊断状态**：`forceDryRun=true` 只写 `force-dry-run.json`，不创建 pending、不武装回收器、不杀进程，也不清 `hold`。
- **`resumableToolCalls` 是可选服务**：本包未安装/被停用时服务不存在，其他插件持有的调用退化为平台默认的 `TOOL_OUTCOME_UNKNOWN` 行为。
- **自测路由不应在生产打开**：`/dsh-restart-test/*` 只在 `testMode` + `webServer` + `connection` 同时存在时挂载，且每个请求先做 `requestRejection` 校验（fail-closed 403）。

## 许可

本文件以 MIT 许可发布，版权归 DX12_XYZ 所有。完整条款见仓库根 [LICENSE](./LICENSE)。

<!-- fused-by: deepseek-v4.1-flash -->

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
