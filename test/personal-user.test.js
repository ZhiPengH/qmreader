const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmreader-personal-'));
process.env.QMREADER_DATA_DIR = testDataDir;
delete process.env.QMREADER_DB_FILE;
const store = require('../lib/store');
after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

test('dedicated personal identity is lazy, never inherits historical users, and persists reading state across a process restart', () => {
  const db = new DatabaseSync(path.join(testDataDir, 'qmreader.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM users').get().total, 0);
  db.prepare(`INSERT INTO users (id, email, display_name, role, password_hash, password_salt, created_at, updated_at)
    VALUES ('legacy-admin', 'legacy@example.com', 'Old Admin', 'admin', 'old-hash', 'old-salt', 1, 1)`).run();
  db.prepare(`INSERT INTO sessions VALUES ('old-session', 'legacy-admin', 1, 1)`).run();
  store.upsertEntries([{ id: 'old-entry', sourceId: 'test', title: 'Old' }, { id: 'personal-entry', sourceId: 'test', title: 'Personal' }]);
  store.setUserEntryState('legacy-admin', 'old-entry', { read: true, starred: true, viewed: true });
  const user = store.getPersonalUser();
  assert.equal(user.id, 'zonglan-personal');
  assert.equal(user.email, 'personal@zonglan.invalid');
  assert.equal(user.role, 'user');
  assert.deepEqual(store.getUserEntryStates(user.id), { read: [], starred: [], history: [] });
  store.setUserEntryState(user.id, 'personal-entry', { read: true, starred: true, viewed: true });
  store.updateUserProfile(user.id, { displayName: 'Personal Reader', defaultReaderTab: 'original' });
  const expected = store.getUserEntryStates(user.id);
  const restarted = spawnSync(process.execPath, ['-e', `
    const store = require('./lib/store');
    const user = store.getPersonalUser();
    process.stdout.write(JSON.stringify({user, states: store.getUserEntryStates(user.id)}));
  `], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert.equal(restarted.status, 0, restarted.stderr);
  const snapshot = JSON.parse(restarted.stdout);
  assert.equal(snapshot.user.id, user.id);
  assert.equal(snapshot.user.createdAt, user.createdAt);
  assert.equal(snapshot.user.displayName, 'Personal Reader');
  assert.equal(snapshot.user.defaultReaderTab, 'original');
  assert.deepEqual(snapshot.states, expected);
  assert.deepEqual(snapshot.states.read, ['personal-entry']);
  assert.deepEqual(snapshot.states.starred, ['personal-entry']);
  assert.equal(snapshot.states.history[0].entryId, 'personal-entry');
  assert.ok(snapshot.states.history[0].viewedAt > 0);
  assert.equal(db.prepare("SELECT role FROM users WHERE id = 'legacy-admin'").get().role, 'admin');
  assert.equal(db.prepare("SELECT password_hash FROM users WHERE id = 'legacy-admin'").get().password_hash, 'old-hash');
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM sessions').get().total, 1);
  assert.equal(store.getUserEntryState('legacy-admin', 'old-entry').starred, true);
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  assert.equal(store.getPersonalUser().role, 'user');
  assert.equal(db.prepare('SELECT role FROM users WHERE id = ?').get(user.id).role, 'user');
  db.close();
});

test('store exposes no account, password, or session APIs', () => {
  for (const name of ['createUser', 'ensureAdminUser', 'authenticateUser', 'createSession', 'getUserBySessionToken', 'deleteSession', 'updateUserPassword']) {
    assert.equal(name in store, false, name);
  }
});
