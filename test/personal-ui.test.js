const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function between(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert(from >= 0 && to > from, `Missing source section: ${start}`);
  return source.slice(from, to);
}

function harness(api) {
  const nodes = new Map();
  const messages = [];
  const context = {
    state: { me: { id: 'personal' }, identityStatus: 'ready', read: new Set(), starred: new Set(), history: new Map() },
    api,
    $: selector => {
      if (!nodes.has(selector)) nodes.set(selector, { disabled: false, innerHTML: '' });
      return nodes.get(selector);
    },
    toast: message => messages.push(message),
    mergeEntryStats() {},
    renderEntryStateUi() {},
    document: { body: { dataset: {} } },
    storage: { getItem: () => null },
    escapeHtml: value => value,
    setCurrentUser(user) { context.state.me = user; },
  };
  for (const name of ['applyAppearance', 'hydrateLucideIcons', 'loadAiProfilesForScope', 'renderAgentPrompts', 'applyReaderPrefs',
    'renderAiSettings', 'renderPersonalIdentityState', 'setSidebarCollapsed', 'setLeftCollapsed',
    'setEntryPaneWidth', 'setupListResizer', 'setContextPaneWidth', 'setupContextResizer',
    'setAgentCollapsed', 'setContextPanel', 'renderComments', 'renderAgent']) context[name] = () => {};
  vm.createContext(context);
  vm.runInContext([
    between('function normalizeHistory(', 'const state ='),
    between('function requirePersonalIdentity()', 'function openSubmitLinkModal'),
    between('async function loadUserEntryStates()', 'function defaultEntryStats('),
    between('async function syncEntryState(', 'function recordEntryView('),
    between('async function loadMe()', '/* ---------- Sidebar'),
    between("$('#mark-read-btn').onclick", 'async function setReaderReaction'),
  ].join('\n'), context);
  return { context, nodes, messages };
}

test('personal frontend never accesses guest reading storage or removed auth routes', () => {
  assert.doesNotMatch(source, /fr_read|fr_starred|qm_history|guestRead|guestStarred|guestHistory/);
  assert.doesNotMatch(source, /\/api\/auth\/|\/api\/me\/password|openAuth\(|requireAuth\(/);
});

test('successful server writes update read, star and history; failed writes preserve confirmed state', async () => {
  let fail = false;
  const { context, messages } = harness(async () => {
    if (fail) throw new Error('offline');
    return {};
  });
  await context.syncEntryState('one', { read: true, starred: true, viewed: true });
  assert(context.state.read.has('one'));
  assert(context.state.starred.has('one'));
  const viewedAt = context.state.history.get('one');
  assert(viewedAt > 0);
  fail = true;
  await context.syncEntryState('one', { read: false, starred: false, viewed: true });
  await context.syncEntryState('two', { read: true, starred: true, viewed: true });
  assert.deepEqual([...context.state.read], ['one']);
  assert.deepEqual([...context.state.starred], ['one']);
  assert.equal(context.state.history.size, 1);
  assert.equal(context.state.history.get('one'), viewedAt);
  assert.equal(messages.length, 2);
});

test('batch read failure leaves unread entries unchanged', async () => {
  const { context, nodes } = harness(async () => { throw new Error('offline'); });
  context.visibleEntries = () => [{ id: 'one' }, { id: 'two' }];
  context.state.read.add('one');
  await nodes.get('#mark-read-btn').onclick();
  assert.deepEqual([...context.state.read], ['one']);
});

test('repeated star actions while pending send one request and re-enable after completion', async () => {
  let finish;
  let calls = 0;
  const { context, nodes } = harness(() => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  });
  context.state.activeEntry = { id: 'one' };
  const button = nodes.get('#reader-star');
  const first = button.onclick();
  assert.equal(button.disabled, true);
  await button.onclick();
  assert.equal(calls, 1);
  assert.equal(context.state.starred.size, 0);
  finish({});
  await first;
  assert.equal(button.disabled, false);
  assert(context.state.starred.has('one'));
});

for (const failure of ['identity request', 'missing identity', 'reading state request']) {
  test(`startup ${failure} failure exposes retry without falling back to guest`, async () => {
    const calls = [];
    const { context, nodes } = harness(async endpoint => {
      calls.push(endpoint);
      if (failure === 'missing identity') return { user: null };
      if (failure === 'reading state request' && endpoint === '/api/me') return { user: { id: 'personal' } };
      throw new Error('offline');
    });
    context.state.me = null;
    context.state.identityStatus = 'loading';
    context.storage.getItem = key => {
      assert.ok(['fr_theme', 'fr_palette'].includes(key), 'Only appearance settings may be read before identity');
      return null;
    };
    context.loadSources = context.loadEntries = context.loadContributors = () => assert.fail('Collections must wait for personal data');
    await vm.runInContext(source.slice(source.indexOf('(async function init() {')), context);
    assert.equal(context.state.identityStatus, 'unavailable');
    assert.equal(context.state.me, null);
    assert.equal(context.state.read.size + context.state.starred.size + context.state.history.size, 0);
    assert.match(nodes.get('#entry-list').innerHTML, /重新加载/);
    const count = calls.length;
    await context.syncEntryState('one', { read: true, starred: true, viewed: true });
    assert.equal(calls.length, count, 'Unavailable identity cannot write states');
  });
}
