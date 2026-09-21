// Refresh scheduling for twitter sources served through the private RSSHub.
// Goal: ~one refresh per source per interval, spread evenly, without starving
// the existing freshness sweep and without hammering X when credentials fail
// (failure backoff is handled by the shared fetcher cache via nextRetryAt).
'use strict';

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_SWEEP_BATCH_SIZE = 4;
const DEFAULT_STARTUP_DELAY_MS = 2 * 60 * 1000;
const MIN_SWEEP_INTERVAL_MS = 60 * 1000;

function dueTwitterSources(sources, { now = Date.now, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  const nowValue = typeof now === 'function' ? now() : Number(now) || 0;
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
  return (Array.isArray(sources) ? sources : [])
    .filter(item => item && item.twitter && item.enabled && !item.deleted && !item.manual)
    .filter(item => !(Number(item.nextRetryAt) > nowValue))
    .map(item => {
      const fetchedAt = Number(item.fetchedAt) || 0;
      const age = fetchedAt ? nowValue - fetchedAt : Infinity;
      return { item, age, overdueRatio: age === Infinity ? Infinity : age / interval };
    })
    .filter(entry => entry.age >= interval)
    .sort((a, b) => (b.overdueRatio - a.overdueRatio) || (a.item.fetchedAt || 0) - (b.item.fetchedAt || 0))
    .map(entry => entry.item);
}

function selectBatch(sources, options = {}) {
  const batchSize = Number.isFinite(options.batchSize) && options.batchSize > 0
    ? Math.floor(options.batchSize) : DEFAULT_SWEEP_BATCH_SIZE;
  return dueTwitterSources(sources, options).slice(0, batchSize);
}

function createTwitterSweeper({
  getSources,
  canStart = () => true,
  startJob,
  now = Date.now,
  intervalMs = DEFAULT_INTERVAL_MS,
  sweepIntervalMs = DEFAULT_SWEEP_INTERVAL_MS,
  batchSize = DEFAULT_SWEEP_BATCH_SIZE,
  startupDelayMs = DEFAULT_STARTUP_DELAY_MS,
  timers = { setTimeout, setInterval },
} = {}) {
  function tick() {
    if (typeof canStart === 'function' && !canStart()) {
      return { started: false, skipped: 'refresh already running' };
    }
    const batch = selectBatch(getSources(), { now, intervalMs, batchSize });
    if (!batch.length) return { started: false, skipped: 'no due twitter sources' };
    return startJob(batch.map(item => item.id));
  }

  function schedule() {
    if (!Number.isFinite(sweepIntervalMs) || sweepIntervalMs < 0) return { enabled: false };
    const interval = Math.max(MIN_SWEEP_INTERVAL_MS, sweepIntervalMs);
    const delay = Number.isFinite(startupDelayMs) ? Math.max(0, startupDelayMs) : DEFAULT_STARTUP_DELAY_MS;
    const handle = timers.setTimeout(() => {
      tick();
      const loop = timers.setInterval(tick, interval);
      if (loop && typeof loop.unref === 'function') loop.unref();
    }, delay);
    if (handle && typeof handle.unref === 'function') handle.unref();
    return { enabled: true };
  }

  return { tick, schedule };
}

module.exports = {
  dueTwitterSources,
  selectBatch,
  createTwitterSweeper,
  DEFAULT_INTERVAL_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  DEFAULT_SWEEP_BATCH_SIZE,
};
