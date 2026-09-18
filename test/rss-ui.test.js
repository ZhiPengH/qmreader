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
    iconMarkup: icon => `<i>${icon}</i>`,
    api: async (url, options) => { calls.push({ url, options }); return { sources: [] }; },
    loadSources: async () => {}, loadEntries: async () => {}, loadRssSources: async () => {}, renderSidebar() {}, renderRssGroups() {}, updateListTitle() {}, renderList() {}, requirePersonalIdentity() {}, confirm: () => true,
    toast: () => {}, setRssBusy() {}, refreshAfterRssMutation: async () => {},
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    categoryLabel: label => label, knownCategories: () => ['article', 'news', 'podcast'], customRssGroups: () => [], persistCustomRssGroups() {},
    CATEGORY_LABELS: { article: '文章', news: '资讯', podcast: '播客' }, TextEncoder,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function rssFeedsAreAdvanced('), source.indexOf('function renderDashboardTabs()')), context);
  return { context, nodes, calls };
}
const submit = { preventDefault() {} };
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

test('edit modal PATCHes metadata only for advanced sources', async () => {
  const { context: c, calls } = harness();
  const item = { id: 'adv', name: '高级源', category: 'article', feeds: ['wpjson:https://example.org'] };
  c.state.rssSources = [item];
  c.openRssEditModal('adv');
  c.$('#rss-edit-name').value = '改名';
  c.$('#rss-edit-category').value = 'article';
  c.$('#rss-edit-site').value = 'https://example.com';
  await c.submitRssEdit(submit);
  const request = calls.find(call => call.options?.method === 'PATCH');
  assert.deepEqual(JSON.parse(request.options.body), { name: '改名', category: 'article', siteUrl: 'https://example.com' });
  assert.equal('feeds' in JSON.parse(request.options.body), false);
});
test('edit modal sends feeds for standard sources and rejects empty', async () => {
  const { context: c, calls } = harness();
  const item = { id: 'std', name: '标准源', category: 'article', feeds: ['https://example.org/feed'] };
  c.state.rssSources = [item];
  c.openRssEditModal('std');
  c.$('#rss-edit-name').value = '标准源';
  c.$('#rss-edit-category').value = 'article';
  c.$('#rss-edit-site').value = '';
  c.$('#rss-edit-feeds').value = '';
  await c.submitRssEdit(submit);
  assert.equal(calls.length, 0);
  assert.match(c.$('#rss-edit-status').textContent, /RSS 地址/);
  c.$('#rss-edit-feeds').value = 'https://example.org/feed\nhttps://example.org/feed2';
  await c.submitRssEdit(submit);
  const request = calls.find(call => call.options?.method === 'PATCH');
  assert.deepEqual(JSON.parse(request.options.body).feeds, ['https://example.org/feed', 'https://example.org/feed2']);
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
