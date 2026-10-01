import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const PROMPT_LIMITS = { title: 100, content: 60000, tags: 8, tag: 24, count: 500, bytes: 4 * 1024 * 1024 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const fields = ['title', 'content', 'tags', 'pinned'];
const metadata = ['id', 'createdAt', 'updatedAt', 'revision'];
const empty = () => ({ version: 1, prompts: [] });
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const validTimestamp = value => Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMESTAMP;

function keys(value, allowed) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) throw fail('提示词数据格式无效');
}

function id(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw fail('提示词 ID 格式无效');
  return value.toLowerCase();
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw fail('请提供有效的提示词版本');
  return value;
}

function values(value, partial = false) {
  const result = {};
  if (!partial || Object.hasOwn(value, 'title')) {
    if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > PROMPT_LIMITS.title) throw fail('标题须为 1 到 100 个字符');
    result.title = value.title.trim();
  }
  if (!partial || Object.hasOwn(value, 'content')) {
    if (typeof value.content !== 'string' || !value.content.trim() || value.content.length > PROMPT_LIMITS.content) throw fail('提示词内容须为 1 到 60000 个字符');
    result.content = value.content; // Preserve indentation, blank lines and trailing whitespace.
  }
  if (!partial || Object.hasOwn(value, 'tags')) {
    const tags = value.tags === undefined ? [] : value.tags;
    if (!Array.isArray(tags) || tags.length > PROMPT_LIMITS.tags || tags.some(tag => typeof tag !== 'string' || !tag.trim() || tag.length > PROMPT_LIMITS.tag)) throw fail('最多 8 个标签，每个标签须为 1 到 24 个字符');
    result.tags = [...new Set(tags.map(tag => tag.trim()))];
  }
  if (!partial || Object.hasOwn(value, 'pinned')) {
    if (value.pinned !== undefined && typeof value.pinned !== 'boolean') throw fail('置顶状态格式无效');
    result.pinned = value.pinned ?? false;
  }
  return result;
}

function collection(value, importing = false) {
  keys(value, ['version', 'prompts']);
  if (value.version !== 1 || !Array.isArray(value.prompts) || value.prompts.length > PROMPT_LIMITS.count) throw fail('请使用版本 1 的提示词库文件，最多保存 500 条提示词');
  const ids = new Set();
  return { version: 1, prompts: value.prompts.map(prompt => {
    keys(prompt, [...fields, ...metadata]);
    const promptId = id(prompt.id);
    if (ids.has(promptId)) throw fail('提示词文件中存在重复 ID');
    ids.add(promptId);
    for (const field of ['createdAt', 'updatedAt']) {
      if ((!importing || prompt[field] !== undefined) && !validTimestamp(prompt[field])) throw fail('提示词时间格式无效');
    }
    if (!importing || prompt.revision !== undefined) revision(prompt.revision);
    const now = Date.now();
    return { id: promptId, ...values(prompt), createdAt: prompt.createdAt ?? now, updatedAt: prompt.updatedAt ?? now, revision: prompt.revision ?? 1 };
  }) };
}

function serialize(state) {
  if (state.prompts.length > PROMPT_LIMITS.count) throw fail('提示词库最多保存 500 条，请先整理现有提示词', 413);
  const raw = JSON.stringify(state) + '\n';
  if (Buffer.byteLength(raw) > PROMPT_LIMITS.bytes) throw fail('提示词库总大小不能超过 4 MB，请先整理现有提示词', 413);
  return raw;
}

function readOptional(path) {
  try {
    if (statSync(path).size > PROMPT_LIMITS.bytes) throw fail('提示词库文件过大，原文件已保留', 503);
    return readFileSync(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function writeAtomic(path, raw) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, raw, { flag: 'wx', mode: 0o600, flush: true });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

function staleLock(path) {
  try {
    const pid = Number(readFileSync(join(path, 'owner'), 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (error) { return error.code === 'ESRCH'; }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return false;
}

function acquireLock(path) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path, { mode: 0o700 });
      try { writeFileSync(join(path, 'owner'), String(process.pid), { flag: 'wx', mode: 0o600 }); }
      catch (error) { rmSync(path, { recursive: true, force: true }); throw error; }
      return () => rmSync(path, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Keep an unclaimed lock intact: another process may be writing its owner.
      if (!staleLock(path) || attempt) throw fail('另一个看板正在保存提示词，请稍后重试', 409);
      // Only one process may reclaim a dead owner's directory. Recheck its
      // owner after acquiring this guard so a competing writer is never removed.
      const recovery = `${path}.recovery`;
      try { mkdirSync(recovery, { mode: 0o700 }); }
      catch (problem) { if (problem.code === 'EEXIST') throw fail('另一个看板正在恢复提示词，请稍后重试', 409); throw problem; }
      try {
        if (!staleLock(path)) throw fail('另一个看板正在保存提示词，请稍后重试', 409);
        rmSync(path, { recursive: true, force: true });
      } finally { rmSync(recovery, { recursive: true, force: true }); }
    }
  }
  throw fail('另一个看板正在保存提示词，请稍后重试', 409);
}

export class PromptLibrary {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.path = join(dataDir, 'prompts.json');
    this.backupPath = `${this.path}.bak`;
    this.lockPath = `${this.path}.lock`;
  }

  read() {
    const raw = readOptional(this.path);
    if (raw !== null) {
      try { return { state: collection(JSON.parse(raw)), raw, recovered: false }; }
      catch { /* Read the last valid backup without overwriting the damaged file. */ }
    }
    const backup = readOptional(this.backupPath);
    if (backup !== null) {
      try { return { state: collection(JSON.parse(backup)), raw, recovered: true }; }
      catch { throw fail('提示词库及备份已损坏，原文件已保留', 503); }
    }
    if (raw !== null) throw fail('提示词库已损坏，原文件已保留', 503);
    return { state: empty(), raw: null, recovered: false };
  }

  list() {
    try {
      const { state, recovered } = this.read();
      return recovered ? { ...state, recovered: true } : state;
    }
    catch (error) { if (error.status) throw error; throw fail('无法读取提示词库，请检查本机目录权限', 503); }
  }

  mutate(operation) {
    let release;
    try {
      mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
      release = acquireLock(this.lockPath);
      // Read inside the lock. Multiple running services never publish edits
      // computed from a cached copy of the collection.
      const previous = this.read();
      const { result, changed } = operation(previous.state);
      if (changed) {
        const raw = serialize(previous.state);
        if (previous.recovered && previous.raw !== null) writeAtomic(`${this.path}.corrupt-${Date.now()}-${randomUUID()}`, previous.raw);
        if (previous.raw !== null && !previous.recovered) writeAtomic(this.backupPath, previous.raw);
        writeAtomic(this.path, raw);
      }
      return result;
    } catch (error) {
      if (error.status) throw error;
      throw fail('无法保存提示词，请检查本机存储空间和目录权限', 503);
    } finally { release?.(); }
  }

  create(body) {
    keys(body, ['id', ...fields]);
    const promptId = id(body.id);
    const input = values(body);
    return this.mutate(state => {
      const existing = state.prompts.find(prompt => prompt.id === promptId);
      if (existing) {
        if (fields.some(field => JSON.stringify(existing[field]) !== JSON.stringify(input[field]))) throw fail('这个提示词 ID 已保存了其他内容，请刷新后重试', 409);
        return { result: { prompt: existing }, changed: false };
      }
      const now = Date.now();
      const prompt = { id: promptId, ...input, createdAt: now, updatedAt: now, revision: 1 };
      state.prompts.push(prompt);
      return { result: { prompt }, changed: true };
    });
  }

  update(promptId, body) {
    promptId = id(promptId);
    keys(body, ['revision', ...fields]);
    revision(body.revision);
    const input = values(body, true);
    if (!Object.keys(input).length) throw fail('请选择要修改的提示词内容');
    return this.mutate(state => {
      const index = state.prompts.findIndex(prompt => prompt.id === promptId);
      const existing = state.prompts[index];
      if (!existing) throw fail('找不到这个提示词', 404);
      if (existing.revision !== body.revision) throw fail('提示词已在其他页面修改，请重新加载后再保存', 409);
      if (!Object.keys(input).some(field => JSON.stringify(existing[field]) !== JSON.stringify(input[field]))) return { result: { prompt: existing }, changed: false };
      if (!Number.isSafeInteger(existing.revision + 1)) throw fail('提示词版本超出范围', 409);
      // A valid imported date can already be the maximum representable Date.
      // Revision advances independently; never write a timestamp our reader rejects.
      const updatedAt = Math.max(Date.now(), Math.min(MAX_TIMESTAMP, existing.updatedAt + 1));
      if (!validTimestamp(updatedAt)) throw fail('提示词更新时间超出范围', 409);
      const prompt = { ...existing, ...input, updatedAt, revision: existing.revision + 1 };
      state.prompts[index] = prompt;
      return { result: { prompt }, changed: true };
    });
  }

  delete(promptId, body) {
    promptId = id(promptId);
    keys(body, ['revision']);
    revision(body.revision);
    return this.mutate(state => {
      const existing = state.prompts.find(prompt => prompt.id === promptId);
      if (!existing) throw fail('找不到这个提示词', 404);
      if (existing.revision !== body.revision) throw fail('提示词已在其他页面修改，请重新加载后再删除', 409);
      state.prompts = state.prompts.filter(prompt => prompt.id !== promptId);
      return { result: { ok: true }, changed: true };
    });
  }

  import(body) {
    const incoming = collection(body, true).prompts;
    return this.mutate(state => {
      const identities = new Set(state.prompts.map(prompt => JSON.stringify([prompt.title, prompt.content])));
      const ids = new Set(state.prompts.map(prompt => prompt.id));
      let imported = 0;
      for (const prompt of incoming) {
        const identity = JSON.stringify([prompt.title, prompt.content]);
        if (identities.has(identity)) continue;
        let promptId = prompt.id;
        while (ids.has(promptId)) promptId = randomUUID();
        state.prompts.push({ ...prompt, id: promptId, revision: 1 });
        ids.add(promptId); identities.add(identity); imported++;
      }
      return { result: { ...state, imported, skipped: incoming.length - imported }, changed: imported > 0 };
    });
  }
}
