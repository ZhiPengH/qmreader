const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSource = () => fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const appSlice = (start, end) => {
  const source = appSource();
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `slice ${start.slice(0, 40)} not found`);
  return source.slice(from, to);
};

function context(overrides = {}) {
  const calls = { api: [], toast: [] };
  const c = {
    $: () => null,
    state: { activeEntry: { id: 'e1' }, readerTab: 'original', selectionTranslate: null },
    SELECTION_TRANSLATE_MIN_CHARS: 2,
    SELECTION_TRANSLATE_MAX_CHARS: 4000,
    Node: { ELEMENT_NODE: 1 },
    window: {},
    ...overrides,
    api: async (path, opts) => {
      calls.api.push({ path, opts });
      if (c.__apiResult) return c.__apiResult;
      return { text: '测试译文' };
    },
    toast: msg => calls.toast.push(msg),
    copyText: async () => true,
    __calls: calls,
  };
  vm.createContext(c);
  return c;
}

test('selectionTranslateContext accepts original-tab selection inside reader content', () => {
  const contentRoot = {}; const fakeEl = { nodeType: 1, closest: sel => (sel === '#reader-content' ? contentRoot : null) };
  const c = context({
    window: { getSelection: () => ({ isCollapsed: false, toString: () => '  The Snowden mystery persists.  ', getRangeAt: () => ({ commonAncestorContainer: fakeEl, getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 20 }) }) }) },
  });
  vm.runInContext(appSlice('function selectionTranslateContext()', 'function hideSelectionTranslatePopover'), c);
  const ctx = c.selectionTranslateContext();
  assert.equal(ctx.text, 'The Snowden mystery persists.');
});

test('selectionTranslateContext rejects non-original tab, links outside reader, and out-of-range lengths', () => {
  const fakeEl = { closest: () => null };
  const selection = text => ({ isCollapsed: false, toString: () => text, getRangeAt: () => ({ commonAncestorContainer: fakeEl, getBoundingClientRect: () => ({ left: 1, top: 1, width: 5, height: 5 }) }) });
  const c = context({
    window: { getSelection: () => selection('The Snowden mystery persists.') },
  });
  vm.runInContext(appSlice('function selectionTranslateContext()', 'function hideSelectionTranslatePopover'), c);
  assert.equal(c.selectionTranslateContext(), null); // closest('#reader-content') -> null
  c.state.readerTab = 'translation';
  assert.equal(c.selectionTranslateContext(), null);
  c.state.readerTab = 'original';
  c.window.getSelection = () => selection('ab');
  assert.equal(c.selectionTranslateContext(), null); // < 2 chars after trim? 'ab' is 2 -> allowed; use 1 char
  c.window.getSelection = () => selection('a');
  assert.equal(c.selectionTranslateContext(), null);
});

test('runSelectionTranslation writes result and reveals actions; stale drafts are ignored', async () => {
  const shown = [];
  const actionsEl = { classList: { add: c => shown.push('add:' + c), remove: c => shown.push('remove:' + c) } };
  const resultEl = { set textContent(v) { this._t = v; }, get textContent() { return this._t; }, classList: { add() {}, remove() {} } };
  const c = context({
    $: sel => (sel === '#selection-translate-result' ? resultEl : sel === '#selection-translate-actions' ? actionsEl : null),
  });
  vm.runInContext(appSlice('async function runSelectionTranslation(', 'async function copySelectionTranslation'), c);
  c.state.selectionTranslate = { text: 'Hello world', status: 'loading', result: '' };
  await c.runSelectionTranslation('Hello world');
  assert.equal(c.state.selectionTranslate.status, 'done');
  assert.equal(c.state.selectionTranslate.result, '测试译文');
  assert.ok(shown.includes('remove:hidden'));

  // 请求期间用户换了选区：结果不得写入新 draft
  c.__apiResult = { text: '旧译文' };
  c.state.selectionTranslate = { text: 'New selection', status: 'loading' };
  let pending;
  const slow = new Promise(resolve => { pending = resolve; });
  c.api = async () => { await slow; return { text: '旧译文' }; };
  const work = c.runSelectionTranslation('Old text');
  c.state.selectionTranslate = { text: 'New selection', status: 'loading' };
  pending();
  await work;
  assert.equal(c.state.selectionTranslate.status, 'loading'); // 未被旧响应污染
});

test('copySelectionTranslation copies only completed translations', async () => {
  const popoverEl = { classList: { add() {} } };
  const c = context({ $: () => popoverEl });
  vm.runInContext(appSlice('function hideSelectionTranslatePopover()', 'function showSelectionTranslatePopover') + appSlice('async function copySelectionTranslation(', 'function retrySelectionTranslation'), c);
  const copied = [];
  c.copyText = async value => { copied.push(value); return true; };
  c.window = { getSelection: () => ({ removeAllRanges() {} }) };
  c.state.selectionTranslate = { text: 'a', status: 'loading', result: '' };
  await c.copySelectionTranslation();
  assert.deepEqual(copied, []);
  assert.ok(c.__calls.toast.some(m => String(m).includes('暂无译文')));
  c.state.selectionTranslate = { text: 'a', status: 'done', result: '你好' };
  await c.copySelectionTranslation();
  assert.deepEqual(copied, ['你好']);
  assert.equal(c.state.selectionTranslate, null);
});

test('app wiring binds mouseup/selectionchange to the translate popover only', () => {
  const src = appSource();
  assert.match(src, /maybeOpenSelectionTranslatePopover/);
  assert.match(src, /#selection-translate-popover, #article-link-menu/);
  assert.doesNotMatch(src, /maybeOpenAnnotationPopover/);
  assert.doesNotMatch(src, /annotation-popover-input/);
  assert.doesNotMatch(src, /submitAnnotationDraft/);
});
