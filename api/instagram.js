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

function configured() {
  return !!(process.env.INSTAGRAM_ACCOUNT_ID && process.env.INSTAGRAM_ACCESS_TOKEN);
}

/** What would be posted for a Trove: the media link, whether it is a video, and the caption. */
function clueFor(trove) {
  const n = Number(trove); const c = CLUES[n]; if (!c) return null;
  const override = String(process.env[`INSTAGRAM_TROVE${n}_MEDIA`] || '').trim();
  const media = /^https:\/\/\S+$/i.test(override) ? override : `${SITE}/assets/instagram/trove-0${n}.jpg`;
  const video = /\.(mp4|mov)(\?|$)/i.test(media);
  const caption = [
    `K-CLUE · Treasure Trove 0${n} is open.`,
    `"${c.title}" — ${c.line}`,
    `Every clue is also on the website. Sign in at topkpop.io to investigate.`,
    `#TopKpop #AISuperSleuth #KClue`,
  ].join('\n\n');
  return { trove: n, media, video, caption };
}

function address(path) {
  const host = (process.env.INSTAGRAM_API_HOST || 'graph.instagram.com').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const v = (process.env.INSTAGRAM_API_VERSION || '').replace(/^\/+|\/+$/g, '');
  return `https://${host}/${v ? v + '/' : ''}${path}`;
}

async function call(method, path, params) {
  const body = new URLSearchParams({ ...params, access_token: process.env.INSTAGRAM_ACCESS_TOKEN });
  const url = address(path);
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = method === 'GET'
      ? await fetch(`${url}?${body}`, { signal: ctl.signal })
      : await fetch(url, { method: 'POST', body, signal: ctl.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      // Never let the token reach a log or an email.
      const msg = String((data.error && data.error.message) || `Instagram answered ${res.status}`).replace(/access_token=[^&\s]+/g, 'access_token=…');
      throw new Error(msg);
    }
    return data;
  } finally { clearTimeout(timer); }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Create the post, wait until Instagram has finished reading the media, then publish. Returns the media id. */
async function publish({ media, video, caption }, { pollMs = 15000, maxPolls = 20 } = {}) {
  const id = process.env.INSTAGRAM_ACCOUNT_ID;
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

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Post a Trove's clue. Never throws: the caller is the unlock job, and a failed post must not stop the emails.
 * notify({ subject, html }) emails the organizer. Returns { posted, by_hand, reason, id }.
 */
async function postClue(trove, { notify, opts } = {}) {
  const clue = clueFor(trove);
  if (!clue) return { posted: false, reason: 'no clue for that Trove' };
  if (PREVIEW_MODE) return { posted: false, reason: 'the preview copy never posts' };
  const tell = async (why) => {
    if (!notify) return false;
    try {
      await notify({
        subject: `Post by hand: Trove 0${clue.trove} clue for Instagram`,
        html: `<p>Trove 0${clue.trove} is open. ${esc(why)}</p>
<p><strong>${clue.video ? 'Video' : 'Picture'}:</strong> <a href="${esc(clue.media)}">${esc(clue.media)}</a></p>
<p><strong>Caption:</strong></p><pre style="white-space:pre-wrap;font-family:inherit">${esc(clue.caption)}</pre>`,
      });
      return true;
    } catch (e) { console.error('instagram notify error:', e.message); return false; }
  };
  if (!configured()) {
    const by_hand = await tell('Instagram is not connected to the site yet, so this one is yours to post.');
    return { posted: false, by_hand, reason: 'Instagram is not connected yet' };
  }
  try {
    const id = await publish(clue, opts);
    console.log(`Instagram: Trove ${clue.trove} clue posted (${id}).`);
    return { posted: true, id };
  } catch (e) {
    console.error(`Instagram: Trove ${clue.trove} clue failed:`, e.message);
    const by_hand = await tell(`The site tried to post this to Instagram and it did not go through (${e.message}).`);
    return { posted: false, by_hand, reason: e.message };
  }
}

module.exports = { configured, clueFor, postClue, _internal: { publish, address } };
