const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmreader-qsub-test-'));
process.env.QMREADER_DATA_DIR = testDataDir;

const subscriptions = require('../lib/subscriptions');

after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

const okCheck = async () => 'checked';

test('known RSSHub hosts canonicalize to the {rsshub} placeholder', () => {
  assert.equal(subscriptions.canonicalizeFeedUrl('https://rsshub.app/twitter/user/Morry4AI?format=atom'), '{rsshub}/twitter/user/Morry4AI?format=atom');
  assert.equal(subscriptions.canonicalizeFeedUrl('https://rsshub.rssforever.com/test/1'), '{rsshub}/test/1');
  assert.equal(subscriptions.canonicalizeFeedUrl('https://example.org/feed.xml'), 'https://example.org/feed.xml');
  assert.equal(subscriptions.canonicalizeFeedUrl('{rsshub}/test/1'), '{rsshub}/test/1');
});

test('expandRsshub walks every configured instance', () => {
  const expanded = subscriptions.expandRsshub('{rsshub}/twitter/user/x');
  assert.equal(expanded.length, 3);
  assert.ok(expanded.every(url => /^https:\/\/rsshub/.test(url) && url.endsWith('/twitter/user/x')));
  assert.deepEqual(subscriptions.expandRsshub('https://example.org/feed'), ['https://example.org/feed']);
});

test('createSource stores {rsshub} form and accepts it on later edits', async () => {
  const created = await subscriptions.createSource(
    { name: '快速订阅源', category: 'article', feeds: ['https://rsshub.app/test/2'] },
    { checkUrl: okCheck },
  );
  assert.deepEqual(created.feeds, ['{rsshub}/test/2']);
  const edited = await subscriptions.updateSource(
    created.id,
    { feeds: ['{rsshub}/test/2'] },
    { checkUrl: okCheck },
  );
  assert.deepEqual(edited.feeds, ['{rsshub}/test/2']);
});

test('duplicate detection matches raw RSSHub URLs against stored placeholder form', async () => {
  const created = await subscriptions.createSource(
    { name: '重复检测', category: 'article', feeds: ['https://rsshub.app/twitter/user/Morry4AI'] },
    { checkUrl: okCheck },
  );
  await assert.rejects(
    subscriptions.createSource(
      { name: '再来一次', category: 'article', feeds: ['https://rsshub.rssforever.com/twitter/user/Morry4AI'] },
      { checkUrl: okCheck },
    ),
    /已存在/,
  );
  await subscriptions.updateSource(created.id, { deleted: true }, { checkUrl: okCheck });
});

test('unreachable RSSHub routes fail subscription with a multi-instance message', async () => {
  const failing = async () => { throw new Error('HTTP 404'); };
  await assert.rejects(
    subscriptions.createSource(
      { name: '死路由', category: 'article', feeds: ['https://rsshub.app/twitter/user/none'] },
      { checkUrl: failing },
    ),
    /3 个 RSSHub 实例.*HTTP 404/s,
  );
});

