const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function presetsSlice() {
  const from = src.indexOf('const AI_PROVIDER_PRESETS = [');
  const to = src.indexOf('const AI_PROVIDER_MAP', from);
  assert(from >= 0 && to > from, 'AI_PROVIDER_PRESETS block found');
  const block = src.slice(from, to);
  const sandbox = { DEFAULT_REWRITE_MODEL: 'deepseek-v4-flash' };
  vm.createContext(sandbox);
  vm.runInContext(block + '\nvar __presets = AI_PROVIDER_PRESETS;', sandbox);
  return sandbox.__presets;
}

test('MiMo preset exists with correct Xiaomi endpoint and current models', () => {
  const presets = presetsSlice();
  const mimo = presets.find(p => p.id === 'mimo');
  assert.ok(mimo, 'preset id "mimo" present');
  assert.equal(mimo.name, '小米 MiMo');
  assert.equal(mimo.providerType, 'openai_compatible');
  assert.equal(mimo.category, '国内大模型');
  assert.equal(mimo.baseUrl, 'https://api.xiaomimimo.com/v1');
  assert.equal(mimo.defaultModel, 'mimo-v2.6-flash');
  assert.equal(mimo.quickModels.length, 2);
  assert.equal(mimo.quickModels[0], 'mimo-v2.6-flash');
  assert.equal(mimo.quickModels[1], 'mimo-v2.6-pro');
  assert.equal(mimo.apiKeyUrl, 'https://platform.xiaomimimo.com/#/console/api-keys');
  // 不推荐已公告下线的 v2.5 系列
  assert.ok(!JSON.stringify(mimo.quickModels).includes('v2.5'));
});

test('preset ids stay unique after adding mimo', () => {
  const presets = presetsSlice();
  const ids = presets.map(p => p.id);
  assert.equal(new Set(ids).size, ids.length);
});
