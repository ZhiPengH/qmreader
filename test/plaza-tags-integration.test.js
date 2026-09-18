const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmreader-plaza-tags-'));
process.env.QMREADER_DATA_DIR = dataDir;
delete process.env.QMREADER_DB_FILE;
const store = require('../lib/store');
const { createPlazaTagger } = require('../lib/plaza-tags');
const db = new DatabaseSync(path.join(dataDir, 'qmreader.sqlite'));
db.exec('PRAGMA foreign_keys = ON');
beforeEach(() => db.exec('DELETE FROM entries; DELETE FROM users;'));
after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// This suite joins the real coordinator and SQLite store. The classifier is an
// explicit fixture; provider request/response contracts are tested separately.
const inputParts = entry => ({ inputHash: store.hashText(JSON.stringify([entry.title, entry.summary])) });
const tags = [{ name: '人工智能', kind: 'topic' }];
function seed() {
  store.upsertEntries(['one', 'two'].map(id => ({ id, sourceId: 'fixture', title: id, summary: 'summary' })));
  return store.getPersonalUser().id;
}

test('real SQLite: concurrent cache fills consume one allowance and preserve empty manual corrections', async () => {
  const userId = seed();
  store.saveEntryTopics('two', { tags: [], origin: 'manual' });
  let calls = 0;
  const tagger = createPlazaTagger({ store, inputParts, dailyLimit: 5, classify: async entries => {
    calls += 1;
    return entries.map(entry => ({ entryId: entry.id, tags }));
  } });
  const entries = ['one', 'two'].map(id => store.getEntry(id));
  const results = await Promise.all([tagger.analyze(userId, entries), tagger.analyze(userId, entries)]);
  assert.equal(calls, 1);
  assert.equal(store.getPlazaTagUsage(userId, 5).used, 1);
  assert.equal(results[1].entries[0].tagStatus, 'ready');
  assert.deepEqual(store.getEntryTopics('one').tags, tags);
  assert.deepEqual(store.getEntryTopics('two').tags, []);
  assert.equal(store.getEntryTopics('two').origin, 'manual');
  assert.equal(Object.hasOwn(results[0].entries[0], 'content'), false);
});

test('real SQLite: deletion while classification is in flight does not resurrect an article or its cache', async () => {
  const userId = seed();
  const tagger = createPlazaTagger({ store, inputParts, dailyLimit: 5, classify: async entries => {
    store.softDeleteEntry('one');
    return entries.map(entry => ({ entryId: entry.id, tags }));
  } });
  const result = await tagger.analyze(userId, [store.getEntry('one')]);
  assert.deepEqual(result.entries, []);
  assert.equal(result.usage.used, 1);
  assert.equal(store.getEntry('one'), null);
  assert.throws(() => store.getEntryTopics('one'), error => error.statusCode === 404);
});

test('real SQLite: failed attempt persists, automatic revisits do not spend again, explicit retry respects cap', async () => {
  const userId = seed();
  let calls = 0;
  const tagger = createPlazaTagger({ store, inputParts, dailyLimit: 1, autoEnabled: true, classify: async () => {
    calls += 1;
    throw new Error('fixture provider failure');
  } });
  const entries = [store.getEntry('one')];
  const first = await tagger.analyze(userId, entries);
  assert.equal(first.skipped, 'failed');
  assert.equal(store.getEntryTopics('one').status, 'failed');
  await tagger.analyze(userId, entries, { automatic: true });
  assert.equal(calls, 1);
  const retry = await tagger.analyze(userId, entries, { retry: true });
  assert.equal(retry.skipped, 'quota');
  assert.equal(calls, 1);
  assert.equal(retry.usage.remaining, 0);
});
