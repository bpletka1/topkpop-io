/**
 * TopKpop.io — The Evaluation Room: checking a team's song link.
 *
 * A link earns the song points only if it is a real Suno song page that opens
 * for anyone, and the words on that page match the lyrics the team locked.
 * Only suno.com is ever contacted from here.
 */

const SUNO_HOSTS = new Set(['suno.com', 'www.suno.com', 'app.suno.ai']);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Is this shaped like a Suno song link? Returns the tidy form of it. */
function normalizeSongUrl(input) {
  // Phones often paste "Listen to ... on Suno: https://suno.com/s/..." or leave off the https://.
  const raw = String(input || '').trim().slice(0, 2000);
  const found = raw.match(/(?:^|[\s"'(<])((?:https?:\/\/)?(?:www\.)?(?:suno\.com|app\.suno\.ai)\/[^\s"'<>)]+)/i);
  let text = found ? found[1] : raw;
  if (!/^https?:\/\//i.test(text)) text = 'https://' + text;
  text = text.replace(/^http:\/\//i, 'https://').replace(/[.,;!]+$/, '');
  let u;
  try { u = new URL(text); } catch (_) { return { ok: false, reason: 'not-a-link' }; }
  if (u.username || u.password || (u.port && u.port !== '443')) return { ok: false, reason: 'not-suno' };
  if (u.protocol !== 'https:' || !SUNO_HOSTS.has(u.hostname.toLowerCase())) return { ok: false, reason: 'not-suno' };
  const path = u.pathname.replace(/\/+$/, '');
  let m = path.match(/^\/(?:song|embed)\/([0-9a-f-]{36})$/i);
  if (m && UUID.test(m[1])) return { ok: true, canonical: 'https://suno.com/song/' + m[1].toLowerCase(), songId: m[1].toLowerCase() };
  m = path.match(/^\/s\/([A-Za-z0-9]{6,40})$/);
  if (m) return { ok: true, canonical: 'https://suno.com/s/' + m[1], shortCode: m[1] };
  return { ok: false, reason: 'not-a-song-page' };
}

// Follow redirects by hand so the request can never leave suno.com.
async function fetchSuno(url, maxBytes = 2500000) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const host = new URL(current).hostname.toLowerCase();
    if (!SUNO_HOSTS.has(host)) return { status: 0, error: 'left-suno', finalUrl: current };
    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      continue;
    }
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    let html = '';
    if (reader) {
      const dec = new TextDecoder();
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        html += dec.decode(value, { stream: true });
        if (got > maxBytes) { try { await reader.cancel(); } catch (_) {} break; }
      }
    }
    return { status: res.status, finalUrl: current, type: res.headers.get('content-type') || '', html };
  }
  return { status: 0, error: 'too-many-redirects', finalUrl: current };
}

// Turn page source into plain comparable words (handles text tucked inside script data).
function comparable(s) {
  return String(s || '')
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\+(["'/])/g, '$1')
    .replace(/&(?:#39|#x27|apos|rsquo|lsquo);/g, "'").replace(/&(?:quot|ldquo|rdquo);/g, '"').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .normalize('NFKC').toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

const lyricLines = (t) => String(t || '').split('\n')
  .map((l) => l.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' '))
  .map(comparable).filter((l) => l.split(' ').length >= 3);

/**
 * How much of the locked lyrics appears on the page?
 * Two measures, so honest teams are not tripped by layout: whole lines, and
 * four-word runs (which still work when the lyrics were pasted as one paragraph).
 */
function lyricMatch(lockedLyrics, pageSource) {
  const page = ' ' + comparable(pageSource) + ' ';
  const lines = [...new Set(lyricLines(lockedLyrics))];
  const foundLines = lines.filter((l) => page.includes(' ' + l + ' ')).length;
  const words = comparable(String(lockedLyrics || '').replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ')).split(' ').filter(Boolean);
  const runs = new Set();
  for (let i = 0; i + 4 <= words.length; i++) runs.add(words.slice(i, i + 4).join(' '));
  const foundRuns = [...runs].filter((r) => page.includes(' ' + r + ' ')).length;
  const linePct = lines.length ? Math.round((100 * foundLines) / lines.length) : 0;
  const runPct = runs.size ? Math.round((100 * foundRuns) / runs.size) : 0;
  return { lines: lines.length, found: foundLines, linePct, runs: runs.size, foundRuns, runPct, pct: Math.max(linePct, runPct), enough: foundLines >= 3 || foundRuns >= 10 };
}

function pageFacts(html, finalUrl) {
  const pick = (re) => { const m = html.match(re); return m ? m[1] : null; };
  const title = pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,200})/i) || pick(/<title[^>]*>([^<]{1,200})/i);
  const audio = pick(/<meta[^>]+property=["']og:audio(?::url)?["'][^>]+content=["']([^"']+)/i) || pick(/(https:\/\/cdn\d*\.suno\.(?:ai|com)\/[0-9a-f-]{36}\.mp3)/i);
  const idFromUrl = (finalUrl.match(UUID) || [])[0];
  const idFromPage = pick(/\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) || (audio && (audio.match(UUID) || [])[0]);
  return { title: title ? title.replace(/\s*\|\s*Suno.*$/i, '').trim() : null, hasAudio: !!audio, songId: (idFromUrl || idFromPage || '').toLowerCase() || null };
}

const MATCH_PCT = Number(process.env.EVALROOM_SONG_MATCH_PCT || 50);

/**
 * Full check. verdict is one of:
 *   'verified'   real Suno song, words match the locked lyrics
 *   'mismatch'   real Suno song, but the words are not the locked lyrics
 *   'not-found'  the link does not open as a song for the public
 *   'unreadable' Suno could not be read right now (try again)
 *   'bad-link'   not a Suno song link
 */
async function checkSong(inputUrl, lockedLyrics) {
  const n = normalizeSongUrl(inputUrl);
  if (!n.ok) return { verdict: 'bad-link', reason: n.reason };
  let page;
  try { page = await fetchSuno(n.canonical); } catch (err) { return { verdict: 'unreadable', canonical: n.canonical, reason: String(err && err.name || 'fetch-failed') }; }
  if (page.status === 404 || page.status === 410) return { verdict: 'not-found', canonical: n.canonical, status: page.status };
  if (page.status !== 200 || !page.html) return { verdict: 'unreadable', canonical: n.canonical, status: page.status, reason: page.error };
  const facts = pageFacts(page.html, page.finalUrl);
  const songId = n.songId || facts.songId;
  if (!songId) return { verdict: 'not-found', canonical: n.canonical, status: 200, reason: 'no-song-on-page' };
  const match = lyricMatch(lockedLyrics, page.html);
  const out = {
    canonical: 'https://suno.com/song/' + songId, songId, title: facts.title, hasAudio: facts.hasAudio,
    embedUrl: 'https://suno.com/embed/' + songId, match, bytes: page.html.length,
  };
  // At least half of the locked words must be in the song, and enough of them that it cannot be chance.
  out.verdict = match.pct >= MATCH_PCT && match.enough ? 'verified' : 'mismatch';
  return out;
}

module.exports = { normalizeSongUrl, checkSong, lyricMatch, fetchSuno, pageFacts, comparable };
