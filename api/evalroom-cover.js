/**
 * TopKpop.io — The Evaluation Room: "Hear it sung".
 *
 * A team uploads a song they own, gives their new lyrics and picks a voice
 * style. An AI voice sings the new lyrics to the tune of that song
 * (MiniMax Music Cover, reached through Replicate).
 *
 * Audio is kept in private storage and only the team that made it can play it.
 */
const { _internal: K } = require('./evalroom-karaoke');

const BUCKET = 'evalroom-private';
const REPLICATE = 'https://api.replicate.com/v1';
const MODEL = process.env.EVALROOM_COVER_MODEL || 'minimax/music-cover';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MB = Number(process.env.EVALROOM_SONG_MAX_MB || 25);
const MAX_PER_DAY = Number(process.env.EVALROOM_COVERS_PER_DAY || 3);
const MAX_TRIES_PER_DAY = Number(process.env.EVALROOM_COVER_TRIES_PER_DAY || 6);
const MAX_ALL_TEAMS_PER_DAY = Number(process.env.EVALROOM_COVERS_ALL_TEAMS_PER_DAY || 40);
const LYRICS_MAX = 2800; // the singing service takes up to 3,000 characters
const safePart = (x) => String(x).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);

// Voices are described by style. No real singer is named or imitated.
const STYLES = {
  kpop_boy: { label: 'K-pop boy-group lead', hint: 'Bright, polished male voice over a dance-pop track', prompt: 'Modern K-pop dance-pop, bright polished young male lead vocal, tight harmonies, punchy drums, glossy synths, energetic and catchy' },
  kpop_girl: { label: 'K-pop girl-group lead', hint: 'Bright, powerful female voice over a dance-pop track', prompt: 'Modern K-pop dance-pop, bright powerful young female lead vocal, tight harmonies, punchy drums, glossy synths, energetic and catchy' },
  soul_male: { label: 'Smooth soul (male)', hint: 'Warm, soulful male voice with piano', prompt: 'Warm soulful pop ballad, smooth expressive male tenor vocal, piano, light strings, gentle groove' },
  latin_female: { label: 'Latin pop (female)', hint: 'Bright female voice with a Latin pop feel', prompt: 'Upbeat Latin pop, bright expressive female lead vocal, rhythmic acoustic guitar, lively percussion, danceable' },
};

function token() {
  const t = process.env.REPLICATE_API_TOKEN;
  if (!t) throw new Error('Hear it sung is not switched on yet (no key).');
  return t;
}

// Keep whole lines, up to the service's length limit.
function fitLyrics(text) {
  const lines = K.lyricLines(text); const kept = [];
  let n = 0;
  for (const l of lines) { if (n + l.length + 1 > LYRICS_MAX) break; kept.push(l); n += l.length + 1; }
  return { text: kept.join('\n'), kept: kept.length, total: lines.length };
}

// What the singer is given: the team's words in ordinary capitals, without stage notes.
// Stress marks like "eMERgency" help a person but trip the AI singer.
function forSinger(text) {
  return K.lyricLines(text).map((line) => {
    let l = line.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/[A-Za-z0-9À-ɏ]/.test(l)) return '';
    l = l.split(' ').map((w) => (/[A-ZÀ-Þ]/.test(w.slice(1)) ? w.toLowerCase() : w)).join(' ');
    l = l.replace(/\bi\b(?=$|[\s'’,.!?;:])/g, 'I');
    return l.replace(/^([^A-Za-zÀ-ɏ]*)([a-zß-ɏ])/, (m, pre, c) => pre + c.toUpperCase());
  }).filter(Boolean).join('\n');
}

let schemaCache = null;
async function inputFields() {
  if (schemaCache) return schemaCache;
  const r = await fetch(`${REPLICATE}/models/${MODEL}`, { headers: { Authorization: 'Bearer ' + token() }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw Object.assign(new Error('Replicate ' + r.status + ': ' + (await r.text()).slice(0, 300)), { status: r.status });
  const j = await r.json();
  const props = (((j.latest_version || {}).openapi_schema || {}).components || {}).schemas;
  schemaCache = props && props.Input && props.Input.properties ? props.Input.properties : {};
  return schemaCache;
}

/** Ask the service to sing. Returns { url, id, seconds }. */
async function sing(audioUrl, stylePrompt, lyrics, onNote = () => {}) {
  const fields = await inputFields().catch(() => ({}));
  const has = (k) => !Object.keys(fields).length || k in fields;
  const input = { prompt: stylePrompt };
  input[has('audio_url') ? 'audio_url' : has('reference_audio') ? 'reference_audio' : 'audio_url'] = audioUrl;
  if (lyrics && has('lyrics')) input.lyrics = lyrics;
  const t0 = Date.now();
  const start = await fetch(`${REPLICATE}/models/${MODEL}/predictions`, { method: 'POST', headers: { Authorization: 'Bearer ' + token(), 'Content-Type': 'application/json' }, body: JSON.stringify({ input }), signal: AbortSignal.timeout(60000) });
  let p = await start.json().catch(() => ({}));
  if (!start.ok) throw Object.assign(new Error('Replicate ' + start.status + ': ' + JSON.stringify(p).slice(0, 400)), { status: start.status });
  await onNote(p.id);
  while (['starting', 'processing'].includes(p.status)) {
    if (Date.now() - t0 > 9 * 60000) throw new Error('The singer took too long.');
    await new Promise((r) => setTimeout(r, 4000));
    const g = await fetch(`${REPLICATE}/predictions/${p.id}`, { headers: { Authorization: 'Bearer ' + token() }, signal: AbortSignal.timeout(30000) });
    p = await g.json();
  }
  if (p.status !== 'succeeded') throw Object.assign(new Error('Replicate ' + p.status + ': ' + String(p.error || '').slice(0, 400)), { status: 422 });
  const out = Array.isArray(p.output) ? p.output[0] : (p.output && p.output.audio) || p.output;
  if (!out || typeof out !== 'string') throw new Error('The singer returned nothing to play.');
  if (!/^https:\/\/[a-z0-9.-]*replicate\.(delivery|com)\//i.test(out)) throw new Error('The singer returned an unexpected address.');
  return { url: out, id: p.id, seconds: Math.round((Date.now() - t0) / 1000), usedLyrics: 'lyrics' in input, fields: Object.keys(fields) };
}

module.exports = function attachCover(router, deps) {
  const { supabase, requireTeam, limited, multer, CFG } = deps;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 1, fields: 8, fieldSize: 400000 } });
  const one = (req, res, next) => upload.single('song')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `That file is over ${MAX_MB} MB. Most songs saved as MP3 or M4A are well under that.` : 'That file could not be read. Please choose an MP3, M4A or WAV song file.' });
    next();
  });
  let running = 0;
  const view = (r) => ({ id: r.id, title: r.title, style: r.style, styleLabel: (STYLES[r.style] || {}).label || r.style, status: r.status, note: r.status === 'failed' ? null : r.step_note, error: r.error, seconds: r.seconds_taken, created_at: r.created_at });

  async function make(id, buf, kind, sourcePath) {
    const set = (patch) => supabase.from('evalroom_covers').update(patch).eq('id', id);
    running++;
    try {
      const { data: row } = await supabase.from('evalroom_covers').select('*').eq('id', id).single();
      await set({ status: 'singing', step_note: 'The singer is learning the tune' });
      const { data: signed, error: sErr } = await supabase.storage.from(BUCKET).createSignedUrl(sourcePath, 3600);
      if (sErr || !signed) throw new Error('storage: ' + (sErr && sErr.message));
      const result = await sing(signed.signedUrl, STYLES[row.style].prompt, forSinger(row.lyrics), (pid) => set({ prediction_id: pid, step_note: 'The singer is recording your song' }));
      const got = await fetch(result.url, { signal: AbortSignal.timeout(120000) });
      if (!got.ok) throw new Error('download ' + got.status);
      const audio = Buffer.from(await got.arrayBuffer());
      const ak = K.sniffAudio(audio) || { mime: got.headers.get('content-type') || 'audio/mpeg', ext: 'mp3' };
      const apath = `${safePart(row.team_key)}/sung/${id}/song.${ak.ext}`;
      const up = await supabase.storage.from(BUCKET).upload(apath, audio, { contentType: ak.mime, upsert: true });
      if (up.error) throw new Error('storage: ' + up.error.message);
      await set({ status: 'ready', step_note: null, audio_path: apath, audio_type: ak.mime, seconds_taken: result.seconds, finished_at: new Date().toISOString() });
    } catch (err) {
      console.error('evalroom cover error:', err.message);
      const m = String(err.message || '');
      const friendly = /not switched on/.test(m) ? m
        : err.status === 401 || err.status === 403 ? 'The singer could not sign in to its service. The organizer needs to check the key.'
        : err.status === 402 || /billing|payment|credit|insufficient/i.test(m) ? 'The singing service needs a payment method or more credit. Please tell the organizer.'
        : /copyright|protected|sensitive|moderat|policy|not allowed/i.test(m) ? 'The singing service would not use this recording. It may recognise it as a protected song. Try a recording your team made.'
        : 'The song could not be sung this time. Check that the file is a normal song with singing, then try again.';
      await set({ status: 'failed', error: friendly, step_note: m.slice(0, 500), finished_at: new Date().toISOString() });
    } finally {
      running--;
      if (sourcePath) await supabase.storage.from(BUCKET).remove([sourcePath]).catch(() => {}); // the upload is never kept
    }
  }

  router.get('/sung', requireTeam, async (req, res) => {
    const { data, error } = await supabase.from('evalroom_covers').select('*').eq('team_key', req.team.key).neq('status', 'deleted').order('created_at', { ascending: false }).limit(20);
    if (error) return res.status(500).json({ error: 'Could not load your songs. Please try again.' });
    res.json({ songs: (data || []).map(view), styles: Object.entries(STYLES).map(([key, s]) => ({ key, label: s.label, hint: s.hint })), perDay: MAX_PER_DAY, lyricsMax: LYRICS_MAX, ready: !!process.env.REPLICATE_API_TOKEN });
  });

  router.post('/sung', requireTeam, one, async (req, res) => {
    try {
      if (limited('sung:' + req.team.key, 4, 10 * 60000)) return res.status(429).json({ error: 'That is a lot of songs in a few minutes. Please wait a little and try again.' });
      if (!process.env.REPLICATE_API_TOKEN) return res.status(503).json({ error: 'Hear it sung is not switched on yet.' });
      const b = req.body || {};
      if (String(b.rights) !== 'true') return res.status(400).json({ error: 'Tick the box to confirm your team bought this song or has the right to use it.' });
      if (!Object.prototype.hasOwnProperty.call(STYLES, String(b.style))) return res.status(400).json({ error: 'Choose a voice style.' });
      const f = req.file; const kind = f && K.sniffAudio(f.buffer);
      if (!kind) return res.status(400).json({ error: 'Please choose a song file saved as MP3 or WAV.' });
      if (!/mpeg|mp3|wav/i.test(kind.mime)) return res.status(400).json({ error: 'The singer can only learn from MP3 or WAV files. Please save the song as MP3 or WAV and try again.' });
      const raw = String(b.lyrics || '');
      if (raw.length > CFG.maxTextChars) return res.status(400).json({ error: 'Those lyrics are too long. Please trim them.' });
      const fit = fitLyrics(raw);
      if (fit.kept < 2 || fit.text.length < 10) return res.status(400).json({ error: 'Paste your new lyrics in box 3, one line per line.' });

      const since = new Date(Date.now() - 864e5).toISOString();
      const { data: today } = await supabase.from('evalroom_covers').select('status').eq('team_key', req.team.key).gte('created_at', since);
      if ((today || []).filter((x) => x.status !== 'failed').length >= MAX_PER_DAY) return res.status(429).json({ error: `Your team has had ${MAX_PER_DAY} songs sung today. The singer is back tomorrow.` });
      if ((today || []).length >= MAX_TRIES_PER_DAY) return res.status(429).json({ error: 'Your team has reached today\'s limit of tries. The singer is back tomorrow.' });
      const { count: everyone } = await supabase.from('evalroom_covers').select('id', { count: 'exact', head: true }).gte('created_at', since);
      if ((everyone || 0) >= MAX_ALL_TEAMS_PER_DAY) return res.status(503).json({ error: 'The singer has reached its limit for today. It is back tomorrow.' });
      if (running >= 2) return res.status(503).json({ error: 'The singer is busy with other teams\' songs. Please try again in a minute.' });

      const { data: row, error } = await supabase.from('evalroom_covers').insert({
        team_key: req.team.key, team_name: req.team.name, title: String(b.title || 'Our song').replace(/[<>]/g, '').trim().slice(0, 80) || 'Our song',
        style: String(b.style), lyrics: fit.text, status: 'queued', step_note: 'Getting ready', rights_confirmed_at: new Date().toISOString(),
      }).select('*').single();
      if (error) throw new Error(error.message);
      const spath = `${safePart(req.team.key)}/sung/${row.id}/source.${kind.ext}`;
      const up = await supabase.storage.from(BUCKET).upload(spath, f.buffer, { contentType: kind.mime, upsert: true });
      if (up.error) { await supabase.from('evalroom_covers').update({ status: 'failed', error: 'The song could not be uploaded. Please try again.' }).eq('id', row.id); throw new Error(up.error.message); }
      make(row.id, f.buffer, kind, spath); // carries on after this reply; the page checks back
      res.json({ ok: true, song: view(row), lyricNote: fit.kept < fit.total ? `The singer can take about ${LYRICS_MAX} characters, so it will sing your first ${fit.kept} of ${fit.total} lines.` : null });
    } catch (err) {
      console.error('evalroom cover create error:', err.message);
      res.status(502).json({ error: 'The singer could not start. Please try again.' });
    }
  });

  router.get('/sung/:id', requireTeam, async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Song not found.' });
    const { data: r } = await supabase.from('evalroom_covers').select('*').eq('id', req.params.id).eq('team_key', req.team.key).single();
    if (!r || r.status === 'deleted') return res.status(404).json({ error: 'Song not found.' });
    if (['queued', 'singing'].includes(r.status) && Date.now() - new Date(r.created_at).getTime() > 11 * 60000) {
      await supabase.from('evalroom_covers').update({ status: 'failed', error: 'The singer was interrupted. Please try again.' }).eq('id', r.id);
      r.status = 'failed'; r.error = 'The singer was interrupted. Please try again.';
    }
    const out = { song: view(r) };
    if (r.status === 'ready') {
      const name = (r.title || 'our-song').replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || 'our-song';
      const ext = (r.audio_path || '').split('.').pop() || 'mp3';
      const play = await supabase.storage.from(BUCKET).createSignedUrl(r.audio_path, 3 * 3600);
      const save = await supabase.storage.from(BUCKET).createSignedUrl(r.audio_path, 3 * 3600, { download: `${name}.${ext}` });
      out.audio_url = play.data && play.data.signedUrl; out.download_url = save.data && save.data.signedUrl; out.lyrics = r.lyrics;
    }
    res.json(out);
  });

  router.post('/sung/:id/delete', requireTeam, async (req, res) => {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Song not found.' });
    const { data: r } = await supabase.from('evalroom_covers').select('id, audio_path, status').eq('id', req.params.id).eq('team_key', req.team.key).single();
    if (!r || r.status === 'deleted') return res.status(404).json({ error: 'Song not found.' });
    if (r.audio_path) await supabase.storage.from(BUCKET).remove([r.audio_path]);
    const { error } = await supabase.from('evalroom_covers').update({ status: 'deleted', audio_path: null, lyrics: '' }).eq('id', r.id);
    if (error) return res.status(500).json({ error: 'That song could not be removed. Please try again.' });
    res.json({ ok: true });
  });

  setTimeout(() => {
    supabase.from('evalroom_covers').update({ status: 'failed', error: 'The singer was interrupted. Please try again.' })
      .in('status', ['queued', 'singing']).lt('created_at', new Date(Date.now() - 6 * 60000).toISOString()).then(() => {});
  }, 9000).unref();
};
module.exports._internal = { forSinger, sing, inputFields, fitLyrics, STYLES, token, REPLICATE, MODEL };
