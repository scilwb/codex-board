import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function readBranch(cwd) {
  const { stdout } = await exec('git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'], {
    timeout: 1500, maxBuffer: 16 * 1024, encoding: 'utf8', windowsHide: true,
  });
  return stdout.trim() || null;
}

// Git on a slow mount must not block snapshots, SSE or bridge heartbeats.
export class GitBranches {
  constructor({ read = readBranch, now = Date.now, ttlMs = 30000, maxEntries = 256, concurrency = 4 } = {}) {
    this.read = read;
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.concurrency = concurrency;
    this.cache = new Map();
    this.pending = new Map();
    this.queue = [];
    this.running = 0;
  }

  get(cwd) {
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) return Promise.resolve(null);
    const cached = this.cache.get(cwd);
    if (cached && this.now() - cached.at < this.ttlMs) {
      this.cache.delete(cwd);
      this.cache.set(cwd, cached);
      return Promise.resolve(cached.branch);
    }
    if (this.pending.has(cwd)) return this.pending.get(cwd);
    const promise = new Promise(resolve => this.queue.push({ cwd, resolve }));
    this.pending.set(cwd, promise);
    this.drain();
    return promise;
  }

  drain() {
    while (this.running < this.concurrency && this.queue.length) {
      const { cwd, resolve } = this.queue.shift();
      this.running++;
      Promise.resolve().then(() => this.read(cwd)).catch(() => null).then(branch => {
        this.cache.delete(cwd);
        this.cache.set(cwd, { branch, at: this.now() });
        while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
        this.pending.delete(cwd);
        this.running--;
        resolve(branch);
        this.drain();
      });
    }
  }
}
