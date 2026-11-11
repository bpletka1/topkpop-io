/**
 * TopKpop.io — The Evaluation Room: karaoke video.
 *
 * Turns a finished karaoke song (music-only track + timed lyrics) into an MP4 a team can
 * download and play anywhere: the words light up in time over the music.
 * The picture is drawn from the saved timings, so it always matches what the page shows.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BUCKET = 'evalroom-private';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FONTS = path.join(__dirname, 'evalroom-fonts');
const MAX_PER_DAY = Number(process.env.EVALROOM_VIDEOS_PER_DAY || 8);  // per team; a new video is only made when the timing changed
const MAX_AT_ONCE = Number(process.env.EVALROOM_VIDEOS_AT_ONCE || 2);
const MAX_SECONDS = Number(process.env.EVALROOM_VIDEO_MAX_SECONDS || 420);
const safePart = (x) => String(x).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);

function ffmpegPath() { try { return require('ffmpeg-static'); } catch (e) { return null; } }

// ── Subtitles with karaoke highlighting (ASS) ────────────────────────────────
const ts = (x) => { x = Math.max(0, x); const h = Math.floor(x / 3600); const m = Math.floor((x % 3600) / 60); const s = x % 60; return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`; };
// Team text is shown, never run: braces and backslashes would be read as commands.
// Emoji are left out: the video's lettering has no pictures for them and would show empty boxes.
const clean = (t) => String(t || '').replace(/[{}\\]/g, '').replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/[\r\n\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();

function buildAss(title, teamName, lines, duration) {
  const L = (lines || []).filter((l) => l && Number.isFinite(l.start) && Number.isFinite(l.end) && clean(l.text)).map((l) => ({ ...l, text: clean(l.text) }));
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1280', 'PlayResY: 720', 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // Sung words turn gold (primary); words still to come are soft white (secondary).
    'Style: Now,Noto Sans KR,62,&H0033C8FF,&H00F2E8E8,&H00140A1E,&H96000000,1,0,0,0,100,100,0,0,1,3,1,5,90,90,0,1',
    'Style: Next,Noto Sans KR,36,&H00C8B4B4,&H00C8B4B4,&H00140A1E,&H96000000,1,0,0,0,100,100,0,0,1,2,0,5,110,110,0,1',
    'Style: Title,Noto Sans KR,56,&H00FFFFFF,&H00FFFFFF,&H00140A1E,&H96000000,1,0,0,0,100,100,0,0,1,3,1,5,90,90,0,1',
    'Style: Small,Noto Sans KR,30,&H00B469FF,&H00B469FF,&H00140A1E,&H96000000,1,0,0,0,100,100,2,0,1,2,0,5,90,90,0,1',
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const ev = [];
  const first = L.length ? L[0].start : duration;
  const say = (a, b, style, text) => { if (b > a + 0.05) ev.push(`Dialogue: 0,${ts(a)},${ts(b)},${style},,0,0,0,,${text}`); };
  // Each line appears a moment before it is sung, so singers can get ready, and never on top of the line before it.
  const showAt = L.map((l, i) => (i === 0 ? Math.max(0, l.start - 2) : Math.min(l.start, Math.max(L[i - 1].end + 0.05, l.start - 1.5))));
  // Opening card, taken down before the first line comes up.
  const cardEnd = L.length ? showAt[0] - 0.1 : Math.min(duration, 6);
  if (cardEnd > 1) {
    say(0, cardEnd, 'Title', `{\\pos(640,300)\\fad(200,200)}${clean(title) || 'Our song'}`);
    if (clean(teamName)) say(0, cardEnd, 'Small', `{\\pos(640,390)\\fad(200,200)}${clean(teamName)}`);
  }
  L.forEach((l, i) => {
    const next = L[i + 1];
    const show = showAt[i];
    const hide = next ? Math.max(show + 0.3, Math.min(l.end + 1.5, showAt[i + 1])) : l.end + 1.5;
    const words = (l.words && l.words.length ? l.words : [{ t: l.text, s: l.start, e: l.end }]);
    let at = show; let body = '';
    words.forEach((w, k) => {
      const s = Math.max(at, Number.isFinite(w.s) ? w.s : at); const e = Math.max(s + 0.02, Number.isFinite(w.e) ? w.e : s + 0.2);
      const gap = Math.round((s - at) * 100); if (gap > 0) body += `{\\k${gap}}`;
      body += `{\\kf${Math.max(1, Math.round((e - s) * 100))}}${clean(w.t)}${k + 1 < words.length ? ' ' : ''}`;
      at = e;
    });
    say(show, hide, 'Now', `{\\pos(640,300)}${body}`);
    if (next) say(show, Math.min(hide, next.start), 'Next', `{\\pos(640,540)}${next.text}`);
  });
  return head.concat(ev).join('\n') + '\n';
}

// ── Rendering ────────────────────────────────────────────────────────────────
function run(bin, args, cwd, ms) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err = (err + d).slice(-3000); });
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('The video took too long to make.')); }, ms);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve(err) : reject(new Error('ffmpeg ' + code + ': ' + err.slice(-600))); });
  });
}

/** music: Buffer, ext: 'mp3' etc. Returns an MP4 Buffer. */
async function render(music, ext, ass, duration) {
  const bin = ffmpegPath(); if (!bin) throw new Error('The video maker is not installed.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ervid-'));
  try {
    fs.writeFileSync(path.join(dir, 'music.' + ext), music);
    fs.writeFileSync(path.join(dir, 'words.ass'), ass, 'utf8');
    fs.mkdirSync(path.join(dir, 'fonts'));
    for (const f of fs.readdirSync(FONTS)) if (/\.(ttf|otf)$/i.test(f)) fs.copyFileSync(path.join(FONTS, f), path.join(dir, 'fonts', f));
    // A still night-sky backdrop with a soft glow; the words are the picture.
    const backdrop = `color=c=0x1a0b2e:s=1280x720:r=20,format=yuv420p,drawbox=x=0:y=0:w=iw:h=6:color=0xff2d8a@0.9:t=fill,drawbox=x=0:y=ih-6:w=iw:h=6:color=0xffc233@0.9:t=fill`;
    await run(bin, ['-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-t', String(MAX_SECONDS), '-i', backdrop, '-i', 'music.' + ext,
      '-vf', 'ass=words.ass:fontsdir=fonts', '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '27', '-pix_fmt', 'yuv420p', '-r', '20',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-shortest', '-movflags', '+faststart', 'out.mp4'], dir, 6 * 60000); // as long as the music, up to the cap
    return fs.readFileSync(path.join(dir, 'out.mp4'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

module.exports = function attachVideo(router, deps) {
  const { supabase, requireTeam, limited } = deps;
  const jobs = new Map(); // song id -> { started, error }
  const started = new Map(); // team -> times a video was started in the last day
  let running = 0;
  const folder = (r) => `${safePart(r.team_key)}/karaoke/${r.id}`;
  // The file name carries a fingerprint of the timing, so fixing the timing makes a fresh video.
  const nameFor = (r) => 'video-' + crypto.createHash('sha256').update(JSON.stringify([r.title, r.timings])).digest('hex').slice(0, 16) + '.mp4';
  const load = async (req) => {
    if (!UUID.test(req.params.id)) return null;
    const { data: r } = await supabase.from('evalroom_karaoke').select('id, team_key, team_name, title, status, timings, duration_s, instrumental_path').eq('id', req.params.id).eq('team_key', req.team.key).single();
    return r && r.status === 'ready' && r.instrumental_path && Array.isArray(r.timings) ? r : null;
  };
  const existing = async (r) => {
    const { data } = await supabase.storage.from(BUCKET).list(folder(r), { limit: 100 });
    return (data || []).map((f) => f.name);
  };
  const state = async (r) => {
    const want = nameFor(r); const j = jobs.get(r.id);
    if (j && !j.error && j.name === want) return { status: 'working', seconds: Math.round((Date.now() - j.started) / 1000) };
    const names = await existing(r);
    if (names.includes(want)) {
      const nice = (String(r.title || 'our-song').replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || 'our-song') + '-karaoke.mp4';
      const { data: s } = await supabase.storage.from(BUCKET).createSignedUrl(`${folder(r)}/${want}`, 3 * 3600, { download: nice });
      return { status: 'ready', download_url: s && s.signedUrl, file_name: nice };
    }
    if (j && j.error && j.name === want) return { status: 'failed', error: j.error };
    return { status: 'none', outOfDate: names.some((n) => /^video-.*\.mp4$/.test(n)) };
  };

  async function make(r, name) {
    try {
      const dl = await supabase.storage.from(BUCKET).download(r.instrumental_path);
      if (dl.error) throw new Error('storage: ' + dl.error.message);
      const music = Buffer.from(await dl.data.arrayBuffer());
      const last = r.timings.length ? r.timings[r.timings.length - 1].end : 0;
      const duration = Math.max(Number(r.duration_s) || 0, last + 2);
      const mp4 = await render(music, (r.instrumental_path.split('.').pop() || 'mp3').toLowerCase(), buildAss(r.title, r.team_name, r.timings, duration), duration);
      // If the song was removed or its timing changed while this was being made, the video is no longer wanted.
      const { data: fresh } = await supabase.from('evalroom_karaoke').select('id, team_key, title, status, timings').eq('id', r.id).single();
      if (!fresh || fresh.status !== 'ready' || !Array.isArray(fresh.timings) || nameFor(fresh) !== name) { jobs.delete(r.id); return; }
      const old = (await existing(r)).filter((n) => /^video-.*\.mp4$/.test(n) && n !== name).map((n) => `${folder(r)}/${n}`);
      const up = await supabase.storage.from(BUCKET).upload(`${folder(r)}/${name}`, mp4, { contentType: 'video/mp4', upsert: true });
      if (up.error) throw new Error('storage: ' + up.error.message);
      if (old.length) await supabase.storage.from(BUCKET).remove(old).catch(() => {});
      jobs.delete(r.id);
    } catch (err) {
      console.error('evalroom video error:', err.message);
      jobs.set(r.id, { name, started: Date.now(), error: 'The video could not be made this time. Please try again.' });
    } finally { running--; }
  }

  router.get('/karaoke/:id/video', requireTeam, async (req, res) => {
    const r = await load(req); if (!r) return res.status(404).json({ error: 'Song not found.' });
    res.json(await state(r));
  });

  router.post('/karaoke/:id/video', requireTeam, async (req, res) => {
    try {
      const r = await load(req); if (!r) return res.status(404).json({ error: 'Song not found.' });
      if (!ffmpegPath()) return res.status(503).json({ error: 'The video maker is not switched on yet.' });
      const now = await state(r);
      if (now.status === 'ready' || now.status === 'working') return res.json(now);
      if (!r.timings.length) return res.status(400).json({ error: 'This song has no timed lyrics to show yet.' });
      const mine = jobs.get(r.id);
      if (mine && !mine.error && Date.now() - mine.started < 7 * 60000) return res.json({ status: 'working', seconds: Math.round((Date.now() - mine.started) / 1000) });
      const day = started.get(req.team.key) || []; const recent = day.filter((t) => Date.now() - t < 864e5);
      if (recent.length >= MAX_PER_DAY) return res.status(429).json({ error: `Your team has made ${MAX_PER_DAY} videos today. The video maker is back tomorrow.` });
      if (running >= MAX_AT_ONCE) return res.status(503).json({ error: 'The video maker is busy with other teams\' songs. It will try again by itself in a moment.', busy: true });
      running++; recent.push(Date.now()); started.set(req.team.key, recent); // only videos that really start are counted
      const name = nameFor(r); jobs.set(r.id, { name, started: Date.now(), error: null });
      make(r, name); // carries on after this reply; the page checks back
      res.json({ status: 'working', seconds: 0 });
    } catch (err) { console.error('evalroom video start error:', err.message); res.status(502).json({ error: 'The video maker could not start. Please try again.' }); }
  });
};
module.exports._internal = { buildAss, render, ffmpegPath };
module.exports.removeVideos = async function removeVideos(supabase, teamKey, id) {
  const dir = `${safePart(teamKey)}/karaoke/${id}`;
  const { data } = await supabase.storage.from(BUCKET).list(dir, { limit: 100 });
  const paths = (data || []).filter((f) => /^video-.*\.mp4$/.test(f.name)).map((f) => `${dir}/${f.name}`);
  if (paths.length) await supabase.storage.from(BUCKET).remove(paths);
};
