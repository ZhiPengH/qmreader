const { after, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const vm = require('node:vm');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmreader-twitter-avatar-'));
process.env.QMREADER_DATA_DIR = testDataDir;
delete process.env.QMREADER_DB_FILE;
const fetcher = require('../lib/fetcher');
const appSource = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');

after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

function startServer({ dir, rsshubOrigin, preload, fetchLog }) {
  const root = path.join(__dirname, '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      RSSHUB_INTERNAL_ORIGIN: rsshubOrigin,
      QMREADER_DATA_DIR: dir,
      QMREADER_DB_FILE: path.join(dir, 'qmreader.sqlite'),
      AVATAR_FETCH_LOG: fetchLog,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' '),
      HOST: '127.0.0.1',
      PORT: '0',
      STARTUP_REFRESH_DELAY_MS: '-1',
      FRESHNESS_SWEEP_INTERVAL_MS: '-1',
      TWITTER_SWEEP_INTERVAL_MS: '-1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    child.stdout.on('data', data => {
      const match = String(data).match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
  });
  return { child, ready };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  const stopped = once(child, 'exit');
  child.kill();
  await stopped;
}

function sourceIconHarness() {
  const context = {
    domainOf(value) {
      try { return new URL(value).hostname; } catch { return ''; }
    },
    escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
    },
    escapeJsString(value) { return String(value).replace(/[\\'"\n\r]/g, '\\$&'); },
  };
  vm.createContext(context);
  const start = appSource.indexOf('function fallbackFavicon(');
  const end = appSource.indexOf('function isLikelyEnglishTitle(', start);
  vm.runInContext(appSource.slice(start, end), context);
  return context;
}

test('Twitter avatar extraction accepts only pbs.twimg.com profile images for Twitter feeds', () => {
  const extract = fetcher.__test.twitterAvatarUrl;
  assert.equal(typeof extract, 'function', 'fetcher must expose its Twitter avatar validator for regression tests');
  const source = { feeds: ['{rsshub}/twitter/user/baoshu88'] };
  const avatar = 'https://pbs.twimg.com/profile_images/123/avatar.jpg';
  assert.equal(extract(source, { image: { url: avatar } }), avatar);
  assert.equal(extract(source, { image: { url: 'http://pbs.twimg.com/profile_images/123/avatar.jpg' } }), '');
  assert.equal(extract(source, { image: { url: 'https://pbs.twimg.com/media/post.jpg' } }), '');
  assert.equal(extract(source, { image: { url: 'https://evil.example/profile_images/avatar.jpg' } }), '');
  assert.equal(extract({ feeds: ['https://example.com/feed.xml'] }, { image: { url: avatar } }), '');
});

test('Twitter source icons use the same-origin cached avatar route and fall back before an avatar is known', () => {
  const context = sourceIconHarness();
  assert.equal(typeof context.sourceIconHtml, 'function', 'subscription icon renderer must support cached source avatars');
  const source = {
    id: 'rss-avatar-test',
    name: '包叔',
    siteUrl: 'https://x.com/baoshu88',
    avatarUrl: 'https://pbs.twimg.com/profile_images/123/avatar.jpg',
  };
  const avatar = context.sourceIconHtml(source, 24, true);
  assert.match(avatar, /src="\/source-avatars\/rss-avatar-test\?v=https%3A%2F%2Fpbs.twimg.com%2Fprofile_images%2F123%2Favatar.jpg"/);
  assert.match(avatar, /loading="eager"/);
  const fallback = context.sourceIconHtml({ id: 'rss-old', name: 'Old', siteUrl: 'https://x.com/old' }, 14, false);
  assert.match(fallback, /\/favicons\?domain_url=https%3A%2F%2Fx.com/);
});

test('Twitter source avatar bytes are fetched once and remain cached across server restart', async () => {
  const avatarUrl = 'https://pbs.twimg.com/profile_images/avataruser/avatar.jpg';
  const rss = '<?xml version="1.0"?><rss version="2.0"><channel>'
    + '<title>Avatar User</title><link>https://x.com/avataruser</link>'
    + `<image><url>${avatarUrl}</url><title>Avatar User</title><link>https://x.com/avataruser</link></image>`
    + '<item><title>One post</title><link>https://x.com/avataruser/status/1</link>'
    + '<pubDate>Mon, 21 Sep 2026 00:00:00 GMT</pubDate><description>hello</description></item>'
    + '</channel></rss>';
  const rsshub = http.createServer((req, res) => {
    if (req.url === '/twitter/user/avataruser') {
      res.setHeader('content-type', 'application/xml');
      res.end(rss);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => rsshub.listen(0, '127.0.0.1', resolve));
  const rsshubOrigin = `http://127.0.0.1:${rsshub.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmreader-avatar-cache-e2e-'));
  const root = path.join(__dirname, '..');
  const preload = path.join(dir, 'avatar-fetch-mock.cjs');
  const fetchLog = path.join(dir, 'avatar-fetches.log');
  fs.writeFileSync(preload, [
    'const fs = require("node:fs");',
    `const fetcher = require(${JSON.stringify(path.join(root, 'lib/fetcher.js'))});`,
    'const original = fetcher.fetchPublicBuffer;',
    'fetcher.fetchPublicBuffer = async (url, options) => {',
    '  if (String(url).startsWith("https://pbs.twimg.com/profile_images/")) {',
    '    fs.appendFileSync(process.env.AVATAR_FETCH_LOG, String(url) + "\\n");',
    '    return { status: 200, buffer: Buffer.from([255, 216, 255, 0]) };',
    '  }',
    '  return original(url, options);',
    '};',
  ].join('\n'));

  let app = startServer({ dir, rsshubOrigin, preload, fetchLog });
  try {
    let base = await app.ready;
    const headers = { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' };
    const createdResponse = await fetch(`${base}/api/me/sources`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: 'Avatar User', category: 'article', feeds: ['https://rsshub.app/twitter/user/avataruser'], siteUrl: 'https://x.com/avataruser' }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const sourceId = created.source.id;

    let source = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await fetch(`${base}/api/me/sources`, { headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } });
      const body = await response.json();
      source = body.sources.find(item => item.id === sourceId);
      if (source?.avatarUrl) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(source?.avatarUrl, avatarUrl, `successful RSS refresh should persist the channel avatar URL; metadata: ${JSON.stringify(source)}`);

    const avatarPath = `/source-avatars/${encodeURIComponent(sourceId)}?v=${encodeURIComponent(source.avatarUrl)}`;
    for (let request = 0; request < 2; request += 1) {
      const response = await fetch(base + avatarPath);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') || '', /image\/jpeg/);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([255, 216, 255, 0]));
    }
    assert.equal(fs.readFileSync(fetchLog, 'utf8').trim().split('\n').length, 1, 'repeated page renders must reuse cached bytes');

    await new Promise(resolve => setTimeout(resolve, 5200));
    const diskCachePath = path.join(dir, 'favicon-cache.json');
    assert.ok(fs.existsSync(diskCachePath), 'avatar bytes should be written to the persistent icon cache');
    assert.ok(Object.keys(JSON.parse(fs.readFileSync(diskCachePath, 'utf8'))).some(key => key.startsWith('twitter-avatar:')));

    await stopServer(app.child);
    app = startServer({ dir, rsshubOrigin, preload, fetchLog });
    base = await app.ready;
    const cachedAfterRestart = await fetch(base + avatarPath);
    assert.equal(cachedAfterRestart.status, 200);
    assert.deepEqual(Buffer.from(await cachedAfterRestart.arrayBuffer()), Buffer.from([255, 216, 255, 0]));
    assert.equal(fs.readFileSync(fetchLog, 'utf8').trim().split('\n').length, 1, 'server restart must not trigger another image request');
  } finally {
    await stopServer(app.child);
    rsshub.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
