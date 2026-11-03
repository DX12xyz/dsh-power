/**
 * Desktop-shell relaunch helper (Windows).
 *
 * The Desktop app owns the Host as a child process, so a restart cannot come
 * from the Host itself. This detached helper terminates the Electron shell,
 * waits for the old Host to finish its graceful shutdown, and then starts the
 * desktop application again. The new shell boots the Host, which delivers the
 * post-restart completion messages to the requesting AIs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const payload = JSON.parse(process.argv[2]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  try {
    appendFileSync(payload.logPath, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    /* diagnostics only */
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await sleep(150);
  }
  return !alive(pid);
}

async function main() {
  await sleep(payload.delayMs ?? 1200);
  log(`desktop relauncher start request=${String(payload.requestId)} main=${String(payload.mainPid)} host=${String(payload.hostPid)}`);

  let killed = false;
  for (let attempt = 1; attempt <= 3 && !killed; attempt += 1) {
    const result = spawnSync('taskkill', ['/F', '/PID', String(payload.mainPid)], { windowsHide: true, encoding: 'utf8' });
    log(`taskkill attempt=${String(attempt)} exit=${String(result.status)} stderr=${String(result.stderr ?? '').trim()}`);
    killed = await waitGone(payload.mainPid, 5000);
  }
  if (!killed) {
    log('electron shell is still alive; aborting relaunch (the host rolls the restart back)');
    return;
  }

  const hostGone = await waitGone(payload.hostPid, 20000);
  log(`old host exited=${String(hostGone)}`);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const child = spawn(payload.appExecutable, [], {
    cwd: payload.appDir,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env,
  });
  child.unref();
  log(`desktop app relaunched pid=${String(child.pid)}`);
}

main().catch((error) => {
  log(`desktop relauncher failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
