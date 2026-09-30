import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BANNER_HELPER = fileURLToPath(new URL('./desktop-banner.py', import.meta.url));
export const BANNER_PYTHON = '/usr/bin/python3';

// Keep notification text off the command line. Resolve `shown` only after GTK
// maps the window; `closed` separately tracks the bounded process lifetime.
export function launchDesktopBanner(payload, { signal, onOpen = () => {}, spawnProcess = spawn,
  startupTimeoutMs = 4000, killGraceMs = 500 } = {}) {
  let resolveShown, rejectShown, resolveClosed;
  const shown = new Promise((resolve, reject) => { resolveShown = resolve; rejectShown = reject; });
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  let child, ready = false, finished = false, opened = false, aborted = false, buffer = '';
  let startupTimer, lifetimeTimer, killTimer;
  const fail = () => new Error('大字通知无法显示，请检查桌面会话后重试。');
  const finish = error => {
    if (finished) return;
    finished = true;
    clearTimeout(startupTimer); clearTimeout(lifetimeTimer); clearTimeout(killTimer);
    signal?.removeEventListener('abort', abort);
    if (!ready) rejectShown(error || fail());
    resolveClosed({ error: error || null, aborted });
  };
  const stop = () => {
    if (finished) return;
    child?.kill('SIGTERM');
    if (!killTimer) killTimer = setTimeout(() => child?.kill('SIGKILL'), killGraceMs);
  };
  const abort = () => { aborted = true; stop(); };
  try {
    if (signal?.aborted) { aborted = true; finish(fail()); return { shown, closed }; }
    child = spawnProcess(BANNER_PYTHON, [BANNER_HELPER], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child.once('error', () => finish(fail()));
    child.once('close', code => finish(code === 0 || aborted ? null : fail()));
    child.stdin.on('error', () => { stop(); });
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 8192) { stop(); return; }
      let boundary;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (['shown', 'suppressed'].includes(message.event) && !ready) {
          ready = true; clearTimeout(startupTimer);
          resolveShown({ suppressed: message.event === 'suppressed' });
        } else if (message.event === 'open' && ready && payload.openable && !opened) {
          opened = true; onOpen();
        }
      }
    });
    signal?.addEventListener('abort', abort, { once: true });
    startupTimer = setTimeout(() => { if (!ready) { ready = true; rejectShown(fail()); stop(); } }, startupTimeoutMs);
    lifetimeTimer = setTimeout(stop, payload.durationMs + startupTimeoutMs + 1000);
    child.stdin.end(JSON.stringify(payload));
  } catch { finish(fail()); }
  return { shown, closed };
}
