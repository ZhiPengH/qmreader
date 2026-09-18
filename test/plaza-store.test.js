const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmreader-plaza-store-'));
process.env.QMREADER_DATA_DIR = testDataDir;
delete process.env.QMREADER_DB_FILE;
const store = require('../lib/store');
const db = new DatabaseSync(path.join(testDataDir, 'qmreader.sqlite'));
db.exec('PRAGMA foreign_keys = ON');
beforeEach(() => db.exec('DELETE FROM entries; DELETE FROM users; DELETE FROM source_overrides;'));
after(() => {
  db.close();
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

function entry(id, extra = {}) {
  return { id, sourceId: 'test', title: `Article ${id}`, ...extra };
}

function restart(expression) {
  const result = spawnSync(process.execPath, ['-e', `
    const store = require('./lib/store');
    process.stdout.write(JSON.stringify(${expression}));
  `], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('plaza returns the entire metadata library beyond 400, including bodyless and disabled-source entries', t => {
  const entries = Array.from({ length: 410 }, (_, i) => entry(`library-${i}`, {
    sourceId: i === 0 ? 'disabled-source' : 'test',
    publishedTs: i,
    content: i === 1 ? '' : '<p>large body</p>'.repeat(1000),
    summary: `Summary ${i}`,
  }));
  store.upsertEntries(entries);
  store.saveSourceOverride('disabled-source', { enabled: false });
  assert.equal(typeof store.getPlazaEntries, 'function');
  const queries = [];
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    queries.push(sql);
    return prepare.call(this, sql);
  });
  const rows = store.getPlazaEntries();
  assert.equal(rows.length, 410);
  assert.equal(new Set(rows.map(row => row.id)).size, 410);
  assert.ok(rows.some(row => row.id === 'library-0' && row.sourceId === 'disabled-source'));
  assert.ok(rows.some(row => row.id === 'library-1'));
  for (const row of rows) {
    assert.equal(Object.hasOwn(row, 'content'), false);
    assert.ok(row.createdAt > 0);
    assert.equal(row.read, false);
    assert.equal(row.reactionByMe, '');
    assert.deepEqual(row.tags, []);
    assert.equal(row.tagStatus, 'pending');
    assert.equal(row.tagOrigin, '');
    assert.equal(row.tagInputHash, '');
    assert.equal(row.tagError, '');
    assert.equal(row.tagUpdatedAt, null);
  }
  assert.ok(queries.length > 0);
  for (const sql of queries) {
    const projection = sql.match(/SELECT([\s\S]*?)FROM/i)?.[1] || '';
    assert.doesNotMatch(projection, /\*|\bcontent\b/i, 'metadata query must not load article bodies');
  }
});

test('plaza excludes soft-deleted entries even after a feed upsert', () => {
  store.upsertEntries([entry('kept'), entry('deleted')]);
  store.softDeleteEntry('deleted');
  store.upsertEntries([entry('deleted', { title: 'Fetched again' })]);
  assert.deepEqual(store.getPlazaEntries().map(row => row.id), ['kept']);
});

test('requested plaza IDs preserve request order, skip missing/deleted IDs, and never repair IDs', () => {
  store.upsertEntries([entry('a'), entry('b'), entry('c'), entry('gone')]);
  store.softDeleteEntry('gone');
  const ids = ['c', 'missing', 'a', 'gone', 'b'];
  assert.deepEqual(store.getPlazaEntries({ ids }).map(row => row.id), ['c', 'a', 'b']);
  assert.deepEqual(store.getPlazaEntries({ ids: [] }), []);
  assert.deepEqual(store.getPlazaEntries({ ids: [' a', 'b ', 'a'.repeat(81)] }), []);
  assert.equal(store.getPlazaEntries({ ids: null }).length, 3);
});

test('plaza read/reaction metadata is scoped to the requested user and reuses existing state tables', () => {
  const user = store.getPersonalUser();
  db.prepare(`INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at, updated_at)
    VALUES ('other', 'other@example.invalid', 'Other', '', '', 1, 1)`).run();
  store.upsertEntries([entry('one'), entry('two')]);
  store.setUserEntryState(user.id, 'one', { read: true });
  store.setUserEntryState('other', 'two', { read: true });
  store.setEntryReaction('one', user.id, 'like');
  store.setEntryReaction('one', 'other', 'dislike');
  const read = userId => store.getPlazaEntries({ userId, ids: ['one', 'two'] })
    .map(({ id, read, reactionByMe }) => ({ id, read, reactionByMe }));
  assert.deepEqual(read(user.id), [
    { id: 'one', read: true, reactionByMe: 'like' },
    { id: 'two', read: false, reactionByMe: '' },
  ]);
  assert.deepEqual(read('other'), [
    { id: 'one', read: false, reactionByMe: 'dislike' },
    { id: 'two', read: true, reactionByMe: '' },
  ]);
  assert.deepEqual(read(''), [
    { id: 'one', read: false, reactionByMe: '' },
    { id: 'two', read: false, reactionByMe: '' },
  ]);
});

test('entry topic cache persists ready tags and exposes the same metadata after restart', () => {
  store.upsertEntries([entry('tagged'), entry('pending')]);
  assert.equal(typeof store.getEntryTopics, 'function');
  assert.equal(typeof store.saveEntryTopics, 'function');
  assert.equal(store.getEntryTopics('pending'), null);
  const tags = [{ name: '人工智能', kind: 'topic' }, { name: '教程', kind: 'format' }];
  const saved = store.saveEntryTopics('tagged', {
    tags, inputHash: 'input-v1', model: 'test-model', provider: 'test-provider',
  });
  assert.deepEqual(saved, {
    tags, status: 'ready', origin: 'ai', inputHash: 'input-v1',
    model: 'test-model', provider: 'test-provider', error: '', updatedAt: saved.updatedAt,
  });
  assert.ok(saved.updatedAt > 0);
  assert.deepEqual(store.getEntryTopics('tagged'), saved);
  const [row] = store.getPlazaEntries({ ids: ['tagged'] });
  assert.deepEqual(row.tags, tags);
  assert.equal(row.tagStatus, 'ready');
  assert.equal(row.tagOrigin, 'ai');
  assert.equal(row.tagInputHash, 'input-v1');
  assert.equal(row.tagError, '');
  assert.equal(row.tagUpdatedAt, saved.updatedAt);
  assert.deepEqual(restart("store.getEntryTopics('tagged')"), saved);
});

test('manual topic corrections, including an empty selection, survive later AI writes and restart', () => {
  store.upsertEntries([entry('corrected')]);
  store.saveEntryTopics('corrected', { tags: [{ name: 'AI', kind: 'topic' }] });
  const manual = store.saveEntryTopics('corrected', {
    tags: [{ name: '随笔', kind: 'format' }], origin: 'manual', inputHash: 'manual-v1',
  });
  assert.deepEqual(store.saveEntryTopics('corrected', {
    tags: [{ name: 'Technology', kind: 'topic' }], inputHash: 'ai-v2',
  }), manual);
  const cleared = store.saveEntryTopics('corrected', { tags: [], origin: 'manual' });
  assert.deepEqual(cleared.tags, []);
  assert.deepEqual(store.saveEntryTopics('corrected', { tags: [], status: 'failed', error: 'timeout' }), cleared);
  assert.deepEqual(restart("store.getEntryTopics('corrected')"), cleared);
});

test('topic tags trim only their edges, default to topic, deduplicate by name/kind, and reject invalid labels', () => {
  store.upsertEntries([entry('validate')]);
  const saved = store.saveEntryTopics('validate', { tags: [
    { name: '  人工  智能  ' }, { name: '人工  智能', kind: 'topic' },
    { name: '人工  智能', kind: 'format' }, { name: '标'.repeat(24), kind: 'topic' },
  ] });
  assert.deepEqual(saved.tags, [
    { name: '人工  智能', kind: 'topic' }, { name: '人工  智能', kind: 'format' },
    { name: '标'.repeat(24), kind: 'topic' },
  ]);
  for (const tag of [null, {}, { name: '' }, { name: ' ' }, { name: 2 },
    { name: '<b>x</b>' }, { name: 'x\ny' }, { name: 'x\u0000' },
    { name: '\tx' }, { name: 'x\u007f' }, { name: 'x\u0085' },
    { name: '标'.repeat(25) }, { name: 'ok', kind: 'other' }, { name: 'ok', kind: null }]) {
    assert.throws(() => store.saveEntryTopics('validate', { tags: [tag] }), { statusCode: 400 }, JSON.stringify(tag));
  }
  for (const tags of [null, {}, 'AI', Array.from({ length: 9 }, (_, i) => ({ name: `Tag ${i}` }))]) {
    assert.throws(() => store.saveEntryTopics('validate', { tags }), { statusCode: 400 });
  }
  assert.deepEqual(store.getEntryTopics('validate'), saved);
});

test('AI ready results cannot be empty; failed/pending results may be empty with explicit valid status and origin', () => {
  store.upsertEntries([entry('status')]);
  assert.throws(() => store.saveEntryTopics('status', { tags: [] }), { statusCode: 400 });
  for (const fields of [{ status: 'done' }, { origin: 'robot' }, { status: null }, { origin: '' }]) {
    assert.throws(() => store.saveEntryTopics('status', { tags: [{ name: 'AI' }], ...fields }), { statusCode: 400 });
  }
  const failed = store.saveEntryTopics('status', { tags: [], status: 'failed', error: 'timeout' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'timeout');
  assert.equal(store.getPlazaEntries({ ids: ['status'] })[0].tagError, 'timeout');
  const pending = store.saveEntryTopics('status', { tags: [], status: 'pending' });
  assert.equal(pending.status, 'pending');
  const ready = store.saveEntryTopics('status', { tags: [{ name: 'AI' }] });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.error, '');
});

test('topic APIs reject missing or soft-deleted entries with 404 and never normalize an article ID', () => {
  store.upsertEntries([entry('active'), entry('deleted'), entry('x'.repeat(80))]);
  store.saveEntryTopics('deleted', { tags: [{ name: 'Old' }] });
  store.softDeleteEntry('deleted');
  for (const id of ['missing', 'deleted', ' active', 'active ', 'x'.repeat(81)]) {
    assert.throws(() => store.getEntryTopics(id), { statusCode: 404 }, id);
    assert.throws(() => store.saveEntryTopics(id, { tags: [{ name: 'New' }] }), { statusCode: 404 }, id);
  }
  assert.equal(store.getEntryTopics('active'), null);
  assert.equal(store.getEntryTopics('x'.repeat(80)), null);
});

test('plaza preferences expose only the users existing dislikes and active ready tags of both kinds', () => {
  const user = store.getPersonalUser();
  db.prepare(`INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at, updated_at)
    VALUES ('other', 'other@example.invalid', 'Other', '', '', 1, 1)`).run();
  store.upsertEntries(['ignored', 'liked', 'other-only', 'deleted', 'failed'].map(id => entry(id)));
  store.setEntryReaction('ignored', user.id, 'dislike');
  store.setUserEntryState(user.id, 'ignored', { read: true });
  store.setEntryReaction('liked', user.id, 'like');
  store.setEntryReaction('other-only', 'other', 'dislike');
  store.setEntryReaction('deleted', user.id, 'dislike');
  store.saveEntryTopics('ignored', { tags: [{ name: 'AI' }, { name: '教程', kind: 'format' }] });
  store.saveEntryTopics('liked', { tags: [{ name: 'AI' }] });
  store.saveEntryTopics('deleted', { tags: [{ name: 'Deleted tag' }] });
  store.saveEntryTopics('failed', { tags: [{ name: 'Failed tag' }], status: 'failed' });
  store.softDeleteEntry('deleted');
  assert.equal(typeof store.getPlazaPreferences, 'function');
  const prefs = store.getPlazaPreferences(user.id);
  assert.deepEqual(prefs.interests, []);
  assert.deepEqual(prefs.ignored, store.getPlazaEntries({ userId: user.id, ids: ['ignored'] }));
  assert.equal(prefs.ignored[0].read, true);
  assert.equal(Object.hasOwn(prefs.ignored[0], 'content'), false);
  assert.deepEqual(prefs.knownTags, [{ name: 'AI', kind: 'topic' }, { name: '教程', kind: 'format' }]);
  assert.deepEqual(store.getPlazaPreferences('other').ignored.map(row => row.id), ['other-only']);
  assert.deepEqual(store.getPlazaPreferences('').ignored, []);
  store.setEntryReaction('ignored', user.id, '');
  assert.deepEqual(store.getPlazaPreferences(user.id).ignored, []);
});

test('explicit interests are user-scoped, persist across restart, and never mutate article reactions', () => {
  const user = store.getPersonalUser();
  db.prepare(`INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at, updated_at)
    VALUES ('other', 'other@example.invalid', 'Other', '', '', 1, 1)`).run();
  store.upsertEntries([entry('liked'), entry('ignored')]);
  store.setEntryReaction('liked', user.id, 'like');
  store.setEntryReaction('ignored', user.id, 'dislike');
  store.saveEntryTopics('liked', { tags: [{ name: 'AI' }] });
  const reactions = () => db.prepare('SELECT * FROM entry_reactions ORDER BY entry_id, user_id').all();
  const before = reactions();
  assert.equal(typeof store.setPlazaInterest, 'function');
  store.setPlazaInterest(user.id, { name: ' AI ' });
  store.setPlazaInterest(user.id, { name: 'AI' });
  store.setPlazaInterest('other', { name: 'Other tag' });
  const result = store.setPlazaInterest(user.id, { name: '随笔', kind: 'format' });
  assert.deepEqual(result.interests, [{ name: 'AI', kind: 'topic' }, { name: '随笔', kind: 'format' }]);
  assert.deepEqual(result.knownTags, result.interests);
  assert.deepEqual(result, store.getPlazaPreferences(user.id));
  assert.deepEqual(restart(`store.getPlazaPreferences(${JSON.stringify(user.id)})`), result);
  const removed = store.setPlazaInterest(user.id, { name: '随笔', kind: 'format' }, false);
  assert.deepEqual(removed.interests, [{ name: 'AI', kind: 'topic' }]);
  assert.deepEqual(removed.knownTags, [{ name: 'AI', kind: 'topic' }]);
  assert.deepEqual(store.getPlazaPreferences('other').interests, [{ name: 'Other tag', kind: 'topic' }]);
  assert.deepEqual(reactions(), before);
  store.setEntryReaction('ignored', user.id, '');
  assert.deepEqual(store.getPlazaPreferences(user.id).interests, removed.interests);
});

test('interest writes validate the boolean and user as well as unsanitized label input', () => {
  const user = store.getPersonalUser();
  for (const interested of ['false', 0, 1, null, {}]) {
    assert.throws(() => store.setPlazaInterest(user.id, { name: 'AI' }, interested), { statusCode: 400 });
  }
  for (const userId of ['', null, undefined, {}, 'missing']) {
    assert.throws(() => store.setPlazaInterest(userId, { name: 'AI' }), { statusCode: 400 });
  }
  for (const tag of [null, {}, { name: '' }, { name: ' ' }, { name: '<img>' },
    { name: 'x\n' }, { name: 'x\u0000' }, { name: 'x'.repeat(25) }, { name: 'x', kind: 'unknown' }]) {
    for (const interested of [true, false]) {
      assert.throws(() => store.setPlazaInterest(user.id, tag, interested), { statusCode: 400 });
    }
  }
  assert.deepEqual(store.getPlazaPreferences(user.id).interests, []);
});

test('library revision tracks all rowids while counts include only active entries, with a strict cursor', () => {
  assert.equal(typeof store.getPlazaLibraryStatus, 'function');
  assert.deepEqual(store.getPlazaLibraryStatus(), { revision: 0, total: 0, newCount: 0 });
  store.upsertEntries([entry('old'), entry('new'), entry('last')]);
  const revision = db.prepare('SELECT MAX(rowid) AS revision FROM entries').get().revision;
  assert.deepEqual(store.getPlazaLibraryStatus(), { revision, total: 3, newCount: 3 });
  const afterRowId = db.prepare("SELECT rowid FROM entries WHERE id = 'old'").get().rowid;
  store.softDeleteEntry('last');
  assert.deepEqual(store.getPlazaLibraryStatus(afterRowId), { revision, total: 2, newCount: 1 });
  assert.deepEqual(store.getPlazaLibraryStatus(revision), { revision, total: 2, newCount: 0 });
  store.upsertEntries([entry('new', { summary: 'changed' })]);
  assert.equal(store.getPlazaLibraryStatus().revision, revision);
  for (const value of [-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null]) {
    assert.throws(() => store.getPlazaLibraryStatus(value), { statusCode: 400 });
  }
});

test('tag allowance counts attempted articles by Shanghai day, clamps grants, and survives restart', () => {
  const user = store.getPersonalUser();
  assert.equal(typeof store.getPlazaTagUsage, 'function');
  assert.equal(typeof store.claimPlazaTagAllowance, 'function');
  const beforeMidnight = Date.parse('2026-09-18T15:59:59.999Z');
  const midnight = Date.parse('2026-09-18T16:00:00.000Z');
  assert.deepEqual(store.getPlazaTagUsage(user.id, 3, beforeMidnight), {
    day: '2026-09-18', limit: 3, used: 0, remaining: 3,
  });
  assert.deepEqual(store.claimPlazaTagAllowance(user.id, 0, 3, beforeMidnight), {
    day: '2026-09-18', limit: 3, used: 0, remaining: 3, granted: 0,
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plaza_tag_usage').get().n, 0);
  assert.deepEqual(store.claimPlazaTagAllowance(user.id, 2, 3, beforeMidnight), {
    day: '2026-09-18', limit: 3, used: 2, remaining: 1, granted: 2,
  });
  assert.deepEqual(restart(`store.claimPlazaTagAllowance(${JSON.stringify(user.id)}, 5, 3, ${beforeMidnight})`), {
    day: '2026-09-18', limit: 3, used: 3, remaining: 0, granted: 1,
  });
  assert.equal(store.claimPlazaTagAllowance(user.id, 1, 3, beforeMidnight).granted, 0);
  assert.deepEqual(store.getPlazaTagUsage(user.id, 1, beforeMidnight), {
    day: '2026-09-18', limit: 1, used: 3, remaining: 0,
  });
  assert.deepEqual(store.claimPlazaTagAllowance(user.id, 1, 3, midnight), {
    day: '2026-09-19', limit: 3, used: 1, remaining: 2, granted: 1,
  });
  assert.equal(restart(`store.getPlazaTagUsage(${JSON.stringify(user.id)}, 3, ${beforeMidnight})`).used, 3);
  assert.equal(store.claimPlazaTagAllowance(user.id, 1, 0, midnight).granted, 0);
});

test('allowance requires explicit nonnegative safe count/limit and a valid timestamp without consuming on bad input', () => {
  const user = store.getPersonalUser();
  const at = Date.parse('2026-09-18T00:00:00Z');
  for (const limit of [undefined, null, '3', -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.getPlazaTagUsage(user.id, limit, at), { statusCode: 400 });
    assert.throws(() => store.claimPlazaTagAllowance(user.id, 1, limit, at), { statusCode: 400 });
  }
  for (const count of [undefined, null, '1', -1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => store.claimPlazaTagAllowance(user.id, count, 3, at), { statusCode: 400 });
  }
  for (const invalidAt of [NaN, Infinity, '2026-09-18', null, 9e15]) {
    assert.throws(() => store.getPlazaTagUsage(user.id, 3, invalidAt), { statusCode: 400 });
    assert.throws(() => store.claimPlazaTagAllowance(user.id, 1, 3, invalidAt), { statusCode: 400 });
  }
  for (const userId of ['', null, undefined, 'missing']) {
    assert.throws(() => store.getPlazaTagUsage(userId, 3, at), { statusCode: 400 });
    assert.throws(() => store.claimPlazaTagAllowance(userId, 1, 3, at), { statusCode: 400 });
  }
  assert.equal(store.getPlazaTagUsage(user.id, 3, at).used, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plaza_tag_usage').get().n, 0);
});

test('allowance locks before reading usage and concurrent processes cannot over-grant', async t => {
  const user = store.getPersonalUser();
  const at = Date.parse('2026-09-18T16:00:00Z');
  let checkedLock = false;
  const prepare = DatabaseSync.prototype.prepare;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    if (/SELECT used FROM plaza_tag_usage/i.test(sql)) {
      let competingWriterBlocked = false;
      try {
        db.exec('BEGIN IMMEDIATE');
        db.exec('ROLLBACK');
      } catch (error) {
        assert.match(error.message, /locked/i);
        competingWriterBlocked = true;
      }
      assert.equal(competingWriterBlocked, true, 'the quota read must already hold the write reservation');
      checkedLock = true;
    }
    return prepare.call(this, sql);
  });
  assert.equal(store.claimPlazaTagAllowance(user.id, 1, 5, at).granted, 1);
  assert.equal(checkedLock, true);
  t.mock.restoreAll();
  db.exec('BEGIN IMMEDIATE; ROLLBACK;');
  const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', `
      const store = require('./lib/store');
      process.stdout.write(JSON.stringify(store.claimPlazaTagAllowance(${JSON.stringify(user.id)}, 2, 5, ${at})));
    `], {
      cwd: path.join(__dirname, '..'), env: { ...process.env, TZ: 'Pacific/Honolulu' }, timeout: 15000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) return reject(new Error(`claim child exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  })));
  assert.equal(results.reduce((sum, result) => sum + result.granted, 0), 4);
  assert.ok(results.every(result => result.used <= 5 && result.day === '2026-09-19'));
  assert.deepEqual(store.getPlazaTagUsage(user.id, 5, at), { day: '2026-09-19', limit: 5, used: 5, remaining: 0 });
});

test('card ratios adapt once to metadata using distributed ID hashes, then persist through content and tag changes', () => {
  const groups = [
    { prefix: 'short', extra: { title: 'Short', summary: '' }, ratios: ['4/3', '16/9'] },
    { prefix: 'long-title', extra: { title: 'Long title '.repeat(20) }, ratios: ['3/4', '4/3'] },
    { prefix: 'long-summary', extra: { title: 'Short', summary: 'Summary '.repeat(50) }, ratios: ['3/4', '4/3'] },
    { prefix: 'image', extra: { image: 'https://example.invalid/image.jpg' }, ratios: ['3/4', '9/16', '1/2'] },
  ];
  for (const group of groups) {
    // Identical suffixes must not collapse all cards onto a single ratio.
    const entries = Array.from({ length: 24 }, (_, i) => entry(`${group.prefix}-${i}-same-tail`, group.extra));
    store.upsertEntries(entries);
    const rows = store.getPlazaEntries({ ids: entries.map(row => row.id) });
    assert.ok(rows.every(row => group.ratios.includes(row.cardRatio)), group.prefix);
    assert.equal(new Set(rows.map(row => row.cardRatio)).size, group.ratios.length, group.prefix);
  }
  const id = 'short-0-same-tail';
  const first = store.getPlazaEntries({ ids: [id] })[0];
  assert.equal(store.getEntryTopics(id), null, 'layout-only cache is not a completed topic cache');
  store.upsertEntries([entry(id, { title: 'Changed long title '.repeat(20), summary: 'Changed summary '.repeat(40), image: 'https://example.invalid/new.jpg' })]);
  store.updateEntryContent(id, { content: '<p>Fetched body</p>'.repeat(100), summary: 'Fetched summary', image: 'https://example.invalid/fetched.jpg' });
  assert.equal(store.getPlazaEntries({ ids: [id] })[0].cardRatio, first.cardRatio);
  store.saveEntryTopics(id, { tags: [{ name: 'AI' }] });
  store.saveEntryTopics(id, { tags: [], origin: 'manual' });
  store.saveEntryTopics(id, { tags: [{ name: 'Ignored AI correction' }] });
  assert.equal(store.getPlazaEntries({ ids: [id] })[0].cardRatio, first.cardRatio);
  assert.equal(restart(`store.getPlazaEntries({ ids: [${JSON.stringify(id)}] })`)[0].cardRatio, first.cardRatio);
  assert.equal(db.prepare('SELECT card_ratio FROM entry_topics WHERE entry_id = ?').get(id).card_ratio, first.cardRatio);
  store.upsertEntries([entry('tag-first')]);
  const cachedBeforeLayout = store.saveEntryTopics('tag-first', { tags: [{ name: 'Manual' }], origin: 'manual' });
  store.getPlazaEntries({ ids: ['tag-first'] });
  assert.deepEqual(store.getEntryTopics('tag-first'), cachedBeforeLayout);
});

test('maxRowId freezes the library revision while newCount still reports subsequently inserted articles', () => {
  store.upsertEntries([entry('first'), entry('second')]);
  const { revision } = store.getPlazaLibraryStatus();
  const before = store.getPlazaEntries({ maxRowId: revision });
  store.upsertEntries([entry('later', { publishedTs: 999999 })]);
  assert.deepEqual(store.getPlazaEntries({ maxRowId: revision }), before);
  assert.equal(store.getPlazaLibraryStatus(revision).newCount, 1);
  assert.deepEqual(store.getPlazaEntries({ maxRowId: 0 }), []);
  assert.deepEqual(store.getPlazaEntries({ ids: ['later', 'second', 'first'], maxRowId: revision }).map(row => row.id), ['second', 'first']);
  assert.equal(store.getPlazaEntries({ maxRowId: null }).length, 3);
  assert.equal(store.getPlazaEntries({ maxRowId: undefined }).length, 3);
  for (const value of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0']) {
    assert.throws(() => store.getPlazaEntries({ maxRowId: value }), { statusCode: 400 });
  }
});

test('plaza IDs accept only an array of unchanged strings, not coercible scalar or object inputs', () => {
  store.upsertEntries([entry('123')]);
  for (const ids of ['123', 123, {}, [123], [null], [{ toString: () => '123' }]]) {
    assert.throws(() => store.getPlazaEntries({ ids }), { statusCode: 400 });
  }
  assert.deepEqual(store.getPlazaEntries({ ids: ['123', '123'] }).map(row => row.id), ['123', '123']);
  assert.deepEqual(store.getPlazaEntries({ ids: [' 123', '123 ', ''] }), []);
});

test('an existing topic cache gains its card-ratio column on restart without losing manual tags', () => {
  store.upsertEntries([entry('upgraded')]);
  const saved = store.saveEntryTopics('upgraded', { tags: [{ name: 'Manual' }], origin: 'manual' });
  db.exec('ALTER TABLE entry_topics DROP COLUMN card_ratio');
  const snapshot = restart("({ topic: store.getEntryTopics('upgraded'), rows: store.getPlazaEntries({ ids: ['upgraded'] }) })");
  assert.deepEqual(snapshot.topic, saved);
  assert.ok(['4/3', '16/9'].includes(snapshot.rows[0].cardRatio));
  assert.deepEqual(store.getEntryTopics('upgraded'), saved);
});
