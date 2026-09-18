// 语言判定回归：中文技术文（正文含大量终端输出/代码）不得误判为英文。
// 案例：MikeoPerfect's Diary「从Fedora40升级到Fedora44」——正文一半是
// dnf 命令与包名，raw HTML 判 latin 导致 AI 摘要自动展开；剥标签+URL 后 mixed。
// 同源近邻投票兜底：同源 ≥2 篇中文（标题+摘要判）→ 单篇 latin 也不自动生成。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const profStart = source.indexOf('function readerLanguageProfile(');
const profEnd = source.indexOf('function adaptiveReaderMeasure(');
const engStart = source.indexOf('function entryLanguageSample(');
const engEnd = source.indexOf('function maybeAutoGenerateSummary(');
assert.ok(profStart >= 0 && profEnd > profStart && engStart >= 0 && engEnd > engStart, 'slices found');

function harness(entries) {
  const ctx = vm.createContext({ state: { entries } });
  vm.runInContext(source.slice(profStart, profEnd) + '\n' + source.slice(engStart, engEnd), ctx);
  return ctx;
}

const fedoraBody = `<p>前几天开机，通知说说系统马上不支持了。</p>
<div class="highlight"><pre><span class="n">Package</span> <span class="n">Architecture</span> <span class="n">Version</span> <span class="n">Repository</span> <span class="n">Size</span>
<span class="nl">Upgrading:</span> <span class="n">google-chrome-stable</span> <span class="n">x86_64</span>
<span class="k">Transaction</span> <span class="k">Summary</span>
<span class="n">Upgrading</span> <span class="o">-</span> <span class="n">Total</span> <span class="n">download</span> <span class="n">size</span> <span class="n">M</span>
sudo dnf clean all &amp;&amp; sudo dnf upgrade --refresh https://example.com/fedora-release.rpm
</pre></div>
<p>我问AI可能是什么原因。它说，官方说一年密钥过期了。</p>
<p>然后接下来又是4-5个小时。然后，</p>
<div class="highlight"><pre>$ sudo dnf system-upgrade download --releasever=44</pre></div>
<p>终于升级到了44。</p>`;

test('code-heavy Chinese tech article is not classified as English (HTML+URL stripped)', () => {
  const ctx = harness([]);
  const entry = { id: 'a', sourceId: 'rss-1', title: '从Fedora40 升级到 Fedora44', summary: '', content: fedoraBody };
  // 剥离前 raw 会判 latin（旧实现直接自动生成摘要）；剥离后不得是 latin。
  const sample = ctx.entryLanguageSample(entry);
  assert.notEqual(vm.runInContext('readerLanguageProfile(' + JSON.stringify(sample) + ')', ctx), 'latin');
  // 判定链终点：不是英文 → 不自动生成摘要。
  assert.equal(ctx.entryIsEnglishForSummary(entry), false);
});

test('neighbor voting pulls a latin-looking entry back when the source is Chinese', () => {
  const neighbors = [
    { id: 'n1', sourceId: 'rss-1', title: '爱睡觉的鸟', summary: '脑子里面依然有很多东西想要表达' },
    { id: 'n2', sourceId: 'rss-1', title: '童年阴影', summary: '能够称为我童年阴影的有两部片子' },
  ];
  const ctx = harness(neighbors);
  // 构造一篇正文判定仍为 latin 的极端文（全英文摘要+链接），同源近邻是中文 → 不自动生成。
  const entry = { id: 'x', sourceId: 'rss-1', title: 'Release Notes 44', summary: 'All packages upgraded via dnf system-upgrade.', content: '<p>dnf system-upgrade --releasever=44</p>' };
  assert.equal(ctx.entryIsEnglishForSummary(entry), false);
});

test('genuinely English sources are untouched by neighbor voting', () => {
  const neighbors = [
    { id: 'e1', sourceId: 'substack-1', title: 'Agency and Agents', summary: 'Increasingly, it is going to determine what happens next with AI.' },
    { id: 'e2', sourceId: 'substack-1', title: 'The twilight of the chatbots', summary: 'For much of the last few years...' },
  ];
  const ctx = harness(neighbors);
  const entry = { id: 'x', sourceId: 'substack-1', title: 'An opinionated guide', summary: '', content: '<p>You can do this with any AI model. The key is to experiment and see what works for your workflow.</p>' };
  assert.equal(ctx.entryIsEnglishForSummary(entry), true);
});
