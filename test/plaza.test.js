const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function plaza() {
  const file = path.join(__dirname, '..', 'lib', 'plaza.js');
  assert.ok(fs.existsSync(file), '广场需要独立的完整文章池排序逻辑');
  return require(file);
}

function entry(id, overrides = {}) {
  return { id, sourceId: 'source', publishedTs: 0, createdAt: 1, read: false, reactionByMe: '', tags: [], ...overrides };
}

test('全部按发布时间排序，缺失发布时间才以入库时间兜底，不改变输入数组', () => {
  const rows = [
    entry('old', { publishedTs: 100, createdAt: 5000 }),
    entry('published-new', { publishedTs: 300, createdAt: 1 }),
    entry('ingested-new', { createdAt: 200 }),
  ];
  const original = structuredClone(rows);
  assert.deepEqual(plaza().rankPlazaEntries(rows).map(row => row.id), ['published-new', 'ingested-new', 'old']);
  assert.deepEqual(rows, original);
});

test('全部的仅未读筛选保留未读负反馈文章，不把负反馈误当删除', () => {
  const rows = [entry('read', { read: true }), entry('unread'), entry('ignored', { reactionByMe: 'dislike' })];
  assert.deepEqual(new Set(plaza().rankPlazaEntries(rows, { unreadOnly: true }).map(row => row.id)), new Set(['unread', 'ignored']));
});

test('全部的最早排序只改变时间方向，发布时间相同仍有稳定次序', () => {
  const rows = [entry('new', { publishedTs: 20 }), entry('old-b', { publishedTs: 10 }), entry('old-a', { publishedTs: 10 })];
  assert.deepEqual(plaza().rankPlazaEntries(rows, { sort: 'oldest' }).map(row => row.id), ['old-a', 'old-b', 'new']);
});

test('随便看看排除负反馈并优先未读，同一 seed 不受查询输入顺序影响', () => {
  const rows = Array.from({ length: 24 }, (_, i) => entry('item-' + i, { publishedTs: i + 1, read: i % 3 === 0 }));
  rows.push(entry('ignored', { publishedTs: 1000, reactionByMe: 'dislike' }));
  const first = plaza().rankPlazaEntries(rows, { mode: 'random', seed: 'one' });
  assert.equal(first.some(row => row.id === 'ignored'), false);
  assert.equal(first[0].read, false);
  const readIndex = first.findIndex(row => row.read);
  assert.ok(first.slice(readIndex).every(row => row.read));
  assert.deepEqual(first.map(row => row.id), plaza().rankPlazaEntries([...rows].reverse(), { mode: 'random', seed: 'one' }).map(row => row.id));
  assert.notDeepEqual(first.map(row => row.id), plaza().rankPlazaEntries(rows, { mode: 'random', seed: 'two' }).map(row => row.id));
});

test('我喜欢优先显式兴趣，也从已点赞文章学习主题，而不是只展示点赞历史', () => {
  const ai = { name: 'AI', kind: 'topic' };
  const design = { name: '设计', kind: 'topic' };
  const rows = [
    entry('fresh-unrelated', { publishedTs: 1000 }),
    entry('explicit-interest', { publishedTs: 20, tags: [ai] }),
    entry('liked-reference', { read: true, reactionByMe: 'like', tags: [design] }),
    entry('related-new-article', { publishedTs: 40, tags: [design] }),
  ];
  const ranked = plaza().rankPlazaEntries(rows, { mode: 'personal', interests: [ai] });
  assert.deepEqual(ranked.map(row => row.id), ['explicit-interest', 'related-new-article', 'fresh-unrelated', 'liked-reference']);
  assert.equal(rows[1].reactionByMe, '');
});

test('兴趣命中充足时每组留出探索位置，而不是将新主题永远排在末尾', () => {
  const ai = { name: 'AI', kind: 'topic' };
  const rows = Array.from({ length: 12 }, (_, i) => entry('matched-' + i, { publishedTs: 20 - i, tags: [ai] }));
  rows.push(entry('outside-a', { sourceId: 'another', publishedTs: 2 }), entry('outside-b', { sourceId: 'third', publishedTs: 1 }));
  const ranked = plaza().rankPlazaEntries(rows, { mode: 'personal', interests: [ai], seed: 'explore' });
  assert.ok(ranked.slice(0, 4).every(row => row.tags.some(tag => tag.name === 'AI')));
  assert.ok(ranked[4].id.startsWith('outside-'));
  assert.ok(ranked[9].id.startsWith('outside-'));
  assert.equal(new Set(ranked.map(row => row.id)).size, rows.length);
});

test('没有兴趣信号时以近期文章分散来源起步，不让高频来源占满首屏', () => {
  const rows = Array.from({ length: 8 }, (_, i) => entry('busy-' + i, { sourceId: 'busy', publishedTs: 100 - i }));
  rows.push(entry('quiet-0', { sourceId: 'quiet', publishedTs: 30 }), entry('third-0', { sourceId: 'third', publishedTs: 20 }));
  const ranked = plaza().rankPlazaEntries(rows, { mode: 'personal', seed: 'cold' });
  assert.deepEqual(ranked.slice(0, 3).map(row => row.id), ['busy-0', 'quiet-0', 'third-0']);
});

test('负反馈温和降低相近内容优先级，不删除文章或拉黑整个来源与主题', () => {
  const ai = { name: 'AI', kind: 'topic' };
  const design = { name: '设计', kind: 'topic' };
  const rows = [
    entry('ignored', { reactionByMe: 'dislike', sourceId: 'shared-source', tags: [ai] }),
    entry('related', { publishedTs: 200, sourceId: 'shared-source', tags: [ai] }),
    entry('design', { publishedTs: 100, tags: [design] }),
    entry('same-source-new-topic', { sourceId: 'shared-source' }),
  ];
  const ranked = plaza().rankPlazaEntries(rows, { mode: 'personal', interests: [ai, design] });
  assert.deepEqual(ranked.map(row => row.id), ['design', 'related', 'same-source-new-topic']);
  assert.equal(plaza().rankPlazaEntries(rows, { mode: 'all' }).length, rows.length);
});
