const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmreader-admin-submissions-'));
process.env.QMREADER_DATA_DIR = testDataDir;
delete process.env.ADMIN_EMAIL;
delete process.env.ADMIN_PASSWORD;
delete process.env.ADMIN_NAME;

const store = require('../lib/store');

// Historical identities are fixtures, not a production account-creation API.
function fixtureUser({ email, displayName, role = 'user' }) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(testDataDir, 'qmreader.sqlite'));
  const id = require('node:crypto').randomUUID();
  const t = Date.now();
  db.prepare(`INSERT INTO users (id, email, display_name, role, password_hash, password_salt, created_at, updated_at)
    VALUES (?, ?, ?, ?, '', '', ?, ?)`).run(id, email, displayName, role, t, t);
  db.close();
  return { id, email, displayName, role };
}


after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

function entry(id, title) {
  return {
    id,
    sourceId: 'user-submitted',
    title,
    link: `https://example.com/${id}`,
    author: '读者',
    published: new Date().toISOString(),
    publishedTs: Date.now(),
    summary: `${title} summary`,
    content: `<p>${title} content</p>`,
  };
}

function saveSubmission(id, title, user) {
  return store.saveSubmittedEntry(entry(id, title), {
    userId: user.id,
    author: user.displayName,
  });
}

function uniqueEmail(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

function waitForServer(child, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timed out')), timeout);
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('QMReader listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(stderr || `server exited ${code}`));
    });
  });
}

test('admin page exposes an accessible user submission management workflow', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  for (const id of [
    'admin-submission-search-form',
    'admin-submission-search',
    'admin-submission-users',
    'admin-submission-detail',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /用户投稿管理/);
  assert.match(app, /async function loadAdminSubmissionUsers/);
  assert.match(app, /async function loadAdminUserSubmissions/);
  assert.match(app, /async function deleteAdminUserSubmissions/);
  assert.match(app, /async function deleteAdminUser/);
  assert.match(app, /showConfirmDialog/);
  assert.match(html, /待审核投稿/);
  assert.match(app, /loadAdminSubmissionRequests/);
  assert.match(app, /reviewAdminSubmissionRequest/);
});

test('submission requests stay quarantined until an administrator reviews them', () => {
  const reader = fixtureUser({ email: uniqueEmail('queue-reader'), displayName: 'queue reader' });
  const admin = fixtureUser({ email: uniqueEmail('queue-admin'), displayName: 'queue admin', role: 'admin' });
  const queued = store.createSubmissionRequest({
    url: 'https://example.com/queued-article',
    userId: reader.id,
    author: reader.displayName,
    note: 'worth reading',
  });
  assert.equal(queued.status, 'pending');
  assert.equal(store.getSubmissionRequests({ status: 'pending' }).length, 1);
  assert.equal(store.getSubmittedEntries().some(item => item.link === queued.url), false);

  const duplicate = store.createSubmissionRequest({
    url: queued.url,
    userId: reader.id,
    author: reader.displayName,
    note: 'duplicate',
  });
  assert.equal(duplicate.id, queued.id);
  assert.equal(store.getSubmissionRequests({ status: 'pending' }).length, 1);

  const rejected = store.reviewSubmissionRequest(queued.id, {
    status: 'rejected',
    reviewedBy: admin.id,
    reason: 'not an article',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reviewReason, 'not an article');
  assert.equal(store.getSubmissionRequests({ status: 'pending' }).length, 0);
});

test('submission quarantine enforces a small durable pending quota per account', () => {
  const reader = fixtureUser({ email: uniqueEmail('quota-reader'), displayName: 'quota reader' });
  for (let index = 0; index < 3; index += 1) {
    store.createSubmissionRequest({
      url: `https://example.com/quota-${index}`,
      userId: reader.id,
      author: reader.displayName,
    });
  }
  assert.throws(
    () => store.createSubmissionRequest({
      url: 'https://example.com/quota-overflow',
      userId: reader.id,
      author: reader.displayName,
    }),
    error => error.statusCode === 429 && /待审核/.test(error.message)
  );
});

test('admin submission summaries and batch soft delete are scoped to one exact user', () => {
  const readerC = fixtureUser({ email: uniqueEmail('reader-c'), displayName: 'c' });
  const sameName = fixtureUser({ email: uniqueEmail('reader-c2'), displayName: 'c' });
  const other = fixtureUser({ email: uniqueEmail('reader-d'), displayName: 'd' });
  saveSubmission('c-entry-one', 'C one', readerC);
  saveSubmission('c-entry-two', 'C two', readerC);
  saveSubmission('same-name-entry', 'Same name', sameName);
  saveSubmission('other-entry', 'Other', other);

  const users = store.getAdminSubmissionUsers({ q: 'reader-c', limit: 20 });
  assert.equal(users.length, 2);
  assert.deepEqual(users.map(item => item.userId).sort(), [readerC.id, sameName.id].sort());
  assert.equal(users.find(item => item.userId === readerC.id).activeSubmissionCount, 2);

  const preview = store.getAdminUserSubmissions(readerC.id, { limit: 20 });
  assert.equal(preview.user.displayName, 'c');
  assert.equal(preview.user.email, readerC.email);
  assert.equal(preview.activeSubmissionCount, 2);
  assert.deepEqual(preview.submissions.map(item => item.entryId).sort(), ['c-entry-one', 'c-entry-two']);

  const result = store.softDeleteUserSubmissions(readerC.id, {
    deletedBy: 'admin-user-id',
    reason: '管理员批量删除用户投稿',
  });
  assert.equal(result.deletedCount, 2);
  assert.deepEqual(result.entryIds.sort(), ['c-entry-one', 'c-entry-two']);
  assert.equal(store.getEntry('c-entry-one'), null);
  assert.equal(store.getEntry('c-entry-two'), null);
  assert.ok(store.getEntry('same-name-entry'));
  assert.ok(store.getEntry('other-entry'));

  const afterDelete = store.getAdminUserSubmissions(readerC.id, { limit: 20 });
  assert.equal(afterDelete.activeSubmissionCount, 0);
  assert.equal(afterDelete.deletedSubmissionCount, 2);
  assert.ok(afterDelete.submissions.every(item => item.deletedAt));

  const idempotent = store.softDeleteUserSubmissions(readerC.id, {
    deletedBy: 'admin-user-id',
    reason: 'repeat',
  });
  assert.equal(idempotent.deletedCount, 0);
  assert.deepEqual(idempotent.entryIds, []);
  assert.throws(
    () => store.softDeleteUserSubmissions('missing-user', { deletedBy: 'admin-user-id' }),
    error => error.statusCode === 404
  );
});

test('moderation disables a non-admin user, deletes submissions, and can be restored', () => {
  const admin = fixtureUser({ email: uniqueEmail('moderator'), displayName: 'moderator', role: 'admin' });
  const offender = fixtureUser({ email: uniqueEmail('offender'), displayName: '违规用户' });
  saveSubmission('offender-entry-one', 'Offender one', offender);
  saveSubmission('offender-entry-two', 'Offender two', offender);
  const pending = store.createSubmissionRequest({
    url: 'https://example.com/offender-pending',
    userId: offender.id,
    author: offender.displayName,
  });

  const moderated = store.disableUserForModeration(offender.id, {
    adminUserId: admin.id,
    reason: '批量发布违规链接',
  });
  assert.equal(moderated.user.disabled, true);
  assert.equal(moderated.deletedSubmissionCount, 2);
  assert.equal(store.getEntry('offender-entry-one'), null);
  assert.equal(store.getSubmissionRequest(pending.id).status, 'rejected');
  assert.throws(
    () => store.disableUserForModeration(admin.id, { adminUserId: admin.id, reason: 'invalid' }),
    error => error.statusCode === 403
  );

  const restored = store.restoreModeratedUser(offender.id, { adminUserId: admin.id });
  assert.equal(restored.disabled, false);
  assert.equal(store.getEntry('offender-entry-one'), null);
});

test('personal HTTP identity cannot gain admin privileges from cookies or legacy admin configuration', { timeout: 15000 }, async () => {
  const admin = fixtureUser({ email: uniqueEmail('legacy-admin'), displayName: 'Legacy Admin', role: 'admin' });
  const token = 'historical-admin-session';
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(testDataDir, 'qmreader.sqlite'));
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(require('node:crypto').createHash('sha256').update(token).digest('hex'), admin.id, Date.now() + 60000, Date.now());
  db.close();
  const port = 44000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), STARTUP_REFRESH_DELAY_MS: '-1', FRESHNESS_SWEEP_INTERVAL_MS: '-1', ADMIN_EMAIL: admin.email, ADMIN_PASSWORD: 'ignored-password' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(child);
    for (const cookie of ['', 'qm_session=forged-admin', `qm_session=${token}`]) {
      const headers = cookie ? { Cookie: cookie } : {};
      const me = await fetch(`${baseUrl}/api/me`, { headers });
      assert.equal(me.status, 200);
      const { user } = await me.json();
      assert.equal(user.id, 'zonglan-personal');
      assert.equal(user.role, 'user');
      assert.equal(me.headers.get('set-cookie'), null);
      for (const [method, route] of [
        ['GET', '/api/admin/submission-users'], ['GET', '/api/admin/submission-requests'],
        ['GET', '/api/admin/users'], ['GET', `/api/admin/users/${admin.id}/submissions`],
        ['DELETE', `/api/admin/users/${admin.id}/submissions`], ['DELETE', `/api/admin/users/${admin.id}`],
        ['POST', `/api/admin/users/${admin.id}/restore`],
        ['POST', '/api/admin/submission-requests/example/approve'], ['POST', '/api/admin/submission-requests/example/reject'],
      ]) {
        const response = await fetch(`${baseUrl}${route}`, { method, headers });
        assert.equal(response.status, 403, `${method} ${route}`);
      }
    }
    for (const route of ['/api/auth/login', '/api/auth/register', '/api/auth/logout', '/api/me/password']) {
      const response = await fetch(`${baseUrl}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(response.status, 404, route);
    }
    const crossOrigin = await fetch(`${baseUrl}/api/submit-link`, {
      method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(crossOrigin.status, 403);
    const blockedProbe = await fetch(`${baseUrl}/api/submit-link`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'http://[::ffff:7f00:1]:9001/metrics' }),
    });
    assert.equal(blockedProbe.status, 400);
    assert.match((await blockedProbe.json()).error, /内网|IP 地址/);
    const queuedResponse = await fetch(`${baseUrl}/api/submit-link`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/personal-quarantined', note: 'pending only' }),
    });
    assert.equal(queuedResponse.status, 202);
    assert.equal((await queuedResponse.json()).pending, true);
    assert.equal(store.getSubmittedEntries().some(item => item.link === 'https://example.com/personal-quarantined'), false);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const invalid = await fetch(`${baseUrl}/api/submit-link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      assert.equal(invalid.status, 400);
    }
    const limited = await fetch(`${baseUrl}/api/submit-link`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    assert.equal(limited.status, 429);
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  }
});

test('HTTP clients share reading state without cookies and retain cancellation across server restart', { timeout: 15000 }, async () => {
  const entryId = 'http-personal-state';
  store.upsertEntries([entry(entryId, 'Shared personal reading')]);
  const port = 45000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const headersA = { 'Content-Type': 'application/json' };
  const headersB = { 'Content-Type': 'application/json', Cookie: 'qm_session=different-device-cookie' };
  const launch = () => spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), STARTUP_REFRESH_DELAY_MS: '-1', FRESHNESS_SWEEP_INTERVAL_MS: '-1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await exited;
  };
  const write = async (headers, update) => {
    const response = await fetch(`${baseUrl}/api/me/entry-state`, {
      method: 'POST', headers, body: JSON.stringify({ entryId, ...update }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).entryState;
  };
  const read = async headers => {
    const response = await fetch(`${baseUrl}/api/me/entry-states`, { headers });
    assert.equal(response.status, 200);
    return (await response.json()).states;
  };
  let child = launch();
  try {
    await waitForServer(child);
    await write(headersA, { read: true, starred: true });
    await write(headersB, { viewed: true });
    const before = await read(headersA);
    assert.deepEqual(await read(headersB), before);
    assert.ok(before.read.includes(entryId));
    assert.ok(before.starred.includes(entryId));
    assert.ok(before.history.some(item => item.entryId === entryId && item.viewedAt > 0));
    const canceled = await write(headersB, { starred: false });
    assert.equal(canceled.starred, false);
    const expected = await read(headersA);
    assert.ok(!expected.starred.includes(entryId));
    assert.ok(expected.read.includes(entryId));
    assert.deepEqual(await read(headersB), expected);
    await stop(child);
    child = launch();
    await waitForServer(child);
    assert.deepEqual(await read(headersA), expected);
    assert.deepEqual(await read(headersB), expected);
  } finally {
    await stop(child);
  }
});
