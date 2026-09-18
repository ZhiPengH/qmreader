const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const slice = source.slice(source.indexOf('function updateReaderTocVisibility('), source.indexOf('function renderOriginalContent('));

function fakeNode({ hidden = false, items = [], rect = { top: 10, right: 900, width: 800, height: 880 } } = {}) {
  const classes = new Set(hidden ? ['hidden'] : []);
  const attrs = new Map();
  return {
    innerHTML: '', style: {}, items,
    classList: {
      toggle(name, on) { on ? classes.add(name) : classes.delete(name); },
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { attrs.set(name, value); },
    removeAttribute(name) { attrs.delete(name); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    getBoundingClientRect() { return rect; },
    querySelectorAll() { return this.items; },
  };
}

function heading(tag, text, top) {
  return { tagName: tag, textContent: text, id: '', getBoundingClientRect: () => ({ top }) };
}

function harness({ headings = [], links = [], tab = 'original', available = false } = {}) {
  const rail = fakeNode({ items: links });
  const pane = fakeNode();
  const content = fakeNode({ items: headings });
  const state = { readerTab: tab, readerTocAvailable: available, readerTocActiveId: '' };
  const context = {
    state,
    window: { innerWidth: 1200 },
    $: sel => ({ '#reader-toc-rail': rail, '#reader-pane': pane, '#reader-content': content }[sel]),
    escapeHtml: value => String(value),
  };
  vm.createContext(context);
  vm.runInContext(slice, context);
  return { context, rail, state, root: { querySelectorAll: () => headings } };
}

test('rail items are built from h2/h3/h4 headings and empty headings are skipped', () => {
  const { context, rail, state } = harness({ headings: [
    heading('H2', 'Intro', 40), heading('H3', 'Details', 60), heading('H2', '   ', 80), heading('H4', 'Notes', 100),
  ] });
  context.renderReaderToc(context.$('#reader-content'));
  assert.equal(state.readerTocAvailable, true);
  assert.match(rail.innerHTML, /reader-toc-rail-h2/);
  assert.match(rail.innerHTML, /reader-toc-rail-h3/);
  assert.match(rail.innerHTML, /reader-toc-rail-h4/);
  assert.doesNotMatch(rail.innerHTML, /title="\s*"/);
  assert.equal(rail.classList.contains('hidden'), false);
});

test('single heading keeps the rail hidden and empty', () => {
  const { context, rail, state } = harness({ headings: [heading('H2', 'Only', 40)] });
  context.renderReaderToc(context.$('#reader-content'));
  assert.equal(state.readerTocAvailable, false);
  assert.equal(rail.innerHTML, '');
  assert.equal(rail.classList.contains('hidden'), true);
});

// h1-only 文章（Substack/gwern 类源用 h1 做章节）：h1 纳入轨道，≥2 个即显示。
test('h1-only articles build the rail from h1 section headings', () => {
  const { context, rail, state } = harness({ headings: [
    heading('H1', 'Giving your AI a computer', 40),
    heading('H1', 'Giving an AI YOUR computer', 60),
    heading('H1', 'Everything Else', 80),
  ] });
  context.renderReaderToc(context.$('#reader-content'));
  assert.equal(state.readerTocAvailable, true);
  assert.match(rail.innerHTML, /reader-toc-rail-h1/g);
  assert.equal((rail.innerHTML.match(/reader-toc-rail-item/g) || []).length, 3);
});

// 首个 h1 与文章主标题相同（部分源正文回填标题）：跳过，不重复显示；
// 但后续章节 h1 正常计入。
test('a leading h1 duplicating the entry title is skipped, later h1 sections count', () => {
  const { context, rail, state } = harness({ headings: [
    heading('H1', 'The Article Title', 20),
    heading('H1', 'First Section', 40),
    heading('H1', 'Second Section', 60),
  ], title: 'The Article Title' });
  context.state.activeEntry = { title: 'The Article Title' };
  context.renderReaderToc(context.$('#reader-content'));
  assert.equal(state.readerTocAvailable, true);
  assert.doesNotMatch(rail.innerHTML, /The Article Title/);
  assert.equal((rail.innerHTML.match(/reader-toc-rail-item/g) || []).length, 2);
});

test('active section follows the last heading above the viewport threshold', () => {
  const headings = [heading('H2', 'One', 40), heading('H3', 'Two', 95), heading('H2', 'Three', 150)];
  headings.forEach((h, i) => { h.id = 'reader-section-' + (i + 1); });
  const links = headings.map((h, i) => {
    const link = fakeNode();
    link.setAttribute('href', '#' + h.id);
    return link;
  });
  const { context, rail } = harness({ headings, links, available: true });
  context.updateReaderTocActive();
  assert.equal(links[1].classList.contains('active'), true);
  assert.equal(links[1].getAttribute('aria-current'), 'true');
  assert.equal(links[0].classList.contains('active'), false);
  assert.equal(links[2].classList.contains('active'), false);
  assert.equal(rail.innerHTML, '');
});

test('rail is only visible on the original tab and anchors beside the pane scrollbar', () => {
  const { context, rail } = harness({ available: true });
  context.updateReaderTocVisibility('rewrite');
  assert.equal(rail.classList.contains('hidden'), true);
  context.updateReaderTocVisibility('original');
  assert.equal(rail.classList.contains('hidden'), false);
  assert.equal(rail.style.top, '450px');
  assert.equal(rail.style.right, '314px');
});
