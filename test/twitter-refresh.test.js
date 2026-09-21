const { test } = require('node:test');
const assert = require('node:assert/strict');
const twitterRefresh = require('../lib/twitter-refresh');

function source(id, overrides = {}) {
  return {
    id, twitter: true, enabled: true, deleted: false, manual: false,
    fetchedAt: 0, nextRetryAt: 0,
    ...overrides,
  };
}

test('due selection respects interval, retry backoff and eligibility', () => {
  const now = 10_000_000;
  const due = twitterRefresh.dueTwitterSources([
    source('fresh', { fetchedAt: now - 60 * 60 * 1000 + 1000 }),   // not yet due
    source('eligible', { fetchedAt: now - 61 * 60 * 1000 }),
    source('backoff', { fetchedAt: 0, nextRetryAt: now + 60_000 }),
    source('disabled', { fetchedAt: 0, enabled: false }),
    source('deleted', { fetchedAt: 0, deleted: true }),
    source('manual', { fetchedAt: 0, manual: true }),
    source('not-twitter', { fetchedAt: 0, twitter: false }),
    source('never-fetched', { fetchedAt: 0 }),
  ], { now, intervalMs: 60 * 60 * 1000 });
  assert.deepEqual(due.map(item => item.id), ['never-fetched', 'eligible']);
});

test('batch selection caps size and prefers the most overdue source', () => {
  const now = 100_000_000;
  const sources = [
    source('mild', { fetchedAt: now - 70 * 60 * 1000 }),
    source('ancient', { fetchedAt: now - 500 * 60 * 1000 }),
    source('middle', { fetchedAt: now - 200 * 60 * 1000 }),
    source('b', { fetchedAt: now - 90 * 60 * 1000 }),
    source('c', { fetchedAt: now - 80 * 60 * 1000 }),
  ];
  const batch = twitterRefresh.selectBatch(sources, { now, intervalMs: 60 * 60 * 1000, batchSize: 3 });
  assert.deepEqual(batch.map(item => item.id), ['ancient', 'middle', 'b']);
});

test('sweeper tick starts one job per round and retries after a busy worker', () => {
  const calls = [];
  let started = true;
  const sweeper = twitterRefresh.createTwitterSweeper({
    getSources: () => [source('a', { fetchedAt: 0 }), source('b', { fetchedAt: 0 })],
    canStart: () => started,
    startJob: ids => { calls.push(ids); return { started }; },
    now: () => 5_000_000,
    intervalMs: 60 * 60 * 1000,
    batchSize: 4,
  });
  started = false; // worker busy
  sweeper.tick();
  assert.deepEqual(calls, []);
  started = true;
  sweeper.tick();
  assert.deepEqual(calls, [[('a'), ('b')]]);
});

test('hundred sources drain within one interval at the default cadence', () => {
  const intervalMs = 60 * 60 * 1000;
  const sweepIntervalMs = 60 * 1000;
  const batchSize = 4;
  const sources = Array.from({ length: 100 }, (_, index) => source(`t${index}`, { fetchedAt: 0 }));
  const fetchedAt = new Map(sources.map(item => [item.id, 0]));
  const firstRefreshAt = new Map();
  let now = 0;
  let jobs = 0;
  const sweeper = twitterRefresh.createTwitterSweeper({
    getSources: () => sources.map(item => ({ ...item, fetchedAt: fetchedAt.get(item.id) })),
    startJob: ids => {
      jobs += 1;
      for (const id of ids) {
        if (!fetchedAt.get(id)) firstRefreshAt.set(id, now);
        fetchedAt.set(id, now);
      }
      return { started: true };
    },
    now: () => now,
    intervalMs, batchSize,
  });
  let ticks = 0;
  for (; now < 3 * intervalMs; now += sweepIntervalMs) {
    sweeper.tick();
    ticks += 1;
  }
  const neverRefreshed = [...fetchedAt.values()].filter(value => value === 0).length;
  assert.equal(neverRefreshed, 0);
  assert.ok(jobs <= ticks);
  // Every source must get its FIRST refresh well inside one interval.
  const lastFirstRefresh = Math.max(...firstRefreshAt.values());
  assert.ok(lastFirstRefresh < intervalMs, `last first refresh at ${lastFirstRefresh} exceeds interval ${intervalMs}`);
});

test('scheduling respects disabled flags and unrefs timers', () => {
  const handles = [];
  const sweeper = twitterRefresh.createTwitterSweeper({
    getSources: () => [],
    startJob: () => ({ started: true }),
    intervalMs: 60 * 60 * 1000,
    startupDelayMs: 1000,
    timers: {
      setTimeout: (fn, ms, ...rest) => { const t = { unref: () => t, __fn: fn, __ms: ms }; handles.push(t); return t; },
      setInterval: (fn, ms, ...rest) => { const t = { unref: () => t, __fn: fn, __ms: ms }; handles.push(t); return t; },
    },
  });
  sweeper.schedule();
  assert.ok(handles.length >= 1);
  assert.ok(handles.every(handle => typeof handle.unref === 'function'));
  assert.ok(handles.some(handle => handle.__ms === 1000));
  // A disabled sweep interval must not schedule anything.
  handles.length = 0;
  const disabled = twitterRefresh.createTwitterSweeper({
    getSources: () => [],
    startJob: () => ({ started: true }),
    sweepIntervalMs: -1,
    timers: {
      setTimeout: (fn, ms) => { handles.push({ unref: () => {}, __ms: ms }); return { unref: () => {} }; },
      setInterval: (fn, ms) => { handles.push({ unref: () => {}, __ms: ms }); return { unref: () => {} }; },
    },
  });
  disabled.schedule();
  assert.equal(handles.length, 0);
});
