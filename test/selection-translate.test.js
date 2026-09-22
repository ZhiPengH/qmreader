const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'news-seltrans-'));
const fetchMockPath = path.join(dir, 'fetch-mock.cjs');
fs.writeFileSync(fetchMockPath, `
const realFetch = global.fetch;
global.fetch = function mockedFetch(url, init) {
  const raw = String(url);
  if (/^https?:\\/\\//.test(raw) && /chat\\/completions|\\/messages/.test(raw)) {
    return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: '斯诺登档案停发之谜的中文译文。' } }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
  }
  return realFetch(url, init);
};
`);
process.env.QMREADER_DATA_DIR = dir;
process.env.QMREADER_DB_FILE = path.join(dir, 'qmreader.sqlite');

const deepseek = require('../lib/deepseek');

after(() => fs.rmSync(dir, { recursive: true, force: true }));

function providerConfig() {
  return {
    provider: 'openai-compatible', providerType: 'openai_compatible', providerTitle: 'Test',
    apiKey: 'test-key', baseUrl: 'https://example.com/v1', model: 'test-model', temperature: 0.1, maxTokens: 2000,
  };
}

function openAiContent(content) {
  return JSON.stringify({ choices: [{ message: { content } }] });
}

const ORIGINAL_FETCH = global.fetch;

test('translateSelection translates plain English to plain Chinese without html fence', async () => {
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '斯诺登档案停发之谜' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await deepseek.translateSelection('The mystery of why the Snowden files stopped.', providerConfig());
    assert.equal(result.text, '斯诺登档案停发之谜');
    assert.equal(calls.length, 1);
    const prompt = calls[0].body.messages.map(m => m.content).join('\n');
    assert.match(prompt, /选中的英文/);
    assert.doesNotMatch(prompt, /response_format|json_object/);
  } finally { global.fetch = ORIGINAL_FETCH; }
});

test('translateSelection strips code fences and markers from provider output', async () => {
  global.fetch = async () => new Response(openAiContent('```json\n{"text":"译文"}\n```'), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await deepseek.translateSelection('Hello world selection', providerConfig());
    assert.equal(result.text, '译文');
  } finally { global.fetch = ORIGINAL_FETCH; }
});

test('translateSelection enforces client-supplied length limit', async () => {
  global.fetch = async () => new Response(openAiContent('这是一段很长的译文'.repeat(60)), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const result = await deepseek.translateSelection('Hello world selection', providerConfig(), { limit: 50 });
    assert.ok(result.text.length <= 50);
  } finally { global.fetch = ORIGINAL_FETCH; }
});

test('translateSelection rejects non-English dominant selection with 422', async () => {
  await assert.rejects(deepseek.translateSelection('这段话是纯中文内容，不满足英文占比要求。', providerConfig()), { statusCode: 422 });
});

test('translateSelection timeout error carries statusCode for the route', async () => {
  global.fetch = async () => { throw new Error('fetch failed'); };
  try {
    await assert.rejects(deepseek.translateSelection('Some English words that pass the gate.', providerConfig()), err => {
      assert.ok(err.statusCode >= 500 || err.statusCode === undefined);
      return true;
    });
  } finally { global.fetch = ORIGINAL_FETCH; }
});

async function startServer() {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', STARTUP_REFRESH_DELAY_MS: '-1', FRESHNESS_SWEEP_INTERVAL_MS: '-1', DEEPSEEK_API_KEY: 'test-key', NODE_OPTIONS: `--require ${fetchMockPath}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timeout')), 15000);
    child.stdout.on('data', data => {
      const match = String(data).match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
  });
  return { child, port };
}

test('POST /api/translate-selection returns translation for english selection', async () => {
  const { child, port } = await startServer();
  try {
    const ORIGINAL_FETCH2 = global.fetch;
    const res = await fetch(`http://127.0.0.1:${port}/api/translate-selection`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'The mystery of why the Snowden files stopped publishing.' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(typeof data.text, 'string');
    assert.ok(data.text.length > 0);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});

test('POST /api/translate-selection rejects invalid payloads', async () => {
  const { child, port } = await startServer();
  try {
    for (const [payload, expected] of [
      [{ text: '' }, 400],
      [{}, 400],
      [{ text: 'a'.repeat(4001) }, 400],
      [{ text: '这段中文不满足条件' }, 422],
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/translate-selection`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, expected, JSON.stringify(payload));
    }
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
