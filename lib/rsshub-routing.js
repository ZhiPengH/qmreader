// Shared RSSHub routing rules for user subscriptions.
// Twitter user feeds are served through a trusted internal RSSHub instance when
// one is configured; every other feed keeps the historical public behaviour.
const { RSSHUB_INSTANCES } = require('./sources');

const RSSHUB_HOSTS = new Set(RSSHUB_INSTANCES.map(base => {
  try { return new URL(base).host; } catch { return ''; }
}).filter(Boolean));

// Strict /twitter/user/:username route; route params are whitelisted below.
const TWITTER_USER_PATH = /^\/twitter\/user\/([A-Za-z0-9_]{1,15})$/;
const TWITTER_USER_PARAMS = new Set([
  'readable', 'authorNameBold', 'showAuthorInTitle', 'showAuthorAsTitleOnly', 'showAuthorInDesc',
  'showQuotedAuthorAvatarInDesc', 'showAuthorAvatarInDesc', 'showEmojiForRetweetAndReply',
  'showSymbolForRetweetAndReply', 'showRetweetTextInTitle', 'addLinkForPics',
  'showTimestampInDescription', 'showQuotedInTitle', 'widthOfPics', 'heightOfPics',
  'sizeOfAuthorAvatar', 'sizeOfQuotedAuthorAvatar', 'includeReplies', 'includeRts',
  'forceWebApi', 'count', 'onlyMedia', 'mediaNumber', 'showEmojiForSubscriberOnly',
  'showSymbolForSubscriberOnly', 'showFullPrefixForSubscriberOnly',
]);

// Exact-path routes (no params) served through the internal channel when one is
// configured. Each entry is verified against the private RSSHub before landing.
const INTERNAL_EXACT_ROUTES = new Set([
  '/36kr/newsflashes',
  '/36kr/hot-list',
]);

// Parameterized routes served through the internal channel. The keyword is
// constrained to a safe charset and bounded length.
const INTERNAL_KEYWORD_ROUTES = /^\/36kr\/search\/articles\/([A-Za-z0-9\u4e00-\u9fa5]{1,32})$/;

function parseInternalOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || !host || url.username || url.password
    || (url.pathname && url.pathname !== '/') || url.search || url.hash) return null;
  return { origin: url.origin, host: host + (url.port ? ':' + url.port : '') };
}

function internalOrigin() {
  return parseInternalOrigin(process.env.RSSHUB_INTERNAL_ORIGIN);
}

function isInternalRsshubTarget(value) {
  const configured = internalOrigin();
  if (!configured) return false;
  try { return new URL(String(value)).origin === configured.origin; } catch { return false; }
}

function twitterRouteFromUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || /\s/.test(raw) || raw.length > 4096) return null;
  let url = null;
  if (raw.startsWith('{rsshub}')) {
    try { url = new URL('https://rsshub.internal.test' + raw.slice('{rsshub}'.length)); } catch { return null; }
  } else {
    try { url = new URL(raw); } catch { return null; }
    if (!RSSHUB_HOSTS.has(url.host)) return null;
  }
  const pathname = (() => {
    try { return decodeURIComponent(url.pathname); } catch { return url.pathname; }
  })();
  const match = pathname.match(TWITTER_USER_PATH);
  if (!match) return null;
  if (url.username || url.password || url.hash) return null;
  const query = url.search ? url.search.slice(1) : '';
  if (query) {
    for (const pair of query.split('&')) {
      if (!pair) return null;
      const key = decodeURIComponent(pair.split('=')[0]);
      if (!TWITTER_USER_PARAMS.has(key)) return null;
    }
  }
  return { username: match[1], query };
}

function isTwitterFeed(value) {
  return Boolean(twitterRouteFromUrl(value));
}

// A feed whose route is whitelisted for the internal channel (twitter user
// feeds plus the exact-path routes above), in any of its three forms:
// {rsshub} placeholder, public RSSHub instance, or internal origin.
function internalRouteFromUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || /\s/.test(raw) || raw.length > 4096) return null;
  let url = null;
  if (raw.startsWith('{rsshub}')) {
    try { url = new URL('https://rsshub.internal.test' + raw.slice('{rsshub}'.length)); } catch { return null; }
  } else {
    try { url = new URL(raw); } catch { return null; }
    if (!RSSHUB_HOSTS.has(url.host) && !isInternalRsshubTarget(raw)) return null;
  }
  if (url.username || url.password || url.hash || url.search) return null;
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { pathname = url.pathname; }
  if (INTERNAL_EXACT_ROUTES.has(pathname)) return { path: pathname };
  const keyword = pathname.match(INTERNAL_KEYWORD_ROUTES);
  if (keyword) return { path: pathname };
  return null;
}

function isInternalRouteFeed(value) {
  return Boolean(internalRouteFromUrl(value) || twitterRouteFromUrl(value));
}

// Builds the constrained internal target for a whitelisted internal-channel
// feed (twitter user route or exact-path route), or null when the feed is not
// whitelisted / the origin is not a bare http(s) origin.
function internalFeedUrl(feedValue, originValue) {
  const origin = parseInternalOrigin(originValue);
  if (!origin) return null;
  const twitter = twitterRouteFromUrl(feedValue);
  if (twitter) return `${origin.origin}/twitter/user/${twitter.username}${twitter.query ? '?' + twitter.query : ''}`;
  const route = internalRouteFromUrl(feedValue);
  if (route) return `${origin.origin}${route.path}`;
  return null;
}

// Candidate expansion shared by preview, validation, enrichment and refresh.
// Whitelisted internal-channel feeds go exclusively through the internal
// channel; everything else keeps the public multi-instance behaviour.
function expandFeedCandidates(feedValue, originValue) {
  const raw = String(feedValue || '');
  const origin = parseInternalOrigin(originValue);
  if (origin && isInternalRouteFeed(raw)) {
    const internal = internalFeedUrl(raw, origin.origin);
    return internal ? [internal] : [];
  }
  if (raw.startsWith('{rsshub}')) {
    const suffix = raw.slice('{rsshub}'.length) || '/';
    return RSSHUB_INSTANCES.map(base => `${base}${suffix}`);
  }
  return [raw];
}

module.exports = {
  RSSHUB_HOSTS,
  twitterRouteFromUrl,
  isTwitterFeed,
  internalRouteFromUrl,
  isInternalRouteFeed,
  internalFeedUrl,
  expandFeedCandidates,
  parseInternalOrigin,
  internalOrigin,
  isInternalRsshubTarget,
};
