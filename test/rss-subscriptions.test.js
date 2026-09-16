const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-subscriptions-'));
process.env.QMREADER_DATA_DIR = dir;
process.env.QMREADER_DB_FILE = path.join(dir, 'qmreader.sqlite');
const store = require('../lib/store');
const subscriptions = require('../lib/subscriptions');
const fetcher = require('../lib/fetcher');
const { SOURCES } = require('../lib/sources');
const options = { checkUrl: async url => url };
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('custom subscriptions persist across processes and current worker registry sees changes', async () => {
  const source = await subscriptions.createSource({ name: 'Feed', feeds: ['https://EXAMPLE.com:443/rss#top'], category: 'news' }, options);
  assert.deepEqual(source.feeds, ['https://example.com/rss']);
  assert.equal(fetcher.getSourceById(source.id).name, 'Feed');
  await subscriptions.updateSource(source.id, { name: 'Renamed', enabled: false }, options);
  assert.equal(fetcher.isEnabled(source), false);
  const restarted = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require('./lib/subscriptions').getSources()))`], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.equal(JSON.parse(restarted.stdout).find(item => item.id === source.id).name, 'Renamed');
  await assert.rejects(subscriptions.createSource({ name: 'Duplicate', feeds: ['https://example.com/rss#other'] }, options), { statusCode: 409 });
});

test('built-in metadata edits preserve advanced adapters; SQLite enabled wins over legacy state', async () => {
  const builtin = SOURCES.find(source => source.id === 'james-clear');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ [builtin.id]: { enabled: false } }));
  fetcher.loadDisk();
  assert.equal(fetcher.isEnabled(builtin), false);
  const edited = await subscriptions.updateSource(builtin.id, { name: 'My newsletter', feeds: builtin.feeds, enabled: true }, options);
  assert.deepEqual(edited.feeds, builtin.feeds);
  fetcher.loadDisk();
  assert.equal(fetcher.isEnabled(builtin), true);
  assert.equal(fetcher.getSourceById(builtin.id).name, 'My newsletter');
  await assert.rejects(subscriptions.updateSource(builtin.id, { feeds: ['wpjson:https://example.com/a'] }, options), { statusCode: 400 });
});

test('soft deletion stops fetching/sidebar but retains entries, read, star, history and restore', async () => {
  const source = await subscriptions.createSource({ name: 'Archive', feeds: ['https://archive.example.com/rss'] }, options);
  const entry = { id: 'retained-entry', sourceId: source.id, title: 'Retained', publishedTs: 1, content: 'Body' };
  fs.writeFileSync(path.join(dir, 'cache.json'), JSON.stringify({ [source.id]: { entries: [entry], status: 'ok' } }));
  fetcher.loadDisk();
  const user = store.getPersonalUser();
  store.setUserEntryState(user.id, entry.id, { read: true, starred: true, viewed: true });
  const before = store.getUserEntryStates(user.id);
  await subscriptions.updateSource(source.id, { deleted: true }, options);
  assert.equal(fetcher.isEnabled(source), false);
  assert.equal(fetcher.getSourcesMeta().some(item => item.id === source.id), false);
  assert.equal(fetcher.getSourcesMeta({ includeDeleted: true }).find(item => item.id === source.id).deleted, true);
  assert.equal(fetcher.getEntryById(entry.id).title, 'Retained');
  assert.equal(fetcher.getEntries().some(item => item.id === entry.id), true);
  assert.deepEqual(store.getUserEntryStates(user.id), before);
  // A stale worker source object cannot fetch after deletion.
  assert.equal((await fetcher.fetchSource(source)).status, 'ok');
  await subscriptions.updateSource(source.id, { deleted: false }, options);
  assert.equal(fetcher.isEnabled(source), true);
});

test('URL and OPML imports return per-item outcomes and deduplicate normalized URLs', async () => {
  const result = await subscriptions.importSources({ format: 'urls', content: 'https://import.example.com/rss\nhttps://IMPORT.example.com:443/rss#x\nfile:///etc/passwd' }, options);
  assert.deepEqual([result.added, result.skipped, result.failed], [1, 1, 1]);
  const opml = await subscriptions.importSources({ format: 'opml', content: '<?xml version="1.0"?><opml version="2.0"><body><outline text="Folder"><outline text="A &amp; B" xmlUrl="https://opml.example.com/feed?a=1&amp;b=2"/><outline type="rss"/></outline></body></opml>' }, options);
  assert.deepEqual([opml.added, opml.skipped, opml.failed], [1, 0, 1]);
  assert.equal(opml.results[0].name, 'A & B');
  assert.equal(opml.results[0].url, 'https://opml.example.com/feed?a=1&b=2');
  for (const content of ['<opml><body></opml>', '<notopml/>', '<!DOCTYPE opml [<!ENTITY x SYSTEM "file:///etc/passwd">]><opml/>']) {
    assert.throws(() => subscriptions.parseImport('opml', content), { statusCode: 400 });
  }
  assert.throws(() => subscriptions.parseImport('urls', Array(201).fill('https://example.com').join('\n')), { statusCode: 400 });
  assert.throws(() => subscriptions.parseImport('urls', 'x'.repeat(1024 * 1024 + 1)), { statusCode: 400 });
});

test('user RSS validation rejects private addresses, credentials and malformed fields without fetching', async () => {
  for (const url of ['http://127.0.0.1/rss', 'http://[::1]/rss', 'http://169.254.169.254/latest/meta-data', 'http://2130706433/rss', 'https://user:pass@example.com/rss', 'file:///etc/passwd', 'wpjson:https://example.com/rss']) {
    await assert.rejects(subscriptions.createSource({ name: 'Unsafe', feeds: [url] }), { statusCode: 400 });
  }
  for (const fields of [{ name: '' }, { enabled: 'true' }, { feeds: [] }, { category: '<x>' }]) {
    await assert.rejects(subscriptions.createSource({ name: 'Bad', feeds: ['https://valid.example.com/rss'], ...fields }, options), { statusCode: 400 });
  }
});

test('HTTP personal subscription routes enforce origin, CRUD contracts and keep ordinary role', async () => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const httpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-subscription-http-'));
  const root = path.join(__dirname, '..');
  // DNS validation is covered above; this fixture prevents all upstream networking.
  const preload = path.join(httpDir, 'preload.cjs');
  fs.writeFileSync(preload, `require(${JSON.stringify(path.join(root, 'lib/fetcher'))}).assertPublicHttpUrl = async url => url;`);
  const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
    cwd: root, env: { ...process.env, QMREADER_DATA_DIR: httpDir, QMREADER_DB_FILE: path.join(httpDir, 'qmreader.sqlite'), HOST: '127.0.0.1', PORT: '0', STARTUP_REFRESH_DELAY_MS: '-1', FRESHNESS_SWEEP_INTERVAL_MS: '-1', PUBLIC_ORIGIN: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
      child.stdout.on('data', data => { const match = String(data).match(/listening on http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const request = (method, url, body, origin = base) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Origin: origin }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.equal((await request('POST', '/api/me/sources', { name: 'Blocked', feeds: ['https://test.example/feed'] }, 'https://foreign.example')).status, 403);
    let response = await request('POST', '/api/me/sources', { name: 'HTTP', feeds: ['https://test.example/feed'], enabled: false });
    assert.equal(response.status, 201);
    const { source } = await response.json();
    assert.equal(source.builtin, false);
    assert.equal(source.enabled, false);
    assert.deepEqual(source.feeds, ['https://test.example/feed']);
    response = await request('PATCH', `/api/me/sources/${source.id}`, { name: 'Edited' });
    assert.equal((await response.json()).source.name, 'Edited');
    assert.equal((await request('DELETE', `/api/me/sources/${source.id}`)).status, 200);
    const managed = await (await request('GET', '/api/me/sources')).json();
    assert.equal(managed.sources.find(item => item.id === source.id).deleted, true);
    assert.equal(managed.sources.some(item => item.manual), false);
    assert.equal((await request('DELETE', '/api/me/sources/user-submitted')).status, 400);
    const sidebar = await (await request('GET', '/api/sources')).json();
    assert.equal(sidebar.sources.some(item => item.id === source.id), false);
    response = await request('POST', '/api/me/sources/import', { format: 'urls', content: 'https://test.example/feed#same\ninvalid' });
    const imported = await response.json();
    assert.deepEqual([imported.added, imported.skipped, imported.failed], [0, 1, 1]);
    assert.equal((await request('PATCH', '/api/me/sources/missing', { name: 'no' })).status, 404);
    assert.equal((await (await request('GET', '/api/me')).json()).user.role, 'user');
    assert.equal((await request('POST', '/api/sources/james-clear/toggle', {})).status, 403);
  } finally {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    fs.rmSync(httpDir, { recursive: true, force: true });
  }
});

test('imports bound DNS concurrency, preserve input order, and share duplicate outcomes', async () => {
  let active = 0;
  let peak = 0;
  let calls = 0;
  const checkUrl = async url => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, url.includes('/0') ? 12 : 2));
    active--;
    if (url.includes('/bad')) throw new Error('DNS failed');
    return url;
  };
  const urls = Array.from({ length: 16 }, (_, i) => `https://parallel.example.com/${i}`);
  urls.splice(1, 0, `${urls[0]}#duplicate`);
  urls.push('https://parallel.example.com/bad', 'https://parallel.example.com/bad#duplicate');
  const result = await subscriptions.importSources({ format: 'urls', content: urls.join('\n') }, { checkUrl });
  assert.deepEqual([result.added, result.skipped, result.failed], [16, 1, 2]);
  assert.equal(calls, 17);
  assert.ok(peak > 1 && peak <= 6, `peak concurrency ${peak}`);
  assert.equal(result.results[0].status, 'added');
  assert.equal(result.results[1].status, 'skipped');
  assert.equal(result.results[2].url, urls[2]);
  assert.equal(result.results.at(-1).status, 'failed');
});

test('saved, read and history articles survive rolling cache loss and list truncation', async () => {
  const source = await subscriptions.createSource({ name: 'Retained archive', feeds: ['https://retained.example.com/feed'] }, options);
  const old = [
    { id: 'old-star', sourceId: source.id, title: 'Old favorite', publishedTs: 1 },
    { id: 'old-history', sourceId: source.id, title: 'Old viewed', publishedTs: 2 },
    { id: 'old-read', sourceId: source.id, title: 'Old read', publishedTs: 3 },
  ];
  const fresh = Array.from({ length: 6 }, (_, i) => ({ id: `recent-${i}`, sourceId: source.id, title: 'Recent', publishedTs: 100 + i }));
  store.upsertEntries(old);
  fs.writeFileSync(path.join(dir, 'cache.json'), JSON.stringify({ [source.id]: { entries: fresh, status: 'ok' } }));
  fetcher.loadDisk();
  const viewer = store.getPersonalUser();
  store.setUserEntryState(viewer.id, old[0].id, { starred: true });
  store.setUserEntryState(viewer.id, old[1].id, { viewed: true });
  store.setUserEntryState(viewer.id, old[2].id, { read: true });
  await subscriptions.updateSource(source.id, { deleted: true }, options);
  await subscriptions.updateSource(source.id, { name: 'Renamed retained archive' }, options);
  const entries = fetcher.getEntries({ sourceId: source.id, viewer, limit: 2 });
  assert.equal(entries.length, 5);
  assert.ok(entries.every(entry => entry.sourceName === 'Renamed retained archive'));
  assert.equal(fetcher.getEntryById('old-star', viewer).sourceName, 'Renamed retained archive');
  assert.equal(fetcher.getSourcesMeta().some(item => item.id === source.id), false);
  for (const entry of old) assert.ok(entries.some(item => item.id === entry.id), entry.id);
  const searched = fetcher.getEntries({ sourceId: source.id, viewer, limit: 1, q: 'favorite' });
  assert.deepEqual(searched.map(item => item.id), ['old-star']);
  const restarted = spawnSync(process.execPath, ['-e', `
    const fetcher = require('./lib/fetcher'); fetcher.loadDisk();
    const viewer = require('./lib/store').getPersonalUser();
    process.stdout.write(JSON.stringify(fetcher.getEntries({sourceId:${JSON.stringify(source.id)},viewer,limit:2}).map(e=>({id:e.id,sourceName:e.sourceName}))));
  `], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert.equal(restarted.status, 0, restarted.stderr);
  const restartedEntries = JSON.parse(restarted.stdout);
  for (const entry of old) {
    assert.equal(restartedEntries.find(item => item.id === entry.id).sourceName, 'Renamed retained archive');
  }
});

test('manual submissions cannot be changed through RSS management', async () => {
  const manual = subscriptions.getSources().find(source => source.manual);
  assert.ok(manual);
  for (const patch of [{ deleted: true }, { enabled: false }, { name: 'Changed' }, { feeds: ['https://example.com/feed'] }]) {
    await assert.rejects(subscriptions.updateSource(manual.id, patch, options), { statusCode: 400 });
  }
  assert.equal(fetcher.getSourceById(manual.id).name, manual.name);
});

test('pin state persists per source and survives process restart', async () => {
  const source = await subscriptions.createSource({ name: 'Pinned Feed', feeds: ['https://example.com/pin-feed'] }, options);
  assert.equal(source.pinned, undefined);
  const pinned = await subscriptions.updateSource(source.id, { pinned: true }, options);
  assert.equal(pinned.pinned, true);
  const other = await subscriptions.createSource({ name: 'Other Feed', feeds: ['https://example.com/other-feed'] }, options);
  const unchanged = subscriptions.getSources().find(item => item.id === other.id);
  assert.equal(unchanged.pinned, undefined);
  const meta = fetcher.getSourcesMeta({ includeDeleted: true }).find(item => item.id === source.id);
  assert.equal(meta.pinned, true);
  await assert.rejects(subscriptions.updateSource(source.id, { pinned: 'yes' }, options), { statusCode: 400 });
});


test('moving a source through all categories preserves its identity, feeds and pin across restart', async () => {
  const source = await subscriptions.createSource({ name: 'Move category', feeds: ['https://move.example.com/rss'], enabled: false, pinned: true }, options);
  for (const category of ['news', 'podcast', 'article']) {
    const moved = await subscriptions.updateSource(source.id, { category }, options);
    assert.equal(moved.category, category);
    assert.equal(moved.id, source.id);
    assert.equal(moved.pinned, true);
    assert.equal(moved.enabled, false);
    assert.deepEqual(moved.feeds, source.feeds);
    assert.equal(fetcher.getSourcesMeta().find(item => item.id === source.id).category, category);
  }
  await subscriptions.updateSource(source.id, { category: 'podcast' }, options);
  const restarted = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require('./lib/subscriptions').getSources()))`], { cwd: path.join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert.equal(restarted.status, 0, restarted.stderr);
  const saved = JSON.parse(restarted.stdout).find(item => item.id === source.id);
  assert.equal(saved.category, 'podcast');
  assert.equal(saved.pinned, true);
  await assert.rejects(subscriptions.updateSource(source.id, { category: '' }, options), { statusCode: 400 });
  const custom = await subscriptions.updateSource(source.id, { category: '科技前沿' }, options);
  assert.equal(custom.category, '科技前沿');
  assert.equal(subscriptions.getSources().find(item => item.id === source.id).category, '科技前沿');
});

test('URL imports derive site origin for favicons and mark auto-named entries', async () => {
  const result = await subscriptions.importSources({ format: 'urls', content: 'https://icon-import.example.com/feed' }, options);
  assert.equal(result.added, 1);
  const item = result.results[0];
  assert.equal(item.status, 'added');
  assert.equal(item.autoNamed, true);
  assert.equal(item.name, 'icon-import.example.com');
  const saved = subscriptions.getSources().find(source => source.id === item.id);
  assert.equal(saved.siteUrl, 'https://icon-import.example.com/');
});

test('purging deleted sources removes custom overrides and permanently hides builtins', async () => {
  const custom = await subscriptions.createSource({ name: '待清除', feeds: ['https://purge.example.com/rss'] }, options);
  await subscriptions.updateSource(custom.id, { deleted: true }, options);
  const builtinId = SOURCES[0].id;
  await subscriptions.updateSource(builtinId, { deleted: true }, options);
  const before = subscriptions.getSources().filter(item => item.deleted);
  assert.ok(before.some(item => item.id === custom.id));
  const result = subscriptions.purgeDeletedSources();
  assert.equal(result.purged, before.length);
  const after = subscriptions.getSources();
  assert.ok(!after.some(item => item.id === custom.id));
  const builtin = after.find(item => item.id === builtinId);
  assert.equal(builtin.deleted, true);
  assert.equal(builtin.purged, true);
  await subscriptions.updateSource(builtinId, { deleted: false }, options);
});
