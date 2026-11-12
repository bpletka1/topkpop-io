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
 * With nothing set, or if a post fails, the organizer is emailed the picture and caption to post by hand.
 * The preview copy never posts.
 */
const SITE = 'https://www.topkpop.io';
const PREVIEW_MODE = process.env.PREVIEW_MODE === '1';

const CLUES = {
  1: { title: 'The Encore Ghost', line: 'A vanished idol. A secret challenge. The first cipher is out.' },
  2: { title: 'The Blade of Bitterness', line: 'Ambition cuts deeper than any blade. The second cipher is out.' },
  3: { title: 'Where Secret Scorn Smolders', line: 'Someone long dismissed left only a shadow. The final cipher is out.' },
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

/** What would be posted for a Trove: the media link, whether it is a video, and the caption. */
function clueFor(trove) {
  const n = Number(trove); const c = CLUES[n]; if (!c) return null;
  // An override must be a public https link to a .jpg or an .mp4/.mov; anything else is ignored and the card is used.
  const override = env(`INSTAGRAM_TROVE${n}_MEDIA`);
  const usable = /^https:\/\/[^\s#]+\.(jpe?g|mp4|mov)(\?[^\s#]*)?$/i.test(override);
  if (override && !usable) console.warn(`instagram: INSTAGRAM_TROVE${n}_MEDIA is not an https link to a .jpg, .mp4 or .mov, so the clue card is used.`);
  const media = usable ? override : `${SITE}/assets/instagram/trove-0${n}.jpg`;
  const video = /\.(mp4|mov)(\?|$)/i.test(media);
  const caption = [
    firstLine(n),
    `"${c.title}" — ${c.line}`,
    `Every clue is also on the website. Sign in at topkpop.io to investigate.`,
    `#TopKpop #AISuperSleuth #KClue`,
  ].join('\n\n');
  return { trove: n, media, video, caption };
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

/** Is this Trove's clue already on the account? Looks at the newest posts for the caption's first line. */
async function alreadyPosted(trove) {
  const got = await call('GET', `${env('INSTAGRAM_ACCOUNT_ID')}/media`, { fields: 'caption', limit: '25' });
  return (got.data || []).some((m) => String(m.caption || '').startsWith(firstLine(trove)));
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

/**
 * Post a Trove's clue. Never throws: the caller is the unlock job, and a failed post must not stop the emails.
 * notify({ subject, html }) emails the organizer and returns true only if the email was really sent.
 * Returns { posted, already, by_hand, reason, id }.
 */
async function postClue(trove, { notify, opts } = {}) {
  const clue = clueFor(trove);
  if (!clue) return { posted: false, reason: 'no clue for that Trove' };
  if (PREVIEW_MODE) return { posted: false, reason: 'the preview copy never posts' };
  const tell = async (why) => {
    if (!notify) return false;
    try {
      return (await notify({
        subject: `Post by hand: Trove 0${clue.trove} clue for Instagram`,
        html: `<p>Trove 0${clue.trove} is open. ${esc(why)}</p>
<p><strong>${clue.video ? 'Video' : 'Picture'}:</strong> <a href="${esc(clue.media)}">${esc(clue.media)}</a></p>
<p><strong>Caption:</strong></p><pre style="white-space:pre-wrap;font-family:inherit">${esc(clue.caption)}</pre>
<p>If it is already on @topkpopio, there is nothing to do.</p>`,
      })) === true;
    } catch (e) { console.error('instagram notify error:', e.message); return false; }
  };
  if (!configured()) {
    const by_hand = await tell('Instagram is not connected to the site yet, so this one is yours to post.');
    return { posted: false, by_hand, reason: 'Instagram is not connected yet' };
  }
  if (busy.has(clue.trove)) return { posted: false, reason: 'this clue is being posted right now' };
  busy.add(clue.trove);
  try {
    if (await alreadyPosted(clue.trove)) return { posted: true, already: true };
    const id = await publish(clue, opts);
    console.log(`Instagram: Trove ${clue.trove} clue posted (${id}).`);
    return { posted: true, id };
  } catch (e) {
    const why = scrub(e.message);
    // A lost reply does not mean a lost post: look once more before asking anyone to post by hand.
    try { if (await alreadyPosted(clue.trove)) return { posted: true, already: true }; } catch (_) { /* fall through to the notice */ }
    console.error(`Instagram: Trove ${clue.trove} clue failed:`, why);
    const by_hand = await tell(`The site tried to post this to Instagram and it did not go through (${why}). Please check @topkpopio first in case it did arrive.`);
    return { posted: false, by_hand, reason: why };
  } finally { busy.delete(clue.trove); }
}

module.exports = { configured, clueFor, postClue, _internal: { publish, address, alreadyPosted, scrub } };
