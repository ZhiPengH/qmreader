const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `Missing source section: ${start}`);
  return source.slice(from, to);
}

function harness(stubs = {}) {
  const opens = [];
  const hints = [];
  const context = {
    state: { view: 'all', filterSource: null, activeEntry: null, entries: [], readerTab: 'original' },
    $: () => ({ classList: { add() {}, remove() {} } }),
    document: { getElementById: () => ({ classList: { add() {}, remove() {} } }) },
    setWorkspacePage() {}, clearReaderUrl() {}, renderAgent() {},
    updateListTitle() {}, renderList() {}, renderSidebar() {},
    loadContributors: async () => {},
    loadEntries: stubs.loadEntries || (async () => {}),
    visibleEntries: stubs.visibleEntries || (() => context.state.entries),
    openEntry: stubs.openEntry || (async entry => { opens.push(entry); }),
    hintSourceRefresh: (id, reason) => hints.push([id, reason]),
  };
  vm.createContext(context);
  vm.runInContext([
    between('async function reload(', 'async function selectSource(id)'),
    between('async function selectSource(id)', 'function selectCategory('),
  ].join('\n'), context);
  return { context, opens, hints };
}

test('selecting a source auto-opens the newest entry after the list loads', async () => {
  const { context: c, opens, hints } = harness({
    loadEntries: async () => { c.state.entries = [{ id: 'newest', sourceId: 's1' }, { id: 'older', sourceId: 's1' }]; },
  });
  await c.selectSource('s1');
  assert.equal(c.state.filterSource, 's1');
  assert.deepEqual(hints, [['s1', 'source-select']]);
  assert.equal(opens.length, 1);
  assert.equal(opens[0].id, 'newest');
});

test('deselecting the active source keeps the list-only behaviour', async () => {
  const { context: c, opens, hints } = harness();
  c.state.filterSource = 's1';
  await c.selectSource('s1');
  assert.equal(c.state.filterSource, null);
  assert.equal(opens.length, 0);
  assert.equal(hints.length, 0);
});

test('a source without entries opens nothing', async () => {
  const { context: c, opens } = harness();
  await c.selectSource('empty');
  assert.equal(c.state.filterSource, 'empty');
  assert.equal(opens.length, 0);
});

test('a slow list load does not open a stale source article after switching', async () => {
  let release;
  const { context: c, opens } = harness({
    loadEntries: async () => { await new Promise(resolve => { release = resolve; }); c.state.entries = [{ id: 's1-first', sourceId: 's1' }]; },
  });
  const pending = c.selectSource('s1');
  c.state.filterSource = 's2'; // 加载期间用户已切到别的源
  release();
  await pending;
  assert.equal(opens.length, 0);
});

test('a manual open during load is overwritten by reload (pre-existing behaviour), auto-open still runs', async () => {
  // reload() 清空 activeEntry 是既有行为：加载期间手动点开的文章也会被抹掉。
  // 该竞态由 openEntry 内部的 user-moved-on 守卫兜底，不在本改动修。
  const { context: c, opens } = harness({
    loadEntries: async () => { c.state.entries = [{ id: 'newest', sourceId: 's1' }]; },
  });
  await c.selectSource('s1');
  assert.equal(c.state.activeEntry, null); // reload 抹掉了手动打开（既有行为）
  assert.equal(opens.length, 1);
});
