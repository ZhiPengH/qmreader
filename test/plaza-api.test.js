const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.join(__dirname, '..');

// Real HTTP server and SQLite. Only the outbound provider is a deterministic fixture.
async function fixture(t, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-plaza-api-'));
  const preload = path.join(dir, 'isolation.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const path = require('node:path');
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (/^\\.env(?:\\.|$)/.test(path.basename(String(file)))) throw new Error('dotenv blocked by test');
      return read.call(this, file, ...args);
    };
    global.fetch = async (url, options) => {
      if (!String(url).startsWith('https://plaza-provider.example/')) throw new Error('external network blocked by test');
      const body = JSON.parse(options.body);
      const input = JSON.parse(body.messages.at(-1).content);
      fs.appendFileSync(path.join(process.env.QMREADER_DATA_DIR, 'provider.jsonl'), JSON.stringify({ url, input }) + '\\n');
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ entries: input.entries.map(e => ({ entryId: e.entryId, tags: [{ name: 'AI', kind: 'topic' }] })) }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
  `);
  // Deliberately do not inherit process.env: no real AI keys, NODE_OPTIONS, DB_FILE or dotenv.
  const env = { PATH: process.env.PATH, TZ: 'UTC', QMREADER_DATA_DIR: dir,
    QMREADER_DB_FILE: path.join(dir, 'qmreader.sqlite'), HOST: '127.0.0.1', PORT: '0',
    STARTUP_REFRESH_DELAY_MS: '-1', FRESHNESS_SWEEP_INTERVAL_MS: '-1', OFFLINE_PREFETCH_HOUR: '-1', ...extraEnv };
  function db(code) {
    const result = spawnSync(process.execPath, ['--require', preload, '-e', `const store = require('./lib/store'); ${code}`], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  db(`store.upsertEntries(Array.from({ length: 410 }, (_, i) => ({ id: 'pool-' + i, sourceId: i ? 'hackernews' : 'disabled-source', title: 'Article ' + i, summary: 'Summary ' + i, content: '<p>Private body</p>', publishedTs: i + 1 }))); store.saveSourceOverride('disabled-source', { enabled: false });`);
  const child = spawn(process.execPath, ['--require', preload, 'server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('startup timeout: ' + stderr)), 10000);
    child.stdout.on('data', chunk => {
      const match = String(chunk).match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`startup exit ${code}: ${stderr}`)); });
  });
  async function request(route, { method = 'GET', body, headers = {}, status = 200 } = {}) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    assert.equal(response.status, status, `${route}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
  return { request, db, calls: () => fs.existsSync(path.join(dir, 'provider.jsonl')) ? fs.readFileSync(path.join(dir, 'provider.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

test('query validation rejects malformed values without repairing IDs or accepting legacy cursors', async t => {
  const { request } = await fixture(t);
  for (const suffix of ['mode=nope', 'mode[]=all', 'mode=all&mode=random', 'sort=asc', 'sort=', 'unread=true', 'limit=0', 'limit=101', 'limit=2.5', 'limit=02', 'seed[]=x', 'cursor=x', 'batch=2', 'limit=9007199254740992']) {
    await request('/api/plaza?' + suffix, { status: 400 });
  }
  for (const suffix of ['', 'ids=', 'ids[]=pool-1', 'ids=pool-1,%20pool-2', 'ids=pool-1,,pool-2', 'ids=' + Array(101).fill('pool-1').join(',')]) {
    await request('/api/plaza/entries?' + suffix, { status: 400 });
  }
  for (const suffix of ['after=-1', 'after=1.2', 'after=NaN', 'after=01', 'after[]=1', 'cursor=1']) {
    await request('/api/plaza/status?' + suffix, { status: 400 });
  }
  const a = await request('/api/plaza?mode=random&seed=stable');
  const b = await request('/api/plaza?mode=random&seed=stable');
  assert.deepEqual(a.order, b.order);
  assert.equal((await request('/api/plaza?mode=personal&unread=1&limit=1')).entries.length, 1);
});

test('full library manifest exceeds 400 and remains usable after arrivals and deletion', async t => {
  const { request, db } = await fixture(t);
  const first = await request('/api/plaza?mode=all&sort=oldest&unread=0&seed=batch&limit=24');
  assert.equal(first.total, 410);
  assert.equal(first.order.length, 410);
  assert.equal(new Set(first.order).size, 410);
  assert.equal(first.entries.length, 24);
  assert.deepEqual(first.entries.map(e => e.id), first.order.slice(0, 24));
  assert.equal(first.order[0], 'pool-0');
  assert.equal(Number.isInteger(first.revision), true);
  for (const entry of first.entries) {
    assert.equal(Object.hasOwn(entry, 'content'), false);
    assert.equal(typeof entry.sourceName, 'string');
    assert.equal(typeof entry.category, 'string');
  }
  db(`store.upsertEntries([{id:'arrival',sourceId:'test',title:'New',publishedTs:999}]);`);
  const status = await request('/api/plaza/status?after=' + first.revision);
  assert.equal(status.newCount, 1);
  assert.equal(status.total, 411);
  const ids = first.order.slice(24, 48).reverse();
  const next = await request('/api/plaza/entries?ids=' + encodeURIComponent(ids.join(',')));
  assert.deepEqual(next.entries.map(e => e.id), ids);
  assert.equal(next.entries.some(e => Object.hasOwn(e, 'content')), false);
  const missing = await request('/api/plaza/entries?ids=pool-3,missing,pool-2');
  assert.deepEqual(missing.entries.map(e => e.id), ['pool-3', 'pool-2']);
  assert.equal(first.order.includes('arrival'), false);
});

test('category 过滤：只返回该分类的文章并聚合 categories 清单', async t => {
  const { request, db } = await fixture(t);
  // 分池：hackernews(news 类) pool-0..409 中前 300 篇划给 podcast 源，验证过滤与清单
  db(`store.upsertEntries(Array.from({ length: 90 }, (_, i) => ({ id: 'cat-' + i, sourceId: 'lexfridman', title: 'Pod ' + i, publishedTs: 1000 + i })));`);
  const all = await request('/api/plaza?mode=all&limit=100');
  assert.ok(Array.isArray(all.categories) && all.categories.length >= 1, '响应要带 categories 清单');
  const news = await request('/api/plaza?mode=all&limit=100&category=news');
  assert.equal(news.total, 409); // 410 - 1(disabled-source)
  assert.ok(news.entries.every(e => e.category === 'news'));
  const pod = await request('/api/plaza?mode=all&limit=100&category=podcast');
  assert.equal(pod.total, 90);
  assert.ok(pod.entries.every(e => e.category === 'podcast'));
  // 非法分类值被 400 拒绝（严格校验语义）
  await request('/api/plaza?category=<script>', { status: 400 });
  await request('/api/plaza?category=' + 'x'.repeat(25), { status: 400 });
});
