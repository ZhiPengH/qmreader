const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmreader-offline-test-'));
process.env.QMREADER_DATA_DIR = testDataDir;

const offlinePrefetch = require('../lib/offline-prefetch');
const store = require('../lib/store');

after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

const HOUR = 3600 * 1000;

function seedEntry(id, overrides = {}) {
  const entry = {
    id,
    sourceId: 'test-source',
    title: 'Title ' + id,
    link: 'https://example.org/' + id,
    author: '',
    published: '2026-09-15 08:00:00',
    summary: 'Short summary.',
    content: '',
    ...overrides,
  };
  store.upsertEntries([entry]);
  return entry;
}

test('nextOfflinePrefetchDelay targets the Beijing hour without catch-up or firing early', () => {
  const beforeTarget = offlinePrefetch.nextOfflinePrefetchDelay(new Date('2026-09-16T20:00:00Z'), 6);
  assert.equal(beforeTarget, 2 * HOUR);
  const afterTarget = offlinePrefetch.nextOfflinePrefetchDelay(new Date('2026-09-16T10:00:00Z'), 6);
  assert.equal(afterTarget, 12 * HOUR);
  const almostDue = offlinePrefetch.nextOfflinePrefetchDelay(new Date('2026-09-16T21:59:30Z'), 6);
  assert.equal(almostDue, 60 * 1000);
  const exactlyDue = offlinePrefetch.nextOfflinePrefetchDelay(new Date('2026-09-16T22:00:00Z'), 6);
  assert.equal(exactlyDue, 24 * HOUR);
  assert.equal(offlinePrefetch.nextOfflinePrefetchDelay(new Date(), 99), -1);
});

test('selection keeps newest fetchable entries, skips rich content and recent failures', () => {
  const now = Date.now();
  const entries = [
    { id: 'rich', link: 'https://example.org/rich', summary: 's', content: '<p>' + 'Full article text '.repeat(60) + '</p>', publishedTs: 500 },
    { id: 'old-fail', link: 'https://example.org/old', summary: 's', content: '', publishedTs: 400, originalFetchError: 'dead', originalFetchAttemptedAt: now - 49 * HOUR },
    { id: 'new-fail', link: 'https://example.org/new', summary: 's', content: '', publishedTs: 450, originalFetchError: 'dead', originalFetchAttemptedAt: now - 1000 },
    { id: 'no-link', link: '', summary: 's', content: '', publishedTs: 600 },
    { id: 'newest', link: 'https://example.org/newest', summary: 's', content: '', publishedTs: 700 },
    { id: 'mid', link: 'https://example.org/mid', summary: 's', content: '', publishedTs: 300 },
  ];
  const picked = offlinePrefetch.selectOfflinePrefetchEntries(entries, { limit: 2, nowMs: now });
  assert.deepEqual(picked.map(entry => entry.id), ['newest', 'old-fail']);
  const all = offlinePrefetch.selectOfflinePrefetchEntries(entries, { limit: 10, nowMs: now });
  assert.deepEqual(all.map(entry => entry.id), ['newest', 'old-fail', 'mid']);
});

test('cache budget evicts oldest prefetched entries first', () => {
  const a = seedEntry('budget-a', { published: '2026-09-13 08:00:00' });
  const b = seedEntry('budget-b', { published: '2026-09-14 08:00:00' });
  const c = seedEntry('budget-c', { published: '2026-09-15 08:00:00' });
  store.updateEntryContent(a.id, { content: 'A'.repeat(3000), originalFetched: true });
  store.updateEntryContent(b.id, { content: 'B'.repeat(2000), originalFetched: true });
  store.updateEntryContent(c.id, { content: 'C'.repeat(1000), originalFetched: true });
  const total = store.offlinePrefetchBytes();
  const result = store.enforceOfflineCacheBudget(total - 1500);
  assert.equal(result.evicted, 1);
  assert.ok(result.bytes <= total - 1500);
  assert.equal(store.getRecentEntriesForPrefetch(10).find(entry => entry.id === 'budget-a').content, '');
  assert.equal(store.getRecentEntriesForPrefetch(10).find(entry => entry.id === 'budget-a').originalFetchedAt, null);
  assert.ok(store.getRecentEntriesForPrefetch(10).find(entry => entry.id === 'budget-c').content.length > 0);
});

test('runs are single-flight and manual fetch errors count as failures without crashing', async () => {
  seedEntry('single-flight', { published: '2026-09-15 09:00:00' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = offlinePrefetch.runOfflinePrefetch({
    trigger: 'test',
    fetchOne: () => gate.then(() => ({ content: 'fetched body' })),
  });
  const second = await offlinePrefetch.runOfflinePrefetch({ trigger: 'test', fetchOne: () => ({ content: 'x' }) });
  assert.equal(second.started, false);
  assert.equal(second.running, true);
  release();
  const done = await first;
  assert.equal(done.started, true);
  assert.ok(done.selected >= 1);
  assert.equal(done.ok, done.selected);
  assert.equal(done.failed, 0);
  assert.equal(offlinePrefetch.getOfflinePrefetchStatus().running, false);

  const failing = await offlinePrefetch.runOfflinePrefetch({
    trigger: 'test',
    fetchOne: async () => { throw new Error('site down'); },
  });
  assert.ok(failing.selected >= 1);
  assert.equal(failing.failed, failing.selected);
});
