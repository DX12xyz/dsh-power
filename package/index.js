/**
 * @local/dsh-power — Host half (v1.8.2).
 *
 * Adds five AI tools (see host/ai.js) plus the mode-aware restart skill:
 *  - 阻塞等待 `restart_dsh_blocking_wait_safe`: wait for every other running AI to
 *    finish its current output, then restart (the original graceful behavior);
 *  - 点名 `restart_dsh_roll_call_caution`: broadcast a steering interjection to
 *    running AIs outside safe state, asking them to stop their own subagents/tool
 *    calls and enter safe state, then wait until every active AI is in safe state
 *    and restart;
 *  - 强制 `restart_dsh_force_dangerous`: request approval first, then check and
 *    consume the safeguard, then interrupt every running AI outside safe state
 *    immediately and restart, then notify every interrupted AI and every restart
 *    initiator of the force restart;
 *  - 强制保险 `restart_dsh_force_safeguard`: arms the force tool for exactly the
 *    next tool call;
 *  - 只读状态 `restart_dsh_status`: a bounded, read-only status projection that
 *    never restarts, never asks for approval and never mutates state.
 * The Host also serves authenticated `/api/dsh-restart/*` routes consumed by the
 * Client half and authenticated self-test routes (`testMode` only).
 *
 * The human sidebar menu (client half) offers three modes: 等待 (all-wait),
 * 中断 (roll-call) and 强制 (force dangerous). Human force restarts are confirmed
 * by a 5-second hold, so they do not need the AI safeguard tool.
 *
 * Mode merge order for one pending restart: dangerous > coordinated > safe. A
 * requester that used all-wait or roll-call belongs to safe state, and so does the
 * initiator of the force restart that actually runs; only AIs interrupted by a
 * force restart (without having entered safe state beforehand) stay outside safe
 * state. The durable intent records the mode, the safe state members, the
 * interrupted sessions (force mode only) and the broadcast statistics; the next
 * boot delivers the matching completion or interruption notices.
 *
 * Safe/coordinated restarts never kill a running turn: the Host waits for the
 * mode's condition, flushes sessions, writes a durable intent file, writes the
 * relaunch spec, spawns the detached relaunch helper and waits for its readiness
 * marker, then asks the launcher for a graceful exit. Force mode skips the wait,
 * records which non-safe-state AIs are interrupted, flushes briefly, and restarts
 * immediately. Human shutdown uses the same modes but never relaunches; its
 * safe/coordinated wait is capped by `shutdownMaxWaitMs` (0 = unlimited), after
 * which remaining running AIs are cancelled and the exit continues after
 * `shutdownGraceMs`. On the next boot the same plugin reads the intent, resumes the
 * affected Sessions, restores each Session's recorded Agent preset and wakes each
 * AI with the mode-specific notice.
 *
 * Tool-call timeout check: none of these tools declares `timeoutMs`, so
 * @deepseek-ai/dsh-tool-call-timeout-policy never arms a deadline for their
 * held-open calls.
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Module 2: the AI-facing tools + skill.
import { registerAiRestart } from './host/ai.js';
// Module 3: the human entry (web client button; the Desktop build shares the web UI).
import { registerHumanEntry } from './host/human.js';
// Module 4: the `resumableToolCalls` service other plugins use to hold a tool
// call across a restart instead of receiving a synthetic unknown outcome.
import {
  RESUME_HOLDS_VERSION,
  RESUME_SERVICE_NAME,
  createResumableToolCalls,
} from './host/resumable.js';
// Module 5: how one held call's result reaches a Session log — the live append
// channel owned by the resumed Agent, or a persisted-only write handle.
import { createSessionResultWriter } from './host/session-writer.js';
// Shared module identities and mode labels.
import {
  HUMAN_MODE_LABELS,
  MODE_COORDINATED,
  MODE_DANGEROUS,
  MODE_LABELS,
  MODE_SAFE,
  PLUGIN_VERSION,
  SAFE_STATE_DEFINITION,
  TOOL_NAME_ALL_WAIT,
} from './host/constants.js';

/** Public package version (kept in sync with package.json and host/constants.js). */
export { PLUGIN_VERSION };

const PLUGIN_ID = '@local/dsh-power';
const RESTART_DIR_NAME = '.dsh-restart';
const STATE_FILE = 'state.json';
const INTENT_FILE = 'restart-intent.json';
const SPEC_FILE = 'relaunch-spec.json';
const CHECKPOINT_FILE = 'checkpoint.json';
/** Durable registry of tool calls another plugin holds across a restart. */
const RESUME_HOLDS_FILE = 'resumable-holds.json';
/**
 * Bounded window the boot settlement keeps retrying a provisional result the
 * resume path's write handle refused (see `settleAtBoot` in `host/resumable.js`).
 * The provisional write starts immediately — waiting first loses the race with
 * the resume, which appends its synthetic `TOOL_OUTCOME_UNKNOWN` closers within
 * milliseconds — so this is a retry budget, not a pre-write delay. Kept below
 * `bootDeliveryDelayMs` so the post-restart delivery still starts on time.
 */
const DEFAULT_HOLD_SETTLE_GRACE_MS = 1200;
const RELAUNCH_READY_FILE = 'relaunch-ready.json';
const LOG_FILE = 'restart.log';
const RELAUNCH_LOG_FILE = 'relaunch.log';
const DESKTOP_RELAUNCH_LOG_FILE = 'relaunch-desktop.log';
const DESKTOP_QUIT_LOG_FILE = 'quit-desktop.log';
/** Force-mode artifacts owned by the detached reaper (hotfix.4). */
const FORCE_REAPER_SPEC_FILE = 'force-reaper-spec.json';
const FORCE_REAPER_LOCK_FILE = 'force-relaunch.lock';
/** Single-file status snapshot and force dry-run record (hotfix.5). */
const FORCE_STATUS_FILE = 'status.json';
const FORCE_DRY_RUN_FILE = 'force-dry-run.json';
const DEFAULT_DESKTOP_RELAUNCH_TIMEOUT_MS = 25000;
const RELAUNCHER_PATH = fileURLToPath(new URL('./relauncher.mjs', import.meta.url));
const DESKTOP_RELAUNCHER_PATH = fileURLToPath(new URL('./relauncher-desktop.mjs', import.meta.url));
const DESKTOP_QUIT_HELPER_PATH = fileURLToPath(new URL('./quit-desktop.mjs', import.meta.url));
const FORCE_REAPER_PATH = fileURLToPath(new URL('./force-reaper.mjs', import.meta.url));
const API_PREFIX = '/api/dsh-restart';
const DEFAULT_GRACE_MS = 750;
const DEFAULT_POLL_MS = 150;
const DEFAULT_BOOT_DELIVERY_DELAY_MS = 1800;
const DEFAULT_FLUSH_TIMEOUT_MS = 3000;
const DEFAULT_EXIT_WATCHDOG_MS = 5000;
const DEFAULT_SHUTDOWN_GRACE_MS = 3000;
const DEFAULT_SHUTDOWN_MAX_WAIT_MS = 300000;
const DEFAULT_UNLOCK_TTL_MS = 300000;
const DEFAULT_COORDINATED_RESEND_MS = 20000;
const DEFAULT_COORDINATED_MAX_RESENDS = 5;
/** How long coordinated mode waits for every active AI to enter safe state. */
const DEFAULT_ROLL_CALL_WAIT_MS = 120000;
const DEFAULT_DANGEROUS_FLUSH_TIMEOUT_MS = 1500;
/** How long the detached reaper lets the Host exit gracefully before force-killing it. */
const DEFAULT_FORCE_KILL_AFTER_MS = 2500;
/** Bounded force-mode flush budget: `min(dangerousFlushTimeoutMs, this)`. */
const FORCE_FLUSH_TIMEOUT_MS = 800;
/** Delay before the self-SIGKILL so the last log line and the flush can land. */
const FORCE_EXIT_GRACE_MS = 250;
/**
 * Upper bound on the optional escape pod's shutdown call before DSH exits.
 * The pod is another plugin's process tree: waiting on it forever would turn a
 * polite linkage into a shutdown hang, so the exit always proceeds.
 */
const ESCAPE_POD_SHUTDOWN_TIMEOUT_MS = 5000;
const WAIT_TIMEOUT_MS = 120000;
const RELAUNCH_DELAY_MS = 500;
const SESSION_IDLE_TIMEOUT_MS = 30000;
/** `restart.log` is rotated to `restart.log.1` once it grows past this size. */
export const LOG_ROTATE_BYTES = 1024 * 1024;
/** The status tool reports at most this many agents; the rest are summarized. */
export const STATUS_AGENT_LIMIT = 50;
/** Bounded restart checkpoint schema version. */
export const CHECKPOINT_VERSION = 1;
/** Hard caps so a checkpoint never becomes a second session log. */
export const CHECKPOINT_LIMITS = Object.freeze({
  sessions: 200,
  openToolCallsPerSession: 20,
  openToolCallsTotal: 200,
  jobsPerSession: 10,
  previewChars: 400,
});
const RESTART_TOOL_PREFIX = 'restart_dsh_';
const SENSITIVE_ARG_KEY = /(?:key|token|secret|password|passwd|authorization|cookie|credential)/i;

/**
 * Numeric config bounds: finite non-negative values are clamped into the range,
 * anything else (missing, non-number, NaN, Infinity, negative) falls back to the
 * default. A bound of `0` means "unlimited" where the field documents it.
 */
export const CONFIG_BOUNDS = Object.freeze({
  pollMs: Object.freeze({ fallback: DEFAULT_POLL_MS, min: 50, max: 60000 }),
  graceMs: Object.freeze({ fallback: DEFAULT_GRACE_MS, min: 0, max: 10000 }),
  bootDeliveryDelayMs: Object.freeze({ fallback: DEFAULT_BOOT_DELIVERY_DELAY_MS, min: 0, max: 60000 }),
  flushTimeoutMs: Object.freeze({ fallback: DEFAULT_FLUSH_TIMEOUT_MS, min: 100, max: 30000 }),
  dangerousFlushTimeoutMs: Object.freeze({ fallback: DEFAULT_DANGEROUS_FLUSH_TIMEOUT_MS, min: 100, max: 30000 }),
  forceKillAfterMs: Object.freeze({ fallback: DEFAULT_FORCE_KILL_AFTER_MS, min: 500, max: 30000 }),
  exitWatchdogMs: Object.freeze({ fallback: DEFAULT_EXIT_WATCHDOG_MS, min: 500, max: 30000 }),
  shutdownGraceMs: Object.freeze({ fallback: DEFAULT_SHUTDOWN_GRACE_MS, min: 0, max: 60000 }),
  shutdownMaxWaitMs: Object.freeze({ fallback: DEFAULT_SHUTDOWN_MAX_WAIT_MS, min: 5000, max: 3600000 }),
  unlockTtlMs: Object.freeze({ fallback: DEFAULT_UNLOCK_TTL_MS, min: 1000, max: 86400000 }),
  coordinatedResendMs: Object.freeze({ fallback: DEFAULT_COORDINATED_RESEND_MS, min: 1000, max: 600000 }),
  coordinatedMaxResends: Object.freeze({ fallback: DEFAULT_COORDINATED_MAX_RESENDS, min: 0, max: 20 }),
  /** `0` is the documented "wait forever" for a roll-call restart. */
  rollCallWaitMs: Object.freeze({ fallback: DEFAULT_ROLL_CALL_WAIT_MS, min: 0, max: 3600000 }),
  desktopRelaunchTimeoutMs: Object.freeze({ fallback: DEFAULT_DESKTOP_RELAUNCH_TIMEOUT_MS, min: 5000, max: 120000 }),
});

/** Host services this feature cannot work without. Web-only pieces are optional. */
export const inject = ['tools', 'agents', 'sessions', 'skills'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/* --------------------------------------------------- restart checkpoint -- */

function formatCheckpointTime(timestamp) {
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return String(timestamp);
  }
}

function redactJsonValue(value) {
  if (Array.isArray(value)) return value.map(redactJsonValue);
  if (value !== null && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_ARG_KEY.test(key) ? '[redacted]' : redactJsonValue(item);
    }
    return output;
  }
  return value;
}

/** Stable argument fingerprint; used only for diagnostics, never for replay here. */
export function sha256Hex(value) {
  try {
    return createHash('sha256').update(String(value)).digest('hex');
  } catch {
    return '';
  }
}

/** JSON-level redaction plus a bounded preview; never keep the full arguments. */
export function redactArgsPreview(raw, maxChars = CHECKPOINT_LIMITS.previewChars) {
  const limit =
    typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars > 0
      ? Math.floor(maxChars)
      : CHECKPOINT_LIMITS.previewChars;
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
  let preview = text;
  try {
    preview = JSON.stringify(redactJsonValue(JSON.parse(text)));
  } catch {
    preview = text.replace(
      /((?:key|token|secret|password|passwd|authorization|cookie|credential)[A-Za-z0-9_-]*\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1[redacted]',
    );
  }
  return preview.length > limit ? `${preview.slice(0, Math.max(1, limit - 1))}…` : preview;
}

/**
 * Tool calls opened in the current turn without a matching `tool/result`.
 * Restart tool calls are excluded: the platform resume repair closes those, and
 * reporting them as unknown business calls would be noise. Calls held through
 * `resumableToolCalls` are excluded for the same reason: their owner answers
 * them on the next boot, so they are not "unknown business calls".
 * @param {readonly object[]} events - session events in ascending seq order.
 * @param {Set<string>} [heldCallIds] - call ids declared resumable.
 */
export function collectOpenToolCalls(events, heldCallIds) {
  if (!Array.isArray(events)) return [];
  let lastTurnEnd = -1;
  for (const event of events) {
    if (event?.type === 'turn/end' && typeof event.seq === 'number' && event.seq > lastTurnEnd) lastTurnEnd = event.seq;
  }
  const open = new Map();
  for (const event of events) {
    if (event === null || typeof event !== 'object' || typeof event.seq !== 'number' || event.seq <= lastTurnEnd) continue;
    if (event.type === 'tool/call') {
      const callId = event.data?.callId === undefined ? undefined : String(event.data.callId);
      const name = typeof event.data?.name === 'string' ? event.data.name : '';
      if (callId === undefined || callId.length === 0 || name.startsWith(RESTART_TOOL_PREFIX)) continue;
      if (heldCallIds instanceof Set && heldCallIds.has(callId)) continue;
      open.set(callId, {
        callId,
        name,
        arguments: typeof event.data?.arguments === 'string' ? event.data.arguments : '',
        seq: event.seq,
      });
    } else if (event.type === 'tool/result') {
      const callId =
        event.data?.message?.toolCallId === undefined ? undefined : String(event.data.message.toolCallId);
      if (callId !== undefined) open.delete(callId);
    }
  }
  return Array.from(open.values());
}

/**
 * Bounded checkpoint model. The caller supplies the live sessions, their events,
 * agent status and job views; this function only trims/redacts so it can be
 * tested without a Host context.
 * @param {object} [input] - checkpoint source.
 * @param {Set<string>|string[]} [input.heldCallIds] - call ids declared resumable.
 * @param {Map<string, string[]>|Record<string, string[]>} [input.heldBySession] -
 *   resumable-held call ids grouped by session.
 */
export function buildCheckpoint(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const heldCallIds =
    source.heldCallIds instanceof Set
      ? source.heldCallIds
      : new Set(Array.isArray(source.heldCallIds) ? source.heldCallIds.map((id) => String(id)) : []);
  // Accept both the Map the resumable registry returns and a JSON round-tripped
  // plain object (sessionId → call ids).
  const heldBySession = new Map();
  if (source.heldBySession instanceof Map) {
    for (const [sessionId, callIds] of source.heldBySession) {
      if (typeof sessionId === 'string' && sessionId.length > 0) heldBySession.set(sessionId, callIds);
    }
  } else if (source.heldBySession !== null && typeof source.heldBySession === 'object') {
    for (const [sessionId, callIds] of Object.entries(source.heldBySession)) {
      if (sessionId.length > 0) heldBySession.set(sessionId, callIds);
    }
  }
  const rawSessions = Array.isArray(source.sessions) ? [...source.sessions] : [];
  rawSessions.sort((left, right) => {
    const running = Number(right?.agentStatus === 'running') - Number(left?.agentStatus === 'running');
    if (running !== 0) return running;
    return (right?.lastSeq ?? 0) - (left?.lastSeq ?? 0);
  });
  const sessions = [];
  let totalCalls = 0;
  let truncated = false;
  for (const session of rawSessions) {
    if (sessions.length >= CHECKPOINT_LIMITS.sessions) {
      truncated = true;
      break;
    }
    const sessionId = typeof session?.sessionId === 'string' && session.sessionId.length > 0 ? session.sessionId : undefined;
    if (sessionId === undefined) continue;
    const calls = [];
    for (const call of collectOpenToolCalls(session.events, heldCallIds)) {
      if (calls.length >= CHECKPOINT_LIMITS.openToolCallsPerSession || totalCalls >= CHECKPOINT_LIMITS.openToolCallsTotal) {
        truncated = true;
        break;
      }
      calls.push({
        callId: call.callId.slice(0, 160),
        name: call.name.slice(0, 120),
        argsHash: sha256Hex(call.arguments),
        argsPreview: redactArgsPreview(call.arguments),
        seq: call.seq,
      });
      totalCalls += 1;
    }
    const jobs = [];
    for (const job of Array.isArray(session?.jobs) ? session.jobs : []) {
      if (jobs.length >= CHECKPOINT_LIMITS.jobsPerSession) {
        truncated = true;
        break;
      }
      jobs.push({
        jobId: typeof job?.jobId === 'string' ? job.jobId.slice(0, 160) : '',
        kind: typeof job?.kind === 'string' ? job.kind.slice(0, 40) : '',
        label: typeof job?.label === 'string' ? job.label.slice(0, 200) : '',
        status: typeof job?.status === 'string' ? job.status.slice(0, 40) : '',
        startedAt: typeof job?.startedAt === 'number' ? job.startedAt : null,
        outputTotal: typeof job?.outputTotal === 'number' ? job.outputTotal : 0,
        spillPaths: Array.isArray(job?.spillPaths)
          ? job.spillPaths
              .slice(0, 3)
              .filter((path) => typeof path === 'string')
              .map((path) => path.slice(0, 300))
          : [],
      });
    }
    // Calls another plugin holds through resumableToolCalls are not unknown:
    // their owner answers them after the restart. Keep their ids per session so
    // the resume report can say "resumable" instead of "pending/unknown".
    const heldCalls = [];
    const heldSource = heldBySession.get(sessionId);
    const heldList = heldSource instanceof Set ? [...heldSource] : Array.isArray(heldSource) ? heldSource : [];
    const seenHeld = new Set();
    for (const rawCallId of heldList) {
      const callId =
        typeof rawCallId === 'string' ? rawCallId : rawCallId === undefined || rawCallId === null ? '' : String(rawCallId);
      if (callId.length === 0) continue;
      const boundedCallId = callId.slice(0, 160);
      if (seenHeld.has(boundedCallId)) continue;
      seenHeld.add(boundedCallId);
      if (heldCalls.length >= CHECKPOINT_LIMITS.openToolCallsPerSession) {
        truncated = true;
        continue;
      }
      heldCalls.push(boundedCallId);
    }
    sessions.push({
      sessionId: sessionId.slice(0, 160),
      agentStatus: typeof session?.agentStatus === 'string' ? session.agentStatus : 'unknown',
      agentPreset: typeof session?.agentPreset === 'string' ? session.agentPreset.slice(0, 120) : null,
      lastSeq: typeof session?.lastSeq === 'number' ? session.lastSeq : null,
      openToolCalls: calls,
      heldToolCalls: heldCalls,
      jobs,
    });
  }
  const jobCount = sessions.reduce((count, session) => count + session.jobs.length, 0);
  const heldCount = sessions.reduce((count, session) => count + session.heldToolCalls.length, 0);
  return {
    version: CHECKPOINT_VERSION,
    requestId: typeof source.requestId === 'string' ? source.requestId : null,
    mode: typeof source.mode === 'string' ? source.mode : null,
    at: typeof source.at === 'number' ? source.at : Date.now(),
    bootIdBefore: typeof source.bootIdBefore === 'string' ? source.bootIdBefore : null,
    platform: typeof source.platform === 'string' ? source.platform : 'web',
    sessions,
    totals: {
      sessions: sessions.length,
      runningSessions: sessions.filter((session) => session.agentStatus === 'running').length,
      openToolCalls: totalCalls,
      heldToolCalls: heldCount,
      jobs: jobCount,
      truncated,
    },
  };
}

/** Per-session restore status derived from a checkpoint and the live session set. */
export function buildResumeReport(checkpoint, liveSessionIds) {
  const live =
    liveSessionIds instanceof Set
      ? liveSessionIds
      : new Set(Array.isArray(liveSessionIds) ? liveSessionIds.map((id) => String(id)) : []);
  const sessions = [];
  for (const item of Array.isArray(checkpoint?.sessions) ? checkpoint.sessions : []) {
    if (item === null || typeof item !== 'object' || typeof item.sessionId !== 'string') continue;
    const openToolCalls = Array.isArray(item.openToolCalls) ? item.openToolCalls.length : 0;
    const jobs = Array.isArray(item.jobs) ? item.jobs.length : 0;
    const heldToolCalls = Array.isArray(item.heldToolCalls) ? item.heldToolCalls.length : 0;
    const restored = live.has(item.sessionId);
    sessions.push({
      sessionId: item.sessionId,
      agentPreset: typeof item.agentPreset === 'string' ? item.agentPreset : null,
      restored,
      openToolCalls,
      heldToolCalls,
      jobs,
      needsReport: openToolCalls > 0 || jobs > 0 || heldToolCalls > 0 || !restored,
      delivered: false,
      failed: false,
      pending: false,
    });
  }
  return {
    checkpointAt: typeof checkpoint?.at === 'number' ? checkpoint.at : null,
    sessions,
    totals: summarizeResumeReport({ sessions }),
  };
}

export function summarizeResumeReport(report) {
  const sessions = Array.isArray(report?.sessions) ? report.sessions : [];
  const sum = (pick) => sessions.reduce((count, session) => count + (pick(session) ? 1 : 0), 0);
  return {
    checkpointAt: typeof report?.checkpointAt === 'number' ? report.checkpointAt : null,
    sessions: sessions.length,
    resumed: sum((session) => session.restored === true),
    missing: sum((session) => session.restored !== true),
    presetFailed: sum((session) => session.presetStatus === 'failed'),
    openToolCalls: sessions.reduce((count, session) => count + (session.openToolCalls ?? 0), 0),
    heldToolCalls: sessions.reduce((count, session) => count + (session.heldToolCalls ?? 0), 0),
    jobs: sessions.reduce((count, session) => count + (session.jobs ?? 0), 0),
    delivered: sum((session) => session.delivered === true),
    failed: sum((session) => session.failed === true),
    pending: sum((session) => session.pending === true),
  };
}

/**
 * Model-facing per-session restore report. It never claims a tool was restored:
 * in-flight calls and background jobs are explicitly reported as unknown/lost.
 */
export function renderResumeReportText(checkpoint, sessionId, options = {}) {
  const item = Array.isArray(checkpoint?.sessions)
    ? checkpoint.sessions.find((session) => session?.sessionId === sessionId)
    : undefined;
  if (item === undefined) return '';
  const restored = options.restored !== false;
  const calls = Array.isArray(item.openToolCalls) ? item.openToolCalls : [];
  const jobs = Array.isArray(item.jobs) ? item.jobs : [];
  const held = Array.isArray(item.heldToolCalls) ? item.heldToolCalls.length : 0;
  const lines = [
    '<dsh_restart_resume_report>',
    '【重启恢复报告】',
    `- 检查点时间：${formatCheckpointTime(checkpoint?.at)}`,
    `- 会话恢复：${restored ? '成功（会话已恢复）' : '未恢复/未找到；请用户重新打开该会话后再继续'}`,
  ];
  const presetRestore = options.presetRestore;
  if (presetRestore !== undefined && presetRestore !== null) {
    if (presetRestore.status === 'failed') {
      lines.push(
        `- Agent 预设：恢复失败（${String(presetRestore.agentPreset ?? '未知')}；${String(presetRestore.error ?? '未知原因')}）`,
      );
    } else if (typeof presetRestore.agentPreset === 'string' && presetRestore.agentPreset.length > 0) {
      lines.push(`- Agent 预设：${presetRestore.agentPreset}（${String(presetRestore.status ?? 'restored')}）`);
    }
  }
  if (calls.length > 0) {
    lines.push(
      `- 未决工具调用：${String(calls.length)} 个（重启时结果未知，平台可能已标记为中断；请核对后重跑或继续，不要假设已完成）`,
    );
    for (const call of calls.slice(0, 5)) {
      lines.push(`  - ${String(call?.name ?? 'unknown')}（callId ${String(call?.callId ?? '?')}）`);
    }
    if (calls.length > 5) lines.push(`  - …另有 ${String(calls.length - 5)} 个未列出`);
  }
  if (jobs.length > 0) {
    lines.push(
      `- 后台任务：${String(jobs.length)} 个（重启后无法重新接回；请重新执行或检查其输出文件，不要假设仍在运行）`,
    );
    for (const job of jobs.slice(0, 5)) {
      lines.push(`  - ${String(job?.label || job?.jobId || 'unknown')}（${String(job?.status ?? 'unknown')}）`);
    }
    if (jobs.length > 5) lines.push(`  - …另有 ${String(jobs.length - 5)} 个未列出`);
  }
  if (held > 0) {
    lines.push(
      `- 可恢复调用：${String(held)} 个已由 resumableToolCalls 接管（命令仍在逃生舱中运行）；结果会在结算后自动写回本会话，请不要重跑。`,
    );
  }
  if (calls.length === 0 && jobs.length === 0 && held === 0) {
    lines.push('- 本会话没有未决工具调用或后台任务。');
  }
  if (checkpoint?.totals?.truncated === true) {
    lines.push('- 检查点已截断；未列出的部分没有恢复信息，请以会话中的实际工具结果为准。');
  }
  lines.push('</dsh_restart_resume_report>');
  return lines.join('\n');
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function saveJsonFile(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    try {
      unlinkSync(path);
    } catch {
      /* first write */
    }
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      writeFileSync(path, text);
      return true;
    } catch {
      return false;
    }
  }
}

function removeFile(path) {
  try {
    unlinkSync(path);
  } catch {
    /* missing is fine */
  }
}

/**
 * Rotate `restart.log` to a single `restart.log.1` backup when it exceeds
 * `maxBytes`. Best effort: a rotation failure is ignored (the log keeps
 * growing rather than losing diagnostics).
 * @param {string} logPath - log file to inspect.
 * @param {number} [maxBytes] - rotation threshold (default 1 MiB).
 * @returns {boolean} whether the file was rotated by this call.
 */
export function rotateLogIfNeeded(logPath, maxBytes = LOG_ROTATE_BYTES) {
  try {
    if (typeof logPath !== 'string' || logPath.length === 0) return false;
    const limit = typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : LOG_ROTATE_BYTES;
    const size = statSync(logPath).size;
    if (!(size > limit)) return false;
    const backup = `${logPath}.1`;
    // Windows cannot rename onto an existing target: drop the old backup first.
    removeFile(backup);
    renameSync(logPath, backup);
    return true;
  } catch {
    return false;
  }
}

function clampNumber(value, fallback, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** `shutdownMaxWaitMs` treats `0` as "wait forever"; other values clamp to [5s, 1h]. */
function clampShutdownMaxWait(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_SHUTDOWN_MAX_WAIT_MS;
  if (value === 0) return 0;
  return clampNumber(value, DEFAULT_SHUTDOWN_MAX_WAIT_MS, 5000, 3600000);
}

/**
 * Whether the roll-call wait for this pending record has expired.
 * `null` deadline (rollCallWaitMs=0) means "wait forever".
 * @param {unknown} record - pending restart record (or any object with the field).
 * @param {number} [now] - current time in ms; injectable for tests.
 * @returns true when a numeric deadline exists and has been reached.
 */
export function rollCallExpired(record, now = Date.now()) {
  return (
    record !== null &&
    typeof record === 'object' &&
    typeof record.coordinatedDeadlineAt === 'number' &&
    now >= record.coordinatedDeadlineAt
  );
}

/**
 * Normalize the row config. Every numeric knob is clamped into its documented
 * range; an invalid value (missing, non-number, NaN/Infinity, negative) falls
 * back to the default. `shutdownMaxWaitMs: 0` means "unlimited" and
 * `rollCallWaitMs: 0` means "wait forever" for a roll-call restart.
 * Non-numeric switches, `home`, and `launch` keep their original semantics.
 * @param {unknown} config - raw row config.
 * @returns normalized config.
 */
export function normalizeConfig(config) {
  const c = config !== null && typeof config === 'object' ? config : {};
  const bounds = CONFIG_BOUNDS;
  const number = (value, spec) => clampNumber(value, spec.fallback, spec.min, spec.max);
  return {
    graceMs: number(c.graceMs, bounds.graceMs),
    pollMs: number(c.pollMs, bounds.pollMs),
    bootDeliveryDelayMs: number(c.bootDeliveryDelayMs, bounds.bootDeliveryDelayMs),
    flushTimeoutMs: number(c.flushTimeoutMs, bounds.flushTimeoutMs),
    exitWatchdogMs: number(c.exitWatchdogMs, bounds.exitWatchdogMs),
    shutdownGraceMs: number(c.shutdownGraceMs, bounds.shutdownGraceMs),
    shutdownMaxWaitMs: clampShutdownMaxWait(c.shutdownMaxWaitMs),
    unlockTtlMs: number(c.unlockTtlMs, bounds.unlockTtlMs),
    coordinatedResendMs: number(c.coordinatedResendMs, bounds.coordinatedResendMs),
    coordinatedMaxResends: number(c.coordinatedMaxResends, bounds.coordinatedMaxResends),
    rollCallWaitMs: number(c.rollCallWaitMs, bounds.rollCallWaitMs),
    dangerousFlushTimeoutMs: number(c.dangerousFlushTimeoutMs, bounds.dangerousFlushTimeoutMs),
    forceKillAfterMs: number(c.forceKillAfterMs, bounds.forceKillAfterMs),
    dangerousNotifyInterrupted: c.dangerousNotifyInterrupted !== false,
    coordinatedNotifyTimedOut: c.coordinatedNotifyTimedOut !== false,
    openBrowserOnRelaunch: c.openBrowserOnRelaunch === true,
    desktopRelaunchTimeoutMs: number(c.desktopRelaunchTimeoutMs, bounds.desktopRelaunchTimeoutMs),
    // Rehearse the force path without creating a pending restart, arming the
    // reaper or killing anything (hotfix.5 troubleshooting switch).
    forceDryRun: c.forceDryRun === true,
    testMode: c.testMode === true,
    home: typeof c.home === 'string' && c.home.length > 0 ? c.home : undefined,
    launch: c.launch !== null && typeof c.launch === 'object' ? c.launch : undefined,
  };
}

/** Runtime settings live beside the restart state, never in the profile patch. */
export const RUNTIME_SETTINGS_FILE = 'settings.json';

/**
 * Validate one runtime `rollCallWaitMs` value.
 * `0` keeps the documented "wait forever" meaning; everything else is the
 * same 1s..1h range the Config schema documents.
 * @param {unknown} value - candidate from a settings request or the durable file.
 * @returns {number | undefined} the accepted value, or undefined when invalid.
 */
export function normalizeRuntimeRollCallWaitMs(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined;
  if (value === 0) return 0;
  if (value < 1000 || value > 3600000) return undefined;
  return value;
}

/**
 * Read the runtime settings file. A missing or corrupt file means "no
 * override": the profile patch value stays in effect.
 * @param {string} stateDir - restart state directory.
 * @returns {{ rollCallWaitMs?: number }} accepted settings.
 */
export function readRuntimeSettings(stateDir) {
  const raw = readJsonFile(join(stateDir, RUNTIME_SETTINGS_FILE));
  if (raw === null || typeof raw !== 'object') return {};
  const rollCallWaitMs = normalizeRuntimeRollCallWaitMs(raw.rollCallWaitMs);
  return rollCallWaitMs === undefined ? {} : { rollCallWaitMs };
}

/**
 * Persist one runtime setting atomically. The caller applies it in memory too,
 * so a save takes effect immediately without touching `cordis.patch.yml`.
 * @param {string} stateDir - restart state directory.
 * @param {{ rollCallWaitMs?: number }} settings - validated settings.
 * @returns {boolean} whether the file was written.
 */
export function writeRuntimeSettings(stateDir, settings) {
  const current = readRuntimeSettings(stateDir);
  const next = { ...current };
  if (settings.rollCallWaitMs !== undefined) {
    const value = normalizeRuntimeRollCallWaitMs(settings.rollCallWaitMs);
    if (value === undefined) return false;
    next.rollCallWaitMs = value;
  }
  return saveJsonFile(join(stateDir, RUNTIME_SETTINGS_FILE), next);
}

/**
 * Whether a runtime override was written after the profile patch was last
 * edited. When the user edits the patch afterwards, the patch wins: the
 * runtime file only has to override the value that was current when it was
 * saved, never a later hand edit.
 * @param {string} stateDir - restart state directory.
 * @param {string | undefined} patchPath - profile patch file, when known.
 * @returns {number | undefined} the effective runtime override.
 */
export function runtimeRollCallWaitOverride(stateDir, patchPath) {
  const settings = readRuntimeSettings(stateDir);
  if (settings.rollCallWaitMs === undefined) return undefined;
  if (typeof patchPath === 'string' && patchPath.length > 0) {
    try {
      if (statSync(patchPath).mtimeMs > statSync(join(stateDir, RUNTIME_SETTINGS_FILE)).mtimeMs) {
        return undefined;
      }
    } catch {
      /* missing patch or settings file: keep the runtime value */
    }
  }
  return settings.rollCallWaitMs;
}

/* ---------------------------------------------------- status projection --- */
const boundedText = (value, maxLength) =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, maxLength) : undefined;

const statusCount = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;

const statusTimestamp = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** At most {@link STATUS_AGENT_LIMIT} session ids, each bounded in length. */
function statusSessionIds(value) {
  if (!Array.isArray(value)) return [];
  const ids = [];
  for (const item of value) {
    if (ids.length >= STATUS_AGENT_LIMIT) break;
    const id = boundedText(item, 160);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

function projectPendingStatus(pending) {
  if (pending === null || typeof pending !== 'object') return null;
  const deadline = statusTimestamp(pending.coordinatedDeadlineAt);
  return {
    requestId: boundedText(pending.requestId, 120) ?? null,
    phase: boundedText(pending.phase, 32) ?? null,
    mode: boundedText(pending.mode, 32) ?? null,
    modeLabel: boundedText(pending.modeLabel, 32) ?? null,
    requestedAt: statusTimestamp(pending.requestedAt),
    waitingMs: statusTimestamp(pending.waitingMs),
    // Roll-call deadline; null means "wait forever" (rollCallWaitMs=0).
    coordinatedDeadlineAt: deadline,
    waitingRemainingMs: deadline === null ? null : Math.max(0, deadline - Date.now()),
    requesters: statusCount(pending.requesters),
    safeStateCount: statusCount(pending.safeStateCount),
    waitingAgents: statusCount(pending.waitingAgents),
    waitingSessionIds: statusSessionIds(pending.waitingSessionIds),
    // Diagnostics only: whether the detached force reaper is armed for this record.
    forceReaperArmed: pending.forceReaperArmed === true,
    broadcast: {
      total: statusCount(pending.broadcast?.total),
      sessions: statusCount(pending.broadcast?.sessions),
    },
  };
}

function projectShutdownStatus(shutdown) {
  if (shutdown === null || typeof shutdown !== 'object') return null;
  return {
    mode: boundedText(shutdown.mode, 32) ?? null,
    modeLabel: boundedText(shutdown.modeLabel, 32) ?? null,
    phase: boundedText(shutdown.phase, 32) ?? null,
    requestedAt: statusTimestamp(shutdown.requestedAt),
    waitingAgents: statusCount(shutdown.waitingAgents),
    waitingSessionIds: statusSessionIds(shutdown.waitingSessionIds),
    // 0 means "wait forever" (no deadline).
    waitTimeoutMs: statusCount(shutdown.waitTimeoutMs),
    deadlineAt: statusTimestamp(shutdown.deadlineAt),
    timedOut: shutdown.timedOut === true,
    reason: boundedText(shutdown.reason, 200) ?? null,
  };
}

/** Count one delivery-result array without exposing its per-session details. */
function deliveryCounts(results) {
  const list = Array.isArray(results) ? results : [];
  let delivered = 0;
  let failed = 0;
  for (const item of list) {
    if (item?.status === 'delivered') delivered += 1;
    else failed += 1;
  }
  return { delivered, failed };
}

function projectLastRestartStatus(lastRestart) {
  if (lastRestart === null || typeof lastRestart !== 'object') return null;
  const safeState =
    lastRestart.safeState !== null && typeof lastRestart.safeState === 'object' ? lastRestart.safeState : undefined;
  const requesters = deliveryCounts(lastRestart.results);
  const interrupted = deliveryCounts(lastRestart.interruptedResults);
  return {
    requestId: boundedText(lastRestart.requestId, 120) ?? null,
    mode: boundedText(lastRestart.mode, 32) ?? null,
    modeLabel: boundedText(lastRestart.modeLabel, 32) ?? null,
    trigger: boundedText(lastRestart.trigger, 32) ?? null,
    dangerous: lastRestart.dangerous === true,
    uiRequested: lastRestart.uiRequested === true,
    requestedAt: statusTimestamp(lastRestart.requestedAt),
    completedAt: statusTimestamp(lastRestart.completedAt),
    tookMs: statusTimestamp(lastRestart.tookMs),
    requesterCount: Array.isArray(lastRestart.requesters) ? lastRestart.requesters.length : 0,
    interruptedCount: Array.isArray(lastRestart.interrupted) ? lastRestart.interrupted.length : 0,
    // Roll-call timeouts (hotfix.9): surfaced even after the intent file is gone.
    timedOutCount: Array.isArray(lastRestart.timedOutSessions)
      ? lastRestart.timedOutSessions.length
      : statusCount(safeState?.timedOutCount),
    timedOutSessionIds: statusSessionIds(lastRestart.timedOutSessions),
    deliveredRequesters: requesters.delivered,
    failedRequesters: requesters.failed,
    deliveredInterrupted: interrupted.delivered,
    failedInterrupted: interrupted.failed,
    checkpoint:
      lastRestart.checkpoint !== null && typeof lastRestart.checkpoint === 'object'
        ? {
            status: boundedText(lastRestart.checkpoint.status, 32) ?? 'unavailable',
            at: statusTimestamp(lastRestart.checkpoint.at),
            sessions: statusCount(lastRestart.checkpoint.totals?.sessions),
            openToolCalls: statusCount(lastRestart.checkpoint.totals?.openToolCalls),
            jobs: statusCount(lastRestart.checkpoint.totals?.jobs),
            truncated: lastRestart.checkpoint.totals?.truncated === true,
          }
        : null,
    resume:
      lastRestart.resume !== null && typeof lastRestart.resume === 'object'
        ? {
            checkpointAt: statusTimestamp(lastRestart.resume.checkpointAt),
            checkpointStatus: boundedText(lastRestart.resume.checkpointStatus, 32) ?? null,
            sessions: statusCount(lastRestart.resume.sessions),
            resumed: statusCount(lastRestart.resume.resumed),
            missing: statusCount(lastRestart.resume.missing),
            presetFailed: statusCount(lastRestart.resume.presetFailed),
            openToolCalls: statusCount(lastRestart.resume.openToolCalls),
            jobs: statusCount(lastRestart.resume.jobs),
            delivered: statusCount(lastRestart.resume.delivered),
            failed: statusCount(lastRestart.resume.failed),
            pending: statusCount(lastRestart.resume.pending),
          }
        : null,
    safeState: safeState === undefined
      ? null
      : {
          enteredSafeState: safeState.enteredSafeState === true,
          safeStateSessionCount: Array.isArray(safeState.safeStateSessionIds) ? safeState.safeStateSessionIds.length : 0,
          interruptedCount: statusCount(safeState.interruptedCount),
          timedOutCount: statusCount(safeState.timedOutCount),
          interruptedDelivered: statusCount(safeState.interruptedDelivered),
          interruptedFailed: statusCount(safeState.interruptedFailed),
          requesterDelivered: statusCount(safeState.requesterDelivered),
          requesterFailed: statusCount(safeState.requesterFailed),
        },
  };
}

/**
 * Bounded, read-only projection of the restart/shutdown status.
 *
 * The model-facing status tool must never receive session result details, file
 * paths, tokens, or an unbounded agent list, so this pure helper picks only the
 * documented summary fields and caps agents/waiting ids at
 * {@link STATUS_AGENT_LIMIT}. It is exported so the projection can be tested
 * without a Host context.
 * @param {unknown} input - raw status snapshot.
 * @returns the bounded status summary.
 */
export function projectStatusSummary(input) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const agentList = Array.isArray(source.agents) ? source.agents : [];
  const agents = [];
  for (const agent of agentList) {
    if (agents.length >= STATUS_AGENT_LIMIT) break;
    if (agent === null || typeof agent !== 'object') continue;
    agents.push({
      sessionId: boundedText(agent.sessionId, 160) ?? '',
      status: boundedText(agent.status, 32) ?? 'unknown',
    });
  }
  return {
    phase: boundedText(source.phase, 32) ?? 'idle',
    shuttingDown: source.shuttingDown === true,
    runningAgents: statusCount(source.runningAgents),
    agents,
    agentsTotal: agentList.length,
    agentsTruncated: agentList.length > agents.length,
    pending: projectPendingStatus(source.pending),
    shutdown: projectShutdownStatus(source.shutdown),
    lastRestart: projectLastRestartStatus(source.lastRestart),
    platform: boundedText(source.platform, 32) ?? 'web',
  };
}

/** One durable user-role message produced by this plugin (not a human turn). */
function restartMessage(text, kind = 'dsh-restart') {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind },
  };
}

/**
 * Whether this Host runs inside the DSH Desktop shell (Electron). The Desktop
 * app boots the Host as its own child process, which means a restart has to
 * relaunch the whole application instead of only the Host process.
 * @returns true when the Host was launched by `@deepseek-ai/dsh-desktop-host`.
 */
function detectDesktopShell() {
  try {
    return process.argv.some(
      (argument) => typeof argument === 'string' && argument.replace(/\\/gu, '/').includes('/dsh-desktop-host/'),
    );
  } catch {
    return false;
  }
}

/**
 * Host plugin body.
 * @param ctx - Host context.
 * @param config - optional row config (see cordis.patch.yml).
 */
export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const desktopShell = detectDesktopShell();
  const platform = desktopShell ? 'desktop' : 'web';
  /** Human fallback path named in restart failure/abort messages. */
  const humanRestartHint = desktopShell
    ? '侧边栏底部的「DSH电源」按钮（桌面版也可用），或退出并重新打开桌面应用'
    : '侧边栏底部的「DSH电源」按钮';

  const profileContext = safeGet(ctx, 'profileContext');
  const home =
    cfg.home ??
    (typeof profileContext?.home === 'string' && profileContext.home.length > 0
      ? profileContext.home
      : typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
        ? process.env.DSH_HOME
        : join(homedir(), '.dsh'));
  const stateDir = join(home, RESTART_DIR_NAME);
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch {
    /* the plugin still works without durable state, only notifications suffer */
  }
  // A setting saved from the Plugins page is persisted here, not written back
  // into the profile patch: editing `cordis.patch.yml` live makes the Loader
  // re-activate this row while agents are running, which is needless for a
  // scalar knob. The patch value stays the fallback until a later hand edit,
  // which wins because it is newer than the runtime file.
  const runtimeRollCallWaitMs = runtimeRollCallWaitOverride(stateDir, profileContext?.patchPath);
  if (runtimeRollCallWaitMs !== undefined) cfg.rollCallWaitMs = runtimeRollCallWaitMs;
  const statePath = join(stateDir, STATE_FILE);
  const intentPath = join(stateDir, INTENT_FILE);
  const specPath = join(stateDir, SPEC_FILE);
  const checkpointPath = join(stateDir, CHECKPOINT_FILE);
  const markerPath = join(stateDir, RELAUNCH_READY_FILE);
  const logPath = join(stateDir, LOG_FILE);
  const relaunchLogPath = join(stateDir, RELAUNCH_LOG_FILE);
  const desktopRelaunchLogPath = join(stateDir, DESKTOP_RELAUNCH_LOG_FILE);
  const desktopQuitLogPath = join(stateDir, DESKTOP_QUIT_LOG_FILE);
  const forceReaperSpecPath = join(stateDir, FORCE_REAPER_SPEC_FILE);
  const forceReaperLockPath = join(stateDir, FORCE_REAPER_LOCK_FILE);
  const statusSnapshotPath = join(stateDir, FORCE_STATUS_FILE);
  const forceDryRunPath = join(stateDir, FORCE_DRY_RUN_FILE);
  function log(message) {
    const line = `[${new Date().toISOString()}] [dsh-restart ${process.pid}] ${message}\n`;
    try {
      rotateLogIfNeeded(logPath);
      appendFileSync(logPath, line);
    } catch {
      /* diagnostics only */
    }
  }

  /* ------------------------------------------------------- boot reconcile -- */

  /**
   * Reconcile the force-mode artifacts left by the previous process (hotfix.5).
   *
   * A confirmed `relaunched`/`done` outcome is cleaned up; a failed (`error`) or
   * unconfirmed (`no-marker`) attempt is kept on disk for
   * `scripts/restart-cli.mjs` and raises `hold`, so no automatic behavior runs
   * before a human or the CLI has looked at it. Marker/lock leftovers that
   * belong to a normal relaunch keep the hotfix.4 cleanup behavior.
   */
  function reconcileForceArtifacts() {
    const now = Date.now();
    const rawSpec = readJsonFile(forceReaperSpecPath);
    const rawMarker = readJsonFile(markerPath);
    const rawLock = readJsonFile(forceReaperLockPath);
    const spec = rawSpec !== null && typeof rawSpec === 'object' ? rawSpec : undefined;
    const marker = rawMarker !== null && typeof rawMarker === 'object' ? rawMarker : undefined;
    const lock = rawLock !== null && typeof rawLock === 'object' ? rawLock : undefined;
    const lockOwnerPid = Number.isSafeInteger(lock?.pid) && lock.pid > 0 ? lock.pid : null;
    const lockOwnerAlive = lockOwnerPid === null ? null : pidAlive(lockOwnerPid);
    if (spec !== undefined) {
      const requestId = boundedText(spec.requestId, 120) ?? null;
      const markerMatches = marker !== undefined && marker.requestId === spec.requestId;
      // A reaper that is still alive has not written its marker yet: that is
      // "in progress", not a failure. Without this distinction a fast boot could
      // raise a false hold before the reaper finishes its 2500ms launch check.
      const inProgress = !markerMatches && lockOwnerAlive === true;
      const status = markerMatches
        ? boundedText(marker.status, 32) ?? 'unknown'
        : inProgress
          ? 'in-progress'
          : 'no-marker';
      const detail = markerMatches ? boundedText(marker.detail, 300) ?? null : null;
      state.lastForceOutcome = {
        at: now,
        requestId,
        mode: boundedText(spec.mode, 32) ?? null,
        platform: boundedText(spec.platform, 32) ?? null,
        status,
        markerAt: markerMatches ? statusTimestamp(marker.at) : null,
        detail,
        lockOwnerPid,
        lockOwnerAlive,
        specPresent: true,
      };
      if (status !== 'relaunched' && status !== 'done' && status !== 'in-progress') {
        // Fail closed: a force attempt that did not report success suspends the
        // automatic paths until an explicit force request (or the CLI) clears it.
        state.hold = { active: true, reason: `last-force-${status}`, at: now, requestId, detail };
        log(`boot hold (${status}) for force attempt ${String(requestId)}; spec/marker/lock kept for the external CLI`);
      }
      // Only a confirmed outcome may be cleaned up: a failed or unconfirmed
      // attempt stays readable and retryable from outside the Host.
      if (status === 'relaunched' || status === 'done') {
        // A confirmed success lifts a hold persisted by an earlier failure.
        state.hold = undefined;
        removeFile(forceReaperSpecPath);
        removeFile(markerPath);
        removeFile(forceReaperLockPath);
        log(`boot reconciled force attempt ${String(requestId)}: ${status}`);
      }
    } else if (marker !== undefined) {
      const status = boundedText(marker.status, 32) ?? 'unknown';
      // No force spec behind the marker: this is a normal relaunch leftover (or
      // a force attempt whose spec is already gone). It must NOT overwrite the
      // persisted force outcome (hotfix.7): a safe/coordinated relaunch marker
      // is not a force attempt. Clean it up exactly as before and keep the last
      // force reconciliation for the CLI.
      const markerRequestId = boundedText(marker.requestId, 120) ?? null;
      removeFile(markerPath);
      log(`boot reconciled relaunch marker ${String(markerRequestId)}: ${status}`);
    }
    // The normal relaunch spec is always stale at boot, and a force lock with no
    // force spec behind it cannot belong to a pending attempt.
    removeFile(specPath);
    if (spec === undefined) removeFile(forceReaperLockPath);
  }

  /**
   * Second pass over a force attempt that was still in progress at boot.
   *
   * The reaper writes its marker only after the 2500ms launch verification, so a
   * fast boot can finish reconciliation before that marker exists. In that case
   * the first pass records `in-progress` and keeps the artifacts; this delayed
   * pass honours the late marker (success clears the hold and the artifacts,
   * failure raises the hold) instead of leaving a false `no-marker`.
   */
  function scheduleForceReconcile() {
    const timer = setTimeout(() => {
      let spec;
      try {
        spec = readJsonFile(forceReaperSpecPath);
      } catch {
        spec = null;
      }
      if (spec === null || typeof spec !== 'object') return;
      let marker;
      try {
        marker = readJsonFile(markerPath);
      } catch {
        marker = null;
      }
      if (marker === null || typeof marker !== 'object' || marker.requestId !== spec.requestId) return;
      const status = boundedText(marker.status, 32) ?? 'unknown';
      const requestId = boundedText(spec.requestId, 120) ?? null;
      const detail = boundedText(marker.detail, 300) ?? null;
      state.lastForceOutcome = {
        at: Date.now(),
        requestId,
        mode: boundedText(spec.mode, 32) ?? null,
        platform: boundedText(spec.platform, 32) ?? null,
        status,
        markerAt: statusTimestamp(marker.at),
        detail,
        lockOwnerPid: null,
        lockOwnerAlive: null,
        specPresent: true,
      };
      if (status === 'relaunched' || status === 'done') {
        state.hold = undefined;
        removeFile(forceReaperSpecPath);
        removeFile(markerPath);
        removeFile(forceReaperLockPath);
        log(`delayed reconcile: force attempt ${String(requestId)} ${status}; artifacts cleared`);
      } else {
        state.hold = { active: true, reason: `last-force-${status}`, at: Date.now(), requestId, detail };
        log(`delayed reconcile: force attempt ${String(requestId)} ${status}; hold raised`);
      }
      saveJsonFile(statePath, state);
      writeStatusSnapshot();
    }, 6000);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  /* ---------------------------------------------------------------- state -- */

  const previousState = readJsonFile(statePath) ?? {};
  const state = {
    version: 1,
    bootId: randomUUID(),
    bootStartedAt: Date.now(),
    pid: process.pid,
    home,
    profile: typeof profileContext?.name === 'string' ? profileContext.name : undefined,
    lastRestart:
      previousState !== null && typeof previousState === 'object' && previousState.lastRestart !== null && typeof previousState.lastRestart === 'object'
        ? previousState.lastRestart
        : null,
    // A previous boot's failure is stale: this boot starts with a clean error slot.
    lastError: undefined,
    // Boot-time reconciliation of the previous force attempt (hotfix.5); a
    // failed/unconfirmed attempt also raises `hold`. Both are diagnostics that
    // must survive the boot that produced them (hotfix.6): the next boot keeps
    // showing them until an explicit force request or the CLI clears the hold.
    lastForceOutcome:
      previousState !== null && typeof previousState === 'object' && previousState.lastForceOutcome !== null && typeof previousState.lastForceOutcome === 'object'
        ? previousState.lastForceOutcome
        : null,
    hold:
      previousState !== null && typeof previousState === 'object' && previousState.hold !== null && typeof previousState.hold === 'object'
        ? previousState.hold
        : undefined,
  };
  // Reconcile the force reaper's spec/marker/lock before the normal relaunch
  // leftovers are dropped: the external CLI needs them when the attempt failed.
  reconcileForceArtifacts();
  saveJsonFile(statePath, state);
  log(
    `boot ${state.bootId} profile=${String(state.profile)} home=${home} platform=${platform} version=${PLUGIN_VERSION}`,
  );

  /* ------------------------------------------- resumable tool calls ------- */

  // `resumableToolCalls` (module 4): another plugin declares that one of its
  // tool calls must be answered in the NEXT process instead of receiving the
  // platform's synthetic `TOOL_OUTCOME_UNKNOWN` closer. The service is provided
  // on the Host context — the same `ctx.get(name)` convention this bundle uses
  // for every service it consumes — and its durable holds file is restored
  // before any Session is resumed on this boot (see `resumeBootSettlement`).
  const resumeHoldsPath = join(stateDir, RESUME_HOLDS_FILE);

  /**
   * The two write channels of a Session live in `host/session-writer.js`:
   * a live Session is appended through its own write handle, a persisted-only
   * Session through `sessionPersistence`, and a Session the post-restart resume
   * is currently loading (its write handle already taken, not published yet) is
   * waited out instead of being refused. See that module for the race.
   */
  const resumeWriter = createSessionResultWriter({ ctx, log });

  const resumable = createResumableToolCalls({
    bootId: state.bootId,
    log,
    settleGraceMs: DEFAULT_HOLD_SETTLE_GRACE_MS,
    lookupCall: (callId) => resumeWriter.findLiveCall(callId),
    writeResult: resumeWriter.writeResult,
    persist(snapshot) {
      if (!saveJsonFile(resumeHoldsPath, snapshot)) {
        throw new Error(`cannot write ${RESUME_HOLDS_FILE}`);
      }
    },
  });

  try {
    ctx.provide(RESUME_SERVICE_NAME, {
      hold: (callId, resume) => resumable.hold(callId, resume),
      complete: (callId, result) => resumable.complete(callId, result),
      fail: (callId, reason) => resumable.fail(callId, reason),
      status: () => resumable.status(),
    });
    log(`provided service ${RESUME_SERVICE_NAME} for cross-restart tool calls`);
  } catch (error) {
    log(`cannot provide ${RESUME_SERVICE_NAME}: ${messageOf(error)}`);
  }

  // Holds written by the previous process are the whole point: restore them
  // before anything resumes a Session, and answer them in the same boot tick.
  const previousHoldsRaw = readJsonFile(resumeHoldsPath);
  const previousHolds =
    previousHoldsRaw !== null &&
    typeof previousHoldsRaw === 'object' &&
    previousHoldsRaw.version === RESUME_HOLDS_VERSION &&
    previousHoldsRaw.bootId !== state.bootId &&
    Array.isArray(previousHoldsRaw.holds)
      ? previousHoldsRaw.holds
      : [];
  if (previousHoldsRaw !== undefined && previousHoldsRaw !== null) {
    if (previousHoldsRaw.version !== RESUME_HOLDS_VERSION) {
      log(`resumable holds ignored (version ${String(previousHoldsRaw.version)}); file discarded`);
      removeFile(resumeHoldsPath);
    } else if (previousHoldsRaw.bootId === state.bootId) {
      // Cannot happen: a fresh boot id is generated above. Kept as a guard.
      log('resumable holds belong to this boot; ignored');
    } else if (previousHolds.length === 0) {
      removeFile(resumeHoldsPath);
    }
  }
  if (previousHolds.length > 0) {
    const restored = resumable.restore(previousHolds);
    log(`resumable holds carried over from the previous boot: ${String(restored)}`);
  }
  /**
   * Answer every carried-over hold before the post-restart delivery resumes a
   * Session: the honest provisional result is written immediately (a resume
   * that starts first appends the platform's synthetic
   * `TOOL_OUTCOME_UNKNOWN` closer for an unanswered call and takes the only
   * write handle while it loads), and a write the resume's handle refused is
   * retried for up to `DEFAULT_HOLD_SETTLE_GRACE_MS` instead of being skipped.
   */
  const resumeBootSettlement = resumable
    .settleAtBoot()
    .then((outcome) => {
      if (outcome.pendingWritten > 0 || outcome.skipped > 0 || outcome.failed > 0 || outcome.deferred > 0) {
        log(`resumable boot settlement ${JSON.stringify(outcome)}`);
      }
      return outcome;
    })
    .catch((error) => {
      log(`resumable boot settlement crashed: ${messageOf(error)}`);
      return null;
    });

  /* -------------------------------------------------------------- pending -- */

  /**
   * One pending restart. `mode` is the effective mode after merging:
   * dangerous > coordinated > safe. `safeStateSessions` holds the AIs that used
   * the safe or coordinated tool and therefore belong to safe state; the
   * coordinated wait condition is "no running agent outside this set".
   * @type {undefined | {
   *   requestId: string,
   *   requestedAt: number,
   *   requesters: Array<{sessionId?: string, source: string, mode: string, reason?: string, requestedAt: number}>,
   *   uiRequested: boolean,
   *   mode: string,
   *   firstCoordinatorSessionId?: string,
   *   safeStateSessions: Set<string>,
   *   broadcastSent: Map<string, { lastAt: number, count: number }>,
   *   broadcastTotal: number,
   *   phase: string,
   *   forceReaperArmed?: boolean,
   * }}
   */
  let pending;
  let lastIdleAt = 0;
  let finalizing = false;
  let disposed = false;
  let pollTimer;
  let dangerousFinalizeTimer;
  let shutdownInProgress = false;
  /**
   * Human shutdown state. Shutdown is never relaunched: `safe` waits for
   * running AIs to finish their current turns, `coordinated` broadcasts a stop
   * request and waits for every active AI to become idle, `dangerous` interrupts
   * running AIs immediately and exits after a brief flush. `deadlineAt` is the
   * hard wait cap (`null` means unlimited); when it passes, remaining running
   * AIs are cancelled and the exit continues after `shutdownGraceMs`.
   * @type {undefined | { mode: string, requestedAt: number, reason?: string, waitTimeoutMs: number, deadlineAt: number | null, timedOut: boolean, broadcastSent: Map<string, { lastAt: number, count: number }>, broadcastTotal: number, phase: string }}
   */
  let shutdownState;
  /**
   * AI restart tool calls held open for the whole restart. A tool never
   * returns before the process exits: the requesting AI stays inside its tool
   * call instead of starting a meaningless next model step, and the resumed
   * session continues from the post-restart completion message.
   * @type {Map<string, { sessionId: string, callId: string, settle: (error?: Error) => void }>}
   */
  const restartToolCalls = new Map();
  /** Resume reports for sessions that were not live when the boot delivery ran. */
  const pendingResumeReports = new Map();
  // The state and every runtime slot it projects now exist; publish the boot
  // snapshot before any request can arrive (hotfix.5).
  writeStatusSnapshot();
  // A reaper may still be finishing its launch verification while this Host
  // starts; re-check the force artifacts once so a late marker is honoured.
  scheduleForceReconcile();

  function settlePendingRestartCalls(message) {
    const entries = [...restartToolCalls.values()];
    for (const entry of entries) {
      try {
        entry.settle(message === undefined ? undefined : new Error(message));
      } catch (error) {
        log(`settling restart tool call ${entry.callId} failed: ${messageOf(error)}`);
      }
    }
    return entries.length;
  }
  /**
   * Hold one AI tool call open for the whole restart (module 2 calls this).
   * A successful restart exits the process before the promise settles; a failed
   * restart rejects it so the model can continue and report the failure.
   * @param {{ sessionId: string, callId?: string, signal?: AbortSignal, blocking?: number }} call
   * @returns {Promise<void>} never resolves on the successful path.
   */
  function holdToolCall({ sessionId, callId, signal, blocking }) {
    const id = typeof callId === 'string' && callId.length > 0 ? callId : `restart-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const entry = {
        sessionId,
        callId: id,
        settle(error) {
          restartToolCalls.delete(id);
          try {
            signal?.removeEventListener?.('abort', onAbort);
          } catch {
            /* signal already detached */
          }
          if (error === undefined) resolve(undefined);
          else reject(error);
        },
      };
      const onAbort = () => {
        entry.settle(
          new Error(
            'DSH 正在重启：本次工具调用会随重启进程结束。重启完成后本会话会收到「DSH 已重启完成」消息，请从中断处继续工作；若重启没有发生，请改用' +
              humanRestartHint +
              '手动重启。',
          ),
        );
      };
      restartToolCalls.set(id, entry);
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener?.('abort', onAbort, { once: true });
      log(`restart tool call ${id} held open for session ${String(sessionId)} (waiting for ${String(typeof blocking === 'number' ? blocking : 0)} other AI)`);
    });
  }

  /**
   * @param {number} pid - process id to probe.
   * @returns whether the process still exists.
   */
  function pidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code === 'EPERM';
    }
  }


  function liveAgents() {
    try {
      return ctx.agents.list();
    } catch {
      return [];
    }
  }

  function runningAgents() {
    return liveAgents().filter((agent) => agent.status === 'running');
  }

  /**
   * Snapshot the bounded, redacted restart checkpoint. Sessions own the truth;
   * jobs are best-effort diagnostics and are never reattached.
   * @param {object} record - pending restart record.
   */
  function captureCheckpoint(record) {
    const jobsService = safeGet(ctx, 'jobs');
    const statuses = new Map();
    for (const agent of liveAgents()) {
      statuses.set(String(agent.id), typeof agent.status === 'string' ? agent.status : 'unknown');
    }
    const sessions = [];
    let sessionsService;
    try {
      sessionsService = ctx.sessions;
    } catch {
      sessionsService = undefined;
    }
    if (sessionsService !== undefined && typeof sessionsService.list === 'function') {
      try {
        for (const session of sessionsService.list()) {
          if (session === null || session === undefined) continue;
          const sessionId = String(session.id);
          let events = [];
          try {
            events = session.ownEvents();
          } catch (error) {
            log(`checkpoint: cannot read events for ${sessionId}: ${messageOf(error)}`);
          }
          const jobs = [];
          if (jobsService !== undefined && typeof jobsService.list === 'function') {
            try {
              const listed = jobsService.list(session.id);
              for (const job of Array.isArray(listed) ? listed : []) {
                if (job === null || typeof job !== 'object') continue;
                if (job.owner === undefined || String(job.owner) !== sessionId) continue;
                jobs.push({
                  jobId: typeof job.id === 'string' ? job.id : '',
                  kind: typeof job.kind === 'string' ? job.kind : '',
                  label: typeof job.label === 'string' ? job.label : '',
                  status: typeof job.status === 'string' ? job.status : 'unknown',
                  startedAt: typeof job.startedAt === 'number' ? job.startedAt : null,
                  outputTotal: typeof job.output?.total === 'number' ? job.output.total : 0,
                  spillPaths:
                    job.output !== null && typeof job.output === 'object' && Array.isArray(job.output.spillPaths)
                      ? job.output.spillPaths
                      : [],
                });
              }
            } catch (error) {
              log(`checkpoint: cannot list jobs for ${sessionId}: ${messageOf(error)}`);
            }
          }
          sessions.push({
            sessionId,
            agentStatus: statuses.get(sessionId) ?? 'unknown',
            agentPreset:
              session.header !== null && typeof session.header === 'object' && typeof session.header.agentPreset === 'string'
                ? session.header.agentPreset
                : null,
            lastSeq: typeof session.seq === 'number' ? session.seq : null,
            events,
            jobs,
          });
        }
      } catch (error) {
        log(`checkpoint: cannot list sessions: ${messageOf(error)}`);
      }
    }
    return buildCheckpoint({
      requestId: record.requestId,
      mode: record.mode,
      at: Date.now(),
      bootIdBefore: state.bootId,
      platform,
      heldCallIds: resumable.heldCallIds(),
      heldBySession: resumable.heldBySession(),
      sessions,
    });
  }

  /**
   * Session ids of the AIs that requested a restart record (defaults to the
   * pending restart). Taking the record explicitly keeps status/waits correct
   * while a caller inspects a record other than the global pending one.
   */
  function requesterSessionIds(record = pending) {
    const ids = new Set();
    if (record === undefined || record === null) return ids;
    for (const requester of record.requesters) {
      if (typeof requester.sessionId === 'string' && requester.sessionId.length > 0) ids.add(requester.sessionId);
    }
    return ids;
  }

  /** Normalize a mode value coming from a tool, the UI, or a durable intent. */
  function normalizeMode(value) {
    if (value === MODE_DANGEROUS) return MODE_DANGEROUS;
    if (value === MODE_COORDINATED) return MODE_COORDINATED;
    return MODE_SAFE;
  }

  /**
   * While a coordinated restart is pending, safe-state tools (safe and
   * coordinated restart) are temporarily frictionless for EVERY permission
   * preset, so a read-only AI that received the broadcast can join safe state
   * without an approval prompt. Any other pending mode keeps the base rule.
   */
  function safeStateAccessOpen() {
    return pending !== undefined && pending.mode === MODE_COORDINATED && pending.phase === 'pending';
  }

  /** The mode a requester itself used; the safe-state definition depends on it. */
  function requesterMode(requester) {
    return normalizeMode(requester?.mode);
  }

  /**
   * A requester belongs to safe state when it used the safe or coordinated tool,
   * or when it initiated the dangerous restart that actually ran.
   */
  function isSafeStateRequester(requester) {
    const mode = requesterMode(requester);
    return mode === MODE_SAFE || mode === MODE_COORDINATED || mode === MODE_DANGEROUS;
  }

  function modeLabel(mode) {
    return MODE_LABELS[normalizeMode(mode)] ?? MODE_LABELS[MODE_SAFE];
  }

  /**
   * Running AIs outside safe state. Coordinated mode waits for these; dangerous
   * mode interrupts these. Requesters never count: they are inside their
   * held-open tool call and receive the post-restart completion notice.
   */
  function activeNotSafeAgents(record = pending) {
    if (record === undefined || record === null) return [];
    const requesters = requesterSessionIds(record);
    return runningAgents().filter((agent) => {
      const id = String(agent.id);
      if (record.safeStateSessions.has(id)) return false;
      return !requesters.has(id);
    });
  }

  function activeNotSafeCount(record = pending) {
    return activeNotSafeAgents(record).length;
  }

  /**
   * Running AIs the safe mode must wait for: everyone except the requesting AIs.
   * A requester is interrupted by the restart instead of being waited on, then
   * resumes from the post-restart completion message.
   */
  function blockingRunningAgents(record = pending) {
    const requesters = requesterSessionIds(record);
    if (requesters.size === 0) return runningAgents();
    return runningAgents().filter((agent) => !requesters.has(String(agent.id)));
  }

  function permissionInfo(session) {
    let preset;
    let sandbox;
    let approvalPolicy;
    const permissionPresets = safeGet(ctx, 'permissionPresets');
    if (permissionPresets !== undefined && typeof permissionPresets.current === 'function') {
      try {
        preset = permissionPresets.current(session);
      } catch {
        preset = undefined;
      }
      if (typeof preset === 'string' && preset !== 'custom' && typeof permissionPresets.resolve === 'function') {
        try {
          const spec = permissionPresets.resolve(preset);
          sandbox = spec?.sandbox;
          approvalPolicy = spec?.approval;
        } catch {
          /* fall through to the durable knob events */
        }
      }
    }
    // Durable fallback: the last sandbox/approval knob events in the session log.
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      const event = session.eventAt(seq);
      if (event === undefined) continue;
      if (sandbox === undefined && event.type === 'sandbox/mode') sandbox = event.data?.mode;
      else if (approvalPolicy === undefined && event.type === 'approval/policy') approvalPolicy = event.data?.policy;
      if (sandbox !== undefined && approvalPolicy !== undefined) break;
    }
    return {
      preset: typeof preset === 'string' ? preset : undefined,
      sandbox,
      approvalPolicy,
      fullAccess: sandbox === 'danger-full-access' && approvalPolicy === 'never',
    };
  }

  function statusValue() {
    const agents = liveAgents().map((agent) => ({ sessionId: String(agent.id), status: agent.status }));
    const waitingFor =
      pending === undefined
        ? []
        : pending.mode === MODE_SAFE
          ? blockingRunningAgents(pending)
          : activeNotSafeAgents(pending);
    const rollCallDeadline = pending === undefined ? null : statusTimestamp(pending.coordinatedDeadlineAt);
    return {
      ok: true,
      version: 1,
      plugin: PLUGIN_ID,
      bootId: state.bootId,
      pid: process.pid,
      bootStartedAt: state.bootStartedAt,
      now: Date.now(),
      phase: shutdownInProgress ? 'shutting-down' : pending === undefined ? 'idle' : pending.phase,
      shuttingDown: shutdownInProgress,
      pending:
        pending === undefined
          ? null
          : {
              requestId: pending.requestId,
              requestedAt: pending.requestedAt,
              coordinatedDeadlineAt: rollCallDeadline,
              waitingRemainingMs: rollCallDeadline === null ? null : Math.max(0, rollCallDeadline - Date.now()),
              mode: pending.mode,
              modeLabel: modeLabel(pending.mode),
              humanModeLabel: HUMAN_MODE_LABELS[pending.mode] ?? HUMAN_MODE_LABELS[MODE_SAFE],
              requesters: pending.requesters.map((requester) => ({
                sessionId: requester.sessionId,
                source: requester.source,
                mode: requesterMode(requester),
                safeState: isSafeStateRequester(requester),
                reason: requester.reason,
                requestedAt: requester.requestedAt,
              })),
              uiRequested: pending.uiRequested,
              firstCoordinatorSessionId: pending.firstCoordinatorSessionId,
              // Diagnostics only: whether the detached force reaper is armed.
              forceReaperArmed: pending.forceReaperArmed === true,
              waitingMs: Date.now() - pending.requestedAt,
              // Agents the effective mode is still waiting for / about to interrupt.
              runningAgents: waitingFor.length,
              blockingAgents: waitingFor.length,
              waitingSessionIds: waitingFor.map((agent) => String(agent.id)),
              safeStateSessions: [...pending.safeStateSessions],
              safeStateCount: pending.safeStateSessions.size,
              broadcast: { total: pending.broadcastTotal, sessions: pending.broadcastSent.size },
              requesterSessionIds: [...requesterSessionIds(pending)],
            },
      runningAgents: agents.filter((agent) => agent.status === 'running').length,
      requesterRunningAgents: liveAgents().filter((agent) => agent.status === 'running' && requesterSessionIds().has(String(agent.id))).length,
      shutdown:
        shutdownState === undefined
          ? null
          : {
              mode: shutdownState.mode,
              modeLabel: modeLabel(shutdownState.mode),
              humanModeLabel: HUMAN_MODE_LABELS[shutdownState.mode] ?? HUMAN_MODE_LABELS[MODE_SAFE],
              requestedAt: shutdownState.requestedAt,
              phase: shutdownState.phase,
              waitingAgents: runningAgents().length,
              waitingSessionIds: runningAgents().map((agent) => String(agent.id)),
              waitTimeoutMs: shutdownState.waitTimeoutMs ?? cfg.shutdownMaxWaitMs,
              deadlineAt: shutdownState.deadlineAt ?? null,
              timedOut: shutdownState.timedOut === true,
              reason: shutdownState.reason ?? null,
              broadcast: { total: shutdownState.broadcastTotal, sessions: shutdownState.broadcastSent.size },
            },
      agents,
      lastRestart: state.lastRestart ?? null,
      // Fail-closed boot state (hotfix.5): non-null while a failed force attempt
      // keeps automatic behavior suspended.
      hold: state.hold ?? null,
      lastError: state.lastError ?? null,
      rollCallWaitMs: cfg.rollCallWaitMs,
      testMode: cfg.testMode,
    };
  }

  /**
   * Write the single human-readable `status.json` snapshot (hotfix.5). Its fixed
   * shape is consumed by `scripts/restart-cli.mjs` while the Host is dead; a
   * write failure is only logged and never disturbs a restart.
   */
  function writeStatusSnapshot() {
    try {
      const snapshot = {
        version: 1,
        at: Date.now(),
        bootId: state.bootId,
        pid: process.pid,
        platform,
        phase: shutdownInProgress ? 'shutting-down' : pending === undefined ? 'idle' : pending.phase,
        pending:
          pending === undefined
            ? null
            : {
                requestId: pending.requestId,
                mode: pending.mode,
                phase: pending.phase,
                requesters: pending.requesters.length,
                safeStateCount: pending.safeStateSessions.size,
                forceReaperArmed: pending.forceReaperArmed === true,
              },
        forceDryRun: cfg.forceDryRun,
        hold: state.hold ?? null,
        lastForceOutcome: state.lastForceOutcome ?? null,
        lastError: state.lastError ?? null,
        lastRestart:
          state.lastRestart === null || typeof state.lastRestart !== 'object'
            ? null
            : {
                requestId: state.lastRestart.requestId ?? null,
                mode: state.lastRestart.mode ?? null,
                tookMs: statusTimestamp(state.lastRestart.tookMs),
                completedAt: statusTimestamp(state.lastRestart.completedAt),
                // Roll-call timeouts stay visible in the human/CLI snapshot too.
                timedOutCount: Array.isArray(state.lastRestart.timedOutSessions)
                  ? state.lastRestart.timedOutSessions.length
                  : statusCount(state.lastRestart.safeState?.timedOutCount),
                timedOutSessionIds: statusSessionIds(state.lastRestart.timedOutSessions),
              },
        paths: {
          stateDir,
          state: statePath,
          status: statusSnapshotPath,
          intent: intentPath,
          spec: specPath,
          checkpoint: checkpointPath,
          marker: markerPath,
          log: logPath,
          relaunchLog: relaunchLogPath,
          forceReaperSpec: forceReaperSpecPath,
          forceReaperLock: forceReaperLockPath,
          forceDryRun: forceDryRunPath,
        },
      };
      if (!saveJsonFile(statusSnapshotPath, snapshot)) log(`status.json write failed at ${String(statusSnapshotPath)}`);
    } catch (error) {
      log(`status.json snapshot failed: ${messageOf(error)}`);
    }
  }

  /**
   * Bounded, read-only snapshot for the model-facing `restart_dsh_status` tool.
   * Unlike `statusValue` it never exposes delivery result details, session
   * result arrays, filesystem paths, or tokens.
   */
  function statusSummary() {
    const waitingFor =
      pending === undefined
        ? []
        : pending.mode === MODE_SAFE
          ? blockingRunningAgents(pending)
          : activeNotSafeAgents(pending);
    return projectStatusSummary({
      phase: shutdownInProgress ? 'shutting-down' : pending === undefined ? 'idle' : pending.phase,
      shuttingDown: shutdownInProgress,
      runningAgents: runningAgents().length,
      agents: liveAgents().map((agent) => ({ sessionId: String(agent.id), status: agent.status })),
      pending:
        pending === undefined
          ? null
          : {
              requestId: pending.requestId,
              phase: pending.phase,
              mode: pending.mode,
              modeLabel: modeLabel(pending.mode),
              requestedAt: pending.requestedAt,
              waitingMs: Date.now() - pending.requestedAt,
              coordinatedDeadlineAt: pending.coordinatedDeadlineAt ?? null,
              requesters: pending.requesters.length,
              safeStateCount: pending.safeStateSessions.size,
              waitingAgents: waitingFor.length,
              waitingSessionIds: waitingFor.map((agent) => String(agent.id)),
              broadcast: { total: pending.broadcastTotal, sessions: pending.broadcastSent.size },
            },
      shutdown:
        shutdownState === undefined
          ? null
          : {
              mode: shutdownState.mode,
              modeLabel: modeLabel(shutdownState.mode),
              phase: shutdownState.phase,
              requestedAt: shutdownState.requestedAt,
              waitingAgents: runningAgents().length,
              waitingSessionIds: runningAgents().map((agent) => String(agent.id)),
              waitTimeoutMs: shutdownState.waitTimeoutMs ?? cfg.shutdownMaxWaitMs,
              deadlineAt: shutdownState.deadlineAt ?? null,
              timedOut: shutdownState.timedOut === true,
              reason: shutdownState.reason,
            },
      lastRestart: state.lastRestart ?? null,
      platform,
    });
  }

  /**
   * Model-facing steering interjection sent to every running AI outside safe
   * state in coordinated mode.
   */
  function coordinationBroadcastText(record) {
    const activeOutside = activeNotSafeCount(record);
    return (
      '<dsh_restart_coordination mode="coordinated">\n' +
      '【点名重启·插话】另一个 AI（或人类通过界面）已发起点名重启（人类界面名为「中断」）。\n' +
      SAFE_STATE_DEFINITION +
      '\n你当前不在就绪状态。立即：\n' +
      '1. 停止派生子代理、正在执行的工具/命令，不要开始新任务；\n' +
      `2. 调用 ${TOOL_NAME_ALL_WAIT} 加入就绪状态（也可调用 restart_dsh_roll_call_caution，但非第一发起者会退化为阻塞等待）；\n` +
      '3. 加入后工具调用会挂起，等待所有活跃 AI 进入就绪状态，随后 DSH 重启。\n' +
      `当前仍有 ${String(activeOutside)} 个活跃 AI 未进入就绪状态。不要使用强制重启。\n` +
      '</dsh_restart_coordination>'
    );
  }

  /**
   * Send the coordination interjection to running AIs outside safe state. One
   * steering message per agent, re-sent at most `coordinatedMaxResends` times
   * with `coordinatedResendMs` spacing while the agent keeps running unsafely.
   * @returns how many interjections were sent by this call.
   */
  function broadcastSafeStateRequest(record) {
    if (record === undefined || record.mode !== MODE_COORDINATED || record.phase !== 'pending') return 0;
    const now = Date.now();
    const requesters = requesterSessionIds(record);
    let sent = 0;
    for (const agent of liveAgents()) {
      const id = String(agent.id);
      if (requesters.has(id) || record.safeStateSessions.has(id) || agent.status !== 'running') {
        // Leaving the running set starts a fresh window for a later turn.
        record.broadcastSent.delete(id);
        continue;
      }
      const previous = record.broadcastSent.get(id);
      if (previous !== undefined) {
        if (previous.count >= cfg.coordinatedMaxResends) continue;
        if (now - previous.lastAt < cfg.coordinatedResendMs) continue;
      }
      try {
        agent.steer(restartMessage(coordinationBroadcastText(record), 'dsh-restart'));
      } catch (error) {
        log(`coordinated broadcast to ${id} failed: ${messageOf(error)}`);
        continue;
      }
      record.broadcastSent.set(id, { lastAt: now, count: (previous?.count ?? 0) + 1 });
      record.broadcastTotal += 1;
      sent += 1;
      log(`coordinated interjection #${String(record.broadcastTotal)} sent to ${id} (${String(record.broadcastSent.get(id).count)}x)`);
    }
    return sent;
  }

  /** Dangerous mode does not wait; finalize shortly after the request is queued. */
  function scheduleDangerousFinalize(record) {
    if (dangerousFinalizeTimer !== undefined) return;
    dangerousFinalizeTimer = setTimeout(() => {
      dangerousFinalizeTimer = undefined;
      if (pending === record && record.phase !== 'restarting') void finalizeRestart();
    }, 120);
    if (typeof dangerousFinalizeTimer?.unref === 'function') dangerousFinalizeTimer.unref();
  }

  /**
   * Queue one restart request (AI tool or UI) into the single pending restart.
   *
   * - safe and coordinated requests add their requester to safe state;
   * - a first coordinated request upgrades a pending safe restart and starts the
   *   broadcast; a coordinated request from a non-first initiator degrades to
   *   safe mode (it only joins safe state);
   * - any dangerous request escalates the pending restart to dangerous mode and
   *   finalizes immediately (dangerous > coordinated > safe).
   */
  /** Absolute deadline for a new roll-call wait; null means "wait forever" (0). */
  function nextRollCallDeadline() {
    return cfg.rollCallWaitMs === 0 ? null : Date.now() + cfg.rollCallWaitMs;
  }

  function requestRestart(request) {
    const now = Date.now();
    const source = request.source === 'ui' ? 'ui' : 'tool';
    const requestedMode = normalizeMode(request.mode);
    const requester = {
      sessionId: typeof request.sessionId === 'string' && request.sessionId.length > 0 ? request.sessionId : undefined,
      source,
      mode: requestedMode,
      reason: typeof request.reason === 'string' && request.reason.trim().length > 0 ? request.reason.trim().slice(0, 500) : undefined,
      requestedAt: now,
    };
    /** UI is the first initiator when the humans pick the roll-call mode. */
    const coordinatorKey = source === 'ui' ? 'ui' : requester.sessionId;
    if (shutdownInProgress) {
      return {
        accepted: false,
        phase: 'shutting-down',
        message: 'DSH 正在关闭，重启请求不会执行。',
        status: statusValue(),
      };
    }
    if (requestedMode === MODE_DANGEROUS && cfg.forceDryRun === true) {
      // Rehearsal only (hotfix.5): record what would happen, then return without
      // creating a pending restart, arming the reaper or killing the Host.
      const launch = resolveLaunch();
      const dryRun = {
        at: now,
        mode: MODE_DANGEROUS,
        reason: requester.reason ?? null,
        platform,
        launch:
          launch === undefined
            ? null
            : { execPath: launch.execPath, cwd: launch.cwd, args: launch.args, argCount: launch.args.length },
        wouldArmReaper: true,
        plan: 'checkpoint→intent→reaper→SIGKILL',
      };
      if (!saveJsonFile(forceDryRunPath, dryRun)) log(`force dry-run write failed at ${String(forceDryRunPath)}`);
      log(`force restart rehearsed by ${source}: forceDryRun enabled; no pending, no reaper, no kill`);
      writeStatusSnapshot();
      return {
        accepted: false,
        dryRun: true,
        mode: MODE_DANGEROUS,
        message: 'forceDryRun 已开启：强制重启只做演练，未执行。关闭 forceDryRun 后重试。',
        status: statusValue(),
      };
    }
    if (requestedMode === MODE_DANGEROUS && state.hold?.active === true) {
      // An explicit force request is the decision that lifts the hold. This is
      // deliberately after the dry-run gate: a rehearsal must not clear it.
      state.hold = undefined;
      saveJsonFile(statePath, state);
      log('hold cleared by explicit force request');
    }
    if (pending !== undefined && pending.phase === 'restarting') {
      if (requestedMode === MODE_DANGEROUS) {
        // A force request must never be refused because a restart is already in
        // flight, and the caller stays held until the process dies. Only a force
        // restart already owns a reaper, though: a safe/coordinated restart has
        // already dispatched its own relauncher (with its own exit watchdog), so
        // arming a second relaunch path here would double-launch the Host.
        if (pending.mode === MODE_DANGEROUS) {
          spawnForceReaper(pending, resolveLaunch(), 'restart');
          log(`force restart ${pending.requestId} re-confirmed by ${source}: reaper armed, caller held until restart`);
        } else {
          log(
            `force request ${pending.requestId} joined the in-flight ${pending.mode} restart by ${source};` +
              ' no extra reaper armed (its relauncher is already dispatched)',
          );
        }
        writeStatusSnapshot();
        return {
          accepted: true,
          alreadyPending: true,
          phase: 'restarting',
          requestId: pending.requestId,
          mode: pending.mode,
          message: 'DSH 重启已在进行，本调用会挂起至重启完成（重启完成后你会收到系统消息）。',
          runningAgents: runningAgents().length,
          blockingAgents: pending.mode === MODE_SAFE ? blockingRunningAgents(pending).length : activeNotSafeCount(pending),
          status: statusValue(),
        };
      }
      return {
        accepted: false,
        alreadyPending: true,
        phase: pending.phase,
        requestId: pending.requestId,
        mode: pending.mode,
        message: 'DSH 已经在重启流程中，本次调用未排队。重启完成后你会收到系统消息。',
        runningAgents: runningAgents().length,
        blockingAgents: pending.mode === MODE_SAFE ? blockingRunningAgents(pending).length : activeNotSafeCount(pending),
        status: statusValue(),
      };
    }
    if (pending === undefined) {
      pending = {
        requestId: randomUUID(),
        requestedAt: now,
        requesters: [],
        uiRequested: source === 'ui',
        mode: requestedMode,
        // Only a roll-call restart is bounded; other modes never read this field.
        coordinatedDeadlineAt: requestedMode === MODE_COORDINATED ? nextRollCallDeadline() : null,
        firstCoordinatorSessionId: requestedMode === MODE_COORDINATED ? coordinatorKey : undefined,
        safeStateSessions: new Set(),
        broadcastSent: new Map(),
        broadcastTotal: 0,
        phase: 'pending',
      };
      lastIdleAt = 0;
      log(
        `restart requested by ${source} mode=${requestedMode}` +
          `${requester.sessionId === undefined ? '' : ` session=${requester.sessionId}`}`,
      );
    }
    const previousMode = pending.mode;
    if (requestedMode === MODE_DANGEROUS) {
      if (pending.mode !== MODE_DANGEROUS) {
        log(`pending restart escalated to force mode by ${source}${requester.sessionId === undefined ? '' : ` session=${requester.sessionId}`}`);
      }
      pending.mode = MODE_DANGEROUS;
    } else if (requestedMode === MODE_COORDINATED) {
      if (pending.mode === MODE_SAFE) {
        pending.mode = MODE_COORDINATED;
        pending.firstCoordinatorSessionId = coordinatorKey;
        // The safe→coordinated upgrade starts the bounded roll-call wait.
        pending.coordinatedDeadlineAt = nextRollCallDeadline();
        log(`pending restart upgraded to roll-call mode by ${source}`);
      } else if (pending.mode === MODE_COORDINATED && pending.firstCoordinatorSessionId === undefined) {
        pending.firstCoordinatorSessionId = coordinatorKey;
      }
      // A pending force mode stays force; this requester still joins safe state.
    }
    let degraded = false;
    if (requestedMode === MODE_COORDINATED && pending.mode === MODE_COORDINATED) {
      const first = pending.firstCoordinatorSessionId;
      degraded = first !== undefined && requester.sessionId !== undefined && first !== requester.sessionId;
    }
    // Safe-state membership is defined by the tool the AI used. A dangerous
    // request cancels an earlier safe-state membership by the same AI.
    if (requester.sessionId !== undefined) {
      if (requestedMode === MODE_DANGEROUS) pending.safeStateSessions.delete(requester.sessionId);
      else pending.safeStateSessions.add(requester.sessionId);
    }
    pending.uiRequested = pending.uiRequested || source === 'ui';
    const duplicateIndex = pending.requesters.findIndex(
      (existing) => existing.sessionId === requester.sessionId && existing.source === requester.source,
    );
    const duplicate = duplicateIndex >= 0;
    if (duplicate) {
      // Keep one requester entry per source/session and retain the stronger mode.
      const rank = (mode) => (mode === MODE_DANGEROUS ? 3 : mode === MODE_COORDINATED ? 2 : 1);
      const existing = pending.requesters[duplicateIndex];
      if (rank(requester.mode) > rank(existing.mode)) existing.mode = requester.mode;
    } else {
      pending.requesters.push(requester);
    }

    let broadcast = { sent: 0, sessions: 0 };
    if (pending.mode === MODE_COORDINATED) {
      const sent = broadcastSafeStateRequest(pending);
      broadcast = { sent, sessions: pending.broadcastSent.size };
    }
    if (pending.mode === MODE_DANGEROUS) scheduleDangerousFinalize(pending);
    // Every pending field above is final for this call: refresh the snapshot.
    writeStatusSnapshot();

    return {
      accepted: true,
      alreadyPending: duplicate || pending.requesters.length > 1,
      phase: pending.phase,
      requestId: pending.requestId,
      mode: pending.mode,
      requestedMode,
      degraded,
      upgraded: previousMode !== pending.mode,
      requesters: pending.requesters.length,
      safeStateCount: pending.safeStateSessions.size,
      runningAgents: runningAgents().length,
      blockingAgents: pending.mode === MODE_SAFE ? blockingRunningAgents(pending).length : activeNotSafeCount(pending),
      activeNotSafe: activeNotSafeCount(pending),
      interruptedAgents: pending.mode === MODE_DANGEROUS ? activeNotSafeCount(pending) : 0,
      broadcast,
      firstCoordinatorSessionId: pending.firstCoordinatorSessionId,
      status: statusValue(),
    };
  }

  function maybeFinalize() {
    if (disposed || finalizing || shutdownInProgress || pending === undefined || pending.phase !== 'pending') return;
    if (pending.mode === MODE_DANGEROUS) {
      // Dangerous mode never waits; the request path schedules finalization and
      // this is only a backstop for a timer that did not fire.
      void finalizeRestart();
      return;
    }
    if (pending.mode === MODE_COORDINATED) {
      broadcastSafeStateRequest(pending);
      // The bounded wait is over: continue the restart even if some AIs are
      // still outside safe state (they are recorded as timed out in the intent).
      if (rollCallExpired(pending)) {
        log(
          `roll-call wait expired for restart ${pending.requestId}; continuing without waiting` +
            ` (${String(activeNotSafeCount(pending))} agent(s) still outside safe state)`,
        );
        void finalizeRestart();
        return;
      }
    }
    const blocking = pending.mode === MODE_COORDINATED ? activeNotSafeAgents(pending) : blockingRunningAgents(pending);
    if (blocking.length > 0) {
      lastIdleAt = 0;
      return;
    }
    const now = Date.now();
    if (lastIdleAt === 0) {
      lastIdleAt = now;
      return;
    }
    if (now - lastIdleAt < cfg.graceMs) return;
    void finalizeRestart();
  }

  function resolveLaunch() {
    const launch = cfg.launch ?? {};
    const execPath = typeof launch.execPath === 'string' && launch.execPath.length > 0 ? launch.execPath : process.execPath;
    const cwd = typeof launch.cwd === 'string' && launch.cwd.length > 0 ? launch.cwd : process.cwd();
    let args;
    if (Array.isArray(launch.args) && launch.args.length > 0 && launch.args.every((value) => typeof value === 'string')) {
      args = [...launch.args];
    } else {
      // `process.argv` is [node, script, ...inner dsh args]; relaunch the same script.
      if (process.argv.length < 2 || typeof process.argv[1] !== 'string' || process.argv[1].length === 0) return undefined;
      args = process.argv.slice(1);
    }
    // Never auto-open a second browser tab on relaunch: the initiating page
    // reloads itself (UI path) or reconnects (AI path). `--no-open` is the
    // web app's own flag; only add it when this really is the web profile/app.
    if (!cfg.openBrowserOnRelaunch && !args.includes('--no-open') && isWebLaunch(args)) args = [...args, '--no-open'];
    return { execPath, execArgv: [...process.execArgv], args, cwd };
  }

  function isWebLaunch(args) {
    if (state.profile === 'web') return true;
    if (args.includes('web')) return true;
    const profileIndex = args.indexOf('--profile');
    if (profileIndex >= 0 && args[profileIndex + 1] === 'web') return true;
    // The browser carrier is mounted: this process is the web app even when a
    // custom profile name (for example a test profile) launched it.
    try {
      return ctx.get('webServer') !== undefined;
    } catch {
      return false;
    }
  }

  /* -------------------------------------------------------- force teardown -- */

  /**
   * Kill this process without any graceful teardown. The timer deliberately is
   * NOT unref'd: it must keep the event loop alive until it fires. SIGKILL
   * cannot be intercepted by a signal handler; `process.exit(0)` is only a
   * fallback for a platform where signalling self is refused.
   * @param {string} label - log context (`force restart` / `force shutdown`).
   */
  function hardKillSelf(label) {
    setTimeout(() => {
      log(`hard self-kill (${label}) pid=${String(process.pid)}`);
      try {
        process.kill(process.pid, 'SIGKILL');
      } catch (error) {
        log(`self SIGKILL failed (${label}): ${messageOf(error)}`);
      }
      try {
        process.exit(0);
      } catch {
        /* the process is already going away */
      }
    }, FORCE_EXIT_GRACE_MS);
  }

  /**
   * Fail-closed check that a force restart has something it can actually
   * relaunch (hotfix.5). The result is recorded in the reaper spec/marker so a
   * failure is explainable later; it never blocks the self-destruct itself.
   * @param {object | undefined} launch - resolved relaunch command.
   * @returns {{ ok: boolean, detail: string }} validation result.
   */
  function validateLaunch(launch) {
    if (desktopShell) {
      const ok = existsSync(process.execPath);
      return {
        ok,
        detail: ok ? `desktop app executable present: ${process.execPath}` : `desktop app executable missing: ${process.execPath}`,
      };
    }
    if (launch === null || typeof launch !== 'object') {
      return { ok: false, detail: 'web relaunch command is missing' };
    }
    if (typeof launch.execPath !== 'string' || launch.execPath.length === 0 || !existsSync(launch.execPath)) {
      return { ok: false, detail: `web relaunch execPath does not exist: ${typeof launch.execPath === 'string' ? launch.execPath : '(missing)'}` };
    }
    if (!Array.isArray(launch.args) || launch.args.length === 0) {
      return { ok: false, detail: 'web relaunch args are empty' };
    }
    return { ok: true, detail: 'web relaunch command is valid' };
  }

  /**
   * Build the force-reaper spec. The contract is fixed by `force-reaper.mjs`:
   * the reaper waits `killAfterMs` for `hostPid` to die, force-kills it
   * (`taskkill /F /PID` on Windows) and then relaunches (restart) or just
   * records `done` (shutdown).
   * @param {object} record - pending restart or synthetic shutdown record.
   * @param {object | undefined} launch - resolved relaunch command (restart+web only).
   * @param {string} mode - 'restart' | 'shutdown'.
   * @returns {object} spec written to {@link forceReaperSpecPath}.
   */
  function buildForceReaperSpec(record, launch, mode) {
    const requestId =
      typeof record?.requestId === 'string' && record.requestId.length > 0 ? record.requestId : `force-${randomUUID()}`;
    // Fail-closed validation is recorded for the next boot / CLI; a shutdown has
    // no relaunch step, so it cannot fail this check.
    const validation =
      mode === 'restart' ? validateLaunch(launch) : { ok: true, detail: 'shutdown mode does not relaunch' };
    const spec = {
      version: 1,
      requestId,
      mode,
      platform,
      hostPid: process.pid,
      createdAt: Date.now(),
      killAfterMs: cfg.forceKillAfterMs,
      // Same budget the old exit watchdog allowed before forcing the exit.
      killGraceMs: DEFAULT_EXIT_WATCHDOG_MS,
      relaunchDelayMs: RELAUNCH_DELAY_MS,
      markerPath,
      logPath: relaunchLogPath,
      lockPath: forceReaperLockPath,
      validation,
    };
    if (!validation.ok) {
      log(`force reaper spec ${requestId} (${mode}) launch validation failed: ${validation.detail}; self-destruct continues`);
    }
    if (desktopShell) spec.mainPid = process.ppid;
    if (mode === 'restart' && desktopShell) {
      spec.appExecutable = process.execPath;
      spec.appDir = dirname(process.execPath);
    } else if (mode === 'restart' && launch !== undefined) {
      spec.relaunch = {
        execPath: launch.execPath,
        execArgv: [...launch.execArgv],
        args: [...launch.args],
        cwd: launch.cwd,
      };
    }
    return spec;
  }

  /**
   * Arm the detached force reaper for `record`. This is what makes force mode
   * unstoppable: the reaper outlives this Host and kills it if it does not die
   * on its own. Idempotent per record, and every failure is only logged — an
   * unarmed reaper must never stop the caller from self-destructing.
   * @param {object} record - pending restart or synthetic shutdown record.
   * @param {object | undefined} launch - resolved relaunch command (restart+web only).
   * @param {string} mode - 'restart' | 'shutdown'.
   * @returns {boolean} whether a reaper is armed for this record.
   */
  function spawnForceReaper(record, launch, mode) {
    if (record === null || typeof record !== 'object') return false;
    if (record.forceReaperArmed === true) {
      log(`force reaper already armed for ${String(record.requestId)} (${mode})`);
      return true;
    }
    const spec = buildForceReaperSpec(record, launch, mode);
    // A spec write failure means no reaper, but it must never block the kill:
    // log it and let the caller continue with its own self-destruct.
    if (!saveJsonFile(forceReaperSpecPath, spec)) {
      log(`force reaper spec write failed for ${spec.requestId} (${mode}); continuing to self-destruct`);
      return false;
    }
    // On Desktop `process.execPath` is the Electron binary: without this marker
    // it would start a second app instance instead of running the reaper script.
    // The Host normally inherits the marker from the shell, but setting it here
    // makes the reaper independent of how the shell launched the Host.
    const env = desktopShell ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env;
    try {
      const child = spawn(process.execPath, [FORCE_REAPER_PATH, forceReaperSpecPath], {
        cwd: stateDir,
        env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      // A detached reaper must never keep this Host alive; a late spawn error
      // can only be logged because the force path proceeds regardless.
      child.unref();
      child.once('error', (error) => log(`force reaper spawn error (${spec.requestId}): ${messageOf(error)}`));
      record.forceReaperArmed = true;
      log(`force reaper armed pid=${String(child.pid)} mode=${mode} requestId=${spec.requestId}`);
      return true;
    } catch (error) {
      log(`force reaper spawn failed (${spec.requestId}): ${messageOf(error)}; retrying via cmd.exe start`);
    }
    if (process.platform === 'win32') {
      try {
        // `start "" /b ...`: the empty title keeps Windows from treating the
        // first quoted path as the window title; /b avoids a console window.
        const fallback = spawn('cmd.exe', ['/c', 'start', '', '/b', process.execPath, FORCE_REAPER_PATH, forceReaperSpecPath], {
          cwd: stateDir,
          env,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        fallback.unref();
        fallback.once('error', (error) => log(`force reaper cmd.exe spawn error (${spec.requestId}): ${messageOf(error)}`));
        record.forceReaperArmed = true;
        log(`force reaper armed via cmd.exe start pid=${String(fallback.pid)} mode=${mode} requestId=${spec.requestId}`);
        return true;
      } catch (error) {
        log(`force reaper cmd.exe spawn failed (${spec.requestId}): ${messageOf(error)}; continuing to self-destruct`);
      }
    }
    return false;
  }

  /**
   * Wait for the relauncher's readiness marker. Readiness is a marker file
   * carrying the SAME requestId and status `started` (helper alive) or
   * `relaunched` (new process spawned); log text is never used for this.
   * @param {string} requestId - restart request this helper was dispatched for.
   * @param {number} timeoutMs - readiness budget.
   * @returns {object} the readiness marker.
   */
  async function waitForRelaunchMarker(requestId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const marker = readJsonFile(markerPath);
      if (marker !== null && typeof marker === 'object' && marker.requestId === requestId) {
        if (marker.status === 'error') {
          const detail = typeof marker.detail === 'string' && marker.detail.length > 0 ? marker.detail : '未知原因';
          throw new Error(`重启辅助进程报告失败：${detail}（详见日志 ${relaunchLogPath}）`);
        }
        if (marker.status === 'started' || marker.status === 'relaunched') return marker;
      }
      await sleep(60);
    }
    throw new Error(`重启辅助进程未就绪，详见日志 ${relaunchLogPath}`);
  }

  async function spawnRelauncher() {
    const requestId = pending?.requestId;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new Error('无法确定重启请求标识，重启辅助进程未启动');
    }
    // The old marker belongs to a previous attempt; a stale one must never be
    // mistaken for this attempt's readiness.
    removeFile(markerPath);
    try {
      writeFileSync(relaunchLogPath, `[${new Date().toISOString()}] [dsh-restart ${process.pid}] dispatch relaunch for ${requestId}\n`);
    } catch {
      /* append-only diagnostics */
    }
    const child = spawn(process.execPath, [RELAUNCHER_PATH, specPath, markerPath], {
      cwd: stateDir,
      env: process.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    let spawnError;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.unref();
    await sleep(400);
    if (spawnError !== undefined) throw new Error(`无法启动重启辅助进程：${messageOf(spawnError)}`);
    const marker = await waitForRelaunchMarker(requestId, 3000);
    // The helper already parsed the spec; removing it prevents a later boot from
    // treating this completed attempt as a leftover.
    removeFile(specPath);
    log(`relauncher ready pid=${String(child.pid)} status=${String(marker.status)} requestId=${requestId}`);
    return child.pid;
  }

  async function flushAll(record, timeoutMs = cfg.flushTimeoutMs) {
    const tasks = [];
    try {
      for (const session of ctx.sessions.list()) {
        tasks.push(
          Promise.resolve()
            .then(() => ctx.sessions.flush(session))
            .catch((error) => log(`session flush failed (${String(session.id)}): ${messageOf(error)}`)),
        );
      }
    } catch (error) {
      log(`listing sessions for flush failed: ${messageOf(error)}`);
    }
    const persistence = safeGet(ctx, 'sessionPersistence');
    if (persistence !== undefined && typeof persistence.flush === 'function') {
      tasks.push(
        Promise.resolve()
          .then(() => persistence.flush())
          .catch((error) => log(`session persistence flush failed: ${messageOf(error)}`)),
      );
    }
    if (tasks.length === 0) return;
    await Promise.race([Promise.allSettled(tasks), sleep(timeoutMs)]);
  }

  function notifyFailure(record, error) {
    const text = `<dsh_restart_failed>\n[DSH 重启失败] DSH 重启未能执行：${messageOf(error)}\n这是系统自动通知：请向用户报告失败及原因。用户仍可用${humanRestartHint}手动重试，或检查启动 DSH 的终端。\n</dsh_restart_failed>`;
    for (const requester of record.requesters) {
      if (requester.sessionId === undefined) continue;
      const agent = safeGet(ctx, 'agents')?.get?.(requester.sessionId);
      if (agent === undefined) continue;
      try {
        agent.followup(restartMessage(text, 'dsh-restart'));
      } catch (followupError) {
        log(`failure notice to ${requester.sessionId} failed: ${messageOf(followupError)}`);
      }
    }
  }

  /**
   * Fail every AI tool call currently held open for a restart. The tool returns
   * the failure to the model so it keeps working instead of staying blocked.
   * @param message - model-facing failure text.
   * @returns number of settled calls (0 means no AI was blocked in the tool).
   */
  function failPendingRestartCalls(message) {
    return settlePendingRestartCalls(message);
  }

  /**
   * @param {object} record - pending restart.
   * @param {object} intent - durable restart intent.
   * @returns {Promise<void>} resolves once the detached helper is running.
   */
  async function spawnDesktopRelauncher(record, intent) {
    const payload = {
      version: 1,
      requestId: record.requestId,
      requestedAt: record.requestedAt,
      delayMs: 1200,
      mainPid: process.ppid,
      hostPid: process.pid,
      appExecutable: process.execPath,
      appDir: dirname(process.execPath),
      logPath: desktopRelaunchLogPath,
    };
    const helper = spawn(process.execPath, [DESKTOP_RELAUNCHER_PATH, JSON.stringify(payload)], {
      cwd: home,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    helper.unref();
    log(`desktop relauncher ready pid=${String(helper.pid)}`);
  }

  /**
   * Roll the pending restart back if the shell did not actually restart.
   * @param {object} record - pending restart.
   */
  function scheduleDesktopRelaunchGuard(record) {
    const timer = setTimeout(() => {
      if (!finalizing) return;
      if (!pidAlive(process.ppid)) return; // the shell is gone; Host shutdown follows
      log('desktop relaunch watchdog fired; rolling the pending restart back');
      removeFile(intentPath);
      state.lastError = { at: Date.now(), requestId: record.requestId, message: 'desktop relaunch timed out' };
      saveJsonFile(statePath, state);
      pending = undefined;
      lastIdleAt = 0;
      finalizing = false;
      const settled = failPendingRestartCalls(
        'DSH 重启失败：桌面应用没有在预期时间内重启（可能被系统或等待软件拦截）。请手动重启桌面应用，或查看日志：' + desktopRelaunchLogPath,
      );
      if (settled === 0) notifyFailure(record, new Error('desktop relaunch timed out'));
    }, cfg.desktopRelaunchTimeoutMs);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  async function finalizeRestart() {
    if (finalizing || pending === undefined) return;
    if (shutdownInProgress) {
      log('finalizeRestart skipped: a shutdown is already in progress');
      pending = undefined;
      return;
    }
    finalizing = true;
    const record = pending;
    try {
      if (record.phase !== 'restarting') {
        if (record.mode === MODE_SAFE && blockingRunningAgents(record).length > 0) {
          lastIdleAt = 0;
          finalizing = false;
          return;
        }
        if (
          record.mode === MODE_COORDINATED &&
          !rollCallExpired(record) &&
          activeNotSafeAgents(record).length > 0
        ) {
          lastIdleAt = 0;
          finalizing = false;
          return;
        }
        // Dangerous mode never waits for running AIs: it interrupts the ones
        // outside safe state by exiting the process.
      }
      if (shutdownInProgress) {
        log(`restart ${record.requestId} abandoned: a shutdown started while waiting`);
        pending = undefined;
        finalizing = false;
        return;
      }
      record.phase = 'restarting';
      log(`finalizing ${record.mode} restart ${record.requestId} requesters=${record.requesters.length}`);

      const launch = resolveLaunch();
      if (launch === undefined) throw new Error('无法确定 DSH 启动命令（process.argv 不完整）；可在插件配置中提供 launch.execPath/launch.args 后重试');

      // Capture the bounded, redacted pre-restart state before writing the intent.
      // A checkpoint failure must never block the restart itself.
      const checkpoint = captureCheckpoint(record);
      const checkpointSaved = saveJsonFile(checkpointPath, checkpoint);
      if (!checkpointSaved) log(`checkpoint write failed for restart ${record.requestId}; continuing without checkpoint`);
      else log(`checkpoint written for restart ${record.requestId} sessions=${String(checkpoint.totals.sessions)} calls=${String(checkpoint.totals.openToolCalls)} jobs=${String(checkpoint.totals.jobs)}`);

      // AIs that dangerous mode interrupts: running agents outside safe state,
      // requesters excluded (they are inside their held-open tool call).
      const interrupted =
        record.mode === MODE_DANGEROUS
          ? activeNotSafeAgents(record).map((agent) => ({ sessionId: String(agent.id) }))
          : [];
      // Roll-call restarts that ran out of wait time still list the AIs that did
      // not enter safe state; the completion notice must report them truthfully.
      const timedOutSessions =
        record.mode === MODE_COORDINATED && rollCallExpired(record)
          ? activeNotSafeAgents(record).map((agent) => String(agent.id))
          : [];
      const intent = {
        version: 1,
        requestId: record.requestId,
        requestedAt: record.requestedAt,
        mode: record.mode,
        dangerous: record.mode === MODE_DANGEROUS,
        requesters: record.requesters.map((requester) => ({
          sessionId: requester.sessionId,
          source: requester.source,
          mode: requesterMode(requester),
          safeState: isSafeStateRequester(requester),
          reason: requester.reason,
          requestedAt: requester.requestedAt,
        })),
        // AIs that entered safe state by using the safe or coordinated tool.
        safeStateSessions: [...record.safeStateSessions],
        firstCoordinatorSessionId: record.firstCoordinatorSessionId,
        broadcast: { total: record.broadcastTotal, sessions: [...record.broadcastSent.keys()] },
        // Roll-call deadline (null = wait forever) and who timed out, if anyone.
        coordinatedDeadlineAt: record.coordinatedDeadlineAt ?? null,
        timedOutSessions,
        interrupted,
        uiRequested: record.uiRequested,
        trigger: record.uiRequested ? (record.requesters.some((requester) => requester.source === 'tool') ? 'mixed' : 'ui') : 'tool',
        bootIdBefore: state.bootId,
        pid: process.pid,
        shell: desktopShell ? 'desktop' : 'web',
        ...(desktopShell ? { hostPid: process.pid, electronMainPid: process.ppid, appExecutable: process.execPath } : {}),
        startedAt: Date.now(),
        checkpoint: {
          version: CHECKPOINT_VERSION,
          status: checkpointSaved ? 'written' : 'failed',
          at: checkpoint.at,
          totals: checkpoint.totals,
          file: CHECKPOINT_FILE,
        },
        // In-flight restart tool calls; the resume repair closes them in the new process.
        pendingToolCalls: [...restartToolCalls.values()].map((call) => ({ sessionId: call.sessionId, callId: call.callId })),
      };
      if (!saveJsonFile(intentPath, intent)) throw new Error('无法写入重启意图文件');

      // Publish the 'restarting' snapshot immediately before any path can kill
      // this process: if it dies mid-restart the CLI can see how far it got.
      writeStatusSnapshot();

      if (record.mode === MODE_DANGEROUS) {
        // Force mode is unstoppable: arm the detached reaper, flush within a
        // small bounded budget, then SIGKILL this process. No relauncher, no
        // readiness marker wait and no appExit + exit watchdog — none of them
        // may block the restart.
        spawnForceReaper(record, launch, 'restart');
        await flushAll(record, Math.min(cfg.dangerousFlushTimeoutMs, FORCE_FLUSH_TIMEOUT_MS));
        log(`force restart ${record.requestId}: hard-exiting without waiting for graceful teardown`);
        hardKillSelf('force restart');
        return;
      }

      if (desktopShell) {
        await flushAll(record, record.mode === MODE_DANGEROUS ? cfg.dangerousFlushTimeoutMs : cfg.flushTimeoutMs);
        if (shutdownInProgress) {
          removeFile(intentPath);
          log(`desktop restart ${record.requestId} abandoned: a shutdown started before relaunch`);
          pending = undefined;
          finalizing = false;
          return;
        }
        log(`desktop ${record.mode} restart ${record.requestId}: relaunching the desktop app (Electron pid ${String(process.ppid)})`);
        await spawnDesktopRelauncher(record, intent);
        scheduleDesktopRelaunchGuard(record);
        return;
      }

      const spec = {
        version: 1,
        requestId: record.requestId,
        markerPath,
        pid: process.pid,
        execPath: launch.execPath,
        execArgv: launch.execArgv,
        args: launch.args,
        cwd: launch.cwd,
        logPath: relaunchLogPath,
        waitTimeoutMs: WAIT_TIMEOUT_MS,
        delayMs: RELAUNCH_DELAY_MS,
        createdAt: Date.now(),
      };
      if (!saveJsonFile(specPath, spec)) throw new Error('无法写入重启启动参数文件');

      if (shutdownInProgress) {
        removeFile(intentPath);
        removeFile(specPath);
        log(`restart ${record.requestId} abandoned: a shutdown started before the relauncher`);
        pending = undefined;
        finalizing = false;
        return;
      }
      await spawnRelauncher();
      // Deliberately do NOT cancel the requesting AIs here: they are inside the
      // held-open restart tool call, so the process exit (and the resume repair
      // in the next process) is what ends their call — no meaningless model step
      // ran in between. Safe/coordinated modes already waited for non-requesters
      // to become idle; dangerous mode intentionally leaves the non-safe-state
      // running AIs to be interrupted by the process exit.
      log(`process exit for ${record.mode} restart with ${String(restartToolCalls.size)} held-open restart tool call(s)`);
      await flushAll(record, record.mode === MODE_DANGEROUS ? cfg.dangerousFlushTimeoutMs : cfg.flushTimeoutMs);

      log('requesting graceful process exit for restart');
      const exit = safeGet(ctx, 'appExit');
      const watchdog = setTimeout(() => {
        log('exit watchdog fired; forcing process exit');
        process.exit(0);
      }, cfg.exitWatchdogMs);
      if (typeof watchdog?.unref === 'function') watchdog.unref();
      if (typeof exit === 'function') exit(0);
      else process.exit(0);
    } catch (error) {
      log(`restart failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      removeFile(intentPath);
      removeFile(checkpointPath);
      state.lastError = { at: Date.now(), requestId: record.requestId, message: messageOf(error) };
      saveJsonFile(statePath, state);
      pending = undefined;
      lastIdleAt = 0;
      finalizing = false;
      const settled = failPendingRestartCalls(
        `DSH 重启失败：${messageOf(error)}。重启没有执行，请向用户报告失败原因；用户可用${humanRestartHint}重试。`,
      );
      if (settled === 0) notifyFailure(record, error);
    }
  }

  /* ------------------------------------------------------------- shutdown -- */

  /**
   * The optional escape pod's Host service (`escapePod`), when that plugin is
   * installed. This package never requires it: a missing service simply
   * disables the shutdown linkage, and its own tools/settings live there.
   * @returns {{ shutdown: (reason?: string) => unknown } | undefined}
   */
  function escapePodService() {
    const service = safeGet(ctx, 'escapePod');
    if (service === undefined || service === null) return undefined;
    return typeof service.shutdown === 'function' ? service : undefined;
  }

  /** Whether the shutdown dialog may offer 「同时关闭正在运行的逃生舱」. */
  function escapePodAvailable() {
    return escapePodService() !== undefined;
  }

  /** One bounded line describing what the pod reported after a shutdown. */
  function describeEscapePodShutdown(result) {
    if (result === null || typeof result !== 'object') return 'no result';
    const parts = [];
    if (typeof result.status === 'string' && result.status.length > 0) parts.push(result.status);
    if (typeof result.killed === 'number' && Number.isFinite(result.killed)) {
      parts.push(`killed=${String(Math.trunc(result.killed))}`);
    }
    return parts.length > 0 ? parts.join(' ') : 'no result';
  }

  /**
   * Close the escape pod right before DSH actually exits. Opt-in: the human
   * shutdown dialog sends `closeEscapePod:true`, and only then does this run.
   * Never throws and never blocks the shutdown — a missing service is logged
   * and skipped, a rejection is logged and swallowed, because tying DSH's own
   * exit to another plugin's cleanup would be a hang waiting to happen.
   * @param {string} reason - human-readable reason recorded by the pod.
   */
  async function closeEscapePodForShutdown(reason) {
    const service = escapePodService();
    if (service === undefined) {
      log('escape pod not closed: escapePod service is not available');
      return;
    }
    try {
      // A promise that outlives the race must not surface as an unhandled
      // rejection; its eventual outcome is irrelevant once DSH is exiting.
      const shutdownPromise = Promise.resolve().then(() => service.shutdown(reason));
      shutdownPromise.catch(() => {});
      const result = await Promise.race([
        shutdownPromise,
        sleep(ESCAPE_POD_SHUTDOWN_TIMEOUT_MS).then(() => ({ timedOut: true })),
      ]);
      if (result !== null && typeof result === 'object' && result.timedOut === true) {
        log(
          `escape pod shutdown timed out after ${String(ESCAPE_POD_SHUTDOWN_TIMEOUT_MS)}ms; continuing to exit`,
        );
        return;
      }
      log(`escape pod closed (${describeEscapePodShutdown(result)})`);
    } catch (error) {
      log(`escape pod shutdown failed: ${messageOf(error)}`);
    }
  }

  function shutdownModeLabel(mode) {
    return HUMAN_MODE_LABELS[normalizeMode(mode)] ?? HUMAN_MODE_LABELS[MODE_SAFE];
  }

  /** Steering interjection asking every running AI to stop before shutdown. */
  function shutdownCoordinationText() {
    return (
      '<dsh_restart_shutdown mode="coordinated">\n' +
      '【DSH 关闭通知】人类已通过界面请求关闭 DSH（中断模式）。\n' +
      '立即停止派生子代理、正在执行的工具/命令，不要开始新任务；所有活跃 AI 停止后 DSH 将关闭（不会再启动）。\n' +
      `当前仍有 ${String(runningAgents().length)} 个活跃 AI。\n` +
      '</dsh_restart_shutdown>'
    );
  }

  /** One broadcast round for a coordinated shutdown; respects resend limits. */
  function broadcastShutdownCoordination(record) {
    if (record === undefined || record.mode !== MODE_COORDINATED) return 0;
    const now = Date.now();
    let sent = 0;
    for (const agent of runningAgents()) {
      const id = String(agent.id);
      const previous = record.broadcastSent.get(id);
      if (previous !== undefined) {
        if (previous.count >= cfg.coordinatedMaxResends) continue;
        if (now - previous.lastAt < cfg.coordinatedResendMs) continue;
      }
      try {
        agent.steer(restartMessage(shutdownCoordinationText(), 'dsh-restart'));
      } catch (error) {
        log(`shutdown broadcast to ${id} failed: ${messageOf(error)}`);
        continue;
      }
      record.broadcastSent.set(id, { lastAt: now, count: (previous?.count ?? 0) + 1 });
      record.broadcastTotal += 1;
      sent += 1;
      log(`shutdown interjection #${String(record.broadcastTotal)} sent to ${id}`);
    }
    return sent;
  }

  /**
   * Exit the process for good: no relauncher and no restart intent.
   *
   * On Desktop the Host is a child of the Electron shell; exiting alone makes the
   * shell show its fatal "backend stopped" dialog and leaves the window open. The
   * official IPC only lets the shell command the Host (there is no Host→shell quit
   * command), so a detached helper terminates the Electron shell while this Host
   * finishes saving sessions. The Host waits briefly so the window disappears
   * before the child exit is observed, then exits itself.
   */
  function exitForShutdown() {
    log('shutting down DSH now (no relaunch)');
    if (desktopShell) {
      try {
        const payload = {
          version: 1,
          mainPid: process.ppid,
          hostPid: process.pid,
          delayMs: 300,
          logPath: desktopQuitLogPath,
        };
        const helper = spawn(process.execPath, [DESKTOP_QUIT_HELPER_PATH, JSON.stringify(payload)], {
          cwd: home,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        helper.unref();
        log(`desktop quit helper ready pid=${String(helper.pid)}`);
      } catch (error) {
        log(`desktop quit helper failed to spawn: ${messageOf(error)}`);
      }
    }
    const finishExit = () => {
      const exit = safeGet(ctx, 'appExit');
      const watchdog = setTimeout(() => {
        log('shutdown watchdog fired; forcing process exit');
        process.exit(0);
      }, cfg.exitWatchdogMs);
      if (typeof watchdog?.unref === 'function') watchdog.unref();
      if (typeof exit === 'function') exit(0);
      else process.exit(0);
    };
    if (desktopShell) {
      // Let the helper close the shell first: an abruptly orphaned child would
      // otherwise trigger the desktop fatal dialog and a half-restarted backend.
      // Wait until the Electron shell is gone (the helper also retries) so that
      // the window closes before this Host's exit is observed.
      const deadline = Date.now() + 6000;
      const wait = () => {
        if (!pidAlive(process.ppid) || Date.now() >= deadline) finishExit();
        else setTimeout(wait, 150);
      };
      setTimeout(wait, 300);
    } else {
      finishExit();
    }
  }

  /**
   * Ask every currently running AI to cancel its turn. A failing cancel is
   * logged and skipped: the shutdown deadline still means the process exits.
   * @param {string} label - log context.
   * @returns {number} how many agents received the cancel request.
   */
  function cancelRunningAgents(label) {
    const running = runningAgents();
    let requested = 0;
    for (const agent of running) {
      try {
        agent.cancel({ kind: 'user' });
        requested += 1;
      } catch (error) {
        log(`${label}: cancel failed for ${String(agent.id)}: ${messageOf(error)}`);
      }
    }
    return requested;
  }

  /**
   * Human-only shutdown with the same three modes as restart, but WITHOUT
   * relaunching: safe waits for running AIs to finish their current turns,
   * coordinated broadcasts a stop request and waits for every active AI to become
   * idle, dangerous interrupts running AIs immediately and exits after a short
   * flush. Safe/coordinated waits are capped by `shutdownMaxWaitMs` (0 = no cap);
   * when the cap passes, remaining running AIs are cancelled and the exit
   * continues after `shutdownGraceMs`. Only the authenticated UI route can reach
   * this; no AI tool exposes it.
   * @param {string} [mode] - restart-derived mode used by the UI.
   * @param {string} [reason] - optional human reason (logs/status only).
   * @param {boolean} [closeEscapePod] - close the escape pod's running commands
   *   immediately before DSH exits (opt-in from the shutdown dialog).
   */
  async function requestShutdown(mode = MODE_SAFE, reason, closeEscapePod = false) {
    if (shutdownInProgress) return false;
    const requestedMode = normalizeMode(mode);
    const shutdownReason =
      typeof reason === 'string' && reason.trim().length > 0 ? reason.trim().slice(0, 200) : undefined;
    const waitTimeoutMs = cfg.shutdownMaxWaitMs;
    shutdownInProgress = true;
    shutdownState = {
      mode: requestedMode,
      requestedAt: Date.now(),
      reason: shutdownReason,
      waitTimeoutMs,
      // 0 means "wait forever": no deadline is recorded.
      deadlineAt: waitTimeoutMs === 0 ? null : Date.now() + waitTimeoutMs,
      timedOut: false,
      broadcastSent: new Map(),
      broadcastTotal: 0,
      phase: 'waiting',
    };
    if (pending !== undefined) {
      const canceledRequestId = pending.requestId;
      pending = undefined;
      // Settle every held restart tool call first: otherwise its requester stays
      // blocked in the tool forever (Agent still `running`) and the safe /
      // coordinated shutdown wait loop below can never finish.
      const settled = failPendingRestartCalls(
        '<dsh_restart_failed>\n[DSH 重启已取消] 人类已请求关闭 DSH，本次重启不会执行。\n</dsh_restart_failed>',
      );
      log(`shutdown cancels pending restart ${canceledRequestId} (settled ${String(settled)} held tool call(s))`);
    }
    removeFile(intentPath);
    log(
      `shutdown requested from the UI (human-only) mode=${requestedMode} (${shutdownModeLabel(requestedMode)})` +
        ` waitTimeoutMs=${String(waitTimeoutMs)}` +
        `${closeEscapePod === true ? ' closeEscapePod=true' : ''}` +
        `${shutdownReason === undefined ? '' : ` reason=${shutdownReason}`}`,
    );
    // Let the HTTP response flush before the process starts tearing down.
    await sleep(250);
    try {
      if (requestedMode === MODE_DANGEROUS) {
        const running = runningAgents();
        log(`force shutdown: interrupting ${String(running.length)} running agent(s)`);
        cancelRunningAgents('force shutdown');
        shutdownState.phase = 'flushing';
        // Snapshot the 'shutting-down' state before the unstoppable path.
        writeStatusSnapshot();
        // Force shutdown is unstoppable too: the detached reaper kills this Host
        // if it does not die on its own, and the hard self-kill follows a small
        // bounded flush. `exitForShutdown()` (graceful appExit + watchdog) is
        // deliberately not used on this path.
        spawnForceReaper({ requestId: `shutdown-${randomUUID()}`, forceReaperArmed: false }, undefined, 'shutdown');
        await flushAll(undefined, Math.min(cfg.dangerousFlushTimeoutMs, FORCE_FLUSH_TIMEOUT_MS));
        // The pod is a separate process tree: closing it here is the last
        // chance before the unstoppable exit. Its failure is only logged.
        if (closeEscapePod === true) await closeEscapePodForShutdown('dsh-power shutdown');
        log('force shutdown: hard-exiting without waiting for graceful teardown');
        hardKillSelf('force shutdown');
        return true;
      } else {
        if (requestedMode === MODE_COORDINATED) broadcastShutdownCoordination(shutdownState);
        let deadlineHit = false;
        while (runningAgents().length > 0) {
          if (shutdownState.deadlineAt !== null && Date.now() >= shutdownState.deadlineAt) {
            deadlineHit = true;
            break;
          }
          if (requestedMode === MODE_COORDINATED) broadcastShutdownCoordination(shutdownState);
          await sleep(cfg.pollMs);
        }
        if (deadlineHit) {
          shutdownState.timedOut = true;
          shutdownState.phase = 'cancelling';
          const remaining = runningAgents().length;
          log(
            `shutdown wait exceeded ${String(waitTimeoutMs)}ms; cancelling ${String(remaining)} remaining running agent(s)` +
              ` and waiting ${String(cfg.shutdownGraceMs)}ms grace`,
          );
          // Cancellation failures are logged and ignored: the hard cap still
          // ends the wait and proceeds to flush/exit.
          cancelRunningAgents('shutdown timeout');
          const graceUntil = Date.now() + cfg.shutdownGraceMs;
          const step = Math.max(10, Math.min(cfg.pollMs, 100));
          while (runningAgents().length > 0 && Date.now() < graceUntil) await sleep(step);
          const stillRunning = runningAgents().length;
          if (stillRunning > 0) {
            log(`shutdown timeout: ${String(stillRunning)} agent(s) still running after the grace window; continuing to exit`);
          }
        }
        shutdownState.phase = 'flushing';
        await flushAll(undefined);
      }
    } catch (error) {
      log(`shutdown cleanup failed: ${messageOf(error)}`);
    }
    // After the waits/flush and before the exit: the same "last chance" as the
    // force path above. Anything the pod reports lands in this log; a pod error
    // never stops DSH from exiting.
    if (closeEscapePod === true) await closeEscapePodForShutdown('dsh-power shutdown');
    exitForShutdown();
    return true;
  }

  /* --------------------------------------------------------- boot delivery -- */

  function formatTime(timestamp) {
    try {
      return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
    } catch {
      return String(timestamp);
    }
  }

  function restoreWarning(presetRestore) {
    if (presetRestore === undefined || presetRestore.status !== 'failed') return '';
    return `\n- 注意：恢复本会话时未能挂载它的 Agent 预设「${String(presetRestore.agentPreset)}」（${String(presetRestore.error ?? '未知原因')}）。由该预设提供的工具可能不可用。如果确实缺少工具，请让用户用${humanRestartHint}做一次等待重启；在确认工具可用前不要依赖它们。`;
  }

  function intentMode(intent) {
    return normalizeMode(intent?.mode ?? (intent?.dangerous === true ? MODE_DANGEROUS : MODE_SAFE));
  }

  /** One sentence stating which restart mode was actually used. */
  function modeSummaryText(intent) {
    const mode = intentMode(intent);
    if (mode === MODE_DANGEROUS) {
      return '本次重启使用【强制】模式：立即中断了所有未就绪的运行中 AI，未等待其完成。强制重启的发起者与预先进入就绪状态的 AI 属于就绪状态；被中断的 AI 不属于就绪状态。';
    }
    if (mode === MODE_COORDINATED) {
      const broadcastTotal = typeof intent.broadcast?.total === 'number' ? intent.broadcast.total : 0;
      const safeCount = Array.isArray(intent.safeStateSessions) ? intent.safeStateSessions.length : 0;
      const timedOutCount = Array.isArray(intent.timedOutSessions) ? intent.timedOutSessions.length : 0;
      const outcome =
        timedOutCount > 0
          ? `限时等待已到，仍有 ${String(timedOutCount)} 个活跃 AI 未进入就绪状态，重启已继续（它们可能被中断）。`
          : `所有活跃 AI 进入就绪状态（${String(safeCount)} 个）后才重启，未强制中断任何 AI。`;
      return `本次重启使用【点名】模式：向未就绪的运行中 AI 广播（共 ${String(broadcastTotal)} 次）；${outcome}`;
    }
    return '本次重启使用【阻塞等待】模式：等待所有其他运行中 AI 完成当前回合后重启，未强制中断任何 AI。';
  }

  /** The safe-state definition plus this restart's own safe-state outcome. */
  function safeStateText(intent) {
    const mode = intentMode(intent);
    const requesters = Array.isArray(intent.requesters) ? intent.requesters : [];
    const safeMembers = requesters
      .filter(
        (requester) =>
          requesterMode(requester) === MODE_SAFE ||
          requesterMode(requester) === MODE_COORDINATED ||
          requesterMode(requester) === MODE_DANGEROUS,
      )
      .map((requester) => requester.sessionId)
      .filter((sessionId) => typeof sessionId === 'string' && sessionId.length > 0);
    const interrupted = Array.isArray(intent.interrupted) ? intent.interrupted : [];
    const interruptedIds = interrupted
      .map((item) => (typeof item?.sessionId === 'string' ? item.sessionId : undefined))
      .filter((sessionId) => sessionId !== undefined);
    if (mode === MODE_DANGEROUS) {
      return (
        '- 就绪状态：强制重启发起者与预先进入就绪状态的 AI **属于就绪状态**；被强制中断的 AI **不属于就绪状态**。' +
        SAFE_STATE_DEFINITION +
        '\n- 属于就绪状态的 AI：' +
        (safeMembers.length > 0 ? safeMembers.join('、') : '无') +
        '\n- 被中断而不属于就绪状态的 AI：' +
        (interruptedIds.length > 0 ? interruptedIds.join('、') : '无')
      );
    }
    return `- 就绪状态：本次重启已进入就绪状态。${SAFE_STATE_DEFINITION}`;
  }

  function interruptedText(intent, item, presetRestore, resumeReport) {
    const completedAt = formatTime(Date.now());
    const tookSeconds = Math.max(0, Math.round((Date.now() - intent.requestedAt) / 1000));
    return (
      '<dsh_restart_interrupted mode="force_dangerous">\n' +
      'DSH 已被【强制重启】重启完成。你被强制中断，未进入就绪状态。\n' +
      `- 时间：${completedAt}（耗时约 ${String(tookSeconds)} 秒）\n` +
      '- 可能后果：被中断回合/工具结果未知（TOOL_OUTCOME_UNKNOWN）；任务进度可能丢失；会话与环境可能不一致。\n' +
      '- 请：检查会话状态 → 尝试恢复任务进度 → 向人类明确告示「你被强制重启、当前进度与风险」。\n' +
      '- 不要重试强制重启。\n' +
      restoreWarning(presetRestore) +
      (typeof resumeReport === 'string' && resumeReport.length > 0 ? `\n${resumeReport}\n` : '') +
      '</dsh_restart_interrupted>'
    );
  }

  function timedOutText(intent, sessionId, presetRestore, resumeReport) {
    const completedAt = formatTime(Date.now());
    const tookSeconds = Math.max(0, Math.round((Date.now() - intent.requestedAt) / 1000));
    return (
      '<dsh_restart_interrupted mode="coordinated_timeout">\n' +
      'DSH 已在【点名】重启的限时等待到期后重启完成。你未在时限内进入就绪状态，当前回合可能已被中断。\n' +
      `- 时间：${completedAt}（耗时约 ${String(tookSeconds)} 秒）\n` +
      '- 可能后果：被中断回合/工具结果未知（TOOL_OUTCOME_UNKNOWN）；任务进度可能丢失；会话与环境可能不一致。\n' +
      '- 请：检查会话状态 → 尝试恢复任务进度 → 向人类如实告示「你在点名等待超时后随重启被中断、当前进度与风险」。\n' +
      '- 不要重试点名/重启工具调用。\n' +
      restoreWarning(presetRestore) +
      (typeof resumeReport === 'string' && resumeReport.length > 0 ? `\n${resumeReport}\n` : '') +
      '</dsh_restart_interrupted>'
    );
  }

  function completionText(intent, requester, presetRestore, extras = {}) {
    const mode = intentMode(intent);
    const requestedAt = formatTime(intent.requestedAt);
    const completedAt = formatTime(Date.now());
    const tookSeconds = Math.max(0, Math.round((Date.now() - intent.requestedAt) / 1000));
    const resumeReport = typeof extras.resumeReport === 'string' ? extras.resumeReport : '';
    const resumeBlock = resumeReport.length > 0 ? `\n${resumeReport}\n` : '';
    const presetFailed = presetRestore !== undefined && presetRestore.status === 'failed';
    const restoredNote = presetFailed ? '会话已恢复，但工具集可能不完整。' : '会话已恢复。';
    const reason = requester.reason === undefined ? '' : `（原因：${requester.reason}）`;
    const header =
      '<dsh_restart_completed mode="' +
      (mode === MODE_DANGEROUS ? 'force_dangerous' : mode === MODE_COORDINATED ? 'roll_call_caution' : 'blocking_wait_safe') +
      '">\n';
    const common =
      `DSH 已重启完成（${modeLabel(mode)}）。\n` +
      `- 请求：${requestedAt}；完成：${completedAt}（约 ${String(tookSeconds)} 秒）\n` +
      `${restoredNote}${reason}\n` +
      modeSummaryText(intent) +
      '\n' +
      safeStateText(intent) +
      '\n';
    const retryNote = '- 重启工具调用被中断属预期，不要重试。\n';
    // Both the dangerous and the coordinated branch report on the interruption
    // notices actually delivered on this boot, so resolve them once up front.
    const interruptedResults = Array.isArray(extras.interruptedResults) ? extras.interruptedResults : [];
    if (mode === MODE_DANGEROUS) {
      const delivered = interruptedResults.filter((result) => result.status === 'delivered').length;
      const failed = interruptedResults.filter((result) => result.status !== 'delivered').length;
      const interrupted = Array.isArray(intent.interrupted) ? intent.interrupted : [];
      const ids = interrupted
        .map((item) => (typeof item?.sessionId === 'string' ? item.sessionId : undefined))
        .filter((sessionId) => sessionId !== undefined);
      return (
        header +
        common +
        `- 被中断 AI：${String(interrupted.length)} 个${ids.length > 0 ? `（${ids.join('、')}）` : '（无）'}；中断通知：成功 ${String(delivered)}、失败 ${String(failed)}。` +
        (failed > 0 ? '未收到通知的被中断 AI 仍不属于就绪状态，请提醒用户检查。' : '') +
        '\n- 被中断 AI 的后果：回合输出可能丢失、工具结果未知、会话与环境可能不一致、后续操作可能重复或冲突；请勿假设其工作已完成。\n' +
        retryNote +
        '- 你必须向用户如实报告：使用了【强制】重启、被中断 AI（如有）不属于就绪状态、数量与恢复情况；发起者本身属于就绪状态。除有额外需求外，以后优先用【阻塞等待】。\n' +
        restoreWarning(presetRestore) +
        '请向用户报告「DSH 已重启完成（强制）」后继续。\n' +
        resumeBlock +
        '</dsh_restart_completed>'
      );
    }
    if (mode === MODE_COORDINATED) {
      const timedOut = Array.isArray(intent.timedOutSessions) ? intent.timedOutSessions : [];
      const timedOutIds = statusSessionIds(timedOut);
      const timedOutNote =
        timedOut.length === 0
          ? ''
          : `- 限时已到：仍有 ${String(timedOut.length)} 个 AI 未进入就绪状态` +
            `${timedOutIds.length > 0 ? `（${timedOutIds.join('、')}${timedOut.length > timedOutIds.length ? ' 等' : ''}）` : ''}，` +
            '已继续重启；它们可能被中断、回合结果未知。\n';
      const timedOutResults = interruptedResults.filter((result) => result.reason === 'timed-out');
      const timedOutDelivered = timedOutResults.filter((result) => result.status === 'delivered').length;
      const timedOutFailed = timedOutResults.filter((result) => result.status !== 'delivered').length;
      const timedOutNotifyNote =
        timedOut.length === 0
          ? ''
          : `- 未就绪 AI 通知：成功 ${String(timedOutDelivered)}、失败 ${String(timedOutFailed)}（未收到通知的 AI 可能仍处于中断状态）。\n`;
      return (
        header +
        common +
        '- 点名的广播可能已让 AI 主动停止部分工作；请让用户按需检查这些会话。\n' +
        timedOutNote +
        timedOutNotifyNote +
        retryNote +
        restoreWarning(presetRestore) +
        '请向用户报告「DSH 已重启完成（中断）」后继续。\n' +
        resumeBlock +
        '</dsh_restart_completed>'
      );
    }
    return (
      header +
      common +
      '- 本次重启未强制中断任何 AI；运行中的 AI 已自然完成或属于重启发起者。\n' +
      retryNote +
      restoreWarning(presetRestore) +
      '请向用户报告「DSH 已重启完成（等待）」后继续。\n' +
      resumeBlock +
      '</dsh_restart_completed>'
    );
  }

  /**
   * Recover the model route a persisted session last used. `AgentLoop.resume`
   * does not derive AgentOptions from the log, and prompt assembly reads
   * `{{provider}}`/`{{model}}` from `agent.options`; resuming without them makes
   * the post-restart turn fail prompt assembly when a section references the
   * model (for example a deployment persona prefix). The last `request/header`
   * config is authoritative; the deployment default model is the fallback.
   */
  async function readLastAgentOptions(sessionId) {
    const persistence = safeGet(ctx, 'sessionPersistence');
    if (persistence !== undefined && typeof persistence.open === 'function') {
      let handle;
      try {
        handle = await persistence.open(sessionId, 'read');
        let start;
        try {
          const snapshot = typeof persistence.stat === 'function' ? await persistence.stat(sessionId) : undefined;
          if (typeof snapshot?.eventCount === 'number') start = Math.max(0, snapshot.eventCount - 200);
        } catch {
          /* read from the beginning */
        }
        const result = start === undefined ? await handle.read() : await handle.read(start);
        const events = Array.isArray(result?.events) ? result.events : [];
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index];
          if (event?.type !== 'request/header') continue;
          const config = event.data?.header?.config;
          if (config !== null && typeof config === 'object' && typeof config.provider === 'string' && typeof config.model === 'string') {
            return {
              provider: config.provider,
              model: config.model,
              ...(typeof config.reasoningEffort === 'string' ? { reasoningEffort: config.reasoningEffort } : {}),
              ...(typeof config.maxTokens === 'number' ? { maxTokens: config.maxTokens } : {}),
            };
          }
        }
      } catch (error) {
        log(`reading persisted model route for ${sessionId} failed: ${messageOf(error)}`);
      } finally {
        try {
          await handle?.close?.();
        } catch {
          /* best effort */
        }
      }
    }
    try {
      const selection = safeGet(ctx, 'agentDefaultModel')?.currentSelection?.();
      if (selection !== undefined && typeof selection.provider === 'string' && typeof selection.model === 'string') {
        return {
          provider: selection.provider,
          model: selection.model,
          ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
        };
      }
    } catch {
      /* no deployment default */
    }
    return undefined;
  }

  /**
   * Read the Agent preset a persisted Session must resume under.
   *
   * The `agentPreset` Session projection is authoritative: it starts from the
   * creation header and advances with later `agent-preset/selected` records.
   * When a preset roster is mounted but the Session recorded no preset (created
   * before presets existed), resuming under the configured default mirrors what
   * the Web Session controller does for the same cold Session.
   *
   * @param sessionId - persisted Session identity to inspect.
   * @returns `undefined` when no preset roster is mounted or the preset cannot
   *   be read; otherwise the recorded preset id, or `null` for the default.
   */
  async function readSessionAgentPreset(sessionId) {
    const presets = safeGet(ctx, 'agentPresets');
    if (presets === undefined || typeof presets.mount !== 'function') return undefined;
    const query = safeGet(ctx, 'sessionQuery');
    if (query === undefined || typeof query.observeSession !== 'function') {
      log(`cannot restore the agent preset of ${sessionId}: the sessionQuery service is unavailable`);
      return undefined;
    }
    let observation;
    try {
      observation = await query.observeSession(sessionId);
    } catch (error) {
      log(`reading the agent preset of ${sessionId} failed: ${messageOf(error)}`);
      return undefined;
    }
    try {
      const projected = observation?.projections?.values?.agentPreset;
      if (typeof projected === 'string' && projected.length > 0) return projected;
      const created = observation?.header?.agentPreset;
      if (typeof created === 'string' && created.length > 0) return created;
      return null;
    } finally {
      try {
        observation?.[Symbol.dispose]?.();
      } catch {
        /* observation lease release is best effort */
      }
    }
  }

  /**
   * Resume the requesting Session and restore the Agent preset it ran under.
   *
   * `AgentLoop.resume` rebuilds the Session log but not the Session-scoped
   * composition: without the `setup` callback the resumed Agent only sees
   * Host-level tools. That is the difference between a human/UI restart (whose
   * page reconnect goes through the Session controller, which mounts the
   * preset) and this post-restart auto-resume. Mounting the recorded preset in
   * `setup` keeps both paths' tool sets identical. A failed mount is reported
   * on the completion message instead of silently resuming a partial Agent.
   *
   * @param sessionId - requesting Session identity.
   * @returns the live Agent and, when a preset was expected, its restore result.
   */
  async function ensureLiveAgent(sessionId) {
    const agentOptions = await readLastAgentOptions(sessionId);
    const recordedPreset = await readSessionAgentPreset(sessionId);
    const presets = safeGet(ctx, 'agentPresets');
    /** @type {undefined | { agentPreset: string, status: 'pending'|'restored'|'failed', error?: string }} */
    const presetRestore =
      recordedPreset === undefined
        ? undefined
        : { agentPreset: recordedPreset ?? 'default', status: 'pending' };
    const failPreset = (message) => {
      if (presetRestore === undefined || presetRestore.status === 'failed') return;
      presetRestore.status = 'failed';
      presetRestore.error = message;
      log(`restoring the agent preset of ${sessionId} failed: ${message}`);
    };
    const settlePreset = (agent) => {
      if (presetRestore === undefined || presetRestore.status === 'failed') return;
      if (typeof presets?.composedPreset !== 'function') {
        /* Older registries cannot verify; trust the setup mount result. */
        if (presetRestore.status === 'pending') presetRestore.status = 'restored';
        return;
      }
      let mounted;
      try {
        mounted = presets.composedPreset(agent.ctx);
      } catch (error) {
        mounted = undefined;
        log(`reading the mounted agent preset of ${sessionId} failed: ${messageOf(error)}`);
      }
      if (typeof mounted === 'string' && mounted.length > 0) {
        presetRestore.agentPreset = mounted;
        presetRestore.status = 'restored';
        return;
      }
      failPreset(
        recordedPreset === null
          ? 'the resumed Agent runs without the configured default Agent preset'
          : `the resumed Agent runs without its recorded Agent preset "${String(recordedPreset)}"`,
      );
    };
    let setup;
    if (recordedPreset !== undefined && (presets === undefined || typeof presets.mount !== 'function')) {
      failPreset('the agentPresets service is unavailable');
    } else if (recordedPreset !== undefined) {
      setup = async (agentCtx) => {
        try {
          const mounted = await presets.mount(agentCtx, recordedPreset ?? undefined);
          if (presetRestore !== undefined && typeof mounted?.id === 'string' && mounted.id.length > 0) {
            presetRestore.agentPreset = mounted.id;
          }
          if (presetRestore !== undefined) presetRestore.status = 'restored';
        } catch (error) {
          failPreset(messageOf(error));
        }
      };
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const live = safeGet(ctx, 'agents')?.get?.(sessionId);
      if (live !== undefined) {
        settlePreset(live);
        return { agent: live, presetRestore };
      }
      try {
        const handle = await ctx.agents.resume({
          resumeSessionId: sessionId,
          ...(agentOptions === undefined ? {} : { agentOptions }),
          ...(setup === undefined ? {} : { setup }),
        });
        settlePreset(handle.agent);
        const modelSuffix = agentOptions === undefined ? '' : ` (model ${agentOptions.provider}/${agentOptions.model})`;
        const presetSuffix =
          presetRestore === undefined ? '' : ` (agent preset ${presetRestore.agentPreset}: ${presetRestore.status})`;
        log(`resumed requester session ${sessionId}${modelSuffix}${presetSuffix}`);
        return { agent: handle.agent, presetRestore };
      } catch (error) {
        const raced = safeGet(ctx, 'agents')?.get?.(sessionId);
        if (raced !== undefined) {
          settlePreset(raced);
          return { agent: raced, presetRestore };
        }
        const message = messageOf(error);
        if (/already (registered|exists|owned|live)/i.test(message)) {
          await sleep(250);
          continue;
        }
        if (/not found|does not exist|ENOENT|no such/i.test(message)) {
          if (attempt >= 6) throw error;
          await sleep(300);
          continue;
        }
        throw error;
      }
    }
    throw new Error(`无法恢复发起重启的会话 ${sessionId}`);
  }

  async function waitAgentIdle(agent) {
    if (agent.status !== 'running') return;
    await Promise.race([agent.whenIdle(), sleep(SESSION_IDLE_TIMEOUT_MS)]);
  }

  /**
   * Resume one persisted Session and deliver its post-restart notice. Resuming
   * also closes an interrupted turn (dangerous mode) with the session repair.
   * @returns a per-session delivery result for the status/lastRestart report.
   */
  async function deliverToSession(sessionId, buildText) {
    const { agent, presetRestore } = await ensureLiveAgent(sessionId);
    await waitAgentIdle(agent);
    agent.followup(restartMessage(buildText(agent, presetRestore), 'dsh-restart'));
    await sleep(250);
    try {
      await ctx.sessions.flush(agent.session);
    } catch (flushError) {
      log(`post-restart notification flush failed: ${messageOf(flushError)}`);
    }
    return {
      sessionId,
      status: 'delivered',
      ...(presetRestore === undefined
        ? {}
        : {
            agentPreset: presetRestore.agentPreset,
            presetStatus: presetRestore.status,
            ...(presetRestore.error === undefined ? {} : { presetError: presetRestore.error }),
          }),
    };
  }

  /**
   * Deliver a pending resume report when a session becomes live again.
   * @param {object} agent - the live agent created/resumed for the session.
   * @param {string} sessionId - session identity.
   */
  function deliverPendingResumeReport(agent, sessionId) {
    const pending = pendingResumeReports.get(sessionId);
    if (pending === undefined) return;
    try {
      const text = renderResumeReportText(pending.checkpoint, sessionId, { restored: true });
      agent.inject(restartMessage(text, 'dsh-restart'));
      pendingResumeReports.delete(sessionId);
      if (state.lastRestart !== null && typeof state.lastRestart === 'object' && state.lastRestart.resume !== null && typeof state.lastRestart.resume === 'object') {
        const resume = state.lastRestart.resume;
        resume.pending = Math.max(0, (resume.pending ?? 0) - 1);
        resume.delivered = (resume.delivered ?? 0) + 1;
        // A report may have been parked because the session was not live at boot
        // (counted as missing); delivering it on agent/created turns it into a
        // resumed session for status accuracy.
        if ((resume.missing ?? 0) > 0) {
          resume.missing -= 1;
          resume.resumed = (resume.resumed ?? 0) + 1;
        }
        saveJsonFile(statePath, state);
      }
      log(`resume report delivered to ${sessionId} when its agent became live`);
    } catch (error) {
      log(`resume report delivery to ${sessionId} failed: ${messageOf(error)}`);
    }
  }

  /**
   * Deliver the mode-specific notices after a restart:
   *  - dangerous mode first notifies every interrupted AI (they were running
   *    outside safe state when the process exited), then every restart
   *    initiator of every type with the safe-state summary;
   *  - safe/coordinated modes notify their initiators;
   *  - affected sessions additionally receive the bounded resume report.
   */
  async function deliverIntent(intent, checkpoint) {
    const mode = intentMode(intent);
    const interruptedResults = [];
    const liveSessionIds = new Set();
    try {
      for (const session of ctx.sessions.list()) liveSessionIds.add(String(session.id));
    } catch (error) {
      log(`resume report: cannot list live sessions: ${messageOf(error)}`);
    }
    const resumeReport =
      checkpoint !== undefined && checkpoint !== null ? buildResumeReport(checkpoint, liveSessionIds) : null;
    const reportBySession = new Map(
      (Array.isArray(resumeReport?.sessions) ? resumeReport.sessions : []).map((session) => [session.sessionId, session]),
    );
    const requesterIds = new Set(
      (Array.isArray(intent.requesters) ? intent.requesters : [])
        .map((requester) => requester?.sessionId)
        .filter((sessionId) => typeof sessionId === 'string' && sessionId.length > 0),
    );
    const interruptedIds = new Set(
      (Array.isArray(intent.interrupted) ? intent.interrupted : [])
        .map((item) => item?.sessionId)
        .filter((sessionId) => typeof sessionId === 'string' && sessionId.length > 0),
    );
    const resumeTextFor = (sessionId, presetRestore, restoredOverride) => {
      if (checkpoint === undefined || checkpoint === null || !reportBySession.has(sessionId)) return '';
      return renderResumeReportText(checkpoint, sessionId, {
        restored: restoredOverride !== false,
        presetRestore,
      });
    };
    const markReport = (sessionId, patch) => {
      const entry = reportBySession.get(sessionId);
      if (entry !== undefined) Object.assign(entry, patch);
    };

    if (mode === MODE_DANGEROUS && cfg.dangerousNotifyInterrupted && Array.isArray(intent.interrupted)) {
      for (const item of intent.interrupted) {
        const sessionId = typeof item?.sessionId === 'string' && item.sessionId.length > 0 ? item.sessionId : undefined;
        if (sessionId === undefined) {
          interruptedResults.push({ sessionId: null, status: 'skipped', reason: 'interrupted entry has no session id' });
          continue;
        }
        try {
          const result = await deliverToSession(sessionId, (_agent, presetRestore) =>
            interruptedText(intent, item, presetRestore, resumeTextFor(sessionId, presetRestore)),
          );
          interruptedResults.push(result);
          markReport(sessionId, { restored: true, delivered: true });
          log(`dangerous-restart interruption notice delivered to ${sessionId}`);
        } catch (error) {
          interruptedResults.push({ sessionId, status: 'failed', error: messageOf(error) });
          markReport(sessionId, { failed: true });
          log(`dangerous-restart interruption notice to ${sessionId} failed: ${messageOf(error)}`);
        }
      }
    }
    // A roll-call wait that expired continues the restart anyway: the AIs still
    // outside safe state were interrupted without ever getting the dangerous-mode
    // notice (they are recorded as timed out, not as `intent.interrupted`). Tell
    // each of them honestly, unless it is a requester or already handled above.
    if (mode === MODE_COORDINATED && cfg.coordinatedNotifyTimedOut) {
      for (const sessionId of new Set(statusSessionIds(intent.timedOutSessions))) {
        if (requesterIds.has(sessionId) || interruptedIds.has(sessionId)) continue;
        try {
          const result = await deliverToSession(sessionId, (_agent, presetRestore) =>
            timedOutText(intent, sessionId, presetRestore, resumeTextFor(sessionId, presetRestore)),
          );
          interruptedResults.push({ ...result, reason: 'timed-out' });
          markReport(sessionId, { restored: true, delivered: true });
          log(`roll-call timeout notice delivered to ${sessionId}`);
        } catch (error) {
          interruptedResults.push({ sessionId, status: 'failed', error: messageOf(error), reason: 'timed-out' });
          markReport(sessionId, { failed: true });
          log(`roll-call timeout notice to ${sessionId} failed: ${messageOf(error)}`);
        }
      }
    }
    const results = [];
    for (const requester of Array.isArray(intent.requesters) ? intent.requesters : []) {
      if (requester.sessionId === undefined || requester.sessionId.length === 0) {
        results.push({
          sessionId: null,
          status: 'skipped',
          reason: 'ui-triggered restart has no AI requester',
          source: requester.source,
          mode: requesterMode(requester),
        });
        continue;
      }
      try {
        const result = await deliverToSession(requester.sessionId, (_agent, presetRestore) =>
          completionText(intent, requester, presetRestore, {
            interruptedResults,
            resumeReport: resumeTextFor(requester.sessionId, presetRestore),
          }),
        );
        results.push({
          ...result,
          source: requester.source,
          mode: requesterMode(requester),
          safeState: isSafeStateRequester(requester),
        });
        markReport(requester.sessionId, { restored: true, delivered: true });
        log(
          `post-restart notification delivered to ${requester.sessionId}` +
            ` (${requesterMode(requester)}: ${String(result.presetStatus ?? 'no preset')})`,
        );
      } catch (error) {
        results.push({
          sessionId: requester.sessionId,
          status: 'failed',
          error: messageOf(error),
          source: requester.source,
          mode: requesterMode(requester),
          safeState: isSafeStateRequester(requester),
        });
        markReport(requester.sessionId, { failed: true });
        log(`post-restart notification to ${requester.sessionId} failed: ${messageOf(error)}`);
      }
    }

    // Sessions that were neither requesters nor force-interrupted still receive
    // their checkpoint report if they had open calls/jobs or could not be restored.
    if (resumeReport !== null) {
      for (const entry of resumeReport.sessions) {
        if (entry.delivered || entry.failed || entry.needsReport !== true) continue;
        if (requesterIds.has(entry.sessionId) || interruptedIds.has(entry.sessionId)) continue;
        const text = renderResumeReportText(checkpoint, entry.sessionId, { restored: entry.restored });
        if (text.length === 0) continue;
        const agents = safeGet(ctx, 'agents');
        const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(entry.sessionId) : undefined;
        if (agent !== undefined && agent !== null && typeof agent.inject === 'function') {
          try {
            agent.inject(restartMessage(text, 'dsh-restart'));
            entry.delivered = true;
            log(`resume report injected into ${entry.sessionId}`);
          } catch (error) {
            entry.failed = true;
            log(`resume report injection into ${entry.sessionId} failed: ${messageOf(error)}`);
          }
        } else {
          pendingResumeReports.set(entry.sessionId, { checkpoint, sessionId: entry.sessionId });
          entry.pending = true;
          log(`resume report parked for ${entry.sessionId} (session not live yet)`);
        }
      }
    }

    if (state.lastRestart !== null && typeof state.lastRestart === 'object') {
      const completedAt = Date.now();
      state.lastRestart.completedAt = completedAt;
      state.lastRestart.tookMs =
        completedAt - (state.lastRestart.requestedAt ?? state.lastRestart.bootStartedAt ?? completedAt);
      state.lastRestart.results = results;
      state.lastRestart.interruptedResults = interruptedResults;
      state.lastRestart.safeState = summarizeSafeState(intent, results, interruptedResults);
      // Persist the roll-call outcome (hotfix.9): the status/CLI must show which
      // AIs were still outside safe state when the wait expired.
      state.lastRestart.timedOutSessions = Array.isArray(intent.timedOutSessions)
        ? statusSessionIds(intent.timedOutSessions)
        : [];
      state.lastRestart.coordinatedDeadlineAt =
        typeof intent.coordinatedDeadlineAt === 'number' ? intent.coordinatedDeadlineAt : null;
      state.lastRestart.resume = resumeReport === null ? null : summarizeResumeReport(resumeReport);
      if (state.lastRestart.resume !== null) {
        state.lastRestart.resume.checkpointStatus = checkpoint === undefined || checkpoint === null ? 'unavailable' : 'written';
      }
      state.lastRestart.checkpoint =
        intent.checkpoint !== undefined && intent.checkpoint !== null
          ? intent.checkpoint
          : checkpoint === undefined || checkpoint === null
            ? { status: 'unavailable' }
            : { status: 'written', at: checkpoint.at, totals: checkpoint.totals, file: CHECKPOINT_FILE };
      // The restart completed and its notices were delivered: a failure recorded
      // by an earlier attempt is no longer the current state.
      state.lastError = undefined;
      saveJsonFile(statePath, state);
      // Refresh the human/CLI snapshot once delivery has finalized lastRestart;
      // otherwise status.json keeps the previous boot's restart summary.
      writeStatusSnapshot();
    }
    removeFile(intentPath);
    log(
      `post-restart delivery complete mode=${mode} ${JSON.stringify({ results, interruptedResults, resume: state.lastRestart?.resume ?? null })}`,
    );
  }

  /** Machine-readable safe-state report used by the Client toast and status. */
  function summarizeSafeState(intent, requesterResults, interruptedResults) {
    const mode = intentMode(intent);
    const requesters = Array.isArray(intent.requesters) ? intent.requesters : [];
    // Safe-state members: safe/coordinated users plus the dangerous initiator.
    const safeMembers = requesters
      .filter(
        (requester) =>
          requesterMode(requester) === MODE_SAFE ||
          requesterMode(requester) === MODE_COORDINATED ||
          requesterMode(requester) === MODE_DANGEROUS,
      )
      .map((requester) => requester.sessionId)
      .filter((sessionId) => typeof sessionId === 'string' && sessionId.length > 0);
    const dangerousRequesters = requesters
      .filter((requester) => requesterMode(requester) === MODE_DANGEROUS)
      .map((requester) => requester.sessionId)
      .filter((sessionId) => typeof sessionId === 'string' && sessionId.length > 0);
    const interrupted = Array.isArray(intent.interrupted) ? intent.interrupted : [];
    const interruptedIds = interrupted
      .map((item) => (typeof item?.sessionId === 'string' ? item.sessionId : undefined))
      .filter((sessionId) => sessionId !== undefined);
    // Roll-call timeouts are outside safe state too (hotfix.9): list them with
    // the force-interrupted ids so the Client toast and status tell the truth.
    const timedOutIds = statusSessionIds(intent.timedOutSessions);
    const delivered = interruptedResults.filter((result) => result.status === 'delivered').length;
    const failed = interruptedResults.filter((result) => result.status !== 'delivered').length;
    return {
      mode,
      modeLabel: modeLabel(mode),
      definition: SAFE_STATE_DEFINITION,
      // Safe/coordinated restarts enter safe state by definition; a dangerous
      // restart does so only when it interrupted no AI: its initiator belongs to
      // safe state, and only interrupted AIs stay outside safe state.
      enteredSafeState: mode === MODE_DANGEROUS ? interrupted.length === 0 : true,
      safeStateSessionIds: safeMembers,
      dangerousRequesterSessionIds: dangerousRequesters,
      notSafeStateSessionIds: [...new Set([...interruptedIds, ...timedOutIds])],
      timedOutCount: timedOutIds.length,
      timedOutSessionIds: timedOutIds,
      interruptedCount: interrupted.length,
      interruptedSessionIds: interruptedIds,
      interruptedDelivered: delivered,
      interruptedFailed: failed,
      requesterDelivered: requesterResults.filter((result) => result.status === 'delivered').length,
      requesterFailed: requesterResults.filter((result) => result.status === 'failed').length,
    };
  }

  const bootIntent = readJsonFile(intentPath);
  if (bootIntent !== undefined && bootIntent !== null && bootIntent.version === 1 && Array.isArray(bootIntent.requesters)) {
    const bootMode = intentMode(bootIntent);
    const bootCheckpointRaw = readJsonFile(checkpointPath);
    const bootCheckpoint =
      bootCheckpointRaw !== null &&
      typeof bootCheckpointRaw === 'object' &&
      bootCheckpointRaw.version === CHECKPOINT_VERSION &&
      bootCheckpointRaw.requestId === bootIntent.requestId
        ? bootCheckpointRaw
        : undefined;
    if (bootCheckpointRaw !== undefined && bootCheckpointRaw !== null && bootCheckpoint === undefined) {
      log(`checkpoint ignored: it does not match restart request ${String(bootIntent.requestId)}`);
    }
    log(`resuming boot after ${bootMode} restart request ${String(bootIntent.requestId)}`);
    state.lastRestart = {
      requestId: bootIntent.requestId,
      requestedAt: bootIntent.requestedAt,
      bootStartedAt: state.bootStartedAt,
      completedAt: null,
      tookMs: null,
      trigger: bootIntent.trigger,
      mode: bootMode,
      modeLabel: modeLabel(bootMode),
      dangerous: bootMode === MODE_DANGEROUS,
      uiRequested: bootIntent.uiRequested === true,
      requesters: bootIntent.requesters.map((requester) => ({
        sessionId: requester.sessionId,
        source: requester.source,
        mode: requesterMode(requester),
        safeState: isSafeStateRequester(requester),
        reason: requester.reason,
        requestedAt: requester.requestedAt,
      })),
      safeStateSessions: Array.isArray(bootIntent.safeStateSessions) ? bootIntent.safeStateSessions : [],
      broadcast: bootIntent.broadcast ?? null,
      interrupted: Array.isArray(bootIntent.interrupted) ? bootIntent.interrupted : [],
      results: null,
      interruptedResults: null,
      safeState: null,
      checkpoint:
        bootIntent.checkpoint !== undefined && bootIntent.checkpoint !== null
          ? bootIntent.checkpoint
          : bootCheckpoint === undefined
            ? { status: 'unavailable' }
            : { status: 'written', at: bootCheckpoint.at, totals: bootCheckpoint.totals, file: CHECKPOINT_FILE },
      resume: null,
      bootIdBefore: bootIntent.bootIdBefore,
      bootId: state.bootId,
    };
    saveJsonFile(statePath, state);
    const beginDelivery = () => {
      const timer = setTimeout(() => {
        void deliverIntent(bootIntent, bootCheckpoint).catch((error) => log(`post-restart delivery crashed: ${messageOf(error)}`));
      }, cfg.bootDeliveryDelayMs);
      if (typeof timer?.unref === 'function') timer.unref();
    };
    try {
      const ready = safeGet(ctx, 'appReady');
      if (ready !== undefined && typeof ready.onReady === 'function') {
        ctx.effect(() => ready.onReady(beginDelivery), 'dsh-restart: post-restart delivery');
      } else {
        beginDelivery();
      }
    } catch (error) {
      log(`scheduling post-restart delivery failed: ${messageOf(error)}`);
      beginDelivery();
    }
  } else {
    // A checkpoint without a restart intent belongs to a crashed/aborted attempt.
    removeFile(checkpointPath);
  }

  /* ---------------------------------------------------------- lifecycle ---- */

  ctx.effect(
    () => () => {
      disposed = true;
      if (pollTimer !== undefined) clearInterval(pollTimer);
      if (dangerousFinalizeTimer !== undefined) {
        clearTimeout(dangerousFinalizeTimer);
        dangerousFinalizeTimer = undefined;
      }
    },
    'dsh-restart: watcher lifecycle',
  );

  try {
    ctx.on('agent/status', (payload) => {
      if (payload?.status === 'running') lastIdleAt = 0;
      maybeFinalize();
    });
    ctx.on('agent/disposed', () => {
      maybeFinalize();
    });
    ctx.effect(
      () => {
        const off = ctx.on('agent/created', (payload) => {
          const agent = payload?.agent;
          if (agent === undefined || agent === null) return;
          const sessionId = String(agent.id);
          if (pendingResumeReports.has(sessionId)) deliverPendingResumeReport(agent, sessionId);
        });
        return () => {
          try {
            off();
          } catch {
            /* disposed */
          }
        };
      },
      'dsh-restart: pending resume reports',
    );
  } catch (error) {
    log(`agent event subscription failed: ${messageOf(error)}`);
  }
  pollTimer = setInterval(maybeFinalize, cfg.pollMs);
  if (typeof pollTimer?.unref === 'function') pollTimer.unref();

  /* ------------------------------------------------------------ modules ---- */

  // Module 2: the AI restart tools (safe / coordinated / dangerous / safeguard
  // / read-only status) and the mode-aware `restart-dsh` skill.
  // Module 3: human entry — the web button is rendered by client.js; the
  // Desktop build deliberately has no human entry (the official app owns the tray).
  registerAiRestart(ctx, {
    requestRestart,
    holdToolCall,
    permissionOf: permissionInfo,
    platform,
    log,
    unlockTtlMs: cfg.unlockTtlMs,
    safeStateAccessOpen,
    statusSummary,
  });
  registerHumanEntry(ctx, { platform, log });

  /* ---------------------------------------------------------- http routes -- */

  const jsonResponse = (payload, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  const errorResponse = (message, status = 500) => jsonResponse({ ok: false, error: message }, status);

  async function readJsonBody(request) {
    try {
      const text = await request.text();
      if (text.length === 0) return {};
      const parsed = JSON.parse(text);
      return parsed !== null && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  ctx.inject(['connection'], (scope) => {
    try {
      scope.effect(
        () =>
          scope.connection.fetch.register({
            path: `${API_PREFIX}/status`,
            methods: ['GET'],
            requestBody: 'buffered',
            fetch: async () => jsonResponse(statusValue()),
          }),
        'dsh-restart: status route',
      );
      scope.effect(
        () =>
          scope.connection.fetch.register({
            path: `${API_PREFIX}/request`,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: async (request) => {
              try {
                const body = await readJsonBody(request);
                const mode = body.mode === MODE_COORDINATED ? MODE_COORDINATED : body.mode === MODE_DANGEROUS ? MODE_DANGEROUS : MODE_SAFE;
                if (mode === MODE_DANGEROUS && body.confirmed !== true) {
                  return errorResponse('强制重启需要界面长按 5 秒确认', 400);
                }
                const result = requestRestart({
                  source: 'ui',
                  mode,
                  reason: typeof body.reason === 'string' ? body.reason : undefined,
                });
                return jsonResponse({ ok: true, ...result, status: statusValue() });
              } catch (error) {
                return errorResponse(messageOf(error));
              }
            },
          }),
        'dsh-restart: request route',
      );
      // Human-only: never exposed as an AI tool. Only the authenticated UI
      // (or the testMode self-test route) reaches this endpoint.
      scope.effect(
        () =>
          scope.connection.fetch.register({
            path: `${API_PREFIX}/shutdown`,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: async (request) => {
              if (shutdownInProgress) return jsonResponse({ ok: true, shuttingDown: true, alreadyShuttingDown: true });
              const body = await readJsonBody(request);
              const mode = body.mode === MODE_COORDINATED ? MODE_COORDINATED : body.mode === MODE_DANGEROUS ? MODE_DANGEROUS : MODE_SAFE;
              if (mode === MODE_DANGEROUS && body.confirmed !== true) {
                return errorResponse('强制关闭需要界面长按 5 秒确认', 400);
              }
              const reason = typeof body.reason === 'string' ? body.reason : undefined;
              // Optional escape-pod linkage: only an explicit `true` closes the
              // pod's running commands before DSH exits. A missing pod service
              // is skipped (and logged) by requestShutdown, never fatal.
              const closeEscapePod = body.closeEscapePod === true;
              setTimeout(() => {
                void requestShutdown(mode, reason, closeEscapePod).catch((error) =>
                  log(`shutdown crashed: ${messageOf(error)}`),
                );
              }, 150);
              return jsonResponse({ ok: true, shuttingDown: true, mode, closeEscapePod });
            },
          }),
        'dsh-restart: shutdown route',
      );
      // Optional companion plugin: whether the escape pod's Host service is
      // present and exposes `shutdown()`. The client half asks before offering
      // the「同时关闭正在运行的逃生舱」checkbox, so a DSH without that package
      // answers `available:false` instead of failing the request.
      scope.effect(
        () =>
          scope.connection.fetch.register({
            path: `${API_PREFIX}/pod`,
            methods: ['GET'],
            requestBody: 'buffered',
            fetch: async () => jsonResponse({ ok: true, available: escapePodAvailable() }),
          }),
        'dsh-restart: pod route',
      );
      // Settings page config (client.js): read/update `rollCallWaitMs` as a
      // runtime setting. The old route wrote the profile patch through
      // configEditor, which makes the Loader reactivate this row live; that is
      // exactly the kind of needless hot reload a scalar knob must avoid. Saving
      // to the runtime file is effective immediately and touches neither the
      // patch nor any live agent/session.
      scope.effect(
        () =>
          scope.connection.fetch.register({
            path: `${API_PREFIX}/config`,
            methods: ['GET', 'POST'],
            requestBody: 'buffered',
            fetch: async (request) => {
              try {
                if (request.method === 'POST') {
                  const body = await readJsonBody(request);
                  const rollCallWaitMs = normalizeRuntimeRollCallWaitMs(body.rollCallWaitMs);
                  if (rollCallWaitMs === undefined) {
                    return errorResponse('rollCallWaitMs 必须是 0 或 1000..3600000 的整数', 400);
                  }
                  if (!writeRuntimeSettings(stateDir, { rollCallWaitMs })) {
                    return errorResponse('写入运行设置失败（状态目录不可写）', 500);
                  }
                  // Effective immediately: every later read (status, deadline
                  // checks, the next roll call) sees the new value. No plugin
                  // reload, so no live agent/session is touched.
                  cfg.rollCallWaitMs = rollCallWaitMs;
                  log(`rollCallWaitMs updated to ${String(rollCallWaitMs)}ms via runtime settings`);
                  return jsonResponse({
                    ok: true,
                    rollCallWaitMs: cfg.rollCallWaitMs,
                    writable: true,
                    persisted: true,
                  });
                }
                return jsonResponse({
                  ok: true,
                  rollCallWaitMs: cfg.rollCallWaitMs,
                  writable: true,
                  persisted: readRuntimeSettings(stateDir).rollCallWaitMs !== undefined,
                });
              } catch (error) {
                return errorResponse(messageOf(error), 500);
              }
            },
          }),
        'dsh-restart: config route',
      );
      log(`registered ${API_PREFIX} routes`);
    } catch (error) {
      log(`API route registration failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  });


  /* --------------------------------------------------------- test routes --- */

  if (cfg.testMode) {
    const writeNodeJson = (res, status, value) => {
      try {
        const body = JSON.stringify(value);
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(body);
      } catch {
        /* client disconnected */
      }
    };
    const readNodeJson = async (req) => {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error('request body too large');
        chunks.push(chunk);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.length === 0) return {};
      try {
        const parsed = JSON.parse(text);
        return parsed !== null && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    };
    // Test routes are mounted only when BOTH the web server and the Connection
    // service are present: every handler authenticates first, so without a
    // Connection service there is no way to admit a request and no route is
    // registered at all.
    ctx.inject(['webServer', 'connection'], (scope) => {
      /**
       * Reject an unauthenticated test-route request before its handler runs.
       * Fail closed: any trust-check failure is treated as a 403.
       * @returns truthy when the request was already answered.
       */
      const rejectUntrusted = (req, res) => {
        let rejection;
        try {
          rejection = scope.connection.requestRejection({ headers: req.headers });
        } catch (error) {
          log(`test route auth check failed: ${messageOf(error)}`);
          writeNodeJson(res, 403, { ok: false, error: 'forbidden' });
          return true;
        }
        if (rejection === 401 || rejection === 403) {
          writeNodeJson(res, rejection, {
            ok: false,
            error: rejection === 401 ? 'unauthorized' : 'forbidden',
          });
          return true;
        }
        return false;
      };
      const register = (path, handler) =>
        scope.effect(
          () =>
            scope.webServer.register({
              kind: 'exact',
              path,
              handler: (req, res) => {
                if (rejectUntrusted(req, res)) return undefined;
                return handler(req, res);
              },
            }),
          `dsh-restart test route ${path}`,
        );
      register('/dsh-restart-test/status', (_req, res) => {
        writeNodeJson(res, 200, statusValue());
      });
      register('/dsh-restart-test/state', (_req, res) => {
        writeNodeJson(res, 200, {
          state,
          stateDir,
          intent: readJsonFile(intentPath) ?? null,
          home,
          relauncherPath: RELAUNCHER_PATH,
        });
      });
      register('/dsh-restart-test/diagnostics', (_req, res) => {
        let hasConnection = false;
        let hasWebServer = false;
        let hasAgents = false;
        try {
          hasConnection = ctx.get('connection') !== undefined;
          hasWebServer = ctx.get('webServer') !== undefined;
          hasAgents = ctx.get('agents') !== undefined;
        } catch {
          /* diagnostics only */
        }
        writeNodeJson(res, 200, {
          ok: true,
          hasConnection,
          hasWebServer,
          hasAgents,
          apiPrefix: API_PREFIX,
          stateDir,
          lastError: state.lastError ?? null,
        });
      });
      register('/dsh-restart-test/create-session', async (req, res) => {
        try {
          const body = await readNodeJson(req);
          const sessionId = `session-test-${randomUUID()}`;
          const options = { sessionId, meta: { cwd: process.cwd() } };
          if (typeof body.provider === 'string' && typeof body.model === 'string') {
            options.agentOptions = { provider: body.provider, model: body.model };
          }
          const handle = await ctx.agents.create(options);
          writeNodeJson(res, 200, { ok: true, sessionId: String(handle.agent.id) });
        } catch (error) {
          writeNodeJson(res, 500, { ok: false, error: messageOf(error) });
        }
      });
      register('/dsh-restart-test/start-turn', async (req, res) => {
        try {
          const body = await readNodeJson(req);
          const agent = typeof body.sessionId === 'string' ? ctx.agents.get(body.sessionId) : undefined;
          if (agent === undefined) throw new Error(`no live agent for session ${typeof body.sessionId === 'string' ? body.sessionId : 'undefined'}`);
          agent.followup(
            restartMessage(typeof body.text === 'string' && body.text.length > 0 ? body.text : 'start a long test turn', 'dsh-restart'),
          );
          writeNodeJson(res, 200, { ok: true, sessionId: String(agent.id), status: agent.status });
        } catch (error) {
          writeNodeJson(res, 500, { ok: false, error: messageOf(error) });
        }
      });
      register('/dsh-restart-test/trigger', async (req, res) => {
        try {
          const body = await readNodeJson(req);
          const result = requestRestart({
            source: body.source === 'ui' ? 'ui' : 'tool',
            sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
            reason: typeof body.reason === 'string' ? body.reason : 'test restart',
            mode: typeof body.mode === 'string' ? body.mode : undefined,
          });
          writeNodeJson(res, 200, { ok: true, result, status: statusValue() });
        } catch (error) {
          writeNodeJson(res, 500, { ok: false, error: messageOf(error) });
        }
      });
      register('/dsh-restart-test/tool-call', async (req, res) => {
        try {
          const body = await readNodeJson(req);
          const agent = typeof body.sessionId === 'string' ? ctx.agents.get(body.sessionId) : undefined;
          if (agent === undefined) throw new Error('no live agent for tool-call test');
          const session = agent.session;
          // Deterministic full access so the tool does not ask the missing human.
          session.append('sandbox/mode', { mode: 'danger-full-access', source: 'delegation' });
          session.append('approval/policy', { policy: 'never', source: 'delegation' });
          const controller = new AbortController();
          const callId = `call-test-${randomUUID()}`;
          const reason = typeof body.reason === 'string' ? body.reason : 'held-call test';
          // Simulate a real model step that requested this tool, so the restart
          // resume repair has a genuine dangling tool call to close.
          const turn = 1;
          session.append('turn/start', { turn });
          session.append('step/start', { turn, step: 1 });
          session.append('assistant/message', {
            turn,
            step: 1,
            message: {
              id: randomUUID(),
              role: 'assistant',
              content: [{ type: 'tool-call', id: callId, name: TOOL_NAME_ALL_WAIT, arguments: JSON.stringify({ reason }) }],
              source: { kind: 'model', provider: 'test', model: 'test' },
            },
            stream: [],
          }, { surfaceOp: 'append' });
          session.append('tool/call', { turn, step: 1, callId, name: TOOL_NAME_ALL_WAIT, arguments: JSON.stringify({ reason }) });
          const execution = ctx.tools.execute({
            callId,
            name: TOOL_NAME_ALL_WAIT,
            arguments: { reason },
            agent,
            signal: controller.signal,
          });
          execution.then(
            (result) => log(`test held tool-call resolved isError=${String(result?.isError)}`),
            (error) => log(`test held tool-call rejected: ${messageOf(error)}`),
          );
          writeNodeJson(res, 200, { ok: true, sessionId: String(agent.id), callId, held: true });
        } catch (error) {
          writeNodeJson(res, 500, { ok: false, error: messageOf(error) });
        }
      });
      register('/dsh-restart-test/cancel-turn', async (req, res) => {
        try {
          const body = await readNodeJson(req);
          const agent = typeof body.sessionId === 'string' ? ctx.agents.get(body.sessionId) : undefined;
          if (agent === undefined) throw new Error(`no live agent for session ${typeof body.sessionId === 'string' ? body.sessionId : 'undefined'}`);
          agent.cancel({ kind: 'user' });
          writeNodeJson(res, 200, { ok: true, sessionId: String(agent.id), status: agent.status });
        } catch (error) {
          writeNodeJson(res, 500, { ok: false, error: messageOf(error) });
        }
      });
      register('/dsh-restart-test/relaunch-check', async (_req, res) => {
        try {
          const dummy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          dummy.unref();
          const marker = join(stateDir, 'relaunch-check-marker.txt');
          removeFile(marker);
          const checkSpecPath = join(stateDir, 'relaunch-check-spec.json');
          const checkLogPath = join(stateDir, 'relaunch-check.log');
          try {
            writeFileSync(checkLogPath, `[${new Date().toISOString()}] [dsh-restart] relaunch-check dispatch\n`);
          } catch {
            /* diagnostics */
          }
          const checkSpec = {
            version: 1,
            pid: dummy.pid,
            execPath: process.execPath,
            execArgv: [],
            args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'relaunch-check-ok')`],
            cwd: stateDir,
            logPath: checkLogPath,
            waitTimeoutMs: 15000,
            delayMs: 100,
          };
          if (!saveJsonFile(checkSpecPath, checkSpec)) throw new Error('无法写入 relaunch-check spec');
          const helper = spawn(process.execPath, [RELAUNCHER_PATH, checkSpecPath], {
            cwd: stateDir,
            env: process.env,
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          helper.unref();
          writeNodeJson(res, 200, { ok: true, dummyPid: dummy.pid, marker, checkLogPath, helperPid: helper.pid });
        } catch (error) {
          writeNodeJson(res, 500, { ok: false, error: messageOf(error) });
        }
      });
      register('/dsh-restart-test/shutdown', async (req, res) => {
        try {
          if (shutdownInProgress) {
            writeNodeJson(res, 200, { ok: true, shuttingDown: true, alreadyShuttingDown: true });
            return;
          }
          const body = await readNodeJson(req);
          const mode = body.mode === MODE_COORDINATED ? MODE_COORDINATED : body.mode === MODE_DANGEROUS ? MODE_DANGEROUS : MODE_SAFE;
          // A dangerous shutdown still requires the same explicit hold
          // confirmation as the production route.
          if (mode === MODE_DANGEROUS && body.confirmed !== true) {
            writeNodeJson(res, 400, { ok: false, error: '强制关闭需要界面长按 5 秒确认' });
            return;
          }
          const reason = typeof body.reason === 'string' ? body.reason : undefined;
          setTimeout(() => {
            void requestShutdown(mode, reason).catch((error) => log(`test shutdown crashed: ${messageOf(error)}`));
          }, 150);
          writeNodeJson(res, 200, { ok: true, shuttingDown: true, mode });
        } catch (error) {
          writeNodeJson(res, 500, { ok: false, error: messageOf(error) });
        }
      });
      log('registered /dsh-restart-test routes (testMode)');
    });
  }
}
