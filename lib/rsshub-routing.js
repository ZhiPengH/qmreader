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

// Builds the constrained internal target for a twitter user feed, or null when
// the feed is not a twitter user route / the origin is not a bare http(s) origin.
function internalFeedUrl(feedValue, originValue) {
  const route = twitterRouteFromUrl(feedValue);
  if (!route) return null;
  const origin = parseInternalOrigin(originValue);
  if (!origin) return null;
  return `${origin.origin}/twitter/user/${route.username}${route.query ? '?' + route.query : ''}`;
}

// Candidate expansion shared by preview, validation, enrichment and refresh.
// Twitter user feeds go exclusively through the internal channel; everything
// else keeps the public multi-instance behaviour.
function expandFeedCandidates(feedValue, originValue) {
  const raw = String(feedValue || '');
  const origin = parseInternalOrigin(originValue);
  if (origin && isTwitterFeed(raw)) {
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
  internalFeedUrl,
  expandFeedCandidates,
  parseInternalOrigin,
  internalOrigin,
  isInternalRsshubTarget,
};
