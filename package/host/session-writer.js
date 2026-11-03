/**
 * Module 5 of 5 — writing one held tool call's result into a Session log.
 *
 * `resumableToolCalls` must append a `tool/result` to a Session that may
 * already be alive on this boot, and the Harness offers exactly two write
 * channels:
 *
 * 1. a **live** Session (`ctx.sessions.get(id)`) — `session.append(...)` is the
 *    official surface-event path and is routed through the Agent's own write
 *    handle, so it never contends for ownership;
 * 2. a **persisted-only** Session — `ctx.sessionPersistence.open(id, 'write')`
 *    claims the Session's single in-process write handle
 *    (`JsonlBackendTracker.claimWrite`), and throws
 *    `SessionAlreadyOwnedError` when somebody else holds it.
 *
 * The post-restart resume path (`AgentLoop.resumeWith`) takes channel 2 first,
 * appends the platform's synthetic `TOOL_OUTCOME_UNKNOWN` closers for every
 * unanswered call, and only then publishes the Session into `ctx.sessions`.
 * During that window channel 2 throws and channel 1 cannot see the Session
 * yet, so a write attempted then must **wait** for publication (or be retried
 * later) — never be treated as done.
 *
 * This module keeps that decision testable without a DSH runtime: it receives
 * the Host context (for `sessions` / `sessionPersistence` / `agents`), a log
 * sink and a sleep function, and it returns one `writeResult` callback for the
 * registry. All event-shape decisions live in `planToolResultWrite`
 * (`./resumable.js`).
 *
 * One rule holds above both channels: a `tool/result` — appended *or* content
 * replaced — must stay inside an open turn. The Session loader rejects either
 * form once the call's turn recorded its `turn/end`
 * (`SessionFormatError: tool/result is outside an open turn`), which makes the
 * whole Session unreadable. A result whose turn already closed is therefore
 * delivered as a follow-up message to the Session's Agent instead of being
 * written, and a provisional result in that state simply defers.
 */
import { randomUUID } from 'node:crypto';

import { planToolResultWrite, replaceResultContent } from './resumable.js';

/** Default budget one write waits for a Session being resumed to be published. */
const DEFAULT_WAIT_MS = 1500;
/** Default poll interval while waiting for that publication. */
const DEFAULT_POLL_MS = 50;
/** Character budget of one result rendered into a follow-up message. */
const MESSAGE_TEXT_CHARS = 12000;

/**
 * Whether an error means "another writer holds this Session right now".
 * Matched by name and by the stable message of
 * `SessionAlreadyOwnedError` (the class lives in
 * `@deepseek-ai/dsh-session-persistence`, which this bundle does not depend on).
 * @param {unknown} error - a failed `open(id, 'write')`.
 * @returns {boolean} true when the write handle is owned by another writer.
 */
export function isSessionWriteOwnedError(error) {
  if (error === null || typeof error !== 'object') return false;
  if (error.name === 'SessionAlreadyOwnedError') return true;
  return typeof error.message === 'string' && error.message.includes('is already owned by an active write handle');
}

/** Whether `session.append` refused because another append is being published. */
function isSessionAppendContended(error) {
  return typeof error?.message === 'string' && error.message.includes('append cannot reenter');
}

/** Committed events of one live Session (empty when it cannot be read). */
export function sessionEventsOf(session) {
  try {
    const events = session.ownEvents();
    return Array.isArray(events) ? events : [];
  } catch {
    return undefined;
  }
}

/**
 * Whether the turn one tool call belongs to already recorded its `turn/end`.
 *
 * A `tool/result` written after that point — `surfaceOp: 'append'` or a
 * content replacement alike — sits outside an open turn and the loader rejects
 * the whole Session, so the write must not happen at all.
 *
 * @param {readonly object[]} events - committed events in ascending `seq` order.
 * @param {number} turn - the turn the call belongs to.
 * @returns {boolean} true when a `turn/end` for that turn is already committed.
 */
export function turnIsClosed(events, turn) {
  if (!Array.isArray(events) || typeof turn !== 'number') return false;
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue;
    if (event.type === 'turn/end' && event.data?.turn === turn) return true;
  }
  return false;
}

/**
 * Render one built `tool/result` payload as the plain text of a message.
 *
 * Text blocks contribute their text; every other block is represented by a
 * `[type]` placeholder, because a follow-up message carries no tool semantics.
 * The whole rendering is bounded, so a huge result cannot flood the next turn.
 *
 * @param {object} data - `tool/result` event data built by the registry.
 * @returns {string} the rendered text (bounded, ellipsized).
 */
export function renderResultText(data) {
  const content = data?.message?.content;
  const parts = [];
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      if (block.type === 'text') parts.push(typeof block.text === 'string' ? block.text : '');
      else parts.push(`[${typeof block.type === 'string' ? block.type : 'unknown'}]`);
    }
  }
  const text = parts.join('\n');
  return text.length > MESSAGE_TEXT_CHARS ? `${text.slice(0, MESSAGE_TEXT_CHARS - 1)}…` : text;
}

/** Envelope that marks a result delivered as a follow-up message. */
function resultEnvelope(callId, kind, text) {
  return [
    `<dsh_resumable_tool_result call="${callId}" kind="${kind}">`,
    '【DSH 重启回填】该工具调用所属的回合已经结束，因此结果以消息形式送达（不要再重跑该命令）。',
    text,
    '</dsh_resumable_tool_result>',
  ].join('\n');
}

/**
 * One `UserMessage` for `Agent.followup` (same shape as `restartMessage` in
 * `index.js`). `followup` splices messages into the Agent inbox, so a bare
 * string would corrupt the next turn instead of reaching the model as input.
 */
function followupMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'dsh-resumable-tool-result' },
  };
}

/**
 * Locate one tool call across the live Sessions of a store.
 * @param {{get?: Function, list?: Function}} store - `ctx.sessions`.
 * @param {string} callId - call to locate.
 * @returns {undefined | object} the located call plus its `sessionId`.
 */
export function findLiveCallIn(store, callId) {
  if (store === undefined || store === null || typeof store.list !== 'function') return undefined;
  let sessions;
  try {
    sessions = store.list();
  } catch {
    return undefined;
  }
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (session === null || session === undefined) continue;
    const events = sessionEventsOf(session);
    if (events === undefined) continue;
    const located = locateIn(events, callId);
    if (located !== undefined) return { ...located, sessionId: String(session.id) };
  }
  return undefined;
}

/** Local import indirection keeps the public surface of `resumable.js` small. */
function locateIn(events, callId) {
  // `planToolResultWrite` returns undefined for a call that is not in the log.
  const plan = planToolResultWrite(events, callId, {});
  if (plan === undefined) return undefined;
  return {
    callId,
    turn: plan.turn,
    step: plan.step,
    ...(plan.action === 'append' ? { callSeq: plan.callSeq } : { resultSeq: plan.seq }),
  };
}

/**
 * Build the writer used as `resumableToolCalls`'s `writeResult` side effect.
 *
 * @param {object} options
 * @param {object} options.ctx - Host context (`sessions`, `sessionPersistence`, `agents`).
 * @param {(message: string) => void} [options.log] - diagnostics sink.
 * @param {number} [options.waitMs] - budget for waiting out a resume's write handle.
 * @param {number} [options.pollMs] - poll interval used inside that budget.
 * @param {(ms: number) => Promise<void>} [options.sleep] - sleep implementation.
 * @returns {{writeResult: (request: object) => Promise<object>, findLiveCall: (callId: string) => (undefined | object), isSessionWriteOwnedError: typeof isSessionWriteOwnedError}}
 */
export function createSessionResultWriter(options = {}) {
  const ctx = options.ctx;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const waitMs =
    typeof options.waitMs === 'number' && Number.isFinite(options.waitMs) && options.waitMs >= 0 ? Math.floor(options.waitMs) : DEFAULT_WAIT_MS;
  const pollMs =
    typeof options.pollMs === 'number' && Number.isFinite(options.pollMs) && options.pollMs > 0 ? Math.max(1, Math.floor(options.pollMs)) : DEFAULT_POLL_MS;
  const sleep = typeof options.sleep === 'function' ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function service(name) {
    try {
      return ctx.get(name);
    } catch {
      return undefined;
    }
  }

  function sessionsStore() {
    try {
      const store = ctx.sessions;
      return store !== undefined && store !== null && typeof store.get === 'function' ? store : undefined;
    } catch {
      return undefined;
    }
  }

  /** The live Session with this id, if any. */
  function liveSessionById(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
    const store = sessionsStore();
    if (store === undefined) return undefined;
    try {
      return store.get(sessionId) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Wait (bounded) for a Session a resume is loading to be published into
   * `ctx.sessions`, because that publication is the moment its write handle
   * becomes usable through the live append channel.
   */
  async function waitForLiveSession(sessionId, budgetMs) {
    const until = Date.now() + Math.max(0, budgetMs);
    for (;;) {
      const live = liveSessionById(sessionId);
      if (live !== undefined) return live;
      const remaining = until - Date.now();
      if (remaining <= 0) return undefined;
      await sleep(Math.min(pollMs, remaining));
    }
  }

  /** Best-effort durability checkpoint for one live Session. */
  async function flushLiveSession(session) {
    const store = sessionsStore();
    if (store === undefined || typeof store.flush !== 'function') return;
    try {
      await store.flush(session);
    } catch (error) {
      log(`flushing Session ${String(session?.id)} after a resumable result failed: ${String(error?.message ?? error)}`);
    }
  }

  /**
   * Deliver one result as a message because its turn already ended.
   *
   * The Agent is the only writer that can open a fresh turn such a message
   * needs, so its absence is reported (never guessed): the caller defers and
   * retries instead of writing a `tool/result` outside the closed turn.
   *
   * A **running** Agent gets the result through `steer`, which claims it at the
   * next step boundary: the result arrives on its own instead of waiting for
   * the current turn to finish (and for the user to release a queued message).
   * An idle Agent gets `followup`, which wakes it into a new turn.
   *
   * @param {object} session - the Session the call belongs to.
   * @param {string} callId - the answered tool call.
   * @param {object} data - built `tool/result` data (its content becomes text).
   * @param {string} kind - `complete` or `fail`.
   * @returns {boolean} true when the Agent accepted the message.
   */
  function deliverAsMessage(session, callId, data, kind) {
    const agents = service('agents');
    if (agents === undefined || agents === null || typeof agents.get !== 'function') return false;
    const agent = agents.get(String(session?.id));
    if (agent === undefined || agent === null || typeof agent.followup !== 'function') return false;
    const text = resultEnvelope(callId, kind, renderResultText(data));
    try {
      const message = followupMessage(text);
      if (agent.status === 'running' && typeof agent.steer === 'function') agent.steer(message);
      else agent.followup(message);
    } catch (error) {
      log(`delivering the result of held tool call ${callId} as a message failed: ${String(error?.message ?? error)}`);
      return false;
    }
    return true;
  }

  /**
   * Execute a plan on a live Session through the official surface-event path.
   * A `skip` is honest (a real answer already exists); a `replace` rewrites our
   * provisional marker or the platform's synthetic closer content.
   *
   * A result whose turn already closed never enters the log: the real outcome
   * leaves as a follow-up message, and a provisional result only defers.
   */
  function writeOnLiveSession(session, callId, build, request) {
    const events = sessionEventsOf(session);
    if (events === undefined) throw new Error(`cannot read the committed events of Session ${String(session?.id)}`);
    const plan = planToolResultWrite(events, callId, { entry: request.entry, replaceSeq: request.replaceSeq });
    if (plan === undefined) throw new Error(`cannot locate tool call ${callId} in the live Session ${String(session?.id)}`);
    if (plan.action === 'skip') return Promise.resolve({ seq: plan.seq, skipped: true, reason: plan.reason });
    if (turnIsClosed(events, plan.turn)) {
      // `turn/end` is committed: appending or content-replacing a `tool/result`
      // here makes the Session unloadable, so deliver the result as input the
      // Agent turns into a new turn instead.
      if (request.kind === 'pending') return Promise.resolve({ deferred: true, reason: 'turn-closed' });
      const data = build(plan.turn, plan.step);
      const kind = typeof request.kind === 'string' && request.kind.length > 0 ? request.kind : 'complete';
      return Promise.resolve(
        deliverAsMessage(session, callId, data, kind)
          ? { messaged: true, reason: 'turn-closed' }
          : { deferred: true, reason: 'turn-closed-awaiting-agent' },
      );
    }
    const data = build(plan.turn, plan.step);
    try {
      if (plan.action === 'replace') {
        const event = session.append('tool/result', replaceResultContent(plan.originalData, data.message.content), {
          surfaceOp: { op: 'replace', startSeq: plan.seq, endSeq: plan.seq },
          sourceEventSeqs: [plan.seq],
        });
        return Promise.resolve({
          seq: event.seq,
          replaced: true,
          ...(plan.reason === 'synthetic-closer' ? { recovered: true } : {}),
          reason: plan.reason,
        });
      }
      const event = session.append('tool/result', data, { surfaceOp: 'append', sourceEventSeqs: [plan.callSeq] });
      return Promise.resolve({ seq: event.seq });
    } catch (error) {
      if (isSessionAppendContended(error)) return Promise.resolve({ deferred: true, reason: 'append-contended' });
      throw error;
    }
  }

  /** Execute a plan on a persisted-only Session through its write handle. */
  async function writeOnHandle(handle, callId, build, request, sessionId) {
    const read = await handle.read(0);
    const events = Array.isArray(read?.events) ? read.events : [];
    const plan = planToolResultWrite(events, callId, { entry: request.entry, replaceSeq: request.replaceSeq });
    if (plan === undefined) throw new Error(`cannot locate tool call ${callId} in Session ${String(sessionId)}`);
    if (plan.action === 'skip') return { seq: plan.seq, skipped: true, reason: plan.reason };
    if (turnIsClosed(events, plan.turn)) {
      // No Agent is reachable through a persisted-only handle: report the
      // refusal so the settlement retries and delivers the result as a message
      // once the Session is published and its Agent exists.
      return { deferred: true, reason: request.kind === 'pending' ? 'turn-closed' : 'turn-closed-awaiting-live' };
    }
    const last = events[events.length - 1];
    if (last === undefined || typeof last.seq !== 'number') throw new Error(`Session ${String(sessionId)} has no committed events`);
    const nextSeq = last.seq + 1;
    const data = build(plan.turn, plan.step);
    if (plan.action === 'replace') {
      await handle.append([
        {
          type: 'tool/result',
          seq: nextSeq,
          time: Date.now(),
          data: replaceResultContent(plan.originalData, data.message.content),
          surfaceOp: { op: 'replace', startSeq: plan.seq, endSeq: plan.seq },
          sourceEventSeqs: [plan.seq],
        },
      ]);
    } else {
      await handle.append([
        {
          type: 'tool/result',
          seq: nextSeq,
          time: Date.now(),
          data,
          surfaceOp: 'append',
          sourceEventSeqs: [plan.callSeq],
        },
      ]);
    }
    await handle.flush();
    return plan.action === 'replace'
      ? { seq: nextSeq, replaced: true, ...(plan.reason === 'synthetic-closer' ? { recovered: true } : {}), reason: plan.reason }
      : { seq: nextSeq };
  }

  /**
   * Append (or content-replace) the result of one held call.
   *
   * Returns `{ seq }` when the result is in the log, `{ skipped: true }` only
   * when a *different* real answer already lives there,
   * `{ deferred: true, reason }` when another writer owns the Session right now
   * (the settle state machine retries instead of settling), and
   * `{ messaged: true }` when the call's turn already ended, in which case the
   * real result was delivered to the Session's Agent as a follow-up message
   * instead of being written outside that turn.
   *
   * @param {{entry: object, build: (turn: number, step: number) => object, kind?: string, replaceSeq?: number}} request
   * @returns {Promise<{seq?: number, skipped?: boolean, deferred?: boolean, messaged?: boolean, replaced?: boolean, recovered?: boolean, reason?: string}>}
   */
  async function writeResult(request) {
    const callId = request.entry?.callId;
    if (typeof callId !== 'string' || callId.length === 0) throw new Error('resumableToolCalls: the write request carries no callId');
    let sessionId = typeof request.entry?.sessionId === 'string' && request.entry.sessionId.length > 0 ? request.entry.sessionId : undefined;
    if (sessionId === undefined) sessionId = findLiveCallIn(sessionsStore(), callId)?.sessionId;

    const live = liveSessionById(sessionId);
    if (live !== undefined && typeof live.append === 'function') {
      const outcome = await writeOnLiveSession(live, callId, request.build, request);
      if (outcome?.skipped !== true && outcome?.deferred !== true) await flushLiveSession(live);
      return outcome;
    }

    const persistence = service('sessionPersistence');
    if (persistence === undefined || persistence === null || typeof persistence.open !== 'function') {
      // The boot settlement can run before the persistence backend is mounted;
      // the hold stays pending and the registry retries.
      return { deferred: true, reason: 'persistence-unavailable' };
    }
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new Error(`cannot resolve the Session of held tool call ${callId}`);
    }

    let handle;
    try {
      handle = await persistence.open(sessionId, 'write');
    } catch (error) {
      const becameLive = liveSessionById(sessionId);
      if (becameLive !== undefined && typeof becameLive.append === 'function') {
        const outcome = await writeOnLiveSession(becameLive, callId, request.build, request);
        if (outcome?.skipped !== true && outcome?.deferred !== true) await flushLiveSession(becameLive);
        return outcome;
      }
      if (!isSessionWriteOwnedError(error)) throw error;
      // The resume path owns the Session's only write handle until its Agent is
      // published. Wait for that publication instead of opening a second handle
      // (which the backend refuses) or giving up (which loses the result).
      const published = await waitForLiveSession(sessionId, waitMs);
      if (published !== undefined && typeof published.append === 'function') {
        const outcome = await writeOnLiveSession(published, callId, request.build, request);
        if (outcome?.skipped !== true && outcome?.deferred !== true) await flushLiveSession(published);
        return outcome;
      }
      return { deferred: true, reason: 'write-locked' };
    }
    try {
      return await writeOnHandle(handle, callId, request.build, request, sessionId);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  return {
    writeResult,
    findLiveCall: (callId) => findLiveCallIn(sessionsStore(), callId),
    isSessionWriteOwnedError,
  };
}
