/**
 * TopKpop.io — The Evaluation Room: the game wall.
 *
 * A team that has locked its work can share it on a wall only signed-in teams can see.
 *   Trove 01: the avatar and poster they locked            (kept in private storage)
 *   Trove 02: the karaoke video made in the Song Maker      (kept on the game's Vimeo, playable only on this site)
 * Sharing adds the Trove's sharing bonus by itself, once. Taking the item down takes the bonus back.
 * The organizer gets an email for every share and can remove anything.
 * "Also post to our public Instagram" is a separate choice the team makes; it is only recorded here.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BUCKET = 'evalroom-private';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WALL_BONUS = Number(process.env.EVALROOM_WALL_BONUS || 25);
const safePart = (x) => String(x).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
const SITE = (process.env.EVALROOM_SITE_URL || 'https://www.topkpop.io').replace(/\/$/, '');

function ffmpegPath() { try { return require('ffmpeg-static'); } catch (e) { return null; } }
function run(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] }); let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('picture took too long')); }, 60000);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (c) => { clearTimeout(t); c === 0 ? resolve() : reject(new Error('ffmpeg ' + c + ': ' + err.slice(-300))); });
  });
}
/** Any picture in, a plain JPEG out, no wider or taller than `side`. Also strips hidden details such as location. */
async function toJpeg(buf, side) {
  const bin = ffmpegPath(); if (!bin) throw new Error('picture tool missing');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erwall-'));
  try {
    fs.writeFileSync(path.join(dir, 'in'), buf);
    await run(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'in', '-frames:v', '1', '-map_metadata', '-1',
      '-vf', `scale=w='if(gt(iw,ih),min(${side},iw),max(2,trunc(iw*min(${side},ih)/ih/2)*2))':h='if(gt(iw,ih),max(2,trunc(ih*min(${side},iw)/iw/2)*2),min(${side},ih))',format=rgba,split[a][b];[a]drawbox=color=white:t=fill:replace=1[bg];[bg][b]overlay=format=auto,format=yuvj420p`, '-q:v', '4', 'out.jpg'], dir);
    return fs.readFileSync(path.join(dir, 'out.jpg'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ── Vimeo (videos play only on this site) ────────────────────────────────────
const vimeoOn = () => !!process.env.VIMEO_ACCESS_TOKEN;
async function vimeo(method, pth, body) {
  const r = await fetch('https://api.vimeo.com' + pth, { method, headers: { Authorization: 'bearer ' + String(process.env.VIMEO_ACCESS_TOKEN).trim(), Accept: 'application/vnd.vimeo.*+json;version=3.4', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
  const t = await r.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch (_) { d = null; }
  if (r.status >= 400) throw Object.assign(new Error('Vimeo ' + r.status + ': ' + String((d && (d.developer_message || d.error)) || t).slice(0, 300)), { status: r.status });
  return d;
}
function wallDomains() {
  const list = String(process.env.EVALROOM_WALL_DOMAINS || 'topkpop.io,www.topkpop.io').split(',').map((x) => x.trim()).filter(Boolean);
  if (process.env.RAILWAY_PUBLIC_DOMAIN && !list.includes(process.env.RAILWAY_PUBLIC_DOMAIN)) list.push(process.env.RAILWAY_PUBLIC_DOMAIN);
  return list;
}
async function vimeoUpload(buf, name) {
  const made = await vimeo('POST', '/me/videos', { upload: { approach: 'tus', size: String(buf.length) }, name: String(name).slice(0, 120), description: 'Shared on the TopKpop.io game wall.', privacy: { view: 'disable', embed: 'whitelist', download: false } });
  const id = String(made.uri).split('/').pop();
  try {
    const up = await fetch(made.upload.upload_link, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: buf, signal: AbortSignal.timeout(180000) });
    if (up.status !== 204 || String(up.headers.get('upload-offset')) !== String(buf.length)) throw new Error('Vimeo upload ' + up.status);
    for (const d of wallDomains()) await vimeo('PUT', '/videos/' + id + '/privacy/domains/' + encodeURIComponent(d));
    const v = await vimeo('GET', '/videos/' + id + '?fields=player_embed_url');
    return { id, embed: v.player_embed_url };
  } catch (e) { await vimeo('DELETE', '/videos/' + id).catch(() => {}); throw e; }
}

module.exports = function attachWall(router, deps) {
  const { supabase, requireTeam, requireOrganizer, limited, loadPictures, activeLock, LOCKS, PREVIEW_MODE, lyricMatch, matchPct } = deps;
  const mine = (q) => q.eq('is_preview', PREVIEW_MODE);

  // Points for sharing go on the team's locked entry (and, on the live site, on the leaderboard record).
  /**
   * Add or take back one kind of bonus on a locked entry. Safe when two things happen at once:
   * each write only goes through if nobody changed the entry since it was read; otherwise it reads again.
   * Returns false when there is nothing to do (already added, or nothing of this kind to take back).
   */
  async function changeBonus(lockId, delta, tag) {
    let lock = null; let done = false;
    for (let i = 0; i < 6 && !done; i++) {
      const got = await supabase.from(LOCKS).select('id, bonus, bonus_reason, submission_id').eq('id', lockId).single();
      lock = got.data; if (!lock) return false;
      const had = String(lock.bonus_reason || '').split('+').filter(Boolean);
      if (delta > 0 && had.includes(tag)) return false;
      if (delta < 0 && !had.includes(tag)) return false;
      const reasons = had.filter((x) => x !== tag); if (delta > 0) reasons.push(tag);
      let q = supabase.from(LOCKS).update({ bonus: Math.max(0, (lock.bonus || 0) + delta), bonus_reason: reasons.join('+') || null }).eq('id', lock.id).eq('bonus', lock.bonus || 0);
      q = lock.bonus_reason == null ? q.is('bonus_reason', null) : q.eq('bonus_reason', lock.bonus_reason);
      const { data: upd, error } = await q.select('id');
      if (error) throw new Error(error.message);
      done = !!(upd && upd.length);
    }
    if (!done) throw new Error('the entry was busy; points not changed');
    if (!PREVIEW_MODE && lock.submission_id) {
      try { await changeLeaderboard(lock.submission_id, delta, tag); }
      catch (e) {
        // Put the entry back the way it was so the two never disagree.
        await changeBonusBack(lockId, delta, tag).catch((x) => console.error('evalroom bonus put-back error:', x.message));
        throw e;
      }
    }
    return true;
  }
  async function changeBonusBack(lockId, delta, tag) {
    for (let i = 0; i < 6; i++) {
      const { data: lock } = await supabase.from(LOCKS).select('id, bonus, bonus_reason').eq('id', lockId).single(); if (!lock) return;
      const had = String(lock.bonus_reason || '').split('+').filter(Boolean);
      const reasons = had.filter((x) => x !== tag); if (delta < 0) reasons.push(tag);
      let q = supabase.from(LOCKS).update({ bonus: Math.max(0, (lock.bonus || 0) - delta), bonus_reason: reasons.join('+') || null }).eq('id', lock.id).eq('bonus', lock.bonus || 0);
      q = lock.bonus_reason == null ? q.is('bonus_reason', null) : q.eq('bonus_reason', lock.bonus_reason);
      const { data: upd } = await q.select('id'); if (upd && upd.length) return;
    }
  }
  /** The leaderboard record. A failed read stops the change; it is never treated as zero. */
  async function changeLeaderboard(submissionId, delta, tag) {
    for (let i = 0; i < 6; i++) {
      const { data: cur, error } = await supabase.from('submissions').select('bonus_score, bonus_awarded_by').eq('id', submissionId).single();
      if (error || !cur) throw new Error('leaderboard read: ' + ((error && error.message) || 'not found'));
      const patch = { bonus_score: Math.max(0, (cur.bonus_score || 0) + delta) };
      // Only stamp who gave the bonus when no person has reviewed it; a person's review is never overwritten.
      if (!cur.bonus_awarded_by || /^auto-/.test(String(cur.bonus_awarded_by))) { patch.bonus_awarded_at = new Date().toISOString(); patch.bonus_awarded_by = /^auto-/.test(tag) ? tag : 'auto-' + tag; }
      let q = supabase.from('submissions').update(patch).eq('id', submissionId);
      q = cur.bonus_score == null ? q.is('bonus_score', null) : q.eq('bonus_score', cur.bonus_score);
      const { data: upd, error: e2 } = await q.select('id');
      if (e2) throw new Error('leaderboard write: ' + e2.message);
      if (upd && upd.length) return;
    }
    throw new Error('leaderboard was busy; points not changed');
  }

  /** One plain email to the organizer with a button to look at the item or remove it. Live site only. */
  async function tellOrganizer({ subject, lead, detail, link }) {
    const to = process.env.EVALROOM_ORGANIZER_EMAIL;
    if (PREVIEW_MODE || !process.env.RESEND_API_KEY || !to) return false;
    try {
      const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222"><p>${lead}</p>${detail || ''}` +
        `<p><a href="${SITE}${link}" style="display:inline-block;padding:10px 18px;background:#e6005c;color:#fff;text-decoration:none;border-radius:6px">Look at it or remove it</a></p>` +
        `<p style="color:#666;font-size:13px">Removing it also takes the points back. You will be asked for the organizer password.</p></div>`;
      const { Resend } = require('resend');
      const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({ from: 'TopKpop.io Evaluation Room <anna@topkpop.io>', to: to.split(',').map((x) => x.trim()).filter(Boolean), subject, html });
      if (error) { console.error('evalroom organizer notice error:', error.message || error); return false; }
      return true;
    } catch (e) { console.error('evalroom organizer notice error:', e.message); return false; }
  }
  const WHAT = { pictures: ['their avatar and poster (Trove 01)', 'an avatar and poster'], karaoke: ['their karaoke video (Trove 02)', 'a karaoke video'], song: ['their song (Trove 02)', 'a song'], dance: ['their dance video (Trove 03)', 'a dance video'] };
  async function notify(row) {
    const esc = (x) => String(x || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return tellOrganizer({
      subject: `Game wall: ${row.team_name} shared ${WHAT[row.kind][1]}`,
      lead: `<b>${esc(row.team_name)}</b> shared ${WHAT[row.kind][0]} on the game wall.`,
      detail: `<p>${row.public_ok ? '<b>They also approved posting it on the public Instagram page.</b>' : 'They did not approve public Instagram posting.'}</p><p>${row.bonus} sharing points were added by themselves.</p>`,
      link: `/pages/evaluation-room/organizer/?wall=${row.id}`,
    });
  }

  const EMBED_OK = /^https:\/\/player\.vimeo\.com\/video\/\d+/;
  /** One request for all the picture links a list needs. */
  async function linksFor(rows) {
    const paths = [];
    for (const r of rows) {
      if (r.kind === 'pictures' && r.images) for (const im of Object.values(r.images)) { if (im && im.small) paths.push(im.small); if (im && im.full) paths.push(im.full); }
      if (r.audio_path) paths.push(r.audio_path);
    }
    const map = {}; if (!paths.length) return map;
    for (let i = 0; i < paths.length; i += 200) {
      const { data } = await supabase.storage.from(BUCKET).createSignedUrls(paths.slice(i, i + 200), 3600);
      for (const d of data || []) if (d && d.signedUrl) map[d.path] = d.signedUrl;
    }
    return map;
  }
  function view(r, team, full, links) {
    const own = !!team && r.team_key === team.key;
    const out = { id: r.id, team: r.team_name, trove: r.trove, kind: r.kind, title: r.title, when: r.created_at, mine: own, publicOk: full || own ? r.public_ok : undefined };
    if (r.kind === 'pictures' && r.images) {
      out.images = {};
      for (const slot of ['avatar', 'poster']) { const im = r.images[slot]; if (im) out.images[slot] = { small: links[im.small] || null, full: links[im.full] || null }; }
    }
    if (EMBED_OK.test(String(r.vimeo_embed || ''))) out.embed = r.vimeo_embed;
    if (r.audio_path && links[r.audio_path]) out.audio = links[r.audio_path];
    if (/^https?:\/\//.test(String(r.link || ''))) out.link = r.link;
    if (full) { out.status = r.status; out.bonus = r.bonus; out.removedAt = r.removed_at; out.removedBy = r.removed_by; out.note = r.removed_note; out.practice = r.is_preview; out.ig = r.ig_status; }
    return out;
  }

  /**
   * Take one item off the wall. Only the first caller gets to do it, so the points come off once.
   * keepBonus: the locked entry itself is being reset, so there are no points to hand back.
   * Returns false when someone else already removed it.
   */
  async function takeDown(r, by, note, keepBonus) {
    const { data: claimed, error } = await supabase.from('evalroom_wall').update({ status: 'removed', removed_at: new Date().toISOString(), removed_by: by, removed_note: note ? String(note).slice(0, 300) : null })
      .eq('id', r.id).is('removed_at', null).select('*');
    if (error) throw new Error(error.message);
    if (!claimed || !claimed.length) return false;
    const row = claimed[0];
    if (!keepBonus && row.bonus && row.lock_id) {
      try { await changeBonus(row.lock_id, -row.bonus, 'wall'); }
      catch (e) {
        // The points could not be taken back, so the item goes back up and the caller is told.
        await supabase.from('evalroom_wall').update({ status: r.status, removed_at: null, removed_by: null, removed_note: null }).eq('id', r.id);
        throw new Error('bonus undo: ' + e.message);
      }
    }
    const paths = [];
    if (row.images) for (const slot of Object.values(row.images)) { if (slot && slot.small) paths.push(slot.small); if (slot && slot.full) paths.push(slot.full); }
    if (row.audio_path) paths.push(row.audio_path);
    if (paths.length) { const rm = await supabase.storage.from(BUCKET).remove(paths); if (rm.error) console.error('evalroom wall file delete:', rm.error.message); }
    let vimeoGone = true;
    if (row.vimeo_id && vimeoOn()) await vimeo('DELETE', '/videos/' + row.vimeo_id).catch((e) => { if (e.status !== 404) { vimeoGone = false; console.error('evalroom wall vimeo delete (video ' + row.vimeo_id + ' still on Vimeo):', e.message); } });
    await supabase.from('evalroom_wall').update({ images: null, vimeo_embed: null, audio_path: null, link: null, bonus: 0, ...(vimeoGone ? { vimeo_id: null } : {}) }).eq('id', r.id);
    return true;
  }
  /** When a locked entry is reset, what was shared from it comes off the wall too. */
  async function retireForLock(lockId, by, note) {
    const { data } = await supabase.from('evalroom_wall').select('*').eq('lock_id', lockId).is('removed_at', null);
    for (const r of data || []) await takeDown(r, by, note, true).catch((e) => console.error('evalroom wall retire:', e.message));
  }
  /** When the organizer removes a team's turned-in karaoke video, its copy on the wall goes too (and its sharing points). */
  async function retireSongForLock(lockId, by, note) {
    const { data } = await supabase.from('evalroom_wall').select('*').eq('lock_id', lockId).eq('kind', 'song').is('removed_at', null);
    for (const r of data || []) await takeDown(r, by, note, false);
  }
  /** A share that never finished stops blocking the team after ten minutes. */
  async function tidy(teamKey) {
    await mine(supabase.from('evalroom_wall').update({ status: 'failed', error: 'did not finish' })).eq('team_key', teamKey).eq('status', 'processing').lt('created_at', new Date(Date.now() - 10 * 60000).toISOString());
  }
  const videoOf = async (teamKey, songId) => {
    const dir = `${safePart(teamKey)}/karaoke/${songId}`;
    const { data: files } = await supabase.storage.from(BUCKET).list(dir, { limit: 100 });
    const vid = (files || []).filter((f) => /^video-.*\.mp4$/.test(f.name)).sort((a, c) => String(c.created_at).localeCompare(String(a.created_at)))[0];
    return vid ? `${dir}/${vid.name}` : null;
  };

  // ── What is on the wall, and what this team can still share ──
  router.get('/wall', requireTeam, async (req, res) => {
    try {
      const { data, error } = await mine(supabase.from('evalroom_wall').select('*')).eq('status', 'ready').is('removed_at', null).order('created_at', { ascending: false }).limit(150);
      if (error) throw new Error(error.message);
      await tidy(req.team.key).catch(() => {});
      const links = await linksFor(data || []);
      const items = (data || []).map((r) => view(r, req.team, false, links));
      const { data: own } = await mine(supabase.from('evalroom_wall').select('trove, status')).eq('team_key', req.team.key).is('removed_at', null).neq('status', 'failed');
      const shared = Object.fromEntries((own || []).map((x) => [x.trove, x.status]));
      const [l1, l2, l3] = await Promise.all([activeLock(req.team.key, 1), activeLock(req.team.key, 2), activeLock(req.team.key, 3)]);
      let songs = [];
      if (l2 && shared[2] == null) {
        const { data: ks } = await supabase.from('evalroom_karaoke').select('id, title, created_at').eq('team_key', req.team.key).eq('status', 'ready').order('created_at', { ascending: false }).limit(10);
        songs = await Promise.all((ks || []).map(async (k) => ({ id: k.id, title: k.title, hasVideo: !!(await videoOf(req.team.key, k.id).catch(() => null)) })));
      }
      res.json({ items, bonus: WALL_BONUS, practice: PREVIEW_MODE, videoReady: vimeoOn(),
        can: { pictures: { locked: !!l1, shared: shared[1] || null },
          karaoke: { locked: !!l2, shared: shared[2] || null, songs, turnedIn: l2 && l2.song_url ? { title: (l2.song_check && l2.song_check.title) || 'Our song', karaokeId: (/^room:karaoke:(.+)$/.exec(l2.song_url) || [])[1] || null } : null },
          dance: { locked: !!l3, shared: shared[3] || null, hasVideo: !!(l3 && l3.dance_video_url) } } });
    } catch (e) { console.error('evalroom wall list error:', e.message); res.status(500).json({ error: 'The wall could not be loaded. Please try again.' }); }
  });

  // ── Share ──
  router.post('/wall/share', requireTeam, async (req, res) => {
    let row = null; const madeFiles = []; let madeVimeo = null; let pointsIn = false; let lockId = null;
    try {
      const b = req.body || {}; const kind = String(b.kind || '');
      if (!['pictures', 'karaoke', 'song', 'dance'].includes(kind)) return res.status(400).json({ error: 'Choose what to share.' });
      if (String(b.confirm) !== 'true') return res.status(400).json({ error: 'Tick the box to say your team agrees to share this with the other teams.' });
      const trove = kind === 'pictures' ? 1 : kind === 'dance' ? 3 : 2;
      const lock = await activeLock(req.team.key, trove);
      if (!lock) return res.status(404).json({ error: kind === 'pictures' ? 'Take the Stage with your avatar and poster first. Then you can share them.' : kind === 'dance' ? 'Take the Stage with your lesson plan first. Then you can share your dance video.' : 'Take the Stage with your lyrics first. Then you can share your song.' });
      let song = null; let videoPath = null; let plan = null;   // plan: how a turned-in song or dance video goes up
      if (kind === 'dance') {
        if (!/^https?:\/\//.test(String(lock.dance_video_url || ''))) return res.status(400).json({ error: 'Your team did not add a dance video link when it took the stage, so there is no video to share.' });
        plan = { title: 'Dance video', link: lock.dance_video_url };
      }
      if (kind === 'song') {
        const u = String(lock.song_url || ''); const title = (lock.song_check && lock.song_check.title) || 'Our song';
        if (!u) return res.status(400).json({ error: 'Turn in your song first. Then you can share it here.' });
        const room = /^room:(karaoke|sung|upload):([0-9a-f-]{36})$/i.exec(u);
        if (room && room[1] === 'karaoke') return res.status(400).json({ error: 'Choose your karaoke song from the list to share its video.' });
        if (room && room[1] === 'sung') {
          const { data: c } = await supabase.from('evalroom_covers').select('id, audio_path, audio_type, status').eq('id', room[2]).eq('team_key', req.team.key).single();
          if (!c || c.status !== 'ready' || !c.audio_path) return res.status(404).json({ error: 'The song your team turned in could not be found.' });
          plan = { title, audioFrom: c.audio_path, audioType: c.audio_type || 'audio/mpeg' };
        } else if (room && room[1] === 'upload') {
          const { data: x } = await mine(supabase.from('evalroom_extras').select('id, link, file_path, status')).eq('id', room[2]).eq('team_key', req.team.key).single();
          if (!x || x.status !== 'ready') return res.status(404).json({ error: 'The karaoke video your team turned in could not be found.' });
          if (x.file_path) { if (!vimeoOn()) return res.status(503).json({ error: 'Sharing videos is not switched on yet.' }); plan = { title, videoFrom: x.file_path }; }
          else plan = { title, link: x.link };
        } else if (/^https?:\/\//.test(u)) plan = { title, link: u };
        else return res.status(400).json({ error: 'The song your team turned in cannot be shared here.' });
      }
      if (kind === 'karaoke') {
        if (!vimeoOn()) return res.status(503).json({ error: 'Sharing videos is not switched on yet.' });
        if (!UUID.test(String(b.id || ''))) return res.status(400).json({ error: 'Choose one of your team\'s karaoke songs.' });
        const { data: s } = await supabase.from('evalroom_karaoke').select('id, title, status, new_lyrics').eq('id', b.id).eq('team_key', req.team.key).single();
        if (!s || s.status !== 'ready') return res.status(404).json({ error: 'That song is not finished yet, or it was removed.' });
        // The video on the wall has to be the song made from the lyrics the team locked.
        const { data: reh } = await supabase.from('evalroom_rehearsals').select('input_text').eq('id', lock.rehearsal_id).single();
        const noBrackets = (t) => String(t || '').replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
        const m = lyricMatch(noBrackets(reh && reh.input_text), noBrackets(s.new_lyrics));
        if (!(m.pct >= matchPct && m.enough)) return res.status(400).json({ error: 'This karaoke song does not use the lyrics your team locked. Share the song made with your locked lyrics.' });
        videoPath = await videoOf(req.team.key, s.id);
        if (!videoPath) return res.status(400).json({ error: 'Make the karaoke video first. Open the song in the Song Maker and press Make the karaoke video, then come back.' });
        song = s;
      }
      await tidy(req.team.key).catch(() => {});
      // Anything still up from an entry the organizer has since reset comes down first.
      const { data: old } = await mine(supabase.from('evalroom_wall').select('*')).eq('team_key', req.team.key).eq('trove', trove).is('removed_at', null).neq('status', 'failed').neq('lock_id', lock.id);
      for (const o of old || []) await takeDown(o, 'reset', 'The locked entry was reset.', true);
      if (limited('wall:' + req.team.key, 6, 10 * 60000)) return res.status(429).json({ error: 'That is a lot of sharing in a few minutes. Please wait a little and try again.' });
      lockId = lock.id;
      const publicOk = String(b.public_ok) === 'true';
      const ins = await supabase.from('evalroom_wall').insert({ team_key: req.team.key, team_name: req.team.name, trove, kind, title: song ? song.title : plan ? plan.title : 'Avatar and poster', source_id: song ? song.id : null, lock_id: lock.id, status: 'processing', public_ok: publicOk, public_ok_at: publicOk ? new Date().toISOString() : null, ig_status: publicOk ? 'approved-waiting-for-setup' : null, is_preview: PREVIEW_MODE }).select('*').single();
      if (ins.error) return res.status(409).json({ error: ins.error.code === '23505' ? 'Your team already shared this Trove on the wall.' : 'That could not be shared. Please try again.' });
      row = ins.data;
      const patch = {};
      if (kind === 'pictures') {
        const { data: reh } = await supabase.from('evalroom_rehearsals').select('input_meta').eq('id', lock.rehearsal_id).single();
        const pics = await loadPictures(reh);
        if (pics.length !== 2) throw Object.assign(new Error('no kept pictures'), { friendly: 'The pictures your team locked could not be found. Please tell the organizer.' });
        const images = {};
        for (const [slot, f] of [['avatar', pics[0]], ['poster', pics[1]]]) {
          const [full, small] = [await toJpeg(f.buffer, 1440), await toJpeg(f.buffer, 480)];
          const base = `wall/${row.id}/${slot}`;   // no team details in the picture's address
          for (const [name, buf] of [[base + '.jpg', full], [base + '_s.jpg', small]]) { madeFiles.push(name); const up = await supabase.storage.from(BUCKET).upload(name, buf, { contentType: 'image/jpeg', upsert: true }); if (up.error) throw new Error('storage: ' + up.error.message); }
          images[slot] = { full: base + '.jpg', small: base + '_s.jpg' };
        }
        patch.images = images;
      } else if (plan && plan.link) {
        patch.link = plan.link;
      } else if (plan && plan.audioFrom) {
        const dl = await supabase.storage.from(BUCKET).download(plan.audioFrom);
        if (dl.error) throw new Error('storage: ' + dl.error.message);
        const name = `wall/${row.id}/song.${String(plan.audioFrom).split('.').pop() || 'mp3'}`; madeFiles.push(name);
        const up = await supabase.storage.from(BUCKET).upload(name, Buffer.from(await dl.data.arrayBuffer()), { contentType: plan.audioType, upsert: true });
        if (up.error) throw new Error('storage: ' + up.error.message);
        patch.audio_path = name;
      } else {
        const dl = await supabase.storage.from(BUCKET).download(plan ? plan.videoFrom : videoPath);
        if (dl.error) throw new Error('storage: ' + dl.error.message);
        const v = await vimeoUpload(Buffer.from(await dl.data.arrayBuffer()), `${req.team.name} - ${song ? song.title : plan.title}`);
        madeVimeo = v.id; patch.vimeo_id = v.id; patch.vimeo_embed = v.embed;
      }
      pointsIn = await changeBonus(lock.id, WALL_BONUS, 'wall');
      patch.status = 'ready'; patch.bonus = pointsIn ? WALL_BONUS : 0;
      const { data: done, error: e3 } = await supabase.from('evalroom_wall').update(patch).eq('id', row.id).eq('status', 'processing').select('*').single();
      if (e3 || !done) throw new Error((e3 && e3.message) || 'share was cancelled');
      row = null;   // from here on the share stands, whatever happens to the email
      const emailed = await notify(done).catch(() => false);
      let item = null; try { item = view(done, req.team, false, await linksFor([done])); } catch (_) { item = null; }
      res.json({ ok: true, bonus: done.bonus, item, emailed });
    } catch (e) {
      console.error('evalroom wall share error:', e.message);
      if (row) {
        // Put everything back the way it was.
        if (pointsIn && lockId) await changeBonus(lockId, -WALL_BONUS, 'wall').catch((x) => console.error('evalroom wall share undo points:', x.message));
        if (madeFiles.length) await supabase.storage.from(BUCKET).remove(madeFiles).catch(() => {});
        if (madeVimeo) await vimeo('DELETE', '/videos/' + madeVimeo).catch((x) => console.error('evalroom wall share undo vimeo (video ' + madeVimeo + '):', x.message));
        await supabase.from('evalroom_wall').update({ status: 'failed', error: String(e.message).slice(0, 300) }).eq('id', row.id);
      }
      if (res.headersSent) return;
      res.status(502).json({ error: e.friendly || 'That could not be shared this time. Nothing was changed. Please try again.' });
    }
  });

  // ── Take your own item down (the sharing points go with it) ──
  router.post('/wall/:id/remove', requireTeam, async (req, res) => {
    try {
      if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found.' });
      const { data: r } = await mine(supabase.from('evalroom_wall').select('*')).eq('id', req.params.id).eq('team_key', req.team.key).single();
      if (!r || r.removed_at) return res.status(404).json({ error: 'Not found.' });
      if (!(await takeDown(r, 'team'))) return res.status(404).json({ error: 'Not found.' });
      res.json({ ok: true });
    } catch (e) { console.error('evalroom wall remove error:', e.message); res.status(502).json({ error: 'That could not be removed. Please try again.' }); }
  });

  // ── Organizer ──
  router.get('/organizer/wall', requireOrganizer, async (req, res) => { try {
    // What is still up comes first; removed items stay listed below as a record.
    const [up, down] = await Promise.all([
      mine(supabase.from('evalroom_wall').select('*')).is('removed_at', null).in('status', ['ready', 'processing']).order('created_at', { ascending: false }).limit(400),
      mine(supabase.from('evalroom_wall').select('*')).not('removed_at', 'is', null).order('removed_at', { ascending: false }).limit(100),
    ]);
    if (up.error || down.error) return res.status(500).json({ error: 'Could not load the wall.' });
    const rows = (up.data || []).concat(down.data || []);
    const links = await linksFor(rows).catch(() => ({}));
    res.json({ items: rows.map((r) => view(r, null, true, links)) });
  } catch (e) { console.error('evalroom organizer wall list error:', e.message); res.status(500).json({ error: 'Could not load the wall.' }); } });
  router.post('/organizer/wall/remove', requireOrganizer, async (req, res) => {
    try {
      const id = String((req.body && req.body.id) || ''); if (!UUID.test(id)) return res.status(404).json({ error: 'Not found.' });
      const { data: r } = await mine(supabase.from('evalroom_wall').select('*')).eq('id', id).single();
      if (!r || r.removed_at) return res.status(404).json({ error: 'Not found, or already removed.' });
      if (!(await takeDown(r, 'organizer', req.body.note))) return res.status(404).json({ error: 'Not found, or already removed.' });
      res.json({ ok: true });
    } catch (e) { console.error('evalroom organizer wall remove error:', e.message); res.status(502).json({ error: 'That could not be removed. Please try again.' }); }
  });
  return { retireForLock, retireSongForLock, changeBonus, tellOrganizer };
};
module.exports._internal = { toJpeg, vimeoUpload, wallDomains };
