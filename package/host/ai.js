/**
 * Module 2 of 3 — AI-initiated restart tools (v1.8.2).
 *
 * Registers five tools and the `restart-dsh` skill:
 *   - `restart_dsh_blocking_wait_safe`   wait for every other running AI, then restart;
 *   - `restart_dsh_roll_call_caution` broadcast to running AIs outside safe state and
 *                                   wait until every active AI is in safe state
 *                                   (bounded by rollCallWaitMs);
 *   - `restart_dsh_force_dangerous` interrupt every non-safe-state running AI
 *                                   immediately, then restart (approval first,
 *                                   then the force-restart safeguard);
 *   - `restart_dsh_force_safeguard` arm the force tool for exactly the next call;
 *   - `restart_dsh_status`          read-only status query (never restarts).
 *
 * Force-restart order (1.8.2): the tool body requests approval first and only
 * after that approval passes does it check and consume the safeguard. A rejected
 * or auto-rejected approval therefore leaves the safeguard untouched, and an
 * unarmed call still reaches approval so an offline rejection can be kept in the
 * todo inbox by the attention plugin.
 *
 * The force lock is enforced twice:
 *   1. a global `ctx.tools.guard` re-locks the safeguard on any other non-transport
 *      tool call (including shell commands, skills and subagents); it never
 *      consumes the safeguard itself. `run_code` and `todo_execute` are transport
 *      layers whose outer call does not re-lock (their nested sub-calls are
 *      separate executions guarded individually), so a replayed force call can
 *      still consume a safeguard armed before the replay;
 *   2. the force tool consumes the safeguard in its own body only after
 *      `authorize()` returns, so no path reaches `requestRestart` without a
 *      consumed safeguard.
 *
 * The tools declare no `timeoutMs`, so @deepseek-ai/dsh-tool-call-timeout-policy
 * leaves their held-open calls untouched (it only arms deadlines for tools that
 * declare a limit). A tool call returns early only when the restart fails or the
 * turn is cancelled. The status tool returns immediately: it declares no
 * approval requirement and performs no side effect.
 */
import {
  MODE_COORDINATED,
  MODE_DANGEROUS,
  MODE_SAFE,
  SKILL_CONTENT,
  TOOL_NAME_ALL_WAIT,
  TOOL_NAME_FORCE,
  TOOL_NAME_ROLL_CALL,
  TOOL_NAME_SAFEGUARD,
  TOOL_NAME_STATUS,
} from './constants.js';

function messageOf(error) {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : String(error);
}

function safeGet(ctx, key) {
  try {
    return ctx.get(key);
  } catch {
    return undefined;
  }
}

function permissionLabel(permission) {
  if (permission === undefined) return '未知';
  if (typeof permission.preset === 'string' && permission.preset.length > 0) return permission.preset;
  if (typeof permission.sandbox === 'string') return permission.sandbox;
  return 'custom';
}

/** Full access = the `danger-full-access` sandbox with the `never` approval policy. */
function isFullAccess(permission) {
  return permission?.sandbox === 'danger-full-access' && permission?.approvalPolicy === 'never';
}

/** Workspace modification and above: workspace-write or danger-full-access. */
function isWorkspaceWriteOrAbove(permission) {
  return permission?.sandbox === 'workspace-write' || permission?.sandbox === 'danger-full-access';
}

/**
 * Transport layers: their outer call is not a business tool call and must not
 * re-lock the safeguard. `run_code` is the PTC transport; `todo_execute` replays
 * a previously approved tool call through `ctx.tools.execute`, so the nested call
 * (which may be the force tool) is guarded separately. Without this exemption a
 * safeguard armed before `todo_execute` could never reach the replayed force
 * call.
 */
const TRANSPORT_TOOL_NAMES = new Set(['run_code', 'todo_execute']);

const SAFEGUARD_REQUIRED_MESSAGE =
  '已通过审批，但尚未完成强制重启保险：请先调用 ' +
  TOOL_NAME_SAFEGUARD +
  ' 并批准，然后重试本次强重启。DSH 未重启。';

export function registerAiRestart(ctx, api) {
  const { requestRestart, holdToolCall, permissionOf, platform, log } = api;
  const desktop = platform === 'desktop';
  /** Human fallback path named in refusal messages. */
  const humanEntryHint = desktop
    ? '退出并重新打开桌面应用'
    : '侧边栏底部的「DSH电源」按钮';

  /* ------------------------------------------------ force-restart safeguard -- */

  /**
   * One open safeguard per session, in memory only: a process restart re-locks it.
   * @type {Map<string, { unlockCallId: string, at: number }>}
   */
  const safeguards = new Map();

  const unlockTtlMs = typeof api.unlockTtlMs === 'number' && api.unlockTtlMs > 0 ? api.unlockTtlMs : 300000;

  function clearSafeguard(sessionId, reason) {
    if (sessionId === undefined) return false;
    if (!safeguards.delete(sessionId)) return false;
    log(`force-restart safeguard for session ${sessionId} dropped (${reason})`);
    return true;
  }

  /**
   * Check and consume the one-safeguard window AFTER approval. Returns
   * `undefined` when no safeguard is armed, `{ expired: true }` when it aged out,
   * and `{ unlockCallId }` when it was consumed. The force tool is the only
   * caller, and it calls this only after `authorize()` has passed — a rejected
   * approval therefore leaves the safeguard untouched.
   */
  function consumeSafeguard(sessionId) {
    const state = safeguards.get(sessionId);
    if (state === undefined) return undefined;
    const now = Date.now();
    if (now - state.at > unlockTtlMs) {
      safeguards.delete(sessionId);
      log(`force-restart safeguard for session ${sessionId} expired before the force call`);
      return { expired: true };
    }
    safeguards.delete(sessionId);
    return { unlockCallId: state.unlockCallId };
  }

  /**
   * Monotonic guard: every tool execution passes here before its body runs.
   * It never consumes the safeguard — the force tool does that in its body after
   * approval. The guard only re-locks the safeguard when another non-transport
   * tool call happens after arming; `run_code` and `todo_execute` are transport
   * layers and their nested sub-calls are guarded individually.
   */
  ctx.effect(
    () =>
      ctx.tools.guard((exec) => {
        try {
          const agentId = exec.agent === undefined || exec.agent === null ? undefined : String(exec.agent.id);
          if (agentId === undefined) return undefined;
          if (TRANSPORT_TOOL_NAMES.has(exec.name)) return undefined;
          // The force tool checks and consumes the safeguard after approval; the
          // guard must not touch it here or a rejected approval would burn it.
          if (exec.name === TOOL_NAME_FORCE) return undefined;
          if (safeguards.delete(agentId)) {
            log(`force-restart relocked for session ${agentId}: tool ${exec.name} called after safeguard`);
          }
          return undefined;
        } catch (error) {
          // Never let the guard itself throw: the force tool checks and consumes
          // the safeguard in its body, so a guard failure still cannot bypass it.
          log(`force-restart guard failed: ${messageOf(error)}`);
          return undefined;
        }
      }),
    'dsh-restart: force restart safeguard guard',
  );

  // A turn boundary or agent disposal invalidates the "next call" window.
  try {
    ctx.on('agent/status', (payload) => {
      if (payload?.status !== 'idle') return;
      const agentId = payload?.agent?.id;
      if (agentId !== undefined) clearSafeguard(String(agentId), 'agent became idle');
    });
    ctx.on('agent/disposed', (payload) => {
      const agentId = payload?.agent?.id;
      if (agentId !== undefined) clearSafeguard(String(agentId), 'agent disposed');
    });
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return;
      const sessionId = session === undefined || session === null ? undefined : String(session.id);
      if (sessionId !== undefined) clearSafeguard(sessionId, 'turn ended');
    });
  } catch (error) {
    log(`force-restart safeguard lifecycle subscription failed: ${messageOf(error)}`);
  }

  /* ------------------------------------------------------------- approval -- */

  /**
   * Safe-state tools (all-wait and roll-call) are frictionless for
   * workspace-write and above. While a roll-call restart is pending, the window
   * opens for EVERY permission preset so a read-only AI that received the
   * broadcast can still join safe state without an approval prompt.
   */
  function safeStateFrictionless(permission) {
    try {
      if (typeof api.safeStateAccessOpen === 'function' && api.safeStateAccessOpen() === true) return true;
    } catch {
      /* the open check must never block authorization */
    }
    return isWorkspaceWriteOrAbove(permission);
  }

  /**
   * Authorize one tool call. Safe-state tools run without a prompt for
   * workspace-write and above (and, while a roll-call restart is pending, for
   * every permission preset); the force tools only for full access. Every other
   * case asks the human for a one-time authorization.
   */
  async function authorize({ agent, exec, session, toolName, required, actionZh, actionEn }) {
    const permission = permissionOf(session);
    const frictionless =
      required === 'safeState'
        ? safeStateFrictionless(permission)
        : required === 'workspace'
          ? isWorkspaceWriteOrAbove(permission)
          : isFullAccess(permission);
    if (frictionless) return permission;
    const approval = safeGet(ctx, 'approval');
    if (approval === undefined || typeof approval.request !== 'function') {
      throw new Error(
        `当前会话权限不足（${permissionLabel(permission)}），且本部署没有审批服务，无法申请授权，DSH 未重启。` +
          `请让用户点击${humanEntryHint}手动重启，或把本会话切换到所需权限后重试。`,
      );
    }
    let outcome;
    try {
      outcome = await approval.request({
        agent,
        toolName,
        callId: exec.callId,
        reason: `AI 请求${actionZh}（当前权限：${permissionLabel(permission)}，需要授权一次）`,
        displayReason: {
          en: actionEn,
          zh: `AI 请求${actionZh}。当前会话权限不足，需要授权一次。`,
        },
        signal: exec.signal,
      });
    } catch (error) {
      throw new Error(`本次操作需要授权，但授权申请失败：${messageOf(error)}。DSH 未重启。`);
    }
    if (outcome !== 'allowed-once') {
      const reason =
        outcome === 'rejected'
          ? '授权未通过'
          : outcome === 'cancelled'
            ? '授权请求被取消'
            : '没有可用的审批通道';
      throw new Error(
        `${reason}，DSH 未重启。请向用户说明：本次操作需要授权；用户可点击${humanEntryHint}手动重启，或把本会话切换为所需权限后重试。`,
      );
    }
    return permission;
  }

  /* ---------------------------------------------------------------- tools -- */

  function agentAndSession(exec, toolName) {
    const agent = exec.agent;
    if (agent === undefined) throw new Error(`${toolName} 需要由 AI 调用`);
    if (ctx.agents.get(agent.id) !== agent) throw new Error(`${toolName} 需要当前存活的调用 AI`);
    const session = agent.session ?? ctx.sessions.get(agent.id);
    if (session === undefined) throw new Error(`${toolName} 需要调用 AI 拥有存活会话`);
    return { agent, session };
  }

  const reasonParam = {
    type: 'string',
    description: '可选：重启原因的简短说明，会记录在待执行请求和重启后通知中。',
  };

  const commonOutput = {
    schema: {
      type: 'object',
      properties: {
        scheduled: { type: 'boolean' },
        accepted: { type: 'boolean' },
        mode: { type: 'string' },
        requestId: { type: 'string' },
        message: { type: 'string' },
        waitingForAgents: { type: 'number' },
        degraded: { type: 'boolean' },
      },
      additionalProperties: true,
    },
    render: (_args, value) => [
      { type: 'text', text: typeof value?.message === 'string' ? value.message : JSON.stringify(value) },
    ],
  };

  /** 阻塞等待：等待其他运行中的 AI 完成当前回合后重启。 */
  const allWaitTool = {
    name: TOOL_NAME_ALL_WAIT,
    description:
      '阻塞等待重启：等待所有其他运行中的 AI 完成当前回合并输出后重启；不中断任何 AI，优先使用。' +
      '权限：workspace-write 及以上免审批，read-only 一次审批；有点名重启进行中时对所有权限临时免审批。' +
      '调用会挂起至重启完成，不要重试。PTC 下长等待优先 native 模式。',
    parameters: { type: 'object', properties: { reason: reasonParam }, additionalProperties: false },
    output: commonOutput,
    presentCall: (args) => ({
      card: 'generic',
      title: '阻塞等待重启 DSH',
      kind: 'execute',
      rawInput: args !== null && typeof args === 'object' ? args : undefined,
    }),
    async execute(args, exec) {
      const { agent, session } = agentAndSession(exec, TOOL_NAME_ALL_WAIT);
      await authorize({
        agent,
        exec,
        session,
        toolName: TOOL_NAME_ALL_WAIT,
        required: 'safeState',
        actionZh: '阻塞等待重启 DSH',
        actionEn:
          'An AI requested an all-wait DSH restart. This session is read-only and no roll-call restart is open, so the human must authorize it once.',
      });
      const reason = typeof args?.reason === 'string' ? args.reason.trim().slice(0, 500) : '';
      const result = requestRestart({
        source: 'tool',
        sessionId: String(agent.id),
        reason: reason.length > 0 ? reason : undefined,
        mode: MODE_SAFE,
      });
      if (result.accepted === false) {
        throw new Error(result.message ?? 'DSH 已经在重启流程中，本次调用未排队。');
      }
      await holdToolCall({
        sessionId: String(agent.id),
        callId: exec.callId,
        signal: exec.signal,
        blocking: result.blockingAgents ?? 0,
      });
      return {
        scheduled: true,
        accepted: true,
        mode: result.mode ?? MODE_SAFE,
        requestId: result.requestId,
        waitingForAgents: result.blockingAgents ?? 0,
        message: '已排入阻塞等待重启（等待其他运行中的 AI）。调用会挂起至重启完成。',
      };
    },
  };

  /** 点名：广播插话并等待所有活跃 AI 进入就绪状态。 */
  const rollCallTool = {
    name: TOOL_NAME_ROLL_CALL,
    description:
      '点名重启：向未就绪的运行中 AI 广播插话，要求其停止派生子代理/工具并加入就绪状态；所有活跃 AI 进入就绪状态后重启。' +
      '默认最多等 120 秒；到点仍未进入就绪状态的 AI 会被中断；可在插件页调整等待时间（0 = 永久等待）。' +
      '非第一发起者调用退化为阻塞等待。权限：workspace-write 及以上免审批，read-only 一次审批；本模式激活后所有权限临时免审批。' +
      '调用会挂起至重启完成，不要重试。PTC 下长等待优先 native 模式。',
    parameters: { type: 'object', properties: { reason: reasonParam }, additionalProperties: false },
    output: commonOutput,
    presentCall: (args) => ({
      card: 'generic',
      title: '点名重启 DSH',
      kind: 'execute',
      rawInput: args !== null && typeof args === 'object' ? args : undefined,
    }),
    async execute(args, exec) {
      const { agent, session } = agentAndSession(exec, TOOL_NAME_ROLL_CALL);
      await authorize({
        agent,
        exec,
        session,
        toolName: TOOL_NAME_ROLL_CALL,
        required: 'safeState',
        actionZh: '点名重启 DSH',
        actionEn:
          'An AI requested a roll-call safe DSH restart. This session is read-only and the roll-call window is not open yet, so the human must authorize it once.',
      });
      const reason = typeof args?.reason === 'string' ? args.reason.trim().slice(0, 500) : '';
      const result = requestRestart({
        source: 'tool',
        sessionId: String(agent.id),
        reason: reason.length > 0 ? reason : undefined,
        mode: MODE_COORDINATED,
      });
      if (result.accepted === false) {
        throw new Error(result.message ?? 'DSH 已经在重启流程中，本次调用未排队。');
      }
      const degraded = result.degraded === true;
      const broadcastSent = result.broadcast?.sent ?? 0;
      await holdToolCall({
        sessionId: String(agent.id),
        callId: exec.callId,
        signal: exec.signal,
        blocking: degraded ? (result.blockingAgents ?? 0) : (result.activeNotSafe ?? 0),
      });
      return {
        scheduled: true,
        accepted: true,
        degraded,
        mode: result.mode ?? (degraded ? MODE_SAFE : MODE_COORDINATED),
        requestId: result.requestId,
        waitingForAgents: degraded ? (result.blockingAgents ?? 0) : (result.activeNotSafe ?? 0),
        message: degraded
          ? '已加入就绪状态（非第一发起者，本次按阻塞等待处理）。调用会挂起至重启完成。'
          : `已排入点名重启：已广播 ${String(broadcastSent)} 个 AI，仍有 ${String(result.activeNotSafe ?? 0)} 个活跃 AI 未进入就绪状态。`,
      };
    },
  };

  /** 强制：先审批，审批通过后再校验并消费保险，然后立即中断并重启。 */
  const forceReasonParam = {
    type: 'string',
    description:
      '可选：重启原因的简短说明，会记录在待执行请求和重启后通知中；审批通过且保险校验通过后才会真正重启。',
  };

  const forceTool = {
    name: TOOL_NAME_FORCE,
    description:
      '强制重启：立即中断所有未就绪的运行中 AI 并重启，不等待完成。' +
      '执行顺序固定为：先请求审批（完全访问免审批，否则一次审批），审批通过后再校验并消费强制保险；没有保险不会重启。' +
      '使用前请先调用 ' +
      TOOL_NAME_SAFEGUARD +
      ' 上保险并批准，然后再调用 ' +
      TOOL_NAME_FORCE +
      '。' +
      '除非有额外需求，否则不要使用。' +
      '重启不可阻挡：完成检查点/意图后会启动独立回收器并强制终止 Host（必要时 taskkill），不等待优雅退出；桌面版会结束 Electron 外壳并重开应用。' +
      '调用会挂起至重启完成，不要重试；PTC 下审批/等待可能受程序 deadline 影响，优先 native。',
    parameters: {
      type: 'object',
      properties: { reason: forceReasonParam },
      additionalProperties: false,
    },
    output: commonOutput,
    presentCall: (args) => ({
      card: 'generic',
      title: '强制重启 DSH',
      kind: 'execute',
      rawInput: args !== null && typeof args === 'object' ? args : undefined,
    }),
    async execute(args, exec) {
      const { agent, session } = agentAndSession(exec, TOOL_NAME_FORCE);
      // Order is deliberate (1.8.2): approval first, safeguard second. A
      // rejected or auto-rejected approval must leave the safeguard untouched,
      // and an unarmed call must still reach approval so the attention plugin
      // can keep an offline rejection in the todo inbox.
      await authorize({
        agent,
        exec,
        session,
        toolName: TOOL_NAME_FORCE,
        required: 'full',
        actionZh: '强制重启 DSH（会立即中断所有未就绪的运行中 AI；审批通过后再校验强制保险）',
        actionEn:
          'An AI requested a force DSH restart. It interrupts every running AI that is not in safe state immediately. This session is not in full access, so the human must authorize it once; the safeguard is checked and consumed only after this approval.',
      });
      const sessionId = String(agent.id);
      const consumed = consumeSafeguard(sessionId);
      if (consumed === undefined) {
        // Same message for full access and approval-gated sessions: the order is
        // always approval -> safeguard, and a missing safeguard never restarts.
        throw new Error(SAFEGUARD_REQUIRED_MESSAGE);
      }
      if (consumed.expired === true) {
        throw new Error(
          '已通过审批，但强制重启保险已过期（超过 ' +
            String(Math.round(unlockTtlMs / 1000)) +
            ' 秒）：已重新锁定，请重新调用 ' +
            TOOL_NAME_SAFEGUARD +
            ' 并批准，然后重试本次强重启。DSH 未重启。',
        );
      }
      log(
        `force-restart safeguard consumed by ${TOOL_NAME_FORCE} call ${String(exec.callId)} for session ${sessionId} (armed by call ${consumed.unlockCallId})`,
      );
      const reason = typeof args?.reason === 'string' ? args.reason.trim().slice(0, 500) : '';
      const result = requestRestart({
        source: 'tool',
        sessionId,
        reason: reason.length > 0 ? reason : undefined,
        mode: MODE_DANGEROUS,
      });
      if (result.accepted === false) {
        throw new Error(result.message ?? '审批与强制保险均已通过，但 DSH 已经在重启流程中，本次调用未排队。');
      }
      await holdToolCall({
        sessionId,
        callId: exec.callId,
        signal: exec.signal,
        blocking: result.interruptedAgents ?? 0,
      });
      return {
        scheduled: true,
        accepted: true,
        mode: MODE_DANGEROUS,
        requestId: result.requestId,
        waitingForAgents: result.interruptedAgents ?? 0,
        message: `审批阶段已通过、强制保险已消费，已排入强制重启：将立即中断 ${String(result.interruptedAgents ?? 0)} 个未就绪的运行中 AI。调用会挂起至重启完成。重启不可阻挡：完成检查点/意图后会启动独立回收器并强制终止 Host（必要时 taskkill），不等待优雅退出；桌面版会结束 Electron 外壳并重开应用。`,
      };
    },
  };

  /** 强制保险：强制重启的前置步骤，只覆盖紧接其后的下一次工具调用。 */
  const safeguardTool = {
    name: TOOL_NAME_SAFEGUARD,
    description:
      '强制保险：为强制重启上一次保险（前置步骤，不是权限提升）。' +
      '上保险后，强制重启会先请求审批，审批通过后才校验并消费本次保险；没有保险不会重启。' +
      '只对紧接着的下一次工具调用有效；在此之前调用任何其他工具、命令、技能、子代理，或回合结束，都会重新锁定（`run_code` / `todo_execute` 传输层的外层调用不重锁，嵌套调用仍逐个校验）。' +
      '仅完全访问免审批，否则一次审批。除非有额外需求，否则不要使用强制重启。',
    parameters: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          description: '可选：简述为什么需要强制重启（会写入审批理由和返回文本）。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          unlocked: { type: 'boolean' },
          mode: { type: 'string' },
          nextTool: { type: 'string' },
          expiresAt: { type: 'number' },
          message: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (_args, value) => [
        { type: 'text', text: typeof value?.message === 'string' ? value.message : JSON.stringify(value) },
      ],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: '强制保险（强制重启前置）',
      kind: 'execute',
      rawInput: args !== null && typeof args === 'object' ? args : undefined,
    }),
    async execute(args, exec) {
      const { agent, session } = agentAndSession(exec, TOOL_NAME_SAFEGUARD);
      const intent = typeof args?.intent === 'string' ? args.intent.trim().slice(0, 300) : '';
      await authorize({
        agent,
        exec,
        session,
        toolName: TOOL_NAME_SAFEGUARD,
        required: 'full',
        actionZh: '强制保险（下一步必须立刻调用强制重启）',
        actionEn:
          'An AI requested to arm the force DSH restart. The next tool call must be the force restart, otherwise the arming is revoked.',
      });
      const sessionId = String(agent.id);
      safeguards.set(sessionId, { unlockCallId: String(exec.callId), at: Date.now() });
      log(`force-restart safeguard armed for session ${sessionId}${intent.length > 0 ? ` intent=${intent}` : ''}`);
      const expiresAt = Date.now() + unlockTtlMs;
      const intentSuffix = intent.length > 0 ? `你声明的意图：${intent}。` : '';
      return {
        unlocked: true,
        mode: MODE_DANGEROUS,
        nextTool: TOOL_NAME_FORCE,
        expiresAt,
        message:
          '已上保险（意图确认完成）。' +
          intentSuffix +
          `下一次工具调用必须是 ${TOOL_NAME_FORCE}，且只执行这一次强制重启；` +
          '在此之前调用其他工具、命令、技能、子代理，或回合结束，都会重新锁定。若意图已改变，不要调用强制重启。',
      };
    },
  };

  /** 只读状态：不触发重启、不审批、不写任何状态。 */
  const statusTool = {
    name: TOOL_NAME_STATUS,
    description:
      '只读状态查询（不触发重启）：返回当前阶段、是否正在关闭、运行中 AI（最多 50 条）、待执行重启、关闭等待上限/截止时间与上次重启摘要。' +
      '无参数、无审批、无副作用；需要重启时另行调用对应的重启工具。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          phase: { type: 'string' },
          shuttingDown: { type: 'boolean' },
          runningAgents: { type: 'number' },
          agents: { type: 'array', items: { type: 'object', additionalProperties: true } },
          platform: { type: 'string' },
          message: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (_args, value) => [
        { type: 'text', text: typeof value?.message === 'string' ? value.message : JSON.stringify(value) },
      ],
    },
    presentCall: () => ({
      card: 'generic',
      title: '查询 DSH 重启状态（只读）',
      kind: 'read',
    }),
    async execute() {
      if (typeof api.statusSummary !== 'function') {
        throw new Error('状态查询不可用：当前宿主未提供只读状态投影。');
      }
      const summary = api.statusSummary();
      const pendingLabel =
        summary.pending === null || summary.pending === undefined
          ? '无待执行重启'
          : `待执行重启 ${String(summary.pending.mode ?? 'unknown')}（等待 ${String(summary.pending.waitingAgents ?? 0)} 个 AI）`;
      const shutdownLabel =
        summary.shutdown === null || summary.shutdown === undefined
          ? '未在关闭'
          : `关闭中 ${String(summary.shutdown.mode ?? 'unknown')}（等待上限 ${String(summary.shutdown.waitTimeoutMs ?? 0)}ms）`;
      const resume = summary.lastRestart?.resume;
      const resumeLabel =
        resume === null || resume === undefined
          ? ''
          : `；上次重启恢复报告：${String(resume.sessions)} 个会话，` +
            `${String(resume.openToolCalls)} 个未决工具调用，${String(resume.jobs)} 个后台任务，` +
            `已投递 ${String(resume.delivered)}，待投递 ${String(resume.pending)}`;
      return {
        ...summary,
        message:
          `只读状态：phase=${String(summary.phase)}，运行中 AI ${String(summary.runningAgents)} 个；` +
          `${shutdownLabel}；${pendingLabel}${resumeLabel}。本查询未触发重启。`,
      };
    },
  };

  ctx.effect(() => ctx.tools.register(allWaitTool), `dsh-restart: ${TOOL_NAME_ALL_WAIT} tool`);
  ctx.effect(() => ctx.tools.register(rollCallTool), `dsh-restart: ${TOOL_NAME_ROLL_CALL} tool`);
  ctx.effect(() => ctx.tools.register(forceTool), `dsh-restart: ${TOOL_NAME_FORCE} tool`);
  ctx.effect(() => ctx.tools.register(safeguardTool), `dsh-restart: ${TOOL_NAME_SAFEGUARD} tool`);
  ctx.effect(() => ctx.tools.register(statusTool), `dsh-restart: ${TOOL_NAME_STATUS} tool`);
  api.log(
    'registered restart tools: ' +
      [TOOL_NAME_ALL_WAIT, TOOL_NAME_ROLL_CALL, TOOL_NAME_FORCE, TOOL_NAME_SAFEGUARD, TOOL_NAME_STATUS].join(', '),
  );

  /* -------------------------------------------------------------- skill ---- */

  ctx.effect(
    () =>
      ctx.skills.register({
        name: 'restart-dsh',
        description:
          'Restart DSH in one of three modes: all-wait (wait for running AIs), roll-call safe (broadcast and wait for every active AI to enter safe state), or force dangerous (approval first, then the force safeguard; immediate interruption).',
        whenToUse:
          'Use when the user asks to restart DSH, when a change reported restart-required, or when the user agrees a restart is the fix. Prefer all-wait; use roll-call only when faster convergence is worth interrupting peers; avoid force dangerous unless there is an explicit extra requirement.',
        source: 'runtime',
        content: SKILL_CONTENT,
      }),
    'dsh-restart: restart skill',
  );
  api.log('registered restart-dsh skill');
}
