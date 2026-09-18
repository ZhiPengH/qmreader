// renderMarkdownLite / renderInlineMarkdown 渲染安全：正文含 ![图片] 语法不得抛
// ReferenceError（2026-09-18 线上事故：重写正文带图片 → eager 未定义 → 「重写失败」，
// 实际服务端已生成成功，纯前端渲染崩溃）。断言渲染产物含 lazy 图片与链接语义。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const inlineStart = source.indexOf('function renderInlineMarkdown(');
const liteEnd = source.indexOf('function plainTextFromHtml(');
assert.ok(inlineStart >= 0 && liteEnd > inlineStart, 'source slices found');

const context = vm.createContext({
  escapeHtml: v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
});
vm.runInContext(source.slice(inlineStart, liteEnd), context);

test('markdown-lite renders image syntax as lazy img without throwing', () => {
  const body = '开头段落\n\n![chart](https://example.test/a.png)\n\n中间 **加粗** 与 [链接](https://example.test/x) 及 `code`\n\n- 列表项 ![小图](https://example.test/b.jpg)';
  const html = context.renderMarkdownLite(body);
  assert.match(html, /<img src="https:\/\/example\.test\/a\.png"[^>]*loading="lazy"/);
  assert.match(html, /<img src="https:\/\/example\.test\/b\.jpg"[^>]*loading="lazy"/);
  assert.doesNotMatch(html, /eager/);
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /href="https:\/\/example\.test\/x"/);
});

test('image-only rewrite body renders instead of raising ReferenceError', () => {
  // 复刻线上形态：重写正文首段即图片，此前直接 ReferenceError。
  const body = '![cover](https://example.test/cover.png)';
  assert.doesNotThrow(() => context.renderMarkdownLite(body));
  assert.match(context.renderMarkdownLite(body), /loading="lazy"/);
});
