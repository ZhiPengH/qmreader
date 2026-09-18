const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Only the coordinator is under test here. SQLite persistence and provider
// protocols have their own real-module suites and are joined by HTTP tests.
function harness(options = {}) {
  const file = path.join(__dirname, '..', 'lib', 'plaza-tags.js');
  assert.ok(fs.existsSync(file), '广场标签需要串行、去重且受额度保护的协调器');
  const entries = new Map(['one', 'two', 'three'].map(id => [id, { id, title: id, summary: 'summary', tags: [] }]));
  const topics = new Map();
  let used = 0;
  const calls = [];
  const inputParts = entry => ({ title: entry.title, summary: entry.summary, inputHash: JSON.stringify([entry.title, entry.summary]) });
  const store = {
    getEntry: id => entries.get(id) || null,
    getEntryTopics: id => topics.get(id) || null,
    saveEntryTopics(id, data) {
      if (topics.get(id)?.origin === 'manual' && data.origin === 'ai') return topics.get(id);
      topics.set(id, structuredClone(data));
      return topics.get(id);
    },
    getPlazaEntries({ ids = [...entries.keys()] } = {}) {
      return ids.filter(id => entries.has(id)).map(id => ({ ...entries.get(id), tags: topics.get(id)?.tags || [], tagStatus: topics.get(id)?.status || 'pending', tagOrigin: topics.get(id)?.origin || '' }));
    },
    getPlazaTagUsage(userId, limit) { return { day: 'test-day', limit, used, remaining: Math.max(0, limit - used) }; },
    claimPlazaTagAllowance(userId, count, limit) {
      const granted = Math.min(count, Math.max(0, limit - used));
      used += granted;
      return { ...this.getPlazaTagUsage(userId, limit), granted };
    },
  };
  const classify = options.classify || (async batch => {
    calls.push(batch.map(entry => entry.id));
    return batch.map(entry => ({ entryId: entry.id, tags: [{ name: 'AI', kind: 'topic' }] }));
  });
  const tagger = require(file).createPlazaTagger({ store, classify, inputParts, dailyLimit: options.dailyLimit ?? 100, autoEnabled: options.autoEnabled ?? false });
  return { entries, topics, calls, inputParts, store, tagger };
}

test('已缓存的结果与人工纠正无需再次调用 AI 或消耗额度', async () => {
  const h = harness();
  h.topics.set('one', { status: 'ready', origin: 'ai', inputHash: h.inputParts(h.entries.get('one')).inputHash, tags: [{ name: 'AI', kind: 'topic' }] });
  h.topics.set('two', { status: 'ready', origin: 'manual', inputHash: 'earlier', tags: [{ name: '随笔', kind: 'format' }] });
  const result = await h.tagger.analyze('user', [h.entries.get('one'), h.entries.get('two')]);
  assert.equal(h.calls.length, 0);
  assert.equal(result.usage.used, 0);
  assert.deepEqual(result.entries[1].tags, [{ name: '随笔', kind: 'format' }]);
});

test('未分析文章先领取额度，生成结果持久化后重复请求不再付费', async () => {
  const h = harness();
  const rows = [h.entries.get('one'), h.entries.get('two')];
  const first = await h.tagger.analyze('user', rows, { aiConfig: { provider: 'openai', model: 'test-model', apiKey: 'test-only-key' } });
  assert.deepEqual(h.calls, [['one', 'two']]);
  assert.equal(first.usage.used, 2);
  assert.equal(first.entries[0].tagStatus, 'ready');
  assert.equal(h.topics.get('one').inputHash, h.inputParts(rows[0]).inputHash);
  assert.equal(JSON.stringify([...h.topics.values()]).includes('test-only-key'), false);
  await h.tagger.analyze('user', rows);
  assert.equal(h.calls.length, 1);
});

test('并发请求同一文章只分析一次，排队后重新检查缓存', async () => {
  const h = harness();
  const rows = [h.entries.get('one')];
  await Promise.all([h.tagger.analyze('user', rows), h.tagger.analyze('user', rows)]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.tagger.state('user').usage.used, 1);
});


test('自动分析关闭时不调用 AI、不领取额度；仍允许用户手动生成', async () => {
  const h = harness();
  const rows = [h.entries.get('one')];
  const skipped = await h.tagger.analyze('user', rows, { automatic: true });
  assert.equal(h.calls.length, 0);
  assert.equal(skipped.skipped, 'disabled');
  assert.equal(skipped.usage.used, 0);
  await h.tagger.analyze('user', rows);
  assert.equal(h.calls.length, 1);
});


test('失败记录可见且不会自动重试，明确重试才再次消耗额度', async () => {
  let attempts = 0;
  const h = harness({ classify: async batch => {
    attempts += 1;
    if (attempts === 1) throw new Error('provider echoed a secret test-only-key');
    return batch.map(entry => ({ entryId: entry.id, tags: [{ name: 'AI', kind: 'topic' }] }));
  } });
  const rows = [h.entries.get('one')];
  const failed = await h.tagger.analyze('user', rows);
  assert.equal(failed.skipped, 'failed');
  assert.equal(failed.entries[0].tagStatus, 'failed');
  assert.equal(failed.usage.used, 1);
  assert.equal(JSON.stringify([...h.topics.values()]).includes('test-only-key'), false);
  await h.tagger.analyze('user', rows);
  assert.equal(attempts, 1);
  const retried = await h.tagger.analyze('user', rows, { retry: true });
  assert.equal(attempts, 2);
  assert.equal(retried.entries[0].tagStatus, 'ready');
  assert.equal(retried.usage.used, 2);
});


test('额度仅覆盖批次的一部分时，只分析获准文章并说明额度已用完', async () => {
  const h = harness({ dailyLimit: 1 });
  const result = await h.tagger.analyze('user', [...h.entries.values()]);
  assert.deepEqual(h.calls, [['one']]);
  assert.equal(result.skipped, 'quota');
  assert.equal(result.usage.used, 1);
  await h.tagger.analyze('user', [h.entries.get('two')]);
  assert.equal(h.calls.length, 1);
});


test('分析期间文章变更或删除时不写入过期结果，人工纠正也不被覆盖', async () => {
  let h;
  h = harness({ classify: async batch => {
    h.entries.get('one').summary = 'changed during request';
    h.entries.delete('two');
    h.topics.set('three', { status: 'ready', origin: 'manual', tags: [{ name: '随笔', kind: 'format' }] });
    return batch.map(entry => ({ entryId: entry.id, tags: [{ name: 'AI', kind: 'topic' }] }));
  } });
  await h.tagger.analyze('user', [...h.entries.values()]);
  assert.equal(h.topics.has('one'), false);
  assert.equal(h.topics.has('two'), false);
  assert.deepEqual(h.topics.get('three').tags, [{ name: '随笔', kind: 'format' }]);
});


test('批次上限在付费前校验，同批重复文章只占一个额度', async () => {
  const h = harness();
  await h.tagger.analyze('user', [h.entries.get('one'), h.entries.get('one')]);
  assert.deepEqual(h.calls, [['one']]);
  const oversized = Array.from({ length: 9 }, (_, i) => ({ id: 'extra-' + i, title: 'extra', summary: '' }));
  await assert.rejects(h.tagger.analyze('user', oversized), error => error.statusCode === 400);
  assert.equal(h.tagger.state('user').usage.used, 1);
});


test('排队期间文章更新后，下一次分析读取最新内容而非旧请求快照', async () => {
  const summaries = [];
  let h;
  h = harness({ classify: async batch => {
    summaries.push(batch[0].summary);
    if (summaries.length === 1) h.entries.get('one').summary = 'updated';
    return batch.map(entry => ({ entryId: entry.id, tags: [{ name: 'AI', kind: 'topic' }] }));
  } });
  const stale = structuredClone(h.entries.get('one'));
  await Promise.all([h.tagger.analyze('user', [stale]), h.tagger.analyze('user', [stale])]);
  assert.deepEqual(summaries, ['summary', 'updated']);
  assert.equal(h.topics.get('one').inputHash, h.inputParts(h.entries.get('one')).inputHash);
});

