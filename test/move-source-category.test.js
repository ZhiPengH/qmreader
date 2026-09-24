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

function harness({ source, patchResult } = {}) {
  const calls = { api: [], toasts: [], reloads: 0 };
  const context = {
    CATEGORY_LABELS: { article: '文章', news: '资讯', podcast: '播客' },
    knownCategories: () => ['article', 'news', 'podcast', '快讯'],
    categoryLabel: cat => ({ article: '文章', news: '资讯', podcast: '播客' }[cat] || cat),
    sourceById: () => source,
    api: async (url, options) => { calls.api.push({ url, options }); if (patchResult instanceof Error) throw patchResult; return patchResult; },
    renderSidebar() {}, renderList() {}, updateListTitle() {},
    toast: msg => calls.toasts.push(msg),
    location: { reload: () => { calls.reloads += 1; } },
    Object,
  };
  vm.createContext(context);
  vm.runInContext(between('async function moveSourceCategory(', 'function pinnedSourceIds('), context);
  return { context, calls };
}

test('moving to a custom group is accepted and reloads the page', async () => {
  const { context, calls } = harness({
    source: { id: 's1', category: 'article' },
    patchResult: { source: { id: 's1', category: '快讯' } },
  });
  await context.moveSourceCategory('s1', '快讯');
  assert.equal(calls.api.length, 1);
  assert.equal(JSON.parse(calls.api[0].options.body).category, '快讯');
  assert.equal(calls.reloads, 1); // 用户要求：移动后自动刷新页面
});

test('built-in groups still move and reload', async () => {
  const { context, calls } = harness({
    source: { id: 's1', category: 'article' },
    patchResult: { source: { id: 's1', category: 'news' } },
  });
  await context.moveSourceCategory('s1', 'news');
  assert.equal(calls.api.length, 1);
  assert.equal(calls.reloads, 1);
});

test('same category and unknown ids are still no-ops', async () => {
  const same = harness({ source: { id: 's1', category: 'news' }, patchResult: null });
  await same.context.moveSourceCategory('s1', 'news');
  assert.equal(same.calls.api.length, 0);
  const unknown = harness({ source: null, patchResult: null });
  await unknown.context.moveSourceCategory('ghost', 'news');
  assert.equal(unknown.calls.api.length, 0);
});

test('a category outside knownCategories is rejected without reload', async () => {
  const { context, calls } = harness({
    source: { id: 's1', category: 'article' },
    patchResult: { source: { id: 's1', category: 'evil' } },
  });
  await context.moveSourceCategory('s1', 'evil<script>');
  assert.equal(calls.api.length, 0);
  assert.equal(calls.reloads, 0);
});

test('patch failure toasts and does not reload', async () => {
  const { context, calls } = harness({
    source: { id: 's1', category: 'article' },
    patchResult: new Error('boom'),
  });
  await context.moveSourceCategory('s1', '快讯');
  assert.equal(calls.api.length, 1);
  assert.match(calls.toasts[0], /移动失败/);
  assert.equal(calls.reloads, 0);
});
