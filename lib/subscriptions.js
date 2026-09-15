const crypto = require('node:crypto');
const sax = require('sax');
const { SOURCES } = require('./sources');
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
async function validate(input, existing, checkUrl) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('订阅内容格式无效');
  const out = {};
  if ('name' in input || !existing) out.name = textField(input.name, '名称', 120, true);
  if ('category' in input || !existing) {
    out.category = input.category || 'article';
    if (!['article', 'news', 'podcast'].includes(out.category)) throw invalid('分类须为 article、news 或 podcast');
  }
  if ('description' in input) out.description = textField(input.description, '描述', 2000);
  if ('siteUrl' in input) out.siteUrl = input.siteUrl === '' ? '' : normalizeUrl(input.siteUrl);
  for (const key of ['enabled', 'deleted']) {
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
      out.feeds = [...new Set(input.feeds.map(normalizeUrl))];
      for (const url of out.feeds) {
        try { await checkUrl(url, { deadline: Date.now() + 5000 }); }
        catch (error) { throw invalid(`RSS 地址不可用或不是公网地址：${error.message}`); }
      }
      out.userFeeds = true;
    }
  }
  return out;
}
function duplicate(feeds, id) {
  const candidates = new Set(feeds.map(url => { try { return normalizeUrl(url); } catch { return url; } }));
  return getSources().find(source => source.id !== id && (source.feeds || []).some(url => {
    try { return candidates.has(normalizeUrl(url)); } catch { return candidates.has(url); }
  }));
}
const defaultCheck = (...args) => require('./fetcher').assertPublicHttpUrl(...args);
async function createSource(input, { checkUrl = defaultCheck } = {}) {
  const fields = await validate(input, null, checkUrl);
  if (duplicate(fields.feeds)) throw invalid('RSS 地址已存在（包括已移除订阅，可恢复）', 409);
  const source = { id: `rss-${crypto.randomUUID()}`, name: '', category: 'article', siteUrl: '', description: '', enabled: true, deleted: false, limit: 20, ...fields };
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
    const source = await createSource({ name: item.name || new URL(url).hostname, feeds: [url], category: 'article', ...(item.siteUrl ? { siteUrl: item.siteUrl } : {}) }, options);
    return { name: source.name, url, id: source.id, status: 'added' };
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

module.exports = { getSources, normalizeUrl, createSource, updateSource, parseImport, importSources };
