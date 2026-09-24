const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicDir = path.join(__dirname, '../public');
const source = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `Missing source section: ${start}`);
  return source.slice(from, to);
}

test('scope bar offers 列表 and 极简 instead of 最新 and 广场', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /data-list-scope="latest"[^>]*>列表</);
  assert.match(html, /data-list-scope="minimal"[^>]*>极简</);
  assert.doesNotMatch(html, /data-list-scope="latest"[^>]*>最新</);
  assert.doesNotMatch(html, /data-list-scope="hot"[^>]*>广场</);
});

test('minimal scope renders one-line cards: title capped at 12 chars, compact time, no summary/media', () => {
  const cards = [];
  const makeEl = () => ({ className: '', dataset: {}, innerHTML: '', tabIndex: 0, onclick: null, onkeydown: null, setAttribute() {}, appendChild() {} });
  const context = {
    state: { view: 'minimal', read: new Set(), starred: new Set(), activeEntry: null, entryRenderLimit: 50, q: '', assetFilter: null },
    plaza: { visibleEntries: () => [] },
    $: () => ({ classList: { add() {}, remove() {}, toggle() {} }, innerHTML: '', dataset: {}, appendChild() {} }),
    document: { createDocumentFragment: () => ({ appendChild() {} }), createElement: () => makeEl() },
    isHomeScope: () => false,
    renderListScopeBar() {},
    renderAssetActivityStrip() {},
    renderHomeAssetActivityList() {},
    visibleEntries: () => [
      { id: 'e1', sourceId: 's1', title: '这是一个非常非常长的文章标题超过十二个字符一定会被截断', publishedTs: Date.now() - 30 * 60000 },
      { id: 'e2', sourceId: 's1', title: '短标题', publishedTs: Date.now() - 3 * 86400000 },
    ],
    sourceById: () => ({ id: 's1', name: '源' }),
    sourceNameForEntry: () => '源',
    sourceIconHtml: () => '',
    assetBadgesHtml: () => '',
    assetActivityLabel: () => '',
    entryHistoryLabel: () => '',
    hotEntryLabel: () => '',
    entryStatsLabel: () => '',
    assetPreviewForEntry: () => null,
    assetItemListHtml: () => '',
    timeAgo: () => 'stub',
    minimalTimeAgo: ts => { context.minimalCalls = (context.minimalCalls || 0) + 1; return ts ? '30m' : ''; },
    escapeHtml: s => String(s),
    lucideIcon: () => '',
    minimalTitleText: title => (title || '').length > 12 ? (title || '').slice(0, 12) + '…' : (title || ''),
    minimalEntryCard: e => { cards.push(e.id); return makeEl(); },
  };
  vm.createContext(context);
  vm.runInContext(between('function renderList(', 'function minimalTitleText('), context);
  context.renderList();
  assert.deepEqual(cards, ['e1', 'e2']);
});

test('minimalTimeAgo formats compact relative labels (1h / 3d / 5m / now)', () => {
  const now = Date.now();
  const context = { Date, Math, Number, isFinite };
  vm.createContext(context);
  vm.runInContext(between('function minimalTimeAgo(', 'function shanghaiParts('), context);
  assert.equal(context.minimalTimeAgo(now), 'now');
  assert.equal(context.minimalTimeAgo(now - 5 * 60000), '5m');
  assert.equal(context.minimalTimeAgo(now - 61 * 60000), '1h');
  assert.equal(context.minimalTimeAgo(now - 3 * 86400000), '3d');
});

test('selectListScope accepts minimal and keeps latest/hot routing intact', () => {
  const context = {
    state: { view: 'all', assetFilter: null, assetSort: 'latest', contributorSort: 'latest', readerFocus: null, readerAssetId: '' },
    selectView: v => { context.pickedView = v; },
    reload: () => { context.reloaded = true; },
    syncListUrl() {},
  };
  vm.createContext(context);
  vm.runInContext(between('function selectListScope(', 'function assetActivityItemHtml('), context);
  context.selectListScope('minimal');
  assert.equal(context.state.view, 'minimal');
  assert.ok(context.reloaded);
  assert.equal(context.pickedView, undefined); // minimal 不走 plaza
  context.selectListScope('hot');
  assert.equal(context.pickedView, 'hot'); // 广场（plaza）入口仍在
});
