/**
 * @local/dsh-power — Client half (v1.8.2).
 *
 * Human entry:
 *  - a square「DSH电源」button appended into the sidebar footer's
 *    `div[class*="_settingsArea"]` (web and Desktop share this DOM), plus a
 *    `sidebar.footer.action` fallback if that container never appears;
 *  - a menu with the three human restart modes — 等待 / 中断 / 强制 — and 关闭 DSH;
 *  - per-mode confirmation: 等待 can be cancelled, 中断 asks for a second
 *    confirmation, 强制 requires holding the confirm button for 5 seconds with an
 *    accelerating flash;
 *  - a frame-wide overlay (`shell.overlay`) owning dialogs, progress, failure,
 *    shutdown screens and the post-restart toast.
 *
 * The browser talks to the Host half over the authenticated shared API channel:
 *   GET  /api/dsh-restart/status
 *   POST /api/dsh-restart/request      {source:'ui', mode:'safe'|'coordinated'|'dangerous', confirmed?}
 *   POST /api/dsh-restart/shutdown     (human-only; never exposed as an AI tool)
 *   GET  /api/dsh-restart/pod          (is the optional escape pod plugin present?)
 *   GET  /api/dsh-restart/config       (plugin page: roll-call wait)
 *   POST /api/dsh-restart/config       {rollCallWaitMs} (plugin page: write it back)
 * The page is reloaded once the new Host answers with a different bootId.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-power',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dshRestart';
    const OVERLAY_ORDER = 1000;
    const POWER_ORDER = 0;
    const API_STATUS = '/api/dsh-restart/status';
    const API_REQUEST = '/api/dsh-restart/request';
    const API_SHUTDOWN = '/api/dsh-restart/shutdown';
    const API_POD = '/api/dsh-restart/pod';
    const API_CONFIG = '/api/dsh-restart/config';
    const PENDING_KEY = 'dsh-restart.pending-request';
    const LAST_SEEN_KEY = 'dsh-restart.last-seen-restart';
    const POLL_INTERVAL_MS = 700;
    const DOWN_TIMEOUT_MS = 180000;
    const SHUTDOWN_TIMEOUT_MS = 45000;
    const BOOT_WATCH_INTERVAL_MS = 12000;
    const REQUEST_TIMEOUT_MS = 5000;
    // hotfix.4: route-mount failures (404/502/503/504) after a restart need a
    // wider window than transient connection failures, so the two classes get
    // separate retry budgets. Every attempt keeps its own 3000ms timeout.
    const API_ATTEMPT_TIMEOUT_MS = 3000;
    const API_HTTP_RETRY_ATTEMPTS = 12;
    const API_HTTP_RETRY_DELAY_MS = 600;
    const API_NETWORK_RETRY_ATTEMPTS = 3;
    const API_NETWORK_RETRY_DELAY_MS = 800;
    const API_RETRY_STATUSES = [404, 502, 503, 504];
    const TOAST_TTL_MS = 10000;
    const HOLD_MS = 5000;
    const HOLD_TICK_MS = 50;
    const DOM_POWER_ID = 'dshrd-dom-power';
    const DOM_RETRY_MS = 1200;

    /* ------------------------------------------------------------- locales -- */

    const zh = {
      'power.title': 'DSH电源',
      'menu.restart': '重启',
      'menu.shutdown': '关闭',
      'dialog.mode': '模式',
      'mode.safe': '等待',
      'mode.coordinated': '中断',
      'mode.dangerous': '强制',
      'dialog.restart.title': '重启 DSH',
      'dialog.shutdown.title': '关闭 DSH',
      'dialog.reason.label': '原因（可选）',
      'dialog.reason.placeholder': '例如：升级后重启 / 调整配置',
      'dialog.restart.safe': '等待所有其他运行中的 AI 完成当前回合并输出后重启；不会中断任何 AI。',
      'dialog.restart.coordinated': '向未就绪的运行中 AI 广播，要求其停止派生子代理/工具并进入就绪状态；所有活跃 AI 进入就绪状态后重启，可能等待较久。',
      'dialog.restart.dangerous': '立即中断所有未就绪的运行中 AI，不等待完成；未完成的工作可能丢失。',
      'dialog.shutdown.safe': '等待所有其他运行中的 AI 完成当前回合并输出后关闭；不会中断任何 AI，也不会重新启动。',
      'dialog.shutdown.coordinated': '向未就绪的运行中 AI 广播，要求其停止派生子代理/工具；所有活跃 AI 停止后关闭，不会重新启动。',
      'dialog.shutdown.dangerous': '立即中断所有运行中的 AI 并关闭；未完成的工作可能丢失，且不会重新启动。',
      'dialog.shutdown.closePod': '同时关闭正在运行的逃生舱',
      'dialog.dangerous.warning': '将中断 {count} 个正在运行的 AI。',
      'dialog.dangerous.warningHint': '确认按钮需要长按 5 秒；中途松开即取消。',
      'dialog.hold.restart': '长按 5 秒强制重启',
      'dialog.hold.shutdown': '长按 5 秒强制关闭',
      'dialog.holding': '继续按住… {seconds} 秒',
      'dialog.holding.progress': '继续按住，已 {elapsed} 秒，剩余 {remaining} 秒',
      'dialog.cancel': '取消',
      'dialog.confirm.restart': '确认重启',
      'dialog.confirm.shutdown': '确认关闭',
      'dialog.next': '下一步',
      'dialog.step2.title': '再次确认',
      'dialog.step2.restart': '确定以【中断】模式重启 DSH？',
      'dialog.step2.shutdown': '确定以【中断】模式关闭 DSH？',
      'dialog.step2.confirm': '确认中断',
      'dialog.running': '当前有 {count} 个 AI 正在运行。',
      'dialog.hint.restart': '重启期间页面会短暂断开连接，不会打开新标签页。',
      'dialog.hint.shutdown': '关闭后页面会失去连接，这是正常现象。',
      'dialog.infoError': '无法读取运行状态：{message}',
      'submitting': '正在提交请求…',
      'waiting.title.safe': '正在等待所有 AI 完成当前回合并重启 DSH…',
      'waiting.title.coordinated': '正在催促其他 AI 并重启 DSH…',
      'waiting.title.dangerous': '正在中断运行中的 AI 并重启 DSH…',
      'waiting.shutdown.title.safe': '正在等待所有 AI 完成后关闭 DSH…',
      'waiting.shutdown.title.coordinated': '正在催促其他 AI 并关闭 DSH…',
      'waiting.shutdown.title.dangerous': '正在中断运行中的 AI 并关闭 DSH…',
      'waiting.shutdown.deadline': '已等待 {elapsed} 秒；最多再等 {seconds} 秒（到点后仍在运行的 AI 会被终止）。',
      'waiting.shutdown.elapsed': '已等待 {elapsed} 秒。',
      'waiting.running.restart': '正在等待 {count} 个 AI 就绪或完成当前回合…',
      'waiting.running.shutdown': '正在等待 {count} 个 AI 停止…',
      'waiting.idle.restart': '正在重启，请稍候，页面会自动恢复…',
      'waiting.idle.shutdown': '正在关闭，页面随后会断开连接…',
      'waiting.down': 'DSH 正在处理，等待服务响应…',
      'waiting.hint.restart': '请不要关闭本页面。',
      'waiting.hint.shutdown': '页面断开即表示关闭完成，这是正常现象。',
      'waiting.rollCallRemaining': '· 剩余 {seconds} 秒后不再等待',
      'failed.title': '操作未完成',
      'failed.request': '无法提交重启请求：{message}',
      'failed.request.shutdown': '无法提交关闭请求：{message}',
      'error.routeNotReady': '重启服务接口尚未就绪（HTTP 404），请稍后重试',
      'failed.timeout': '等待超时：DSH 服务在 {seconds} 秒内没有恢复。请检查启动 DSH 的终端（或重新运行 dsh web），然后刷新本页。',
      'failed.timeout.desktop': '等待超时：DSH 服务在 {seconds} 秒内没有恢复。请退出并重新打开桌面应用，然后刷新本页。',
      'failed.reload': '刷新页面',
      'failed.close': '关闭',
      'shutdown.submitting': '正在提交关闭请求…',
      'shutdown.doneTitle': 'DSH 已关闭',
      'shutdown.doneBody': '本页面与后端服务连接已断开，DSH已退出',
      'shutdown.doneBody.desktop': '本页面与后端服务连接已断开，DSH已退出',
      'shutdown.donePod': '运行的逃生舱已关闭',
      'shutdown.timeout': '关闭超时：DSH 似乎仍在运行。请稍后手动关闭本页，或检查启动 DSH 的终端。',
      'toast.safe': 'DSH 已重启完成：已等待所有 AI 完成当前回合，页面已自动恢复。',
      'toast.safeAi': 'DSH 已重启完成：已等待所有 AI 完成当前回合（{count} 个 AI 请求）。',
      'toast.coordinated': 'DSH 已重启完成：所有活跃 AI 已就绪或结束当前回合，未中断任何 AI。',
      'toast.coordinatedTimedOut': 'DSH 已重启完成：等待时间用尽时仍有 {count} 个 AI 未就绪，已继续重启；它们可能被中断。',
      'toast.force': 'DSH 已重启完成：立即中断了 {interrupted} 个运行中的 AI；中断通知成功 {delivered} 个、失败 {failed} 个。等待/催促的使用者与发起者已就绪；被中断的 AI 可能丢失进度或结果未知，请检查相关会话。',
      'toast.forceNoInterrupt': 'DSH 已重启完成：本次没有其他 AI 被中断。除非确有需要，否则优先等待所有 AI 完成。',
      'toast.close': '关闭',
      'settings.title': '电源设置',
      'settings.desc': '点名等待会广播并要求其他 AI 就绪；超过等待时间后不再等待，继续重启或关闭，并记录仍未就绪的 AI。',
      'settings.summary': '点名等待：{seconds} 秒（0 = 永久等待）',
      'settings.wait.label': '点名等待时间',
      'settings.wait.unit': '秒',
      'settings.loading': '读取中…',
      'settings.loadFailed': '读取配置失败：{message}',
      'settings.loadFailedHint': '读取配置失败，请刷新插件页后重试。',
      'settings.save': '保存',
      'settings.saving': '保存中…',
      'settings.saved': '已保存，立即生效（不会重载插件）',
      'settings.saveFailed': '保存失败：{message}',
      'settings.saveFailedHint': '保存失败，请稍后重试。',
      'settings.invalid': '请输入 0–3600 之间的整数秒数（0 = 永久等待）。',
      'settings.readOnly': '运行设置目录不可写，无法保存；请直接修改 profile 补丁。',
      'settings.note': '范围 0–3600 秒；0 = 永久等待。保存写入运行设置并立即生效，不会触发插件热重载。',
      'settings.current': '当前生效：{seconds} 秒',
    };

    const en = {
      'power.title': 'DSH power',
      'menu.restart': 'Restart',
      'menu.shutdown': 'Shut down',
      'dialog.mode': 'Mode',
      'mode.safe': 'Wait',
      'mode.coordinated': 'Interrupt',
      'mode.dangerous': 'Force',
      'dialog.restart.title': 'Restart DSH',
      'dialog.shutdown.title': 'Shut down DSH',
      'dialog.reason.label': 'Reason (optional)',
      'dialog.reason.placeholder': 'e.g. restart after upgrading / config change',
      'dialog.restart.safe': 'Waits until every other running AI finishes its current turn and output, then restarts; no AI is interrupted.',
      'dialog.restart.coordinated': 'Broadcasts to running AIs that are not ready, asking them to stop their subagents/tools and become ready; restarts after every active AI is ready. This may take a while.',
      'dialog.restart.dangerous': 'Immediately interrupts every running AI that is not ready; unfinished work may be lost.',
      'dialog.shutdown.safe': 'Waits until every other running AI finishes its current turn and output, then shuts down; no AI is interrupted and DSH does not relaunch.',
      'dialog.shutdown.coordinated': 'Broadcasts to running AIs that are not ready, asking them to stop their subagents/tools; shuts down after every active AI stops. DSH does not relaunch.',
      'dialog.shutdown.dangerous': 'Immediately interrupts every running AI and shuts down; unfinished work may be lost and DSH does not relaunch.',
      'dialog.shutdown.closePod': 'Also close the running escape pod',
      'dialog.dangerous.warning': 'This will interrupt {count} running AI(s).',
      'dialog.dangerous.warningHint': 'Hold the confirm button for 5 seconds; release early to cancel.',
      'dialog.hold.restart': 'Hold 5s to force restart',
      'dialog.hold.shutdown': 'Hold 5s to force shutdown',
      'dialog.holding': 'Keep holding… {seconds}s',
      'dialog.holding.progress': 'Keep holding: {elapsed}s elapsed, {remaining}s remaining',
      'dialog.cancel': 'Cancel',
      'dialog.confirm.restart': 'Confirm restart',
      'dialog.confirm.shutdown': 'Confirm shutdown',
      'dialog.next': 'Next',
      'dialog.step2.title': 'Confirm again',
      'dialog.step2.restart': 'Restart DSH in INTERRUPT mode?',
      'dialog.step2.shutdown': 'Shut down DSH in INTERRUPT mode?',
      'dialog.step2.confirm': 'Confirm interrupt',
      'dialog.running': '{count} AI(s) are currently running.',
      'dialog.hint.restart': 'The page disconnects briefly; no new browser tab is opened.',
      'dialog.hint.shutdown': 'The page loses its connection after shutdown; this is normal.',
      'dialog.infoError': 'Could not read the running state: {message}',
      'submitting': 'Submitting request…',
      'waiting.title.safe': 'Waiting for every AI to finish before restarting DSH…',
      'waiting.title.coordinated': 'Nudging the other AIs before restarting DSH…',
      'waiting.title.dangerous': 'Interrupting running AIs and restarting DSH…',
      'waiting.shutdown.title.safe': 'Waiting for every AI to finish before shutting down DSH…',
      'waiting.shutdown.title.coordinated': 'Nudging the other AIs before shutting down DSH…',
      'waiting.shutdown.title.dangerous': 'Interrupting running AIs and shutting down DSH…',
      'waiting.shutdown.deadline': 'Waited {elapsed}s; up to {seconds}s remaining (AIs still running at the deadline will be terminated).',
      'waiting.shutdown.elapsed': 'Waited {elapsed}s.',
      'waiting.running.restart': 'Waiting for {count} AI(s) to become ready or finish the current turn…',
      'waiting.running.shutdown': 'Waiting for {count} AI(s) to stop…',
      'waiting.idle.restart': 'Restarting, please wait; the page recovers automatically…',
      'waiting.idle.shutdown': 'Shutting down; the page disconnects shortly…',
      'waiting.down': 'DSH is working; waiting for the service to respond…',
      'waiting.hint.restart': 'Please keep this page open.',
      'waiting.hint.shutdown': 'The page disconnecting means shutdown completed; this is normal.',
      'waiting.rollCallRemaining': '· Not waiting after {seconds}s',
      'failed.title': 'Operation did not complete',
      'failed.request': 'Could not submit the restart request: {message}',
      'failed.request.shutdown': 'Could not submit the shutdown request: {message}',
      'error.routeNotReady': 'The restart API is not ready yet (HTTP 404). Please retry in a moment.',
      'failed.timeout': 'Timed out: the DSH server did not come back within {seconds} seconds. Check the terminal that launched DSH (or run dsh web again), then reload this page.',
      'failed.timeout.desktop': 'Timed out: the DSH server did not come back within {seconds} seconds. Quit and reopen the desktop app, then reload this page.',
      'failed.reload': 'Reload page',
      'failed.close': 'Close',
      'shutdown.submitting': 'Submitting shutdown request…',
      'shutdown.doneTitle': 'DSH shut down',
      'shutdown.doneBody': 'The connection between this page and the backend service has been closed; DSH has exited.',
      'shutdown.doneBody.desktop': 'The connection between this page and the backend service has been closed; DSH has exited.',
      'shutdown.donePod': 'The running escape pod was shut down.',
      'shutdown.timeout': 'Shutdown timed out: DSH seems to still be running. Close this page later or check the terminal that launched DSH.',
      'toast.safe': 'DSH restarted after waiting for every AI to finish; the page recovered automatically.',
      'toast.safeAi': 'DSH restarted after waiting for every AI to finish ({count} AI request(s)).',
      'toast.coordinated': 'DSH restarted: every active AI was ready or finished its turn; no AI was interrupted.',
      'toast.coordinatedTimedOut': 'DSH restarted: the wait ran out with {count} AI(s) still not ready, so the restart continued; they may have been interrupted.',
      'toast.force': 'DSH restarted: {interrupted} running AI(s) were interrupted immediately; interruption notices delivered: {delivered}, failed: {failed}. Wait/nudge users and the initiator were ready; interrupted AIs may lose progress or have unknown tool outcomes — check those sessions.',
      'toast.forceNoInterrupt': 'DSH restarted: no other AI was interrupted. Prefer waiting for every AI to finish unless there is an explicit need.',
      'toast.close': 'Close',
      'settings.title': 'Power settings',
      'settings.desc': 'Roll-call wait broadcasts and asks other AIs to become ready; once the wait time is used up, DSH stops waiting and continues the restart or shutdown, recording the AIs that were still not ready.',
      'settings.summary': 'Roll-call wait: {seconds}s (0 = wait forever)',
      'settings.wait.label': 'Roll-call wait time',
      'settings.wait.unit': 's',
      'settings.loading': 'Loading…',
      'settings.loadFailed': 'Could not read the config: {message}',
      'settings.loadFailedHint': 'Could not read the config; reload the plugin page and retry.',
      'settings.save': 'Save',
      'settings.saving': 'Saving…',
      'settings.saved': 'Saved; effective immediately (no plugin reload)',
      'settings.saveFailed': 'Could not save: {message}',
      'settings.saveFailedHint': 'Could not save; please retry later.',
      'settings.invalid': 'Enter a whole number of seconds from 0 to 3600 (0 = wait forever).',
      'settings.readOnly': 'The runtime settings directory is not writable; edit the profile patch directly.',
      'settings.note': 'Range 0–3600 seconds; 0 = wait forever. Saving writes a runtime setting that applies immediately and never triggers a plugin hot reload.',
      'settings.current': 'In effect now: {seconds}s',
    };

    /* --------------------------------------------------------- style sheet -- */

    const STYLE_ID = '@local/dsh-power/client.css';
    const CSS = `
.dshrd-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;height:32px;padding:0 14px;border-radius:8px;border:.5px solid var(--dsw-alias-state-error-primary);background:transparent;color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:1;cursor:pointer;font-family:inherit;transition:background .12s ease,color .12s ease}
.dshrd-button:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}
.dshrd-button:disabled{opacity:.5;cursor:default}
.dshrd-button-plain{border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.dshrd-button-plain:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}
.dshrd-button-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dshrd-button-primary:hover{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)}
.dshrd-power{width:28px;height:28px;flex:none;border:none;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;margin-right:2px;transition:background .12s ease,color .12s ease}
.dshrd-settings-power{margin-left:auto;margin-right:0}
.dshrd-power:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent));color:var(--dsw-alias-label-primary)}
.dshrd-power-active{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb, var(--dsw-alias-label-primary) 10%, transparent));color:var(--dsw-alias-label-primary)}
.dshrd-power:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshrd-menu-backdrop{position:fixed;inset:0;z-index:6300;background:transparent;pointer-events:auto}
.dshrd-menu{position:fixed;z-index:6310;width:196px;box-sizing:border-box;display:flex;flex-direction:column;gap:2px;padding:6px;border-radius:12px;border:.5px solid color-mix(in srgb, var(--dsw-alias-border-l1) 70%, transparent);background:color-mix(in srgb, var(--dsw-alias-bg-overlay) 78%, transparent);backdrop-filter:blur(22px) saturate(150%);-webkit-backdrop-filter:blur(22px) saturate(150%);box-shadow:0 16px 40px color-mix(in srgb, var(--dsw-alias-label-primary) 16%, transparent);color:var(--dsw-alias-label-primary);pointer-events:auto}
.dshrd-menu-sep{height:1px;margin:4px 6px;background:color-mix(in srgb, var(--dsw-alias-border-l1) 60%, transparent)}
.dshrd-menu-item{display:flex;align-items:center;width:100%;box-sizing:border-box;padding:8px 10px;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;white-space:nowrap}
.dshrd-menu-item:hover{background:color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent)}
.dshrd-menu-item-danger{color:var(--dsw-alias-state-error-primary)}
.dshrd-menu-item-danger:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}
.dshrd-backdrop{position:fixed;inset:0;z-index:6000;display:flex;align-items:center;justify-content:center;pointer-events:auto;background:color-mix(in srgb, var(--dsw-alias-bg-base) 28%, transparent);backdrop-filter:blur(18px) saturate(140%);-webkit-backdrop-filter:blur(18px) saturate(140%)}
.dshrd-card{width:min(470px,calc(100vw - 48px));max-height:calc(100vh - 48px);overflow:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:20px;border-radius:14px;border:.5px solid color-mix(in srgb, var(--dsw-alias-border-l1) 70%, transparent);background:color-mix(in srgb, var(--dsw-alias-bg-overlay) 74%, transparent);backdrop-filter:blur(26px) saturate(150%);-webkit-backdrop-filter:blur(26px) saturate(150%);color:var(--dsw-alias-label-primary);box-shadow:0 20px 56px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent)}
.dshrd-card-title{font-size:16px;line-height:22px;font-weight:600}
.dshrd-card-body{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.dshrd-card-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshrd-field{display:flex;align-items:center;gap:10px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dshrd-field-label{flex:none}
.dshrd-select{flex:1 1 auto;min-width:0;height:32px;box-sizing:border-box;padding:0 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 70%, transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;outline:none}
.dshrd-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshrd-select option{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary)}
.dshrd-input{flex:1 1 auto;min-width:0;height:32px;box-sizing:border-box;padding:0 10px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);background:color-mix(in srgb, var(--dsw-alias-bg-layer-1) 70%, transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dshrd-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:.72}
.dshrd-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dshrd-warning{margin-top:2px;padding:10px 12px;border-radius:8px;font-size:13px;line-height:19px;font-weight:500;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);border:.5px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent);overflow-wrap:anywhere}
.dshrd-warning-hint{margin-top:6px;font-size:12px;line-height:18px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.dshrd-danger-zone{margin-top:2px;padding:10px 12px;border-radius:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent);border:.5px dashed color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, transparent)}
.dshrd-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px;flex-wrap:wrap}
.dshrd-hold{position:relative;overflow:hidden;border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);animation-duration:700ms;animation-iteration-count:infinite;animation-timing-function:ease-in-out}
.dshrd-hold::after{content:'';position:absolute;left:0;bottom:0;height:2px;width:var(--dshrd-hold-progress,0%);background:var(--dsw-alias-state-error-primary);transition:width .06s linear}
.dshrd-hold-active{animation-name:dshrd-hold-pulse}
@keyframes dshrd-hold-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb, var(--dsw-alias-state-error-primary) 0%, transparent)}50%{box-shadow:0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, transparent)}}
.dshrd-progress{position:fixed;inset:0;z-index:6100;display:flex;align-items:center;justify-content:center;pointer-events:auto;background:color-mix(in srgb, var(--dsw-alias-bg-base) 22%, transparent);backdrop-filter:blur(20px) saturate(140%);-webkit-backdrop-filter:blur(20px) saturate(140%)}
.dshrd-progress-card{width:min(400px,calc(100vw - 48px));box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:12px;padding:26px 22px;border-radius:14px;border:.5px solid color-mix(in srgb, var(--dsw-alias-border-l1) 70%, transparent);background:color-mix(in srgb, var(--dsw-alias-bg-overlay) 70%, transparent);backdrop-filter:blur(26px) saturate(150%);-webkit-backdrop-filter:blur(26px) saturate(150%);color:var(--dsw-alias-label-primary);box-shadow:0 20px 56px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);text-align:center}
/* 圆环由 SVG 几何 + flex:0 0 auto 决定：Chromium 的 flex 压缩不能把圆拉成椭圆（桌面版回归修复）。 */
.dshrd-spinner{display:block;flex:0 0 auto;width:31px;height:31px;animation:dshrd-spin .9s linear infinite;transform-origin:50% 50%}
@keyframes dshrd-spin{to{transform:rotate(360deg)}}
.dshrd-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:6200;display:flex;align-items:center;gap:12px;max-width:min(560px,calc(100vw - 48px));box-sizing:border-box;padding:10px 14px;border-radius:10px;border:.5px solid color-mix(in srgb, var(--dsw-alias-border-l1) 70%, transparent);border-left:3px solid var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-bg-overlay) 80%, transparent);backdrop-filter:blur(20px) saturate(150%);-webkit-backdrop-filter:blur(20px) saturate(150%);color:var(--dsw-alias-label-primary);box-shadow:0 10px 32px color-mix(in srgb, var(--dsw-alias-label-primary) 18%, transparent);pointer-events:auto;font-size:13px;line-height:20px}
.dshrd-toast-danger{border-left-color:var(--dsw-alias-state-error-primary);box-shadow:0 10px 32px color-mix(in srgb, var(--dsw-alias-state-error-primary) 30%, transparent)}
.dshrd-toast-danger .dshrd-toast-message{color:var(--dsw-alias-label-primary)}
.dshrd-toast-close{flex:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer;font-family:inherit;padding:2px 4px}
.dshrd-toast-close:hover{color:var(--dsw-alias-label-primary)}
.dshrd-cfg{box-sizing:border-box;display:flex;flex-direction:column;gap:8px;max-width:640px;font-family:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dshrd-cfg-summary{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshrd-cfg-title{font-size:14px;line-height:20px;font-weight:600}
.dshrd-cfg-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshrd-cfg-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.dshrd-cfg-label{flex:none;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dshrd-input.dshrd-cfg-input{flex:0 0 110px;width:110px}
.dshrd-cfg-unit{flex:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshrd-cfg-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshrd-cfg-cur{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshrd-cfg-ok{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary);overflow-wrap:anywhere}
.dshrd-cfg-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dshrd-cfg-subtitle{font-size:13px;line-height:20px;font-weight:600;margin-top:4px}
.dshrd-cfg-check{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px}
.dshrd-cfg-check input{margin:0;width:14px;height:14px;accent-color:var(--dsw-alias-brand-primary)}
.dshrd-cfg-check-locked{opacity:.6}
.dshrd-cfg-check-danger{color:var(--dsw-alias-state-error-primary)}
.dshrd-cfg-check-danger input{accent-color:var(--dsw-alias-state-error-primary)}
.dshrd-cfg-save{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:4px}
`;

    let styleElement = null;
    function ensureStyles() {
      if (typeof document === 'undefined') return () => {};
      if (styleElement !== null && styleElement.isConnected) return () => {};
      styleElement = document.createElement('style');
      styleElement.dataset.plugin = '@local/dsh-power';
      styleElement.dataset.pluginCss = STYLE_ID;
      styleElement.textContent = CSS;
      document.head.appendChild(styleElement);
      return () => {
        try {
          styleElement?.remove();
        } catch {
          /* ignore */
        }
        styleElement = null;
      };
    }

    /* ------------------------------------------------------------- store ---- */

    const listeners = new Set();
    let snapshot = {
      stage: 'idle',
      action: 'restart',
      mode: 'safe',
      step: 1,
      reason: '',
      info: null,
      infoError: null,
      error: null,
      bootId: null,
      startedAt: 0,
      serverDown: false,
      toast: null,
      menu: null,
      powerHidden: false,
      domButtonReady: false,
      // Shutdown-only escape pod linkage (hotfix.9): availability is read from
      // GET /api/dsh-restart/pod when the dialog opens; the checkbox starts
      // unchecked and `closedEscapePod` remembers the submitted choice for the
      // done screen.
      podAvailable: false,
      closeEscapePod: false,
      closedEscapePod: false,
    };

    function setSnapshot(patch) {
      snapshot = Object.assign({}, snapshot, patch);
      for (const listener of Array.from(listeners)) {
        try {
          listener();
        } catch {
          /* a broken render must not break the store */
        }
      }
    }

    function subscribeStore(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function useStore() {
      const [value, setValue] = React.useState(snapshot);
      React.useEffect(() => subscribeStore(() => setValue(snapshot)), []);
      return value;
    }

    function useToastTimer(toast, clear) {
      React.useEffect(() => {
        if (toast === null) return undefined;
        const ttl = typeof toast.ttlMs === 'number' ? toast.ttlMs : TOAST_TTL_MS;
        const timer = setTimeout(clear, ttl);
        return () => clearTimeout(timer);
      }, [toast, clear]);
    }

    /* ------------------------------------------------------------- helpers -- */

    function errorText(error) {
      return error instanceof Error ? error.message : String(error);
    }

    async function apiRequest(url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, Object.assign({ credentials: 'same-origin', signal: controller.signal }, init));
        const text = await response.text();
        let data = {};
        try {
          data = text.length > 0 ? JSON.parse(text) : {};
        } catch {
          data = {};
        }
        if (!response.ok) {
          const error = new Error(data.error ?? `HTTP ${String(response.status)}`);
          error.status = response.status;
          throw error;
        }
        return data;
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * Retry policy by failure class:
     *  - HTTP 404/502/503/504 (route still mounting / gateway): 12 attempts, 600ms apart;
     *  - fetch rejection or AbortError timeout (pure network failure): 3 attempts, 800ms apart;
     *  - explicit denials (400/401/403) and other statuses: no retry.
     */
    function retryPolicyForApiError(error) {
      if (error !== null && typeof error === 'object' && typeof error.status === 'number') {
        if (!API_RETRY_STATUSES.includes(error.status)) return null;
        return { kind: 'http', attempts: API_HTTP_RETRY_ATTEMPTS, delayMs: API_HTTP_RETRY_DELAY_MS };
      }
      return { kind: 'network', attempts: API_NETWORK_RETRY_ATTEMPTS, delayMs: API_NETWORK_RETRY_DELAY_MS };
    }

    function retryDelay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    /**
     * hotfix.4: the retry budget depends on the failure class; a final 404 keeps
     * its status and is tagged so the UI can show `error.routeNotReady`.
     */
    async function apiRequestWithRetry(url, init, onRetry) {
      let lastError = null;
      let attempts = 0;
      let httpFailures = 0;
      let networkFailures = 0;
      for (;;) {
        try {
          return await apiRequest(url, init, API_ATTEMPT_TIMEOUT_MS);
        } catch (error) {
          lastError = error;
          attempts += 1;
          const policy = retryPolicyForApiError(error);
          if (policy === null) break;
          if (policy.kind === 'http') {
            httpFailures += 1;
            if (httpFailures >= policy.attempts) break;
          } else {
            networkFailures += 1;
            if (networkFailures >= policy.attempts) break;
          }
          // Overall cap stays at the larger (HTTP) budget even for mixed failures.
          if (attempts >= API_HTTP_RETRY_ATTEMPTS) break;
          if (typeof onRetry === 'function') onRetry(error);
          await retryDelay(policy.delayMs);
        }
      }
      if (lastError !== null && typeof lastError === 'object' && lastError.status === 404) {
        lastError.routeNotReady = true;
      }
      throw lastError;
    }

    function readPendingMarker() {
      try {
        const raw = localStorage.getItem(PENDING_KEY);
        if (raw === null) return null;
        const value = JSON.parse(raw);
        return value !== null && typeof value === 'object' ? value : null;
      } catch {
        return null;
      }
    }

    function writePendingMarker(value) {
      try {
        localStorage.setItem(PENDING_KEY, JSON.stringify(value));
      } catch {
        /* private mode */
      }
    }

    function clearPendingMarker() {
      try {
        localStorage.removeItem(PENDING_KEY);
      } catch {
        /* ignore */
      }
    }

    function lastSeenRestart() {
      try {
        return localStorage.getItem(LAST_SEEN_KEY);
      } catch {
        return null;
      }
    }

    function markLastSeen(id) {
      try {
        localStorage.setItem(LAST_SEEN_KEY, typeof id === 'string' ? id : '');
      } catch {
        /* ignore */
      }
    }

    let pollTimer = null;
    let pollGeneration = 0;
    let pollInFlight = false;
    // Wall-clock time of the latest accepted status read: the roll-call
    // countdown subtracts local drift from `pending.waitingRemainingMs`.
    let infoFetchedAt = 0;
    let shutdownFailureCount = 0;
    let bootWatchTimer = null;
    let bootWatchInFlight = false;
    let currentBootId = null;
    let shutdownDoneTimer = null;

    function formatText(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) => (Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match));
    }

    function showToast(toast) {
      setSnapshot({ toast });
    }

    function dismissToast() {
      setSnapshot({ toast: null });
    }

    function stopPolling() {
      // Invalidate every in-flight poll of the previous run and clear its timer.
      pollGeneration += 1;
      pollInFlight = false;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (shutdownDoneTimer !== null) {
        clearTimeout(shutdownDoneTimer);
        shutdownDoneTimer = null;
      }
    }

    function isBusyStage(stage) {
      return stage === 'waiting' || stage === 'submitting' || stage === 'shutting-down';
    }

    function isDesktopShell() {
      try {
        if (typeof globalThis.dshDesktop === 'object' && globalThis.dshDesktop !== null) return true;
        return typeof location === 'object' && location.protocol === 'dsh-app:';
      } catch {
        return false;
      }
    }

    /** Pick one of two explicit locale keys for the current platform. */
    function platformText(t, webKey, desktopKey) {
      return isDesktopShell() ? t(desktopKey) : t(webKey);
    }

    function failRestart(reason) {
      stopPolling();
      clearPendingMarker();
      setSnapshot({ stage: 'failed', error: reason, serverDown: false });
    }

    function failureFromError(error, action = 'restart') {
      if (error !== null && typeof error === 'object' && error.routeNotReady === true) {
        return { kind: 'route-not-ready', action };
      }
      return { kind: 'submit', message: errorText(error), action };
    }

    function failureText(t, error, action = 'restart') {
      if (error === null || error === undefined) return '';
      if (typeof error === 'object' && error.kind === 'route-not-ready') return t('error.routeNotReady');
      if (typeof error === 'object' && error.kind === 'timeout') {
        return formatText(platformText(t, 'failed.timeout', 'failed.timeout.desktop'), { seconds: error.seconds ?? 0 });
      }
      if (typeof error === 'object' && error.kind === 'submit') {
        return formatText(t(action === 'shutdown' ? 'failed.request.shutdown' : 'failed.request'), { message: error.message ?? '' });
      }
      if (typeof error === 'object' && error.kind === 'shutdown-timeout') return t('shutdown.timeout');
      return typeof error === 'string' ? error : String(error.message ?? error);
    }

    function startPolling() {
      stopPolling();
      const generation = pollGeneration;
      pollTimer = setInterval(() => {
        void pollOnce(generation);
      }, POLL_INTERVAL_MS);
      void pollOnce(generation);
    }

    async function pollOnce(generation = pollGeneration) {
      if (generation !== pollGeneration || pollInFlight) return;
      if (snapshot.stage !== 'waiting') return;
      pollInFlight = true;
      try {
        const status = await apiRequestWithRetry(API_STATUS, { method: 'GET' }, () => {
          // The old Host stopped answering; keep the pre-hotfix down→up bootstrap
          // working for generations that never exposed bootId.
          if (generation === pollGeneration) setSnapshot({ serverDown: true });
        });
        if (generation !== pollGeneration) return;
        const previousBootId = snapshot.bootId;
        const restarted =
          (typeof previousBootId === 'string' && typeof status.bootId === 'string' && status.bootId !== previousBootId) ||
          // Host generation that never exposed bootId: a successful response
          // after a connection failure means the new process is answering.
          (typeof previousBootId !== 'string' && snapshot.serverDown === true);
        if (restarted) {
          stopPolling();
          if (typeof status.bootId === 'string') currentBootId = status.bootId;
          try {
            window.location.reload();
          } catch {
            setSnapshot({ stage: 'idle' });
          }
          return;
        }
        infoFetchedAt = Date.now();
        setSnapshot({ info: status, serverDown: false });
      } catch {
        if (generation !== pollGeneration) return;
        setSnapshot({ serverDown: true });
        const elapsed = Date.now() - (snapshot.startedAt || Date.now());
        if (elapsed > DOWN_TIMEOUT_MS) {
          failRestart({ kind: 'timeout', seconds: Math.round(elapsed / 1000) });
        }
      } finally {
        if (generation === pollGeneration) pollInFlight = false;
      }
    }

    function startShutdownPolling() {
      stopPolling();
      shutdownFailureCount = 0;
      const generation = pollGeneration;
      pollTimer = setInterval(() => {
        void pollShutdownOnce(generation);
      }, POLL_INTERVAL_MS);
      void pollShutdownOnce(generation);
    }

    async function pollShutdownOnce(generation = pollGeneration) {
      if (generation !== pollGeneration || pollInFlight) return;
      if (snapshot.stage !== 'shutting-down') return;
      pollInFlight = true;
      try {
        const status = await apiRequestWithRetry(API_STATUS, { method: 'GET' });
        if (generation !== pollGeneration) return;
        shutdownFailureCount = 0;
        infoFetchedAt = Date.now();
        setSnapshot({ info: status });
        const elapsed = Date.now() - (snapshot.startedAt || Date.now());
        // Safe/coordinated shutdown may legitimately wait a long time for AIs to
        // stop; only a force shutdown is expected to disconnect quickly.
        if (snapshot.mode === 'dangerous' && elapsed > SHUTDOWN_TIMEOUT_MS) {
          stopPolling();
          setSnapshot({ stage: 'failed', error: { kind: 'shutdown-timeout' } });
        }
      } catch {
        if (generation !== pollGeneration) return;
        shutdownFailureCount += 1;
        // A single network hiccup is not evidence that shutdown completed:
        // require three consecutive failures before showing the disconnected UI.
        if (shutdownFailureCount < 3) return;
        stopPolling();
        const doneGeneration = pollGeneration;
        shutdownDoneTimer = setTimeout(() => {
          shutdownDoneTimer = null;
          if (doneGeneration !== pollGeneration) return;
          if (snapshot.stage === 'shutting-down') setSnapshot({ stage: 'shutdown-done' });
        }, 900);
      } finally {
        if (generation === pollGeneration) pollInFlight = false;
      }
    }

    async function refreshInfo() {
      try {
        const status = await apiRequestWithRetry(API_STATUS, { method: 'GET' });
        // A late dialog refresh must not clobber the waiting/shutdown status.
        if (snapshot.stage !== 'dialog') return;
        infoFetchedAt = Date.now();
        setSnapshot({ info: status, infoError: null });
      } catch (error) {
        if (snapshot.stage !== 'dialog') return;
        setSnapshot({ infoError: errorText(error) });
      }
    }

    function closePowerMenu() {
      if (snapshot.menu !== null) setSnapshot({ menu: null });
    }

    function togglePowerMenu(rect) {
      if (isBusyStage(snapshot.stage)) {
        closePowerMenu();
        return;
      }
      if (snapshot.menu !== null) {
        setSnapshot({ menu: null });
        return;
      }
      if (rect === null || rect === undefined) return;
      const width = 196;
      const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
      const bottom = Math.max(8, window.innerHeight - rect.top + 8);
      setSnapshot({ menu: { left, bottom } });
    }

    function humanModeLabel(mode) {
      return mode === 'coordinated' ? '中断' : mode === 'dangerous' ? '强制' : '等待';
    }

    function humanReason(fallback) {
      const typed = typeof snapshot.reason === 'string' ? snapshot.reason.trim().slice(0, 200) : '';
      return typed.length > 0 ? typed : fallback;
    }

    function openActionDialog(action) {
      if (isBusyStage(snapshot.stage)) {
        closePowerMenu();
        return;
      }
      closePowerMenu();
      setSnapshot({
        stage: 'dialog',
        action: action === 'shutdown' ? 'shutdown' : 'restart',
        mode: 'safe',
        step: 1,
        reason: '',
        error: null,
        infoError: null,
        info: null,
        // The escape pod linkage belongs to shutdown only and is never
        // pre-checked: a human has to opt in for every single shutdown.
        podAvailable: false,
        closeEscapePod: false,
        closedEscapePod: false,
      });
      void refreshInfo();
      if (action === 'shutdown') void refreshPodAvailability();
    }

    /**
     * Ask the Host whether the optional escape pod plugin is installed. The
     * checkbox only exists when it is; a failed read counts as "not available"
     * because an optional convenience must never block a shutdown.
     */
    async function refreshPodAvailability() {
      try {
        const data = await apiRequestWithRetry(API_POD, { method: 'GET' });
        if (snapshot.stage !== 'dialog') return;
        setSnapshot({ podAvailable: data !== null && typeof data === 'object' && data.available === true });
      } catch {
        if (snapshot.stage !== 'dialog') return;
        setSnapshot({ podAvailable: false });
      }
    }

    function cancelDialog() {
      stopPolling();
      setSnapshot({ stage: 'idle', error: null, step: 1, reason: '' });
    }

    async function submitRestart() {
      const mode = snapshot.mode;
      setSnapshot({ stage: 'submitting', error: null });
      try {
        let before = snapshot.info;
        if (before === null) before = await apiRequestWithRetry(API_STATUS, { method: 'GET' });
        const body = { source: 'ui', mode, reason: humanReason(`侧边栏 DSH电源：${humanModeLabel(mode)}重启`) };
        if (mode === 'dangerous') body.confirmed = true;
        const response = await apiRequestWithRetry(API_REQUEST, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (response !== null && typeof response === 'object' && response.accepted === false) {
          throw new Error(typeof response.message === 'string' ? response.message : '重启请求未被接受');
        }
        writePendingMarker({ bootId: before?.bootId, requestedAt: Date.now() });
        if (typeof before?.bootId === 'string') currentBootId = before.bootId;
        setSnapshot({
          stage: 'waiting',
          bootId: before?.bootId ?? null,
          startedAt: Date.now(),
          serverDown: false,
          info: response.status ?? null,
        });
        startPolling();
      } catch (error) {
        failRestart(failureFromError(error));
      }
    }

    async function submitShutdown() {
      const mode = snapshot.mode;
      // Read once: the dialog is replaced by the progress screen right below,
      // so the checked value must be captured before the stage changes.
      const closeEscapePod = snapshot.closeEscapePod === true;
      setSnapshot({ stage: 'submitting', error: null });
      try {
        const body = { mode, reason: humanReason(`侧边栏 DSH电源：${humanModeLabel(mode)}关闭`) };
        if (mode === 'dangerous') body.confirmed = true;
        // Only an explicit `true` makes the Host close the escape pod; the Host
        // skips it when the service is missing and never lets it block exiting.
        body.closeEscapePod = closeEscapePod;
        await apiRequestWithRetry(API_SHUTDOWN, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        setSnapshot({
          stage: 'shutting-down',
          startedAt: Date.now(),
          serverDown: false,
          closedEscapePod: closeEscapePod,
        });
        startShutdownPolling();
      } catch (error) {
        setSnapshot({ stage: 'failed', error: failureFromError(error, 'shutdown') });
      }
    }

    async function confirmAction() {
      if (snapshot.stage !== 'dialog') return;
      if (snapshot.action === 'shutdown') await submitShutdown();
      else await submitRestart();
    }

    /* ------------------------------------------------- restart outcomes ----- */

    const OUTCOME_RECHECK_MS = 2000;
    const OUTCOME_RECHECK_TTL_MS = 120000;
    let outcomeRecheckTimer = null;
    let outcomeRecheckStartedAt = 0;

    function stopOutcomeRecheck() {
      if (outcomeRecheckTimer !== null) {
        clearInterval(outcomeRecheckTimer);
        outcomeRecheckTimer = null;
      }
    }

    function armOutcomeRecheck() {
      if (outcomeRecheckTimer !== null) return;
      outcomeRecheckStartedAt = Date.now();
      outcomeRecheckTimer = setInterval(() => {
        if (Date.now() - outcomeRecheckStartedAt > OUTCOME_RECHECK_TTL_MS) {
          stopOutcomeRecheck();
          if (readPendingMarker() !== null) clearPendingMarker();
          return;
        }
        void checkRestartOutcome();
      }, OUTCOME_RECHECK_MS);
    }

    /** Effective restart mode recorded by the current Host generation. */
    function restartModeOf(lastRestart) {
      if (lastRestart === null || typeof lastRestart !== 'object') return 'safe';
      if (lastRestart.mode === 'dangerous' || lastRestart.dangerous === true) return 'force';
      if (lastRestart.mode === 'coordinated') return 'coordinated';
      return 'safe';
    }

    function arrayCount(value) {
      return Array.isArray(value) ? value.length : 0;
    }

    function restartOutcomeToast(lastRestart) {
      const mode = restartModeOf(lastRestart);
      if (mode === 'force') {
        const interrupted =
          typeof lastRestart.interruptedCount === 'number' ? lastRestart.interruptedCount : arrayCount(lastRestart.interrupted);
        const safeState = lastRestart.safeState !== null && typeof lastRestart.safeState === 'object' ? lastRestart.safeState : null;
        const delivered =
          typeof safeState?.interruptedDelivered === 'number'
            ? safeState.interruptedDelivered
            : Array.isArray(lastRestart.interruptedResults)
              ? lastRestart.interruptedResults.filter((result) => result !== null && typeof result === 'object' && result.status === 'delivered').length
              : 0;
        const failed =
          typeof safeState?.interruptedFailed === 'number'
            ? safeState.interruptedFailed
            : Array.isArray(lastRestart.interruptedResults)
              ? lastRestart.interruptedResults.filter((result) => result !== null && typeof result === 'object' && result.status !== 'delivered').length
              : 0;
        if (interrupted > 0) return { kind: 'force', interrupted, delivered, failed, ttlMs: 60000 };
        return { kind: 'forceNoInterrupt', ttlMs: 30000 };
      }
      if (mode === 'coordinated') {
        const safeState = lastRestart.safeState !== null && typeof lastRestart.safeState === 'object' ? lastRestart.safeState : null;
        const timedOut =
          typeof safeState?.timedOutCount === 'number'
            ? safeState.timedOutCount
            : Array.isArray(lastRestart.timedOutSessions)
              ? lastRestart.timedOutSessions.length
              : 0;
        return { kind: 'coordinated', timedOut, ttlMs: timedOut > 0 ? 30000 : 15000 };
      }
      const aiCount = Array.isArray(lastRestart.requesters)
        ? lastRestart.requesters.filter((requester) => typeof requester?.sessionId === 'string').length
        : 0;
      return { kind: aiCount > 0 ? 'safeAi' : 'safe', count: aiCount };
    }

    function showRestartOutcome(lastRestart) {
      if (lastRestart === null || typeof lastRestart !== 'object') return;
      markLastSeen(lastRestart.requestId);
      showToast(restartOutcomeToast(lastRestart));
    }

    async function checkRestartOutcome() {
      let status;
      try {
        status = await apiRequestWithRetry(API_STATUS, { method: 'GET' });
      } catch {
        return;
      }
      const lastRestart = status.lastRestart;
      const marker = readPendingMarker();
      if (typeof status.bootId === 'string') currentBootId = status.bootId;
      if (marker !== null) {
        const outcomeReady =
          lastRestart !== null && typeof lastRestart === 'object' && typeof lastRestart.completedAt === 'number';
        if (!outcomeReady) {
          armOutcomeRecheck();
          return;
        }
        clearPendingMarker();
        stopOutcomeRecheck();
        const ours =
          typeof lastRestart.requestedAt !== 'number' ||
          typeof marker.requestedAt !== 'number' ||
          lastRestart.requestedAt >= marker.requestedAt - 120000;
        if (ours) showRestartOutcome(lastRestart);
        return;
      }
      if (
        lastRestart !== null &&
        typeof lastRestart === 'object' &&
        typeof lastRestart.requestId === 'string' &&
        typeof lastRestart.completedAt === 'number' &&
        Date.now() - lastRestart.completedAt < 5 * 60 * 1000 &&
        lastSeenRestart() !== lastRestart.requestId
      ) {
        showRestartOutcome(lastRestart);
      } else if (lastRestart !== null && typeof lastRestart?.requestId === 'string') {
        markLastSeen(lastRestart.requestId);
      }
    }

    function startBootWatch() {
      if (bootWatchTimer !== null) return;
      bootWatchTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        if (snapshot.stage !== 'idle') return;
        // A retry chain can outlive the 12s watch interval; keep one heartbeat.
        if (bootWatchInFlight) return;
        bootWatchInFlight = true;
        void (async () => {
          try {
            const status = await apiRequestWithRetry(API_STATUS, { method: 'GET' });
            if (currentBootId !== null && typeof status.bootId === 'string' && status.bootId !== currentBootId) {
              currentBootId = status.bootId;
              const lastRestart = status.lastRestart;
              if (lastRestart !== null && typeof lastRestart === 'object' && typeof lastRestart.completedAt === 'number' && Date.now() - lastRestart.completedAt < 5 * 60 * 1000) {
                showRestartOutcome(lastRestart);
              }
            } else if (currentBootId === null && typeof status.bootId === 'string') {
              currentBootId = status.bootId;
            }
          } catch {
            /* transient */
          } finally {
            bootWatchInFlight = false;
          }
        })();
      }, BOOT_WATCH_INTERVAL_MS);
    }

    /* ---------------------------------------------------- DOM power button -- */

    let domPowerButton = null;
    let domPowerObserver = null;
    let domPowerRetryTimer = null;
    let domPowerThrottleTimer = null;
    let domPowerUnsubscribe = null;

    function powerIcon() {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('width', '16');
      svg.setAttribute('height', '16');
      svg.setAttribute('viewBox', '0 0 16 16');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('aria-hidden', 'true');
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      line.setAttribute('d', 'M8 1.75v6');
      line.setAttribute('stroke', 'currentColor');
      line.setAttribute('stroke-width', '1.6');
      line.setAttribute('stroke-linecap', 'round');
      const arc = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      arc.setAttribute('d', 'M4.35 3.3a5.4 5.4 0 1 0 7.3 0');
      arc.setAttribute('stroke', 'currentColor');
      arc.setAttribute('stroke-width', '1.6');
      arc.setAttribute('stroke-linecap', 'round');
      arc.setAttribute('fill', 'none');
      svg.appendChild(line);
      svg.appendChild(arc);
      return svg;
    }

    function settingsAreaContainer() {
      if (typeof document === 'undefined') return null;
      return document.querySelector('div[class*="_settingsArea"]');
    }

    function sidebarCollapsed() {
      if (typeof document === 'undefined') return false;
      return document.querySelector('[class*="_root"][class*="_collapsed"]') !== null;
    }

    /**
     * The official account/settings row fills the settingsArea (avatar + name +
     * connection indicator). Never squeeze it: in the wide sidebar keep the row
     * untouched and overlay our icon at its trailing edge inside a 32px right
     * gutter, so the avatar keeps its normal left position. In the collapsed rail
     * stack the icon under the row.
     */
    function layoutSettingsArea(container, button, collapsed) {
      try {
        container.style.display = 'flex';
        container.style.alignItems = 'center';
        container.style.gap = '4px';
        if (collapsed) {
          container.style.position = '';
          container.style.boxSizing = '';
          container.style.paddingRight = '';
          container.style.flexDirection = 'column';
          container.style.justifyContent = 'center';
          button.style.position = '';
          button.style.right = '';
          button.style.top = '';
          button.style.transform = '';
          button.style.marginLeft = '0';
          button.style.marginRight = '0';
          button.style.zIndex = '';
        } else {
          container.style.position = 'relative';
          container.style.boxSizing = 'border-box';
          container.style.paddingRight = '32px';
          container.style.flexDirection = 'row';
          container.style.justifyContent = 'flex-end';
          button.style.position = 'absolute';
          button.style.right = '0';
          button.style.top = '50%';
          button.style.transform = 'translateY(-50%)';
          button.style.marginLeft = '0';
          button.style.marginRight = '0';
          button.style.zIndex = '1';
        }
        // Clear inline styles written by earlier 1.7.3 builds that squeezed the row.
        const first = container.firstElementChild;
        if (first !== null && first !== button) {
          first.style.flex = '';
          first.style.width = '';
          first.style.minWidth = '';
        }
      } catch {
        /* inert container */
      }
    }

    function syncDomPowerButton() {
      if (domPowerButton === null) return;
      try {
        domPowerButton.style.display = snapshot.powerHidden ? 'none' : '';
        domPowerButton.classList.toggle('dshrd-power-active', snapshot.menu !== null);
        domPowerButton.setAttribute('aria-expanded', snapshot.menu !== null ? 'true' : 'false');
        const container = domPowerButton.parentElement;
        if (container !== null) layoutSettingsArea(container, domPowerButton, sidebarCollapsed());
      } catch {
        /* detached */
      }
    }

    function ensureDomPowerButton() {
      if (typeof document === 'undefined') return;
      const container = settingsAreaContainer();
      if (container === null) {
        setSnapshot({ domButtonReady: false });
        if (domPowerRetryTimer === null) {
          domPowerRetryTimer = setTimeout(() => {
            domPowerRetryTimer = null;
            ensureDomPowerButton();
          }, DOM_RETRY_MS);
        }
        return;
      }
      const existing = document.getElementById(DOM_POWER_ID);
      if (existing !== null && existing.parentElement === container) {
        domPowerButton = existing;
        syncDomPowerButton();
        if (snapshot.domButtonReady !== true) setSnapshot({ domButtonReady: true });
        return;
      }
      if (existing !== null) {
        try {
          existing.remove();
        } catch {
          /* ignore */
        }
      }
      const button = document.createElement('button');
      button.id = DOM_POWER_ID;
      button.type = 'button';
      button.className = 'dshrd-power dshrd-settings-power';
      button.title = 'DSH电源';
      button.setAttribute('aria-label', 'DSH电源');
      button.setAttribute('aria-haspopup', 'menu');
      button.setAttribute('aria-expanded', 'false');
      button.appendChild(powerIcon());
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (isBusyStage(snapshot.stage)) return;
        togglePowerMenu(button.getBoundingClientRect());
      });
      container.appendChild(button);
      layoutSettingsArea(container, button, sidebarCollapsed());
      domPowerButton = button;
      syncDomPowerButton();
      setSnapshot({ domButtonReady: true });
    }

    function scheduleDomPowerEnsure() {
      if (typeof document === 'undefined') return;
      if (domPowerThrottleTimer !== null) return;
      domPowerThrottleTimer = setTimeout(() => {
        domPowerThrottleTimer = null;
        ensureDomPowerButton();
      }, 150);
    }

    function startDomPowerWatch() {
      if (typeof document === 'undefined') return;
      ensureDomPowerButton();
      if (domPowerObserver === null) {
        domPowerObserver = new MutationObserver(() => scheduleDomPowerEnsure());
        domPowerObserver.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class'],
        });
      }
      // Store changes (menu/reconnect state) keep the DOM button chrome in sync.
      if (domPowerUnsubscribe === null) domPowerUnsubscribe = subscribeStore(syncDomPowerButton);
    }

    function stopDomPowerWatch() {
      if (domPowerObserver !== null) {
        try {
          domPowerObserver.disconnect();
        } catch {
          /* ignore */
        }
        domPowerObserver = null;
      }
      for (const timer of [domPowerRetryTimer, domPowerThrottleTimer]) {
        if (timer !== null) {
          try {
            clearTimeout(timer);
          } catch {
            /* ignore */
          }
        }
      }
      domPowerRetryTimer = null;
      domPowerThrottleTimer = null;
      if (domPowerUnsubscribe !== null) {
        try {
          domPowerUnsubscribe();
        } catch {
          /* ignore */
        }
        domPowerUnsubscribe = null;
      }
      try {
        const container = domPowerButton?.parentElement ?? null;
        if (container !== null) {
          container.style.display = '';
          container.style.alignItems = '';
          container.style.gap = '';
          container.style.position = '';
          container.style.boxSizing = '';
          container.style.paddingRight = '';
          container.style.flexDirection = '';
          container.style.justifyContent = '';
          const first = container.firstElementChild;
          if (first !== null) {
            first.style.flex = '';
            first.style.width = '';
            first.style.minWidth = '';
          }
        }
        if (domPowerButton !== null) {
          domPowerButton.style.position = '';
          domPowerButton.style.right = '';
          domPowerButton.style.top = '';
          domPowerButton.style.transform = '';
          domPowerButton.style.zIndex = '';
        }
        domPowerButton?.remove();
      } catch {
        /* ignore */
      }
      domPowerButton = null;
    }

    /* --------------------------------------------------------- components --- */

    const POWER_ICON = (props) =>
      h(
        'svg',
        { width: props?.size ?? 16, height: props?.size ?? 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M8 1.75v6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('path', {
          d: 'M4.35 3.3a5.4 5.4 0 1 0 7.3 0',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          fill: 'none',
        }),
      );

    /**
     * Fallback seat rendered while the settingsArea DOM button is not ready.
     * It disappears as soon as `domButtonReady` flips; no one-shot startup gate.
     */
    function PowerFallback(props) {
      const { t } = props;
      const store = useStore();
      if (store.domButtonReady) return null;
      if (store.powerHidden) return null;
      return h(
        'button',
        {
          type: 'button',
          className: `dshrd-power${store.menu !== null ? ' dshrd-power-active' : ''}`,
          'aria-label': t('power.title'),
          'aria-haspopup': 'menu',
          'aria-expanded': store.menu !== null ? 'true' : 'false',
          title: t('power.title'),
          onClick: (event) => {
            event.stopPropagation();
            if (isBusyStage(store.stage)) return;
            togglePowerMenu(event.currentTarget.getBoundingClientRect());
          },
        },
        h(POWER_ICON),
      );
    }

    function PowerMenu(props) {
      const { t, store } = props;
      if (store.menu === null) return null;
      const item = (action, label, danger) =>
        h(
          'button',
          {
            key: action,
            type: 'button',
            role: 'menuitem',
            className: `dshrd-menu-item${danger ? ' dshrd-menu-item-danger' : ''}`,
            onClick: () => openActionDialog(action),
          },
          label,
        );
      return h(
        React.Fragment,
        null,
        h('div', { className: 'dshrd-menu-backdrop', onClick: closePowerMenu }),
        h(
          'div',
          {
            className: 'dshrd-menu',
            role: 'menu',
            style: { left: `${String(store.menu.left)}px`, bottom: `${String(store.menu.bottom)}px` },
          },
          item('restart', t('menu.restart')),
          item('shutdown', t('menu.shutdown'), true),
        ),
      );
    }

    /** Long-press confirm: 5 seconds with an accelerating flash; release cancels. */
    function LongPressButton(props) {
      const { t, label, onConfirm } = props;
      const idleLabel = typeof label === 'string' && label.length > 0 ? label : t('dialog.hold.restart');
      const [holding, setHolding] = React.useState(false);
      const [elapsed, setElapsed] = React.useState(0);
      const startAt = React.useRef(0);
      const timer = React.useRef(null);
      const holdRef = React.useRef(false);

      const stop = React.useCallback(() => {
        holdRef.current = false;
        if (timer.current !== null) {
          clearInterval(timer.current);
          timer.current = null;
        }
        setHolding(false);
        setElapsed(0);
      }, []);

      const start = React.useCallback(() => {
        if (holdRef.current) return;
        holdRef.current = true;
        startAt.current = Date.now();
        setHolding(true);
        setElapsed(0);
        timer.current = setInterval(() => {
          const value = Date.now() - startAt.current;
          if (value >= HOLD_MS) {
            stop();
            onConfirm();
            return;
          }
          setElapsed(value);
        }, HOLD_TICK_MS);
      }, [onConfirm, stop]);

      React.useEffect(() => () => stop(), [stop]);

      // While the pointer is held down, any focus loss, hidden tab, pointer
      // cancellation or a release outside the button must cancel the hold.
      React.useEffect(() => {
        if (!holding) return undefined;
        if (typeof window === 'undefined' || typeof document === 'undefined') return undefined;
        const onWindowBlur = () => stop();
        const onVisibilityChange = () => {
          if (document.visibilityState === 'hidden') stop();
        };
        const onPointerEnd = () => stop();
        window.addEventListener('blur', onWindowBlur);
        window.addEventListener('pointerup', onPointerEnd, true);
        window.addEventListener('pointercancel', onPointerEnd, true);
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
          window.removeEventListener('blur', onWindowBlur);
          window.removeEventListener('pointerup', onPointerEnd, true);
          window.removeEventListener('pointercancel', onPointerEnd, true);
          document.removeEventListener('visibilitychange', onVisibilityChange);
        };
      }, [holding, stop]);

      const remaining = Math.max(0, (HOLD_MS - elapsed) / 1000).toFixed(1);
      const elapsedSeconds = (elapsed / 1000).toFixed(1);
      const progress = Math.min(100, Math.round((elapsed / HOLD_MS) * 100));
      const flashMs = Math.max(120, Math.round(700 - (elapsed / HOLD_MS) * 560));
      const ariaValueText = holding
        ? formatText(t('dialog.holding.progress'), { elapsed: elapsedSeconds, remaining })
        : idleLabel;
      return h(
        'button',
        {
          type: 'button',
          className: `dshrd-button dshrd-hold${holding ? ' dshrd-hold-active' : ''}`,
          style: { '--dshrd-hold-progress': `${String(progress)}%`, animationDuration: `${String(flashMs)}ms` },
          'aria-label': idleLabel,
          'aria-valuemin': 0,
          'aria-valuemax': HOLD_MS,
          'aria-valuenow': Math.min(HOLD_MS, Math.round(elapsed)),
          'aria-valuetext': ariaValueText,
          onPointerDown: (event) => {
            // Only the primary button starts a hold; touch pointers report 0.
            if (event.button !== 0) return;
            event.preventDefault();
            try {
              event.currentTarget.setPointerCapture?.(event.pointerId);
            } catch {
              /* ignore */
            }
            start();
          },
          onPointerUp: stop,
          onPointerCancel: stop,
          onPointerLeave: stop,
          onLostPointerCapture: stop,
          onPointerMove: (event) => {
            // Pointer capture keeps events on the button even outside it; cancel
            // as soon as the pointer leaves the button's box (R2 fallback).
            if (!holdRef.current) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const { clientX: x, clientY: y } = event;
            if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) stop();
          },
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            if (event.repeat) return;
            start();
          },
          onKeyUp: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            stop();
          },
          onBlur: stop,
        },
        holding ? formatText(t('dialog.holding'), { seconds: remaining }) : idleLabel,
      );
    }

    function DialogCard(props) {
      const { t, store } = props;
      const action = store.action === 'shutdown' ? 'shutdown' : 'restart';
      const mode = store.mode === 'coordinated' || store.mode === 'dangerous' ? store.mode : 'safe';
      const step = store.step === 2 ? 2 : 1;
      const running = typeof store.info?.runningAgents === 'number' ? store.info.runningAgents : 0;
      const title =
        step === 2 ? t('dialog.step2.title') : t(action === 'shutdown' ? 'dialog.shutdown.title' : 'dialog.restart.title');
      const body = step === 2 ? t(`dialog.step2.${action}`) : t(`dialog.${action}.${mode}`);
      const hintKey = action === 'shutdown' ? 'dialog.hint.shutdown' : 'dialog.hint.restart';
      const holdLabel = t(action === 'shutdown' ? 'dialog.hold.shutdown' : 'dialog.hold.restart');
      const primaryLabel =
        step === 2
          ? t('dialog.step2.confirm')
          : mode === 'coordinated'
            ? t('dialog.next')
            : t(action === 'shutdown' ? 'dialog.confirm.shutdown' : 'dialog.confirm.restart');
      const primary = () => {
        if (step === 1 && mode === 'coordinated') {
          setSnapshot({ step: 2 });
          return;
        }
        void confirmAction();
      };
      const reasonField =
        step === 1
          ? h(
              'label',
              { className: 'dshrd-field' },
              h('span', { className: 'dshrd-field-label' }, t('dialog.reason.label')),
              h('input', {
                className: 'dshrd-input',
                type: 'text',
                maxLength: 200,
                value: typeof store.reason === 'string' ? store.reason : '',
                placeholder: t('dialog.reason.placeholder'),
                onChange: (event) => setSnapshot({ reason: event.target.value.slice(0, 200) }),
              }),
            )
          : null;
      const modeSelect =
        step === 1
          ? h(
              'label',
              { className: 'dshrd-field' },
              h('span', { className: 'dshrd-field-label' }, t('dialog.mode')),
              h(
                'select',
                {
                  className: 'dshrd-select',
                  value: mode,
                  onChange: (event) => setSnapshot({ mode: event.target.value, step: 1 }),
                },
                h('option', { value: 'safe' }, t('mode.safe')),
                h('option', { value: 'coordinated' }, t('mode.coordinated')),
                h('option', { value: 'dangerous' }, t('mode.dangerous')),
              ),
            )
          : null;
      // Escape pod linkage: shutdown only, only when the Host reports the
      // optional `escapePod` service, and never pre-checked. Kept on both steps
      // so a coordinated second confirmation keeps the choice, and disabled
      // while the dialog is locked (a submit replaces it with the progress
      // screen, so nothing can be toggled mid-flight).
      const dialogLocked = store.stage !== 'dialog';
      const podCheckbox =
        action === 'shutdown' && store.podAvailable === true
          ? h(
              'label',
              { className: dialogLocked ? 'dshrd-cfg-check dshrd-cfg-check-danger dshrd-cfg-check-locked' : 'dshrd-cfg-check dshrd-cfg-check-danger' },
              h('input', {
                type: 'checkbox',
                checked: store.closeEscapePod === true,
                disabled: dialogLocked,
                onChange: (event) => setSnapshot({ closeEscapePod: event.target.checked }),
              }),
              h('span', null, t('dialog.shutdown.closePod')),
            )
          : null;
      return h(
        'div',
        {
          className: 'dshrd-backdrop',
          onClick: (event) => {
            if (event.target === event.currentTarget) cancelDialog();
          },
        },
        h(
          'div',
          { className: 'dshrd-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
          h('div', { className: 'dshrd-card-title' }, title),
          modeSelect,
          reasonField,
          h('div', { className: 'dshrd-card-body' }, body),
          running > 0
            ? h('div', { className: 'dshrd-card-hint' }, formatText(t('dialog.running'), { count: running }))
            : null,
          step === 1 && mode === 'dangerous'
            ? h(
                'div',
                { className: 'dshrd-danger-zone' },
                running > 0 ? formatText(t('dialog.dangerous.warning'), { count: running }) : null,
                h('div', { className: 'dshrd-warning-hint' }, t('dialog.dangerous.warningHint')),
              )
            : null,
          podCheckbox,
          h('div', { className: 'dshrd-card-hint' }, t(hintKey)),
          store.infoError !== null
            ? h('div', { className: 'dshrd-card-hint' }, formatText(t('dialog.infoError'), { message: store.infoError }))
            : null,
          h(
            'div',
            { className: 'dshrd-actions' },
            h('button', { type: 'button', className: 'dshrd-button dshrd-button-plain', onClick: cancelDialog }, t('dialog.cancel')),
            step === 1 && mode === 'dangerous'
              ? h(LongPressButton, { key: 'hold', t, label: holdLabel, onConfirm: () => void confirmAction() })
              : h(
                  'button',
                  { type: 'button', className: 'dshrd-button dshrd-button-primary', onClick: primary },
                  primaryLabel,
                ),
          ),
        ),
      );
    }

    function waitingTitle(t, mode) {
      if (mode === 'coordinated') return t('waiting.title.coordinated');
      if (mode === 'dangerous') return t('waiting.title.dangerous');
      return t('waiting.title.safe');
    }

    function shutdownWaitingTitle(t, mode) {
      if (mode === 'coordinated') return t('waiting.shutdown.title.coordinated');
      if (mode === 'dangerous') return t('waiting.shutdown.title.dangerous');
      return t('waiting.shutdown.title.safe');
    }

    /**
     * Seconds left before a coordinated (roll-call) restart stops waiting.
     * Hotfix.8 Hosts report `pending.waitingRemainingMs`; the deadline is the
     * fallback for an older status shape. Both are nullable (0 = wait forever).
     */
    function rollCallRemainingSeconds(info, clock) {
      const pending = info !== null && typeof info === 'object' ? info.pending : null;
      if (pending === null || typeof pending !== 'object') return null;
      if (typeof pending.waitingRemainingMs === 'number' && Number.isFinite(pending.waitingRemainingMs)) {
        const drift = infoFetchedAt > 0 ? Math.max(0, clock - infoFetchedAt) : 0;
        return Math.max(0, Math.ceil((pending.waitingRemainingMs - drift) / 1000));
      }
      if (typeof pending.coordinatedDeadlineAt === 'number' && pending.coordinatedDeadlineAt > 0) {
        return Math.max(0, Math.ceil((pending.coordinatedDeadlineAt - clock) / 1000));
      }
      return null;
    }

    /**
     * Progress ring for the full-screen progress card.
     *
     * A CSS `border` + `border-radius:50%` ring is laid out by the flexbox box:
     * in the card (column flex, `max-height` + `overflow:auto`) Chromium shrinks
     * the spinner's height when the desktop window is short, so the box stops
     * being square and the ring renders as an ellipse. SVG geometry cannot be
     * squashed — `viewBox` plus `preserveAspectRatio` map the circle through a
     * uniform scale, so the ring stays a perfect circle even if the box is not.
     * The rotation is the CSS animation on the root `<svg>`.
     *
     * Circumference: 2 * PI * 14.25 = 89.535; a quarter is 22.384, which starts
     * at the top after `rotate(-135 15.5 15.5)` (matching the old `border-top`
     * highlight). The 31px box keeps the old border-box footprint
     * (26px content + 2 x 2.5px border), so the ring does not change size.
     */
    function progressSpinner() {
      const track = h('circle', {
        cx: 15.5,
        cy: 15.5,
        r: 14.25,
        fill: 'none',
        stroke: 'var(--dsw-alias-border-l2)',
        strokeWidth: 2.5,
      });
      const arc = h('circle', {
        cx: 15.5,
        cy: 15.5,
        r: 14.25,
        fill: 'none',
        stroke: 'var(--dsw-alias-brand-primary)',
        strokeWidth: 2.5,
        strokeDasharray: '22.384 67.151',
        transform: 'rotate(-135 15.5 15.5)',
      });
      return h(
        'svg',
        {
          className: 'dshrd-spinner',
          viewBox: '0 0 31 31',
          width: 31,
          height: 31,
          fill: 'none',
          preserveAspectRatio: 'xMidYMid meet',
          'aria-hidden': true,
        },
        track,
        arc,
      );
    }

    function ProgressScreen(props) {
      const { t, store } = props;
      // A local clock keeps the shutdown elapsed/deadline hint and the
      // roll-call countdown ticking even while the status poll is failing and
      // cannot refresh `store.info`.
      const [clock, setClock] = React.useState(() => Date.now());
      React.useEffect(() => {
        if (store.stage !== 'shutting-down' && store.stage !== 'waiting') return undefined;
        setClock(Date.now());
        const timer = setInterval(() => setClock(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [store.stage]);
      if (store.stage === 'submitting') {
        return h(
          'div',
          { className: 'dshrd-progress' },
          h(
            'div',
            { className: 'dshrd-progress-card', role: 'status' },
            progressSpinner(),
            h(
              'div',
              { className: 'dshrd-card-body' },
              store.action === 'shutdown' ? t('shutdown.submitting') : t('submitting'),
            ),
          ),
        );
      }
      if (store.stage === 'shutting-down') {
        const shutdownInfo = store.info !== null && typeof store.info === 'object' ? store.info.shutdown : null;
        const mode = typeof shutdownInfo?.mode === 'string' ? shutdownInfo.mode : store.mode;
        const waiting = typeof shutdownInfo?.waitingAgents === 'number' ? shutdownInfo.waitingAgents : 0;
        const requestedAt =
          typeof shutdownInfo?.requestedAt === 'number' && shutdownInfo.requestedAt > 0
            ? shutdownInfo.requestedAt
            : typeof store.startedAt === 'number' && store.startedAt > 0
              ? store.startedAt
              : null;
        const waitTimeoutMs = typeof shutdownInfo?.waitTimeoutMs === 'number' ? shutdownInfo.waitTimeoutMs : null;
        let deadlineAt =
          typeof shutdownInfo?.deadlineAt === 'number' && shutdownInfo.deadlineAt > 0 ? shutdownInfo.deadlineAt : null;
        if (deadlineAt === null && requestedAt !== null && waitTimeoutMs !== null && waitTimeoutMs > 0) {
          deadlineAt = requestedAt + waitTimeoutMs;
        }
        const elapsedSeconds = requestedAt === null ? null : Math.max(0, Math.floor((clock - requestedAt) / 1000));
        let deadlineLine = null;
        if (elapsedSeconds !== null) {
          if (waitTimeoutMs !== null && waitTimeoutMs > 0 && deadlineAt !== null) {
            const remainingSeconds = Math.max(0, Math.ceil((deadlineAt - clock) / 1000));
            deadlineLine = formatText(t('waiting.shutdown.deadline'), {
              elapsed: elapsedSeconds,
              seconds: remainingSeconds,
            });
          } else {
            // Unknown or explicitly unlimited (waitTimeoutMs === 0): show elapsed only.
            deadlineLine = formatText(t('waiting.shutdown.elapsed'), { elapsed: elapsedSeconds });
          }
        }
        const message =
          waiting > 0 ? formatText(t('waiting.running.shutdown'), { count: waiting }) : t('waiting.idle.shutdown');
        return h(
          'div',
          { className: 'dshrd-progress' },
          h(
            'div',
            { className: 'dshrd-progress-card', role: 'status', 'aria-live': 'polite' },
            progressSpinner(),
            h('div', { className: 'dshrd-card-title' }, shutdownWaitingTitle(t, mode)),
            h('div', { className: 'dshrd-card-body' }, message),
            deadlineLine !== null ? h('div', { className: 'dshrd-card-hint', 'aria-live': 'off' }, deadlineLine) : null,
            h('div', { className: 'dshrd-card-hint' }, t('waiting.hint.shutdown')),
          ),
        );
      }
      const pendingInfo = store.info !== null && typeof store.info === 'object' ? store.info.pending : null;
      const mode = typeof pendingInfo?.mode === 'string' ? pendingInfo.mode : store.mode;
      let message;
      if (store.serverDown) message = t('waiting.down');
      else {
        const running =
          pendingInfo !== null && typeof pendingInfo.runningAgents === 'number'
            ? pendingInfo.runningAgents
            : typeof store.info?.runningAgents === 'number'
              ? store.info.runningAgents
              : 0;
        message = running > 0 ? formatText(t('waiting.running.restart'), { count: running }) : t('waiting.idle.restart');
      }
      // Roll-call countdown: only a coordinated restart has a dead-man deadline,
      // and a stale (server-down) status must not freeze it at an old value.
      const rollCallSeconds =
        store.serverDown || mode !== 'coordinated' ? null : rollCallRemainingSeconds(store.info, clock);
      return h(
        'div',
        { className: 'dshrd-progress' },
        h(
          'div',
          { className: 'dshrd-progress-card', role: 'status', 'aria-live': 'polite' },
          progressSpinner(),
          h('div', { className: 'dshrd-card-title' }, waitingTitle(t, mode)),
          h(
            'div',
            { className: 'dshrd-card-body' },
            message,
            // Visually appended to the running line; excluded from the polite
            // live region so a per-second countdown is not announced as chatter.
            rollCallSeconds === null
              ? null
              : h(
                  'span',
                  { 'aria-live': 'off' },
                  ` ${formatText(t('waiting.rollCallRemaining'), { seconds: rollCallSeconds })}`,
                ),
          ),
          h('div', { className: 'dshrd-card-hint' }, t('waiting.hint.restart')),
        ),
      );
    }

    function ShutdownDoneScreen(props) {
      const { t, store } = props;
      return h(
        'div',
        { className: 'dshrd-progress' },
        h(
          'div',
          { className: 'dshrd-progress-card', role: 'status' },
          h('div', { className: 'dshrd-card-title' }, t('shutdown.doneTitle')),
          h('div', { className: 'dshrd-card-body' }, platformText(t, 'shutdown.doneBody', 'shutdown.doneBody.desktop')),
          // Second line only when this shutdown opted into closing the pod.
          store !== undefined && store.closedEscapePod === true
            ? h('div', { className: 'dshrd-card-hint' }, t('shutdown.donePod'))
            : null,
          h(
            'div',
            { className: 'dshrd-actions' },
            h('button', { type: 'button', className: 'dshrd-button dshrd-button-plain', onClick: () => setSnapshot({ stage: 'idle' }) }, t('failed.close')),
          ),
        ),
      );
    }

    function FailureScreen(props) {
      const { t, store } = props;
      return h(
        'div',
        { className: 'dshrd-backdrop' },
        h(
          'div',
          { className: 'dshrd-card', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': t('failed.title') },
          h('div', { className: 'dshrd-card-title' }, t('failed.title')),
          h('div', { className: 'dshrd-card-body' }, failureText(t, store.error, store.action)),
          h(
            'div',
            { className: 'dshrd-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshrd-button dshrd-button-plain',
                onClick: () => {
                  setSnapshot({ stage: 'idle', error: null });
                },
              },
              t('failed.close'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dshrd-button',
                onClick: () => {
                  try {
                    window.location.reload();
                  } catch {
                    setSnapshot({ stage: 'idle' });
                  }
                },
              },
              t('failed.reload'),
            ),
          ),
        ),
      );
    }

    function ToastView(props) {
      const { t, store } = props;
      const toast = store.toast;
      useToastTimer(toast, dismissToast);
      if (toast === null) return null;
      let text;
      let danger = false;
      if (toast.kind === 'force') {
        danger = true;
        text = formatText(t('toast.force'), {
          interrupted: toast.interrupted ?? 0,
          delivered: toast.delivered ?? 0,
          failed: toast.failed ?? 0,
        });
      } else if (toast.kind === 'forceNoInterrupt') {
        danger = true;
        text = t('toast.forceNoInterrupt');
      } else if (toast.kind === 'coordinated') {
        text =
          (toast.timedOut ?? 0) > 0
            ? formatText(t('toast.coordinatedTimedOut'), { count: toast.timedOut })
            : t('toast.coordinated');
      } else if (toast.kind === 'safeAi') {
        text = formatText(t('toast.safeAi'), { count: toast.count ?? 0 });
      } else {
        text = t('toast.safe');
      }
      return h(
        'div',
        {
          className: danger ? 'dshrd-toast dshrd-toast-danger' : 'dshrd-toast',
          role: 'status',
          'aria-live': danger ? 'assertive' : 'polite',
        },
        h('div', { className: 'dshrd-toast-message', style: { flex: '1 1 auto' } }, text),
        h('button', { type: 'button', className: 'dshrd-toast-close', onClick: dismissToast }, t('toast.close')),
      );
    }

    /* --------------------------------------------------- plugin config page -- */

    // The bundle-config page can render outside this bundle's own locale
    // wrappers, so resolve the inlined dictionaries when no `t` seat exists.
    function fallbackTranslate(key, values) {
      let dict = en;
      try {
        const language =
          typeof navigator !== 'undefined' && typeof navigator.language === 'string' ? navigator.language : '';
        if (language.toLowerCase().indexOf('zh') === 0) dict = zh;
      } catch {
        dict = en;
      }
      const template = Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : en[key];
      if (typeof template !== 'string') return String(key);
      return values === undefined ? template : formatText(template, values);
    }

    function settingsTranslate(props) {
      return props !== null && props !== undefined && typeof props.t === 'function' ? props.t : fallbackTranslate;
    }

    /** `{ ok, rollCallWaitMs, writable }` -> whole seconds, or null when invalid. */
    function configSeconds(data) {
      if (data === null || typeof data !== 'object' || data.ok === false) return null;
      const ms = data.rollCallWaitMs;
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
      return Math.round(ms / 1000);
    }

    /** A broken config panel must never take the sidebar entry down with it. */
    class SettingsBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }
      static getDerivedStateFromError() {
        return { failed: true };
      }
      componentDidCatch() {
        /* the panel is optional */
      }
      render() {
        return this.state.failed ? null : this.props.children;
      }
    }

    /**
     * `plugins.bundle.config` page: the roll-call wait, read/written over the
     * Host API. Saving writes the runtime settings file (`settings.json` beside
     * the restart state) instead of editing the profile patch, so a new value
     * applies immediately and never reactivates this plugin row (a Loader
     * re-activation disposes live agents/sessions on DSH 0.2.1-rc.5).
     */
    function RestartSettingsPanel(props) {
      const t = settingsTranslate(props);
      const view = props !== null && props !== undefined && props.view === 'summary' ? 'summary' : 'page';
      const [seconds, setSeconds] = React.useState('');
      const [currentSeconds, setCurrentSeconds] = React.useState(null);
      const [loaded, setLoaded] = React.useState(false);
      const [writable, setWritable] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);
      const aliveRef = React.useRef(true);
      const baseId = typeof React.useId === 'function' ? React.useId() : 'dshrd-cfg';
      const inputId = `${baseId}-wait`;

      React.useEffect(() => {
        aliveRef.current = true;
        return () => {
          aliveRef.current = false;
        };
      }, []);

      React.useEffect(() => {
        let cancelled = false;
        apiRequest(API_CONFIG, { method: 'GET' }).then(
          (data) => {
            if (cancelled || !aliveRef.current) return;
            setLoaded(true);
            const parsed = configSeconds(data);
            if (parsed === null) {
              setMessage({ kind: 'error', text: t('settings.loadFailedHint') });
              return;
            }
            setSeconds(String(parsed));
            setCurrentSeconds(parsed);
            setWritable(data.writable !== false);
          },
          (error) => {
            if (cancelled || !aliveRef.current) return;
            setLoaded(true);
            setMessage({
              kind: 'error',
              text: formatText(t('settings.loadFailed'), { message: errorText(error) }),
            });
          },
        );
        return () => {
          cancelled = true;
        };
      }, [view]);

      if (view === 'summary') {
        return h(
          'div',
          { className: 'dshrd-cfg' },
          h(
            'span',
            { className: 'dshrd-cfg-summary' },
            formatText(t('settings.summary'), { seconds: currentSeconds === null ? '…' : currentSeconds }),
          ),
        );
      }

      const save = () => {
        if (busy || !loaded || writable !== true) return;
        const raw = (typeof seconds === 'string' ? seconds : String(seconds)).trim();
        const parsed = Number(raw);
        // Host accepts 0 (= wait forever) or 1000..3600000 ms.
        if (raw === '' || !Number.isFinite(parsed) || Math.round(parsed) !== parsed || parsed < 0 || parsed > 3600) {
          setMessage({ kind: 'error', text: t('settings.invalid') });
          return;
        }
        setBusy(true);
        setMessage(null);
        apiRequest(API_CONFIG, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rollCallWaitMs: parsed * 1000 }),
        }).then(
          (data) => {
            if (!aliveRef.current) return;
            setBusy(false);
            if (data !== null && typeof data === 'object' && data.ok === true) {
              const saved = configSeconds(data);
              const value = saved === null ? parsed : saved;
              setCurrentSeconds(value);
              setSeconds(String(value));
              setMessage({ kind: 'ok', text: t('settings.saved') });
              return;
            }
            setMessage({
              kind: 'error',
              text: formatText(t('settings.saveFailed'), { message: t('settings.saveFailedHint') }),
            });
          },
          (error) => {
            if (!aliveRef.current) return;
            setBusy(false);
            // 400 (bad value) and 500 (not writable) both carry the Host's own
            // text; every HTTP status is worth showing verbatim.
            const status = error !== null && typeof error === 'object' ? error.status : undefined;
            const detail = typeof status === 'number' ? errorText(error) : t('settings.saveFailedHint');
            setMessage({
              kind: 'error',
              text: formatText(t('settings.saveFailed'), { message: detail }),
            });
          },
        );
      };

      const disabled = busy || !loaded || writable !== true;
      return h(
        'div',
        { className: 'dshrd-cfg' },
        h('div', { className: 'dshrd-cfg-title' }, t('settings.title')),
        h('div', { className: 'dshrd-cfg-desc' }, t('settings.desc')),
        h(
          'div',
          { className: 'dshrd-cfg-row' },
          h('label', { className: 'dshrd-cfg-label', htmlFor: inputId }, t('settings.wait.label')),
          h('input', {
            id: inputId,
            className: 'dshrd-input dshrd-cfg-input',
            type: 'number',
            min: 0,
            max: 3600,
            step: 1,
            inputMode: 'numeric',
            value: seconds,
            disabled,
            onChange: (event) => setSeconds(event.target.value),
            onKeyDown: (event) => {
              if (event.key !== 'Enter' && event.key !== 'NumpadEnter') return;
              event.preventDefault();
              save();
            },
          }),
          h('span', { className: 'dshrd-cfg-unit' }, t('settings.wait.unit')),
        ),
        h(
          'div',
          { className: 'dshrd-cfg-save' },
          h(
            'button',
            { type: 'button', className: 'dshrd-button dshrd-button-primary', disabled, onClick: save },
            busy ? t('settings.saving') : t('settings.save'),
          ),
        ),
        message === null
          ? null
          : h(
              'div',
              {
                className: message.kind === 'ok' ? 'dshrd-cfg-ok' : 'dshrd-cfg-error',
                role: message.kind === 'ok' ? 'status' : 'alert',
              },
              message.text,
            ),
        writable === true ? null : h('div', { className: 'dshrd-cfg-note' }, t('settings.readOnly')),
        h('div', { className: 'dshrd-cfg-note' }, t('settings.note')),
        h(
          'div',
          { className: 'dshrd-cfg-cur' },
          currentSeconds === null
            ? t('settings.loading')
            : formatText(t('settings.current'), { seconds: currentSeconds }),
        ),
      );
    }

    /** Registered bundle-config component; a crash stays on this page. */
    function RestartSettings(props) {
      return h(SettingsBoundary, null, h(RestartSettingsPanel, props));
    }

    function RestartOverlay(props) {
      const { t } = props;
      const store = useStore();
      const nodes = [];
      if (store.menu !== null) nodes.push(h(PowerMenu, { key: 'menu', t, store }));
      if (store.stage === 'dialog') nodes.push(h(DialogCard, { key: 'dialog', t, store }));
      else if (store.stage === 'submitting' || store.stage === 'waiting' || store.stage === 'shutting-down') {
        nodes.push(h(ProgressScreen, { key: 'progress', t, store }));
      } else if (store.stage === 'shutdown-done') nodes.push(h(ShutdownDoneScreen, { key: 'shutdown-done', t, store }));
      else if (store.stage === 'failed') nodes.push(h(FailureScreen, { key: 'failed', t, store }));
      nodes.push(h(ToastView, { key: 'toast', t, store }));
      return h(React.Fragment, null, ...nodes);
    }

    /* ---------------------------------------------------------------- app ---- */

    const inject = ['slots', 'locale', 'connection'];

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh,
            en,
          }),
        'dsh-restart: locale dictionaries',
      );
      ctx.effect(() => ensureStyles(), 'dsh-restart: styles');
      // Keep the DOM power button's chrome (hidden while reconnecting, active
      // while the menu is open) in sync with the store.
      ctx.effect(
        () => {
          const state = ctx.get('connection')?.state;
          if (state === undefined || typeof state.subscribe !== 'function' || typeof state.getSnapshot !== 'function') {
            return () => {};
          }
          const sync = () => {
            let hidden = false;
            try {
              const value = state.getSnapshot();
              hidden = value !== undefined && value !== 'connected';
            } catch {
              hidden = false;
            }
            if (snapshot.powerHidden !== hidden) {
              if (hidden) closePowerMenu();
              setSnapshot({ powerHidden: hidden });
            }
          };
          sync();
          const off = state.subscribe(sync);
          return () => {
            try {
              off();
            } catch {
              /* disposed */
            }
          };
        },
        'dsh-restart: power visibility',
      );
      // The real human entry: a square button appended into the sidebar footer's
      // settingsArea container (web and Desktop share that DOM).
      ctx.effect(() => startDomPowerWatch(), 'dsh-restart: settingsArea power button');
      // Fallback seat only if settingsArea never appears.
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'restart-dsh-power',
            order: POWER_ORDER,
            locale: NS,
          },
          PowerFallback,
        ),
      );
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'restart-dsh-overlay',
            order: OVERLAY_ORDER,
            locale: NS,
          },
          RestartOverlay,
        ),
      );
      // Plugins page → this bundle's detail page: the roll-call wait setting is
      // keyed by the bundle package name. Contained so a config-page failure can
      // never break the sidebar button or the overlay registered above.
      try {
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: '@local/dsh-power',
              locale: NS,
            },
            RestartSettings,
          ),
        );
      } catch {
        /* optional surface: leave the rest of the plugin intact */
      }
      ctx.effect(
        () => {
          const onKeyDown = (event) => {
            if (event.defaultPrevented || event.isComposing) return;
            if (event.key !== 'Escape' || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
            if (snapshot.menu !== null) {
              event.preventDefault();
              closePowerMenu();
              return;
            }
            if (snapshot.stage === 'dialog') {
              event.preventDefault();
              cancelDialog();
              return;
            }
            if (snapshot.stage === 'failed' || snapshot.stage === 'shutdown-done') {
              event.preventDefault();
              setSnapshot({ stage: 'idle', error: null });
            }
          };
          document.addEventListener('keydown', onKeyDown);
          const dismiss = () => closePowerMenu();
          window.addEventListener('resize', dismiss);
          window.addEventListener('blur', dismiss);
          return () => {
            document.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('resize', dismiss);
            window.removeEventListener('blur', dismiss);
          };
        },
        'dsh-restart: dismissal listeners',
      );
      void checkRestartOutcome();
      startBootWatch();
      ctx.effect(
        () => () => {
          stopPolling();
          stopOutcomeRecheck();
          stopDomPowerWatch();
          if (bootWatchTimer !== null) {
            clearInterval(bootWatchTimer);
            bootWatchTimer = null;
          }
        },
        'dsh-restart: timers',
      );
    }

    return { inject, apply };
  },
});
