const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmreader-rsshub-routes-'));
process.env.QMREADER_DATA_DIR = testDataDir;
delete process.env.QMREADER_DB_FILE;
process.env.RSSHUB_INTERNAL_ORIGIN = 'http://rsshub-x:1200';

const routing = require('../lib/rsshub-routing');

after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

test('36kr newsflashes route is recognized as an internal-channel feed', () => {
  // Logical placeholder form
  assert.ok(routing.isInternalRouteFeed('{rsshub}/36kr/newsflashes'), 'placeholder form');
  // Expanded public-instance form
  assert.ok(routing.isInternalRouteFeed('https://rsshub.app/36kr/newsflashes'), 'rsshub.app form');
  // Direct internal origin form
  assert.ok(routing.isInternalRouteFeed('http://rsshub-x:1200/36kr/newsflashes'), 'internal origin form');
});

test('36kr newsflashes expands exclusively through the internal channel', () => {
  const expanded = routing.expandFeedCandidates('{rsshub}/36kr/newsflashes', 'http://rsshub-x:1200');
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0], 'http://rsshub-x:1200/36kr/newsflashes');
  // Without an internal origin configured it stays on the public instances.
  const fallback = routing.expandFeedCandidates('{rsshub}/36kr/newsflashes', null);
  assert.ok(fallback.length > 1 && fallback.every(url => url.includes('rsshub')));
});

test('36kr hot-list is whitelisted alongside newsflashes', () => {
  assert.ok(routing.isInternalRouteFeed('{rsshub}/36kr/hot-list'));
  const expanded = routing.expandFeedCandidates('{rsshub}/36kr/hot-list', 'http://rsshub-x:1200');
  assert.deepEqual(expanded, ['http://rsshub-x:1200/36kr/hot-list']);
});

test('36kr article search routes accept safe keywords only', () => {
  assert.ok(routing.isInternalRouteFeed('{rsshub}/36kr/search/articles/AI'));
  assert.ok(routing.isInternalRouteFeed('{rsshub}/36kr/search/articles/大模型'));
  const expanded = routing.expandFeedCandidates('{rsshub}/36kr/search/articles/AI', 'http://rsshub-x:1200');
  assert.deepEqual(expanded, ['http://rsshub-x:1200/36kr/search/articles/AI']);
  assert.equal(routing.isInternalRouteFeed('{rsshub}/36kr/search/articles/a b'), false, 'spaces rejected');
  assert.equal(routing.isInternalRouteFeed('{rsshub}/36kr/search/articles/' + 'x'.repeat(33)), false, 'overlong keyword rejected');
  assert.equal(routing.isInternalRouteFeed('{rsshub}/36kr/search/newsflashes/AI'), false, 'wrong sub-route');
});

test('unknown 36kr sub-routes and foreign hosts are not internal-channel feeds', () => {
  assert.equal(routing.isInternalRouteFeed('{rsshub}/36kr/information/latest'), false, 'not whitelisted sub-route');
  assert.equal(routing.isInternalRouteFeed('{rsshub}/36kr/newsflashes/extra'), false, 'extra path segments');
  assert.equal(routing.isInternalRouteFeed('https://evil.example/36kr/newsflashes'), false, 'foreign host');
  assert.equal(routing.isInternalRouteFeed('{rsshub}/36kr/'), false, 'bare namespace');
  assert.equal(routing.isInternalRouteFeed('{rsshub}/user/someone'), false, 'other namespace');
});

test('twitter feeds remain internal-route feeds (superset check)', () => {
  assert.ok(routing.isInternalRouteFeed('{rsshub}/twitter/user/baoshu88'));
  const expanded = routing.expandFeedCandidates('https://rsshub.app/twitter/user/baoshu88', 'http://rsshub-x:1200');
  assert.equal(expanded.length, 1);
  assert.equal(expanded[0], 'http://rsshub-x:1200/twitter/user/baoshu88');
});

test('internalFeedUrl maps whitelisted non-twitter routes to the internal origin', () => {
  assert.equal(
    routing.internalFeedUrl('{rsshub}/36kr/newsflashes', 'http://rsshub-x:1200'),
    'http://rsshub-x:1200/36kr/newsflashes',
  );
  assert.equal(routing.internalFeedUrl('{rsshub}/36kr/newsflashes/extra', 'http://rsshub-x:1200'), null);
});
