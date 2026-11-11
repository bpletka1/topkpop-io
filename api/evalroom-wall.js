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
      '-vf', `scale=w='if(gt(iw,ih),min(${side},iw),-2)':h='if(gt(iw,ih),-2,min(${side},ih))',format=yuvj420p`, '-q:v', '4', 'out.jpg'], dir);
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
  const { supabase, requireTeam, requireOrganizer, limited, loadPictures, activeLock, LOCKS, PREVIEW_MODE } = deps;
  const mine = (q) => q.eq('is_preview', PREVIEW_MODE);

  // Points for sharing go on the team's locked entry (and, on the live site, on the leaderboard record).
  async function changeBonus(lockId, delta, tag) {
    const { data: lock } = await supabase.from(LOCKS).select('id, bonus, bonus_reason, submission_id').eq('id', lockId).single();
    if (!lock) return false;
    const reasons = String(lock.bonus_reason || '').split('+').filter(Boolean).filter((x) => x !== tag);
    if (delta > 0) reasons.push(tag);
    const { error } = await supabase.from(LOCKS).update({ bonus: Math.max(0, (lock.bonus || 0) + delta), bonus_reason: reasons.join('+') || null }).eq('id', lock.id);
    if (error) throw new Error(error.message);
    if (!PREVIEW_MODE && lock.submission_id) {
      const { data: cur } = await supabase.from('submissions').select('bonus_score').eq('id', lock.submission_id).single();
      const { error: e2 } = await supabase.from('submissions').update({ bonus_score: Math.max(0, ((cur && cur.bonus_score) || 0) + delta), bonus_awarded_at: new Date().toISOString(), bonus_awarded_by: 'auto-wall' }).eq('id', lock.submission_id);
      if (e2) { await supabase.from(LOCKS).update({ bonus: lock.bonus || 0, bonus_reason: lock.bonus_reason }).eq('id', lock.id); throw new Error(e2.message); }
    }
    return true;
  }

  // Tell the organizer about every share, with a link to look at it and take it down.
  async function notify(row) {
    const to = process.env.EVALROOM_ORGANIZER_EMAIL;
    if (PREVIEW_MODE || !process.env.RESEND_API_KEY || !to) return false;
    try {
      const esc = (x) => String(x || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const what = row.kind === 'pictures' ? 'their avatar and poster (Trove 01)' : 'their karaoke video (Trove 02)';
      const link = `${SITE}/pages/evaluation-room/organizer/?wall=${row.id}`;
      const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222"><p><b>${esc(row.team_name)}</b> shared ${what} on the game wall.</p>` +
        `<p>${row.public_ok ? '<b>They also approved posting it on the public Instagram page.</b>' : 'They did not approve public Instagram posting.'}</p>` +
        `<p>${row.bonus} sharing points were added by themselves.</p>` +
        `<p><a href="${link}" style="display:inline-block;padding:10px 18px;background:#e6005c;color:#fff;text-decoration:none;border-radius:6px">Look at it or remove it</a></p>` +
        `<p style="color:#666;font-size:13px">Removing it also takes the sharing points back. You will be asked for the organizer password.</p></div>`;
      const { Resend } = require('resend');
      const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({ from: 'TopKpop.io Game Wall <anna@topkpop.io>', to: to.split(',').map((x) => x.trim()).filter(Boolean), subject: `Game wall: ${row.team_name} shared ${row.kind === 'pictures' ? 'an avatar and poster' : 'a karaoke video'}`, html });
      if (error) { console.error('evalroom wall notice error:', error.message || error); return false; }
      return true;
    } catch (e) { console.error('evalroom wall notice error:', e.message); return false; }
  }

  async function view(r, team, full) {
    const out = { id: r.id, team: r.team_name, trove: r.trove, kind: r.kind, title: r.title, when: r.created_at, mine: !!team && r.team_key === team.key, publicOk: full || (team && r.team_key === team.key) ? r.public_ok : undefined };
    if (r.kind === 'pictures' && r.images) {
      out.images = {};
      for (const slot of ['avatar', 'poster']) {
        const im = r.images[slot]; if (!im) continue;
        const [s, f] = await Promise.all([supabase.storage.from(BUCKET).createSignedUrl(im.small, 3600), supabase.storage.from(BUCKET).createSignedUrl(im.full, 3600)]);
        out.images[slot] = { small: s.data && s.data.signedUrl, full: f.data && f.data.signedUrl };
      }
    }
    if (r.kind === 'karaoke') out.embed = r.vimeo_embed;
    if (full) { out.status = r.status; out.bonus = r.bonus; out.removedAt = r.removed_at; out.removedBy = r.removed_by; out.note = r.removed_note; out.practice = r.is_preview; out.ig = r.ig_status; }
    return out;
  }

  async function takeDown(r, by, note) {
    const paths = [];
    if (r.images) for (const slot of Object.values(r.images)) { if (slot.small) paths.push(slot.small); if (slot.full) paths.push(slot.full); }
    if (paths.length) await supabase.storage.from(BUCKET).remove(paths).catch(() => {});
    if (r.vimeo_id && vimeoOn()) await vimeo('DELETE', '/videos/' + r.vimeo_id).catch((e) => console.error('evalroom wall vimeo delete:', e.message));
    if (r.bonus && r.lock_id) await changeBonus(r.lock_id, -r.bonus, 'wall').catch((e) => console.error('evalroom wall bonus undo:', e.message));
    const { error } = await supabase.from('evalroom_wall').update({ status: 'removed', removed_at: new Date().toISOString(), removed_by: by, removed_note: note ? String(note).slice(0, 300) : null, images: null, vimeo_id: null, vimeo_embed: null, bonus: 0 }).eq('id', r.id);
    if (error) throw new Error(error.message);
  }

  // ── What is on the wall, and what this team can still share ──
  router.get('/wall', requireTeam, async (req, res) => {
    try {
      const { data, error } = await mine(supabase.from('evalroom_wall').select('*')).eq('status', 'ready').is('removed_at', null).order('created_at', { ascending: false }).limit(150);
      if (error) throw new Error(error.message);
      const items = []; for (const r of data || []) items.push(await view(r, req.team, false));
      const { data: own } = await mine(supabase.from('evalroom_wall').select('trove, status')).eq('team_key', req.team.key).is('removed_at', null).neq('status', 'failed');
      const shared = Object.fromEntries((own || []).map((x) => [x.trove, x.status]));
      const [l1, l2] = await Promise.all([activeLock(req.team.key, 1), activeLock(req.team.key, 2)]);
      let songs = [];
      if (l2) { const { data: ks } = await supabase.from('evalroom_karaoke').select('id, title, created_at').eq('team_key', req.team.key).eq('status', 'ready').order('created_at', { ascending: false }).limit(10); songs = ks || []; }
      res.json({ items, bonus: WALL_BONUS, practice: PREVIEW_MODE, videoReady: vimeoOn(),
        can: { pictures: { locked: !!l1, shared: shared[1] || null }, karaoke: { locked: !!l2, shared: shared[2] || null, songs } } });
    } catch (e) { console.error('evalroom wall list error:', e.message); res.status(500).json({ error: 'The wall could not be loaded. Please try again.' }); }
  });

  // ── Share ──
  router.post('/wall/share', requireTeam, async (req, res) => {
    let row = null;
    try {
      const b = req.body || {}; const kind = String(b.kind || '');
      if (kind !== 'pictures' && kind !== 'karaoke') return res.status(400).json({ error: 'Choose what to share.' });
      if (String(b.confirm) !== 'true') return res.status(400).json({ error: 'Tick the box to say your team agrees to share this with the other teams.' });
      if (limited('wall:' + req.team.key, 6, 10 * 60000)) return res.status(429).json({ error: 'That is a lot of sharing in a few minutes. Please wait a little and try again.' });
      const trove = kind === 'pictures' ? 1 : 2;
      const lock = await activeLock(req.team.key, trove);
      if (!lock) return res.status(404).json({ error: kind === 'pictures' ? 'Take the Stage with your avatar and poster first. Then you can share them.' : 'Take the Stage with your lyrics first. Then you can share your karaoke video.' });
      let song = null; let videoPath = null;
      if (kind === 'karaoke') {
        if (!vimeoOn()) return res.status(503).json({ error: 'Sharing videos is not switched on yet.' });
        if (!UUID.test(String(b.id || ''))) return res.status(400).json({ error: 'Choose one of your team\'s karaoke songs.' });
        const { data: s } = await supabase.from('evalroom_karaoke').select('id, title, status').eq('id', b.id).eq('team_key', req.team.key).single();
        if (!s || s.status !== 'ready') return res.status(404).json({ error: 'That song is not finished yet, or it was removed.' });
        const dir = `${safePart(req.team.key)}/karaoke/${s.id}`;
        const { data: files } = await supabase.storage.from(BUCKET).list(dir, { limit: 100 });
        const vid = (files || []).filter((f) => /^video-.*\.mp4$/.test(f.name)).sort((a, c) => String(c.created_at).localeCompare(String(a.created_at)))[0];
        if (!vid) return res.status(400).json({ error: 'Make the karaoke video first. Open the song in the Song Maker and press Make the karaoke video, then come back.' });
        song = s; videoPath = `${dir}/${vid.name}`;
      }
      const publicOk = String(b.public_ok) === 'true';
      const ins = await supabase.from('evalroom_wall').insert({ team_key: req.team.key, team_name: req.team.name, trove, kind, title: song ? song.title : 'Avatar and poster', source_id: song ? song.id : null, lock_id: lock.id, status: 'processing', public_ok: publicOk, public_ok_at: publicOk ? new Date().toISOString() : null, ig_status: publicOk ? 'approved-waiting-for-setup' : null, is_preview: PREVIEW_MODE }).select('*').single();
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
          const base = `${safePart(req.team.key)}/wall/${row.id}/${slot}`;
          for (const [name, buf] of [[base + '.jpg', full], [base + '_s.jpg', small]]) { const up = await supabase.storage.from(BUCKET).upload(name, buf, { contentType: 'image/jpeg', upsert: true }); if (up.error) throw new Error('storage: ' + up.error.message); }
          images[slot] = { full: base + '.jpg', small: base + '_s.jpg' };
        }
        patch.images = images;
      } else {
        const dl = await supabase.storage.from(BUCKET).download(videoPath);
        if (dl.error) throw new Error('storage: ' + dl.error.message);
        const v = await vimeoUpload(Buffer.from(await dl.data.arrayBuffer()), `${req.team.name} - ${song.title}`);
        patch.vimeo_id = v.id; patch.vimeo_embed = v.embed;
      }
      await changeBonus(lock.id, WALL_BONUS, 'wall');
      patch.status = 'ready'; patch.bonus = WALL_BONUS;
      const { data: done, error: e3 } = await supabase.from('evalroom_wall').update(patch).eq('id', row.id).select('*').single();
      if (e3) { await changeBonus(lock.id, -WALL_BONUS, 'wall').catch(() => {}); throw new Error(e3.message); }
      const emailed = await notify(done);
      res.json({ ok: true, bonus: WALL_BONUS, item: await view(done, req.team, false), emailed });
    } catch (e) {
      console.error('evalroom wall share error:', e.message);
      if (row) await supabase.from('evalroom_wall').update({ status: 'failed', error: String(e.message).slice(0, 300) }).eq('id', row.id);
      res.status(502).json({ error: e.friendly || 'That could not be shared this time. Nothing was changed. Please try again.' });
    }
  });

  // ── Take your own item down (the sharing points go with it) ──
  router.post('/wall/:id/remove', requireTeam, async (req, res) => {
    try {
      if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found.' });
      const { data: r } = await mine(supabase.from('evalroom_wall').select('*')).eq('id', req.params.id).eq('team_key', req.team.key).single();
      if (!r || r.removed_at) return res.status(404).json({ error: 'Not found.' });
      await takeDown(r, 'team'); res.json({ ok: true });
    } catch (e) { console.error('evalroom wall remove error:', e.message); res.status(502).json({ error: 'That could not be removed. Please try again.' }); }
  });

  // ── Organizer ──
  router.get('/organizer/wall', requireOrganizer, async (req, res) => {
    const { data, error } = await supabase.from('evalroom_wall').select('*').neq('status', 'failed').order('created_at', { ascending: false }).limit(300);
    if (error) return res.status(500).json({ error: 'Could not load the wall.' });
    const items = []; for (const r of data || []) items.push(await view(r, null, true));
    res.json({ items });
  });
  router.post('/organizer/wall/remove', requireOrganizer, async (req, res) => {
    try {
      const id = String((req.body && req.body.id) || ''); if (!UUID.test(id)) return res.status(404).json({ error: 'Not found.' });
      const { data: r } = await supabase.from('evalroom_wall').select('*').eq('id', id).single();
      if (!r || r.removed_at) return res.status(404).json({ error: 'Not found.' });
      await takeDown(r, 'organizer', req.body.note); res.json({ ok: true });
    } catch (e) { console.error('evalroom organizer wall remove error:', e.message); res.status(502).json({ error: 'That could not be removed. Please try again.' }); }
  });
};
module.exports._internal = { toJpeg, vimeoUpload, wallDomains };
