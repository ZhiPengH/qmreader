const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/app.js'), 'utf8');
function harness() {
  const nodes = new Map();
  const calls = [];
  const context = {
    state: { me: { id: 'personal' }, rssSources: [], sources: [], rssBusy: false },
    $: selector => {
      if (!nodes.has(selector)) nodes.set(selector, { value: '', textContent: '', innerHTML: '', files: [], setAttribute(name, value) { this[name] = value; }, classList: { add() {}, remove() {}, toggle() {} }, reset() { this.didReset = true; }, focus() {} });
      return nodes.get(selector);
    },
    $$: () => [],
    escapeHtml: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    api: async (url, options) => { calls.push({ url, options }); return { sources: [] }; },
    loadSources: async () => {}, loadEntries: async () => {}, renderSidebar() {}, updateListTitle() {}, renderList() {}, requirePersonalIdentity() {}, confirm: () => true,
    CATEGORY_LABELS: { article: '文章' }, TextEncoder,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function rssFeedsAreAdvanced('), source.indexOf('function renderDashboardTabs()')), context);
  return { context, nodes, calls };
}
const submit = { preventDefault() {} };
test('advanced built-in metadata edits omit feeds and preserve original config', async () => {
  const { context: c, calls } = harness();
  const item = { id: 'builtin', name: '内置', category: 'article', feeds: ['wpjson:https://example.org', '{rsshub}/example'] };
  c.state.rssSources = [item]; c.editRssSource(item);
  c.$('#rss-name').value = '新名称';
  await c.submitRssSource(submit);
  const request = calls.find(call => call.options?.method === 'PATCH');
  assert.equal(request.url, '/api/me/sources/builtin');
  assert.deepEqual(JSON.parse(request.options.body), { name: '新名称', category: 'article' });
  assert.equal(item.feeds[0], 'wpjson:https://example.org');
});
test('save failure preserves form draft and unlocks operation', async () => {
  const { context: c } = harness();
  c.$('#rss-name').value = 'My RSS'; c.$('#rss-category').value = 'article'; c.$('#rss-feeds').value = 'https://example.org/rss';
  c.api = async () => { throw Error('保存失败'); };
  await c.submitRssSource(submit);
  assert.equal(c.$('#rss-name').value, 'My RSS');
  assert.equal(c.$('#rss-source-form').didReset, undefined);
  assert.equal(c.state.rssBusy, false);
  assert.match(c.$('#rss-status').textContent, /保存失败/);
});
test('import report escapes untrusted source names, URLs and errors', () => {
  const { context: c } = harness();
  c.renderRssImportResult({ added: 0, failed: 1, results: [{ status: 'failed', name: '<img src=x onerror=alert(1)>', url: '<script>', message: '<iframe>' }] });
  const html = c.$('#rss-import-results').innerHTML;
  assert(!html.includes('<img')); assert(!html.includes('<script>')); assert(!html.includes('<iframe>'));
  assert(html.includes('&lt;img')); assert(html.includes('失败 1'));
});
test('oversized batch is rejected locally without API request', async () => {
  const { context: c, calls } = harness();
  c.$('#rss-import-format').value = 'urls'; c.$('#rss-import-urls').value = Array(201).fill('https://example.org/rss').join('\n');
  await c.submitRssImport(submit);
  assert.equal(calls.length, 0); assert.match(c.$('#rss-status').textContent, /200/);
});
test('cancelling deletion sends no request; confirmed deletion uses soft-delete endpoint', async () => {
  const { context: c, calls } = harness();
  c.state.rssSources = [{ id: 'rss-id', name: 'News' }];
  const event = { target: { closest: () => ({ dataset: { rssAction: 'delete', rssId: 'rss-id' } }) } };
  c.confirm = () => false; await c.handleRssAction(event); assert.equal(calls.length, 0);
  c.confirm = message => { assert.match(message, /收藏和阅读历史都会保留/); return true; };
  await c.handleRssAction(event);
  assert.equal(calls[0].options.method, 'DELETE'); assert.equal(calls[0].url, '/api/me/sources/rss-id');
});
test('disabled and deleted sources stay out of ordinary lists and counts, but remain in favorites and history', () => {
  const { context: c } = harness();
  c.state.sources = [{ id: 'on', enabled: true, name: '新名称' }, { id: 'off', enabled: false }];
  c.state.entries = [{ id: 'a', sourceId: 'on', sourceName: '旧名称' }, { id: 'b', sourceId: 'off' }, { id: 'c', sourceId: 'deleted', sourceName: '已删源' }];
  c.state.read = new Set(); c.state.starred = new Set(['b', 'c']); c.state.history = new Map([['b', 1], ['c', 2]]);
  c.entryQualityScore = () => 1;
  function section(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
  vm.runInContext([
    section('function isEntrySourceEnabled(', 'function mergeEntryStats('),
    section('function unreadCountFor(', 'function renderSidebar('),
    section('function sourceNameForEntry(', 'function assetSearchText('),
    section('function visibleEntries(', 'function entryAssetItems('),
  ].join('\n'), c);
  c.state.view = 'all'; assert.deepEqual(Array.from(c.visibleEntries(), entry => entry.id), ['a']);
  c.state.view = 'unread'; assert.equal(c.visibleEntries().length, 1); assert.equal(c.unreadCountFor(() => true), 1); assert.equal(c.hotEntryCount(), 1);
  c.state.view = 'starred'; assert.deepEqual(Array.from(c.visibleEntries(), entry => entry.id), ['b', 'c']);
  c.state.view = 'history'; assert.deepEqual(Array.from(c.visibleEntries(), entry => entry.id), ['c', 'b']);
  assert.equal(c.sourceNameForEntry(c.state.entries[0]), '新名称'); assert.equal(c.sourceNameForEntry(c.state.entries[2]), '已删源');
});
test('pending subscription displays saved but awaiting fetch; refresh failure is not reported as full success', async () => {
  const { context: c } = harness();
  assert.match(c.rssFetchStatus({ enabled: true, status: 'pending', fetchedAt: 0 }), /等待首次抓取/);
  c.api = async () => { throw Error('network'); };
  await c.mutateRssSource(async () => ({}), '订阅源已保存');
  assert.match(c.$('#rss-status').textContent, /操作已保存，但刷新失败/);
});

test('advanced RSS configuration can be explicitly replaced and cancelling resets that choice', async () => {
  const { context: c, calls } = harness();
  const item = { id: 'builtin-rss', name: 'RSS', category: 'article', feeds: ['https://example.org/feed', '{rsshub}/example', 'wpjson:https://example.org'] };
  c.state.rssSources = [item]; c.editRssSource(item);
  assert.equal(c.$('#rss-feeds').readOnly, true);
  c.useStandardRssFeeds();
  assert.equal(c.$('#rss-feeds').readOnly, false);
  assert.equal(c.$('#rss-feeds').value, 'https://example.org/feed');
  c.$('#rss-feeds').value = 'https://example.org/replacement';
  await c.submitRssSource(submit);
  const request = calls.find(call => call.options?.method === 'PATCH');
  assert.deepEqual(JSON.parse(request.options.body).feeds, ['https://example.org/replacement']);
  c.state.rssSources = [item]; c.editRssSource(item); c.useStandardRssFeeds(); c.resetRssEditor();
  assert.equal(c.state.rssReplaceAdvanced, false);
  c.editRssSource(item); assert.equal(c.state.rssReplaceAdvanced, false); assert.equal(c.$('#rss-feeds').readOnly, true);
});

test('article freshness uses publication date and strict 15/30 day thresholds', () => {
  const { context: c } = harness();
  const now = Date.parse('2026-09-15T00:00:00Z');
  for (const [days, expected] of [[0, ''], [15, ''], [16, 'aging'], [30, 'aging'], [31, 'stale'], [-1, '']]) {
    assert.equal(c.rssArticleAge({ latestArticle: { published: new Date(now - days * 86400000).toISOString() }, fetchedAt: now }, now), expected);
  }
  assert.equal(c.rssArticleAge({}, now), '');
  assert.equal(c.rssArticleAge({ latestArticle: { published: 'invalid' } }, now), '');
});
test('latest article escapes titles and handles empty or undated feeds', () => {
  const { context: c } = harness();
  assert.match(c.rssLatestArticleHtml({}), /暂无已抓取文章/);
  const html = c.rssLatestArticleHtml({ latestArticle: { title: '<img onerror=bad>', published: null } });
  assert(!html.includes('<img'));
  assert.match(html, /发布日期未知/);
});

test('inactive toggle filters dated sources and sorts oldest first without altering registry order', () => {
  const { context: c } = harness();
  const now = Date.parse('2026-09-15T00:00:00Z');
  const items = [16, 2, 60, 31, 15].map(days => ({ id: String(days), latestArticle: { published: new Date(now - days * 86400000).toISOString() } }));
  items.push({ id: 'unknown' }, { id: 'deleted', deleted: true, latestArticle: items[2].latestArticle });
  assert.deepEqual(Array.from(c.visibleRssSources(items, true, now), s => s.id), ['60', '31', '16']);
  assert.deepEqual(Array.from(c.visibleRssSources(items, false, now), s => s.id), ['16','2','60','31','15','unknown']);
  c.toggleInactiveRssSources(); assert.equal(c.state.rssInactiveOnly, true);
  c.toggleInactiveRssSources(); assert.equal(c.state.rssInactiveOnly, false);
});
test('article summary truncates to ten unicode characters with date first', () => {
  const { context: c } = harness();
  const html = c.rssLatestArticleHtml({latestArticle:{title:'一二三四五六七八九十十一',published:'2026-08-24'}});
  assert.match(html, /<\/time>：一二三四五六七八九十\.\.\./);
  assert(!html.includes('最新文章'));
  assert(!c.rssLatestArticleHtml({latestArticle:{title:'短标题'}}).includes('...'));
});

test('subscription articles default to original even with rewrite preference, explicit tabs still work', () => {
  const c = { state: { filterSource: 'rss-test' }, currentDefaultReaderTab: () => 'rewrite', normalizeReaderTab: tab => tab };
  vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('function normalizeReaderOpenTab('), source.indexOf('function setCurrentUser(')), c);
  assert.equal(c.normalizeReaderOpenTab(null), 'original');
  assert.equal(c.normalizeReaderOpenTab(''), 'original');
  assert.equal(c.normalizeReaderOpenTab('rewrite'), 'rewrite');
  c.state.filterSource = 'another-source';
  assert.equal(c.normalizeReaderOpenTab(undefined), 'original');
  c.state.filterSource = null;
  assert.equal(c.normalizeReaderOpenTab(null), 'rewrite');
});
