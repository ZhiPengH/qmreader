/* Plaza owns its frozen discovery sequence; the existing app owns reading. */
(function (global) {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const STORAGE_KEY = 'qm_plaza_v1';
  function create(adapter) {
    const newSeed = () => adapter.seed ? adapter.seed() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    let saved = {};
    try { saved = JSON.parse(adapter.storage?.getItem(STORAGE_KEY) || '{}'); } catch {}
    const settings = { mode: ['all', 'random', 'personal'].includes(saved.mode) ? saved.mode : 'all', view: saved.view === 'list' ? 'list' : 'masonry', sort: 'latest', unread: false, seed: newSeed() };
    let confirmedSettings = { ...settings }, failedSettings = null;
    let order = [], entries = new Map(), loaded = 0, revision = 0, newCount = 0;
    let active = false, initialized = false, epoch = 0, loading = false, error = '', readerId = '', position = null;
    let preferences = { interests: [], ignored: [], knownTags: [] }, tagging = { autoEnabled: false };
    let ui = null;
    const emit = (type, data) => { adapter.onChange?.(type, data); ui?.update(type, data); };
    function snapshot() { return copy({ settings, order, entries: [...entries.values()], loaded, revision, preferences, tagging, active, loading, error, readerId, newCount, pending: [...pendingWrites] }); }
    function visibleEntries() { return order.slice(0, loaded).map(id => entries.get(id)).filter(Boolean); }
    async function refresh({ shuffle = false } = {}) {
      if (shuffle) settings.seed = newSeed();
      const token = ++epoch, requestedSettings = { ...settings };
      failedSettings = null;
      loading = true; error = ''; emit('state');
      try {
        const query = new URLSearchParams({ mode: settings.mode, sort: settings.mode === 'all' ? settings.sort : 'latest', unread: settings.unread ? '1' : '0', seed: settings.seed, limit: '24' });
        const data = await adapter.api('/api/plaza?' + query);
        if (!active || token !== epoch) return;
        order = [...data.order];
        entries = new Map(data.entries.map(item => [item.id, item]));
        loaded = data.entries.length;
        revision = data.revision; newCount = 0;
        preferences = data.preferences; tagging = data.tagging;
        initialized = true; confirmedSettings = { ...settings };
        try { adapter.storage?.setItem(STORAGE_KEY, JSON.stringify({ mode: settings.mode, view: settings.view })); } catch {}
        emit('reset', visibleEntries());
        return true;
      } catch (err) {
        if (active && token === epoch) {
          error = err.message; failedSettings = requestedSettings;
          Object.assign(settings, { ...confirmedSettings, view: settings.view }); emit('settings');
          return false;
        }
      }
      finally { if (token === epoch) { loading = false; emit('state'); } }
    }
    async function activate() { active = true; emit('active', true); if (!initialized) await refresh(); }
    function deactivate() { active = false; epoch++; loading = false; close({ restore: false }); emit('active', false); }
    async function change(patch) {
      const reload = ['mode', 'sort', 'unread'].some(key => key in patch && patch[key] !== settings[key]);
      if (patch.mode && ['all', 'random', 'personal'].includes(patch.mode)) settings.mode = patch.mode;
      if (patch.view && ['masonry', 'list'].includes(patch.view)) settings.view = patch.view;
      if (patch.sort) settings.sort = patch.sort === 'oldest' ? 'oldest' : 'latest';
      if ('unread' in patch) settings.unread = Boolean(patch.unread);
      emit('settings');
      if (reload) {
        close({ restore: false });
        await refresh();
      }
      try { adapter.storage?.setItem(STORAGE_KEY, JSON.stringify({ mode: settings.mode, view: settings.view })); } catch {}
    }
    function retryLoad() {
      if (failedSettings) { Object.assign(settings, { ...failedSettings, view: settings.view }); return refresh(); }
      return loaded ? loadMore() : refresh();
    }
    async function loadMore() {
      if (!active || loading || loaded >= order.length) return;
      const token = epoch, ids = order.slice(loaded, loaded + 24);
      loading = true; error = ''; emit('state');
      try {
        const data = await adapter.api('/api/plaza/entries?ids=' + encodeURIComponent(ids.join(',')));
        if (!active || token !== epoch) return;
        for (const item of data.entries) entries.set(item.id, item);
        loaded += ids.length;
        emit('append', ids.map(id => entries.get(id)).filter(Boolean));
      } catch (err) { if (active && token === epoch) error = err.message; }
      finally { if (token === epoch) { loading = false; emit('state'); } }
    }
    async function checkStatus() {
      if (!active || loading || (adapter.isVisible && !adapter.isVisible())) return;
      const token = epoch;
      try {
        const data = await adapter.api('/api/plaza/status?after=' + revision);
        if (!active || token !== epoch) return;
        newCount = data.newCount; tagging = data.tagging; emit('state');
      } catch (err) { if (active && token === epoch) { error = '检查更新失败：' + err.message; emit('state'); } }
    }
    let navigation = 0;
    // Tag fields are store-owned: only update()/saveTags()/hydrate() may write them; reader entries never clobber them.
    const TAG_FIELDS = ['tags', 'tagStatus', 'tagOrigin', 'tagInputHash', 'tagError', 'tagUpdatedAt'];
    function beginReader(item, trigger) {
      if (!readerId) position = adapter.capturePosition?.(trigger) || null;
      const previous = entries.get(item.id);
      const merged = { ...previous, ...item };
      if (previous) for (const field of TAG_FIELDS) merged[field] = previous[field];
      entries.set(item.id, merged);
      if (readerId !== item.id) { navigation++; readerId = item.id; emit('reader', readerId); }
    }
    function hydrate(item) {
      if (!order.includes(item.id)) return false;
      entries.set(item.id, { ...entries.get(item.id), ...item });
      return entries.get(item.id);
    }
    function readerEntry(id) { return entries.get(id) || null; }
    async function open(id, trigger, options) {
      const item = entries.get(id);
      if (!item || !active) return;
      beginReader(item, trigger);
      await adapter.openEntry?.(item, options);
    }
    async function move(delta) {
      if (!active) return;
      const token = ++navigation, generation = epoch;
      const index = readerId ? order.indexOf(readerId) + delta : delta > 0 ? 0 : order.length - 1;
      if (index < 0 || index >= order.length) { adapter.edge?.(delta); return; }
      while (loaded <= index) {
        const before = loaded; await loadMore();
        if (before === loaded || token !== navigation || generation !== epoch) return;
      }
      if (active && token === navigation && generation === epoch) await open(order[index]);
    }
    function close({ restore = true } = {}) {
      navigation++;
      if (!readerId) return;
      readerId = ''; adapter.closeReader?.(); emit('reader', '');
      if (restore && position) adapter.restorePosition?.(position);
      position = null;
    }
    const pendingWrites = new Set(), undo = new Map(), tagVersions = new Map();
    let preferenceVersion = 0;
    function tagPatch(item) {
      return Object.fromEntries(['id', 'tags', 'tagStatus', 'tagOrigin', 'tagInputHash', 'tagError', 'tagUpdatedAt'].filter(key => key in item).map(key => [key, item[key]]));
    }
    function update(item) {
      const previous = entries.get(item.id);
      if (!previous) return;
      const next = { ...previous, ...item };
      if (item.stats && 'reactionByMe' in item.stats) next.reactionByMe = item.stats.reactionByMe;
      entries.set(item.id, next); emit('update', next);
    }
    async function write(key, url, body, method, apply) {
      if (pendingWrites.has(key)) return false;
      const token = epoch; pendingWrites.add(key); error = ''; emit('state');
      try {
        const data = await adapter.api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        if (!active || token !== epoch) return false;
        apply(data); return true;
      } catch (err) { if (active && token === epoch) error = err.message; return false; }
      finally { pendingWrites.delete(key); emit('state'); }
    }
    function setInterest(tag, interested) {
      preferenceVersion++;
      return write('preferences', '/api/plaza/interests', { tag, interested }, 'PATCH', data => { preferences = data.preferences; emit('preferences'); });
    }
    function saveTags(id, tags) {
      tagVersions.set(id, (tagVersions.get(id) || 0) + 1);
      return write('tags:' + id, '/api/plaza/entries/' + encodeURIComponent(id) + '/tags', { tags }, 'PATCH', data => update(tagPatch(data.entry)));
    }
    function react(id, reaction, { exact = false, remember = true } = {}) {
      const item = entries.get(id) || preferences.ignored.find(item => item.id === id);
      if (!item) return Promise.resolve(false);
      const previous = item.reactionByMe || item.stats?.reactionByMe || '';
      const next = !exact && previous === reaction ? '' : reaction;
      return write('reaction:' + id, '/api/entry/' + encodeURIComponent(id) + '/reaction', { reaction: next }, 'POST', data => {
        if (remember && next === 'dislike') undo.set(id, previous); else undo.delete(id);
        update({ id, stats: data.stats, reactionByMe: next });
        adapter.mergeStats?.(id, data.stats);
        preferenceVersion++;
        preferences.ignored = preferences.ignored.filter(item => item.id !== id);
        if (next === 'dislike') preferences.ignored.push({ ...item, reactionByMe: next });
        emit('feedback', { id, reaction: next, canUndo: undo.has(id) });
      });
    }
    function undoReaction(id) { return undo.has(id) ? react(id, undo.get(id), { exact: true, remember: false }) : Promise.resolve(false); }
    let tagQueue = Promise.resolve();
    const attempted = new Set();
    const tagKey = item => item.id + ':' + (item.tagInputHash || '');
    function generateTags(ids, { retry = false, automatic = false } = {}) {
      const token = epoch;
      const task = async () => {
        if (!active || token !== epoch || (automatic && !tagging.autoEnabled)) return false;
        const candidates = [...new Set(ids)].map(id => entries.get(id)).filter(item => item && item.tagOrigin !== 'manual' && item.tagStatus !== 'ready' && (retry || item.tagStatus !== 'failed') && (!automatic || !attempted.has(tagKey(item))));
        for (let offset = 0; offset < candidates.length; offset += 8) {
          if (!active || token !== epoch) return false;
          const batch = candidates.slice(offset, offset + 8);
          const versions = new Map(batch.map(item => [item.id, tagVersions.get(item.id)]));
          batch.forEach(item => attempted.add(tagKey(item)));
          error = ''; emit('tagging', batch.map(item => item.id));
          try {
            const data = await adapter.api('/api/plaza/tags', { method: 'POST', aiConfig: adapter.aiConfig?.(), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entryIds: batch.map(item => item.id), retry, automatic }) });
            if (!active || token !== epoch) return false;
            (data.entries || []).forEach(item => {
              if (versions.get(item.id) === tagVersions.get(item.id) && entries.get(item.id)?.tagOrigin !== 'manual') update(tagPatch(item));
            });
            tagging.usage = data.usage;
            if (data.skipped) { error = '标签未生成：' + data.skipped; emit('state'); return false; }
          } catch (err) {
            if (active && token === epoch) {
              error = '标签生成失败：' + err.message;
              // A manual retry is offered; hover and failed automatic batches never loop.
              candidates.forEach(item => attempted.add(tagKey(item)));
              if (!automatic && /API Key|未配置|Authentication|401/i.test(err.message)) adapter.openAiSettings?.();
              emit('state');
            }
            return false;
          } finally { if (active && token === epoch) emit('tagging', []); }
        }
        return true;
      };
      tagQueue = tagQueue.then(task, task);
      return tagQueue;
    }
    function autoTagLoaded() { return generateTags(visibleEntries().map(item => item.id), { automatic: true }); }
    async function loadPreferences() {
      const token = epoch, version = preferenceVersion;
      try {
        const data = await adapter.api('/api/plaza/preferences');
        if (active && token === epoch && version === preferenceVersion) { preferences = data.preferences; emit('preferences'); }
      } catch (err) { if (active && token === epoch) { error = err.message; emit('state'); } }
    }
    const controller = { activate, deactivate, refresh, change, snapshot, visibleEntries, loadMore, retryLoad, checkStatus, open, close, beginReader, hydrate, readerEntry, move, update, setInterest, saveTags, react, undoReaction, generateTags, autoTagLoaded, loadPreferences,
      showReaderTags: id => ui?.showReaderTags(id), closeOverlays: () => ui?.closeOverlays() || false };
    if (adapter.root) ui = mount(adapter.root, controller, adapter);
    return controller;
  }

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tagKeyFor = tag => tag.kind + ':' + tag.name;
  function mount(root, plaza, adapter) {
    const doc = root.ownerDocument, win = doc.defaultView;
    const $ = selector => root.querySelector(selector);
    const icon = name => adapter.icon ? adapter.icon(name) : '';
    const button = (label, attrs = '', name = '') => `<button type="button" class="plaza-btn" ${attrs}>${name ? icon(name) : ''}${esc(label)}</button>`;
    const mobile = () => win.matchMedia('(max-width: 840px)').matches;
    const cards = new Map();
    let columns = [], columnWidth = 0, readerTagId = '', lastTagTrigger = null, suppressTagFocus = false;
    root.innerHTML = `<header class="plaza-heading"><button type="button" class="plaza-btn plaza-mobile-menu" data-sidebar aria-label="展开侧边栏">${icon('panel-left-open')}</button><h1>广场</h1><span id="plaza-total"></span>${button('兴趣偏好', 'data-preferences', 'sliders-horizontal')}</header>
      <div class="plaza-controls"><div class="plaza-modes" role="tablist" aria-label="浏览方式">${[['all', '全部'], ['random', '随便看看'], ['personal', '我喜欢']].map(([mode, label]) => button(label, `role="tab" data-mode="${mode}" aria-selected="${mode === 'all'}"`)).join('')}</div><div class="plaza-layouts" role="group" aria-label="展示方式">${button('瀑布流', 'data-layout="masonry" aria-pressed="true"', 'boxes')}${button('列表', 'data-layout="list" aria-pressed="false"', 'file-text')}</div></div>
      <div class="plaza-filters"><label id="plaza-sort-label"><select id="plaza-sort" aria-label="排序"><option value="latest">按最新发布</option><option value="oldest">按最早发布</option></select></label><label><input id="plaza-unread" type="checkbox">仅未读</label><span id="plaza-shown"></span>${button('换一批', 'data-shuffle hidden', 'refresh-cw')}</div>
      <p class="plaza-helper" id="plaza-helper"></p><button type="button" id="plaza-update" class="plaza-btn" hidden></button>
      <div id="plaza-feed" class="plaza-feed" aria-label="文章广场"></div><div class="plaza-load-foot"><p id="plaza-load-status" role="status"></p>${button('继续浏览', 'id="plaza-more"')}</div>`;
    const prefs = doc.createElement('dialog');
    prefs.id = 'plaza-preferences'; prefs.setAttribute('id', 'plaza-preferences'); prefs.classList.add('plaza-dialog'); prefs.setAttribute('aria-labelledby', 'plaza-preferences-title');
    prefs.innerHTML = `<header><h2 id="plaza-preferences-title">兴趣偏好</h2>${button('关闭', 'data-close-preferences', 'x')}</header><div class="plaza-prefs-body"><h3>我主动选择的兴趣</h3><p>取消主动偏好不会屏蔽主题，也不会改变文章点赞。</p><div id="plaza-interests" class="plaza-tag-list"></div>${addForm()}<details id="plaza-ignored"><summary>不感兴趣的文章</summary><p>恢复推荐资格，不会自动点赞。</p><div id="plaza-ignored-list"></div></details><p role="alert" class="plaza-error"></p></div>`;
    doc.body.appendChild(prefs);
    const notice = doc.createElement('div'); notice.classList.add('plaza-notice'); notice.hidden = true; notice.setAttribute('role', 'status'); doc.body.appendChild(notice);
    const readerTags = doc.querySelector('#plaza-reader-tags');
    function addForm() {
      return `<form class="plaza-tag-add" data-add-interest><input name="name" maxlength="24" required aria-label="新兴趣标签" placeholder="新兴趣标签"><select name="kind" aria-label="标签类型"><option value="topic">主题</option><option value="format">体裁</option></select><button class="plaza-btn" type="submit">添加兴趣</button></form>`;
    }
    function tagButton(tag, interested) { return button(tag.name + (tag.kind === 'format' ? ' · 体裁' : ''), `data-interest="${esc(tag.name)}" data-kind="${esc(tag.kind)}" aria-pressed="${interested}"`); }
    function picker(item) {
      const pref = plaza.snapshot().preferences, selected = new Set(pref.interests.map(tagKeyFor));
      const tags = item.tags || [], keys = new Set(tags.map(tagKeyFor));
      const known = [...new Map([...pref.interests, ...pref.knownTags].map(t => [tagKeyFor(t), t])).values()].filter(t => !keys.has(tagKeyFor(t)));
      return `<div class="plaza-pop-head"><strong>想多看哪类内容？</strong>${button('关闭', 'data-close-tags', 'x')}</div><div class="plaza-tag-list">${tags.map(t => tagButton(t, selected.has(tagKeyFor(t)))).join('')}</div>
        ${item.tagStatus !== 'ready' && item.tagOrigin !== 'manual' ? `<p class="plaza-tag-note">${item.tagStatus === 'failed' ? esc(item.tagError || '候选标签生成失败，请检查 AI 配置后重试。') : '还没有候选标签。'}</p>${button(item.tagStatus === 'failed' ? '重试' : '生成候选标签', `data-generate="${esc(item.id)}" data-retry="${item.tagStatus === 'failed'}"`)}${button('AI 设置', 'data-ai-settings')}` : ''}
        <details class="plaza-tag-extra"><summary>其他已有标签</summary><div class="plaza-tag-list">${known.map(t => tagButton(t, selected.has(tagKeyFor(t)))).join('') || '<span>暂无其他标签</span>'}</div></details>${addForm()}
        <details class="plaza-tag-extra"><summary>纠正文章标签</summary><form data-correct-tags="${esc(item.id)}"><label>主题（每行一个）<textarea name="topic" rows="2">${esc(tags.filter(t => t.kind === 'topic').map(t => t.name).join('\n'))}</textarea></label><label>体裁（每行一个）<textarea name="format" rows="2">${esc(tags.filter(t => t.kind === 'format').map(t => t.name).join('\n'))}</textarea></label><button type="submit" class="plaza-btn">保存文章标签</button></form></details><p class="plaza-tag-note">选择兴趣不会点赞；纠正标签不表达兴趣。${item.tagOrigin === 'manual' ? '文章标签已人工确认。' : ''}</p><p role="alert" class="plaza-error"></p>`;
    }
    function makeCard(item) {
      const card = doc.createElement('article'); card.classList.add('plaza-card'); card.dataset.entryId = item.id;
      card.dataset.ratio = ['1/2', '3/4', '9/16', '4/3', '16/9'].includes(item.cardRatio) ? item.cardRatio : '4/3';
      const image = typeof item.image === 'string' && /^(https?:\/\/|\/)/i.test(item.image) ? item.image : '';
      card.classList.toggle('plaza-has-image', Boolean(image));
      const title = item.titleZh || item.title || '未命名文章';
      const date = Number(item.publishedTs) || Date.parse(item.published || '') || Number(item.createdAt);
      card.innerHTML = `<div class="plaza-card-top"><span class="plaza-source">${esc(item.sourceName || item.sourceId || '')}</span><div class="plaza-actions">${button('', `data-like="${esc(item.id)}" aria-label="点赞：${esc(title)}" aria-pressed="false"`, 'thumbs-up')}${button('', `data-dislike="${esc(item.id)}" aria-label="不感兴趣：${esc(title)}" aria-pressed="false"`, 'thumbs-down')}</div></div><button type="button" class="plaza-card-open" data-open="${esc(item.id)}"><h2 class="plaza-card-title">${esc(title)}</h2><p class="plaza-card-summary">${esc(adapter.plainText ? adapter.plainText(item.summary || '') : item.summary || '')}</p>${image ? `<img class="plaza-card-image" src="${esc(image)}" alt="" loading="lazy" decoding="async">` : ''}</button><footer class="plaza-card-bottom"><time>${Number.isFinite(date) && date > 0 ? new Date(date).toLocaleDateString('zh-CN') : ''}</time><span class="plaza-read-mark" hidden>已读</span></footer><section class="plaza-tag-pop" aria-label="文章兴趣标签" hidden>${picker(item)}</section>`;
      cards.set(item.id, card); $('#plaza-feed').appendChild(card); updateCard(item); return card;
    }
    function updateCard(item) {
      const card = cards.get(item.id); if (!card) return;
      const reaction = item.reactionByMe || item.stats?.reactionByMe || '';
      card.querySelector('[data-like]').setAttribute('aria-pressed', String(reaction === 'like'));
      card.querySelector('[data-dislike]').setAttribute('aria-pressed', String(reaction === 'dislike'));
      card.querySelector('.plaza-read-mark').hidden = !item.read;
      card.classList.toggle('plaza-is-ignored', reaction === 'dislike');
    }
    function layout(appendOnly = false) {
      const feed = $('#plaza-feed'), list = plaza.snapshot().settings.view === 'list';
      feed.classList.toggle('plaza-list', list);
      const width = feed.clientWidth; if (!width) return;
      const count = width >= 960 ? 3 : width >= 550 && !mobile() ? 2 : 1, gap = 16;
      const nextWidth = (width - gap * (count - 1)) / count;
      if (!appendOnly || columns.length !== count || columnWidth !== nextWidth) { columns = Array(count).fill(0); columnWidth = nextWidth; appendOnly = false; }
      for (const card of cards.values()) {
        if (list) { card.style.left = ''; card.style.top = ''; card.style.width = ''; card.style.minHeight = ''; card.dataset.placed = ''; continue; }
        if (appendOnly && card.dataset.placed) continue;
        const [w, h] = card.dataset.ratio.split('/').map(Number);
        card.style.width = columnWidth + 'px'; card.style.minHeight = columnWidth * h / w + 'px';
        const column = columns.indexOf(Math.min(...columns));
        card.style.left = column * (columnWidth + gap) + 'px'; card.style.top = columns[column] + 'px';
        columns[column] += card.offsetHeight + gap; card.dataset.placed = '1';
      }
      feed.style.height = list ? 'auto' : Math.max(0, ...columns) + 'px';
    }
    function updateControls() {
      const s = plaza.snapshot();
      root.querySelectorAll('[data-mode]').forEach(b => { b.setAttribute('aria-selected', String(b.dataset.mode === s.settings.mode)); b.setAttribute('tabindex', b.dataset.mode === s.settings.mode ? '0' : '-1'); });
      root.querySelectorAll('[data-like], [data-dislike]').forEach(b => { b.disabled = s.pending.includes('reaction:' + (b.dataset.like || b.dataset.dislike)); });
      for (const container of [root, prefs, readerTags].filter(Boolean)) container.querySelectorAll('[data-interest]').forEach(b => { b.disabled = s.pending.includes('preferences'); });
      root.querySelectorAll('[data-layout]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.layout === s.settings.view)));
      $('#plaza-sort-label').hidden = s.settings.mode !== 'all'; $('#plaza-sort').value = s.settings.sort; $('#plaza-unread').checked = s.settings.unread;
      $('[data-shuffle]').hidden = s.settings.mode !== 'random';
      $('#plaza-total').textContent = s.order.length ? s.order.length + ' 篇' : '';
      $('#plaza-shown').textContent = s.loaded + ' / ' + s.order.length;
      $('#plaza-update').hidden = !s.newCount; $('#plaza-update').textContent = `有 ${s.newCount} 篇新文章 · 点击更新`;
      $('#plaza-helper').textContent = s.settings.mode === 'personal' ? '按你的阅读反馈与主动兴趣推荐；本次浏览顺序保持不变。' : s.settings.mode === 'random' ? '看看平时没留意的内容；想换个方向，可以换一批。' : '';
      $('#plaza-more').hidden = !s.error && s.loaded >= s.order.length; $('#plaza-more').disabled = s.loading;
      $('#plaza-more').textContent = s.error ? '重试加载' : '继续浏览';
      $('#plaza-load-status').textContent = s.loading ? '正在加载文章…' : s.error ? '操作失败：' + s.error : !s.order.length ? '暂时没有符合条件的文章，试试关闭「仅未读」或切换浏览方式。' : s.loaded >= s.order.length ? '本批文章已展示完' : '向下滚动继续浏览';
      if (s.error) { notice.hidden = false; notice.textContent = '操作失败：' + s.error; }
      prefs.querySelector('[role="alert"]').textContent = s.error;
      for (const container of [root, prefs, readerTags].filter(Boolean)) container.querySelectorAll('[data-interest]').forEach(b => b.setAttribute('aria-pressed', String(s.preferences.interests.some(t => t.name === b.dataset.interest && t.kind === b.dataset.kind))));
    }
    function renderPreferences() {
      const p = plaza.snapshot().preferences;
      prefs.querySelector('#plaza-interests').innerHTML = p.interests.map(t => tagButton(t, true)).join('') || '<p>尚未选择兴趣，可以直接添加。</p>';
      prefs.querySelector('#plaza-ignored-list').innerHTML = p.ignored.map(e => `<div class="plaza-ignored-row"><span>${esc(e.titleZh || e.title)}</span>${button('恢复', `data-restore="${esc(e.id)}"`)}</div>`).join('') || '<p>没有不感兴趣的文章。</p>';
    }
    function closeOverlays({ restoreFocus = true } = {}) {
      let closed = false;
      if (prefs.open) { prefs.close(); closed = true; }
      if (readerTags && !readerTags.hidden) { readerTags.hidden = true; closed = true; doc.querySelector('#plaza-reader-tags-toggle')?.setAttribute('aria-expanded', 'false'); }
      for (const card of cards.values()) { const pop = card.querySelector('.plaza-tag-pop'); if (!pop.hidden) closed = true; pop.hidden = true; card.classList.remove('plaza-tag-open'); }
      if (closed && restoreFocus) { suppressTagFocus = true; lastTagTrigger?.focus?.({ preventScroll: true }); suppressTagFocus = false; }
      return closed;
    }
    function showCardTags(card, trigger) {
      if (mobile() || !card) return;
      if (!card.querySelector('.plaza-tag-pop').hidden) return;
      closeOverlays({ restoreFocus: false }); lastTagTrigger = trigger;
      card.querySelector('.plaza-tag-pop').hidden = false; card.classList.add('plaza-tag-open');
    }
    function showReaderTags(id) {
      const item = plaza.readerEntry(id) || plaza.visibleEntries().find(e => e.id === id); if (!item || !readerTags) return;
      readerTagId = id; readerTags.innerHTML = picker(item); readerTags.hidden = false;
      doc.querySelector('#plaza-reader-tags-toggle')?.setAttribute('aria-expanded', 'true');
    }
    async function click(event) {
      const b = event.target.closest('button'); if (!b) return;
      if (b.dataset.open) { closeOverlays(); await plaza.open(b.dataset.open, b); }
      else if (b.dataset.like) await plaza.react(b.dataset.like, 'like');
      else if (b.dataset.dislike) await plaza.react(b.dataset.dislike, 'dislike');
      else if (b.dataset.mode) await plaza.change({ mode: b.dataset.mode });
      else if (b.dataset.layout) { closeOverlays(); await plaza.change({ view: b.dataset.layout }); }
      else if (b.getAttribute('data-shuffle') !== null && b.getAttribute('data-shuffle') !== undefined) await plaza.refresh({ shuffle: true });
      else if (b.dataset.interest) await plaza.setInterest({ name: b.dataset.interest, kind: b.dataset.kind }, b.getAttribute('aria-pressed') !== 'true');
      else if (b.matches('[data-ai-settings]')) adapter.openAiSettings?.();
      else if (b.dataset.generate) { b.disabled = true; await plaza.generateTags([b.dataset.generate], { retry: b.dataset.retry === 'true' }); b.disabled = false; }
      else if (b.dataset.restore) { await plaza.react(b.dataset.restore, '', { exact: true }); renderPreferences(); }
      else if (b.dataset.undo) await plaza.undoReaction(b.dataset.undo);
      else if (b.matches('[data-close-tags]')) closeOverlays();
      else if (b.matches('[data-preferences]')) { closeOverlays(); renderPreferences(); prefs.showModal(); await plaza.loadPreferences(); }
      else if (b.matches('[data-close-preferences]')) prefs.close();
      else if (b.matches('[data-sidebar]')) adapter.toggleSidebar?.();
      else if (b.matches('#plaza-update')) await plaza.refresh();
      else if (b.matches('#plaza-more')) await plaza.retryLoad();
      const panel = b.closest('.plaza-tag-pop') || b.closest('#plaza-reader-tags');
      if (panel) panel.querySelector('[role="alert"]').textContent = plaza.snapshot().error;
    }
    async function submit(event) {
      const form = event.target; if (!form.matches('[data-add-interest], [data-correct-tags]')) return;
      event.preventDefault(); const submitButton = form.querySelector('button[type="submit"]'); submitButton.disabled = true;
      let ok = false;
      if (form.matches('[data-add-interest]')) {
        const name = form.querySelector('[name="name"]').value.trim(), kind = form.querySelector('[name="kind"]').value;
        if (name) ok = await plaza.setInterest({ name, kind }, true);
        if (ok) form.querySelector('[name="name"]').value = '';
      } else {
        const tags = ['topic', 'format'].flatMap(kind => form.querySelector(`[name="${kind}"]`).value.split('\n').map(name => ({ name: name.trim(), kind })).filter(t => t.name));
        ok = await plaza.saveTags(form.dataset.correctTags, tags);
      }
      submitButton.disabled = false;
      const panel = form.closest('.plaza-tag-pop') || form.closest('#plaza-reader-tags') || prefs;
      if (ok && panel !== prefs) {
        const id = panel === readerTags ? readerTagId : panel.closest('.plaza-card')?.dataset.entryId;
        const item = plaza.visibleEntries().find(entry => entry.id === id);
        if (item) panel.innerHTML = picker(item);
      }
      panel.querySelector('[role="alert"]').textContent = ok ? '' : plaza.snapshot().error;
    }
    for (const container of [root, prefs, notice, readerTags].filter(Boolean)) { container.addEventListener('click', click); container.addEventListener('submit', submit); }
    root.addEventListener('keydown', async event => {
      const tab = event.target.closest('[data-mode]');
      if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const tabs = [...root.querySelectorAll('[data-mode]')], index = tabs.indexOf(tab);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].focus(); await plaza.change({ mode: tabs[next].dataset.mode });
    });
    root.addEventListener('change', event => {
      if (event.target.matches('#plaza-sort')) plaza.change({ sort: event.target.value });
      if (event.target.matches('#plaza-unread')) plaza.change({ unread: event.target.checked });
    });
    root.addEventListener('pointerover', event => { const b = event.target.closest('[data-like]'); if (b && event.pointerType !== 'touch') showCardTags(b.closest('.plaza-card'), b); });
    root.addEventListener('pointerout', event => { const card = event.target.closest('.plaza-card'); if (card && !card.contains(event.relatedTarget) && !card.contains(doc.activeElement)) { card.querySelector('.plaza-tag-pop').hidden = true; card.classList.remove('plaza-tag-open'); } });
    root.addEventListener('focusin', event => { const b = event.target.closest('[data-like]'); if (b && !suppressTagFocus) showCardTags(b.closest('.plaza-card'), b); });
    root.addEventListener('scroll', () => { const s = plaza.snapshot(); if (!s.readerId && !s.error && root.scrollHeight - root.scrollTop - root.clientHeight < 220) plaza.loadMore(); }, { passive: true });
    if (win.ResizeObserver) new win.ResizeObserver(() => layout()).observe($('#plaza-feed'));
    win.addEventListener('resize', () => layout());
    function update(type, data) {
      if (type === 'reset') { closeOverlays(); cards.clear(); $('#plaza-feed').innerHTML = ''; root.scrollTop = 0; data.forEach(makeCard); layout(); plaza.autoTagLoaded(); }
      if (type === 'append') { data.forEach(makeCard); layout(true); plaza.autoTagLoaded(); }
      if (type === 'update') updateCard(data);
      if (type === 'settings') layout();
      if (type === 'preferences') renderPreferences();
      if (type === 'reader') { closeOverlays(); readerTagId = ''; }
      if (type === 'active') { root.hidden = !data; if (!data) { closeOverlays(); notice.hidden = true; } else layout(); }
      if (type === 'tagging' && !data.length) {
        for (const item of plaza.visibleEntries()) { const pop = cards.get(item.id)?.querySelector('.plaza-tag-pop'); if (pop && !pop.querySelector('details[open]') && !pop.contains(doc.activeElement)) pop.innerHTML = picker(item); }
        if (readerTagId && readerTags && !readerTags.querySelector('details[open]')) showReaderTags(readerTagId);
      }
      if (type === 'feedback') { notice.hidden = false; notice.innerHTML = `<span>${data.reaction === 'dislike' ? '已记录，下次减少推荐' : data.reaction === 'like' ? '已点赞' : '已恢复推荐资格'}</span>${data.canUndo ? button('撤销', `data-undo="${esc(data.id)}"`) : ''}`; }
      updateControls();
    }
    return { update, showReaderTags, closeOverlays };
  }
  global.QMPlaza = { create };
})(window);
