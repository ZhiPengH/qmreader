const crypto = require('node:crypto');
const sax = require('sax');
const { SOURCES, RSSHUB_INSTANCES } = require('./sources');
const store = require('./store');

function invalid(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
function getSources() {
  const overrides = new Map(store.getSourceOverrides().map(item => [item.id, item]));
  const sources = SOURCES.map(source => ({ ...source, builtin: true, deleted: false, ...overrides.get(source.id) }));
  for (const item of overrides.values()) {
    if (!SOURCES.some(source => source.id === item.id)) sources.push({ ...item, builtin: false });
  }
  return sources;
}
function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) throw invalid('请输入有效的 RSS URL');
  let url;
  try { url = new URL(value.trim()); } catch { throw invalid('URL 格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid('仅支持不含账号密码的 HTTP(S) URL');
  url.hash = '';
  return url.href;
}
function textField(value, label, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw invalid(`${label}格式无效或过长`);
  return value.trim();
}

const RSSHUB_HOSTS = new Set(RSSHUB_INSTANCES.map(base => {
  try { return new URL(base).host; } catch { return ''; }
}).filter(Boolean));

function canonicalizeFeedUrl(url) {
  const value = String(url || '');
  if (value.startsWith('{rsshub}')) return value;
  try {
    const parsed = new URL(value);
    if (RSSHUB_HOSTS.has(parsed.host)) return `{rsshub}${parsed.pathname}${parsed.search}`;
  } catch { /* keep raw */ }
  return value;
}

function expandRsshub(url) {
  const value = String(url || '');
  if (!value.startsWith('{rsshub}')) return [value];
  const suffix = value.slice('{rsshub}'.length) || '/';
  return RSSHUB_INSTANCES.map(base => `${base}${suffix}`);
}

function feedCandidate(url) {
  const value = String(url || '').trim();
  if (value.startsWith('{rsshub}')) {
    const suffix = value.slice('{rsshub}'.length);
    if (!/^\//.test(suffix) || /\s/.test(value) || value.length > 4096) throw invalid('RSSHub 地址格式无效');
    return value;
  }
  return canonicalizeFeedUrl(normalizeUrl(value));
}
async function validate(input, existing, checkUrl) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('订阅内容格式无效');
  const out = {};
  if ('name' in input || !existing) out.name = textField(input.name, '名称', 120, true);
  if ('category' in input || !existing) {
    const canonicalLabels = { '文章': 'article', '资讯': 'news', '播客': 'podcast' };
    const provided = input.category === undefined || input.category === null ? 'article' : input.category;
    const raw = String(provided).trim();
    out.category = canonicalLabels[raw] || raw;
    if (!out.category || out.category.length > 24 || /[<>"'&]/.test(out.category)) throw invalid('分类格式无效或过长（最多 24 个字符）');
  }
  if ('description' in input) out.description = textField(input.description, '描述', 2000);
  if ('siteUrl' in input) out.siteUrl = input.siteUrl === '' ? '' : normalizeUrl(input.siteUrl);
  for (const key of ['enabled', 'deleted', 'pinned']) {
    if (key in input) {
      if (typeof input[key] !== 'boolean') throw invalid(`${key} 须为布尔值`);
      out[key] = input[key];
    }
  }
  if ('feeds' in input || !existing) {
    if (!Array.isArray(input.feeds) || input.feeds.length > 20) throw invalid('每个订阅须有 1 至 20 个 RSS URL');
    // Metadata edits may round-trip existing adapters without rewriting their configuration.
    if (!existing || JSON.stringify(input.feeds) !== JSON.stringify(existing.feeds)) {
      if (!input.feeds.length) throw invalid('每个订阅须有 1 至 20 个 RSS URL');
      out.feeds = [...new Set(input.feeds.map(feedCandidate))];
      for (const url of out.feeds) {
        const candidates = expandRsshub(url);
        let lastError = null;
        let reachable = false;
        for (const candidate of candidates) {
          try { await checkUrl(candidate, { deadline: Date.now() + 5000 }); reachable = true; break; }
          catch (error) { lastError = error; }
        }
        if (!reachable) throw invalid(`RSS 地址不可用或不是公网地址${candidates.length > 1 ? `（已尝试 ${candidates.length} 个 RSSHub 实例）` : ''}：${lastError ? lastError.message : '未知错误'}`);
      }
      out.userFeeds = true;
    }
  }
  return out;
}
function duplicate(feeds, id) {
  const candidates = new Set(feeds.map(url => { try { return feedCandidate(url); } catch { return url; } }));
  return getSources().find(source => source.id !== id && (source.feeds || []).some(url => {
    try { return candidates.has(feedCandidate(url)); } catch { return candidates.has(url); }
  }));
}
const defaultCheck = (...args) => require('./fetcher').assertPublicHttpUrl(...args);
async function createSource(input, { checkUrl = defaultCheck } = {}) {
  const fields = await validate(input, null, checkUrl);
  if (duplicate(fields.feeds)) throw invalid('RSS 地址已存在（包括已移除订阅，可恢复）', 409);
  const source = { id: `rss-${crypto.randomUUID()}`, name: '', category: 'article', siteUrl: '', description: '', enabled: true, deleted: false, limit: 20, createdAt: Date.now(), ...fields };
  store.saveSourceOverride(source.id, source);
  return getSources().find(item => item.id === source.id);
}
async function updateSource(id, input, { checkUrl = defaultCheck } = {}) {
  const existing = getSources().find(source => source.id === id);
  if (!existing) throw invalid('订阅不存在', 404);
  if (existing.manual) throw invalid('手动投稿不是 RSS 订阅，不能在这里修改', 400);
  const fields = await validate(input, existing, checkUrl);
  if (fields.feeds && duplicate(fields.feeds, id)) throw invalid('RSS 地址已存在', 409);
  // Keep only overrides for built-ins, preserving future built-in adapter updates.
  const previous = store.getSourceOverrides().find(item => item.id === id) || {};
  store.saveSourceOverride(id, { ...previous, ...fields });
  return getSources().find(source => source.id === id);
}
function parseImport(format, content) {
  if (typeof content !== 'string' || !content.trim()) throw invalid('导入内容不能为空');
  if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) throw invalid('导入内容不能超过 1 MB');
  let items = [];
  if (format === 'urls') items = content.split(/\r?\n/).map(url => url.trim()).filter(Boolean).map(url => ({ url }));
  else if (format === 'opml') {
    if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw invalid('OPML 不允许 DTD 或实体声明');
    let root = '';
    const parser = sax.parser(true, { trim: true });
    parser.onopentag = node => {
      if (!root) root = node.name.toLowerCase();
      if (node.name.toLowerCase() !== 'outline') return;
      const attr = Object.fromEntries(Object.entries(node.attributes).map(([key, value]) => [key.toLowerCase(), value]));
      if ('xmlurl' in attr || String(attr.type).toLowerCase() === 'rss') items.push({ url: attr.xmlurl || '', name: attr.title || attr.text || '', siteUrl: attr.htmlurl || '' });
      if (items.length > 200) throw invalid('每次最多导入 200 个订阅');
    };
    try { parser.write(content).close(); } catch (error) { throw invalid(`OPML 格式无效：${error.message}`); }
    if (root !== 'opml') throw invalid('文件不是 OPML');
  } else throw invalid('导入格式须为 opml 或 urls');
  if (!items.length) throw invalid('没有找到 RSS 订阅地址');
  if (items.length > 200) throw invalid('每次最多导入 200 个订阅');
  return items;
}
async function importSources(input, options = {}) {
  const items = parseImport(input && input.format, input && input.content);
  const results = new Array(items.length);
  // Duplicate URLs share one attempt. Results retain input order, while unrelated
  // DNS checks progress independently, at no more than six concurrent requests.
  const attempts = new Map();
  let next = 0;
  async function addItem(item, url) {
    if (duplicate([url])) return { ...item, status: 'skipped', message: 'RSS 地址已存在（含已移除订阅）' };
    let fallbackSiteUrl = item.siteUrl;
    if (!fallbackSiteUrl) { try { fallbackSiteUrl = new URL(url).origin; } catch { fallbackSiteUrl = ''; } }
    const source = await createSource({ name: item.name || new URL(url).hostname, feeds: [url], category: 'article', ...(fallbackSiteUrl ? { siteUrl: fallbackSiteUrl } : {}) }, options);
    return { name: source.name, url, id: source.id, status: 'added', autoNamed: !item.name };
  }
  async function worker() {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      try {
        const url = normalizeUrl(item.url);
        if (attempts.has(url)) {
          const original = await attempts.get(url);
          results[index] = { ...item, url, status: original.status === 'failed' ? 'failed' : 'skipped', message: original.status === 'failed' ? original.message : 'RSS 地址重复' };
          continue;
        }
        const attempt = addItem(item, url).catch(error => ({ ...item, status: error.statusCode === 409 ? 'skipped' : 'failed', message: error.message }));
        attempts.set(url, attempt);
        results[index] = await attempt;
      } catch (error) { results[index] = { ...item, status: 'failed', message: error.message }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, items.length) }, worker));
  return { added: results.filter(item => item.status === 'added').length, skipped: results.filter(item => item.status === 'skipped').length, failed: results.filter(item => item.status === 'failed').length, results };
}

function purgeDeletedSources() {
  return store.purgeDeletedSources();
}

module.exports = { getSources, normalizeUrl, canonicalizeFeedUrl, expandRsshub, feedCandidate, createSource, updateSource, parseImport, importSources, purgeDeletedSources };
