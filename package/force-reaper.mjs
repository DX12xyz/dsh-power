/**
 * Detached force reaper for the DSH restart plugin.
 *
 * index.js writes a JSON spec, spawns this script with `detached: true` /
 * ignored stdio and then hard-exits. The reaper therefore outlives the Host: it
 * waits a bounded time for a graceful exit, force-kills whatever is still alive
 * (`taskkill /F` on Windows — never `/T`, which would also hit this process —
 * and SIGKILL elsewhere), then either stops (shutdown) or relaunches the same
 * command once per request (restart). Desktop paths also clear the Electron
 * shell (`mainPid`) before relaunching, even when the Host already exited:
 * a surviving shell holds the single-instance lock and swallows the new app.
 *
 * The Host never parses this log to decide readiness. Instead this helper
 * publishes the marker atomically (temp file + rename):
 *   - `{ requestId, status: 'done', pid, at }` after a forced shutdown;
 *   - `{ requestId, status: 'relaunched', pid, at, childPid }` after a relaunch;
 *   - `{ requestId, status: 'error', pid, at, detail }` on every failure path
 *     (including an unreadable spec, detected through `argv[3]`).
 *
 * Log, lock, and marker failures are swallowed: they must never prevent the
 * kill. Spec fields (see index.js):
 *   { version, requestId, mode, platform, hostPid, mainPid, killAfterMs,
 *     killGraceMs, relaunchDelayMs, relaunch, appExecutable, appDir,
 *     markerPath, logPath, lockPath }
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';

// Tunables fixed by the contract (SPEC.md §1).
const POLL_MS = 100;
const KILL_ATTEMPTS = 3;
const KILL_RETRY_MS = 400;
const LAUNCH_ATTEMPTS = 3;
const LAUNCH_VERIFY_MS = 2500;
const LAUNCH_RETRY_MS = 1000;
// Desktop only: let the old Electron shell finish dying before the app starts.
const SHELL_SETTLE_MS = 500;

const specPath = process.argv[2];
const markerPathArg =
  typeof process.argv[3] === 'string' && process.argv[3].length > 0 ? process.argv[3] : undefined;

let spec;
let specError;
try {
  if (typeof specPath !== 'string' || specPath.length === 0) {
    throw new Error('missing spec path argument');
  }
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
const logPath = typeof spec?.logPath === 'string' && spec.logPath.length > 0 ? spec.logPath : undefined;
const lockPath =
  typeof spec?.lockPath === 'string' && spec.lockPath.length > 0 ? spec.lockPath : undefined;
const requestId = typeof spec?.requestId === 'string' ? spec.requestId : undefined;
const isDesktop = spec?.platform === 'desktop';
const isShutdown = spec?.mode === 'shutdown';

function log(message) {
  const line = `[force-reaper ${process.pid}] [${new Date().toISOString()}] ${message}\n`;
  if (logPath !== undefined) {
    try {
      appendFileSync(logPath, line);
    } catch {
      /* logging must never abort the kill or the relaunch */
    }
  }
}

/**
 * Publish the final marker. Written through a temp file and renamed so a reader
 * never sees a half-written marker; failures are ignored because the marker is
 * diagnostics, not durability.
 * @param {'done'|'relaunched'|'error'} status - reaper state.
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
      /* the marker must never abort the kill or the relaunch */
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

/** @returns {boolean} true once `pid` is gone, false after `timeoutMs`. */
async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false;
    await sleep(POLL_MS);
  }
  return true;
}

function toPid(value, label) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  if (value !== undefined && value !== null) log(`ignoring invalid ${label}: ${JSON.stringify(value)}`);
  return undefined;
}

function duration(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/**
 * Run a short-lived helper detached and hidden, and wait for it to finish.
 * Detaching matters here: the helper must not die with this reaper, and
 * `windowsHide` without a new process group is refused by some hosts.
 * @returns {Promise<string|undefined>} failure text, or undefined on success.
 */
function runHelper(command, args) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (message) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(message);
    };
    let child;
    try {
      child = spawn(command, args, { stdio: 'ignore', windowsHide: true, detached: true });
    } catch (error) {
      finish(`${command} could not start: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(`${command} did not finish in time`);
    }, 5000);
    child.once('error', (error) => {
      finish(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    child.once('exit', (code) => {
      finish(code === 0 ? undefined : `${command} exited with code ${String(code)}`);
    });
  });
}

/**
 * One kill attempt. Windows deliberately uses `taskkill /F /PID` without `/T`:
 * a tree kill would reach this reaper when it lives under the Host. POSIX uses
 * SIGKILL directly.
 */
async function killOnce(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === 'win32') {
    const failure = await runHelper('taskkill', ['/F', '/PID', String(pid)]);
    if (failure === undefined) return;
    if (!isAlive(pid)) {
      log(`${failure}, but ${pid} is already gone`);
      return;
    }
    // A restricted token can deny taskkill; TerminateProcess is the last resort
    // so a force kill still means "the process dies".
    log(`${failure}; falling back to TerminateProcess for ${pid}`);
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      log(`TerminateProcess ${pid} failed: ${error?.code ?? 'unknown'}`);
    }
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    const code = error?.code ?? 'unknown';
    log(`SIGKILL ${pid} failed: ${code}`);
  }
}

/**
 * Kill `pid` with at most KILL_ATTEMPTS attempts (KILL_RETRY_MS apart), then
 * wait up to `killGraceMs` for it to disappear.
 * @returns {Promise<boolean>} true when the process is gone.
 */
async function forceKill(pid, label, killGraceMs) {
  for (let attempt = 1; attempt <= KILL_ATTEMPTS; attempt += 1) {
    if (!isAlive(pid)) {
      log(`${label} ${pid} is already gone`);
      return true;
    }
    log(`kill attempt ${attempt}/${KILL_ATTEMPTS} for ${label} ${pid}`);
    await killOnce(pid);
    await sleep(KILL_RETRY_MS);
    if (!isAlive(pid)) {
      log(`${label} ${pid} terminated`);
      return true;
    }
  }
  const deadline = Date.now() + killGraceMs;
  while (isAlive(pid) && Date.now() < deadline) await sleep(POLL_MS);
  const gone = !isAlive(pid);
  log(gone ? `${label} ${pid} terminated` : `${label} ${pid} survived ${killGraceMs}ms after the kill`);
  return gone;
}

/**
 * Make sure the Electron shell is gone. A desktop restart must always do this,
 * even when the Host died on its own: a surviving shell keeps the
 * single-instance lock and would swallow the relaunched app.
 * @returns {Promise<boolean>} true when the shell is gone.
 */
async function ensureShellGone(mainPid, killGraceMs) {
  if (!isAlive(mainPid)) {
    log(`shell ${mainPid} already gone`);
    return true;
  }
  log(`killing electron shell ${mainPid}`);
  const gone = await forceKill(mainPid, 'shell', killGraceMs);
  log(gone ? `shell ${mainPid} gone` : `shell ${mainPid} is still alive`);
  return gone;
}

function readLock() {
  if (lockPath === undefined) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Take the relaunch lock with an exclusive create so only one reaper relaunches
 * a given request. A live holder always wins (even for the same requestId) to
 * avoid a double launch; a dead or unreadable holder is stale and retried once.
 * @returns {boolean} true when this process owns the lock (or locking is
 *   impossible, in which case the relaunch must still be attempted).
 */
function acquireLock() {
  if (lockPath === undefined) {
    log('spec has no lockPath; relaunching without a lock');
    return true;
  }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
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
      log(`lock acquired at ${lockPath} (attempt ${attempt})`);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        // A broken lock path is not a reason to skip the relaunch.
        log(`lock error at ${lockPath}: ${error?.code ?? String(error)}; continuing without it`);
        return true;
      }
    }
    const holder = readLock();
    const holderPid = Number.isSafeInteger(holder?.pid) && holder.pid > 0 ? holder.pid : undefined;
    if (holderPid !== undefined && holderPid !== process.pid && isAlive(holderPid)) {
      const holderRequestId = typeof holder?.requestId === 'string' ? holder.requestId : undefined;
      log(
        `lock held by live pid ${holderPid} (requestId ${JSON.stringify(holderRequestId)});` +
          ` not relaunching again`,
      );
      return false;
    }
    log(`stale lock at ${lockPath} (holder ${JSON.stringify(holder ?? null)}); removing and retrying`);
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`cannot remove stale lock: ${error?.code ?? String(error)}`);
    }
  }
  log('could not acquire the relaunch lock; another reaper is relaunching');
  return false;
}

function releaseLock() {
  if (lockPath === undefined) return;
  try {
    unlinkSync(lockPath);
    log(`lock released at ${lockPath}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`cannot release lock: ${error?.code ?? String(error)}`);
  }
}

/**
 * Spawn the replacement process. The spec carries the exact web command
 * (`relaunch`) or the Electron app pair (`appExecutable` / `appDir`). Desktop
 * launches must not look like a plain Node child of the old shell, so the two
 * Electron markers are stripped from the environment.
 */
function launch() {
  if (isDesktop) {
    const appExecutable =
      typeof spec?.appExecutable === 'string' && spec.appExecutable.length > 0
        ? spec.appExecutable
        : undefined;
    if (appExecutable === undefined) throw new Error('spec has no appExecutable');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    const child = spawn(appExecutable, [], {
      cwd: typeof spec?.appDir === 'string' && spec.appDir.length > 0 ? spec.appDir : undefined,
      env,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    log(`spawning desktop app ${JSON.stringify(appExecutable)}`);
    return child;
  }

  const relaunch = spec?.relaunch;
  const execPath =
    typeof relaunch?.execPath === 'string' && relaunch.execPath.length > 0
      ? relaunch.execPath
      : process.execPath;
  const execArgv = Array.isArray(relaunch?.execArgv)
    ? relaunch.execArgv.filter((value) => typeof value === 'string')
    : [];
  const args = Array.isArray(relaunch?.args) ? relaunch.args.filter((value) => typeof value === 'string') : [];
  const cwd = typeof relaunch?.cwd === 'string' && relaunch.cwd.length > 0 ? relaunch.cwd : undefined;
  const child = spawn(execPath, [...execArgv, ...args], {
    cwd,
    env: process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  log(`spawning ${JSON.stringify(execPath)} ${JSON.stringify([...execArgv, ...args])} cwd=${JSON.stringify(cwd)}`);
  return child;
}

async function main() {
  if (specError !== undefined) {
    const detail = specError instanceof Error ? specError.message : String(specError);
    writeMarker('error', { detail: `cannot read spec: ${detail}` });
    process.exit(2);
    return;
  }

  const hostPid = toPid(spec.hostPid, 'hostPid');
  const mainPid = toPid(spec.mainPid, 'mainPid');
  const killAfterMs = duration(spec.killAfterMs, 2500);
  const killGraceMs = duration(spec.killGraceMs, 5000);
  const relaunchDelayMs = duration(spec.relaunchDelayMs, 500);

  if (isDesktop && mainPid === undefined) {
    log('desktop spec has no mainPid; the Electron shell cannot be cleared');
  }

  log(
    `started: mode=${isShutdown ? 'shutdown' : 'restart'} platform=${isDesktop ? 'desktop' : 'web'}` +
      ` hostPid=${String(hostPid)} mainPid=${String(mainPid)} killAfterMs=${killAfterMs}` +
      ` killGraceMs=${killGraceMs} requestId=${JSON.stringify(requestId)}`,
  );

  // Phase 1: give the Host its bounded chance to leave on its own.
  if (hostPid !== undefined && (await waitForExit(hostPid, killAfterMs))) {
    log(`host ${hostPid} already gone (exited within ${killAfterMs}ms)`);
  } else if (hostPid !== undefined) {
    log(`host ${hostPid} still alive after ${killAfterMs}ms; forcing`);
    // Phase 2: desktop shells first (the Electron main may own the Host), then
    // the Host itself if it is still around.
    if (isDesktop && mainPid !== undefined) await ensureShellGone(mainPid, killGraceMs);
    if (isAlive(hostPid)) await forceKill(hostPid, 'host', killGraceMs);
  } else {
    log('no usable hostPid in spec; skipping the graceful wait');
  }

  if (isShutdown) {
    // A forced desktop close must take the Electron shell down as well, whether
    // or not the Host had already exited.
    if (isDesktop && mainPid !== undefined) await ensureShellGone(mainPid, killGraceMs);
    log('shutdown complete');
    writeMarker('done');
    process.exit(0);
    return;
  }

  // Restart: only one reaper may relaunch a given request.
  if (!acquireLock()) {
    log('relaunch already owned by another reaper; exiting without relaunching');
    process.exit(0);
    return;
  }

  // The Host is routinely SIGKILLed by index.js ~250ms after the intent, so the
  // graceful wait usually finds it dead and the shell is still running. Clear
  // the shell here, after the lock, so a losing reaper never touches it.
  if (isDesktop && mainPid !== undefined) {
    await ensureShellGone(mainPid, killGraceMs);
    await sleep(SHELL_SETTLE_MS);
  }

  await sleep(relaunchDelayMs);

  let lastChildPid;
  let lastDetail = 'no launch was attempted';
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt += 1) {
    let child;
    try {
      child = launch();
    } catch (error) {
      lastDetail = `launch attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`;
      log(lastDetail);
      if (attempt < LAUNCH_ATTEMPTS) await sleep(LAUNCH_RETRY_MS);
      continue;
    }
    lastChildPid = child.pid;
    let spawnError;
    child.once('error', (error) => {
      spawnError = error;
      log(`spawn error for pid ${String(child.pid)}: ${error instanceof Error ? error.message : String(error)}`);
    });
    child.unref();
    log(`launch attempt ${attempt}/${LAUNCH_ATTEMPTS} spawned pid ${String(child.pid)}`);

    await sleep(LAUNCH_VERIFY_MS);
    if (child.pid !== undefined && isAlive(child.pid)) {
      log(`relaunch verified: pid ${String(child.pid)} is alive after ${LAUNCH_VERIFY_MS}ms`);
      writeMarker('relaunched', { childPid: child.pid });
      releaseLock();
      process.exit(0);
      return;
    }
    if (
      spawnError === undefined &&
      child.pid !== undefined &&
      child.exitCode === 0 &&
      child.signalCode === null
    ) {
      // A fire-and-forget launch command (for example a handoff script) may
      // finish immediately; a clean exit still means the relaunch happened.
      log(`launch command pid ${String(child.pid)} completed cleanly; treating it as relaunched`);
      writeMarker('relaunched', { childPid: child.pid });
      releaseLock();
      process.exit(0);
      return;
    }
    lastDetail =
      `launched process ${String(child.pid)} exited early` +
      ` (code ${String(child.exitCode)}, signal ${String(child.signalCode)})`;
    log(lastDetail);
    if (attempt < LAUNCH_ATTEMPTS) await sleep(LAUNCH_RETRY_MS);
  }

  const detail = `relaunch failed after ${LAUNCH_ATTEMPTS} attempts (last pid ${String(lastChildPid)}): ${lastDetail}`;
  log(detail);
  writeMarker('error', { detail });
  releaseLock();
  process.exit(5);
}

function fatal(error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  log(`unexpected failure: ${detail}`);
  writeMarker('error', { detail });
  process.exit(1);
}

process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
main().catch(fatal);
