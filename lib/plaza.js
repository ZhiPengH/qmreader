const crypto = require('crypto');

function shuffled(entries, seed) {
  const result = [...entries];
  let value = crypto.createHash('sha256').update(String(seed)).digest().readUInt32BE(0) || 1;
  for (let i = result.length - 1; i > 0; i -= 1) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    const j = Math.floor((value >>> 0) / 0x100000000 * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function entryTime(entry) {
  return Number(entry.publishedTs) || Number(entry.createdAt) || 0;
}

function topicKey(tag) {
  return `${tag.kind}:${tag.name.toLowerCase()}`;
}

function affinityScores(entries, interests) {
  const explicit = new Set(interests.map(topicKey));
  const likes = new Map();
  const dislikes = new Map();
  for (const entry of entries) {
    const counts = entry.reactionByMe === 'like' ? likes : entry.reactionByMe === 'dislike' ? dislikes : null;
    if (!counts) continue;
    for (const tag of entry.tags || []) {
      const key = topicKey(tag);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return new Map(entries.map(entry => [entry.id, (entry.tags || []).reduce((total, tag) => {
    const key = topicKey(tag);
    return total + (explicit.has(key) ? 4 : 0) + Math.min(2, (likes.get(key) || 0) * 0.5) - Math.min(1, (dislikes.get(key) || 0) * 0.25);
  }, 0)]));
}

function diversifySources(entries) {
  const groups = new Map();
  for (const entry of entries) {
    if (!groups.has(entry.sourceId)) groups.set(entry.sourceId, []);
    groups.get(entry.sourceId).push(entry);
  }
  const result = [];
  while (groups.size) {
    for (const [source, rows] of groups) {
      result.push(rows.shift());
      if (!rows.length) groups.delete(source);
    }
  }
  return result;
}

function mixExploration(rows, scores, seed) {
  const relevant = rows.filter(entry => scores.get(entry.id) > 0)
    .sort((a, b) => scores.get(b.id) - scores.get(a.id));
  if (!relevant.length) return diversifySources([...rows].sort((a, b) => scores.get(b.id) - scores.get(a.id)));
  const explore = diversifySources(shuffled(rows.filter(entry => scores.get(entry.id) <= 0), seed));
  const result = [];
  relevant.forEach((entry, index) => {
    result.push(entry);
    if ((index + 1) % 4 === 0 && explore.length) result.push(explore.shift());
  });
  return result.concat(explore);
}

function rankPlazaEntries(entries, { mode = 'all', unreadOnly = false, sort = 'latest', seed = '', interests = [] } = {}) {
  const rows = entries.filter(entry => (!unreadOnly || !entry.read) && (mode === 'all' || entry.reactionByMe !== 'dislike'));
  rows.sort((a, b) => (mode === 'all' && sort === 'oldest' ? 1 : -1) * (entryTime(a) - entryTime(b)) || a.id.localeCompare(b.id));
  if (mode === 'random') return shuffled(rows, seed).sort((a, b) => Number(a.read) - Number(b.read));
  if (mode === 'personal') {
    const scores = affinityScores(entries, interests);
    return [false, true].flatMap(read => mixExploration(rows.filter(entry => Boolean(entry.read) === read), scores, seed));
  }
  return rows;
}

module.exports = { rankPlazaEntries };
