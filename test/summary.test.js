const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmreader-summary-test-'));
process.env.QMREADER_DATA_DIR = testDataDir;

const deepseek = require('../lib/deepseek');
const store = require('../lib/store');

after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

function seedEntry(overrides = {}) {
  const entry = {
    id: 'summary-' + Math.random().toString(36).slice(2, 10),
    sourceId: 'test-source',
    title: 'How universities should prepare founders',
    link: 'https://example.org/founders',
    author: '',
    published: '2026-09-16 08:00:00',
    summary: 'English summary about founder education.',
    content: '<p>' + 'Founders need practical courses about customers, pricing and distribution. '.repeat(10) + '</p>',
    ...overrides,
  };
  store.upsertEntries([entry]);
  return entry;
}

function openAiResponse(content) {
  return new Response(JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('saveSummary roundtrips and regeneration overwrites the stored body', () => {
  const entry = seedEntry();
  const first = store.saveSummary(entry.id, { body: '第一版摘要', model: 'm1', provider: 'p1', createdBy: 'tester', contentHash: 'h1' });
  assert.equal(first.body, '第一版摘要');
  assert.equal(first.createdBy, 'tester');
  const second = store.saveSummary(entry.id, { body: '第二版摘要', model: 'm2', provider: 'p2', createdBy: 'tester', contentHash: 'h2' });
  assert.equal(second.body, '第二版摘要');
  assert.equal(store.getSummary(entry.id).model, 'm2');
  assert.equal(store.getSummary('missing-entry'), null);
});

test('summarizeEntry generates once, caches by content hash, and force regenerates', async () => {
  const entry = seedEntry();
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return openAiResponse('这是一段关于创始人教育的中文摘要，覆盖课程设计、实践方式和常见误区，帮助读者快速判断文章要点。');
  };
  try {
    const config = { provider: 'openai-compatible', providerType: 'openai_compatible', apiKey: 'test-key', baseUrl: 'https://example.com/v1', model: 'test-model', temperature: 0.3, maxTokens: 2000 };
    const first = await deepseek.summarizeEntry(entry, { ...config, author: 'tester' });
    assert.equal(first.cached, false);
    assert.match(first.summary.body, /中文摘要/);
    assert.equal(first.summary.model, 'test-model');
    assert.equal(calls, 1);

    const cached = await deepseek.summarizeEntry(entry, config);
    assert.equal(cached.cached, true);
    assert.equal(calls, 1);

    const forced = await deepseek.summarizeEntry(entry, { ...config, force: true });
    assert.equal(forced.cached, false);
    assert.equal(calls, 2);
    assert.equal(store.getSummary(entry.id).body, forced.summary.body);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('summarizeEntry rejects empty model output without saving', async () => {
  const entry = seedEntry();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => openAiResponse('   ');
  try {
    await assert.rejects(
      deepseek.summarizeEntry(entry, { provider: 'openai-compatible', providerType: 'openai_compatible', apiKey: 'test-key', baseUrl: 'https://example.com/v1', model: 'test-model' }),
      /empty summary/,
    );
    assert.equal(store.getSummary(entry.id), null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
