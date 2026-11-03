/**
 * Detached relaunch helper for the DSH restart plugin.
 *
 * The DSH process spawns this script with `detached: true` / ignored stdio, a
 * JSON spec path (`argv[2]`) and a readiness marker path (`argv[3]`), then asks
 * the launcher for a graceful shutdown. This script outlives the old process,
 * waits until its parent PID is gone, and starts a fresh DSH using the exact
 * same node binary, exec args, script arguments, cwd, and inherited environment.
 * Every step is appended to the spec's log file so a failed restart can be
 * diagnosed without a console.
 *
 * The Host never parses this log to decide readiness. Instead this helper
 * writes the marker early and atomically:
 *   - `{ requestId, status: 'started', pid, at }` as soon as the spec is read;
 *   - `{ requestId, status: 'relaunched', pid, at, childPid }` after the new
 *     process was spawned;
 *   - `{ requestId, status: 'error', pid, at, detail }` on every failure path
 *     (including an unreadable spec, detected through `argv[3]`).
 *
 * Spec fields (see index.js):
 *   { requestId, markerPath, pid, execPath, execArgv, args, cwd, logPath,
 *     waitTimeoutMs, delayMs }
 */
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

const specPath = process.argv[2];
const markerPathArg =
  typeof process.argv[3] === 'string' && process.argv[3].length > 0 ? process.argv[3] : undefined;

let spec;
let specError;
try {
  const parsed = JSON.parse(readFileSync(specPath, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('spec is not a JSON object');
  }
  spec = parsed;
} catch (error) {
  specError = error;
}

const markerPath =
  markerPathArg ??
  (typeof spec?.markerPath === 'string' && spec.markerPath.length > 0 ? spec.markerPath : undefined);
const requestId = typeof spec?.requestId === 'string' ? spec.requestId : undefined;
const logPath = typeof spec?.logPath === 'string' ? spec.logPath : undefined;

function log(message) {
  const line = `[${new Date().toISOString()}] [relauncher ${process.pid}] ${message}\n`;
  if (logPath !== undefined) {
    try {
      appendFileSync(logPath, line);
    } catch {
      /* logging must never abort the relaunch */
    }
  }
}

/**
 * Publish the readiness marker the Host waits for. Written through a temp file
 * and renamed so a reader never sees a half-written marker; failures are
 * ignored because the marker is diagnostics, not durability.
 * @param {'started'|'relaunched'|'error'} status - helper state.
 * @param {object} [extra] - additional marker fields (childPid, detail).
 */
function writeMarker(status, extra = {}) {
  if (markerPath === undefined) return;
  const payload = { requestId, status, pid: process.pid, at: Date.now(), ...extra };
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
  } catch {
    try {
      writeFileSync(markerPath, text);
    } catch {
      /* the marker must never abort the relaunch */
    }
  }
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by someone else.
    return error?.code === 'EPERM';
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
  return true;
}

function launch() {
  const execArgv = Array.isArray(spec.execArgv) ? spec.execArgv.filter((value) => typeof value === 'string') : [];
  const args = Array.isArray(spec.args) ? spec.args.filter((value) => typeof value === 'string') : [];
  const child = spawn(spec.execPath, [...execArgv, ...args], {
    cwd: typeof spec.cwd === 'string' && spec.cwd.length > 0 ? spec.cwd : undefined,
    env: process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('error', (error) => {
    log(`spawn error: ${error instanceof Error ? error.message : String(error)}`);
  });
  child.unref();
  return child;
}

async function main() {
  if (specError !== undefined) {
    const detail = specError instanceof Error ? specError.message : String(specError);
    writeMarker('error', { detail: `cannot read spec: ${detail}` });
    process.exit(2);
    return;
  }
  log('relauncher started');
  writeMarker('started');
  log(
    `spec: execPath=${JSON.stringify(spec.execPath)} args=${JSON.stringify(spec.args)} cwd=${JSON.stringify(spec.cwd)}` +
      ` pid=${String(spec.pid)} requestId=${String(requestId)} markerPath=${JSON.stringify(markerPath)}`,
  );
  const waitTimeoutMs = Number.isSafeInteger(spec.waitTimeoutMs) && spec.waitTimeoutMs > 0 ? spec.waitTimeoutMs : 120000;
  const gone = await waitForExit(spec.pid, waitTimeoutMs);
  if (!gone) {
    const detail = `old process ${String(spec.pid)} did not exit within ${String(waitTimeoutMs)}ms`;
    log(`${detail}; giving up`);
    writeMarker('error', { detail });
    process.exit(3);
    return;
  }
  log(`old process ${String(spec.pid)} exited`);
  const delayMs = Number.isSafeInteger(spec.delayMs) && spec.delayMs >= 0 ? spec.delayMs : 500;
  await sleep(delayMs);

  const attempts = 3;
  let lastChild;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const child = launch();
    lastChild = child;
    log(`launch attempt ${String(attempt)} spawned pid ${String(child.pid)}`);
    await sleep(2500);
    if (child.pid !== undefined && !isAlive(child.pid)) {
      const code = child.exitCode;
      log(`launched process ${String(child.pid)} exited early (code ${String(code)})`);
      if (attempt < attempts) await sleep(1000);
      continue;
    }
    log('relaunch succeeded');
    writeMarker('relaunched', { childPid: child.pid ?? null });
    process.exit(0);
  }
  const detail = `relaunch failed after ${String(attempts)} attempts (last pid ${String(lastChild?.pid)})`;
  log(detail);
  writeMarker('error', { detail });
  process.exit(5);
}

main().catch((error) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  log(`unexpected failure: ${detail}`);
  writeMarker('error', { detail });
  process.exit(1);
});
