const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
const appearance = source.slice(source.indexOf('const PALETTES ='), source.indexOf("window.addEventListener('error'"));
function open(saved, blocked = false) {
  const nodes = { '#palette-select': {}, '#theme-toggle': { setAttribute() {} } };
  const messages = [];
  const context = { document: { body: { dataset: {} } }, $: id => nodes[id], toast: msg => messages.push(msg), window: { localStorage: {
    setItem(k, v) { if (blocked) throw new Error('blocked'); saved.set(k, v); }, getItem: k => saved.get(k) ?? null,
  } } };
  vm.createContext(context);
  vm.runInContext(appearance, context);
  context.applyAppearance(saved.get('fr_palette'), saved.get('fr_theme'));
  return { context, nodes, messages };
}
test('all palettes preserve brightness and persist independently across fresh page contexts', () => {
  const saved = new Map();
  for (const palette of ['neutral', 'atelier', 'midnight', 'sage', 'mist', 'rose']) {
    for (const mode of ['light', 'dark']) {
      let page = open(saved);
      if (page.context.document.body.dataset.theme !== mode) page.nodes['#theme-toggle'].onclick();
      page.nodes['#palette-select'].onchange({ target: { value: palette } });
      assert.equal(page.context.document.body.dataset.theme, mode);
      for (let i = 0; i < 2; i++) {
        page.nodes['#theme-toggle'].onclick();
        assert.equal(page.context.document.body.dataset.palette, palette);
      }
      page = open(saved);
      assert.equal(page.context.document.body.dataset.palette, palette);
      assert.equal(page.context.document.body.dataset.theme, mode);
      assert.equal(page.nodes['#palette-select'].value, palette);
    }
  }
});
test('invalid saved settings fall back and storage failure warns without blocking switching', () => {
  const page = open(new Map([['fr_palette', 'bogus'], ['fr_theme', 'bogus']]), true);
  assert.equal(page.context.document.body.dataset.palette, 'neutral');
  assert.equal(page.context.document.body.dataset.theme, 'light');
  page.nodes['#palette-select'].onchange({ target: { value: 'midnight' } });
  page.nodes['#theme-toggle'].onclick();
  assert.equal(page.context.document.body.dataset.palette, 'midnight');
  assert.equal(page.context.document.body.dataset.theme, 'dark');
  assert.equal(page.messages.length, 2);
});
