/**
 * TopKpop.io — The Evaluation Room: Song Maker (karaoke).
 *
 * A team uploads an English song they own. The room:
 *   1. splits it into the singing and the music            (ElevenLabs stem separation)
 *   2. times the ORIGINAL lyrics to the singing            (ElevenLabs forced alignment)
 *   3. hands those timings to the team's NEW lyrics, line for line
 *   4. plays the music with the new lyrics lighting up in time
 *
 * Audio is kept in private storage and only the team that made it can play it.
 */
const { unzipSync } = require('fflate');

const API = 'https://api.elevenlabs.io';
const BUCKET = 'evalroom-private';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MB = Number(process.env.EVALROOM_SONG_MAX_MB || 25);
const MAX_PER_DAY = Number(process.env.EVALROOM_SONGS_PER_DAY || 3);            // finished songs per team per day
const MAX_TRIES_PER_DAY = Number(process.env.EVALROOM_SONG_TRIES_PER_DAY || 6);   // every upload counts, working or not
const MAX_ALL_TEAMS_PER_DAY = Number(process.env.EVALROOM_SONGS_ALL_TEAMS_PER_DAY || 60); // whole room, protects the audio budget
const LOSS_WARN = Number(process.env.EVALROOM_ALIGN_LOSS_WARN || 2.2);            // above this the lyrics probably do not match the recording
const MAX_AT_ONCE = Number(process.env.EVALROOM_SONGS_AT_ONCE || 2);
const STEMS = process.env.EVALROOM_STEM_VARIATION || 'two_stems_v1';
const safePart = (x) => String(x).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);

// ── What kind of audio file is this? (checked by content, not by name) ───────
function sniffAudio(buf) {
  if (!buf || buf.length < 20000) return null; // even a short song is far bigger than this
  const s4 = buf.slice(0, 4).toString('latin1');
  if (s4 === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WAVE') return { mime: 'audio/wav', ext: 'wav' };
  const mp3Frame = (i) => i + 1 < buf.length && buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0 && [0x02, 0x04].includes(buf[i + 1] & 0x06) && (buf[i + 2] & 0xf0) !== 0xf0 && (buf[i + 2] & 0x0c) !== 0x0c;
  if (s4.slice(0, 3) === 'ID3') {
    // Skip the tag and make sure real MP3 audio follows it.
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    for (let i = 10 + size, n = 0; i < buf.length - 1 && n < 4096; i++, n++) if (mp3Frame(i)) return { mime: 'audio/mpeg', ext: 'mp3' };
    return null;
  }
  if (mp3Frame(0)) return { mime: 'audio/mpeg', ext: 'mp3' };
  if (buf.slice(4, 8).toString('latin1') === 'ftyp') return { mime: 'audio/mp4', ext: 'm4a' };
  if (s4 === 'fLaC') return { mime: 'audio/flac', ext: 'flac' };
  if (s4 === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' };
  return null;
}

// ── ElevenLabs calls ─────────────────────────────────────────────────────────
function elevenKey() {
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new Error('The song maker is not switched on yet (no ElevenLabs key).');
  return k;
}
async function elevenError(res) {
  let body = ''; try { body = (await res.text()).slice(0, 600); } catch (_) {}
  const err = new Error(`ElevenLabs ${res.status}: ${body}`); err.status = res.status; return err;
}

/** Split a song. Returns { instrumental: {buf, mime, ext}, vocals: {buf, mime, ext}, names: [...] }. */
async function separate(buf, kind, variation = STEMS) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: kind.mime }), 'song.' + kind.ext);
  if (variation) form.append('stem_variation_id', variation);
  const res = await fetch(`${API}/v1/music/stem-separation`, { method: 'POST', headers: { 'xi-api-key': elevenKey() }, body: form, signal: AbortSignal.timeout(280000) });
  if (!res.ok) throw await elevenError(res);
  const type = res.headers.get('content-type') || '';
  const data = Buffer.from(await res.arrayBuffer());
  const out = { names: [], contentType: type, bytes: data.length };
  const isZip = data.length > 4 && data[0] === 0x50 && data[1] === 0x4b;
  if (!isZip) throw new Error('The splitter returned something unexpected (' + type + ').');
  const files = unzipSync(new Uint8Array(data));
  const stems = [];
  for (const [name, bytes] of Object.entries(files)) {
    const b = Buffer.from(bytes); const k = sniffAudio(b);
    out.names.push(name + ' (' + b.length + ')');
    if (k) stems.push({ name: name.toLowerCase(), buf: b, ...k });
  }
  const vocals = stems.find((s) => /vocal|voice|sing/.test(s.name) && !/no[_ -]?vocal|instrumental|backing/.test(s.name));
  const instrumental = stems.find((s) => /instrumental|no[_ -]?vocal|accompaniment|backing|music|karaoke|other/.test(s.name) && s !== vocals) || stems.find((s) => s !== vocals);
  if (!vocals || !instrumental) throw new Error('The splitter did not return a vocals track and a music track: ' + out.names.join(', '));
  if (stems.length > 2) out.note = 'more than two stems returned; using ' + instrumental.name;
  return { ...out, vocals, instrumental };
}

/** Time known words against a recording. Returns { words: [{text,start,end,loss}], loss }. */
async function align(buf, kind, text) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: kind.mime }), 'vocals.' + kind.ext);
  form.append('text', text);
  const res = await fetch(`${API}/v1/forced-alignment`, { method: 'POST', headers: { 'xi-api-key': elevenKey() }, body: form, signal: AbortSignal.timeout(240000) });
  if (!res.ok) throw await elevenError(res);
  const j = await res.json();
  return { words: (j.words || []).filter((w) => String(w.text || '').trim()), loss: j.loss };
}

// ── Lyrics and timing ────────────────────────────────────────────────────────
const lyricLines = (t) => String(t || '').replace(/\r/g, '').split('\n').map((l) => l.trim())
  .filter((l) => l && !/^\[[^\]]*\]$/.test(l) && !/^(verse|chorus|bridge|intro|outro|pre-chorus|hook|refrain)\s*\d*\s*[:.-]?$/i.test(l));
const tokens = (line) => line.split(/\s+/).filter(Boolean);
const bare = (w) => String(w).toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '');
// A rough size for spreading words across a line: Hangul blocks count once each, otherwise vowel groups.
const weight = (w) => { const h = (w.match(/[가-힣]/g) || []).length; if (h) return h; return Math.max(1, (bare(w).match(/[aeiouyáéíóúü]+/g) || []).length); };

/**
 * Turn word timings for the ORIGINAL lyrics into line timings, then give each
 * line of the NEW lyrics the same window, spreading its words by size.
 */
function buildTimings(originalLyrics, newLyrics, aligned, durationHint) {
  const orig = lyricLines(originalLyrics); const neu = lyricLines(newLyrics);
  const words = (aligned.words || []).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end));
  // Walk the aligned words in order, assigning as many as each original line has.
  let wi = 0; const windows = [];
  for (const line of orig) {
    const want = tokens(line).length;
    const mine = words.slice(wi, wi + want); wi += want;
    if (mine.length) windows.push({ start: mine[0].start, end: mine[mine.length - 1].end, loss: mine.reduce((s, w) => s + (w.loss || 0), 0) / mine.length });
    else windows.push(null);
  }
  // Fill any gaps so every line has a window.
  const total = durationHint || (words.length ? words[words.length - 1].end + 2 : orig.length * 4);
  for (let i = 0; i < windows.length; i++) {
    if (windows[i]) continue;
    const prev = i > 0 ? windows[i - 1] : null;
    let nextIdx = i + 1; while (nextIdx < windows.length && !windows[nextIdx]) nextIdx++;
    const next = nextIdx < windows.length ? windows[nextIdx] : null;
    const a = prev ? prev.end : 0; const b = next ? next.start : total;
    const slots = nextIdx - i; const each = Math.max(0.6, (b - a) / (slots + 0.0001));
    windows[i] = { start: a + 0.05, end: a + each, loss: null, guessed: true };
  }
  // Keep order sane: no line may start before the previous one.
  for (let i = 1; i < windows.length; i++) if (windows[i].start < windows[i - 1].start) windows[i].start = windows[i - 1].start + 0.05;
  for (const w of windows) if (w.end <= w.start) w.end = w.start + 0.8;

  const n = Math.max(neu.length, 0);
  const lines = [];
  for (let i = 0; i < n; i++) {
    // Same line count: one to one. Otherwise spread the new lines across the original windows in proportion.
    const oi = orig.length === n ? i : Math.min(orig.length - 1, Math.floor((i * orig.length) / n));
    const share = orig.length === n ? null : { k: i - Math.ceil((oi * n) / orig.length), of: Math.max(1, Math.ceil(((oi + 1) * n) / orig.length) - Math.ceil((oi * n) / orig.length)) };
    const win = windows[oi] || { start: i * 4, end: i * 4 + 3.5 };
    let s = win.start; let e = win.end;
    if (share) { const span = (win.end - win.start) / share.of; s = win.start + span * share.k; e = s + span; }
    const toks = tokens(neu[i]); const sum = toks.reduce((a, t) => a + weight(t), 0) || 1;
    let at = s; const ws = toks.map((t) => { const d = ((e - s) * weight(t)) / sum; const w = { t, s: +at.toFixed(3), e: +(at + d).toFixed(3) }; at += d; return w; });
    lines.push({ start: +s.toFixed(3), end: +e.toFixed(3), text: neu[i], words: ws, guessed: !!win.guessed });
  }
  const usable = windows.filter((w) => !w.guessed).length;
  const wordsExpected = orig.reduce((a, l) => a + tokens(l).length, 0);
  // Signs that the lyrics do not belong to this recording.
  let sameStart = 0; for (let i = 1; i < words.length; i++) if (words[i].start - words[i - 1].start < 0.02) sameStart++;
  const stackedPct = words.length > 1 ? Math.round((100 * sameStart) / (words.length - 1)) : 0;
  const tinyLines = windows.filter((w) => !w.guessed && w.end - w.start < 0.35).length;
  const reasons = [];
  if (!words.length) reasons.push('no-words');
  if (words.length && Number.isFinite(aligned.loss) && aligned.loss > LOSS_WARN) reasons.push('poor-fit');
  if (stackedPct >= 15) reasons.push('stacked-words');
  if (tinyLines >= 2) reasons.push('tiny-lines');
  if (wordsExpected && Math.abs(words.length - wordsExpected) > Math.max(2, wordsExpected * 0.1)) reasons.push('word-count');
  const level = !words.length || reasons.includes('poor-fit') || reasons.includes('stacked-words') || reasons.includes('tiny-lines') ? 'poor'
    : reasons.length || usable < windows.length || orig.length !== neu.length ? 'check' : 'good';
  const quality = {
    originalLines: orig.length, newLines: neu.length, sameLineCount: orig.length === neu.length,
    wordsExpected, wordsTimed: words.length, linesTimed: usable, loss: aligned.loss, stackedPct, tinyLines, reasons, level,
  };
  return { lines, quality };
}

// ── Routes ───────────────────────────────────────────────────────────────────
module.exports = function attachKaraoke(router, deps) {
  const { supabase, requireTeam, limited, multer, CFG } = deps;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 1, fields: 8, fieldSize: 400000 } });
  let running = 0;
  const one = (req, res, next) => upload.single('song')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `That file is over ${MAX_MB} MB. Most songs saved as MP3 or M4A are well under that.` : 'That file could not be read. Please choose an MP3, M4A or WAV song file.' });
    next();
  });

  const view = (r) => ({ id: r.id, title: r.title, status: r.status, note: r.status === 'failed' ? null : r.step_note, error: r.error, duration: r.duration_s, quality: r.timing_quality, edited: r.edited, created_at: r.created_at });

  async function prepare(id, buf, kind) {
    const set = (patch) => supabase.from('evalroom_karaoke').update(patch).eq('id', id);
    let sourcePath = null;
    running++;
    try {
      const { data: row } = await supabase.from('evalroom_karaoke').select('*').eq('id', id).single();
      sourcePath = row.source_path;
      await set({ status: 'splitting', step_note: 'Separating the singing from the music' });
      const split = await separate(buf, kind);
      const ipath = `${safePart(row.team_key)}/karaoke/${id}/music.${split.instrumental.ext}`;
      const up = await supabase.storage.from(BUCKET).upload(ipath, split.instrumental.buf, { contentType: split.instrumental.mime, upsert: true });
      if (up.error) throw new Error('storage: ' + up.error.message);
      await set({ status: 'timing', step_note: 'Timing the lyrics to the singing', instrumental_path: ipath, instrumental_type: split.instrumental.mime });
      const aligned = await align(split.vocals.buf, split.vocals, lyricLines(row.original_lyrics).join('\n'));
      const { lines, quality } = buildTimings(row.original_lyrics, row.new_lyrics, aligned);
      const dur = lines.length ? lines[lines.length - 1].end : null;
      await set({ status: 'ready', step_note: null, timings: lines, auto_timings: lines, timing_quality: quality, duration_s: dur, finished_at: new Date().toISOString() });
    } catch (err) {
      console.error('evalroom karaoke error:', err.message);
      const friendly = /not switched on/.test(err.message) ? err.message
        : err.status === 401 || err.status === 403 ? 'The song maker could not sign in to its audio service. The organizer needs to check the key.'
        : err.status === 402 || /quota|credit/i.test(err.message) ? 'The song maker has run out of audio credits. Please tell the organizer.'
        : 'The song could not be prepared. Check that the file is a normal song with singing, then try again.';
      await set({ status: 'failed', error: friendly, finished_at: new Date().toISOString() });
    } finally {
      running--;
      // The uploaded original is never kept, whether the song worked or not.
      if (sourcePath) await supabase.storage.from(BUCKET).remove([sourcePath]).catch(() => {});
    }
  }

  router.get('/karaoke', requireTeam, async (req, res) => {
    const { data, error } = await supabase.from('evalroom_karaoke').select('*').eq('team_key', req.team.key).neq('status', 'deleted').order('created_at', { ascending: false }).limit(20);
    if (error) return res.status(500).json({ error: 'Could not load your songs. Please try again.' });
    res.json({ songs: (data || []).map(view), maxMb: MAX_MB, perDay: MAX_PER_DAY, ready: !!process.env.ELEVENLABS_API_KEY });
  });

  router.post('/karaoke', requireTeam, one, async (req, res) => {
    try {
      if (limited('karaoke:' + req.team.key, 4, 10 * 60000)) return res.status(429).json({ error: 'That is a lot of songs in a few minutes. Please wait a little and try again.' });
      if (!process.env.ELEVENLABS_API_KEY) return res.status(503).json({ error: 'The song maker is not switched on yet.' });
      const b = req.body || {};
      if (String(b.rights) !== 'true') return res.status(400).json({ error: 'Tick the box to confirm your team bought this song or has the right to use it.' });
      const f = req.file; const kind = f && sniffAudio(f.buffer);
      if (!kind) return res.status(400).json({ error: 'Please choose a song file saved as MP3, M4A or WAV.' });
      const orig = String(b.original_lyrics || ''); const neu = String(b.new_lyrics || '');
      if (orig.length > CFG.maxTextChars || neu.length > CFG.maxTextChars) return res.status(400).json({ error: `Those lyrics are longer than the song maker can take (${CFG.maxTextChars.toLocaleString()} characters). Please trim them.` });
      const ol = lyricLines(orig); const nl = lyricLines(neu);
      if (ol.length < 2) return res.status(400).json({ error: 'Paste the original lyrics of the song, one line per line. Lines that are only a label, like [Chorus], are skipped.' });
      if (nl.length < 2) return res.status(400).json({ error: 'Paste your new lyrics, one line per line. Lines that are only a label, like [Chorus], are skipped.' });
      const since = new Date(Date.now() - 864e5).toISOString();
      const { data: today } = await supabase.from('evalroom_karaoke').select('status').eq('team_key', req.team.key).gte('created_at', since);
      const made = (today || []).filter((x) => x.status !== 'failed').length;
      if (made >= MAX_PER_DAY) return res.status(429).json({ error: `Your team has made ${MAX_PER_DAY} songs today. The song maker opens again tomorrow.` });
      if ((today || []).length >= MAX_TRIES_PER_DAY) return res.status(429).json({ error: 'Your team has reached today\'s limit of tries with the song maker. It opens again tomorrow.' });
      const { count: everyone } = await supabase.from('evalroom_karaoke').select('id', { count: 'exact', head: true }).gte('created_at', since);
      if ((everyone || 0) >= MAX_ALL_TEAMS_PER_DAY) return res.status(503).json({ error: 'The song maker has reached its limit for today. It opens again tomorrow.' });
      if (running >= MAX_AT_ONCE) return res.status(503).json({ error: 'The song maker is busy with other teams\' songs. Please try again in a minute.' });

      const { data: row, error } = await supabase.from('evalroom_karaoke').insert({
        team_key: req.team.key, team_name: req.team.name, title: String(b.title || 'Our song').replace(/[<>]/g, '').trim().slice(0, 80) || 'Our song',
        original_lyrics: ol.join('\n'), new_lyrics: nl.join('\n'), status: 'queued', step_note: 'Getting ready', rights_confirmed_at: new Date().toISOString(),
      }).select('*').single();
      if (error) throw new Error(error.message);
      const spath = `${safePart(req.team.key)}/karaoke/${row.id}/source.${kind.ext}`;
      const up = await supabase.storage.from(BUCKET).upload(spath, f.buffer, { contentType: kind.mime, upsert: true });
      if (!up.error) await supabase.from('evalroom_karaoke').update({ source_path: spath }).eq('id', row.id);
      prepare(row.id, f.buffer, kind); // carries on after this reply; the page checks back for progress
      res.json({ ok: true, song: view(row), lineNote: ol.length === nl.length ? null : `Your new lyrics have ${nl.length} lines and the original has ${ol.length}. The timing works best when they match line for line.` });
    } catch (err) {
      console.error('evalroom karaoke create error:', err.message);
      res.status(502).json({ error: 'The song maker could not start. Please try again.' });
    }
  });

  router.get('/karaoke/:id', requireTeam, async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Song not found.' });
    const { data: r } = await supabase.from('evalroom_karaoke').select('*').eq('id', req.params.id).eq('team_key', req.team.key).single();
    if (!r || r.status === 'deleted') return res.status(404).json({ error: 'Song not found.' });
    // A song stuck for 12 minutes was interrupted (for example by a restart).
    if (['queued', 'splitting', 'timing'].includes(r.status) && Date.now() - new Date(r.created_at).getTime() > 8 * 60000) {
      await supabase.from('evalroom_karaoke').update({ status: 'failed', error: 'The song maker was interrupted. Please make the song again.' }).eq('id', r.id);
      r.status = 'failed'; r.error = 'The song maker was interrupted. Please make the song again.';
    }
    const out = { song: view(r) };
    if (r.status === 'ready') {
      const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(r.instrumental_path, 3 * 3600);
      out.audio_url = signed && signed.signedUrl; out.lines = r.timings; out.canUndo = !!(r.edited && r.auto_timings);
    }
    res.json(out);
  });

  // Save timing the team fixed by tapping along.
  router.post('/karaoke/:id/timings', requireTeam, async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Song not found.' });
    const { data: r } = await supabase.from('evalroom_karaoke').select('id, timings, status').eq('id', req.params.id).eq('team_key', req.team.key).single();
    if (!r || r.status !== 'ready') return res.status(404).json({ error: 'Song not found.' });
    const starts = req.body && req.body.starts;
    if (!Array.isArray(starts) || starts.length !== r.timings.length || starts.some((x) => typeof x !== 'number' || !(x >= 0) || x > 3600)) return res.status(400).json({ error: 'That timing could not be saved.' });
    if (starts.some((x, i) => i > 0 && x < starts[i - 1] + 0.15)) return res.status(400).json({ error: 'Those taps were out of order or too close together, so the timing was left as it was. Try again, tapping once as each line begins.' });
    const lines = r.timings.map((l, i) => {
      const s = starts[i]; const next = i + 1 < starts.length ? starts[i + 1] : s + Math.max(1.5, l.end - l.start);
      const e = Math.max(s + 0.4, Math.min(next - 0.05, s + Math.max(1.5, (l.end - l.start) * 1.5)));
      const sum = l.words.reduce((a, w) => a + weight(w.t), 0) || 1; let at = s;
      const words = l.words.map((w) => { const d = ((e - s) * weight(w.t)) / sum; const o = { t: w.t, s: +at.toFixed(3), e: +(at + d).toFixed(3) }; at += d; return o; });
      return { ...l, start: +s.toFixed(3), end: +e.toFixed(3), words, guessed: false };
    });
    const { error } = await supabase.from('evalroom_karaoke').update({ timings: lines, edited: true }).eq('id', r.id);
    if (error) return res.status(500).json({ error: 'That timing could not be saved. Please try again.' });
    res.json({ ok: true, lines });
  });

  // Go back to the timing the room worked out.
  router.post('/karaoke/:id/timings/reset', requireTeam, async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Song not found.' });
    const { data: r } = await supabase.from('evalroom_karaoke').select('id, auto_timings, status').eq('id', req.params.id).eq('team_key', req.team.key).single();
    if (!r || r.status !== 'ready' || !r.auto_timings) return res.status(404).json({ error: 'Song not found.' });
    const { error } = await supabase.from('evalroom_karaoke').update({ timings: r.auto_timings, edited: false }).eq('id', r.id);
    if (error) return res.status(500).json({ error: 'That could not be undone. Please try again.' });
    res.json({ ok: true, lines: r.auto_timings });
  });

  // Remove a song and its audio.
  router.post('/karaoke/:id/delete', requireTeam, async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Song not found.' });
    const { data: r } = await supabase.from('evalroom_karaoke').select('id, instrumental_path, source_path, status').eq('id', req.params.id).eq('team_key', req.team.key).single();
    if (!r || r.status === 'deleted') return res.status(404).json({ error: 'Song not found.' });
    const paths = [r.instrumental_path, r.source_path].filter(Boolean);
    if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
    // The row stays (without audio or lyrics) so the daily limits still count it.
    const { error } = await supabase.from('evalroom_karaoke').update({ status: 'deleted', instrumental_path: null, source_path: null, timings: null, auto_timings: null, original_lyrics: '', new_lyrics: '' }).eq('id', r.id);
    if (error) return res.status(500).json({ error: 'That song could not be removed. Please try again.' });
    res.json({ ok: true });
  });

  // After a restart, songs that were mid-way are told plainly that they need making again.
  setTimeout(() => {
    supabase.from('evalroom_karaoke').update({ status: 'failed', error: 'The song maker was interrupted. Please make the song again.' })
      .in('status', ['queued', 'splitting', 'timing']).lt('created_at', new Date(Date.now() - 6 * 60000).toISOString()).then(() => {});
  }, 8000).unref();
};
module.exports._internal = { separate, align, buildTimings, sniffAudio, lyricLines, elevenKey, API };
