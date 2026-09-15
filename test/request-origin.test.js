const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('explicit public origin permits proxy Host mismatch and rejects foreign origins', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-assets-'));
  const root = path.join(__dirname, '..');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PUBLIC_ORIGIN: 'https://news.example.test', QMREADER_DATA_DIR: dir, QMREADER_DB_FILE: path.join(dir, 'qmreader.sqlite'), HOST: '127.0.0.1', PORT: '0', STARTUP_REFRESH_DELAY_MS: '-1', FRESHNESS_SWEEP_INTERVAL_MS: '-1' },
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
    async function post(origin, extra = {}) {
      return fetch(base + '/origin-guard-test-not-a-route', {
        method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin', ...extra },
      });
    }
    // Unknown route returns 404 only after the origin middleware allows it.
    assert.equal((await post('https://news.example.test')).status, 404);
    for (const origin of ['https://evil.example.test', 'http://news.example.test',
      'https://news.example.test:444', 'https://news.example.test.evil.test',
      'null', 'https://news.example.test/path', 'https://user@news.example.test', base]) {
      assert.equal((await post(origin, { 'X-Forwarded-Host': 'evil.example.test' })).status, 403, origin);
    }
    assert.equal((await post('https://news.example.test', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  } finally {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
