import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const MAX_CANDIDATES = 512;
const MAX_OUTPUT = 24;
const MARKDOWN_LINK = /\[[^\]\n]{0,200}\]\(\s*(<[^>\n]{1,1024}>|[^)\n]{1,1024})\s*\)/gu;
const BACKTICK = /`([^`\n]{1,1024})`/gu;
const TAB_LINE = /^\s*[-*]\s+[^:\n]{1,140}:\s+([^\n]{1,1024})$/gmu;
const PLAIN_PATH = /(^|[\s([{（【"'“‘，、：])((?:~\/|\.{1,2}\/|\/|[\p{L}\p{N}_.-]+\/)(?:[\p{L}\p{N}_+.@-]+\/)*[\p{L}\p{N}_+.@-]+(?:\.[\p{L}\p{N}]{1,12})?(?::[1-9]\d{0,6})?)(?=$|[\s)\]}）】，。；;!?,.:])/gmu;
const SPACED_PATH = /(^|[\s([{（【"'“‘，、：])((?:~\/|\.{1,2}\/|\/|[\p{L}\p{N}_.-]+\/)(?:[\p{L}\p{N}_+.@-]+[ /]){0,8}[\p{L}\p{N}_+.@-]+\.[\p{L}\p{N}]{1,12}(?::[1-9]\d{0,6})?)(?=$|[\s)\]}）】，。；;!?,.:])/gmu;
const BARE_FILE = /(^|[\s([{（【"'“‘，、：])((?:Dockerfile|Makefile|CMakeLists\.txt|LICENSE|README(?:\.[\p{L}\p{N}_-]+)?\.md|AGENTS\.md|[\p{L}\p{N}_-]+\.(?:md|mdx|txt|mjs|cjs|js|jsx|ts|tsx|py|json|jsonl|yaml|yml|toml|pdf|svg|png|jpg|jpeg|urdf|stl|step|html|css))(?::[1-9]\d{0,6})?)(?=$|[\s)\]}）】，。；;!?,.:])/gmu;
const IMPORTANT = /(?:修改|编辑|新增|实现|测试|运行|关键|入口|接口|修复|报错|失败|打开|查看|改动|edit(?:ed)?|chang(?:e|ed)|test(?:ed)?|key|entry|main|error|fail|fix(?:ed)?|open)/iu;
const HTTP_METHOD = /(?:^|[\s：:])(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+$/iu;
const HTTP_REQUEST_PREFIX = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+\//iu;
const COMMAND_PREFIX = /^(?:npm|npx|pnpm|yarn|bun|node|python(?:3(?:\.\d+)?)?|pytest|uv|pip(?:3)?|git|bash|sh|zsh|fish|cargo|go|rustc|make|cmake|docker|kubectl|curl|wget|ls|cat|sed|rg|grep|find|cp|mv|rm|mkdir|touch|chmod|chown|cd|echo|tar|unzip|awk|perl|ruby|java|gradle|mvn|vite)\s+/iu;

function cleanTarget(target) {
  let value = target.trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1);
  value = value.trim().replace(/^['"“‘]+|['"”’]+$/gu, '').trim();
  if (/^(?:https?:|ftp:|mailto:|www\.|\/\/)/iu.test(value) || /[\r\n\0<>|;&$?]/u.test(value)) return null;
  if (value.startsWith('file://')) value = value.slice('file://'.length);
  if (value.includes('#')) {
    const fragment = value.match(/#L([1-9]\d{0,6})$/iu);
    if (!fragment) return null;
    value = `${value.slice(0, -fragment[0].length)}:${fragment[1]}`;
  }
  let line;
  const lineSuffix = value.match(/:([1-9]\d{0,6})$/u);
  if (lineSuffix) {
    line = Number(lineSuffix[1]);
    value = value.slice(0, -lineSuffix[0].length);
  }
  value = value.replace(/[，。；;:,.]+$/gu, '').trim();
  if (!value || value === '.' || value === '..' || value === '~' || value.length > 1024) return null;
  if (COMMAND_PREFIX.test(value) || HTTP_REQUEST_PREFIX.test(value)) return null;
  if (/[.!?。]\s/u.test(value) || /\s(?:and|or|then|please|the|is|are|with|for|see|here|guide|然后|请|以及|并且|修改|查看|测试)\s/iu.test(value)) return null;
  const pathLike = /^(?:\/|~\/|\.{1,2}\/)/u.test(value) || value.includes('/') || BARE_NAME.test(value);
  if (!pathLike || /^(?:https?:|ftp:|mailto:)/iu.test(value)) return null;
  if (/^[\w-]+\.(?:com|org|net|io|ai|cn|dev|app)(?:\/|$)/iu.test(value)) return null;
  return { value, line };
}

const BARE_NAME = /^(?:Dockerfile|Makefile|CMakeLists\.txt|LICENSE|README(?:\.[\p{L}\p{N}_-]+)?\.md|AGENTS\.md|[\p{L}\p{N}_-]+\.(?:md|mdx|txt|mjs|cjs|js|jsx|ts|tsx|py|json|jsonl|yaml|yml|toml|pdf|svg|png|jpg|jpeg|urdf|stl|step|html|css))$/iu;

function localPath(raw, cwd) {
  const cleaned = cleanTarget(raw);
  if (!cleaned) return null;
  let value = cleaned.value;
  if (value.startsWith('~/')) value = resolve(homedir(), value.slice(2));
  else value = resolve(cwd, value);
  return { path: value, line: cleaned.line };
}

function evidenceText(text, start, end) {
  const before = text.slice(Math.max(0, start - 64), start);
  const middle = text.slice(start, Math.min(end, start + 120));
  const after = text.slice(end, Math.min(text.length, end + 64));
  const excerpt = `${before}${middle}${after}`.replace(/\s+/gu, ' ').trim();
  return excerpt.length > 160 ? `${excerpt.slice(0, 157)}…` : excerpt;
}

function rank(messageIndex, count, kind, context) {
  const recency = 100 * (messageIndex + 1) / Math.max(count, 1);
  const explicit = { markdown: 35, tab: 30, backtick: 25, plain: 5, bare: 0 }[kind] || 0;
  return recency + explicit + (IMPORTANT.test(context) ? 40 : 0);
}

function compareCandidate(a, b) {
  return b.rank - a.rank || b.messageIndex - a.messageIndex || b.start - a.start || a.path.localeCompare(b.path);
}

function mergedSpans(spans) {
  spans.sort((a, b) => a[0] - b[0]);
  const covered = [];
  for (const [start, end] of spans) {
    const previous = covered.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else covered.push([start, end]);
  }
  return covered;
}

function overlapsSpans(covered, start, end) {
  let left = 0;
  let right = covered.length;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (covered[middle][1] <= start) left = middle + 1;
    else right = middle;
  }
  return left < covered.length && covered[left][0] < end;
}

async function fileStatus(path) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return 'unverified';
    if (info.isFile()) return 'file';
    if (info.isDirectory()) return 'directory';
    return 'unverified';
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR' ? 'missing' : 'unverified';
  }
}

/**
 * Extract bounded file references from already-public conversation messages.
 * This checks path metadata only. It never reads file contents or searches cwd.
 */
export async function collectHandoffFiles({ messages, cwd, maxFiles = MAX_OUTPUT }) {
  if (!Array.isArray(messages) || typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new TypeError('collectHandoffFiles requires public messages and an absolute source cwd');
  }
  const limit = Math.min(MAX_OUTPUT, Math.max(0, Number.isInteger(maxFiles) ? maxFiles : MAX_OUTPUT));
  const candidates = new Map();
  let omitted = false;

  function add(raw, message, messageIndex, start, end, kind) {
    if (kind === 'plain' && HTTP_METHOD.test(message.text.slice(Math.max(0, start - 24), start))) return;
    const location = localPath(raw, cwd);
    if (!location) return;
    const context = evidenceText(message.text, start, end);
    const item = {
      ...location,
      evidence: { offset: message.offset, role: message.role, text: context },
      messageIndex, start, rank: rank(messageIndex, messages.length, kind, context),
    };
    const old = candidates.get(item.path);
    if (old) {
      if (compareCandidate(item, old) < 0) candidates.set(item.path, item);
      return;
    }
    if (candidates.size < MAX_CANDIDATES) { candidates.set(item.path, item); return; }
    omitted = true;
    let weakest;
    for (const existing of candidates.values()) {
      if (!weakest || compareCandidate(existing, weakest) > 0) weakest = existing;
    }
    if (compareCandidate(item, weakest) < 0) {
      candidates.delete(weakest.path);
      candidates.set(item.path, item);
    }
  }

  messages.forEach((message, messageIndex) => {
    if (!message || typeof message.text !== 'string' || !['user', 'assistant'].includes(message.role)) return;
    if (message.role === 'assistant' && message.phase && !['commentary', 'final_answer', 'final'].includes(message.phase)) return;
    const text = message.text;
    const explicitSpans = [];
    for (const match of text.matchAll(MARKDOWN_LINK)) {
      const target = match[1];
      add(target, message, messageIndex, match.index, match.index + match[0].length, 'markdown');
      explicitSpans.push([match.index, match.index + match[0].length]);
    }
    for (const match of text.matchAll(BACKTICK)) {
      add(match[1], message, messageIndex, match.index, match.index + match[0].length, 'backtick');
      explicitSpans.push([match.index, match.index + match[0].length]);
    }
    for (const match of text.matchAll(TAB_LINE)) {
      const target = match[1];
      const start = match.index + match[0].lastIndexOf(target);
      add(target, message, messageIndex, start, start + target.length, 'tab');
      explicitSpans.push([start, start + target.length]);
    }
    const explicitCovered = mergedSpans(explicitSpans);
    const spacedSpans = [];
    for (const match of text.matchAll(SPACED_PATH)) {
      const start = match.index + match[1].length;
      const end = start + match[2].length;
      if (!overlapsSpans(explicitCovered, start, end) && localPath(match[2], cwd)) {
        add(match[2], message, messageIndex, start, end, 'plain');
        spacedSpans.push([start, end]);
      }
    }
    const covered = mergedSpans([...explicitSpans, ...spacedSpans]);
    for (const match of text.matchAll(PLAIN_PATH)) {
      const start = match.index + match[1].length;
      if (!overlapsSpans(covered, start, start + match[2].length)) add(match[2], message, messageIndex, start, start + match[2].length, 'plain');
    }
    for (const match of text.matchAll(BARE_FILE)) {
      const start = match.index + match[1].length;
      if (!overlapsSpans(covered, start, start + match[2].length)) add(match[2], message, messageIndex, start, start + match[2].length, 'bare');
    }
  });

  const selected = [...candidates.values()].sort(compareCandidate);
  if (selected.length > limit) omitted = true;
  const files = await Promise.all(selected.slice(0, limit).map(async ({ path, line, evidence }) => ({
    path,
    ...(line ? { line } : {}),
    status: await fileStatus(path),
    evidence,
  })));
  return { files, omitted };
}
