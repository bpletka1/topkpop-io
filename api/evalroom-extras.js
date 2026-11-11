/**
 * TopKpop.io — The Evaluation Room: extra tasks a team turns in after it has taken the stage.
 *
 *   Trove 01  Team Name Lore        the team types its 2 to 4 sentence origin story        (+25)
 *   Trove 02  Avatar Performance    a video (file or link) of the avatar performing the song (+25)
 *   Trove 02  Karaoke video         a karaoke video made outside the room, turned in as the
 *                                   team's one song                                          (+10)
 *
 * The room only checks that something real was turned in. It does not judge quality.
 * Points are added by themselves, once. The organizer is emailed about each one and can remove it,
 * which takes the points back.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const BUCKET = 'evalroom-private';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MB = Number(process.env.EVALROOM_EXTRA_MAX_MB || 80);
const EXTRA_BONUS = Number(process.env.EVALROOM_EXTRA_BONUS || 25);
const SONG_BONUS = 10;

const KINDS = {
  'lore': { trove: 1, bonus: EXTRA_BONUS, tag: 'lore', name: 'Team Name Lore', what: 'their team name story (Trove 01)' },
  'avatar-performance': { trove: 2, bonus: EXTRA_BONUS, tag: 'avatar-performance', name: 'Avatar Performance', what: 'their avatar performance video (Trove 02)' },
  'karaoke-video': { trove: 2, bonus: SONG_BONUS, tag: 'auto-video-song', name: 'Karaoke video', what: 'a karaoke video made outside the room as their song (Trove 02)', isSong: true },
};

function ffmpegPath() { try { return require('ffmpeg-static'); } catch (e) { return null; } }
/** MP4, MOV and M4V files carry "ftyp" near the start; WebM starts with its own four bytes. A picture has neither. */
function looksLikeVideoFile(buf) {
  if (!buf || buf.length < 16) return false;
  return buf.slice(4, 8).toString('latin1') === 'ftyp' || (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3);
}
/** True when the file really is a video that can be played. */
function isVideo(buf) {
  return new Promise((resolve) => {
    const bin = ffmpegPath(); if (!bin || !looksLikeVideoFile(buf)) return resolve(false);
    let dir = null;
    const done = (ok) => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); resolve(ok); };
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'erextra-'));
      fs.writeFileSync(path.join(dir, 'in'), buf);
      const p = spawn(bin, ['-hide_banner', '-v', 'error', '-i', 'in', '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'], { cwd: dir, stdio: 'ignore' });
      const t = setTimeout(() => { p.kill('SIGKILL'); }, 30000);
      p.on('error', () => { clearTimeout(t); done(false); });
      p.on('close', (c) => { clearTimeout(t); done(c === 0); });
    } catch (_) { done(false); }
  });
}
function cleanLink(v) {
  const s = String(v || '').trim(); if (!s) return null;
  try { const u = new URL(s); if (u.protocol !== 'https:') return undefined; if (!u.hostname.includes('.')) return undefined; return u.toString().slice(0, 400); } catch (_) { return undefined; }
}
/** Counts sentences well enough to tell "one line" from "a short story". */
function sentences(text) { return String(text).split(/[.!?。！？]+(?:\s+|$)/).map((x) => x.trim()).filter((x) => x.split(/\s+/).length >= 2).length; }

module.exports = function attachExtras(router, deps) {
  const { supabase, requireTeam, requireOrganizer, limited, activeLock, LOCKS, PREVIEW_MODE, multer, changeBonus, tellOrganizer, retireWallSong } = deps;
  const mine = (q) => q.eq('is_preview', PREVIEW_MODE);
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 1, fields: 6, fieldSize: 4000 } });
  const oneFile = (req, res, next) => upload.single('file')(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `That video is larger than ${MAX_MB} MB. Put it on YouTube or Google Drive and paste the link instead.` : 'That file could not be read. Please try again.' });
  });

  const view = (r, full, fileUrl) => r && KINDS[r.kind] && ({
    id: r.id, kind: r.kind, trove: r.trove, name: KINDS[r.kind].name, bonus: r.bonus, when: r.created_at, text: r.body || null, link: r.link || null, hasFile: !!r.file_path,
    ...(full ? { team: r.team_name, fileUrl: fileUrl || null, removedAt: r.removed_at, removedBy: r.removed_by, note: r.removed_note, practice: r.is_preview } : {}),
  });

  async function current(teamKey) {
    const { data } = await mine(supabase.from('evalroom_extras').select('*')).eq('team_key', teamKey).eq('status', 'ready').is('removed_at', null);
    return Object.fromEntries((data || []).map((r) => [r.kind, r]));
  }

  async function notify(row) {
    const k = KINDS[row.kind];
    const esc = (x) => String(x || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return tellOrganizer({
      subject: `Extra task: ${row.team_name} turned in ${k.name}`,
      lead: `<b>${esc(row.team_name)}</b> turned in ${k.what}.`,
      detail: (row.body ? `<p style="border-left:3px solid #e6005c;padding-left:12px">${esc(row.body)}</p>` : '') + (row.link ? `<p>Link they gave: ${esc(row.link)}</p>` : '') + `<p>${row.bonus} points were added by themselves. The room checked that something was turned in. It did not judge the quality.</p>`,
      link: `/pages/evaluation-room/organizer/?extra=${row.id}`,
    });
  }

  /** Take one extra task away. Only the first caller does it, so the points come off once. */
  async function takeDown(r, by, note, keepBonus) {
    const { data: claimed, error } = await supabase.from('evalroom_extras').update({ status: 'removed', removed_at: new Date().toISOString(), removed_by: by, removed_note: note ? String(note).slice(0, 300) : null })
      .eq('id', r.id).is('removed_at', null).select('*');
    if (error) throw new Error(error.message);
    if (!claimed || !claimed.length) return false;
    const row = claimed[0]; const k = KINDS[row.kind];
    if (!keepBonus && row.lock_id) {
      try {
        if (row.bonus) await changeBonus(row.lock_id, -row.bonus, k.tag);
        if (k.isSong) {
          await supabase.from(LOCKS).update({ song_url: null, song_check: null }).eq('id', row.lock_id).eq('song_url', 'room:upload:' + row.id);
          // If this video was also shared on the wall, that copy and its sharing points go too.
          await retireWallSong(row.lock_id, by, note || 'The karaoke video was removed.').catch((e) => console.error('evalroom extras wall retire:', e.message));
        }
      } catch (e) {
        await supabase.from('evalroom_extras').update({ status: 'ready', removed_at: null, removed_by: null, removed_note: null }).eq('id', r.id);
        throw new Error('bonus undo: ' + e.message);
      }
    }
    if (row.file_path) { const rm = await supabase.storage.from(BUCKET).remove([row.file_path]); if (rm.error) console.error('evalroom extras file delete:', rm.error.message); }
    await supabase.from('evalroom_extras').update({ file_path: null, bonus: 0 }).eq('id', r.id);
    return true;
  }
  async function retireForLock(lockId, by, note) {
    const { data } = await supabase.from('evalroom_extras').select('*').eq('lock_id', lockId).is('removed_at', null);
    for (const r of data || []) await takeDown(r, by, note, true).catch((e) => console.error('evalroom extras retire:', e.message));
  }

  // ── What this team can still turn in ──
  router.get('/extras', requireTeam, async (req, res) => {
    try {
      const [l1, l2, have] = await Promise.all([activeLock(req.team.key, 1), activeLock(req.team.key, 2), current(req.team.key)]);
      // Anything left over from an entry the organizer has reset no longer counts.
      const live = (kind, lock) => (have[kind] && lock && have[kind].lock_id === lock.id ? view(have[kind]) : null);
      res.json({ maxMb: MAX_MB, practice: PREVIEW_MODE,
        lore: { locked: !!l1, bonus: KINDS.lore.bonus, item: live('lore', l1) },
        avatarPerformance: { locked: !!l2, bonus: KINDS['avatar-performance'].bonus, item: live('avatar-performance', l2) },
        karaokeVideo: { locked: !!l2, bonus: KINDS['karaoke-video'].bonus, hasSong: !!(l2 && l2.song_url), item: live('karaoke-video', l2) } });
    } catch (e) { console.error('evalroom extras list error:', e.message); res.status(500).json({ error: 'This could not be loaded. Please try again.' }); }
  });

  /** Shared by both turn-in routes: save the row, add the points, tell the organizer. */
  async function turnIn(req, res, kind, lock, fields, file) {
    const k = KINDS[kind]; let row = null; let filePath = null; let pointsIn = false; let songSet = false;
    try {
      // Clear anything this team left from an entry that has since been reset.
      const { data: old } = await mine(supabase.from('evalroom_extras').select('*')).eq('team_key', req.team.key).eq('kind', kind).is('removed_at', null).neq('status', 'failed').neq('lock_id', lock.id);
      for (const o of old || []) await takeDown(o, 'reset', 'The locked entry was reset.', true);
      await mine(supabase.from('evalroom_extras').update({ status: 'failed', error: 'did not finish' })).eq('team_key', req.team.key).eq('kind', kind).eq('status', 'processing').lt('created_at', new Date(Date.now() - 10 * 60000).toISOString());
      if (limited('extra:' + req.team.key, 8, 10 * 60000)) return res.status(429).json({ error: 'That is a lot of turning in for a few minutes. Please wait a little and try again.' });
      const ins = await supabase.from('evalroom_extras').insert({ team_key: req.team.key, team_name: req.team.name, trove: k.trove, kind, lock_id: lock.id, status: 'processing', is_preview: PREVIEW_MODE, ...fields }).select('*').single();
      if (ins.error) return res.status(409).json({ error: ins.error.code === '23505' ? 'Your team already turned this in.' : 'That could not be turned in. Please try again.' });
      row = ins.data;
      const patch = {};
      if (file) {
        filePath = `extras/${row.id}/video.${file.ext}`;
        const up = await supabase.storage.from(BUCKET).upload(filePath, file.buffer, { contentType: file.mime, upsert: true });
        if (up.error) throw new Error('storage: ' + up.error.message);
        patch.file_path = filePath; patch.file_type = file.mime;
      }
      if (k.isSong) {
        // A team turns in one song. This claims that one place.
        const { data: got, error } = await supabase.from(LOCKS).update({ song_url: 'room:upload:' + row.id, song_check: { verdict: 'turned-in', room: 'upload', title: fields.body || 'Karaoke video', canonical: 'room:upload:' + row.id } }).eq('id', lock.id).is('song_url', null).select('id');
        if (error || !got || !got.length) throw Object.assign(new Error('song already turned in'), { friendly: 'Your team already turned in its song.', status: 409 });
        songSet = true;
      }
      pointsIn = await changeBonus(lock.id, k.bonus, k.tag);
      patch.status = 'ready'; patch.bonus = pointsIn ? k.bonus : 0;
      const { data: done, error: e3 } = await supabase.from('evalroom_extras').update(patch).eq('id', row.id).eq('status', 'processing').select('*').single();
      if (e3 || !done) throw new Error((e3 && e3.message) || 'turn-in was cancelled');
      row = null;
      const emailed = await notify(done).catch(() => false);
      res.json({ ok: true, bonus: done.bonus, item: view(done), emailed });
    } catch (e) {
      console.error('evalroom extras turn-in error:', e.message);
      if (row) {
        if (pointsIn) await changeBonus(lock.id, -k.bonus, k.tag).catch((x) => console.error('evalroom extras undo points:', x.message));
        if (songSet) await supabase.from(LOCKS).update({ song_url: null, song_check: null }).eq('id', lock.id).eq('song_url', 'room:upload:' + row.id);
        if (filePath) await supabase.storage.from(BUCKET).remove([filePath]).catch(() => {});
        await supabase.from('evalroom_extras').update({ status: 'failed', error: String(e.message).slice(0, 300), file_path: null }).eq('id', row.id);
      }
      if (res.headersSent) return;
      res.status(e.status || 502).json({ error: e.friendly || 'That could not be turned in this time. Nothing was changed. Please try again.' });
    }
  }

  // ── Trove 01: Team Name Lore ──
  router.post('/extras/lore', requireTeam, async (req, res) => {
    const text = String((req.body && req.body.text) || '').replace(/\s+/g, ' ').trim();
    const n = sentences(text);
    if (text.length < 40 || n < 2) return res.status(400).json({ error: 'Write 2 to 4 sentences telling the story behind your team name.' });
    if (text.length > 900 || n > 5) return res.status(400).json({ error: 'That is longer than a short story. Keep it to 2 to 4 sentences.' });
    const lock = await activeLock(req.team.key, 1).catch(() => null);
    if (!lock) return res.status(404).json({ error: 'Take the Stage with your avatar and poster first. Then turn in your team name story.' });
    return turnIn(req, res, 'lore', lock, { body: text });
  });

  // ── Trove 02: a video, as a file or a link ──
  router.post('/extras/video', requireTeam, oneFile, async (req, res) => {
    const b = req.body || {}; const kind = String(b.kind || '');
    if (kind !== 'avatar-performance' && kind !== 'karaoke-video') return res.status(400).json({ error: 'Choose what you are turning in.' });
    const link = cleanLink(b.link);
    if (link === undefined) return res.status(400).json({ error: 'That link does not look like a web address. It should start with https://' });
    if (!req.file && !link) return res.status(400).json({ error: 'Choose your video file, or paste a link to it.' });
    if (req.file && link) return res.status(400).json({ error: 'Give the video file or the link, not both.' });
    const lock = await activeLock(req.team.key, 2).catch(() => null);
    if (!lock) return res.status(404).json({ error: 'Take the Stage with your lyrics first. Then turn in your video.' });
    if (kind === 'karaoke-video' && lock.song_url) return res.status(409).json({ error: 'Your team already turned in its song.' });
    let file = null;
    if (req.file) {
      if (limited('extracheck:' + req.team.key, 6, 10 * 60000)) return res.status(429).json({ error: 'That is a lot of uploads for a few minutes. Please wait a little and try again.' });
      if (!(await isVideo(req.file.buffer))) return res.status(400).json({ error: 'That file is not a video the room can play. Save it as MP4 and try again.' });
      const ext = (String(req.file.originalname || '').toLowerCase().match(/\.(mp4|mov|m4v|webm)$/) || [null, 'mp4'])[1];
      file = { buffer: req.file.buffer, ext, mime: ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : 'video/mp4' };
    }
    const title = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return turnIn(req, res, kind, lock, { link: link || null, body: title || null }, file);
  });

  // ── Organizer ──
  router.get('/organizer/extras', requireOrganizer, async (req, res) => { try {
    const [up, down] = await Promise.all([
      mine(supabase.from('evalroom_extras').select('*')).is('removed_at', null).eq('status', 'ready').order('created_at', { ascending: false }).limit(400),
      mine(supabase.from('evalroom_extras').select('*')).not('removed_at', 'is', null).order('removed_at', { ascending: false }).limit(100),
    ]);
    if (up.error || down.error) return res.status(500).json({ error: 'Could not load the extra tasks.' });
    const rows = (up.data || []).concat(down.data || []);
    const paths = rows.filter((r) => r.file_path).map((r) => r.file_path); const urls = {};
    if (paths.length) { const { data } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600); for (const d of data || []) if (d && d.signedUrl) urls[d.path] = d.signedUrl; }
    res.json({ items: rows.map((r) => view(r, true, urls[r.file_path])).filter(Boolean) });
  } catch (e) { console.error('evalroom organizer extras list error:', e.message); res.status(500).json({ error: 'Could not load the extra tasks.' }); } });
  router.post('/organizer/extras/remove', requireOrganizer, async (req, res) => {
    try {
      const id = String((req.body && req.body.id) || ''); if (!UUID.test(id)) return res.status(404).json({ error: 'Not found.' });
      const { data: r } = await mine(supabase.from('evalroom_extras').select('*')).eq('id', id).single();
      if (!r || r.removed_at || !(await takeDown(r, 'organizer', req.body.note))) return res.status(404).json({ error: 'Not found, or already removed.' });
      res.json({ ok: true });
    } catch (e) { console.error('evalroom organizer extras remove error:', e.message); res.status(502).json({ error: 'That could not be removed. Please try again.' }); }
  });

  return { retireForLock };
};
module.exports._internal = { sentences, cleanLink, isVideo, KINDS };
