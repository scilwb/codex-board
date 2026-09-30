import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createActivityTracker } from '../src/activity.js';
import { BANNER_HELPER, BANNER_PYTHON, launchDesktopBanner } from './desktop-banner.mjs';

function runCommand(file, args, { timeout, signal }) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, signal, maxBuffer: 32 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

function cleanTitle(value) {
  return String(value || '未命名对话').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160) || '未命名对话';
}

// libnotify bodies support markup. Thread titles are untrusted plain text.
function escapeMarkup(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export class DesktopNotifications {
  constructor({ dataDir, onOpen = async () => {}, run = runCommand, now = Date.now, platform = process.platform,
    maxConcurrent = 4, maxQueue = 64, commandTimeoutMs = 4000, actionTimeoutMs = 20000, launchBanner = launchDesktopBanner } = {}) {
    if (!dataDir) throw new Error('Desktop notification dataDir is required.');
    this.settingsPath = join(dataDir, 'desktop-notifications.json');
    this.dataDir = dataDir;
    this.onOpen = onOpen;
    this.run = run;
    this.now = now;
    this.platform = platform;
    this.launchBanner = launchBanner;
    this.presentation = 'system';
    this.bannerVisible = false;
    this.activeBanner = null;
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.maxQueue = Math.max(1, maxQueue);
    this.commandTimeoutMs = commandTimeoutMs;
    this.actionTimeoutMs = actionTimeoutMs;
    this.enabled = false;
    this.available = null;
    this.supportsActions = false;
    this.configError = null;
    this.probeError = null;
    this.deliveryError = null;
    this.lastProbeAt = null;
    this.closed = false;
    this.queue = [];
    this.active = 0;
    this.controllers = new Set();
    this.trackActivity = createActivityTracker();
    try {
      const settings = JSON.parse(readFileSync(this.settingsPath, 'utf8'));
      if (typeof settings.enabled !== 'boolean') throw new Error('Invalid settings.');
      this.enabled = settings.enabled;
    } catch (error) {
      if (error.code !== 'ENOENT') this.configError = '桌面提醒设置无法读取，已暂时关闭提醒。';
    }
    this.readyPromise = this.probe();
  }

  status() {
    return {
      enabled: this.enabled,
      available: this.available,
      supportsActions: this.supportsActions,
      presentation: this.presentation,
      lastError: this.configError || this.probeError || this.deliveryError || null,
    };
  }

  async ready() {
    await this.readyPromise;
    return this.status();
  }

  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('桌面提醒开关必须为布尔值。');
    if (this.closed) throw new Error('桌面提醒服务已关闭。');
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.settingsPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ enabled }, null, 2)}\n`, { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temporary, this.settingsPath);
    } finally {
      rmSync(temporary, { force: true });
    }
    this.enabled = enabled;
    this.configError = null;
    if (!enabled) { this.queue.length = 0; this.activeBanner?.controller.abort(); }
    else if (this.available === false) void this.retryProbe();
    return this.status();
  }

  observe(threads) {
    // Always advance the baseline, including while muted or unavailable.
    const notices = this.trackActivity(Array.isArray(threads) ? threads : [], this.now());
    const current = new Map((Array.isArray(threads) ? threads : []).map(thread => [thread.id, thread]));
    const pendingQuestion = notice => {
      const thread = current.get(notice.threadId);
      return thread?.status === 'waiting' && !thread.activity?.stale && !thread.archived;
    };
    if (this.presentation === 'large-banner') this.queue = this.queue.filter(notice => notice.status !== 'waiting' || pendingQuestion(notice));
    if (this.activeBanner?.notice.status === 'waiting' && !pendingQuestion(this.activeBanner.notice)) this.activeBanner.controller.abort();
    if (this.closed || !this.enabled) return;
    if (this.available === false && this.now() - this.lastProbeAt >= 30000) void this.retryProbe();
    for (const notice of notices) {
      if (this.queue.length >= this.maxQueue) this.queue.shift();
      this.queue.push(notice);
    }
    void this.readyPromise.then(() => this.drain());
  }

  async test() {
    if (this.closed) throw new Error('桌面提醒服务已关闭。');
    await this.ready();
    if (!this.available) await this.retryProbe();
    if (!this.available) throw new Error(this.probeError || '系统桌面通知暂不可用。');
    // Test notifications do not require enabling ongoing notifications and have
    // no action, so the HTTP request completes without waiting for a click.
    if (this.controllers.size >= this.maxConcurrent + 1) throw new Error('桌面提醒正在发送，请稍后重试。');
    if (this.bannerVisible) throw new Error('已有桌面提醒正在显示，请关闭后再测试。');
    await this.send({ test: true }, { waitForClose: false });
    return this.status();
  }

  async command(file, args, timeout = this.commandTimeoutMs) {
    if (this.closed) throw new Error('桌面提醒服务已关闭。');
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      return await this.run(file, args, { timeout, signal: controller.signal });
    } finally {
      this.controllers.delete(controller);
    }
  }

  async probe() {
    this.lastProbeAt = this.now();
    if (this.platform !== 'linux') {
      this.available = false;
      this.probeError = '当前系统暂不支持原生桌面提醒；此功能需要 Linux 桌面通知服务。';
      return;
    }
    // GTK provides per-application large text without changing desktop fonts.
    // Fall back to native notifications on systems without this helper/display.
    try {
      const checked = await this.command(BANNER_PYTHON, [BANNER_HELPER, '--check']);
      const capability = JSON.parse(checked.stdout);
      if (capability.available && capability.backend === 'gtk3') {
        this.presentation = 'large-banner';
        this.supportsActions = true;
        this.available = true;
        this.probeError = null;
        return;
      }
    } catch { /* Native libnotify remains supported. */ }
    if (this.closed) return;
    this.presentation = 'system';
    let help;
    try {
      help = await this.command('notify-send', ['--help']);
    } catch (error) {
      if (this.closed) return;
      this.available = false;
      this.probeError = error.code === 'ENOENT'
        ? '未找到 notify-send，请安装桌面通知工具 libnotify-bin。'
        : '无法启动桌面通知工具 notify-send。';
      return;
    }
    try {
      const capabilities = await this.command('gdbus', ['call', '--session', '--dest', 'org.freedesktop.Notifications',
        '--object-path', '/org/freedesktop/Notifications', '--method', 'org.freedesktop.Notifications.GetCapabilities']);
      this.supportsActions = /--action\b/.test(help.stdout) && /['"]actions['"]/.test(capabilities.stdout);
    } catch (error) {
      if (this.closed) return;
      // gdbus is only a capability probe; notify-send can work without this CLI.
      if (error.code !== 'ENOENT') {
        this.available = false;
        this.probeError = '无法连接桌面通知服务，请确认看板服务运行在已登录的桌面会话中。';
        return;
      }
    }
    if (!this.closed) {
      this.available = true;
      this.probeError = null;
    }
  }

  retryProbe() {
    if (this.closed || this.available !== false) return this.readyPromise;
    this.available = null;
    this.supportsActions = false;
    this.readyPromise = this.probe();
    return this.readyPromise;
  }

  drain() {
    if (this.closed || !this.enabled || !this.available) {
      this.queue.length = 0;
      return;
    }
    while (this.active < (this.presentation === 'large-banner' ? 1 : this.maxConcurrent) && !this.bannerVisible && this.queue.length) {
      const notice = this.queue.shift();
      this.active += 1;
      void this.send(notice).catch(() => {}).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }

  async showBanner(notice, { waitForClose = true } = {}) {
    if (this.bannerVisible) throw new Error('已有桌面提醒正在显示。');
    const controller = new AbortController();
    this.controllers.add(controller);
    this.bannerVisible = true;
    this.activeBanner = { notice, controller };
    const payload = {
      status: notice.test ? 'test' : notice.status,
      title: notice.test ? '有提问、执行结束，在这里看清楚' : cleanTitle(notice.title),
      body: '',
      durationMs: notice.test ? 12000 : notice.status === 'waiting' ? 25000 : 18000,
      openable: !notice.test,
    };
    const banner = this.launchBanner(payload, { signal: controller.signal, onOpen: () => {
      if (this.closed) return;
      Promise.resolve().then(() => this.onOpen(notice.threadId)).catch(() => {
        this.deliveryError = '打开对话失败，请从看板打开。';
      });
    } });
    const closed = banner.closed.then(result => {
      if (result?.error && !result.aborted && !this.closed) this.deliveryError = result.error.message;
    }).finally(() => {
      this.controllers.delete(controller);
      this.bannerVisible = false;
      this.activeBanner = null;
      this.drain();
    });
    try {
      const result = await banner.shown;
      if (result?.suppressed) {
        if (notice.test) throw new Error('系统已开启勿扰，暂不显示桌面横幅。');
      } else this.deliveryError = null;
      if (waitForClose) await closed;
    } catch (error) {
      if (controller.signal.aborted) {
        if (notice.test && !this.closed) throw new Error('测试提醒已取消。');
        return;
      }
      if (!this.closed) this.deliveryError = error.message;
      throw error;
    }
  }

  async send(notice, options) {
    if (this.presentation === 'large-banner') return this.showBanner(notice, options);
    const actionable = !notice.test && this.supportsActions;
    const summary = notice.test ? 'Codex Board · 桌面提醒测试'
      : notice.status === 'waiting' ? 'Codex 需要你回答' : 'Codex 本轮已结束';
    const body = notice.test ? '有提问、执行结束时提醒你。' : escapeMarkup(cleanTitle(notice.title));
    const args = ['--app-name=Codex Board', '--icon=dialog-information', '--urgency=normal', '--expire-time=10000'];
    if (actionable) args.push('--action=open=打开对话');
    args.push('--', summary, body);
    let result;
    try {
      result = await this.command('notify-send', args, actionable ? this.actionTimeoutMs : this.commandTimeoutMs);
      this.deliveryError = null;
    } catch (error) {
      if (this.closed) return;
      // An action-capable notify-send waits for the user; expiry of our bounded
      // listener does not mean delivery failed and does not leave a process alive.
      if (actionable && error.killed) return;
      this.deliveryError = '桌面提醒发送失败，请检查桌面通知服务后重试测试提醒。';
      throw new Error(this.deliveryError, { cause: error });
    }
    if (actionable && result?.stdout?.trim() === 'open' && !this.closed) {
      try {
        await this.onOpen(notice.threadId);
      } catch {
        this.deliveryError = '已发送桌面提醒，但打开对话失败；请从看板打开。';
      }
    }
  }

  close() {
    this.closed = true;
    this.queue.length = 0;
    for (const controller of this.controllers) controller.abort();
  }
}
