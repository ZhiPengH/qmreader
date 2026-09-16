const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('new HTML uses content hashes instead of legacy immutable URLs; only matching assets are immutable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-assets-'));
  const root = path.join(__dirname, '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, QMREADER_DATA_DIR: dir, QMREADER_DB_FILE: path.join(dir, 'qmreader.sqlite'), HOST: '127.0.0.1', PORT: '0', STARTUP_REFRESH_DELAY_MS: '-1', FRESHNESS_SWEEP_INTERVAL_MS: '-1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    // Linux /proc is unavailable on Mac; the server reports its actual bound port.
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server startup timeout')), 10000);
      child.stdout.on('data', data => {
        const match = String(data).match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    for (const route of ['/', '/index.html', '/me']) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const html = await response.text();
      for (const name of ['app.js', 'styles.css']) {
        const digest = createHash('sha256').update(fs.readFileSync(path.join(root, 'public', name))).digest('hex');
        assert.ok(html.includes(`/${name}?v=${digest}`));
        assert.ok(!html.includes(`/${name}?v=159`));
        const asset = await fetch(`${base}/${name}?v=${digest}`);
        assert.match(asset.headers.get('cache-control'), /immutable/);
        assert.equal(createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex'), digest);
      }
    }
    for (const url of ['/app.js?v=159', '/styles.css?v=159', '/app.js']) {
      const asset = await fetch(base + url);
      assert.doesNotMatch(asset.headers.get('cache-control'), /immutable/);
      assert.match(asset.headers.get('cache-control'), /must-revalidate/);
    }
  } finally {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
