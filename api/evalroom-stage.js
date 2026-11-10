/**
 * TopKpop.io — The Evaluation Room: Take the Stage.
 *
 * A team picks one of its rehearsals and locks it as the official score for
 * that Trove. The score they saw is the score they keep. A lock is final for
 * the team; the organizer can reset one from the organizer page.
 *
 * On the preview copy, locks are recorded as practice locks and never touch
 * the official submissions or the leaderboard.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { checkSong, normalizeSongUrl } = require('./evalroom-song');

const SONG_BONUS = 10;       // Trove 02: a verified song made from the locked lyrics
const DANCE_BONUS = 10;      // Trove 03: a dance video link (same rule as the current submit page)
const TROVE_OF = { visual: 1, lyric: 2, lesson: 3 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SONG_MESSAGES = {
  'bad-link': 'That is not a Suno song link. In Suno, open your song, tap Share, and copy the link. It looks like suno.com/s/... or suno.com/song/...',
  'not-found': 'That Suno link did not open as a song. In Suno, check the song is set to Link Only or Public, then copy the link again.',
  mismatch: 'That song does not use the lyrics you locked. Make the song in Suno with your locked lyrics pasted in Custom mode, then paste that song\'s link.',
  unreadable: 'Suno could not be reached to check your song just now. Your link has not been used. Please try again in a few minutes.',
  reused: 'That song link has already been turned in by a team. Each team needs its own song.',
};

function cleanUrl(v, max = 400) {
  const s = String(v || '').trim();
  if (!s) return null;
  try { const u = new URL(s); if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined; return u.toString().slice(0, max); } catch (_) { return undefined; }
}

module.exports = function attachStage(router, deps) {
  const { supabase, JUDGES, PREVIEW_MODE, requireTeam, uploadTwo, limited, clientIp, sniffImage } = deps;

  const lockView = (l) => l && ({
    id: l.id, trove: l.trove, judge: l.judge, score: l.score, max: l.max_score, bonus: l.bonus, total: l.score + l.bonus,
    bonus_reason: l.bonus_reason, song_url: l.song_url, song_title: l.song_check && l.song_check.title, embed_url: l.song_check && l.song_check.embedUrl,
    dance_video_url: l.dance_video_url, locked_at: l.locked_at, practice: l.is_preview, rehearsal_id: l.rehearsal_id,
  });

  async function activeLock(teamKey, trove) {
    const { data, error } = await supabase.from('evalroom_locks').select('*').eq('team_key', teamKey).eq('trove', trove).is('reset_at', null).limit(1);
    if (error) throw new Error(error.message);
    return data && data[0];
  }

  async function songTaken(canonical, exceptLockId) {
    let q = supabase.from('evalroom_locks').select('id').ilike('song_url', canonical.replace(/[\\%_]/g, (c) => '\\' + c)).is('reset_at', null).limit(1);
    if (exceptLockId) q = q.neq('id', exceptLockId);
    const { data } = await q;
    return !!(data && data.length);
  }

  // Checks a song against locked lyrics. Returns { ok, message, check, canonical }.
  async function verifySong(url, lyrics, exceptLockId) {
    const n = normalizeSongUrl(url);
    if (!n.ok) return { ok: false, verdict: 'bad-link', message: SONG_MESSAGES['bad-link'] };
    const check = await checkSong(url, lyrics);
    if (check.verdict !== 'verified') return { ok: false, verdict: check.verdict, message: SONG_MESSAGES[check.verdict] || SONG_MESSAGES.unreadable, check };
    if (await songTaken(check.canonical, exceptLockId)) return { ok: false, verdict: 'reused', message: SONG_MESSAGES.reused, check };
    return { ok: true, verdict: 'verified', check, canonical: check.canonical };
  }

  // ── Official record (live site only) ───────────────────────────────────────
  const isRegisteredTeam = (team) => !team.preview && UUID.test(team.key);
  const isPractice = (team) => PREVIEW_MODE || !isRegisteredTeam(team);

  async function writeOfficial(team, lock, files) {
    const payload = {
      team_id: team.key, team_name: team.name, trove_number: lock.trove,
      notes: ['Locked in The Evaluation Room', 'Rehearsal ' + lock.rehearsal_id, lock.song_url ? 'Song: ' + lock.song_url : null, lock.dance_video_url ? 'Dance Video: ' + lock.dance_video_url : null].filter(Boolean).join(' | '),
      oracle_score: lock.score, final_score: lock.score, scored_at: new Date().toISOString(),
      bonus_score: lock.bonus || 0,
    };
    if (lock.bonus) { payload.bonus_awarded_at = new Date().toISOString(); payload.bonus_awarded_by = lock.bonus_reason; }
    if (lock.instagram_post_url) payload.instagram_post_url = lock.instagram_post_url;
    for (const [i, f] of (files || []).entries()) {
      const name = `trove-${lock.trove}/${team.key}/${Date.now()}_${String(f.originalname || 'file').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const { error } = await supabase.storage.from('submissions').upload(name, f.buffer, { contentType: f.mimetype, upsert: false });
      if (error) throw new Error('upload: ' + error.message);
      payload[`file${i + 1}_url`] = supabase.storage.from('submissions').getPublicUrl(name).data.publicUrl;
      payload[`file${i + 1}_name`] = f.originalname;
    }
    const { data, error } = await supabase.from('submissions').upsert(payload, { onConflict: 'team_id,trove_number' }).select('id').single();
    if (error) throw new Error('submission: ' + error.message);
    return data.id;
  }

  // Receipt: the same confirmation email the Trove pages send. Sent only on the live site,
  // and only when RESEND_API_KEY is set as a Railway variable.
  async function sendReceipt(team, lock) {
    if (PREVIEW_MODE || !process.env.RESEND_API_KEY) return false;
    try {
      const { data: reg } = await supabase.from('registrations').select('captain_email').eq('id', team.key).single();
      if (!reg || !reg.captain_email) return false;
      const tpl = { 1: 'email2_trove01.html', 2: 'email3_trove02.html', 3: 'email4_trove03.html' }[lock.trove];
      const subject = { 1: '🔍 Trove 01 Confirmed — Identity Locked In', 2: '🎵 Trove 02 Confirmed — Evidence Song Received', 3: '🕵️ Trove 03 Confirmed — Final Evidence Secured' }[lock.trove];
      let html = fs.readFileSync(path.join(__dirname, '..', 'pages', 'emails', tpl), 'utf8');
      const scoreStr = `${lock.score}/${lock.max_score}` + (lock.bonus ? ` + ${lock.bonus} bonus` : '');
      html = html.split('*SCORE*').join(scoreStr).split('[TEAM_NAME]').join(team.name || '');
      const { Resend } = require('resend');
      const { error } = await new Resend(process.env.RESEND_API_KEY).emails.send({ from: 'Detective Anna Im - TopKpop.io <anna@topkpop.io>', to: [reg.captain_email], subject, html });
      if (error) { console.error('evalroom receipt error:', error.message || error); return false; }
      return true;
    } catch (err) { console.error('evalroom receipt error:', err.message); return false; }
  }

  // ── Team routes ────────────────────────────────────────────────────────────
  router.get('/stage', requireTeam, async (req, res) => {
    try {
      const { data, error } = await supabase.from('evalroom_locks').select('*').eq('team_key', req.team.key).is('reset_at', null);
      if (error) throw new Error(error.message);
      const locks = {};
      for (const l of data || []) locks[l.judge] = lockView(l);
      res.json({ locks, practice: isPractice(req.team), songBonus: SONG_BONUS, danceBonus: DANCE_BONUS });
    } catch (err) { console.error('evalroom stage error:', err.message); res.status(500).json({ error: 'Could not load your official scores. Please try again.' }); }
  });

  // Try a song link before locking (nothing is saved).
  router.post('/stage/check-song', requireTeam, async (req, res) => {
    try {
      if (limited('song:' + req.team.key, 8, 60000)) return res.status(429).json({ error: 'That is a lot of checks in one minute. Try again shortly.' });
      const rid = String((req.body && req.body.rehearsal_id) || '');
      if (!UUID.test(rid)) return res.status(400).json({ error: 'Choose a rehearsal first.' });
      const { data: r } = await supabase.from('evalroom_rehearsals').select('input_text').eq('id', rid).eq('team_key', req.team.key).eq('judge', 'lyric').eq('ok', true).single();
      if (!r) return res.status(404).json({ error: 'That rehearsal was not found.' });
      const v = await verifySong(req.body.song_url, r.input_text);
      res.json({ ok: v.ok, verdict: v.verdict, message: v.ok ? 'Song confirmed. It matches these lyrics.' : v.message, title: v.check && v.check.title, embed_url: v.ok ? v.check.embedUrl : null, match: v.check && v.check.match });
    } catch (err) { console.error('evalroom check-song error:', err.message); res.status(502).json({ error: SONG_MESSAGES.unreadable }); }
  });

  // Lock a rehearsal as the official score.
  router.post('/stage/:judge', requireTeam, uploadTwo, async (req, res) => {
    const j = JUDGES[req.params.judge];
    if (!j) return res.status(404).json({ error: 'No such judge.' });
    const trove = TROVE_OF[j.key];
    try {
      if (limited('stage:' + req.team.key, 15, 60000)) return res.status(429).json({ error: 'Too many tries in one minute. Please wait a moment.' });
      const b = req.body || {};
      if (String(b.confirm) !== 'true') return res.status(400).json({ error: 'Tick the box to confirm your team is ready. A lock is final.' });
      const rid = String(b.rehearsal_id || '');
      if (!UUID.test(rid)) return res.status(400).json({ error: 'Choose the rehearsal you want to lock.' });

      const { data: r } = await supabase.from('evalroom_rehearsals').select('id, score, max_score, input_text, input_meta').eq('id', rid).eq('team_key', req.team.key).eq('judge', j.key).eq('ok', true).single();
      if (!r) return res.status(404).json({ error: 'That rehearsal was not found for your team.' });

      const existing = await activeLock(req.team.key, trove);
      if (existing) return res.status(409).json({ error: `Your team already locked its official score for Trove 0${trove}. A lock is final.`, lock: lockView(existing) });

      const practice = isPractice(req.team);
      if (!practice) {
        const { data: sub } = await supabase.from('submissions').select('id').eq('team_id', req.team.key).eq('trove_number', trove).limit(1);
        if (sub && sub.length) return res.status(409).json({ error: `Your team already has an official submission for Trove 0${trove}. If that is a mistake, contact the organizer.` });
      }

      // Trove 01: the same two pictures, so the official record holds the work that earned the score.
      let files = [];
      if (j.input === 'images') {
        const a = req.files && req.files.avatar && req.files.avatar[0];
        const p = req.files && req.files.poster && req.files.poster[0];
        if (!a || !p || !sniffImage(a.buffer) || !sniffImage(p.buffer)) return res.status(400).json({ error: 'To lock this score, choose the same avatar and poster pictures you rehearsed with.' });
        const fp = crypto.createHash('sha256').update(a.buffer).update('|').update(p.buffer).digest('hex');
        if (fp !== (r.input_meta && r.input_meta.fingerprint)) return res.status(400).json({ error: 'Those are not the same pictures this rehearsal was scored on. Choose the exact pictures you rehearsed with, or rehearse the new ones first.' });
        files = [a, p];
      }

      const lock = {
        team_key: req.team.key, team_name: req.team.name, trove, judge: j.key, rehearsal_id: r.id,
        score: r.score, max_score: r.max_score, bonus: 0, bonus_reason: null, is_preview: practice,
      };
      const insta = cleanUrl(b.instagram_post_url);
      if (insta === undefined) return res.status(400).json({ error: 'The Instagram link does not look like a web address. Fix it or leave it blank.' });
      if (insta) lock.instagram_post_url = insta;

      // Trove 02: optional song link, checked before anything is locked.
      if (j.key === 'lyric' && String(b.song_url || '').trim()) {
        const v = await verifySong(b.song_url, r.input_text);
        if (!v.ok) return res.status(400).json({ error: v.message + ' Nothing was locked.', song: v.verdict });
        lock.song_url = v.canonical; lock.song_check = v.check; lock.bonus = SONG_BONUS; lock.bonus_reason = 'auto-song-link';
      }
      // Trove 03: optional dance video link (+10, same rule as today).
      if (j.key === 'lesson' && String(b.dance_video_url || '').trim()) {
        const d = cleanUrl(b.dance_video_url);
        if (!d) return res.status(400).json({ error: 'The dance video link does not look like a web address. Fix it or leave it blank.' });
        lock.dance_video_url = d; lock.bonus = DANCE_BONUS; lock.bonus_reason = 'auto-dance-video';
      }

      const { data: saved, error: insErr } = await supabase.from('evalroom_locks').insert(lock).select('*').single();
      if (insErr) {
        if (insErr.code === '23505') {
          const msg = /song_once/.test(insErr.message) ? SONG_MESSAGES.reused : `Your team already locked its official score for Trove 0${trove}.`;
          return res.status(409).json({ error: msg });
        }
        throw new Error(insErr.message);
      }

      let emailed = false;
      if (!practice) {
        try {
          const subId = await writeOfficial(req.team, saved, files);
          await supabase.from('evalroom_locks').update({ submission_id: subId }).eq('id', saved.id);
        } catch (err) {
          // The official record could not be written: undo the lock so the team can try again.
          await supabase.from('evalroom_locks').delete().eq('id', saved.id);
          throw err;
        }
        emailed = await sendReceipt(req.team, saved);
      }
      res.json({ ok: true, lock: lockView(saved), practice, emailed });
    } catch (err) {
      console.error('evalroom lock error:', err.message);
      res.status(502).json({ error: 'The lock did not go through. Nothing was changed. Please try again.' });
    }
  });

  // Trove 02: add the song after the lyrics are locked (once).
  router.post('/stage/lyric/song', requireTeam, async (req, res) => {
    try {
      if (limited('song:' + req.team.key, 8, 60000)) return res.status(429).json({ error: 'That is a lot of checks in one minute. Try again shortly.' });
      const lock = await activeLock(req.team.key, 2);
      if (!lock) return res.status(404).json({ error: 'Lock your lyrics first, then add your song.' });
      if (lock.song_url) return res.status(409).json({ error: 'Your team already turned in its song.', lock: lockView(lock) });
      const { data: r } = await supabase.from('evalroom_rehearsals').select('input_text').eq('id', lock.rehearsal_id).single();
      const v = await verifySong(req.body && req.body.song_url, r && r.input_text, lock.id);
      if (!v.ok) return res.status(400).json({ error: v.message, song: v.verdict });
      const { data: saved, error } = await supabase.from('evalroom_locks')
        .update({ song_url: v.canonical, song_check: v.check, bonus: SONG_BONUS, bonus_reason: 'auto-song-link' }).eq('id', lock.id).is('song_url', null).select('*').single();
      if (error) return res.status(409).json({ error: error.code === '23505' ? SONG_MESSAGES.reused : 'The song could not be added. Please try again.' });
      if (!lock.is_preview && lock.submission_id) {
        const { error: subErr } = await supabase.from('submissions').update({ bonus_score: SONG_BONUS, bonus_awarded_at: new Date().toISOString(), bonus_awarded_by: 'auto-song-link' }).eq('id', lock.submission_id);
        if (subErr) console.error('evalroom song bonus save error:', subErr.message);
      }
      res.json({ ok: true, lock: lockView(saved) });
    } catch (err) { console.error('evalroom add-song error:', err.message); res.status(502).json({ error: SONG_MESSAGES.unreadable }); }
  });

  // ── Organizer routes ───────────────────────────────────────────────────────
  function requireOrganizer(req, res, next) {
    if (limited('organizer:' + clientIp(req), 10, 15 * 60000)) return res.status(429).json({ error: 'Too many tries. Please wait 15 minutes.' });
    const given = crypto.createHash('sha256').update(String(req.headers['x-organizer-password'] || '')).digest();
    const real = crypto.createHash('sha256').update(String(process.env.ADMIN_PASSWORD || '')).digest();
    if (!process.env.ADMIN_PASSWORD || !crypto.timingSafeEqual(given, real)) return res.status(401).json({ error: 'That password is not right.' });
    next();
  }

  router.get('/organizer/locks', requireOrganizer, async (req, res) => {
    const { data, error } = await supabase.from('evalroom_locks').select('*').order('locked_at', { ascending: false }).limit(500);
    if (error) return res.status(500).json({ error: 'Could not load the locks.' });
    res.json({ preview: PREVIEW_MODE, locks: (data || []).map((l) => ({ ...lockView(l), team_name: l.team_name, reset_at: l.reset_at, reset_note: l.reset_note })) });
  });

  router.post('/organizer/reset', requireOrganizer, async (req, res) => {
    try {
      const id = String((req.body && req.body.lock_id) || '');
      if (!UUID.test(id)) return res.status(400).json({ error: 'Choose a lock to reset.' });
      const { data: lock } = await supabase.from('evalroom_locks').select('*').eq('id', id).is('reset_at', null).single();
      if (!lock) return res.status(404).json({ error: 'That lock was not found or is already reset.' });
      const note = String((req.body && req.body.note) || '').slice(0, 300);
      const { error } = await supabase.from('evalroom_locks').update({ reset_at: new Date().toISOString(), reset_note: note || null }).eq('id', id);
      if (error) throw new Error(error.message);
      // On the live site, take the official entry off the leaderboard so the team can lock again.
      if (!lock.is_preview && lock.submission_id) {
        const { error: delErr } = await supabase.from('submissions').delete().eq('id', lock.submission_id);
        if (delErr) console.error('evalroom reset: submission delete error:', delErr.message);
      }
      res.json({ ok: true });
    } catch (err) { console.error('evalroom reset error:', err.message); res.status(500).json({ error: 'The reset did not go through. Please try again.' }); }
  });
};
