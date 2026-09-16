const fetcher = require('./fetcher');
const store = require('./store');
const { shouldAutoFetchOriginal } = require('./background-jobs');

const OFFLINE_PREFETCH_HOUR = Number.parseInt(process.env.OFFLINE_PREFETCH_HOUR ?? '6', 10);
const OFFLINE_PREFETCH_LIMIT = Math.max(1, Number.parseInt(process.env.OFFLINE_PREFETCH_LIMIT || '500', 10) || 500);
const OFFLINE_PREFETCH_CONCURRENCY = Math.max(1, Math.min(8, Number.parseInt(process.env.OFFLINE_PREFETCH_CONCURRENCY || '4', 10) || 4));
const OFFLINE_CACHE_MAX_BYTES = Math.max(0, Number.parseInt(process.env.OFFLINE_CACHE_MAX_BYTES || String(512 * 1024 * 1024), 10));
const OFFLINE_PREFETCH_POOL = 2000;
const RECENT_FAILURE_SKIP_MS = 48 * 60 * 60 * 1000;

const status = { running: false, lastRun: null };

function nextOfflinePrefetchDelay(now = new Date(), hourShanghai = OFFLINE_PREFETCH_HOUR) {
  const target = Number(hourShanghai);
  if (!Number.isFinite(target) || target < 0 || target > 23) return -1;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now).map(part => [part.type, part.value]));
  const addDay = Number(parts.hour) >= target ? 1 : 0;
  const targetUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + addDay, target - 8, 0, 0);
  return Math.max(targetUtc - now.getTime(), 60 * 1000);
}

function entryRecentlyFailed(entry, nowMs = Date.now()) {
  return Boolean(entry && entry.originalFetchError && entry.originalFetchAttemptedAt
    && nowMs - Number(entry.originalFetchAttemptedAt) < RECENT_FAILURE_SKIP_MS);
}

function selectOfflinePrefetchEntries(entries, { limit = OFFLINE_PREFETCH_LIMIT, nowMs = Date.now() } = {}) {
  const seen = new Set();
  return (Array.isArray(entries) ? entries : [])
    .filter(entry => entry && entry.id && !seen.has(entry.id) && seen.add(entry.id))
    .filter(entry => !entryRecentlyFailed(entry, nowMs))
    .filter(shouldAutoFetchOriginal)
    .sort((a, b) => (Number(b.publishedTs) || 0) - (Number(a.publishedTs) || 0))
    .slice(0, Math.max(1, limit));
}

async function runOfflinePrefetch({ trigger = 'scheduled', fetchOne = entry => fetcher.fetchEntryOriginal(entry) } = {}) {
  if (status.running) return { started: false, running: true };
  status.running = true;
  const startedAt = Date.now();
  let ok = 0;
  let failed = 0;
  let bytesAdded = 0;
  try {
    const pool = store.getRecentEntriesForPrefetch(OFFLINE_PREFETCH_POOL);
    const candidates = selectOfflinePrefetchEntries(pool);
    console.log(`[offline-prefetch] start trigger=${trigger} candidates=${candidates.length} concurrency=${OFFLINE_PREFETCH_CONCURRENCY}`);
    let cursor = 0;
    const worker = async () => {
      while (cursor < candidates.length) {
        const entry = candidates[cursor];
        cursor += 1;
        try {
          const updated = await fetchOne(entry);
          if (updated && updated.content) {
            ok += 1;
            bytesAdded += Buffer.byteLength(String(updated.content), 'utf8');
          } else {
            failed += 1;
          }
        } catch (error) {
          failed += 1;
          console.warn(`[offline-prefetch] skip ${entry.id} (${entry.link}): ${error.message || error}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(OFFLINE_PREFETCH_CONCURRENCY, candidates.length)) }, worker));
    const budget = store.enforceOfflineCacheBudget(OFFLINE_CACHE_MAX_BYTES);
    const durationMs = Date.now() - startedAt;
    status.lastRun = {
      at: startedAt,
      trigger,
      selected: candidates.length,
      ok,
      failed,
      bytesAdded,
      evicted: budget.evicted,
      totalBytes: budget.bytes,
      durationMs,
    };
    console.log(`[offline-prefetch] done trigger=${trigger} selected=${candidates.length} ok=${ok} failed=${failed} bytesAdded=${bytesAdded} evicted=${budget.evicted} totalBytes=${budget.bytes} durationMs=${durationMs}`);
    return { started: true, ...status.lastRun };
  } catch (error) {
    status.lastRun = { at: startedAt, trigger, error: error.message || String(error), durationMs: Date.now() - startedAt };
    console.warn('[offline-prefetch] run failed:', error.message || error);
    return { started: true, error: status.lastRun.error };
  } finally {
    status.running = false;
  }
}

function getOfflinePrefetchStatus() {
  return {
    running: status.running,
    config: {
      hourShanghai: OFFLINE_PREFETCH_HOUR,
      limit: OFFLINE_PREFETCH_LIMIT,
      concurrency: OFFLINE_PREFETCH_CONCURRENCY,
      maxCacheBytes: OFFLINE_CACHE_MAX_BYTES,
    },
    lastRun: status.lastRun,
  };
}

function scheduleOfflinePrefetch() {
  if (!Number.isFinite(OFFLINE_PREFETCH_HOUR) || OFFLINE_PREFETCH_HOUR < 0) {
    console.log('Offline prefetch disabled');
    return;
  }
  const arm = () => {
    const delay = nextOfflinePrefetchDelay(new Date(), OFFLINE_PREFETCH_HOUR);
    const timer = setTimeout(async () => {
      try {
        await runOfflinePrefetch({ trigger: 'scheduled' });
      } catch (error) {
        console.warn('[offline-prefetch] timer error:', error.message || error);
      }
      arm();
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  };
  arm();
  console.log(`Offline prefetch scheduled at ${OFFLINE_PREFETCH_HOUR}:00 Beijing time`);
}

module.exports = {
  nextOfflinePrefetchDelay,
  selectOfflinePrefetchEntries,
  entryRecentlyFailed,
  runOfflinePrefetch,
  getOfflinePrefetchStatus,
  scheduleOfflinePrefetch,
};
