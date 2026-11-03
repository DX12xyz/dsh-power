/**
 * Module identities shared by the three halves of this bundle (v1.8.2).
 *
 * Five AI tools form three restart modes plus the force-restart safeguard and a
 * read-only status query:
 *   - 阻塞等待      restart_dsh_blocking_wait_safe       wait for every other running AI, then restart;
 *   - 点名    restart_dsh_roll_call_caution   broadcast to running AIs outside safe state,
 *                                                wait until every active AI is in safe state
 *                                                (bounded by rollCallWaitMs);
 *   - 强制    restart_dsh_force_dangerous     interrupt every running AI outside safe state
 *                                                immediately, then restart (approval first,
 *                                                then the force-restart safeguard);
 *   - 强制保险    restart_dsh_force_safeguard     arm the force tool for exactly the next call;
 *   - 只读状态    restart_dsh_status              read the current restart/shutdown state only.
 *
 * Human UI names: 等待 = 阻塞等待, 中断 = 点名, 强制 = 强制.
 *
 * Safe state (就绪状态): an AI belongs to safe state when it has used the all-wait or
 * roll-call tool, or when it is the initiator of the force restart that actually runs;
 * AIs interrupted by a force restart (without entering safe state beforehand) do not.
 */

/** Package version surfaced in boot logs and docs; keep in sync with package.json. */
export const PLUGIN_VERSION = '1.8.2';

export const TOOL_NAME_ALL_WAIT = 'restart_dsh_blocking_wait_safe';
export const TOOL_NAME_ROLL_CALL = 'restart_dsh_roll_call_caution';
export const TOOL_NAME_FORCE = 'restart_dsh_force_dangerous';
export const TOOL_NAME_SAFEGUARD = 'restart_dsh_force_safeguard';
export const TOOL_NAME_STATUS = 'restart_dsh_status';

export const MODE_SAFE = 'safe';
export const MODE_COORDINATED = 'coordinated';
export const MODE_DANGEROUS = 'dangerous';

/** AI-facing mode names used in tool text and post-restart notices. */
export const MODE_LABELS = {
  [MODE_SAFE]: '阻塞等待',
  [MODE_COORDINATED]: '点名',
  [MODE_DANGEROUS]: '强制',
};

/** Human UI names for the same modes (sidebar menu, dialogs, toasts). */
export const HUMAN_MODE_LABELS = {
  [MODE_SAFE]: '等待',
  [MODE_COORDINATED]: '中断',
  [MODE_DANGEROUS]: '强制',
};

/** The safe-state definition repeated in notifications. */
export const SAFE_STATE_DEFINITION =
  '就绪状态的定义：使用过【阻塞等待】或【点名】工具，以及强制重启的发起者，属于就绪状态；被强制中断的 AI 不属于就绪状态。';

export const SKILL_CONTENT = `# 重启 DSH（阻塞等待 / 点名 / 强制）

不要用 shell 命令杀 DSH 进程。桌面版重启会重启整个应用：窗口短暂关闭后自动重开。

## 模式与工具

| 模式 | 工具 | 行为 | 权限 |
|---|---|---|---|
| 阻塞等待（最推荐） | \`restart_dsh_blocking_wait_safe\` | 等所有其他运行中的 AI 完成当前回合后重启；不中断任何 AI | workspace-write 及以上免审批；read-only 一次审批 |
| 点名 | \`restart_dsh_roll_call_caution\` | 向未就绪的运行中 AI 广播插话，要求其停止派生/工具并加入就绪状态；默认最多等 120 秒，到点仍有 AI 未进入就绪状态就继续重启；非第一发起者调用退化为阻塞等待 | 同上；本模式激活后等待类工具对所有权限临时免审批 |
| 强制 | \`restart_dsh_force_dangerous\` | 立即中断所有未就绪的运行中 AI 并重启，不等待完成 | 仅完全访问免审批，否则一次审批；先审批，通过后再校验并消费保险（没有保险不会重启） |
| 强制保险 | \`restart_dsh_force_safeguard\` | 为强制重启上保险一次，只对下一次工具调用有效 | 仅完全访问免审批，否则一次审批 |
| 只读状态 | \`restart_dsh_status\` | 只读状态查询（不触发重启）：当前阶段、运行中 AI、待执行重启、关闭等待超时与上次重启摘要；无副作用 | 无需审批 |

人类界面名称映射：**等待 = 阻塞等待，中断 = 点名，强制 = 强制**；人类菜单的「重启 / 关闭」都可在弹窗下拉中三选一（默认等待），关闭只退出、不再启动。

只读状态查询（不触发重启）用 \`restart_dsh_status\`：无参数、无审批、不产生任何状态变更，适合在重启前确认是否有其他 AI 正在运行，或在怀疑卡住时查看关闭等待上限。

## 就绪状态

- 使用过阻塞等待或点名工具的 AI，以及强制重启的发起者，属于就绪状态。
- 被强制中断且没有预先进入就绪状态的 AI 不属于就绪状态。
- 点名等待所有活跃 AI 进入就绪状态；强制立即中断未就绪的运行中 AI。

## 强制（不可阻挡）

强制重启不可阻挡：完成检查点/意图后会启动独立回收器并强制终止 Host（必要时 taskkill），不等待优雅退出；桌面版会结束 Electron 外壳并重开应用。

## 强制保险规则

1. 无论权限如何（包括完全访问），都必须先调用 \`restart_dsh_force_safeguard\` 上保险。没有保险时，强制重启会先走审批，审批通过后返回「先上保险」的引导错误，不会重启。
2. 保险只对紧接着的下一次工具调用有效，且该调用必须是 \`restart_dsh_force_dangerous\`。
3. 在此之前调用任何其他工具、命令、技能、子代理，或回合结束、进程重启，都会重新锁定。PTC 的 \`run_code\` 与待办重放的 \`todo_execute\` 是传输层，外层调用不重锁；它们内部的嵌套调用仍逐个校验。
4. 强制重启的执行顺序是「先审批，再校验并消费保险」；审批被拒时保险保留，可稍后重试。
5. **除非有额外需求，否则不要使用强制重启。**

## 人类入口

- 网页与桌面侧边栏底部的「DSH电源」按钮（settingsArea 区域，仅图标）打开菜单：「重启」/「关闭」。
- 点开后弹窗内用下拉选择模式（默认「等待」）：
  - 等待：确认框可取消；
  - 中断：点「下一步」后再确认一次；
  - 强制：红色警告，确认按钮需长按 5 秒（闪烁加速），松开即取消。
- 关闭与重启使用同样的三选一，但只关闭、不再启动：等待=等运行中 AI 完成当前回合；中断=广播要求 AI 停止、所有活跃 AI 停止后关闭；强制=立即中断并关闭。
- 人类发起的强制重启/强制关闭由长按确认，不需要 AI 开保险，也不受 AI 权限限制。

## 权限

- 阻塞等待 / 点名：workspace-write 或 danger-full-access 免审批；read-only 一次审批；点名激活期间等待类工具对所有权限临时免审批。
- 强制 / 强制保险：仅完全访问免审批；其他权限各需一次审批。强制重启先请求审批，审批通过后才校验并消费保险；没有保险不会重启。
- 没有审批通道且权限不足时，工具拒绝执行并说明原因。

## 工具调用行为

1. 重启请求合并；模式升级：强制 > 点名 > 阻塞等待。
2. 调用会保持挂起直到进程重启；不要在这之后开始新的推理步骤。
3. 重启后本会话收到 \`<dsh_restart_completed mode="...">\`；非发起者被强制中断时收到 \`<dsh_restart_interrupted mode="force_dangerous">\`。按消息行动，不要重试。
4. 强制非发起者被中断时，会被告知“被强制重启、可能后果、尝试恢复任务进度并向人类告示”。

## 点名广播

- 第一发起者调用 \`restart_dsh_roll_call_caution\` 后，所有不在就绪状态且正在运行的 AI 收到插话：停止派生子代理/正在执行的工具，不要开始新任务，调用 \`restart_dsh_blocking_wait_safe\` 加入就绪状态（非第一发起者调用点名会退化为阻塞等待）。
- 使用阻塞等待或点名工具即进入就绪状态；点名模式默认最多等 120 秒，到点仍未进入就绪状态的 AI 会被中断、重启继续；等待时间可在插件页调整（0 = 永久等待）。
- 广播只在目标 AI 的下一个 step 边界送达；卡在长工具调用中的 AI 需要等该调用结束，因此可能等待较久。

## PTC 模式

- PTC 下 \`run_code\` 程序有默认 120 秒、上限 600 秒的程序级 deadline；长时间等待（点名、审批）可能被中止，优先 native 模式或提高程序超时。
- native 模式没有该限制：工具不声明 \`timeoutMs\`，长挂起不受命令超时影响。

## 重启后

- 阻塞等待 / 点名：发起者收到完成消息，包含就绪状态说明。
- 强制：发起者收到完成消息，声明使用了强制重启、属于/不属于就绪状态的 AI 与被中断 AI 的恢复结果；必须向用户如实报告。被中断 AI 会收到中断通知并要求恢复进度、向人类告示。
- 若收到 \`[DSH 重启失败]\`，报告失败原因；人类仍可用「DSH电源」按钮重启或关闭 DSH。
`;
