const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const fetcher = require(path.join(__dirname, '..', 'lib', 'fetcher.js'));

// Fixture mirrors the real SSR markup of https://xbangdan.com/articles/
// (verified 2026-09-23): one entry per <a class="ac" data-tk="art" data-age="...">.
const FIXTURE = `
<section class="acs acs4" id="art-list">
<a class="ac t1" data-tk="art" data-zone="cn" data-age="31.46" href="https://x.com/old_timer/status/1000000000000000001" target="_blank" rel="noopener">
<span class="ac-rk"></span>
<span class="ac-cv">
<img loading="lazy" src="/feed/img/media/OLD.jpg?format=jpg&amp;name=small" alt="">
<span class="ac-pv">这条是三十一天前的老条目，应当被 21 天窗口过滤掉。</span>
</span>
<span class="ac-bd">
<span class="ac-t">旧条目标题</span>
<span class="ac-who">
<img class="ac-av" loading="lazy" src="/avatars/old_timer.jpg" alt="旧人">
<span class="ac-nm"><b>旧人</b><i>@old_timer · 10万 曝光</i></span>
<span class="ac-top" title="采集于 08/30"><span class="ac-q">100</span><span class="ac-qu">收藏</span></span>
</span>
</span>
</a>
<a class="ac t1" data-tk="art" data-zone="cn" data-age="3.03" href="https://x.com/miles_mazy/status/2091339513134010554" target="_blank" rel="noopener">
<span class="ac-rk"></span>
<span class="ac-cv">
<img loading="lazy" src="/feed/img/media/HQVi4DkasAAhLPz.jpg?format=jpg&amp;name=small" alt="">
<span class="ac-pv">第一次打开 Codex，真正容易卡住的是眼前这些区域分别管什么。</span>
</span>
<span class="ac-bd">
<span class="ac-t">万字长文｜Codex 从入门到精通</span>
<span class="ac-who">
<img class="ac-av" loading="lazy" src="/avatars/miles_mazy.jpg" alt="Miles Ma">
<span class="ac-nm"><b>Miles Ma</b><i>@miles_mazy · 210.8万 曝光</i></span>
<span class="ac-top" title="采集于 17:10"><span class="ac-q">11570</span><span class="ac-qu">收藏</span></span>
</span>
</span>
</a>
<a class="ac t2" data-tk="art" data-zone="gl" data-age="17.5" href="https://x.com/overseas/status/2000000000000000002" target="_blank" rel="noopener">
<span class="ac-rk"></span>
<span class="ac-cv">
<span class="ac-pv">Overseas entry within window.</span>
</span>
<span class="ac-bd">
<span class="ac-t">Overseas longform</span>
<span class="ac-who">
<span class="ac-nm"><b>Global Author</b><i>@overseas · 5.2万 曝光</i></span>
<span class="ac-top" title="采集于 09/01"><span class="ac-q">999</span><span class="ac-qu">收藏</span></span>
</span>
</span>
</a>
</section>
`;

const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

test('xbangdan parser keeps entries within the 21-day window and drops older ones', () => {
  const items = fetcher.parseXbangdanHtml(FIXTURE, { now: NOW });
  assert.equal(items.length, 2, '31.46-day entry must be filtered; 3.03 and 17.5 stay');
  const links = items.map(i => i.link);
  assert.ok(links.includes('https://x.com/miles_mazy/status/2091339513134010554'));
  assert.ok(links.includes('https://x.com/overseas/status/2000000000000000002'));
  assert.ok(!links.includes('https://x.com/old_timer/status/1000000000000000001'));
});

test('xbangdan parser maps markup to feed item fields', () => {
  const items = fetcher.parseXbangdanHtml(FIXTURE, { now: NOW });
  const main = items.find(i => i.link.includes('miles_mazy'));
  assert.equal(main.title, '万字长文｜Codex 从入门到精通');
  assert.equal(main.guid, 'https://x.com/miles_mazy/status/2091339513134010554');
  assert.equal(main.creator, 'Miles Ma (@miles_mazy)');
  // pubDate = now - data-age days
  const expected = new Date(NOW - 3.03 * 86400000).toISOString();
  assert.equal(main.pubDate, expected);
  assert.ok(main.content.includes('第一次打开 Codex'));
  assert.ok(main.content.includes('11570'), 'favorites count appears in content');
  assert.ok(main.content.includes('210.8万'), 'exposure appears in content');
  assert.equal(main.mediaThumbnail.$.url, 'https://xbangdan.com/feed/img/media/HQVi4DkasAAhLPz.jpg?format=jpg&name=small');
});

test('xbangdan entries without a cover image still parse', () => {
  const items = fetcher.parseXbangdanHtml(FIXTURE, { now: NOW });
  const overseas = items.find(i => i.link.includes('overseas'));
  assert.equal(overseas.title, 'Overseas longform');
  assert.ok(!overseas.mediaThumbnail, 'no cover in markup -> no mediaThumbnail');
});

test('xbangdan source is registered with the custom feed prefix', () => {
  const { SOURCES } = require(path.join(__dirname, '..', 'lib', 'sources.js'));
  const src = SOURCES.find(s => s.id === 'xbangdan');
  assert.ok(src, 'source registered');
  assert.equal(src.enabled, true);
  assert.deepEqual(src.feeds, ['xbangdan:https://xbangdan.com/articles/']);
});
