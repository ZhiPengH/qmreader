const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const publicDir = path.join(__dirname, '../public');
const plain = value => JSON.parse(JSON.stringify(value));
const entry = id => ({ id, title: `Article ${id}`, summary: 'Summary', cardRatio: '3/4', tags: [], tagStatus: 'pending', reactionByMe: '' });
const payload = (ids = ['a', 'b', 'c']) => ({ order: ids, entries: ids.slice(0, 2).map(entry), total: ids.length, revision: 1, preferences: { interests: [], ignored: [], knownTags: [] }, tagging: { autoEnabled: false } });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function harness(overrides = {}) {
  const calls = [], events = [], saved = new Map();
  const context = { URLSearchParams, console, setTimeout, clearTimeout, Map, Set, window: {} };
  vm.createContext(context);
  const file = path.join(publicDir, 'plaza.js');
  vm.runInContext(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', context);
  assert.equal(typeof context.window.QMPlaza?.create, 'function', 'The ordinary-script plaza factory must exist');
  const adapter = { api: async (url, options) => { calls.push([url, options]); return payload(); }, storage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) }, onChange: (type, data) => events.push([type, data]), seed: () => 'batch-1', ...overrides };
  return { plaza: context.window.QMPlaza.create(adapter), calls, events, saved };
}

test('append consumes the entire frozen ID list in batches without resetting previous nodes', async () => {
  const ids = Array.from({ length: 453 }, (_, i) => `id-${i}`);
  const appended = [], calls = [];
  const { plaza, events } = harness({ api: async url => {
    calls.push(url);
    if (url.startsWith('/api/plaza?')) return { ...payload(ids), entries: ids.slice(0, 24).map(entry) };
    const requested = new URL(url, 'http://local').searchParams.get('ids').split(',');
    assert(requested.length <= 24);
    return { entries: requested.slice().reverse().map(entry) };
  }, onChange: (type, data) => { if (type === 'append') appended.push(...data.map(e => e.id)); events?.push?.([type, data]); } });
  await plaza.activate();
  const first = plaza.visibleEntries()[0];
  while (plaza.snapshot().loaded < ids.length) await plaza.loadMore();
  assert.strictEqual(plaza.visibleEntries()[0], first, 'metadata and attached card identities survive append');
  assert.deepEqual(plain(plaza.visibleEntries().map(e => e.id)), ids);
  assert.deepEqual(appended, ids.slice(24));
  assert.equal(events.filter(e => e[0] === 'reset').length, 1);
  assert(calls.every(url => !url.startsWith('/api/entries')));
});

test('mode switches and deactivation invalidate older loads and appends', async () => {
  const old = deferred(), more = deferred(); let mode = 'all', count = 0;
  const { plaza } = harness({ api: url => {
    if (url.includes('/entries?')) return more.promise;
    count++;
    return count === 1 ? old.promise : Promise.resolve(payload([mode, 'next', 'extra']));
  } });
  const initial = plaza.activate(); mode = 'random';
  await plaza.change({ mode }); old.resolve(payload(['stale'])); await initial;
  assert.deepEqual(plain(plaza.snapshot().order), ['random', 'next', 'extra']);
  const pending = plaza.loadMore(); plaza.deactivate(); more.resolve({ entries: [entry('extra')] }); await pending;
  assert.equal(plaza.snapshot().loaded, 2);
  assert.equal(plaza.snapshot().loading, false);
});

test('view changes keep snapshot and remember entrance/view while random refresh changes seed', async () => {
  let seeds = 0;
  const { plaza, calls, saved } = harness({ seed: () => String(++seeds) });
  await plaza.activate();
  await plaza.change({ view: 'list' });
  assert.equal(calls.length, 1);
  await plaza.change({ mode: 'random' });
  const seed = plaza.snapshot().settings.seed;
  await plaza.refresh({ shuffle: true });
  assert.notEqual(plaza.snapshot().settings.seed, seed);
  const next = harness({ storage: { getItem: key => saved.get(key), setItem() {} } }).plaza;
  assert.equal(next.snapshot().settings.mode, 'random');
  assert.equal(next.snapshot().settings.view, 'list');
});

test('failed append preserves pages and exposes retryable error without duplicate requests', async () => {
  const pending = deferred(); let requests = 0;
  const { plaza } = harness({ api: url => url.includes('/entries?') ? (requests++, pending.promise) : Promise.resolve(payload()) });
  await plaza.activate();
  const first = plaza.loadMore(); const second = plaza.loadMore();
  pending.resolve({ entries: [entry('c')] }); await Promise.all([first, second]);
  assert.equal(requests, 1);
  // A separate rejected request must retain the first loaded page.
  const failed = harness({ api: async url => { if (url.includes('/entries?')) throw new Error('offline'); return payload(); } }).plaza;
  await failed.activate(); await failed.loadMore();
  assert.equal(failed.snapshot().loaded, 2);
  assert.match(failed.snapshot().error, /offline/);
  assert.equal(failed.snapshot().loading, false);
});

test('status notification never changes frozen sequence and hidden/inactive views do not poll', async () => {
  let visible = true;
  const { plaza, calls } = harness({ isVisible: () => visible, api: async url => {
    calls.push([url]);
    return url.includes('/status?') ? { revision: 3, total: 10, newCount: 7, tagging: { autoEnabled: false } } : payload();
  } });
  await plaza.activate(); await plaza.checkStatus();
  assert.equal(plaza.snapshot().newCount, 7);
  assert.equal(plaza.snapshot().revision, 1);
  assert.deepEqual(plain(plaza.snapshot().order), ['a', 'b', 'c']);
  const count = calls.length; visible = false; await plaza.checkStatus(); plaza.deactivate(); visible = true; await plaza.checkStatus();
  assert.equal(calls.length, count);
});

test('reader close restores captured scroll/focus without reloading; mode switch closes and discards it', async () => {
  const restored = [], opens = [], closes = [];
  const { plaza, calls } = harness({ capturePosition: () => ({ scrollTop: 432, focusId: 'a' }), restorePosition: p => restored.push(p), openEntry: e => opens.push(e.id), closeReader: () => closes.push(true) });
  await plaza.activate(); await plaza.open('a'); await plaza.open('b'); plaza.close();
  assert.deepEqual(opens, ['a', 'b']);
  assert.deepEqual(restored, [{ scrollTop: 432, focusId: 'a' }]);
  assert.equal(calls.length, 1);
  await plaza.open('a'); await plaza.change({ mode: 'personal' });
  assert.equal(plaza.snapshot().readerId, '');
  assert.equal(closes.length, 2);
});

test('interest selection and manual article tags are separate from reactions and preserve tag kind', async () => {
  const writes = [];
  const { plaza } = harness({ api: async (url, options) => {
    if (!options) return payload();
    writes.push([url, JSON.parse(options.body)]);
    if (url.endsWith('/interests')) return { preferences: { interests: [{ name: '研究', kind: 'format' }], ignored: [], knownTags: [] } };
    return { entry: { ...entry('a'), tags: [], tagOrigin: 'manual' } };
  } });
  await plaza.activate();
  await plaza.setInterest({ name: '研究', kind: 'format' }, true);
  await plaza.saveTags('a', []);
  assert.deepEqual(writes, [['/api/plaza/interests', { tag: { name: '研究', kind: 'format' }, interested: true }], ['/api/plaza/entries/a/tags', { tags: [] }]]);
  assert.equal(plaza.visibleEntries()[0].tagOrigin, 'manual');
  assert.deepEqual(plain(plaza.snapshot().order), ['a', 'b', 'c']);
});

test('negative feedback undo restores a previous like via existing ID-based reaction API', async () => {
  const writes = [], stats = [];
  const { plaza } = harness({ mergeStats: (id, value) => stats.push([id, value]), api: async (url, options) => {
    if (!options) { const data = payload(); data.entries[0].reactionByMe = 'like'; return data; }
    const body = JSON.parse(options.body); writes.push([url, body]); return { stats: { entryId: 'a', reactionByMe: body.reaction } };
  } });
  await plaza.activate(); await plaza.react('a', 'dislike');
  assert.equal(plaza.visibleEntries()[0].reactionByMe, 'dislike');
  await plaza.undoReaction('a');
  assert.equal(plaza.visibleEntries()[0].reactionByMe, 'like');
  assert.deepEqual(writes, [['/api/entry/a/reaction', { reaction: 'dislike' }], ['/api/entry/a/reaction', { reaction: 'like' }]]);
  assert.equal(stats.length, 2);
  assert.deepEqual(plain(plaza.snapshot().order), ['a', 'b', 'c']);
});

test('failed feedback and tag writes preserve confirmed state and stale successes cannot write a new mode', async () => {
  let fail = true; const pending = deferred();
  const { plaza } = harness({ api: async (url, options) => {
    if (!options) return payload();
    if (fail) throw new Error('write failed');
    return pending.promise;
  } });
  await plaza.activate();
  assert.equal(await plaza.react('a', 'like'), false);
  assert.equal(await plaza.setInterest({ name: 'AI', kind: 'topic' }, true), false);
  assert.equal(await plaza.saveTags('a', [{ name: 'AI', kind: 'topic' }]), false);
  assert.equal(plaza.visibleEntries()[0].reactionByMe, '');
  assert.deepEqual(plain(plaza.snapshot().preferences.interests), []);
  assert.deepEqual(plain(plaza.visibleEntries()[0].tags), []);
  assert.match(plaza.snapshot().error, /write failed/);
  fail = false; const write = plaza.react('a', 'like'); await plaza.change({ mode: 'personal' });
  pending.resolve({ stats: { reactionByMe: 'like' } }); await write;
  assert.equal(plaza.visibleEntries()[0].reactionByMe, '');
});

test('tag generation is opt-in, serial batches of loaded pending items only and reuses results', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => String(i)); let enabled = false, inFlight = 0, max = 0;
  const requests = [];
  const { plaza } = harness({ aiConfig: () => ({ model: 'configured-test-model' }), api: async (url, options) => {
    if (!options) return { ...payload(ids), entries: ids.map(id => ({ ...entry(id), tagStatus: id === '19' ? 'failed' : 'pending' })), tagging: { autoEnabled: enabled } };
    inFlight++; max = Math.max(max, inFlight);
    const body = JSON.parse(options.body); requests.push(body);
    assert.equal(options.aiConfig.model, 'configured-test-model');
    await Promise.resolve(); inFlight--;
    return { entries: body.entryIds.map(id => ({ ...entry(id), tagStatus: 'ready', tags: [{ name: '技术', kind: 'topic' }] })), usage: { used: body.entryIds.length } };
  } });
  await plaza.activate(); await plaza.autoTagLoaded(); assert.equal(requests.length, 0);
  enabled = true; await plaza.refresh();
  await Promise.all([plaza.autoTagLoaded(), plaza.autoTagLoaded()]);
  assert.equal(max, 1);
  assert.deepEqual(requests.map(r => r.entryIds.length), [8, 8, 3]);
  assert(requests.every(r => r.automatic === true && r.retry === false && !r.entryIds.includes('19')));
  await plaza.autoTagLoaded(); assert.equal(requests.length, 3);
  await plaza.generateTags(['19'], { retry: true });
  assert.equal(requests[3].retry, true); assert.equal(requests[3].automatic, false);
});

test('tag auth error exposes existing AI settings and cannot repeatedly auto-retry failures', async () => {
  let calls = 0, settings = 0;
  const { plaza } = harness({ openAiSettings: () => settings++, api: async (url, options) => {
    if (!options) return { ...payload(), tagging: { autoEnabled: true } };
    calls++; throw new Error('API Key 未配置');
  } });
  await plaza.activate(); await plaza.autoTagLoaded(); await plaza.autoTagLoaded();
  assert.equal(calls, 1);
  await plaza.generateTags(['a'], { retry: true });
  assert.equal(settings, 1);
  assert.match(plaza.snapshot().error, /未配置/);
});

// DOM test double backed by the real HTML parser; no browser/layout claims.
function domHarness(html = '<section id="plaza-root"></section><div id="plaza-reader-tags" hidden></div>') {
  const $ = require('cheerio').load(html), cache = new WeakMap();
  const doc = { activeElement: null, defaultView: { innerWidth: 1200, matchMedia: () => ({ matches: false }), requestAnimationFrame: fn => fn(), addEventListener() {} } };
  function wrap(raw) {
    if (!raw) return null;
    if (cache.has(raw)) return cache.get(raw);
    const node = { raw, ownerDocument: doc, style: { setProperty(k, v) { this[k] = v; } }, _events: {}, scrollTop: 0, clientWidth: 1000, clientHeight: 600, offsetHeight: 280,
      get innerHTML() { return $(raw).html(); }, set innerHTML(value) { $(raw).html(value); },
      get textContent() { return $(raw).text(); }, set textContent(value) { $(raw).text(value); },
      get children() { return $(raw).children().toArray().map(wrap); },
      get parentElement() { return wrap(raw.parent); },
      get dataset() { return new Proxy({}, { get: (_, key) => $(raw).attr('data-' + String(key).replace(/[A-Z]/g, c => '-' + c.toLowerCase())), set: (_, key, value) => { $(raw).attr('data-' + key.replace(/[A-Z]/g, c => '-' + c.toLowerCase()), String(value)); return true; } }); },
      get hidden() { return $(raw).attr('hidden') !== undefined; }, set hidden(v) { if (v) $(raw).attr('hidden', ''); else $(raw).removeAttr('hidden'); },
      get value() { return $(raw).val() || ''; }, set value(v) { $(raw).val(v); },
      get open() { return $(raw).attr('open') !== undefined; }, set open(v) { if (v) $(raw).attr('open', ''); else $(raw).removeAttr('open'); },
      querySelector: s => wrap($(raw).find(s)[0]), querySelectorAll: s => $(raw).find(s).toArray().map(wrap),
      closest: s => wrap($(raw).closest(s)[0]), matches: s => $(raw).is(s),
      getAttribute: k => $(raw).attr(k), setAttribute: (k, v) => $(raw).attr(k, String(v)), removeAttribute: k => $(raw).removeAttr(k),
      appendChild: child => { $(raw).append(child.raw); return child; }, remove: () => $(raw).remove(),
      contains: n => n && (n === node || $(raw).find('*').toArray().includes(n.raw)),
      focus: () => { const changed = doc.activeElement !== node; doc.activeElement = node; if (changed) doc.onFocus?.(node); }, showModal: () => { node.open = true; }, close: () => { node.open = false; },
      getBoundingClientRect: () => ({ width: node.clientWidth, height: node.offsetHeight }),
      addEventListener: (type, fn) => { (node._events[type] ||= []).push(fn); },
      async dispatch(type, target = node, extra = {}) { const event = { target, preventDefault() {}, stopPropagation() {}, ...extra }; for (const fn of node._events[type] || []) await fn(event); },
    };
    node.classList = { add: (...xs) => xs.forEach(x => $(raw).addClass(x)), remove: (...xs) => xs.forEach(x => $(raw).removeClass(x)), contains: x => $(raw).hasClass(x), toggle: (x, force) => { const yes = force ?? !$(raw).hasClass(x); $(raw).toggleClass(x, yes); return yes; } };
    cache.set(raw, node); return node;
  }
  doc.querySelector = s => wrap($(s)[0]); doc.querySelectorAll = s => $(s).toArray().map(wrap);
  doc.getElementById = id => doc.querySelector('#' + id);
  doc.createElement = name => wrap($(`<${name}></${name}>`)[0]); doc.body = doc.querySelector('body');
  doc.addEventListener = (...args) => doc.body.addEventListener(...args);
  return { doc, root: doc.querySelector('#plaza-root') };
}

test('mounted UI appends real card nodes, preserves full titles/ratios, and hover never requests AI', async () => {
  const { doc, root } = domHarness(); const requests = [];
  const { plaza } = harness({ root, api: async (url, options) => { requests.push(url); return url.includes('/entries?') ? { entries: [entry('c')] } : payload(); } });
  await plaza.activate();
  const first = root.querySelector('[data-entry-id="a"]');
  assert(first, 'the mounted feed contains its first card');
  assert.equal(first.querySelector('.plaza-card-title').textContent, 'Article a');
  assert.equal(first.dataset.ratio, '3/4');
  await plaza.loadMore();
  assert.strictEqual(root.querySelector('[data-entry-id="a"]'), first);
  assert.equal(root.querySelectorAll('.plaza-card').length, 3);
  const count = requests.length;
  await root.dispatch('pointerover', first.querySelector('[data-like]'), { pointerType: 'mouse' });
  assert.equal(first.querySelector('.plaza-tag-pop').hidden, false);
  await root.dispatch('pointerout', first.querySelector('[data-like]'), { relatedTarget: first.querySelector('.plaza-tag-pop') });
  assert.equal(first.querySelector('.plaza-tag-pop').hidden, false);
  assert.equal(requests.length, count);
  const ignored = doc.querySelector('#plaza-ignored'); assert(ignored); assert.equal(ignored.open, false);
});

test('failed tag editor save keeps draft and shows inline error; mobile hover offers no card tag panel', async () => {
  const { doc, root } = domHarness(); doc.defaultView.matchMedia = () => ({ matches: true });
  const { plaza } = harness({ root, api: async (url, options) => { if (options) throw new Error('offline'); return payload(); } });
  await plaza.activate();
  const first = root.querySelector('[data-entry-id="a"]'); assert(first);
  await root.dispatch('pointerover', first.querySelector('[data-like]'), { pointerType: 'touch' });
  assert.equal(first.querySelector('.plaza-tag-pop').hidden, true);
  plaza.showReaderTags('a');
  const panel = doc.querySelector('#plaza-reader-tags');
  panel.querySelector('[name="topic"]').value = '保留草稿';
  await panel.dispatch('submit', panel.querySelector('[data-correct-tags]'));
  assert.equal(panel.querySelector('[name="topic"]').value, '保留草稿');
  assert.match(panel.querySelector('[role="alert"]').textContent, /offline/);
});

const appSource = () => fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
function appSlice(start, end) { const source = appSource(), from = source.indexOf(start), to = source.indexOf(end, from + start.length); assert(from >= 0 && to > from); return source.slice(from, to); }

test('production document loads plaza assets and keeps original reader/context nodes in place', () => {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'), $ = require('cheerio').load(html);
  assert($('script[src*="plaza.js"]').length === 1);
  assert(html.indexOf('src="/plaza.js') < html.indexOf('src="/app.js'));
  assert(html.indexOf('href="/plaza.css') > html.indexOf('href="/styles.css'));
  for (const id of ['reader-pane', 'agent-pane', 'context-resizer']) { assert.equal($('#' + id).length, 1); assert.equal($('#' + id).parent().attr('id'), 'app'); }
  assert.equal($('#plaza-root').parent().attr('id'), 'app');
  assert.equal($('#plaza-reader-tags-toggle').closest('#reader').length, 1);
  assert.equal($('[data-view="hot"] .view-label').text(), '广场');
  assert.equal($('[data-list-scope="minimal"]').text(), '极简');
});

test('plaza URLs and history reader updates preserve the plaza return route', () => {
  const c = { URL, URLSearchParams, window: { location: new URL('http://localhost/plaza') }, state: { view: 'hot', readerTab: 'original', activeEntry: { id: 'a' } }, history: { state: { plazaReturn: true }, pushState(data, _, url) { this.result = data; c.window.location = url; } }, document: {}, ASSET_FILTER_TYPES: [], normalizeReaderTab: x => x, entryArticleLocator: e => e.id, readerRouteTitle: () => '' };
  vm.createContext(c);
  vm.runInContext([appSlice('function readerUrlFor(', 'function readerAssetUrl('), appSlice('function listUrlFor(', 'function contributorUrlFor('), appSlice('function syncReaderUrl(', 'function syncListUrl(')].join('\n'), c);
  assert.equal(c.listUrlFor().pathname, '/plaza');
  c.syncReaderUrl();
  assert.equal(c.window.location.searchParams.get('from'), 'plaza');
  assert.equal(c.history.result.plazaReturn, true);
});

test('plaza list render bypasses legacy DOM rebuild and uses loaded frozen order', () => {
  const frozen = [entry('z'), entry('a')], touched = [];
  const c = { state: { view: 'hot', read: new Set() }, plaza: { visibleEntries: () => frozen, update() {} }, $: () => { touched.push(true); throw new Error('legacy list should not be accessed'); } };
  vm.createContext(c);
  vm.runInContext(appSlice('function visibleEntries()', 'function feedCountMarkup(') + appSlice('function renderList(', 'function updateListTitle('), c);
  assert.strictEqual(c.visibleEntries(), frozen);
  c.renderList(); assert.equal(touched.length, 0);
});

test('plaza desktop width budget excludes old list without mutating leftCollapsed preference', () => {
  const c = { state: { view: 'hot', leftCollapsed: false, sidebarCollapsed: false, agentCollapsed: false }, window: { innerWidth: 1400 }, minimumReaderPaneWidth: () => 640, ENTRY_PANE_MIN_WIDTH: 300, CONTEXT_PANE_MIN_WIDTH: 260 };
  vm.createContext(c); vm.runInContext(appSlice('function readerWorkbenchWidthBudget(', 'function shouldAutoCollapseContext('), c);
  assert.equal(c.readerWorkbenchWidthBudget(), 232 + 640 + 4 + 260);
  assert.equal(c.state.leftCollapsed, false);
});

test('keyboard next loads missing metadata from frozen sequence and close invalidates pending navigation', async () => {
  const pending = deferred(), opens = [];
  const { plaza } = harness({ openEntry: e => opens.push(e.id), api: async url => url.includes('/entries?') ? pending.promise : payload() });
  await plaza.activate(); await plaza.open('b');
  const move = plaza.move(1); plaza.close(); pending.resolve({ entries: [entry('c')] }); await move;
  assert.deepEqual(opens, ['b']);
  await plaza.open('b'); await plaza.move(1);
  assert.deepEqual(opens, ['b', 'b', 'c']);
});

function bridgeHarness(overrides = {}) {
  const { doc, root } = domHarness(fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'));
  const opens = [], closes = [], urls = [], reads = [];
  const c = { window: doc.defaultView, document: doc, URLSearchParams, setTimeout, clearTimeout, setInterval: () => 0,
    storage: { getItem: () => null, setItem() {} }, state: { view: 'all', entries: [], read: new Set(), activeEntry: null },
    $: s => doc.querySelector(s), api: async url => { reads.push(url); return payload(); },
    lucideIcon: () => '', plainTextFromHtml: x => x, summaryAiConfig: () => ({}), openAiConfigModal() {},
    openEntry: async e => { c.state.activeEntry = e; opens.push(e.id); doc.querySelector('#app').classList.add('reading'); },
    closeReaderFromRoute: () => { closes.push(true); c.state.activeEntry = null; doc.querySelector('#app').classList.remove('reading'); },
    setWorkspacePage() {}, renderSidebar() {}, updateListTitle() {}, mergeEntryStats() {}, setFeedDrawer() {}, toast() {},
    syncListUrl: opts => urls.push(opts), reload: () => assert.fail('plaza entry must not reload legacy list'), contentCache: new Map(), ...overrides,
  };
  vm.createContext(c); vm.runInContext(fs.readFileSync(path.join(publicDir, 'plaza.js'), 'utf8'), c);
  vm.runInContext(appSlice('/* ---------- Plaza bridge ---------- */', '/* ---------- Init ---------- */') + appSlice('function selectView(', 'function goHomeAll('), c);
  return { c, root, doc, opens, closes, urls, reads, plaza: vm.runInContext('plaza', c) };
}

test('real app bridge enters plaza, opens existing reader and closes without rebuilding cards or losing scroll/focus', async () => {
  const { c, root, doc, plaza, opens, reads } = bridgeHarness();
  await c.selectView('hot'); assert(doc.querySelector('#app').classList.contains('plaza-active'));
  const button = root.querySelector('[data-open="a"]'); root.scrollTop = 345; button.focus();
  await plaza.open('a', button); assert.deepEqual(opens, ['a']);
  c.closePlazaReader();
  assert.equal(root.scrollTop, 345); assert.strictEqual(doc.activeElement, button);
  assert.strictEqual(root.querySelector('[data-open="a"]'), button);
  assert(reads.every(url => !url.startsWith('/api/entries')));
  c.leavePlaza(); assert.equal(root.hidden, true); assert.equal(plaza.snapshot().active, false);
});

test('URL back to plaza closes reader without replacing its frozen pages', async () => {
  const { c, root, plaza } = bridgeHarness();
  await c.selectView('hot'); await plaza.open('a'); const first = root.querySelector('.plaza-card');
  c.routeStateFromUrl = () => ({ view: 'hot', entryId: '' });
  vm.runInContext(appSlice('async function openEntryFromUrl(', '/* ---------- Navigation ---------- */'), c);
  await c.openEntryFromUrl();
  assert.equal(c.state.activeEntry, null); assert.strictEqual(root.querySelector('.plaza-card'), first);
});

test('same-ID reader reopen cannot receive the previous content request', async () => {
  const code = appSlice('async function openEntry(e,', 'function closeReaderFromRoute(');
  const pending = deferred(), rendered = [], nodes = new Map();
  const c = { state: { view: 'all' }, ASSET_FILTER_TYPES: [], contentCache: new Map(),
    $: s => { if (!nodes.has(s)) nodes.set(s, { classList: { add() {}, remove() {} }, innerHTML: '', value: '', scrollTop: 0 }); return nodes.get(s); },
    document: { getElementById: () => ({ classList: { add() {} } }) },
    api: () => pending.promise, normalizeReaderOpenTab: () => 'original', sourceById: () => null,
    renderOriginalContent: (e, text) => rendered.push(text), isCompactViewport: () => false,
  };
  for (const name of ['setWorkspacePage','recordEntryView','syncEntryState','renderAdminEntryControls','escapeHtml','sourceNameForEntry','renderTitle','updateRewriteUiLabels','readerRouteTitle','friendlyDateTime','renderReaderStatsUi','renderReaderAssets','renderReaderAssetSummary','updateFetchOriginalButton','setReaderTab','loadTranslation','loadRewrite','loadSummary','loadAnnotations','loadComments','loadAgentMessages','syncReaderUrl','normalizeReaderWorkbenchLayout','applyReaderPrefs','renderAgent','renderEntryStateUi']) c[name] ||= () => {};
  vm.createContext(c); vm.runInContext(code, c);
  const old = c.openEntry(entry('a')); await c.openEntry({ ...entry('a'), content: 'new-content' });
  pending.resolve({ entry: { ...entry('a'), content: 'old-content' } }); await old;
  assert.deepEqual(rendered, ['new-content']);
});

test('plaza styles scope no-list desktop/mobile and leave full titles unclamped', () => {
  const css = fs.readFileSync(path.join(publicDir, 'plaza.css'), 'utf8');
  assert.match(css, /#app\.plaza-active[^{}]*#entry-pane[^{}]*\{[^}]*display:\s*none\s*!important/s);
  assert.match(css, /@media\s*\(max-width:\s*840px\)/);
  assert.match(css, /#plaza-update\s*\{[^}]*position:\s*fixed/s);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'all colors use incumbent theme tokens');
  assert.match(css, /\.plaza-card-title\s*\{[^}]*overflow-wrap:\s*anywhere/s);
});

test('plaza icons all exist in the shipped icon registry', async () => {
  const c = { window: {} }; vm.runInNewContext(fs.readFileSync(path.join(publicDir, 'lucide-icons.js'), 'utf8'), c);
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'), used = [];
  const { root } = domHarness();
  await harness({ root, icon: name => { used.push(name); return ''; } }).plaza.activate();
  const $ = require('cheerio').load(html);
  $('[data-view="hot"] [data-qm-icon], .plaza-reader-control [data-qm-icon]').each((_, el) => used.push($(el).attr('data-qm-icon')));
  for (const name of used) assert(c.window.QM_LUCIDE_ICONS[name], `Missing shipped icon: ${name}`);
});

test('manual correction wins over earlier generated tags and older preference reads cannot undo a save', async () => {
  const generated = deferred(), preferenceRead = deferred();
  const manual = [{ name: '人工主题', kind: 'topic' }];
  const { plaza } = harness({ api: async (url, options) => {
    if (url === '/api/plaza/tags') return generated.promise;
    if (url === '/api/plaza/preferences') return preferenceRead.promise;
    if (url.endsWith('/a/tags')) return { entry: { ...entry('a'), tags: manual, tagStatus: 'ready', tagOrigin: 'manual' } };
    if (url.endsWith('/interests')) return { preferences: { interests: manual, ignored: [], knownTags: manual } };
    return payload();
  } });
  await plaza.activate();
  const generating = plaza.generateTags(['a']); await Promise.resolve();
  const reading = plaza.loadPreferences();
  await plaza.saveTags('a', manual); await plaza.setInterest(manual[0], true);
  generated.resolve({ entries: [{ ...entry('a'), tags: [{ name: '旧 AI', kind: 'topic' }], tagOrigin: 'ai', tagStatus: 'ready' }] });
  preferenceRead.resolve({ preferences: payload().preferences });
  await Promise.all([generating, reading]);
  assert.deepEqual(plain(plaza.visibleEntries()[0].tags), manual);
  assert.deepEqual(plain(plaza.snapshot().preferences.interests), manual);
});

test('closing a keyboard tag popover returns focus without reopening it; successful correction refreshes visible tags', async () => {
  const { doc, root } = domHarness(); doc.onFocus = node => root.dispatch('focusin', node);
  const { plaza } = harness({ root, api: async (url, options) => {
    if (!options) return payload();
    return { entry: { ...entry('a'), tags: [{ name: '已纠正', kind: 'format' }], tagOrigin: 'manual', tagStatus: 'ready' } };
  } });
  await plaza.activate();
  const card = root.querySelector('[data-entry-id="a"]'), like = card.querySelector('[data-like]'), pop = card.querySelector('.plaza-tag-pop');
  like.focus(); assert.equal(pop.hidden, false);
  pop.querySelector('[data-close-tags]').focus(); plaza.closeOverlays();
  assert.strictEqual(doc.activeElement, like); assert.equal(pop.hidden, true);
  plaza.showReaderTags('a'); const panel = doc.querySelector('#plaza-reader-tags');
  panel.querySelector('[name="format"]').value = '已纠正';
  await panel.dispatch('submit', panel.querySelector('[data-correct-tags]'));
  assert(panel.querySelector('[data-interest="已纠正"]'));
});

test('failed tag generation response offers real AI settings rather than fake candidate tags', async () => {
  const { doc, root } = domHarness(); let settings = 0;
  const { plaza } = harness({ root, openAiSettings: () => settings++, api: async (url, options) => options ? { entries: [{ ...entry('a'), tagStatus: 'failed', tagError: '请检查 AI 配置' }], skipped: 'failed' } : payload() });
  await plaza.activate(); plaza.showReaderTags('a');
  const panel = doc.querySelector('#plaza-reader-tags');
  await panel.dispatch('click', panel.querySelector('[data-generate]'));
  assert.match(panel.textContent, /请检查 AI 配置/);
  const config = panel.querySelector('[data-ai-settings]'); assert(config); await panel.dispatch('click', config);
  assert.equal(settings, 1); assert.equal(panel.querySelectorAll('[data-interest]').length, 0);
});

test('Escape exits immersive plaza reading without detaching the original reader', async () => {
  const { c, doc, plaza } = bridgeHarness(); await c.selectView('hot'); await plaza.open('a');
  c.state.readerImmersive = true; c.isShortcutEditableTarget = () => false;
  c.setReaderImmersive = value => { c.state.readerImmersive = value; };
  for (const name of ['setReaderPrefsOpen', 'setAccountMenuOpen', 'hideArticleLinkMenu']) c[name] = () => {};
  vm.runInContext(appSlice("document.addEventListener('keydown', (e) => {", "window.addEventListener('popstate'"), c);
  await doc.body.dispatch('keydown', doc.body, { key: 'Escape' });
  assert.equal(c.state.readerImmersive, false);
  assert.equal(c.state.activeEntry.id, 'a'); assert(doc.querySelector('#app').classList.contains('reading'));
});

test('clicking plaza navigation while reading returns to the retained plaza, not just its URL', async () => {
  const { c, root, plaza } = bridgeHarness(); await c.selectView('hot'); const first = root.querySelector('.plaza-card');
  await plaza.open('a'); await c.selectView('hot');
  assert.equal(c.state.activeEntry, null); assert.equal(plaza.snapshot().readerId, '');
  assert.strictEqual(root.querySelector('.plaza-card'), first);
});

test('back during deep-link lookup invalidates that lookup before it can reopen the reader', async () => {
  const { c } = bridgeHarness(); await c.selectView('hot'); const pending = deferred(), opened = [];
  c.api = () => pending.promise; c.openEntry = async e => opened.push(e.id);
  vm.runInContext(appSlice('async function openEntryById(', 'async function openEntryFromUrl('), c);
  const opening = c.openEntryById('outside-loaded-pages'); c.closePlazaReader({ syncUrl: false });
  pending.resolve({ entry: entry('outside-loaded-pages') }); await opening;
  assert.deepEqual(opened, []);
});

test('mode tabs support arrow navigation, and write buttons show pending state until confirmed', async () => {
  const { root } = domHarness(); const pending = deferred();
  const { plaza } = harness({ root, api: async (url, options) => options ? pending.promise : payload() });
  await plaza.activate(); const all = root.querySelector('[data-mode="all"]');
  await root.dispatch('keydown', all, { key: 'ArrowRight' });
  assert.equal(plaza.snapshot().settings.mode, 'random');
  const like = root.querySelector('[data-like="a"]'); const write = root.dispatch('click', like);
  assert.equal(like.disabled, true); assert.equal(like.getAttribute('aria-pressed'), 'false');
  pending.resolve({ stats: { reactionByMe: 'like' } }); await write;
  assert.equal(like.disabled, false); assert.equal(like.getAttribute('aria-pressed'), 'true');
});

test('mode failure keeps a truthful prior snapshot and offers an initial-load retry without discarding cards', async () => {
  let fail = false;
  const { root } = domHarness(); const { plaza } = harness({ root, api: async () => { if (fail) throw new Error('offline'); return payload(); } });
  await plaza.activate(); const first = root.querySelector('.plaza-card'); fail = true;
  await plaza.change({ mode: 'personal' });
  assert.equal(plaza.snapshot().settings.mode, 'all'); assert.strictEqual(root.querySelector('.plaza-card'), first);
  assert.match(root.querySelector('#plaza-load-status').textContent, /offline/);
});

test('back while initial plaza is loading invalidates the outer article route continuation', async () => {
  const firstLoad = deferred(); let requests = 0;
  const { c, opens } = bridgeHarness({ api: async () => ++requests === 1 ? firstLoad.promise : payload() });
  c.routeStateFromUrl = () => ({ view: 'hot', entryId: 'a' });
  c.openEntryById = async id => opens.push(id);
  vm.runInContext(appSlice('async function openEntryFromUrl(', '/* ---------- Navigation ---------- */'), c);
  const oldRoute = c.openEntryFromUrl();
  c.routeStateFromUrl = () => ({ view: 'hot', entryId: '' }); await c.openEntryFromUrl();
  firstLoad.resolve(payload()); await oldRoute;
  assert.deepEqual(opens, []);
});

test('retry after failed mode change retries that mode and not the old next-page endpoint', async () => {
  const { root } = domHarness(); let fail = false; const requests = [];
  const { plaza } = harness({ root, api: async url => { requests.push(url); if (fail) throw new Error('offline'); return payload(); } });
  await plaza.activate(); fail = true; await plaza.change({ mode: 'personal' }); fail = false;
  await root.dispatch('click', root.querySelector('#plaza-more'));
  assert.equal(new URL(requests.at(-1), 'http://local').searchParams.get('mode'), 'personal');
  assert.equal(plaza.snapshot().settings.mode, 'personal');
});

test('plaza reader exposes lazy-content failure and retries through the existing reader', async () => {
  const code = appSlice('async function openEntry(e,', 'function closeReaderFromRoute('), nodes = new Map();
  const c = { state: { view: 'hot' }, ASSET_FILTER_TYPES: [], contentCache: new Map(), plaza: { beginReader() {} },
    $: s => { if (!nodes.has(s)) nodes.set(s, { classList: { add() {}, remove() {} }, innerHTML: '', value: '', scrollTop: 0, hidden: true }); return nodes.get(s); },
    document: { getElementById: () => ({ classList: { add() {} } }) }, api: async () => { throw new Error('offline'); }, normalizeReaderOpenTab: () => 'original', sourceById: () => null, isCompactViewport: () => false,
  };
  for (const name of ['setWorkspacePage','recordEntryView','syncEntryState','renderAdminEntryControls','escapeHtml','sourceNameForEntry','renderTitle','updateRewriteUiLabels','readerRouteTitle','friendlyDateTime','renderReaderStatsUi','renderReaderAssets','renderReaderAssetSummary','updateFetchOriginalButton','setReaderTab','loadTranslation','loadRewrite','loadSummary','loadAnnotations','loadComments','loadAgentMessages','syncReaderUrl','normalizeReaderWorkbenchLayout','applyReaderPrefs','renderAgent','renderEntryStateUi','renderOriginalContent']) c[name] = () => {};
  vm.createContext(c); vm.runInContext(code, c); await c.openEntry(entry('a'));
  assert.equal(c.$('#plaza-reader-error').hidden, false);
  assert.match(c.$('#plaza-reader-error-text').textContent, /offline/);
  const bridge = bridgeHarness(); await bridge.c.selectView('hot'); await bridge.plaza.open('a');
  await bridge.doc.querySelector('#plaza-reader-retry').onclick();
  assert.deepEqual(bridge.opens, ['a', 'a']);
});

for (const [name, end, field, loading] of [
  ['loadTranslation', 'function rewriteMetaText(', 'translation', 'translationLoading'],
  ['loadRewrite', 'async function generateTranslation(', 'rewrite', 'rewriteLoading'],
  ['loadSummary', 'async function generateSummary(', 'summary', 'summaryLoading'],

  ['loadComments', 'async function submitComment(', 'comments'],
  ['loadAgentMessages', 'async function sendAgentMessage(', 'agentMessages'],
]) {
  test(`${name} cannot write success/error/finally into a reopened same-ID reader`, async () => {
    for (const fail of [false, true]) {
      const pending = deferred(), rendered = [], expected = { fresh: true };
      const c = { state: { activeEntry: entry('a'), readerRequestToken: 1 }, api: () => pending.promise,
        updateEntryAssets() {}, entryAssetHelpfulPatch() {}, renderList() {}, maybeAutoGenerateSummary() {}, maybeGenerateRewriteAfterLoad() {}, generateTranslation() {}, generateRewrite() {} };
      for (const fn of ['renderTranslation', 'renderRewrite', 'renderSummary', 'renderAnnotations', 'renderComments', 'renderAgent']) c[fn] = () => rendered.push(fn);
      vm.createContext(c); vm.runInContext(appSlice('async function ' + name + '(', end), c);
      const work = c[name](entry('a')); rendered.length = 0;
      c.state.readerRequestToken = 3; c.state[field] = expected; if (loading) c.state[loading] = true;
      if (fail) pending.reject(new Error('stale failure')); else pending.resolve({ translation: {}, rewrite: {}, summary: {}, annotations: [], comments: [], messages: [] });
      await work;
      assert.strictEqual(c.state[field], expected); assert.deepEqual(rendered, []);
      if (loading) assert.equal(c.state[loading], true);
    }
  });
}

test('deep-linked later-page articles hydrate plaza metadata and keep the reader tag toolbar usable', async () => {
  const { c, doc, plaza, reads } = bridgeHarness(); await c.selectView('hot');
  c.api = async url => { reads.push(url); return url.startsWith('/api/plaza/entries?') ? { entries: [{ ...entry('c'), tags: [{ name: '深链主题', kind: 'topic' }], tagOrigin: 'manual', tagStatus: 'ready' }] } : { entry: { ...entry('c'), content: 'full body' } }; };
  const open = c.openEntry; c.openEntry = async item => { plaza.beginReader(item); await open(item); };
  vm.runInContext(appSlice('async function openEntryById(', 'async function openEntryFromUrl('), c);
  await c.openEntryById('c'); plaza.showReaderTags('c');
  assert.equal(c.state.activeEntry.content, 'full body');
  assert.equal(doc.querySelector('#plaza-reader-tags').hidden, false);
  assert(doc.querySelector('#plaza-reader-tags [data-interest="深链主题"]'));
  assert(reads.includes('/api/plaza/entries?ids=c'));
  assert.equal(plaza.snapshot().loaded, 2, 'deep link must not pretend earlier pages were loaded');
});

test('navigating to a non-plaza article clears plaza ownership before reusing the reader', async () => {
  const { c, plaza } = bridgeHarness(); await c.selectView('hot'); await plaza.open('a');
  c.routeStateFromUrl = () => ({ view: '', entryId: 'ordinary' }); let openedView;
  c.openEntryById = async () => { openedView = c.state.view; return true; };
  vm.runInContext(appSlice('async function openEntryFromUrl(', '/* ---------- Navigation ---------- */'), c);
  await c.openEntryFromUrl();
  assert.equal(openedView, 'all'); assert.equal(plaza.snapshot().active, false);
});

test('Escape closes original AI settings and font controls before closing plaza reading', async () => {
  const { c, doc, plaza } = bridgeHarness(); await c.selectView('hot'); await plaza.open('a');
  c.isShortcutEditableTarget = () => false; c.setReaderPrefsOpen = value => { c.state.readerPrefsOpen = value; };
  c.setAccountMenuOpen = () => {}; c.hideArticleLinkMenu = () => {};
  vm.runInContext(appSlice("document.addEventListener('keydown', (e) => {", "window.addEventListener('popstate'"), c);
  doc.querySelector('#ai-config-modal').classList.remove('hidden');
  await doc.body.dispatch('keydown', doc.body, { key: 'Escape' });
  assert.equal(c.state.activeEntry?.id, 'a'); assert(doc.querySelector('#ai-config-modal').classList.contains('hidden'));
  c.state.readerPrefsOpen = true;
  await doc.body.dispatch('keydown', doc.body, { key: 'Escape' });
  assert.equal(c.state.activeEntry?.id, 'a'); assert.equal(c.state.readerPrefsOpen, false);
  await doc.body.dispatch('keydown', doc.body, { key: 'Escape' }); assert.equal(c.state.activeEntry, null);
});

test('first entry loads a detached frozen snapshot with all/latest/masonry defaults', async () => {
  const { plaza, calls } = harness();
  await plaza.activate();
  const snap = plaza.snapshot();
  assert.deepEqual(plain(snap.order), ['a', 'b', 'c']);
  assert.deepEqual(plain(snap.settings), { mode: 'all', view: 'masonry', sort: 'latest', unread: false, category: '', seed: 'batch-1' });
  assert.equal(snap.loaded, 2);
  snap.order.reverse();
  snap.settings.mode = 'random';
  assert.deepEqual(plain(plaza.snapshot().order), ['a', 'b', 'c']);
  const url = new URL(calls[0][0], 'http://local');
  assert.equal(url.pathname, '/api/plaza');
  assert.equal(url.searchParams.get('limit'), '24');
});

test('分类 chips：change({category}) 触发重载并带 query 参数，snapshot 暴露 categories', async () => {
  const calls = [];
  const { plaza } = harness({ api: async url => { calls.push(url); return { ...payload(), categories: ['article', 'news'] }; } });
  await plaza.activate();
  assert.deepEqual(plain(plaza.snapshot().categories), ['article', 'news']);
  assert.equal(calls[0].includes('category='), false); // 默认全部：不带参数
  await plaza.change({ category: 'news' });
  const reloadCall = calls.find(url => url.includes('category=news'));
  assert(reloadCall, '切换分类要触发一次带 category 的重载');
  assert.equal(plaza.snapshot().settings.category, 'news');
  await plaza.change({ category: '' }); // 切回全部
  assert(calls.filter(url => url.includes('/api/plaza?')).length >= 3);
  assert.equal(plaza.snapshot().settings.category, '');
});
