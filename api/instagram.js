/**
 * Posting clues to the TopKpop Instagram account when a Trove opens.
 *
 * Asleep until these are set in Railway (live service only):
 *   INSTAGRAM_ACCOUNT_ID     the Instagram professional account's id
 *   INSTAGRAM_ACCESS_TOKEN   an access token allowed to publish for that account
 * Optional:
 *   INSTAGRAM_API_HOST       graph.instagram.com (default, Instagram Login) or graph.facebook.com (Facebook Login)
 *   INSTAGRAM_API_VERSION    e.g. v23.0; left out of the address when not set
 *   INSTAGRAM_TROVE1_MEDIA, INSTAGRAM_TROVE2_MEDIA, INSTAGRAM_TROVE3_MEDIA
 *                            a public https link to a .jpg or .mp4 to post in place of the clue card
 *
 * Each Trove posts its cipher card and then its clue videos. The videos live on Vimeo; at post time the site asks
 * Vimeo for each one's direct file link (VIMEO_ACCESS_TOKEN, which needs the video_files scope and a Vimeo plan
 * that gives file links). A video whose file link cannot be had is sent to the organizer to post by hand.
 *
 * With nothing set, or if a post fails, the organizer is emailed the picture and caption to post by hand.
 * The preview copy never posts.
 */
const SITE = 'https://www.topkpop.io';
const PREVIEW_MODE = process.env.PREVIEW_MODE === '1';

// videos: the Vimeo ids of the K-Clue videos on that Trove's page, in page order.
const CLUES = {
  1: { title: 'The Encore Ghost', line: 'A vanished idol. A secret challenge. The first cipher is out.', videos: ['1139810578', '1193250273', '1193252635'] },
  2: { title: 'The Blade of Bitterness', line: 'Ambition cuts deeper than any blade. The second cipher is out.', videos: ['1144892790', '1144488168', '1193255434'] },
  3: { title: 'Where Secret Scorn Smolders', line: 'Someone long dismissed left only a shadow. The final cipher is out.', videos: ['1193253275', '1193253274', '1193253273', '1193253276'] },
};

const env = (k) => String(process.env[k] || '').trim();
function configured() {
  return !PREVIEW_MODE && !!(env('INSTAGRAM_ACCOUNT_ID') && env('INSTAGRAM_ACCESS_TOKEN'));
}
/** Take the token out of anything that might be logged, emailed or returned. */
function scrub(text) {
  const tok = env('INSTAGRAM_ACCESS_TOKEN');
  let out = String(text == null ? '' : text).replace(/access_token=[^&\s]+/g, 'access_token=…');
  if (tok) out = out.split(tok).join('…');
  return out;
}

const TAGS = '#TopKpopSleuth';
const WHERE = 'Every clue is also on the website. Sign in at topkpop.io to investigate.';

/**
 * Everything that would be posted for a Trove, in order: the cipher card, then each clue video.
 * Each item: { trove, key, first, caption, video, media (card) or vimeo (video id), page (where to see it) }.
 * `first` is the caption's first line; it is unique per item and is how a repeat is recognised.
 */
function cluesFor(trove) {
  const n = Number(trove); const c = CLUES[n]; if (!c) return null;
  // A card override must be a public https link to a .jpg or an .mp4/.mov; anything else is ignored.
  const override = env(`INSTAGRAM_TROVE${n}_MEDIA`);
  const usable = /^https:\/\/[^\s#]+\.(jpe?g|mp4|mov)(\?[^\s#]*)?$/i.test(override);
  if (override && !usable) console.warn(`instagram: INSTAGRAM_TROVE${n}_MEDIA is not an https link to a .jpg, .mp4 or .mov, so the clue card is used.`);
  const media = usable ? override : `${SITE}/assets/instagram/trove-0${n}.jpg`;
  const items = [{
    trove: n, key: 'card', first: firstLine(n), media, video: /\.(mp4|mov)(\?|$)/i.test(media), page: media,
    caption: [firstLine(n), `"${c.title}" — ${c.line}`, WHERE, TAGS].join('\n\n'),
  }];
  c.videos.forEach((id, i) => {
    const first = `K-CLUE · Treasure Trove 0${n} · Clue video ${i + 1}.`;
    items.push({ trove: n, key: 'video' + (i + 1), first, vimeo: id, video: true, page: `https://vimeo.com/${id}`,
      caption: [first, 'Watch closely. Someone in this story is not who they seem.', WHERE, TAGS].join('\n\n') });
  });
  return items;
}

/** Ask Vimeo for a direct .mp4 link to one of the account's videos. Throws with a plain reason if it cannot. */
async function vimeoFile(id) {
  const tok = env('VIMEO_ACCESS_TOKEN');
  if (!tok) throw new Error('the site has no Vimeo token');
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30000);
  let res, data;
  try {
    res = await fetch(`https://api.vimeo.com/videos/${id}?fields=files,download`, { headers: { Authorization: 'bearer ' + tok, Accept: 'application/vnd.vimeo.*+json;version=3.4' }, signal: ctl.signal });
    data = await res.json().catch(() => ({}));
  } catch (e) { throw new Error('Vimeo could not be reached'); } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error(`Vimeo answered ${res.status} for this video`);
  // Instagram wants a plain .mp4 no taller or wider than 1920; take the largest that fits.
  // Vimeo's own conversions only (never the original upload, which can be huge or in a format Instagram refuses).
  const files = [].concat(data.files || [], data.download || [])
    .filter((f) => f && f.link && /^https:\/\//i.test(f.link) && (f.type === 'video/mp4' || /\.mp4(\?|$)/i.test(f.link)) && !['hls', 'dash', 'source'].includes(f.quality))
    .filter((f) => Math.max(f.width || 0, f.height || 0) <= 1920)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  if (!files.length) throw new Error('Vimeo gave no file link for this video (the token needs the video_files scope, and the Vimeo plan must include file links)');
  return files[0].link;
}

const firstLine = (n) => `K-CLUE · Treasure Trove 0${n} is open.`;

function address(path) {
  const host = (env('INSTAGRAM_API_HOST') || 'graph.instagram.com').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const v = env('INSTAGRAM_API_VERSION').replace(/^\/+|\/+$/g, '');
  return `https://${host}/${v ? v + '/' : ''}${path}`;
}

async function call(method, path, params) {
  const body = new URLSearchParams({ ...params, access_token: env('INSTAGRAM_ACCESS_TOKEN') });
  const url = address(path);
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = method === 'GET'
      ? await fetch(`${url}?${body}`, { signal: ctl.signal })
      : await fetch(url, { method: 'POST', body, signal: ctl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(scrub((data.error && data.error.message) || `Instagram answered ${res.status}`));
    }
    return data;
  } catch (e) {
    // Never let the token reach a log, an email or a reply, whatever the error was.
    throw new Error(scrub(e && e.name === 'AbortError' ? 'Instagram did not answer in time' : (e && e.message) || 'Instagram could not be reached'));
  } finally { clearTimeout(timer); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The first lines of the newest posts on the account, used to recognise a clue that is already up. */
async function recentCaptions() {
  const got = await call('GET', `${env('INSTAGRAM_ACCOUNT_ID')}/media`, { fields: 'caption', limit: '50' });
  return (got.data || []).map((m) => String(m.caption || ''));
}
async function alreadyPosted(item) {
  return (await recentCaptions()).some((c) => c.startsWith(item.first));
}

/** Create the post, wait until Instagram has finished reading the media, then publish. Returns the media id. */
async function publish({ media, video, caption }, { pollMs = 15000, maxPolls = 20 } = {}) {
  const id = env('INSTAGRAM_ACCOUNT_ID');
  const made = await call('POST', `${id}/media`, video ? { media_type: 'REELS', video_url: media, caption } : { image_url: media, caption });
  if (!made.id) throw new Error('Instagram did not return a post to publish');
  for (let i = 0; i < maxPolls; i++) {
    const st = await call('GET', `${made.id}`, { fields: 'status_code' });
    if (st.status_code === 'FINISHED' || st.status_code === 'PUBLISHED') break;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error(`Instagram could not read the ${video ? 'video' : 'picture'} (${st.status_code})`);
    if (i === maxPolls - 1) throw new Error('Instagram was still preparing the post after 5 minutes');
    await wait(pollMs);
  }
  const out = await call('POST', `${id}/media_publish`, { creation_id: made.id });
  if (!out.id) throw new Error('Instagram did not confirm the post');
  return out.id;
}

// One post per Trove at a time in this process, so two clicks or a click during the job cannot both publish.
const busy = new Set();

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const label = (it) => it.key === 'card' ? 'cipher card' : 'clue video ' + it.key.slice(5);

/**
 * Post a Trove's clues: the cipher card, then each clue video. Never throws: the caller is the unlock job, and a
 * failed post must not stop anything else. notify({ subject, html }) emails the organizer and returns true only
 * if the email was really sent. One email lists everything left to post by hand.
 * Returns { posted, already, by_hand, reason, items: [{ key, posted, already, reason, id }] }.
 */
async function postClue(trove, { notify, opts } = {}) {
  const items = cluesFor(trove);
  if (!items) return { posted: false, reason: 'no clue for that Trove' };
  if (PREVIEW_MODE) return { posted: false, reason: 'the preview copy never posts' };
  const n = items[0].trove;
  const tell = async (lead, left) => {
    if (!notify) return false;
    // Give the organizer a file to download for each video, where Vimeo will hand one over.
    for (const x of left) { if (x.item.vimeo) { try { x.file = await vimeoFile(x.item.vimeo); } catch (_) { /* the Vimeo page link is still there */ } } }
    try {
      return (await notify({
        subject: `Post by hand: Trove 0${n} clue${left.length === 1 ? '' : 's'} for Instagram`,
        html: `<p>Trove 0${n} is open. ${esc(lead)}</p>` + left.map((x) => `<hr>
<p><strong>${esc(label(x.item))}</strong>${x.reason ? ' — ' + esc(x.reason) : ''}<br>
${x.item.video ? 'Video' : 'Picture'}: <a href="${esc(x.item.page)}">${esc(x.item.page)}</a><br>
${x.file ? `Download the file: <a href="${esc(x.file)}">video file</a> (this link works for about a day)<br>` : ''}</p>
<pre style="white-space:pre-wrap;font-family:inherit">${esc(x.item.caption)}</pre>`).join('') +
          `<hr><p>If any of these are already on @topkpopio, there is nothing to do for that one. When you post one by hand, keep the first line of its caption exactly as written above: that line is how the site knows it is already up.</p>`,
      })) === true;
    } catch (e) { console.error('instagram notify error:', scrub(e.message)); return false; }
  };
  if (!configured()) {
    const by_hand = await tell('Instagram is not connected to the site yet, so these are yours to post.', items.map((item) => ({ item })));
    return { posted: false, by_hand, reason: 'Instagram is not connected yet', items: [] };
  }
  if (busy.has(n)) return { posted: false, reason: 'these clues are being posted right now', items: [] };
  busy.add(n);
  const results = []; const left = [];
  try {
    for (const item of items) {
      try {
        if (await alreadyPosted(item)) { results.push({ key: item.key, posted: true, already: true }); continue; }
        const media = item.vimeo ? await vimeoFile(item.vimeo) : item.media;
        const id = await publish({ media, video: item.video, caption: item.caption }, opts);
        console.log(`Instagram: Trove ${n} ${label(item)} posted (${id}).`);
        results.push({ key: item.key, posted: true, id });
      } catch (e) {
        const why = scrub(e.message);
        // A lost reply does not mean a lost post: look once more before asking anyone to post by hand.
        let there = false; try { there = await alreadyPosted(item); } catch (_) { /* treat as not there */ }
        if (there) { results.push({ key: item.key, posted: true, already: true }); continue; }
        console.error(`Instagram: Trove ${n} ${label(item)} failed:`, why);
        results.push({ key: item.key, posted: false, reason: why }); left.push({ item, reason: why });
      }
    }
  } finally { busy.delete(n); }
  const by_hand = left.length ? await tell('The site tried to post these to Instagram and they did not go through. Please check @topkpopio first in case they did arrive.', left) : false;
  return {
    posted: left.length === 0, already: results.every((r) => r.already), by_hand,
    reason: left.length ? left.map((x) => `${label(x.item)}: ${x.reason}`).join('; ') : undefined, items: results,
  };
}

const isBusy = (trove) => busy.has(Number(trove));

module.exports = { configured, cluesFor, postClue, isBusy, _internal: { publish, address, alreadyPosted, scrub, vimeoFile } };
