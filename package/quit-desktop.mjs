/**
 * Desktop-shell quit helper (Windows).
 *
 * The Desktop app owns the Host as a child process. On a human shutdown the Host
 * cannot ask the Electron shell to quit through the official IPC: that channel
 * only carries shell→Host commands (shutdown, quit-inspection, update-tasks).
 * Simply exiting the Host makes the shell treat it as a crash, keep the window
 * open, and show the fatal "backend stopped" dialog — the app is then half alive
 * and restarting the backend through that dialog can wedge the conversation.
 *
 * This detached helper terminates the Electron shell so the window closes with
 * the backend. The Host saves sessions in parallel and exits shortly after, so
 * the shell cannot observe an unexpected child exit and show its recovery dialog.
 */
import { spawnSync } from 'node:child_process';
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
  await sleep(payload.delayMs ?? 300);
  log(`desktop quit helper start main=${String(payload.mainPid)} host=${String(payload.hostPid)}`);

  let killed = false;
  for (let attempt = 1; attempt <= 3 && !killed; attempt += 1) {
    const result = spawnSync('taskkill', ['/F', '/PID', String(payload.mainPid)], { windowsHide: true, encoding: 'utf8' });
    log(
      `taskkill attempt=${String(attempt)} exit=${String(result.status)} error=${result.error === undefined ? '' : String(result.error.code ?? result.error)} stderr=${String(result.stderr ?? '').trim()}`,
    );
    killed = await waitGone(payload.mainPid, 4000);
    if (killed) break;
    // Fallback: Node's process.kill maps to TerminateProcess on Windows and can
    // still work where an external taskkill invocation is unavailable.
    try {
      process.kill(payload.mainPid);
    } catch (error) {
      log(`process.kill fallback failed: ${error instanceof Error ? (error.code ?? error.message) : String(error)}`);
    }
    killed = await waitGone(payload.mainPid, 2000);
  }
  if (killed) log('electron shell terminated for shutdown');
  else log('electron shell is still alive; the window may remain open');
}

main().catch((error) => {
  log(`desktop quit helper failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 1;
});
