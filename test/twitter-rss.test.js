const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

// Data dir must be pinned before any module loads its own path resolution.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmreader-twitter-rss-'));
process.env.QMREADER_DATA_DIR = testDataDir;
delete process.env.QMREADER_DB_FILE;
process.env.RSSHUB_INTERNAL_ORIGIN = 'http://rsshub-x:1200';

const routing = require('../lib/rsshub-routing');
const subscriptions = require('../lib/subscriptions');
const fetcher = require('../lib/fetcher');

after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

const okCheck = async () => 'checked';

test('twitterRouteFromUrl accepts only the strict user route on known RSSHub hosts', () => {
  assert.deepEqual(
    routing.twitterRouteFromUrl('https://rsshub.app/twitter/user/zaobaosg'),
    { username: 'zaobaosg', query: '' },
  );
  assert.deepEqual(
    routing.twitterRouteFromUrl('https://rsshub.rssforever.com/twitter/user/WaylyBaye?readable=1'),
    { username: 'WaylyBaye', query: 'readable=1' },
  );
  assert.deepEqual(
    routing.twitterRouteFromUrl('{rsshub}/twitter/user/x_01'),
    { username: 'x_01', query: '' },
  );
  for (const bad of [
    'https://rsshub.app/twitter/user/',
    'https://rsshub.app/twitter/user/a/b',
    'https://rsshub.app/twitter/followings/x',
    'https://rsshub.app/twitter/list/x/y',
    'https://evil.example.com/twitter/user/x',
    'https://rsshub.app/blog/x',
    '{rsshub}/twitter/user/../etc',
    'https://rsshub.app/twitter/user/over_15_characters_long_name',
    'not a url',
  ]) {
    assert.equal(routing.twitterRouteFromUrl(bad), null, bad);
  }
});

test('internalFeedUrl builds a constrained internal target', () => {
  assert.equal(
    routing.internalFeedUrl('{rsshub}/twitter/user/zaobaosg', 'http://rsshub-x:1200'),
    'http://rsshub-x:1200/twitter/user/zaobaosg',
  );
  assert.equal(
    routing.internalFeedUrl('{rsshub}/twitter/user/a?readable=1&count=20', 'http://rsshub-x:1200'),
    'http://rsshub-x:1200/twitter/user/a?readable=1&count=20',
  );
  assert.equal(routing.internalFeedUrl('{rsshub}/tldr/ai', 'http://rsshub-x:1200'), null);
  assert.equal(routing.internalFeedUrl('https://example.org/feed', 'http://rsshub-x:1200'), null);
  assert.equal(routing.internalFeedUrl('{rsshub}/twitter/user/a', 'https://rsshub-x:1200/path'), null);
});

test('expandFeedCandidates routes twitter through the internal channel only', () => {
  assert.deepEqual(
    routing.expandFeedCandidates('{rsshub}/twitter/user/x', 'http://rsshub-x:1200'),
    ['http://rsshub-x:1200/twitter/user/x'],
  );
  // Without an internal origin the historical public fallback applies.
  const publicFallback = routing.expandFeedCandidates('{rsshub}/twitter/user/x', null);
  assert.ok(publicFallback.length > 1 && publicFallback.every(url => url.includes('/twitter/user/x')));
  // Non-twitter RSSHub routes never use the internal channel.
  const nonTwitter = routing.expandFeedCandidates('{rsshub}/tldr/ai', 'http://rsshub-x:1200');
  assert.deepEqual(nonTwitter, nonTwitter.filter(url => !url.startsWith('http://rsshub-x:1200')));
  assert.deepEqual(routing.expandFeedCandidates('https://example.org/feed', 'http://rsshub-x:1200'), ['https://example.org/feed']);
});

test('createSource stores the logical form, validates against the internal channel, and lifts the entry limit', async () => {
  const seen = [];
  const created = await subscriptions.createSource(
    { name: '早报', category: 'article', feeds: ['https://rsshub.app/twitter/user/zaobaosg'] },
    { checkUrl: async url => { seen.push(url); return 'checked'; } },
  );
  assert.deepEqual(created.feeds, ['{rsshub}/twitter/user/zaobaosg']);
  assert.deepEqual(seen, ['http://rsshub-x:1200/twitter/user/zaobaosg']);
  assert.equal(created.limit, 30);
  // Editing to another twitter account keeps the internal validation and the raised limit.
  const seenEdit = [];
  const edited = await subscriptions.updateSource(
    created.id,
    { feeds: ['https://rsshub.app/twitter/user/waylybaye'] },
    { checkUrl: async url => { seenEdit.push(url); return 'checked'; } },
  );
  assert.deepEqual(edited.feeds, ['{rsshub}/twitter/user/waylybaye']);
  assert.deepEqual(seenEdit, ['http://rsshub-x:1200/twitter/user/waylybaye']);
  assert.equal(edited.limit, 30);
});

test('fetchInternalText follows same-origin redirects only and reports upstream failures', async () => {
  const body = ['<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>'];
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    if (req.url === '/twitter/user/ok') { res.end(body[0]); return; }
    if (req.url === '/twitter/user/same') { res.writeHead(302, { location: 'http://127.0.0.1:' + server.address().port + '/twitter/user/ok' }); res.end(); return; }
    if (req.url === '/twitter/user/cross') { res.writeHead(302, { location: 'https://example.com/x' }); res.end(); return; }
    if (req.url === '/twitter/user/dead') { res.writeHead(503); res.end('upstream'); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  process.env.RSSHUB_INTERNAL_ORIGIN = base;
  try {
    const direct = await fetcher.fetchInternalText(base + '/twitter/user/ok', { timeout: 2000 });
    assert.ok(direct.includes('<rss'));
    const redirected = await fetcher.fetchInternalText(base + '/twitter/user/same', { timeout: 2000 });
    assert.ok(redirected.includes('<rss'));
    await assert.rejects(fetcher.fetchInternalText(base + '/twitter/user/cross', { timeout: 2000 }), /越界|redirect/i);
    await assert.rejects(fetcher.fetchInternalText(base + '/twitter/user/dead', { timeout: 2000 }), /503/);
    await assert.rejects(fetcher.fetchInternalText(base + '/other/route', { timeout: 2000 }), /内部|twitter/i);
  } finally {
    server.close();
    process.env.RSSHUB_INTERNAL_ORIGIN = 'http://rsshub-x:1200';
  }
  assert.ok(hits >= 5);
});

test('preview and subscribe use the internal channel without leaking it', async () => {
  const rss = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<rss version="2.0"><channel><title>Test User</title><link>https://x.com/testuser</link>'
    + '<item><title>Post 1</title><link>https://x.com/testuser/status/1</link>'
    + '<pubDate>Mon, 21 Sep 2026 00:00:00 GMT</pubDate><description>hello</description></item>'
    + '</channel></rss>';
  const stub = http.createServer((req, res) => {
    if (req.url === '/twitter/user/testuser') { res.setHeader('content-type', 'application/xml'); res.end(rss); return; }
    if (req.url === '/twitter/user/empty') {
      res.setHeader('content-type', 'application/xml');
      res.end('<?xml version="1.0"?><rss version="2.0"><channel><title>Empty</title><link>https://x.com/empty</link></channel></rss>');
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  const stubBase = 'http://127.0.0.1:' + stub.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-twitter-e2e-'));
  const root = path.join(__dirname, '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      RSSHUB_INTERNAL_ORIGIN: stubBase,
      QMREADER_DATA_DIR: dir,
      QMREADER_DB_FILE: path.join(dir, 'qmreader.sqlite'),
      HOST: '127.0.0.1', PORT: '0',
      STARTUP_REFRESH_DELAY_MS: '-1', FRESHNESS_SWEEP_INTERVAL_MS: '-1', TWITTER_SWEEP_INTERVAL_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
      child.stdout.on('data', data => {
        const match = String(data).match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const headers = { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' };

    const preview = await (await fetch(base + '/api/me/rss-preview', {
      method: 'POST', headers, body: JSON.stringify({ url: 'https://rsshub.app/twitter/user/testuser' }),
    })).json();
    assert.equal(preview.url, '{rsshub}/twitter/user/testuser');
    assert.equal(preview.title, 'Test User');
    assert.equal(preview.itemCount, 1);
    assert.equal(preview.siteUrl, 'https://x.com/testuser');
    assert.ok(!JSON.stringify(preview).includes(stubBase), 'internal origin must not leak');

    const empty = await fetch(base + '/api/me/rss-preview', {
      method: 'POST', headers, body: JSON.stringify({ url: 'https://rsshub.app/twitter/user/empty' }),
    });
    const emptyBody = await empty.json();
    // An empty RSS shell must not be reported as a usable feed.
    assert.equal(empty.status, 422);
    assert.match(emptyBody.error, /有效内容|条目/);
    assert.ok(!JSON.stringify(emptyBody).includes(stubBase), 'internal origin must not leak');

    const created = await (await fetch(base + '/api/me/sources', {
      method: 'POST', headers, body: JSON.stringify({ name: 'Test', category: 'article', feeds: ['https://rsshub.app/twitter/user/testuser'], siteUrl: 'https://x.com/testuser' }),
    })).json();
    assert.equal(created.source.feeds[0], '{rsshub}/twitter/user/testuser');
    assert.ok(!JSON.stringify(created).includes(stubBase));
  } finally {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    fs.rmSync(dir, { recursive: true, force: true });
    stub.close();
  }
});

test('public feed preview failures are not mislabeled as internal channel', async () => {
  // Regression for the 36kr report: with the internal RSSHub configured, a
  // public URL that fails must not be labeled 内部通道 in the error message.
  const stub = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  const stubBase = 'http://127.0.0.1:' + stub.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-preview-label-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      RSSHUB_INTERNAL_ORIGIN: stubBase,
      QMREADER_DATA_DIR: dir,
      QMREADER_DB_FILE: path.join(dir, 'qmreader.sqlite'),
      HOST: '127.0.0.1', PORT: '0',
      STARTUP_REFRESH_DELAY_MS: '-1', FRESHNESS_SWEEP_INTERVAL_MS: '-1', TWITTER_SWEEP_INTERVAL_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
      child.stdout.on('data', data => {
        const match = String(data).match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const headers = { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' };
    // 127.0.0.1:1 refuses connections -> a plain public-URL failure.
    const response = await fetch(base + '/api/me/rss-preview', {
      method: 'POST', headers, body: JSON.stringify({ url: 'http://127.0.0.1:1/feed' }),
    });
    const body = await response.json();
    assert.equal(response.status, 422);
    assert.ok(!String(body.error).includes('内部通道'), `error mislabeled: ${body.error}`);
    assert.match(String(body.error), /127\.0\.0\.1:1|无法解析/);
  } finally {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    fs.rmSync(dir, { recursive: true, force: true });
    stub.close();
  }
});

test('36kr newsflashes preview goes through the internal channel end to end', async () => {
  const rss = '<?xml version="1.0" encoding="UTF-8"?>'
    + '<rss version="2.0"><channel><title>36氪 - 快讯</title><link>https://www.36kr.com/newsflashes</link>'
    + '<item><title>小米18 Pro系列发布</title><link>https://www.36kr.com/p/123</link>'
    + '<pubDate>Wed, 23 Sep 2026 12:21:05 GMT</pubDate><description>快讯内容</description></item>'
    + '</channel></rss>';
  const stub = http.createServer((req, res) => {
    if (req.url === '/36kr/newsflashes') { res.setHeader('content-type', 'application/xml'); res.end(rss); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  const stubBase = 'http://127.0.0.1:' + stub.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-36kr-e2e-'));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      RSSHUB_INTERNAL_ORIGIN: stubBase,
      QMREADER_DATA_DIR: dir,
      QMREADER_DB_FILE: path.join(dir, 'qmreader.sqlite'),
      HOST: '127.0.0.1', PORT: '0',
      STARTUP_REFRESH_DELAY_MS: '-1', FRESHNESS_SWEEP_INTERVAL_MS: '-1', TWITTER_SWEEP_INTERVAL_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
      child.stdout.on('data', data => {
        const match = String(data).match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const headers = { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' };
    const preview = await (await fetch(base + '/api/me/rss-preview', {
      method: 'POST', headers, body: JSON.stringify({ url: 'https://rsshub.app/36kr/newsflashes' }),
    })).json();
    assert.equal(preview.url, '{rsshub}/36kr/newsflashes');
    assert.equal(preview.title, '36氪 - 快讯');
    assert.equal(preview.itemCount, 1);
    assert.equal(preview.siteUrl, 'https://www.36kr.com/newsflashes');
    assert.ok(!JSON.stringify(preview).includes(stubBase), 'internal origin must not leak');

    const created = await (await fetch(base + '/api/me/sources', {
      method: 'POST', headers, body: JSON.stringify({ name: '36氪快讯', category: 'news', feeds: ['https://rsshub.app/36kr/newsflashes'] }),
    })).json();
    assert.equal(created.source.feeds[0], '{rsshub}/36kr/newsflashes');
    assert.ok(!JSON.stringify(created).includes(stubBase));
  } finally {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    fs.rmSync(dir, { recursive: true, force: true });
    stub.close();
  }
});

test('fetchInternalText retries once on transient upstream failures and then gives up', async () => {
  const body = '<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>';
  const hits = [];
  const flaky = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/twitter/user/flaky' && hits.filter(u => u === '/twitter/user/flaky').length === 1) {
      res.writeHead(503); res.end('upstream'); return;
    }
    if (req.url === '/twitter/user/flaky') { res.end(body); return; }
    if (req.url === '/twitter/user/always') { res.writeHead(503); res.end(); return; }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => flaky.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + flaky.address().port;
  process.env.RSSHUB_INTERNAL_ORIGIN = base;
  try {
    const recovered = await fetcher.fetchInternalText(base + '/twitter/user/flaky', { timeout: 3000, retryDelayMs: 10 });
    assert.ok(recovered.includes('<rss'));
    await assert.rejects(fetcher.fetchInternalText(base + '/twitter/user/always', { timeout: 3000, retryDelayMs: 10 }), /503/);
  } finally {
    flaky.close();
    process.env.RSSHUB_INTERNAL_ORIGIN = 'http://rsshub-x:1200';
  }
  assert.equal(hits.filter(u => u === '/twitter/user/flaky').length, 2);
  assert.equal(hits.filter(u => u === '/twitter/user/always').length, 2);
});
