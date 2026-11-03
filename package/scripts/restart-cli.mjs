#!/usr/bin/env node
/**
 * Standalone recovery CLI for the DSH restart plugin (hotfix.5, task A).
 *
 * This script is deliberately independent of the DSH runtime: it never imports
 * the plugin, never touches the network and has no dependencies. It reads (and,
 * for the explicit repair commands, writes) only the plugin state directory, so
 * it still works when the Host crashed, when DSH cannot boot, or when the user
 * needs to inspect what a force restart left behind.
 *
 * Commands (SPEC.md task A):
 *   status      read-only human summary, or a structured object with --json
 *   relaunch    relaunch from force-reaper-spec.json (dry run without --yes)
 *   clear-stale remove spec/marker/lock only when every recorded Host pid and
 *               the lock holder are provably dead (requires --yes)
 *   unhold      clear `hold` in state.json
 *
 * State directory: `--dir` > `$DSH_HOME/.dsh-restart` > `~/.dsh/.dsh-restart`.
 *
 * Files read when present: state.json, status.json, restart-intent.json,
 * force-reaper-spec.json, force-relaunch.lock, relaunch-ready.json and the tail
 * of relaunch.log. Relaunch reuses the exact spec contract and lock semantics of
 * force-reaper.mjs: an exclusive lock file (`openSync(lockPath, 'wx')`), a live
 * holder always wins, a dead or unreadable holder is stale and retried once.
 * A successful relaunch publishes `relaunch-ready.json` with status
 * `relaunched` (and a failure `error`), so the next boot reconciliation sees a
 * manual recovery instead of an unexplained stale attempt.
 *
 * Exit codes (documented in --help as well):
 *   0 success, rehearsal, nothing to do, or a live lock holder skipped us
 *   1 unexpected internal failure
 *   2 usage error
 *   3 missing/unusable spec or state (including unparsable JSON)
 *   4 precondition refused (Host or lock holder alive, shutdown spec, duplicate)
 *   5 relaunch failed after three attempts
 *   6 write/delete failure
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';

/* --------------------------------------------------------------- constants -- */

const RESTART_DIR_NAME = '.dsh-restart';
const STATE_FILE = 'state.json';
const STATUS_FILE = 'status.json';
const INTENT_FILE = 'restart-intent.json';
const SPEC_FILE = 'force-reaper-spec.json';
const LOCK_FILE = 'force-relaunch.lock';
const MARKER_FILE = 'relaunch-ready.json';
const LOG_FILE = 'relaunch.log';

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const EXIT_MISSING = 3;
const EXIT_REFUSED = 4;
const EXIT_LAUNCH_FAILED = 5;
const EXIT_WRITE_FAILED = 6;

/** Default verification budget after one launch attempt (SPEC task A). */
const DEFAULT_WAIT_MS = 2500;
const MAX_WAIT_MS = 600000;
/** Attempts per relaunch, matching force-reaper.mjs. */
const LAUNCH_ATTEMPTS = 3;
/** Lock attempts: exclusive create, then one stale-holder retry. */
const LOCK_ATTEMPTS = 2;
/** How much of relaunch.log to read for the tail. */
const LOG_TAIL_LINES = 12;
const LOG_TAIL_BYTES = 16 * 1024;

const COMMANDS = ['status', 'relaunch', 'clear-stale', 'unhold'];

const USAGE = `DSH 重启恢复 CLI（独立于 DSH 运行时，纯 Node ESM，零依赖）

用法：
  node scripts/restart-cli.mjs status      [--dir <stateDir>] [--json]
  node scripts/restart-cli.mjs relaunch    [--dir <stateDir>] [--yes] [--wait <ms>]
  node scripts/restart-cli.mjs clear-stale [--dir <stateDir>] [--yes]
  node scripts/restart-cli.mjs unhold      [--dir <stateDir>]

子命令：
  status       只读摘要：bootId/pid、Host 是否存活、phase、pending、hold、
               lastError、lastForceOutcome、spec 的 requestId/mode/platform 与
               命令摘要、marker 状态、锁持有者是否存活，最后给出建议。
               加 --json 输出结构化对象（含原始解析结果）。
  relaunch     依据 force-reaper-spec.json 重新拉起 Host。spec.hostPid 或其它
               记录中的 Host pid 仍存活时拒绝。未带 --yes 只打印将要执行的
               命令（演练）；带 --yes 时先抢 force-relaunch.lock（存活持有者
               优先，直接跳过并退出 0），再按平台拉起：
                 web     spawn(execPath, [...execArgv, ...args], { cwd, ... })
                 desktop spawn(appExecutable, [], { cwd: appDir, ... }) 且移除
                         ELECTRON_RUN_AS_NODE / ELECTRON_NO_ATTACH_CONSOLE
               --wait 为每次拉起后的验证等待（默认 2500ms，最多尝试 3 次）；
               成功打印 relaunched pid=…、释放锁并写入 marker；失败退出 5。
  clear-stale  仅当 spec.hostPid、state/status/intent 记录的 Host pid、以及锁
               持有者 pid 全部已退出（或不存在）时，删除 force-reaper-spec.json、
               relaunch-ready.json、force-relaunch.lock。未带 --yes 只报告。
  unhold       清除 state.json 中的 hold（任何值都清空），不存在则提示。

状态目录解析：
  --dir 优先；否则 $DSH_HOME/.dsh-restart；否则 ~/.dsh/.dsh-restart。

退出码：
  0  成功（含演练、无需操作、锁被存活持有者占用而跳过）
  1  未预料的内部错误
  2  用法错误（未知子命令/参数、--wait 非法、缺少值）
  3  spec/state 缺失或不可用（JSON 损坏、spec 缺少必要字段、spec 校验失败）
  4  前置条件不满足（Host 或锁持有者仍存活、spec 属于 shutdown、检出重复实例）
  5  relaunch 重试 3 次后仍失败
  6  写操作失败（写入 state.json、删除产物）

说明：本 CLI 不会安装、打包或修改插件文件；只读写状态目录内的
state.json / status.json / restart-intent.json / force-reaper-spec.json /
relaunch-ready.json / force-relaunch.lock / relaunch.log。`;

/* ------------------------------------------------------------------ errors -- */

class UsageError extends Error {}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function fatal(error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  try {
    writeSync(2, `DSH 重启 CLI 内部错误：${detail}\n`);
  } catch {
    /* nothing left to report to */
  }
  process.exit(EXIT_FAILURE);
}

/* ------------------------------------------------------------------ output -- */

function out(text) {
  const value = text.endsWith('\n') ? text : `${text}\n`;
  try {
    process.stdout.write(value);
  } catch {
    /* a detached console may be gone; output is diagnostics only */
  }
}

/** @returns {number} the process exit code for this result. */
function emit(result, wantJson) {
  if (wantJson) {
    let text;
    try {
      text = JSON.stringify(result.json, null, 2);
    } catch (error) {
      text = JSON.stringify({ ok: false, error: `JSON 序列化失败：${messageOf(error)}` }, null, 2);
    }
    out(text);
  } else {
    const lines = [...result.lines];
    if (result.code !== EXIT_OK) lines.push('', `（退出码：${result.code}）`);
    out(lines.join('\n'));
  }
  return result.code;
}

/* --------------------------------------------------------------- utilities -- */

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function validPid(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTime(value) {
  if (!Number.isFinite(value)) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
  );
}

function shortId(value) {
  const text = String(value);
  return text.length > 12 ? `${text.slice(0, 8)}…` : text;
}

function clip(text, limit) {
  const value = String(text);
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

/** Terminal width of `text`, counting CJK as double width. */
function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(
      char,
    )
      ? 2
      : 1;
  }
  return width;
}

function pad(text, width) {
  const label = String(text);
  const current = displayWidth(label);
  return current >= width ? label : `${label}${' '.repeat(width - current)}`;
}

function row(label, value) {
  return `  ${pad(label, 24)}${value}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Liveness check shared with force-reaper.mjs: signal 0 probes the pid, and
 * EPERM means the process exists but belongs to somebody else.
 */
function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function formatCommand(executable, args) {
  return [executable, ...args]
    .map((part) => (/\s/.test(part) || part.length === 0 ? JSON.stringify(part) : part))
    .join(' ');
}

/* ------------------------------------------------------------------- files -- */

/**
 * Read a JSON object without ever throwing.
 * @returns {{present: boolean, value?: object, invalid?: boolean, error?: string}}
 */
function readJsonFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false };
    return { present: true, invalid: true, error: `无法读取（${error?.code ?? messageOf(error)}）` };
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { present: true, invalid: true, error: '内容不是 JSON 对象' };
    }
    return { present: true, value: parsed };
  } catch (error) {
    return { present: true, invalid: true, error: `JSON 解析失败（${messageOf(error)}）` };
  }
}

/**
 * Read at most `lineCount` trailing lines without loading a huge log.
 * @returns {{present: boolean, lines: string[], size?: number, truncated?: boolean, error?: string}}
 */
function readTail(path, lineCount) {
  let fd;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { present: true, lines: [], error: '不是普通文件' };
    const start = Math.max(0, stat.size - LOG_TAIL_BYTES);
    const length = Math.min(LOG_TAIL_BYTES, stat.size);
    const buffer = Buffer.alloc(length);
    fd = openSync(path, 'r');
    let read = 0;
    while (read < length) {
      const chunk = readSync(fd, buffer, read, length - read, start + read);
      if (chunk <= 0) break;
      read += chunk;
    }
    let text = buffer.subarray(0, read).toString('utf8');
    if (start > 0) {
      // A byte offset can split a line: drop the partial first line.
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : '';
    }
    const all = text.split(/\r?\n/).filter((line) => line.length > 0);
    return {
      present: true,
      lines: all.slice(-lineCount),
      size: stat.size,
      truncated: start > 0,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false, lines: [] };
    return { present: true, lines: [], error: `无法读取（${error?.code ?? messageOf(error)}）` };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the descriptor is already gone */
      }
    }
  }
}

/**
 * Replace a JSON file atomically where possible; used for state.json and the
 * readiness marker. Never throws.
 * @returns {{ok: boolean, error?: string}}
 */
function writeJsonAtomic(path, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
    return { ok: true };
  } catch (error) {
    try {
      // A Windows rename can refuse to replace; retry after an unlink.
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      }
      renameSync(tmp, path);
      return { ok: true };
    } catch (retryError) {
      try {
        writeFileSync(path, text);
        return { ok: true };
      } catch (writeError) {
        try {
          unlinkSync(tmp);
        } catch {
          /* already gone */
        }
        return { ok: false, error: `${writeError?.code ?? messageOf(writeError)}（${path}）` };
      }
    }
  }
}

/** Publish the readiness marker exactly like force-reaper.mjs does. */
function writeMarkerFile(markerPath, payload) {
  const text = `${JSON.stringify(payload)}\n`;
  const tmp = `${markerPath}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    try {
      unlinkSync(markerPath);
    } catch {
      /* first marker */
    }
    renameSync(tmp, markerPath);
    return { ok: true };
  } catch {
    try {
      writeFileSync(markerPath, text);
      return { ok: true };
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        /* already gone */
      }
      return { ok: false, error: `${error?.code ?? messageOf(error)}（${markerPath}）` };
    }
  }
}

function appendLog(logPath, message) {
  if (logPath === undefined) return;
  const line = `[${new Date().toISOString()}] [restart-cli ${process.pid}] ${message}\n`;
  try {
    appendFileSync(logPath, line);
  } catch {
    /* logging must never abort a repair */
  }
}

/* ------------------------------------------------------------- arguments -- */

function parseArgs(argv) {
  const parsed = {
    command: undefined,
    dir: undefined,
    json: false,
    yes: false,
    waitMs: DEFAULT_WAIT_MS,
    help: false,
  };
  const positional = [];

  const assign = (flag, value) => {
    if (flag === '--dir') {
      if (value === undefined || value.length === 0) throw new UsageError('--dir 需要一个非空目录');
      parsed.dir = value;
      return;
    }
    const waitMs = Number(value);
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
      throw new UsageError(`--wait 需要一个 0..${MAX_WAIT_MS} 的整数毫秒值（收到 ${JSON.stringify(value)}）`);
    }
    parsed.waitMs = waitMs;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h' || token === 'help') {
      parsed.help = true;
      continue;
    }
    if (token === '--json') {
      parsed.json = true;
      continue;
    }
    if (token === '--yes' || token === '-y') {
      parsed.yes = true;
      continue;
    }
    if (token === '--dir' || token === '--wait') {
      const next = argv[index + 1];
      if (next === undefined || (next.startsWith('-') && next.length > 1 && next !== '--')) {
        throw new UsageError(`${token} 需要一个值`);
      }
      index += 1;
      assign(token, next);
      continue;
    }
    if (token.startsWith('--dir=')) {
      assign('--dir', token.slice('--dir='.length));
      continue;
    }
    if (token.startsWith('--wait=')) {
      assign('--wait', token.slice('--wait='.length));
      continue;
    }
    if (token.startsWith('-') && token !== '-') {
      throw new UsageError(`未知参数：${token}`);
    }
    positional.push(token);
  }

  if (parsed.help) return parsed;
  if (positional.length === 0) {
    throw new UsageError(`缺少子命令（${COMMANDS.join(' / ')}）`);
  }
  if (positional.length > 1) {
    throw new UsageError(`多余的参数：${positional.slice(1).join(' ')}`);
  }
  const command = positional[0];
  if (!COMMANDS.includes(command)) {
    throw new UsageError(`未知子命令：${command}（可用：${COMMANDS.join(' / ')}）`);
  }
  parsed.command = command;
  return parsed;
}

/** `--dir` > `$DSH_HOME/.dsh-restart` > `~/.dsh/.dsh-restart`. */
function resolveStateDir(explicit) {
  const expandHome = (value) => {
    if (value === '~') return homedir();
    if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2));
    return value;
  };
  if (explicit !== undefined) {
    const expanded = expandHome(explicit);
    return isAbsolute(expanded) ? resolvePath(expanded) : resolvePath(process.cwd(), expanded);
  }
  const home = nonEmpty(process.env.DSH_HOME);
  if (home !== undefined) return join(resolvePath(expandHome(home)), RESTART_DIR_NAME);
  return join(homedir(), '.dsh', RESTART_DIR_NAME);
}

function dirSource(explicit) {
  if (explicit !== undefined) return '--dir';
  return nonEmpty(process.env.DSH_HOME) !== undefined ? 'DSH_HOME' : '默认 ~/.dsh';
}

function resolveSpecPath(value, dir, fallback) {
  const raw = nonEmpty(value);
  if (raw === undefined) return join(dir, fallback);
  const expanded = raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : resolvePath(dir, expanded);
}

/* --------------------------------------------------------------- collection -- */

/** Fields force-reaper.mjs needs before it can relaunch anything. */
function specIssues(spec) {
  const issues = [];
  if (spec === undefined) {
    issues.push('spec 不可用');
    return issues;
  }
  if (spec.mode !== 'restart' && spec.mode !== 'shutdown') {
    issues.push(`mode 无法识别（${JSON.stringify(spec.mode ?? null)}）`);
  }
  if (validPid(spec.hostPid) === undefined) issues.push('缺少有效 hostPid');
  if (spec.platform === 'desktop') {
    if (nonEmpty(spec.appExecutable) === undefined) issues.push('缺少 appExecutable');
  } else {
    const relaunch = spec.relaunch;
    if (relaunch === null || typeof relaunch !== 'object' || Array.isArray(relaunch)) {
      issues.push('缺少 relaunch 命令');
    } else {
      if (nonEmpty(relaunch.execPath) === undefined) issues.push('缺少 relaunch.execPath');
      if (stringArray(relaunch.args).length === 0) issues.push('relaunch.args 为空');
    }
  }
  return issues;
}

function describeSpecCommand(spec) {
  if (spec.platform === 'desktop') {
    const executable = nonEmpty(spec.appExecutable);
    return {
      platform: 'desktop',
      executable: executable ?? null,
      args: [],
      cwd: nonEmpty(spec.appDir) ?? null,
      text: executable === undefined ? '（缺少 appExecutable）' : formatCommand(executable, []),
    };
  }
  const relaunch = spec.relaunch !== null && typeof spec.relaunch === 'object' ? spec.relaunch : undefined;
  const executable = nonEmpty(relaunch?.execPath);
  const args = [...stringArray(relaunch?.execArgv), ...stringArray(relaunch?.args)];
  return {
    platform: 'web',
    executable: executable ?? null,
    args,
    cwd: nonEmpty(relaunch?.cwd) ?? null,
    text: executable === undefined ? '（缺少 relaunch.execPath）' : formatCommand(executable, args),
  };
}

function collectStatus(dir, source) {
  const at = Date.now();
  const files = {
    state: readJsonFile(join(dir, STATE_FILE)),
    status: readJsonFile(join(dir, STATUS_FILE)),
    intent: readJsonFile(join(dir, INTENT_FILE)),
    spec: readJsonFile(join(dir, SPEC_FILE)),
    marker: readJsonFile(join(dir, MARKER_FILE)),
    lock: readJsonFile(join(dir, LOCK_FILE)),
    log: readTail(join(dir, LOG_FILE), LOG_TAIL_LINES),
  };
  const state = files.state.value;
  const status = files.status.value;
  const intent = files.intent.value;
  const spec = files.spec.value;
  const marker = files.marker.value;
  const lock = files.lock.value;

  const statusPid = validPid(status?.pid);
  const statePid = validPid(state?.pid);
  const hostPid = statusPid ?? statePid;
  const hostSource = statusPid !== undefined ? STATUS_FILE : statePid !== undefined ? STATE_FILE : undefined;
  const hostAlive = hostPid !== undefined && isAlive(hostPid);

  let phase = nonEmpty(status?.phase);
  if (phase === undefined && intent !== undefined) phase = 'restarting';
  if (phase === undefined && files.spec.present) phase = 'restarting';
  if (phase === undefined) phase = 'unknown';

  let pending = status?.pending !== undefined && status?.pending !== null ? status.pending : undefined;
  let pendingSource;
  if (pending !== undefined) {
    pendingSource = STATUS_FILE;
  } else if (intent !== undefined) {
    pending = {
      requestId: intent.requestId,
      mode: intent.mode,
      phase: 'restarting',
      requesters: Array.isArray(intent.requesters) ? intent.requesters.length : undefined,
    };
    pendingSource = INTENT_FILE;
  }

  const holdCandidates = [status?.hold, state?.hold].filter(
    (value) => value !== undefined && value !== null,
  );
  const activeHold = holdCandidates.find((value) => typeof value === 'object' && value.active === true);
  const hold = activeHold ?? (holdCandidates.length > 0 ? holdCandidates[0] : null);
  const holdActive = hold !== null && typeof hold === 'object' && hold.active === true;

  const lastError = status?.lastError ?? state?.lastError ?? null;
  const lastForceOutcome = status?.lastForceOutcome ?? state?.lastForceOutcome ?? null;
  const lastRestart = status?.lastRestart ?? state?.lastRestart ?? null;
  const bootIdMismatch =
    nonEmpty(status?.bootId) !== undefined &&
    nonEmpty(state?.bootId) !== undefined &&
    status.bootId !== state.bootId;

  const specPresent = files.spec.present;
  const specInvalid = files.spec.invalid === true;
  const issues = [];
  if (specPresent && specInvalid) issues.push(`spec 无法解析（${files.spec.error}）`);
  else if (specPresent) issues.push(...specIssues(spec));
  const specHostPid = validPid(spec?.hostPid);
  const specHostAlive = specHostPid !== undefined && isAlive(specHostPid);
  const command = specPresent && !specInvalid ? describeSpecCommand(spec) : undefined;
  const validation =
    specPresent && spec?.validation !== null && typeof spec?.validation === 'object'
      ? spec.validation
      : undefined;
  const specSummary = {
    present: specPresent,
    invalid: specInvalid,
    requestId: nonEmpty(spec?.requestId) ?? null,
    mode: nonEmpty(spec?.mode) ?? null,
    platform: spec?.platform === 'desktop' ? 'desktop' : specPresent ? 'web' : null,
    hostPid: specHostPid ?? null,
    hostAlive: specHostAlive,
    command: command ?? null,
    validation: validation ?? null,
    issues,
  };

  const markerChildPid = validPid(marker?.childPid);
  const markerChildAlive =
    markerChildPid !== undefined && markerChildPid !== process.pid && isAlive(markerChildPid);
  const markerSummary = {
    present: files.marker.present,
    invalid: files.marker.invalid === true,
    status: nonEmpty(marker?.status) ?? null,
    requestId: nonEmpty(marker?.requestId) ?? null,
    childPid: markerChildPid ?? null,
    childAlive: markerChildAlive,
    at: Number.isFinite(marker?.at) ? marker.at : null,
    detail: nonEmpty(marker?.detail) ?? null,
    matchesSpec:
      specPresent &&
      nonEmpty(spec?.requestId) !== undefined &&
      nonEmpty(marker?.requestId) !== undefined &&
      marker.requestId === spec.requestId,
  };

  const lockPid = validPid(lock?.pid);
  const lockAlive = lockPid !== undefined && isAlive(lockPid);
  const lockSummary = {
    present: files.lock.present,
    invalid: files.lock.invalid === true,
    pid: lockPid ?? null,
    requestId: nonEmpty(lock?.requestId) ?? null,
    at: Number.isFinite(lock?.at) ? lock.at : null,
    holderAlive: lockAlive,
    stale: files.lock.present && !lockAlive,
  };

  const ctx = {
    at,
    dir,
    dirSource: source,
    dirExists: existsSync(dir),
    files,
    state,
    status,
    intent,
    spec,
    marker,
    lock,
    hostPid,
    hostAlive,
    hostSource,
    phase,
    pending,
    pendingSource,
    hold,
    holdActive,
    lastError,
    lastForceOutcome,
    lastRestart,
    bootIdMismatch,
    specSummary,
    markerSummary,
    lockSummary,
  };
  ctx.suggestions = buildSuggestions(ctx);
  return ctx;
}

/** Every alive pid that claims to be a Host, excluding this CLI process. */
function liveHostEvidence(ctx) {
  const found = [];
  const add = (pid, source) => {
    const value = validPid(pid);
    if (value === undefined || value === process.pid) return;
    if (found.some((item) => item.pid === value)) return;
    if (!isAlive(value)) return;
    found.push({ pid: value, source });
  };
  add(ctx.state?.pid, STATE_FILE);
  add(ctx.status?.pid, STATUS_FILE);
  add(ctx.intent?.pid, INTENT_FILE);
  add(ctx.spec?.hostPid, SPEC_FILE);
  return found;
}

function buildSuggestions(ctx) {
  const suggestions = [];
  if (ctx.holdActive) {
    suggestions.push({
      code: 'hold-active',
      text: `hold 生效（原因 ${ctx.hold.reason ?? '未记录'}）：排查上次失败原因后执行 unhold 解除，恢复自动行为。`,
    });
  }
  if (ctx.hostAlive) {
    suggestions.push({
      code: 'host-alive',
      text: `Host 仍存活（pid ${ctx.hostPid}）：等它自行退出后再执行 relaunch；若确认已卡死，先结束该进程。`,
    });
  }
  if (ctx.lockSummary.holderAlive) {
    suggestions.push({
      code: 'lock-live',
      text: `relaunch 锁被存活进程持有（pid ${ctx.lockSummary.pid}）：说明已有 relaunch 在执行，不要重复执行。`,
    });
  }
  if (ctx.specSummary.present) {
    if (!ctx.hostAlive) {
      if (ctx.specSummary.mode === 'shutdown') {
        suggestions.push({
          code: 'shutdown-spec',
          text: '残留的是强制关闭（mode=shutdown）产物，relaunch 不适用；可执行 clear-stale --yes 清理后手动启动 DSH。',
        });
      } else if (ctx.markerSummary.status === 'relaunched' && ctx.markerSummary.childAlive) {
        suggestions.push({
          code: 'relaunch-in-flight',
          text: `marker 显示已拉起的进程仍存活（pid ${ctx.markerSummary.childPid}）：等待新 Host 写入 state.json；不要重复执行 relaunch，若长时间无响应请检查 relaunch.log。`,
        });
      } else if (ctx.specSummary.issues.length > 0) {
        suggestions.push({
          code: 'spec-incomplete',
          text: `Host 已退出，但 spec 不完整（${ctx.specSummary.issues.join('；')}）：执行 clear-stale --yes 清理残留后手动启动 DSH。`,
        });
      } else if (ctx.markerSummary.status === 'error') {
        suggestions.push({
          code: 'retry-after-error',
          text: `上次强制重启失败（marker=error：${ctx.markerSummary.detail ?? '未知原因'}）：可执行 relaunch --yes 重试。`,
        });
      } else {
        suggestions.push({
          code: 'relaunch-ready',
          text: 'Host 已退出且 spec 完整：可执行 relaunch --yes 重新拉起。',
        });
      }
    }
  } else if (ctx.markerSummary.present || ctx.lockSummary.present) {
    suggestions.push({
      code: 'stale-artifacts',
      text: '没有 spec，但残留 marker/lock：可执行 clear-stale --yes 清理；需要恢复运行请手动启动 DSH。',
    });
  } else {
    suggestions.push({ code: 'clean', text: '没有待恢复的强制重启产物：无需操作。' });
  }
  return suggestions;
}

/* ---------------------------------------------------------------- rendering -- */

function describeStateFile(file) {
  if (!file.present) return '缺失';
  if (file.invalid) return `存在但${file.error}`;
  const parts = ['存在'];
  const bootId = nonEmpty(file.value?.bootId);
  if (bootId !== undefined) parts.push(`bootId=${shortId(bootId)}`);
  const pid = validPid(file.value?.pid);
  if (pid !== undefined) parts.push(`pid=${pid}`);
  const profile = nonEmpty(file.value?.profile);
  if (profile !== undefined) parts.push(`profile=${profile}`);
  return parts.join(' ');
}

function describeStatusFile(file) {
  if (!file.present) return '缺失';
  if (file.invalid) return `存在但${file.error}`;
  const parts = ['存在'];
  const value = file.value;
  if (nonEmpty(value?.phase) !== undefined) parts.push(`phase=${value.phase}`);
  if (Number.isFinite(value?.at)) parts.push(`快照=${formatTime(value.at)}`);
  if (nonEmpty(value?.bootId) !== undefined) parts.push(`bootId=${shortId(value.bootId)}`);
  return parts.join(' ');
}

function describeIntentFile(file) {
  if (!file.present) return '缺失';
  if (file.invalid) return `存在但${file.error}`;
  const value = file.value;
  const parts = ['存在'];
  if (nonEmpty(value?.requestId) !== undefined) parts.push(`requestId=${value.requestId}`);
  if (nonEmpty(value?.mode) !== undefined) parts.push(`mode=${value.mode}`);
  if (Number.isFinite(value?.startedAt)) parts.push(`写入=${formatTime(value.startedAt)}`);
  return parts.join(' ');
}

function describeSpecFile(ctx) {
  if (!ctx.files.spec.present) return '缺失';
  if (ctx.files.spec.invalid) return `存在但${ctx.files.spec.error}`;
  const summary = ctx.specSummary;
  return `存在 requestId=${summary.requestId ?? '—'} mode=${summary.mode ?? '—'} platform=${summary.platform ?? '—'}`;
}

function describeMarkerFile(file) {
  if (!file.present) return '缺失';
  if (file.invalid) return `存在但${file.error}`;
  const parts = ['存在'];
  if (nonEmpty(file.value?.status) !== undefined) parts.push(`status=${file.value.status}`);
  if (nonEmpty(file.value?.requestId) !== undefined) parts.push(`requestId=${file.value.requestId}`);
  if (Number.isFinite(file.value?.at)) parts.push(`at=${formatTime(file.value.at)}`);
  return parts.join(' ');
}

function describeLockFile(ctx) {
  if (!ctx.files.lock.present) return '缺失';
  if (ctx.files.lock.invalid) return '存在但无法解析（视为陈旧）';
  const summary = ctx.lockSummary;
  if (summary.pid === null) return '存在 持有者 pid=未知（视为陈旧）';
  return `${summary.holderAlive ? '存在 持有者存活' : '存在 持有者已退出（陈旧）'} pid=${summary.pid}`;
}

function describeLogFile(file) {
  if (!file.present) return '缺失';
  if (file.error !== undefined) return file.error;
  const size = Number.isFinite(file.size) ? `${file.size} 字节` : '大小未知';
  return `存在 共 ${size}${file.truncated ? '（仅读尾部）' : ''}`;
}

function describePending(pending, source) {
  if (pending === null || pending === undefined) return '无';
  const parts = [];
  if (nonEmpty(pending.requestId) !== undefined) parts.push(`requestId=${pending.requestId}`);
  if (nonEmpty(pending.mode) !== undefined) parts.push(`mode=${pending.mode}`);
  if (nonEmpty(pending.phase) !== undefined) parts.push(`phase=${pending.phase}`);
  if (Array.isArray(pending.requesters)) parts.push(`请求者=${pending.requesters.length}`);
  else if (Number.isSafeInteger(pending.requesters)) parts.push(`请求者=${pending.requesters}`);
  if (pending.forceReaperArmed === true) parts.push('reaper 已武装');
  if (source !== undefined) parts.push(`来源=${source}`);
  return parts.length > 0 ? parts.join(' ') : '有（字段无法识别）';
}

function describeHold(hold) {
  if (hold === null || hold === undefined) return '未生效';
  if (typeof hold !== 'object') return `存在（${String(hold)}）`;
  const parts = [hold.active === true ? '生效' : '未激活'];
  if (nonEmpty(hold.reason) !== undefined) parts.push(`原因=${hold.reason}`);
  if (Number.isFinite(hold.at)) parts.push(`时间=${formatTime(hold.at)}`);
  if (nonEmpty(hold.requestId) !== undefined) parts.push(`requestId=${hold.requestId}`);
  if (nonEmpty(hold.detail) !== undefined) parts.push(`详情=${clip(hold.detail, 80)}`);
  return parts.join('  ');
}

function describeErrorish(value) {
  if (value === null || value === undefined) return '无';
  if (typeof value === 'string') return clip(value, 200);
  if (typeof value === 'object') {
    const message = nonEmpty(value.message) ?? nonEmpty(value.detail);
    if (message !== undefined) return clip(message, 200);
    try {
      return clip(JSON.stringify(value), 200);
    } catch {
      return '无法显示';
    }
  }
  return clip(String(value), 200);
}

function describeOutcome(outcome) {
  if (outcome === null || outcome === undefined) return '无记录';
  if (typeof outcome !== 'object') return clip(String(outcome), 200);
  const parts = [];
  if (nonEmpty(outcome.status) !== undefined) parts.push(`status=${outcome.status}`);
  if (Number.isFinite(outcome.at)) parts.push(`at=${formatTime(outcome.at)}`);
  if (nonEmpty(outcome.requestId) !== undefined) parts.push(`requestId=${outcome.requestId}`);
  if (nonEmpty(outcome.mode) !== undefined) parts.push(`mode=${outcome.mode}`);
  if (nonEmpty(outcome.platform) !== undefined) parts.push(`platform=${outcome.platform}`);
  if (outcome.lockOwnerPid !== undefined && outcome.lockOwnerPid !== null) {
    parts.push(`lockOwner=${outcome.lockOwnerPid}（${outcome.lockOwnerAlive === true ? '存活' : '已退出'}）`);
  }
  if (nonEmpty(outcome.detail) !== undefined) parts.push(`detail=${clip(outcome.detail, 100)}`);
  return parts.length > 0 ? parts.join(' ') : '有（字段无法识别）';
}

function describeLastRestart(lastRestart) {
  if (lastRestart === null || lastRestart === undefined || typeof lastRestart !== 'object') return '无记录';
  const parts = [];
  if (nonEmpty(lastRestart.mode) !== undefined) parts.push(`mode=${lastRestart.mode}`);
  if (Number.isFinite(lastRestart.tookMs)) parts.push(`用时=${lastRestart.tookMs}ms`);
  if (Number.isFinite(lastRestart.completedAt)) parts.push(`完成于=${formatTime(lastRestart.completedAt)}`);
  if (nonEmpty(lastRestart.requestId) !== undefined) parts.push(`requestId=${lastRestart.requestId}`);
  return parts.length > 0 ? parts.join(' ') : '有（字段无法识别）';
}

function describeValidation(validation) {
  if (validation === null || validation === undefined) return '未提供';
  const detail = nonEmpty(validation.detail);
  if (validation.ok === true) return `通过${detail === undefined ? '' : `（${detail}）`}`;
  return `失败${detail === undefined ? '' : `（${detail}）`}，relaunch 会拒绝执行`;
}

function describeMarkerSummary(summary) {
  if (!summary.present) return '缺失';
  if (summary.invalid) return '存在但无法解析';
  const parts = [`status=${summary.status ?? '—'}`];
  if (summary.requestId !== null) parts.push(`requestId=${summary.requestId}`);
  if (summary.childPid !== null) parts.push(`childPid=${summary.childPid}${summary.childAlive ? '（存活）' : ''}`);
  if (summary.at !== null) parts.push(`at=${formatTime(summary.at)}`);
  if (summary.detail !== null) parts.push(`detail=${clip(summary.detail, 100)}`);
  return parts.join(' ');
}

function describeLockSummary(summary) {
  if (!summary.present) return '缺失';
  if (summary.invalid) return '存在但无法解析（视为陈旧）';
  const parts = [];
  if (summary.pid === null) parts.push('持有者 pid=未知（视为陈旧）');
  else parts.push(`持有者 pid=${summary.pid}（${summary.holderAlive ? '存活' : '已退出 → 陈旧'}）`);
  if (summary.requestId !== null) parts.push(`requestId=${summary.requestId}`);
  if (summary.at !== null) parts.push(`at=${formatTime(summary.at)}`);
  return parts.join(' ');
}

function renderStatusText(ctx) {
  const lines = [];
  lines.push('DSH 重启状态');
  lines.push(`状态目录：${ctx.dir}（来源：${ctx.dirSource}${ctx.dirExists ? '' : '，目录不存在'}）`);
  lines.push(`生成时间：${formatTime(ctx.at)}`);
  lines.push('');
  lines.push('【文件】');
  lines.push(row('state.json', describeStateFile(ctx.files.state)));
  lines.push(row('status.json', describeStatusFile(ctx.files.status)));
  lines.push(row('restart-intent.json', describeIntentFile(ctx.files.intent)));
  lines.push(row('force-reaper-spec.json', describeSpecFile(ctx)));
  lines.push(row('relaunch-ready.json', describeMarkerFile(ctx.files.marker)));
  lines.push(row('force-relaunch.lock', describeLockFile(ctx)));
  lines.push(row('relaunch.log', describeLogFile(ctx.files.log)));
  lines.push('');
  lines.push('【Host】');
  if (ctx.hostPid === undefined) {
    lines.push(row('pid', '未知（state.json 与 status.json 都没有有效 pid）'));
  } else {
    lines.push(
      row('pid', `${ctx.hostPid}（${ctx.hostAlive ? '存活' : '已退出'}，来源 ${ctx.hostSource}）`),
    );
  }
  lines.push(row('phase', ctx.phase === 'unknown' ? '未知（缺少 status.json）' : ctx.phase));
  lines.push(row('pending', describePending(ctx.pending, ctx.pendingSource)));
  lines.push(row('hold', describeHold(ctx.hold)));
  lines.push(row('lastError', describeErrorish(ctx.lastError)));
  lines.push(row('lastForceOutcome', describeOutcome(ctx.lastForceOutcome)));
  lines.push(row('lastRestart', describeLastRestart(ctx.lastRestart)));
  if (ctx.bootIdMismatch) {
    lines.push(row('快照一致性', 'status.json 与 state.json 的 bootId 不一致，status.json 可能是旧快照'));
  }
  lines.push('');
  lines.push('【强制重启产物】');
  if (!ctx.files.spec.present) {
    lines.push(row('spec', '缺失（没有待恢复的强制重启）'));
  } else if (ctx.files.spec.invalid) {
    lines.push(row('spec', `存在但${ctx.files.spec.error}`));
  } else {
    const summary = ctx.specSummary;
    lines.push(
      row(
        'spec',
        `requestId=${summary.requestId ?? '—'} mode=${summary.mode ?? '—'} platform=${summary.platform ?? '—'}`,
      ),
    );
    lines.push(
      row(
        'spec.hostPid',
        summary.hostPid === null
          ? '缺失或非法'
          : `${summary.hostPid}（${summary.hostAlive ? '存活' : '已退出'}）`,
      ),
    );
    lines.push(row('spec.validation', describeValidation(summary.validation)));
    lines.push(row('启动命令', summary.command?.text ?? '—'));
    if (summary.command?.cwd !== null && summary.command?.cwd !== undefined) {
      lines.push(row('cwd', summary.command.cwd));
    }
    if (summary.issues.length > 0) lines.push(row('spec 问题', summary.issues.join('；')));
  }
  lines.push(row('marker', describeMarkerSummary(ctx.markerSummary)));
  if (ctx.specSummary.present) {
    lines.push(
      row(
        'marker 对齐',
        !ctx.markerSummary.present
          ? '无 marker'
          : ctx.markerSummary.matchesSpec
            ? 'requestId 与 spec 一致'
            : 'requestId 与 spec 不一致',
      ),
    );
  }
  lines.push(row('lock', describeLockSummary(ctx.lockSummary)));
  lines.push('');
  if (ctx.files.log.present && ctx.files.log.lines.length > 0) {
    lines.push(`【relaunch.log 尾部（${ctx.files.log.lines.length} 行）】`);
    for (const line of ctx.files.log.lines) lines.push(`  | ${line}`);
  } else if (ctx.files.log.present) {
    lines.push('【relaunch.log】文件存在但没有内容');
  } else {
    lines.push('【relaunch.log】缺失');
  }
  lines.push('');
  lines.push('【建议】');
  for (const item of ctx.suggestions) lines.push(`  - ${item.text}`);
  return lines;
}

function buildStatusJson(ctx) {
  const fileJson = (file) => ({
    present: file.present,
    invalid: file.invalid === true,
    error: file.error ?? null,
  });
  return {
    command: 'status',
    ok: true,
    at: ctx.at,
    dir: ctx.dir,
    dirSource: ctx.dirSource,
    dirExists: ctx.dirExists,
    files: {
      state: fileJson(ctx.files.state),
      status: fileJson(ctx.files.status),
      intent: fileJson(ctx.files.intent),
      spec: fileJson(ctx.files.spec),
      marker: fileJson(ctx.files.marker),
      lock: fileJson(ctx.files.lock),
      log: {
        present: ctx.files.log.present,
        size: ctx.files.log.size ?? null,
        truncated: ctx.files.log.truncated === true,
        error: ctx.files.log.error ?? null,
      },
    },
    state: ctx.state ?? null,
    status: ctx.status ?? null,
    intent: ctx.intent ?? null,
    spec: ctx.spec ?? null,
    marker: ctx.marker ?? null,
    lock: ctx.lock ?? null,
    host: {
      pid: ctx.hostPid ?? null,
      alive: ctx.hostAlive,
      source: ctx.hostSource ?? null,
    },
    phase: ctx.phase,
    pending: ctx.pending ?? null,
    pendingSource: ctx.pendingSource ?? null,
    hold: ctx.hold ?? null,
    holdActive: ctx.holdActive,
    lastError: ctx.lastError ?? null,
    lastForceOutcome: ctx.lastForceOutcome ?? null,
    lastRestart: ctx.lastRestart ?? null,
    bootIdMismatch: ctx.bootIdMismatch,
    specSummary: ctx.specSummary,
    markerSummary: ctx.markerSummary,
    lockSummary: ctx.lockSummary,
    relaunchLogTail: ctx.files.log.lines,
    suggestions: ctx.suggestions,
  };
}

/* ------------------------------------------------------------------ status -- */

function runStatus(dir, source) {
  const ctx = collectStatus(dir, source);
  return { code: EXIT_OK, lines: renderStatusText(ctx), json: buildStatusJson(ctx) };
}

/* ---------------------------------------------------------------- relaunch -- */

/**
 * Build the spawn plan from a spec, mirroring force-reaper.mjs `launch()`.
 * @returns {{ok: true, plan: object} | {ok: false, detail: string}}
 */
function buildLaunchPlan(spec) {
  if (spec.platform === 'desktop') {
    const executable = nonEmpty(spec.appExecutable);
    if (executable === undefined) {
      return { ok: false, detail: 'spec.platform=desktop 但缺少 appExecutable，无法拉起桌面应用' };
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    return {
      ok: true,
      plan: {
        platform: 'desktop',
        executable,
        args: [],
        cwd: nonEmpty(spec.appDir),
        env,
        windowsHide: false,
        envNote: '继承当前环境，已移除 ELECTRON_RUN_AS_NODE / ELECTRON_NO_ATTACH_CONSOLE',
        text: formatCommand(executable, []),
      },
    };
  }
  const relaunch = spec.relaunch !== null && typeof spec.relaunch === 'object' ? spec.relaunch : undefined;
  const executable = nonEmpty(relaunch?.execPath);
  if (executable === undefined) {
    return { ok: false, detail: 'spec.platform=web 但缺少 relaunch.execPath，无法拉起' };
  }
  const execArgv = stringArray(relaunch?.execArgv);
  const args = [...execArgv, ...stringArray(relaunch?.args)];
  if (args.length === 0) {
    return { ok: false, detail: 'spec.relaunch.args 为空，拉起后没有可执行的 DSH 命令' };
  }
  return {
    ok: true,
    plan: {
      platform: 'web',
      executable,
      args,
      cwd: nonEmpty(relaunch?.cwd),
      env: process.env,
      windowsHide: true,
      envNote: '继承当前环境',
      text: formatCommand(executable, args),
    },
  };
}

function planJson(plan) {
  return {
    platform: plan.platform,
    executable: plan.executable,
    args: plan.args,
    cwd: plan.cwd ?? null,
    windowsHide: plan.windowsHide,
    envNote: plan.envNote,
    text: plan.text,
  };
}

/**
 * Try to take the relaunch lock exactly like the force reaper: exclusive create,
 * a live holder always wins, a dead or unreadable holder is stale and retried
 * once. A broken lock path is not a reason to skip the repair.
 */
function acquireLock(lockPath, requestId) {
  for (let attempt = 1; attempt <= LOCK_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeFileSync(
          fd,
          `${JSON.stringify({ pid: process.pid, requestId: requestId ?? null, at: Date.now() })}\n`,
        );
      } finally {
        closeSync(fd);
      }
      return { acquired: true, attempt };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { acquired: true, attempt, degraded: error?.code ?? messageOf(error) };
      }
    }
    const holder = readJsonFile(lockPath);
    const holderPid = validPid(holder.value?.pid);
    if (holderPid !== undefined && holderPid !== process.pid && isAlive(holderPid)) {
      return { acquired: false, reason: 'live-holder', holderPid, holder: holder.value };
    }
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return {
          acquired: false,
          reason: 'unlink-failed',
          detail: error?.code ?? messageOf(error),
        };
      }
    }
  }
  return { acquired: false, reason: 'exhausted' };
}

function releaseLock(lockPath) {
  const holder = readJsonFile(lockPath);
  const holderPid = validPid(holder.value?.pid);
  if (holderPid !== undefined && holderPid !== process.pid) {
    return { released: false, detail: `锁已归 pid ${holderPid} 所有，跳过释放` };
  }
  try {
    unlinkSync(lockPath);
    return { released: true, detail: '已释放' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { released: true, detail: '锁文件已不存在' };
    return { released: false, detail: `无法释放（${error?.code ?? messageOf(error)}）` };
  }
}

function spawnPlan(plan) {
  const child = spawn(plan.executable, plan.args, {
    cwd: plan.cwd,
    env: plan.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: plan.windowsHide,
  });
  child.unref();
  return child;
}

/**
 * Watch one launch attempt for at most `waitMs`.
 * A child that is still alive is a success; a child that exits cleanly (a
 * handoff or fire-and-forget command) is also a success, like force-reaper.mjs.
 * @returns {Promise<{ok: boolean, alive?: boolean, exitedCleanly?: boolean, detail: string}>}
 */
function waitLaunch(child, waitMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    let exitInfo;
    let spawnError;
    const classify = () => {
      if (spawnError !== undefined) {
        return { ok: false, detail: `spawn 错误：${messageOf(spawnError)}` };
      }
      if (exitInfo === undefined) {
        return { ok: true, alive: true, detail: `进程存活 ${waitMs}ms` };
      }
      if (exitInfo.code === 0 && exitInfo.signal === null) {
        return { ok: true, exitedCleanly: true, detail: '命令已正常退出（视为拉起成功）' };
      }
      return {
        ok: false,
        detail: `进程提前退出（code=${String(exitInfo.code)}，signal=${String(exitInfo.signal)}）`,
      };
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    child.once('error', (error) => {
      spawnError = error;
      finish(classify());
    });
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
      finish(classify());
    });
    timer = setTimeout(() => finish(classify()), waitMs);
  });
}

async function runRelaunch(dir, source, options) {
  const lines = ['DSH 重启 CLI — relaunch', `状态目录：${dir}（来源：${source}）`];
  const json = {
    command: 'relaunch',
    ok: true,
    dir,
    dirSource: source,
    at: Date.now(),
    executed: false,
    relaunched: false,
    pid: null,
    attempts: 0,
    waitMs: options.waitMs,
    lockPath: null,
    markerPath: null,
  };
  const ctx = collectStatus(dir, source);

  const specFile = ctx.files.spec;
  if (!specFile.present) {
    lines.push(`错误：找不到 ${SPEC_FILE}（${join(dir, SPEC_FILE)}）。没有可用的启动参数；请确认 --dir 或先让插件武装一次强制重启。`);
    return { code: EXIT_MISSING, lines, json: { ...json, ok: false, error: 'spec-missing' } };
  }
  if (specFile.invalid) {
    lines.push(`错误：${SPEC_FILE} 不可用：${specFile.error}。修复或删除该文件后重试。`);
    return { code: EXIT_MISSING, lines, json: { ...json, ok: false, error: 'spec-invalid', detail: specFile.error } };
  }

  const spec = specFile.value;
  const requestId = nonEmpty(spec.requestId);
  const markerPath = resolveSpecPath(spec.markerPath, dir, MARKER_FILE);
  const logPath = resolveSpecPath(spec.logPath, dir, LOG_FILE);
  const lockPath = resolveSpecPath(spec.lockPath, dir, LOCK_FILE);
  json.lockPath = lockPath;
  json.markerPath = markerPath;

  lines.push(`spec：requestId=${requestId ?? '—'} mode=${spec.mode ?? '—'} platform=${spec.platform === 'desktop' ? 'desktop' : 'web'}`);

  if (spec.mode === 'shutdown') {
    lines.push('拒绝执行：该 spec 属于强制关闭（mode=shutdown），不是重启。执行 clear-stale --yes 清理残留，需要恢复运行请手动启动 DSH。');
    return { code: EXIT_REFUSED, lines, json: { ...json, ok: false, error: 'shutdown-spec' } };
  }

  const validation = spec.validation !== null && typeof spec.validation === 'object' ? spec.validation : undefined;
  if (validation !== undefined && validation.ok === false) {
    const detail = nonEmpty(validation.detail) ?? '未提供原因';
    lines.push(`拒绝执行：spec.validation.ok=false（${detail}）。启动参数在武装时已校验失败，请修复后重新发起强制重启，或执行 clear-stale --yes 清理。`);
    return { code: EXIT_MISSING, lines, json: { ...json, ok: false, error: 'spec-validation-failed', detail } };
  }

  const hostPid = validPid(spec.hostPid);
  const specHostAlive = hostPid !== undefined && isAlive(hostPid);
  const otherHosts = liveHostEvidence(ctx).filter((item) => item.source !== SPEC_FILE);

  const planResult = buildLaunchPlan(spec);
  if (planResult.ok) {
    lines.push(`命令：${planResult.plan.text}`);
    lines.push(`cwd：${planResult.plan.cwd ?? '（继承当前目录）'}`);
  }

  if (specHostAlive) {
    lines.push(`拒绝执行：spec.hostPid 仍存活（pid ${hostPid}）。强制重启产物只应在 Host 退出后用于补拉；请等待其退出，或确认卡死后先结束该进程。`);
    return {
      code: EXIT_REFUSED,
      lines,
      json: { ...json, ok: false, error: 'host-alive', hostPid },
    };
  }
  if (otherHosts.length > 0) {
    const detail = otherHosts.map((item) => `pid ${item.pid}（${item.source}）`).join('、');
    lines.push(`拒绝执行：检出仍存活的 Host 进程 ${detail}。已有新的 Host 在运行，重复拉起会造成双实例。`);
    return {
      code: EXIT_REFUSED,
      lines,
      json: { ...json, ok: false, error: 'duplicate-host', hosts: otherHosts },
    };
  }
  // A previous relaunch (CLI or reaper) may have spawned a Host that has not
  // written state.json yet; its marker child is the only proof it exists.
  if (ctx.markerSummary.matchesSpec && ctx.markerSummary.status === 'relaunched' && ctx.markerSummary.childAlive) {
    lines.push(
      `拒绝执行：marker 记录的上次拉起进程仍存活（pid ${ctx.markerSummary.childPid}），很可能已有新 Host 在启动。` +
        '等待它写入 state.json；若确认无响应，先结束该进程或执行 clear-stale --yes。',
    );
    return {
      code: EXIT_REFUSED,
      lines,
      json: { ...json, ok: false, error: 'launched-child-alive', childPid: ctx.markerSummary.childPid },
    };
  }
  if (hostPid === undefined) {
    lines.push('警告：spec 缺少有效 hostPid，无法确认 Host 是否已退出；与 reaper 行为一致，继续执行。');
  } else {
    lines.push(`Host pid ${hostPid}：已退出。`);
  }
  if (ctx.holdActive) {
    lines.push(`提示：state.json 中 hold 生效（原因 ${ctx.hold.reason ?? '未记录'}）；手动 relaunch 不受 hold 限制，成功后建议执行 unhold。`);
  }
  if (!planResult.ok) {
    lines.push(`拒绝执行：${planResult.detail}。请修复 spec 或执行 clear-stale --yes 清理。`);
    return { code: EXIT_MISSING, lines, json: { ...json, ok: false, error: 'launch-plan-invalid', detail: planResult.detail } };
  }

  const plan = planResult.plan;
  if (!existsSync(plan.executable)) {
    lines.push(`警告：可执行文件当前不存在（${plan.executable}），spawn 可能以 ENOENT 失败。`);
  }

  if (!options.yes) {
    lines.push('');
    lines.push('演练：未执行任何拉起（加 --yes 实际执行）。');
    lines.push(`  env：${plan.envNote}`);
    lines.push(`  验证：每次拉起后等待 ${options.waitMs}ms，最多 ${LAUNCH_ATTEMPTS} 次尝试`);
    lines.push(`  锁：${lockPath}`);
    lines.push(`  marker：${markerPath}`);
    return {
      code: EXIT_OK,
      lines,
      json: { ...json, executed: false, wouldRun: planJson(plan) },
    };
  }

  const lock = acquireLock(lockPath, requestId);
  json.lock = { path: lockPath, acquired: lock.acquired, degraded: lock.degraded ?? null, reason: lock.reason ?? null };
  if (!lock.acquired) {
    if (lock.reason === 'live-holder') {
      lines.push(`未执行：relaunch 锁被存活进程持有（pid ${lock.holderPid}，requestId ${lock.holder?.requestId ?? '未知'}）。`);
      lines.push('另一个 relaunch 正在执行；本次跳过，稍后用 status 复查。');
    } else if (lock.reason === 'unlink-failed') {
      lines.push(`未执行：无法清理陈旧锁（${lock.detail}），请检查权限后重试。`);
      return {
        code: EXIT_WRITE_FAILED,
        lines,
        json: { ...json, ok: false, error: 'lock-unavailable', detail: lock.detail },
      };
    } else {
      lines.push('未执行：未能取得 relaunch 锁（可能有并发 relaunch 刚抢到）。本次跳过，稍后重试。');
    }
    return { code: EXIT_OK, lines, json: { ...json, ok: true, skipped: lock.reason } };
  }
  if (lock.degraded !== undefined) {
    lines.push(`警告：无法使用锁文件（${lock.degraded}），继续执行（与 reaper 一致）。`);
  } else {
    lines.push(`锁：已获得（${lockPath}）`);
  }

  const retryDelayMs = Math.min(1000, Math.max(150, Math.round(options.waitMs / 2)));
  const attempts = [];
  let succeeded;
  let lastDetail = '没有尝试拉起';
  let launchTargetPid;

  try {
    for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt += 1) {
      json.attempts = attempt;
      let child;
      try {
        child = spawnPlan(plan);
      } catch (error) {
        lastDetail = `spawn 失败：${messageOf(error)}`;
        attempts.push({ attempt, ok: false, pid: null, detail: lastDetail });
        lines.push(`[${attempt}/${LAUNCH_ATTEMPTS}] ${lastDetail}`);
        if (attempt < LAUNCH_ATTEMPTS) await sleep(retryDelayMs);
        continue;
      }
      launchTargetPid = child.pid;
      const outcome = await waitLaunch(child, options.waitMs);
      attempts.push({ attempt, ok: outcome.ok, pid: child.pid ?? null, detail: outcome.detail });
      if (outcome.ok) {
        succeeded = { pid: child.pid, attempt, detail: outcome.detail };
        lines.push(`[${attempt}/${LAUNCH_ATTEMPTS}] 成功：${outcome.detail}（pid ${child.pid ?? '未知'}）`);
        break;
      }
      lastDetail = outcome.detail;
      lines.push(`[${attempt}/${LAUNCH_ATTEMPTS}] 失败：${lastDetail}`);
      if (attempt < LAUNCH_ATTEMPTS) await sleep(retryDelayMs);
    }
  } catch (error) {
    lastDetail = `内部错误：${messageOf(error)}`;
    lines.push(`拉起过程中出错：${lastDetail}`);
  }

  json.attemptDetails = attempts;

  if (succeeded !== undefined) {
    lines.push(`结果：relaunched pid=${succeeded.pid ?? '未知'}（第 ${succeeded.attempt} 次尝试）`);
    json.executed = true;
    json.relaunched = true;
    json.pid = succeeded.pid ?? null;
    json.ok = true;
    const release = releaseLock(lockPath);
    lines.push(`锁：${release.detail}`);
    const markerWrite = writeMarkerFile(markerPath, {
      requestId: requestId ?? null,
      status: 'relaunched',
      pid: process.pid,
      childPid: succeeded.pid ?? null,
      at: Date.now(),
      source: 'restart-cli',
    });
    lines.push(
      markerWrite.ok
        ? `marker：已写入 status=relaunched（${markerPath}）`
        : `marker：写入失败（${markerWrite.error}），不影响拉起结果`,
    );
    appendLog(
      logPath,
      `restart-cli: relaunch succeeded pid=${String(succeeded.pid)} requestId=${JSON.stringify(requestId ?? null)} lock=${lockPath}`,
    );
    json.marker = { path: markerPath, written: markerWrite.ok, error: markerWrite.error ?? null };
    json.lock.released = release.released;
    return { code: EXIT_OK, lines, json };
  }

  const detail = `relaunch 失败：${LAUNCH_ATTEMPTS} 次尝试均未成功（最后原因：${lastDetail}）`;
  lines.push(`结果：${detail}`);
  json.ok = false;
  json.error = 'launch-failed';
  json.detail = detail;
  json.executed = true;
  json.pid = launchTargetPid ?? null;
  const release = releaseLock(lockPath);
  lines.push(`锁：${release.detail}`);
  const markerWrite = writeMarkerFile(markerPath, {
    requestId: requestId ?? null,
    status: 'error',
    pid: process.pid,
    at: Date.now(),
    detail: `restart-cli: ${lastDetail}`,
    source: 'restart-cli',
  });
  lines.push(
    markerWrite.ok
      ? `marker：已写入 status=error（${markerPath}）`
      : `marker：写入失败（${markerWrite.error}）`,
  );
  appendLog(logPath, `restart-cli: relaunch FAILED ${lastDetail} requestId=${JSON.stringify(requestId ?? null)}`);
  json.marker = { path: markerPath, written: markerWrite.ok, error: markerWrite.error ?? null };
  json.lock.released = release.released;
  lines.push('请检查 relaunch.log 尾部与 spec 中的命令后重试。');
  return { code: EXIT_LAUNCH_FAILED, lines, json };
}

/* -------------------------------------------------------------- clear-stale -- */

function runClearStale(dir, source, options) {
  const lines = ['DSH 重启 CLI — clear-stale', `状态目录：${dir}（来源：${source}）`];
  const json = {
    command: 'clear-stale',
    ok: true,
    dir,
    dirSource: source,
    at: Date.now(),
    executed: false,
    deleted: [],
  };
  const ctx = collectStatus(dir, source);
  const specPresent = ctx.files.spec.present;
  const markerPresent = ctx.files.marker.present;
  const lockPresent = ctx.files.lock.present;

  if (!specPresent && !markerPresent && !lockPresent) {
    lines.push('没有可清理的产物：force-reaper-spec.json / relaunch-ready.json / force-relaunch.lock 都不存在。');
    return { code: EXIT_OK, lines, json: { ...json, nothingToDo: true } };
  }

  lines.push(`Host pid（spec）：${ctx.specSummary.hostPid ?? '无'}${ctx.specSummary.hostPid === null ? '' : `（${ctx.specSummary.hostAlive ? '存活' : '已退出'}）`}`);
  lines.push(`Host pid（state/status）：${ctx.hostPid ?? '无'}${ctx.hostPid === undefined ? '' : `（${ctx.hostAlive ? '存活' : '已退出'}）`}`);
  lines.push(
    `锁持有者：${ctx.lockSummary.present ? (ctx.lockSummary.pid === null ? '无法识别' : `pid ${ctx.lockSummary.pid}（${ctx.lockSummary.holderAlive ? '存活' : '已退出'}）`) : '无锁文件'}`,
  );

  const otherHosts = liveHostEvidence(ctx).filter((item) => item.source !== SPEC_FILE);
  if (ctx.specSummary.hostAlive) {
    lines.push(`拒绝清理：Host 仍存活（spec.hostPid=${ctx.specSummary.hostPid}）。等它退出后再执行，或确认卡死后先结束该进程。`);
    return {
      code: EXIT_REFUSED,
      lines,
      json: { ...json, ok: false, error: 'host-alive', hostPid: ctx.specSummary.hostPid },
    };
  }
  if (otherHosts.length > 0) {
    const detail = otherHosts.map((item) => `pid ${item.pid}（${item.source}）`).join('、');
    lines.push(`拒绝清理：state/status/intent 记录的 Host 仍存活 ${detail}。`);
    return {
      code: EXIT_REFUSED,
      lines,
      json: { ...json, ok: false, error: 'duplicate-host', hosts: otherHosts },
    };
  }
  if (ctx.lockSummary.holderAlive) {
    lines.push(`拒绝清理：锁持有者仍存活（pid ${ctx.lockSummary.pid}），relaunch 可能正在执行。`);
    return {
      code: EXIT_REFUSED,
      lines,
      json: { ...json, ok: false, error: 'lock-holder-alive', lockPid: ctx.lockSummary.pid },
    };
  }

  const targets = [];
  if (specPresent) targets.push({ name: SPEC_FILE, path: join(dir, SPEC_FILE) });
  if (markerPresent) targets.push({ name: MARKER_FILE, path: join(dir, MARKER_FILE) });
  if (lockPresent) targets.push({ name: LOCK_FILE, path: join(dir, LOCK_FILE) });
  lines.push(`Host 与锁持有者都已退出，产物可安全清理：${targets.map((item) => item.name).join('、')}`);
  json.wouldDelete = targets.map((item) => item.name);

  if (!options.yes) {
    lines.push('演练：未删除任何文件（加 --yes 执行）。');
    return { code: EXIT_OK, lines, json };
  }

  const deleted = [];
  const failed = [];
  for (const target of targets) {
    try {
      unlinkSync(target.path);
      deleted.push(target.name);
      lines.push(`已删除 ${target.name}`);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        deleted.push(target.name);
        lines.push(`已删除 ${target.name}（原本已不存在）`);
      } else {
        failed.push({ file: target.name, error: error?.code ?? messageOf(error) });
        lines.push(`删除失败 ${target.name}：${error?.code ?? messageOf(error)}`);
      }
    }
  }
  json.executed = true;
  json.deleted = deleted;
  json.failed = failed;
  if (failed.length > 0) {
    lines.push('部分产物未能删除，请检查目录权限后重试。');
    return { code: EXIT_WRITE_FAILED, lines, json: { ...json, ok: false, error: 'delete-failed' } };
  }
  lines.push('清理完成。现在可以手动启动 DSH。');
  return { code: EXIT_OK, lines, json };
}

/* ------------------------------------------------------------------- unhold -- */

function runUnhold(dir, source) {
  const lines = ['DSH 重启 CLI — unhold', `状态目录：${dir}（来源：${source}）`];
  const json = { command: 'unhold', ok: true, dir, dirSource: source, at: Date.now(), changed: false };
  const statePath = join(dir, STATE_FILE);
  const stateFile = readJsonFile(statePath);

  if (!stateFile.present) {
    lines.push(`错误：${STATE_FILE} 不存在（${statePath}）。还没有运行过插件，或 --dir 指向了错误的目录。`);
    return { code: EXIT_MISSING, lines, json: { ...json, ok: false, error: 'state-missing' } };
  }
  if (stateFile.invalid) {
    lines.push(`错误：${STATE_FILE} 不可用：${stateFile.error}。为避免破坏状态，未做任何修改。`);
    return { code: EXIT_MISSING, lines, json: { ...json, ok: false, error: 'state-invalid', detail: stateFile.error } };
  }

  const state = stateFile.value;
  const hold = state.hold;
  const emptyObject =
    hold !== null && typeof hold === 'object' && !Array.isArray(hold) && Object.keys(hold).length === 0;
  if (hold === undefined || hold === null || emptyObject) {
    lines.push('当前没有 hold（state.json 中 hold 为空），无需修改。');
    return { code: EXIT_OK, lines, json: { ...json, hold: null } };
  }

  lines.push(`当前 hold：${describeHold(hold)}`);
  delete state.hold;
  const write = writeJsonAtomic(statePath, state);
  if (!write.ok) {
    lines.push(`错误：写回 ${STATE_FILE} 失败（${write.error}），hold 未清除。`);
    return { code: EXIT_WRITE_FAILED, lines, json: { ...json, ok: false, error: 'write-failed', detail: write.error } };
  }
  lines.push(`已清除 ${STATE_FILE} 中的 hold。`);
  json.changed = true;
  json.ok = true;
  json.cleared = hold;
  if (hold !== null && typeof hold === 'object' && hold.active === true) {
    lines.push('提示：hold 生效期间强制重启曾被暂停；确认上次失败原因已处理后，自动行为恢复。');
  }
  lines.push('提示：status.json 是 Host 写入的快照，可能仍显示旧 hold，会在下次 Host 写入或启动时刷新。');
  return { code: EXIT_OK, lines, json };
}

/* -------------------------------------------------------------------- main -- */

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    out(USAGE);
    return EXIT_USAGE;
  }

  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    out(`错误：${messageOf(error)}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (options.help) {
    out(USAGE);
    return EXIT_OK;
  }

  const dir = resolveStateDir(options.dir);
  const source = dirSource(options.dir);

  let result;
  try {
    if (options.command === 'status') result = runStatus(dir, source);
    else if (options.command === 'relaunch') result = await runRelaunch(dir, source, options);
    else if (options.command === 'clear-stale') result = runClearStale(dir, source, options);
    else result = runUnhold(dir, source);
  } catch (error) {
    const detail = messageOf(error);
    result = {
      code: EXIT_FAILURE,
      lines: ['DSH 重启 CLI 内部错误', `状态目录：${dir}`, `错误：${detail}`],
      json: { command: options.command, ok: false, dir, error: detail },
    };
  }
  return emit(result, options.json);
}

process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => fatal(error),
);
