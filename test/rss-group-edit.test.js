const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../public/app.js'), 'utf8');

function harness() {
  const nodes = new Map();
  const calls = [];
  const store = new Map();
  const makeNode = () => ({
    value: '', textContent: '', innerHTML: '', files: [],
    dataset: {},
    isConnected: true,
    setAttribute(name, value) { this[name] = value; },
    classList: { add() {}, remove() {}, toggle() {} },
    reset() { this.didReset = true; },
    focus() { this.didFocus = true; },
    select() {},
    insertBefore() {}, remove() { this.didRemove = true; },
    replaceWith() { this.didReplace = true; },
    querySelector() { return makeNode(); },
  });
  const context = {
    state: { me: { id: 'personal' }, rssSources: [], sources: [], rssBusy: false },
    $: selector => {
      if (!nodes.has(selector)) nodes.set(selector, makeNode());
      return nodes.get(selector);
    },
    $$: () => [],
    navigator: {},
    setTimeout: () => 0,
    CSS: { escape: value => String(value) },
    document: { createElement: () => makeNode() },
    escapeHtml: value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    iconMarkup: icon => `<i>${icon}</i>`,
    api: async (url, options) => { calls.push({ url, options }); return { sources: [] }; },
    loadSources: async () => {}, loadEntries: async () => {}, loadRssSources: async () => {},
    renderSidebar() {}, renderRssGroups() {}, updateListTitle() {}, renderList() {},
    requirePersonalIdentity: () => true, confirm: () => true,
    toast: message => { context.__toasts.push(String(message)); },
    setRssBusy() {}, refreshAfterRssMutation: async () => {},
    storage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    categoryLabel: label => label, knownCategories: () => ['article', 'news', 'podcast'],
    customRssGroups: () => [], persistCustomRssGroups() {},
    CATEGORY_LABELS: { article: '文章', news: '资讯', podcast: '播客' }, TextEncoder,
    __toasts: [],
  };
  vm.createContext(context);
  const start = source.indexOf('const quickSub =');
  const end = source.indexOf('function renderDashboardTabs()');
  vm.runInContext(source.slice(start, end), context);
  return { context, nodes, calls, store };
}

test('quick subscribe modal refreshes category options from current groups on open', () => {
  const { context: c } = harness();
  c.persistCustomRssGroups(['AI 前沿']);
  c.openSubmitLinkModal();
  const html = c.$('#submit-link-category').innerHTML;
  assert.ok(html.includes('AI 前沿'), 'custom group should appear in quick subscribe dropdown');
  assert.ok(html.includes('文章'), 'built-in groups should remain');
});

test('group rename commits member sources to server and persists the renamed group', async () => {
  const { context: c, calls } = harness();
  c.persistCustomRssGroups(['AI 前沿']);
  c.state.rssSources = [
    { id: 's1', name: '源一', category: 'AI 前沿', feeds: ['https://a.example/rss'] },
    { id: 's2', name: '源二', category: 'AI 前沿', feeds: ['https://b.example/rss'] },
  ];
  c.state.rssCategoryFilter = 'AI 前沿';
  c.beginRssGroupRename({ dataset: { group: 'AI 前沿' }, isConnected: true, replaceWith() {} });
  assert.equal(c.state.rssGroupRename.group, 'AI 前沿', 'rename state should track the group');
  const ok = await c.commitRssGroupRename('AI 观察');
  assert.equal(ok, true);
  const patches = calls.filter(call => call.options?.method === 'PATCH');
  assert.equal(patches.length, 2, 'both member sources should be re-categorized');
  assert.ok(patches.every(p => JSON.parse(p.options.body).category === 'AI 观察'));
  const groups = c.customRssGroups();
  assert.ok(groups.includes('AI 观察') && !groups.includes('AI 前沿'), 'local group list should be renamed');
  assert.equal(c.state.rssCategoryFilter, 'AI 观察', 'active filter should follow the rename');
});

test('rename to a blank or duplicate name is rejected without server calls', async () => {
  const { context: c, calls } = harness();
  c.persistCustomRssGroups(['AI 前沿', '思考']);
  c.state.rssSources = [{ id: 's1', name: '源一', category: 'AI 前沿', feeds: ['https://a.example/rss'] }];
  c.beginRssGroupRename({ dataset: { group: 'AI 前沿' }, isConnected: true, replaceWith() {} });
  assert.equal(await c.commitRssGroupRename('思考'), false);
  assert.equal(calls.length, 0, 'no server call for duplicate rename');
  assert.equal(await c.commitRssGroupRename('   '), false);
  assert.equal(calls.length, 0, 'no server call for blank rename');
  assert.ok(c.__toasts.some(t => t.includes('已存在')), 'duplicate should tell the user why');
});

test('built-in groups can be renamed into custom groups', async () => {
  const { context: c, calls } = harness();
  c.persistCustomRssGroups(['AI 前沿']);
  c.state.rssSources = [
    { id: 's1', name: '源一', category: 'article', feeds: ['https://a.example/rss'] },
    { id: 's2', name: '源二', category: 'article', feeds: ['https://b.example/rss'] },
  ];
  c.beginRssGroupRename({ dataset: { group: 'article' }, isConnected: true, replaceWith() {} });
  assert.equal(c.state.rssGroupRename?.group, 'article', 'built-in group should enter rename mode');
  assert.equal(await c.commitRssGroupRename('深度阅读'), true);
  const patches = calls.filter(call => call.options?.method === 'PATCH');
  assert.equal(patches.length, 2, 'member sources should be re-categorized');
  assert.ok(patches.every(p => JSON.parse(p.options.body).category === '深度阅读'));
  const groups = c.customRssGroups();
  assert.ok(groups.includes('深度阅读'), 'renamed built-in should be persisted as a custom group');
  assert.ok(groups.includes('AI 前沿'), 'existing custom groups are untouched');
});
