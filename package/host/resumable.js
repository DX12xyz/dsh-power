/**
 * Module 4 of 5 — `resumableToolCalls`, the cross-restart hold registry.
 *
 * The platform closes every tool call left open in a persisted log with a
 * synthetic `TOOL_OUTCOME_UNKNOWN` result when a Session is resumed
 * (`interruptedTurnClosers` in `@deepseek-ai/dsh-session`). A plugin whose tool
 * call can survive the restart (for example a command that runs outside the DSH
 * process tree) can ask this registry to hold its call instead:
 *
 * - `hold(callId, { tool, hint, deadlineMs })` records the intent durably
 *   *before* the restart checkpoint is written, so a later boot still knows the
 *   call is expected to be answered by its owner;
 * - before any Session is resumed on the new boot, every still-unsettled hold
 *   receives a provisional result, so the platform never appends its synthetic
 *   `TOOL_OUTCOME_UNKNOWN` closer for that call;
 * - `complete(callId, result)` writes the real result (or rewrites the
 *   provisional content through a `tool/result` surface replacement) exactly
 *   once;
 * - `fail(callId, reason)` writes the platform's own wording and code, so the
 *   model cannot tell a failed recovery apart from a native interrupted call;
 * - `deadlineMs` bounds the wait: after it passes the call is failed instead of
 *   hanging forever.
 *
 * This module owns the state machine and the event payload shaping only. It
 * receives every side effect through injected callbacks (`persist`,
 * `lookupCall`, `writeResult`), which keeps it unit-testable without a Cordis
 * Host context.
 */

/**
 * Service name under which the Host half provides the registry
 * (`ctx.get('resumableToolCalls')`).
 */
export const RESUME_SERVICE_NAME = 'resumableToolCalls';
/** Schema version of the durable holds file. */
export const RESUME_HOLDS_VERSION = 1;
/** Bounded registry sizes and field caps. */
export const RESUME_LIMITS = Object.freeze({
  holds: 64,
  callIdChars: 200,
  toolChars: 120,
  hintBytes: 4096,
  reasonChars: 400,
  deadlineMs: 24 * 60 * 60 * 1000,
  pendingTextChars: 1200,
});
/** Recovery code of the platform's synthetic interrupted-tool-result closer. */
export const UNKNOWN_OUTCOME_CODE = 'TOOL_OUTCOME_UNKNOWN';
/** Recovery code of the platform's closer for a call that never recorded a start. */
export const TOOL_NOT_STARTED_CODE = 'TOOL_NOT_STARTED';
/** Recovery error name of that closer. */
export const UNKNOWN_OUTCOME_NAME = 'ToolOutcomeUnknownError';

/**
 * Backoff of a settlement the session log refused because another writer (the
 * post-restart resume path) owns the Session's only write handle. A refusal is
 * never a settlement: the hold stays `held` and the write is retried until it
 * lands or its deadline fails the call.
 */
export const RESUME_WRITE_RETRY = Object.freeze({
  baseMs: 250,
  maxMs: 5000,
  /** How long one `complete`/`fail` keeps retrying in-line before returning to the caller. */
  waitMs: 8000,
});
/**
 * The platform's exact model-visible wording for an interrupted tool call
 * (`CLOSER_TEXT.interrupted.started` in `@deepseek-ai/dsh-session`). `fail()`
 * reproduces it verbatim so the model never sees a "different" failure.
 */
export const UNKNOWN_OUTCOME_TEXT =
  'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.';

/** Clamp a numeric deadline; invalid values fall back to the hard cap. */
function clampDeadline(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return RESUME_LIMITS.deadlineMs;
  if (value <= 0) return 1;
  return Math.min(Math.floor(value), RESUME_LIMITS.deadlineMs);
}

/** Bounded, JSON-safe copy of the resume hint (identities only, never argv). */
export function boundHint(hint) {
  const source = hint !== null && typeof hint === 'object' && !Array.isArray(hint) ? hint : {};
  let text;
  try {
    text = JSON.stringify(source);
  } catch {
    return {};
  }
  if (typeof text !== 'string') return {};
  // Keep the smallest stable subset that fits the byte budget: the contract
  // only needs opaque identifiers (for example a pod jobId).
  if (text.length <= RESUME_LIMITS.hintBytes) return JSON.parse(text);
  const bounded = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    const candidate = { ...bounded, [key]: value };
    if (JSON.stringify(candidate).length > RESUME_LIMITS.hintBytes) break;
    bounded[key] = value;
  }
  return bounded;
}

/**
 * Validate and bound one `hold()` descriptor.
 * @param {unknown} resume - `{ tool, hint, deadlineMs }` from the owning plugin.
 * @param {number} [now] - current epoch ms (defaults to `Date.now()`).
 * @returns {{tool: string, hint: object, deadlineMs: number, deadlineAt: number}}
 * @throws {TypeError} when the tool identity is missing.
 */
export function normalizeResumeDescriptor(resume, now = Date.now()) {
  if (resume === null || typeof resume !== 'object') {
    throw new TypeError('resumableToolCalls.hold: resume descriptor must be an object');
  }
  const tool = typeof resume.tool === 'string' ? resume.tool.trim().slice(0, RESUME_LIMITS.toolChars) : '';
  if (tool.length === 0) {
    throw new TypeError('resumableToolCalls.hold: resume.tool must be a non-empty string');
  }
  const deadlineMs = clampDeadline(resume.deadlineMs);
  return {
    tool,
    hint: boundHint(resume.hint),
    deadlineMs,
    deadlineAt: now + deadlineMs,
  };
}

/** Bounded call identity. */
export function normalizeCallId(callId) {
  if (typeof callId !== 'string' || callId.trim().length === 0) {
    throw new TypeError('resumableToolCalls: callId must be a non-empty string');
  }
  return callId.trim().slice(0, RESUME_LIMITS.callIdChars);
}

/** Normalize tool-result blocks (string shorthand allowed). */
function normalizeContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    blocks.push(block);
  }
  return blocks;
}

/** Normalize the optional `{message, info}` error envelope of a tool result. */
function normalizeError(error) {
  if (error === null || typeof error !== 'object') return undefined;
  if (error.info !== null && typeof error.info === 'object') {
    const info = {};
    for (const [key, value] of Object.entries(error.info)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') info[key] = value;
    }
    return Object.keys(info).length === 0 ? undefined : info;
  }
  const info = {};
  for (const key of ['name', 'code']) {
    if (typeof error[key] === 'string' && error[key].length > 0) info[key] = error[key];
  }
  return Object.keys(info).length === 0 ? undefined : info;
}

/**
 * Build the `tool/result` event data for one answered held call. The shape
 * mirrors `appendToolResult` in `@deepseek-ai/dsh-agent-loop`.
 * @param {{callId: string, turn: number, step: number, id: string, content: unknown, isError?: boolean, error?: unknown, meta?: unknown}} input
 * @returns {object} event data (without seq/time/surfaceOp).
 */
export function buildToolResultData(input) {
  const callId = String(input.callId);
  const data = {
    turn: input.turn,
    step: input.step,
    message: {
      id: input.id,
      role: 'tool',
      toolCallId: callId,
      isError: input.isError === true,
      source: { kind: 'tool', callId },
      content: normalizeContent(input.content),
    },
  };
  const info = normalizeError(input.error);
  // The platform rejects an `error` envelope on a non-error tool result
  // (`validateSessionEventData`), so a caller that forgets `isError: true`
  // keeps the text and loses only the envelope, never the whole write.
  if (info !== undefined && data.message.isError === true) data.error = info;
  if (input.meta !== undefined) data.meta = input.meta;
  return data;
}

/**
 * Platform-identical result for a call whose recovery failed.
 * @param {{callId: string, turn: number, step: number, id?: string}} input
 */
export function buildUnknownResult(input) {
  return buildToolResultData({
    callId: input.callId,
    turn: input.turn,
    step: input.step,
    id: input.id ?? `resumable-tool-result-${String(input.callId)}`,
    content: [{ type: 'text', text: UNKNOWN_OUTCOME_TEXT }],
    isError: true,
    error: { name: UNKNOWN_OUTCOME_NAME, code: UNKNOWN_OUTCOME_CODE },
  });
}

/** Honest provisional result written before a Session resumes. */
export function buildPendingText(resume) {
  const hint = JSON.stringify(resume?.hint ?? {});
  const head = `工具调用 ${String(resume?.tool ?? 'unknown')} 因 DSH 重启被挂起，命令仍由原进程负责；结果尚未产生，不要重跑，也不要假设已完成。`;
  const tail = `恢复标识：${hint.length > 600 ? `${hint.slice(0, 600)}…` : hint}`;
  const text = `${head}${tail}`;
  return text.length > RESUME_LIMITS.pendingTextChars
    ? `${text.slice(0, RESUME_LIMITS.pendingTextChars - 1)}…`
    : text;
}

/**
 * Provisional (non-error) result that keeps the platform from appending its own
 * unknown closer. `complete`/`fail` later rewrite only its content.
 * @param {{callId: string, turn: number, step: number, id: string, resume: object}} input
 */
export function buildPendingResult(input) {
  return buildToolResultData({
    callId: input.callId,
    turn: input.turn,
    step: input.step,
    id: input.id,
    content: [{ type: 'text', text: buildPendingText(input.resume) }],
    isError: false,
  });
}

/**
 * Result data for `complete(callId, payload)`.
 * @param {{callId: string, turn: number, step: number, id: string, payload: object}} input
 */
export function buildCompletedResult(input) {
  const payload = input.payload;
  if (payload === null || typeof payload !== 'object') {
    throw new TypeError('resumableToolCalls.complete: result payload must be an object');
  }
  return buildToolResultData({
    callId: input.callId,
    turn: input.turn,
    step: input.step,
    id: input.id,
    content: payload.content,
    isError: payload.isError === true,
    error: payload.error,
    ...(payload.meta === undefined ? {} : { meta: payload.meta }),
  });
}

/**
 * Replace only the content of an existing result event, preserving every other
 * field (the platform's `tool/result` surface replacement forbids changing more
 * than `message.content`).
 * @param {object} data - original event data.
 * @param {unknown} content - replacement blocks (a string becomes one text block).
 * @returns {object} replacement event data.
 */
export function replaceResultContent(data, content) {
  return {
    ...data,
    message: {
      ...data.message,
      content: normalizeContent(content),
    },
  };
}

/**
 * Locate one tool call in a Session's committed events.
 *
 * @param {readonly object[]} events - ascending `seq` events.
 * @param {string} callId - call to locate.
 * @returns {undefined | {callId: string, name: string, turn: number, step: number, callSeq: number, resultSeq: number | undefined, resultIsError: boolean | undefined}} the call, or `undefined`.
 */
export function locateToolCall(events, callId) {
  if (!Array.isArray(events) || typeof callId !== 'string' || callId.length === 0) return undefined;
  let located;
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'tool/call' && String(event.data?.callId) === callId) {
      located = {
        callId,
        name: typeof event.data?.name === 'string' ? event.data.name : '',
        turn: typeof event.data?.turn === 'number' ? event.data.turn : 1,
        step: typeof event.data?.step === 'number' ? event.data.step : 1,
        callSeq: typeof event.seq === 'number' ? event.seq : undefined,
        resultSeq: undefined,
        resultIsError: undefined,
      };
    } else if (
      located !== undefined &&
      event.type === 'tool/result' &&
      (String(event.data?.message?.toolCallId) === callId || String(event.data?.message?.source?.callId) === callId)
    ) {
      if (typeof event.seq === 'number') located.resultSeq = event.seq;
      located.resultIsError = event.data?.message?.isError === true;
    }
  }
  if (located === undefined || located.callSeq === undefined) return undefined;
  return located;
}

/**
 * Whether one committed `tool/result` payload is the platform's own synthetic
 * closer (`interruptedTurnClosers` in `@deepseek-ai/dsh-session`) rather than a
 * real answer. Only such a node may be rewritten once the resume path has
 * already appended it: the platform allows a `tool/result` replacement to
 * change `message.content` only, so the closer's error envelope survives.
 *
 * @param {unknown} data - `event.data` of a `tool/result` event.
 * @returns {boolean} true when this is the synthetic unknown/not-started closer.
 */
export function isSyntheticCloserResult(data) {
  if (data === null || typeof data !== 'object') return false;
  if (data.message === null || typeof data.message !== 'object') return false;
  if (data.message.isError !== true) return false;
  const code = data.error?.code;
  return code === UNKNOWN_OUTCOME_CODE || code === TOOL_NOT_STARTED_CODE;
}

/**
 * Classify the `tool/result` that currently answers one held call.
 *
 * @param {unknown} data - `event.data` of the result event.
 * @param {object} [entry] - the hold record (its provisional message identity).
 * @returns {'provisional' | 'synthetic-closer' | 'final'} `'provisional'` is
 *   our own pre-resume marker, `'synthetic-closer'` the platform's fabricated
 *   unknown outcome (recoverable), `'final'` a real answer that must not move.
 */
export function classifyAnsweredResult(data, entry) {
  if (data === null || typeof data !== 'object') return 'final';
  const messageId = data.message?.id;
  const pendingMessageId = entry?.pendingMessageId;
  if (typeof pendingMessageId === 'string' && pendingMessageId.length > 0 && messageId === pendingMessageId) return 'provisional';
  if (entry?.pendingWritten === true && typeof messageId === 'string' && messageId.includes(`-resumable-tool-result-${String(entry.callId ?? '')}`)) {
    return 'provisional';
  }
  if (isSyntheticCloserResult(data)) return 'synthetic-closer';
  return 'final';
}

/**
 * Decide how one held call's result enters a Session log that may already have
 * an answer for it. The caller executes the plan; keeping the decision here
 * makes the resume/settlement race testable without a DSH runtime.
 *
 * The rule that matters: a result that is *ours* (the pre-resume provisional)
 * or the *platform's* fabricated closer is replaced — never skipped — because
 * skipping would leave the real outcome out of the log. A genuinely different
 * answer is skipped, and the hold is honestly reported as observed.
 *
 * @param {readonly object[]} events - committed events in ascending `seq` order.
 * @param {string} callId - call to answer.
 * @param {{entry?: object, replaceSeq?: number}} [options] - hold record and the
 *   caller's existing replacement target (`entry.pendingWritten` implies one).
 * @returns {undefined | {action: 'append', turn: number, step: number, callSeq: number}
 *   | {action: 'replace', seq: number, turn: number, step: number, originalData: object, reason: string}
 *   | {action: 'skip', seq: number, turn: number, step: number, reason: string}} the plan.
 */
export function planToolResultWrite(events, callId, options = {}) {
  const located = locateToolCall(events, callId);
  if (located === undefined) return undefined;
  const turn = located.turn;
  const step = located.step;
  if (located.resultSeq !== undefined) {
    const original = events.find((event) => event !== null && typeof event === 'object' && event.seq === located.resultSeq);
    if (original === undefined || original.type !== 'tool/result') {
      return { action: 'skip', seq: located.resultSeq, turn, step, reason: 'unreadable-result' };
    }
    const classification = classifyAnsweredResult(original.data, options.entry);
    if (classification === 'final') {
      // A real answer already lives in the log. Rewriting it would move a
      // different outcome, so the hold is observed instead.
      if (options.replaceSeq === undefined || options.replaceSeq !== located.resultSeq) {
        return { action: 'skip', seq: located.resultSeq, turn, step, reason: 'answered' };
      }
      return { action: 'replace', seq: located.resultSeq, turn, step, originalData: original.data, reason: 'recorded-target' };
    }
    if (classification === 'provisional' && options.replaceSeq !== undefined && options.replaceSeq !== located.resultSeq) {
      // Our record points at a provisional that is no longer the current node:
      // something else answered in between, so do not touch it.
      return { action: 'skip', seq: located.resultSeq, turn, step, reason: 'answered' };
    }
    return { action: 'replace', seq: located.resultSeq, turn, step, originalData: original.data, reason: classification };
  }
  return { action: 'append', turn, step, callSeq: located.callSeq };
}

/** Serialize one entry for the durable holds file (never the full hint payload). */
function serializableEntry(entry) {
  return {
    callId: entry.callId,
    sessionId: entry.sessionId ?? null,
    tool: entry.tool,
    hint: entry.hint,
    deadlineMs: entry.deadlineMs,
    heldAt: entry.heldAt,
    deadlineAt: entry.deadlineAt,
    status: entry.status,
    turn: entry.turn ?? null,
    step: entry.step ?? null,
    callSeq: entry.callSeq ?? null,
    pendingWritten: entry.pendingWritten === true,
    pendingMessageId: entry.pendingMessageId ?? null,
    resultSeq: entry.resultSeq ?? null,
    settledAt: entry.settledAt ?? null,
    deliveredAsMessage: entry.deliveredAsMessage === true,
    failReason: entry.failReason ?? null,
  };
}

/** Copy one durable record back into a live entry. */
function restoreEntry(record, now) {
  const callId = normalizeCallId(record.callId);
  const deadlineAt =
    typeof record.deadlineAt === 'number' && Number.isFinite(record.deadlineAt)
      ? record.deadlineAt
      : now + clampDeadline(record.deadlineMs);
  return {
    callId,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
    tool: typeof record.tool === 'string' ? record.tool : 'unknown',
    hint: boundHint(record.hint),
    deadlineMs: clampDeadline(record.deadlineMs),
    heldAt: typeof record.heldAt === 'number' ? record.heldAt : deadlineAt - clampDeadline(record.deadlineMs),
    deadlineAt,
    status: 'held',
    turn: typeof record.turn === 'number' ? record.turn : undefined,
    step: typeof record.step === 'number' ? record.step : undefined,
    callSeq: typeof record.callSeq === 'number' ? record.callSeq : undefined,
    pendingWritten: record.pendingWritten === true,
    pendingMessageId: typeof record.pendingMessageId === 'string' ? record.pendingMessageId : undefined,
    resultSeq: typeof record.resultSeq === 'number' ? record.resultSeq : undefined,
    settledAt: undefined,
    deliveredAsMessage: false,
    failReason: undefined,
    timer: undefined,
    retryTimer: undefined,
    deferred: undefined,
    deferredReason: undefined,
    pendingWrite: undefined,
    closerRewritten: false,
  };
}

/**
 * Create the hold registry.
 *
 * @param {object} [options]
 * @param {string} [options.bootId] - identity of the boot that owns this registry.
 * @param {() => number} [options.now] - clock (epoch ms).
 * @param {(callback: () => void, ms: number) => unknown} [options.schedule] - timer creation.
 * @param {(handle: unknown) => void} [options.cancelSchedule] - timer cancellation.
 * @param {(snapshot: object) => void} [options.persist] - durable write of the registry snapshot; called synchronously by `hold()`.
 * @param {(message: string) => void} [options.log] - diagnostics sink.
 * @param {(callId: string) => (undefined | {sessionId?: string, turn?: number, step?: number, callSeq?: number, resultSeq?: number})} [options.lookupCall] - live-Session locator.
 * @param {(request: {entry: object, build: (turn: number, step: number) => object, replaceSeq?: number, replaceMessageId?: string}) => Promise<{seq?: number, skipped?: boolean, deferred?: boolean, messaged?: boolean, reason?: string, recovered?: boolean}>} [options.writeResult] - appends or content-replaces one `tool/result`; `{deferred: true}` means another writer owns the Session right now (retry, never settle), and `{messaged: true}` means the call's turn already ended and the real result reached the Agent as a follow-up message instead of entering the log.
 * @param {number} [options.settleGraceMs] - how long a new boot keeps retrying a provisional write another writer owns before reporting the hold as still pending.
 * @param {number} [options.deferredWaitMs] - how long one `complete`/`fail` retries a write another writer owns in-line before returning `write-locked` (the hold stays pending and the retry continues in the background).
 */
export function createResumableToolCalls(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const schedule =
    typeof options.schedule === 'function'
      ? options.schedule
      : (callback, ms) => {
          const timer = setTimeout(callback, ms);
          if (typeof timer?.unref === 'function') timer.unref();
          return timer;
        };
  const cancelSchedule =
    typeof options.cancelSchedule === 'function'
      ? options.cancelSchedule
      : (handle) => {
          if (handle !== undefined && handle !== null) clearTimeout(handle);
        };
  const persist = typeof options.persist === 'function' ? options.persist : () => {};
  const log = typeof options.log === 'function' ? options.log : () => {};
  const lookupCall = typeof options.lookupCall === 'function' ? options.lookupCall : () => undefined;
  const writeResult =
    typeof options.writeResult === 'function'
      ? options.writeResult
      : async () => ({ skipped: true });
  const settleGraceMs =
    typeof options.settleGraceMs === 'number' && Number.isFinite(options.settleGraceMs) && options.settleGraceMs >= 0
      ? Math.floor(options.settleGraceMs)
      : 1200;
  const deferredWaitMs =
    typeof options.deferredWaitMs === 'number' && Number.isFinite(options.deferredWaitMs) && options.deferredWaitMs >= 0
      ? Math.floor(options.deferredWaitMs)
      : RESUME_WRITE_RETRY.waitMs;
  const bootId = typeof options.bootId === 'string' ? options.bootId : 'boot';

  /** @type {Map<string, object>} */
  const entries = new Map();
  let disposed = false;
  let sequence = 0;

  function nextMessageId(entry, kind) {
    sequence += 1;
    return `${kind}-resumable-tool-result-${entry.callId}-${String(sequence)}`;
  }

  /** Bounded durable snapshot. */
  function snapshot() {
    const holds = [];
    for (const entry of entries.values()) {
      if (holds.length >= RESUME_LIMITS.holds) break;
      holds.push(serializableEntry(entry));
    }
    return {
      version: RESUME_HOLDS_VERSION,
      bootId,
      updatedAt: now(),
      holds,
    };
  }

  function persistNow() {
    try {
      persist(snapshot());
    } catch (error) {
      log(`resumable holds persist failed: ${String(error?.message ?? error)}`);
    }
  }

  function cancelTimer(entry) {
    if (entry.timer === undefined) return;
    try {
      cancelSchedule(entry.timer);
    } catch {
      /* timer already fired */
    }
    entry.timer = undefined;
  }

  function armDeadline(entry) {
    cancelTimer(entry);
    const delay = Math.max(0, entry.deadlineAt - now());
    entry.timer = schedule(() => {
      entry.timer = undefined;
      void fail(entry.callId, `deadline ${String(entry.deadlineMs)}ms exceeded`).catch((error) => {
        log(`resumable hold ${entry.callId} deadline fail failed: ${String(error?.message ?? error)}`);
      });
    }, delay);
  }

  /** Resolve the call position from the live Session, then from the record. */
  function resolveTarget(entry) {
    const found = lookupCall(entry.callId);
    if (found !== undefined && found !== null) {
      if (typeof found.sessionId === 'string' && found.sessionId.length > 0) entry.sessionId = found.sessionId;
      if (typeof found.turn === 'number') entry.turn = found.turn;
      if (typeof found.step === 'number') entry.step = found.step;
      if (typeof found.callSeq === 'number') entry.callSeq = found.callSeq;
      if (typeof found.resultSeq === 'number') entry.resultSeq = found.resultSeq;
    }
    return {
      turn: typeof entry.turn === 'number' ? entry.turn : 1,
      step: typeof entry.step === 'number' ? entry.step : 1,
    };
  }

  /** Wait through the injected scheduler so fake clocks drive the retry tests. */
  function sleepFor(ms) {
    return new Promise((resolve) => {
      const timer = schedule(resolve, Math.max(0, ms));
      if (typeof timer?.unref === 'function') timer.unref();
    });
  }

  /** Exponential backoff of a refused settlement, capped by `RESUME_WRITE_RETRY`. */
  function retryDelay(attempt) {
    const exponent = Math.min(8, Math.max(0, attempt - 1));
    return Math.min(RESUME_WRITE_RETRY.maxMs, RESUME_WRITE_RETRY.baseMs * 2 ** exponent);
  }

  function cancelRetry(entry) {
    if (entry.retryTimer === undefined) return;
    try {
      cancelSchedule(entry.retryTimer);
    } catch {
      /* timer already fired */
    }
    entry.retryTimer = undefined;
  }

  /**
   * Keep a refused settlement alive in the background until it lands or the
   * hold's deadline fails the call. The entry never leaves `held` while a write
   * is outstanding, so a restart in between still finds it in the holds file.
   */
  function scheduleSettlementRetry(entry) {
    if (disposed || entry.deferred === undefined) return;
    cancelRetry(entry);
    if (entry.deadlineAt <= now()) {
      // The deadline is spent and the write is still refused: keep the hold
      // pending (never mark it answered) and let the next boot try again.
      log(`resumable hold ${entry.callId} is past its deadline and still cannot write its result; keeping it pending`);
      return;
    }
    const attempt = entry.deferred.attempts ?? 1;
    entry.retryTimer = schedule(() => {
      entry.retryTimer = undefined;
      void retryDeferred(entry).catch((error) => {
        log(`resumable hold ${entry.callId} deferred settlement failed: ${String(error?.message ?? error)}`);
      });
    }, retryDelay(attempt));
  }

  async function retryDeferred(entry) {
    if (disposed || entry.status !== 'held') return;
    const deferred = entry.deferred;
    if (deferred === undefined) return;
    if (deferred.kind === 'pending') {
      await writeProvisional(entry);
      persistNow();
      return;
    }
    await settle(entry, deferred.kind, deferred.payload, deferred.reason);
  }

  /**
   * Write the honest provisional result that keeps the platform from appending
   * its synthetic closer. The entry stays `held` (its deadline keeps running)
   * and the write is retried while another writer owns the Session.
   *
   * @returns {Promise<'written' | 'skipped' | 'deferred'>} what the log did.
   */
  async function writeProvisional(entry) {
    if (entry.status !== 'held' || entry.pendingWritten === true) {
      // Another settle claimed the call while this boot sweep was walking it:
      // its real result is being written, so no provisional marker belongs here.
      return 'skipped';
    }
    const run = (async () => {
      const messageId = nextMessageId(entry, 'pending');
      resolveTarget(entry);
      const outcome = await writeResult({
        entry: { ...serializableEntry(entry), callId: entry.callId },
        kind: 'pending',
        build: (turn, step) =>
          buildPendingResult({
            callId: entry.callId,
            turn,
            step,
            id: messageId,
            resume: { tool: entry.tool, hint: entry.hint },
          }),
      });
      if (outcome?.deferred === true || outcome?.messaged === true) {
        // A provisional marker never travels as a message: if the writer
        // reports one anyway, treat it as a deferral so `pendingWritten` stays
        // false and the call is retried instead of being claimed as answered.
        const attempts = (entry.deferred?.attempts ?? 0) + 1;
        entry.deferred = { kind: 'pending', payload: undefined, reason: String(outcome.reason ?? 'write-locked'), attempts };
        entry.deferredReason = entry.deferred.reason;
        scheduleSettlementRetry(entry);
        log(`resumable hold ${entry.callId} provisional result deferred (${entry.deferred.reason}); retrying`);
        return 'deferred';
      }
      if (outcome?.skipped === true) {
        entry.status = 'observed';
        entry.settledAt = now();
        if (typeof outcome.seq === 'number') entry.resultSeq = outcome.seq;
        entry.deferred = undefined;
        entry.deferredReason = undefined;
        cancelRetry(entry);
        cancelTimer(entry);
        log(`resumable hold ${entry.callId} was already answered in its session log before resume`);
        return 'skipped';
      }
      entry.pendingWritten = true;
      entry.pendingMessageId = messageId;
      if (typeof outcome?.seq === 'number') entry.resultSeq = outcome.seq;
      if (outcome?.recovered === true) entry.closerRewritten = true;
      entry.deferred = undefined;
      entry.deferredReason = undefined;
      cancelRetry(entry);
      log(`resumable hold ${entry.callId} got its provisional result before resume (tool ${entry.tool})`);
      return 'written';
    })();
    entry.pendingWrite = run;
    try {
      return await run;
    } finally {
      if (entry.pendingWrite === run) entry.pendingWrite = undefined;
    }
  }

  /**
   * Claim one entry for settlement, first letting an in-flight provisional write
   * finish so a `complete` that arrives during boot settlement replaces the
   * marker instead of racing it.
   * @returns {Promise<boolean>} whether this call owns the settlement.
   */
  async function claimForSettle(entry) {
    if (entry.pendingWrite !== undefined) await entry.pendingWrite.catch(() => {});
    if (entry.status !== 'held') return false;
    // Synchronous claim: a concurrent complete/fail observes 'settling' and is a no-op.
    entry.status = 'settling';
    entry.deferred = undefined;
    cancelRetry(entry);
    return true;
  }

  /** Serialize settlement per call so two concurrent completes write once. */
  async function settle(entry, kind, payload, reason) {
    if (!(await claimForSettle(entry))) return { applied: false, reason: 'already-settled', status: entry.status };
    const queuedAt = now();
    let attempt = 0;
    try {
      for (;;) {
        attempt += 1;
        resolveTarget(entry);
        const replacing = entry.pendingWritten === true;
        const replaceSeq = replacing ? entry.resultSeq : undefined;
        const replaceMessageId = replacing ? entry.pendingMessageId : undefined;
        const messageId = nextMessageId(entry, kind);
        const build = (turn, step) =>
          kind === 'complete'
            ? buildCompletedResult({ callId: entry.callId, turn, step, id: messageId, payload })
            : buildUnknownResult({ callId: entry.callId, turn, step, id: messageId });
        const outcome = await writeResult({
          entry: { ...serializableEntry(entry), callId: entry.callId },
          build,
          kind,
          ...(replacing ? { replaceSeq, replaceMessageId } : {}),
        });
        if (outcome?.deferred === true) {
          // Another writer owns the Session (the resume path). Never settle on a
          // refused write: keep the hold pending and retry with backoff.
          const deferredReason = String(outcome.reason ?? 'write-locked');
          entry.status = 'held';
          entry.deferred = { kind, payload, reason, attempts: attempt };
          entry.deferredReason = deferredReason;
          persistNow();
          log(`resumable hold ${entry.callId} settlement deferred: ${deferredReason} (attempt ${attempt})`);
          if (now() - queuedAt >= deferredWaitMs) {
            scheduleSettlementRetry(entry);
            return { applied: false, reason: 'write-locked', status: 'held', retryScheduled: true };
          }
          await sleepFor(retryDelay(attempt));
          if (entry.status !== 'held' || entry.deferred === undefined) {
            return { applied: false, reason: 'already-settled', status: entry.status };
          }
          entry.status = 'settling';
          continue;
        }
        if (outcome?.skipped === true) {
          entry.status = 'observed';
          entry.settledAt = now();
          if (typeof outcome.seq === 'number') entry.resultSeq = outcome.seq;
          entry.deferred = undefined;
          entry.deferredReason = undefined;
          cancelRetry(entry);
          cancelTimer(entry);
          persistNow();
          log(`resumable hold ${entry.callId} already answered in its session log (${kind})`);
          return { applied: false, reason: 'already-in-log', status: entry.status };
        }
        if (outcome?.messaged === true) {
          // The call's turn already recorded its `turn/end`, so no `tool/result`
          // may enter the log (the loader would reject the whole Session). The
          // real outcome reached the Agent as a follow-up message instead, which
          // settles the hold exactly like a log write — only without a result
          // seq, because no event exists.
          entry.status = kind === 'complete' ? 'completed' : 'failed';
          entry.settledAt = now();
          entry.deliveredAsMessage = true;
          entry.deferred = undefined;
          entry.deferredReason = undefined;
          cancelRetry(entry);
          cancelTimer(entry);
          persistNow();
          log(`resumable hold ${entry.callId} settled as ${entry.status} (turn already closed; result delivered as a follow-up message)`);
          return { applied: true, reason: entry.status, status: entry.status, messaged: true };
        }
        entry.status = kind === 'complete' ? 'completed' : 'failed';
        entry.settledAt = now();
        if (typeof outcome?.seq === 'number') {
          entry.resultSeq = outcome.seq;
          if (replacing) entry.pendingWritten = false;
        }
        if (outcome?.recovered === true) entry.closerRewritten = true;
        if (kind === 'fail') entry.failReason = reason?.slice(0, RESUME_LIMITS.reasonChars) ?? null;
        entry.deferred = undefined;
        entry.deferredReason = undefined;
        cancelRetry(entry);
        cancelTimer(entry);
        persistNow();
        log(
          `resumable hold ${entry.callId} settled as ${entry.status}` +
            `${replacing ? ' (content replacement)' : ''}${outcome?.recovered === true ? ' (rewrote the platform closer)' : ''}` +
            `${kind === 'fail' && reason ? `: ${String(reason)}` : ''}`,
        );
        return { applied: true, reason: entry.status, status: entry.status };
      }
    } catch (error) {
      // A failed write must not consume the hold: restore it so a retry, a later
      // complete or the next boot can try again. Re-arming the deadline is only
      // meaningful while it is still ahead — re-arming an expired deadline would
      // immediately fail again and spin on the same failure.
      entry.status = 'held';
      if (entry.deadlineAt > now()) armDeadline(entry);
      persistNow();
      log(`resumable hold ${entry.callId} settlement failed: ${String(error?.message ?? error)}`);
      throw error;
    }
  }

  async function fail(callId, reason) {
    const id = normalizeCallId(callId);
    const entry = entries.get(id);
    if (entry === undefined) return { applied: false, reason: 'unknown-call' };
    const text = typeof reason === 'string' ? reason : String(reason ?? '');
    return settle(entry, 'fail', undefined, text);
  }

  async function complete(callId, result) {
    const id = normalizeCallId(callId);
    const entry = entries.get(id);
    if (entry === undefined) return { applied: false, reason: 'unknown-call' };
    return settle(entry, 'complete', result, undefined);
  }

  /**
   * Claim one call for cross-restart recovery.
   * @param {string} callId - the platform tool-call identity.
   * @param {{tool: string, hint?: object, deadlineMs?: number}} resume - recovery descriptor.
   * @returns {() => void} release; cancels the hold without answering the call.
   */
  function hold(callId, resume) {
    if (disposed) throw new Error('resumableToolCalls: the Host plugin is disposed');
    const id = normalizeCallId(callId);
    const at = now();
    const descriptor = normalizeResumeDescriptor(resume, at);
    const token = `${id}:${String(at)}:${String(++sequence)}`;
    const existing = entries.get(id);
    if (existing !== undefined && existing.status === 'held') {
      cancelTimer(existing);
      // A refreshed hold starts a new wait: an older deferred settlement would
      // answer a call this owner just re-claimed, so drop it.
      cancelRetry(existing);
      existing.deferred = undefined;
      existing.deferredReason = undefined;
      existing.token = token;
      existing.tool = descriptor.tool;
      existing.hint = descriptor.hint;
      existing.deadlineMs = descriptor.deadlineMs;
      existing.deadlineAt = descriptor.deadlineAt;
      existing.heldAt = at;
      resolveTarget(existing);
      armDeadline(existing);
      // Durable BEFORE returning: the restart checkpoint is written later and
      // must never describe a hold the holds file does not know about.
      persistNow();
      log(`resumable hold ${id} refreshed for tool ${descriptor.tool} (deadline ${String(descriptor.deadlineMs)}ms)`);
      return () => release(id, token);
    }
    if (entries.size >= RESUME_LIMITS.holds) {
      // Only live holds consume the budget; a long session may have settled
      // hundreds of resumable calls whose results are already durable.
      pruneSettled();
    }
    if (entries.size >= RESUME_LIMITS.holds) {
      throw new Error(`resumableToolCalls: at most ${String(RESUME_LIMITS.holds)} calls can be held at once`);
    }
    const entry = {
      callId: id,
      sessionId: undefined,
      tool: descriptor.tool,
      hint: descriptor.hint,
      deadlineMs: descriptor.deadlineMs,
      heldAt: at,
      deadlineAt: descriptor.deadlineAt,
      status: 'held',
      turn: undefined,
      step: undefined,
      callSeq: undefined,
      pendingWritten: false,
      pendingMessageId: undefined,
      resultSeq: undefined,
      settledAt: undefined,
      deliveredAsMessage: false,
      failReason: undefined,
      timer: undefined,
      retryTimer: undefined,
      deferred: undefined,
      deferredReason: undefined,
      pendingWrite: undefined,
      closerRewritten: false,
      token,
    };
    entries.set(id, entry);
    resolveTarget(entry);
    armDeadline(entry);
    // Durable BEFORE returning: a restart that starts right after this call
    // must find the hold in the holds file, not only in memory.
    persistNow();
    log(`resumable hold ${id} registered for tool ${descriptor.tool} (deadline ${String(descriptor.deadlineMs)}ms)`);
    return () => release(id, token);
  }

  function release(callId, token) {
    const entry = entries.get(callId);
    if (entry === undefined) return;
    if (token !== undefined && entry.token !== token) return;
    if (entry.status !== 'held') return;
    cancelTimer(entry);
    cancelRetry(entry);
    entries.delete(callId);
    persistNow();
    log(`resumable hold ${callId} released by its owner`);
  }

  /**
   * Forget settled calls so the bounded registry counts only live holds. Their
   * results already live in the session logs; `restart.log` keeps the history.
   * @returns {number} removed entries.
   */
  function pruneSettled() {
    let pruned = 0;
    for (const [id, entry] of entries) {
      if (entry.status === 'held' || entry.status === 'settling') continue;
      cancelTimer(entry);
      cancelRetry(entry);
      entries.delete(id);
      pruned += 1;
    }
    return pruned;
  }

  /**
   * Re-arm holds persisted by a previous boot.
   * @param {object[]} records - durable hold records.
   * @returns {number} number of restored holds.
   */
  function restore(records) {
    if (!Array.isArray(records) || records.length === 0) return 0;
    let restored = 0;
    for (const record of records) {
      if (restored >= RESUME_LIMITS.holds) break;
      if (record === null || typeof record !== 'object') continue;
      if (record.status !== 'held') continue;
      let entry;
      try {
        entry = restoreEntry(record, now());
      } catch {
        continue;
      }
      if (entries.has(entry.callId)) continue;
      entries.set(entry.callId, entry);
      armDeadline(entry);
      restored += 1;
    }
    // Re-stamp the file with THIS boot's id even when nothing is still held, so
    // a settled record is never mistaken for a carry-over again.
    persistNow();
    if (restored > 0) log(`restored ${String(restored)} resumable hold(s) from the previous boot`);
    return restored;
  }

  /**
   * Answer every still-open hold of the previous boot before any Session is
   * resumed.
   *
   * The provisional result is written **immediately**, not after a grace delay:
   * the post-restart resume takes the Session's only write handle within
   * milliseconds of boot, appends the platform's synthetic
   * `TOOL_OUTCOME_UNKNOWN` closer for every call that still has no result, and
   * only then publishes the Session — waiting first loses that race. A write
   * another writer owns is not skipped: it stays `held` and is retried during a
   * bounded `settleGraceMs` window (and afterwards in the background) so the
   * real outcome is never silently dropped.
   *
   * @returns {Promise<{graceMs: number, pendingWritten: number, skipped: number, failed: number, deferred: number, settled: number}>}
   */
  async function settleAtBoot() {
    const waiting = [...entries.values()].filter((entry) => entry.status === 'held');
    if (waiting.length === 0) return { graceMs: 0, pendingWritten: 0, skipped: 0, failed: 0, deferred: 0, settled: 0 };
    const startedAt = now();
    const touched = new Set();
    for (const entry of [...entries.values()]) {
      if (entry.status !== 'held') continue;
      touched.add(entry.callId);
      if (entry.deadlineAt <= now()) {
        // The wait already expired: answer with the platform wording instead
        // of keeping a call that can never be recovered.
        try {
          await fail(entry.callId, `deadline ${String(entry.deadlineMs)}ms exceeded before boot settlement`);
        } catch (error) {
          log(`resumable hold ${entry.callId} deadline settlement failed: ${String(error?.message ?? error)}`);
        }
        continue;
      }
      try {
        await writeProvisional(entry);
      } catch (error) {
        log(`resumable hold ${entry.callId} provisional result failed: ${String(error?.message ?? error)}`);
      }
    }
    // The deferred writes are Sessions the resume path owns right now; let them
    // land before the post-restart delivery resumes that very Session.
    const stillDeferred = () => [...touched].some((callId) => entries.get(callId)?.deferred !== undefined);
    if (settleGraceMs > 0) {
      const until = startedAt + settleGraceMs;
      while (now() < until && stillDeferred()) {
        await sleepFor(Math.min(200, Math.max(1, until - now())));
      }
    }
    const outcome = { graceMs: settleGraceMs, pendingWritten: 0, skipped: 0, failed: 0, deferred: 0, settled: 0 };
    for (const callId of touched) {
      const entry = entries.get(callId);
      if (entry === undefined) continue;
      if (entry.status === 'failed') outcome.failed += 1;
      else if (entry.status === 'observed') outcome.skipped += 1;
      else if (entry.status === 'completed') outcome.settled += 1;
      else if (entry.pendingWritten === true) outcome.pendingWritten += 1;
      else outcome.deferred += 1;
    }
    if (outcome.pendingWritten > 0 || outcome.skipped > 0 || outcome.failed > 0 || outcome.deferred > 0 || outcome.settled > 0) persistNow();
    return outcome;
  }

  /** Read-only view for status/diagnostics. */
  function status() {
    const holds = [];
    for (const entry of entries.values()) {
      holds.push({
        callId: entry.callId,
        sessionId: entry.sessionId ?? null,
        tool: entry.tool,
        status: entry.status,
        deadlineAt: entry.deadlineAt,
        pendingWritten: entry.pendingWritten === true,
        deferredReason: entry.deferredReason ?? null,
        closerRewritten: entry.closerRewritten === true,
      });
    }
    return {
      service: RESUME_SERVICE_NAME,
      bootId,
      holds,
      held: holds.filter((entry) => entry.status === 'held').length,
      deferred: holds.filter((entry) => entry.deferredReason !== null).length,
      settled: holds.filter((entry) => entry.status === 'completed' || entry.status === 'failed' || entry.status === 'observed').length,
    };
  }

  /** Call ids that are currently held (used to keep the resume report honest). */
  function heldCallIds() {
    const ids = new Set();
    for (const entry of entries.values()) if (entry.status === 'held') ids.add(entry.callId);
    return ids;
  }

  /**
   * Held call ids grouped by their owning Session. The restart checkpoint uses
   * this to report "N calls are still held by resumableToolCalls" instead of
   * claiming the Session has no pending tool calls; a hold without a resolvable
   * `sessionId` belongs to no group and is skipped here.
   * @returns {Map<string, string[]>} sessionId → held call ids.
   */
  function heldBySession() {
    const bySession = new Map();
    for (const entry of entries.values()) {
      if (entry.status !== 'held') continue;
      if (typeof entry.sessionId !== 'string' || entry.sessionId.length === 0) continue;
      const calls = bySession.get(entry.sessionId);
      if (calls === undefined) bySession.set(entry.sessionId, [entry.callId]);
      else calls.push(entry.callId);
    }
    return bySession;
  }

  function dispose() {
    disposed = true;
    for (const entry of entries.values()) {
      cancelTimer(entry);
      cancelRetry(entry);
    }
    entries.clear();
  }

  return {
    hold,
    complete,
    fail,
    release,
    restore,
    settleAtBoot,
    status,
    heldCallIds,
    heldBySession,
    dispose,
    snapshot,
  };
}
