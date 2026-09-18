function createPlazaTagger({ store, classify, inputParts, dailyLimit = 100, autoEnabled = false }) {
  function state(userId) {
    return { autoEnabled, dailyLimit, usage: store.getPlazaTagUsage(userId, dailyLimit) };
  }

  async function perform(userId, entries, { aiConfig = {}, automatic = false, retry = false } = {}) {
    if (automatic && !autoEnabled) return { entries: store.getPlazaEntries({ userId, ids: entries.map(entry => entry.id) }), usage: state(userId).usage, skipped: 'disabled' };
    entries = entries.map(entry => store.getEntry(entry.id)).filter(Boolean);
    let skipped;
    const pending = entries.filter(entry => {
      const cached = store.getEntryTopics(entry.id);
      if (cached?.origin === 'manual') return false;
      const unchanged = cached?.inputHash === inputParts(entry).inputHash;
      return !(unchanged && (cached.status === 'ready' || (cached.status === 'failed' && !retry)));
    });
    if (pending.length) {
      const allowance = store.claimPlazaTagAllowance(userId, pending.length, dailyLimit);
      const batch = pending.slice(0, allowance.granted);
      if (batch.length < pending.length) skipped = 'quota';
      if (batch.length) {
        const hashes = new Map(batch.map(entry => [entry.id, inputParts(entry).inputHash]));
        function saveCurrent(id, data) {
          const current = store.getEntry(id);
          if (!current || inputParts(current).inputHash !== hashes.get(id)) return;
          if (store.getEntryTopics(id)?.origin === 'manual') return;
          store.saveEntryTopics(id, { ...data, origin: 'ai', inputHash: hashes.get(id), provider: aiConfig.provider || '', model: aiConfig.model || '' });
        }
        let result;
        try {
          result = await classify(batch, aiConfig);
        } catch {
          for (const entry of batch) {
            saveCurrent(entry.id, { tags: [], status: 'failed', error: '标签分析失败，请检查 AI 配置后重试' });
          }
          return { entries: store.getPlazaEntries({ userId, ids: entries.map(entry => entry.id) }), usage: state(userId).usage, skipped: 'failed' };
        }
        for (const item of result) {
          saveCurrent(item.entryId, { tags: item.tags, status: 'ready', error: '' });
        }
      }
    }
    return { entries: store.getPlazaEntries({ userId, ids: entries.map(entry => entry.id) }), usage: state(userId).usage, ...(skipped ? { skipped } : {}) };
  }

  let queue = Promise.resolve();
  function analyze(userId, entries, options) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 8 || entries.some(entry => !entry || typeof entry.id !== 'string' || !entry.id)) {
      return Promise.reject(Object.assign(new Error('一次只能分析 1–8 篇有效文章'), { statusCode: 400 }));
    }
    entries = [...new Map(entries.map(entry => [entry.id, entry])).values()];
    const task = queue.then(() => perform(userId, entries, options));
    queue = task.catch(() => {});
    return task;
  }

  return { state, analyze };
}

module.exports = { createPlazaTagger };
