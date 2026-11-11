/**
 * TopKpop.io — The Evaluation Room: preview-only test runner.
 *
 * Runs ONLY when PREVIEW_MODE=1. It reads test cases from the
 * evalroom_selftest table, runs them through the same code the page uses,
 * and writes the results back. It can be deleted once the room is live.
 */
const fs = require('fs');
const path = require('path');
const { complete } = require('./ai-complete');
const { _internal: R } = require('./evalroom');
const { SUITES } = require('./evalroom-fixtures/cases');
const { compare } = require('./evalroom-syllables');

const FIXTURES = path.join(__dirname, 'evalroom-fixtures');
const MAX_PARALLEL = 3;
let running = 0;

function fixtureDataUrl(name) {
  const safe = path.basename(String(name));
  const buf = fs.readFileSync(path.join(FIXTURES, safe));
  const mime = R.sniffImage(buf);
  if (!mime) throw new Error('Fixture is not an image: ' + safe);
  return R.dataUrl(buf, mime);
}

function judgeInput(j, p) {
  if (j.input === 'images') return { avatarDataUrl: fixtureDataUrl(p.avatar), posterDataUrl: fixtureDataUrl(p.poster) };
  return { text: String(p.text || '') };
}


const words = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;

// The quality rules written into each judge's instructions, checked by program.
function feedbackChecks(j, parsed, raw) {
  const [lo, hi] = j.key === 'lesson' ? [40, 60] : [48, 52];
  const n = words(parsed.summary);
  return {
    summaryWords: n, summaryInRange: n >= lo && n <= hi, summaryNear: n >= lo - 6 && n <= hi + 6,
    strengths: parsed.strengths.length, improvements: parsed.improvements.length,
    hasWelcome: /welcome/i.test(raw.split('Category Scores')[0] || ''),
    mentionsTikTok: /tiktok/i.test(raw),
    mentionsAI: j.key === 'lesson' ? /\b(AI|prompt|ChatGPT)\b/.test(raw) : false,
  };
}

// Same rule the studio page uses to find the finished lyrics.
function cleanCopy(text) {
  const lines = String(text || '').split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/clean\s+copy/i.test(lines[i]) && lines[i].replace(/[^a-z]/gi, '').length < 30) { start = i + 1; break; }
  }
  if (start === -1) return '';
  const out = [];
  for (let k = start; k < lines.length; k++) {
    const l = lines[k];
    if (/^\s*(#{1,6}\s|\*\*[^*]+\*\*\s*$)/.test(l) && out.join('').trim()) break;
    if (/^\s*(-{3,}|⸻+)\s*$/.test(l)) { if (out.join('').trim()) break; else continue; }
    out.push(l.replace(/\*\*/g, '').replace(/^\s*#{1,6}\s*/, '').replace(/^```.*$/, ''));
  }
  let body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  // Leave off a closing remark such as "Would you like any changes?"
  const stanzas = body.split(/\n\s*\n/);
  while (stanzas.length > 1) {
  const last = stanzas[stanzas.length - 1].trim();
  const oneLine = last.indexOf('\n') === -1;
    if (oneLine && (/\?\s*$/.test(last) || /^(would you|let me know|if you|want me|i can|feel free|note:|tip:|ready to)/i.test(last))) stanzas.pop(); else break;
  }
  body = stanzas.join('\n\n').trim();
  return body.length >= 40 ? body : '';
}

async function runCase(row, port) {
  const p = row.payload || {};
  const models = p.model ? [p.model] : undefined;

  if (row.kind === 'suite') {
    const cases = SUITES[p.name];
    if (!cases) throw new Error('No such suite: ' + p.name);
    const rows = cases.map((c) => ({
      suite: row.suite || p.name, label: c.label, kind: c.kind,
      payload: { ...c.payload, ...(p.model ? { model: p.model } : {}), ...(p.effort !== undefined ? { effort: p.effort } : {}) },
    }));
    const { error } = await R.supabase.from('evalroom_selftest').insert(rows);
    if (error) throw new Error(error.message);
    return { queued: rows.length };
  }

  if (row.kind === 'judge') {
    const j = R.JUDGES[p.judge];
    const { ai, parsed, saidMissing } = await R.runJudge(j, judgeInput(j, p), { models, effort: p.effort });
    await R.logUsage('selftest', 'selftest', ai);
    const e = p.expect || {};
    let pass = null;
    if (e.min !== undefined || e.max !== undefined) {
      if (!parsed.ok) pass = !!e.missingOk;
      else pass = (e.min === undefined || parsed.score >= e.min) && (e.max === undefined || parsed.score <= e.max);
    }
    return { ...parsed, saidMissing, pass, expect: e, checks: parsed.ok ? feedbackChecks(j, parsed, ai.text) : null, raw: ai.text, model: ai.model, ms: ai.ms, dropped: ai.dropped, tokensIn: ai.tokensIn, tokensOut: ai.tokensOut, costUsd: ai.costUsd };
  }

  if (row.kind === 'baseline') {
    // The old Oracle, rebuilt: the saved instructions alone, the entry sent the way a person would paste it.
    const j = R.JUDGES[p.judge];
    const input = judgeInput(j, p);
    const user = j.input === 'images'
      ? [{ type: 'text', text: 'Here are my avatar and my poster.' }, { type: 'image_url', image_url: { url: input.avatarDataUrl } }, { type: 'image_url', image_url: { url: input.posterDataUrl } }]
      : (p.leadIn ? p.leadIn + '\n\n' : '') + input.text;
    const ai = await complete(R.openai, models || ['gpt-4o'], [{ role: 'system', content: j.instructions }, { role: 'user', content: user }], { maxTokens: 3000, effort: p.effort });
    await R.logUsage('selftest', 'selftest', ai);
    return { raw: ai.text, model: ai.model, ms: ai.ms, dropped: ai.dropped, costUsd: ai.costUsd };
  }

  if (row.kind === 'studio') {
    const ai = await complete(
      R.openai, models || R.CFG.studioModels,
      [{ role: 'system', content: R.STUDIO_INSTRUCTIONS }, ...(p.messages || [])],
      { effort: p.effort === undefined ? R.CFG.studioEffort : p.effort, maxTokens: 12000, timeoutMs: 280000 }
    );
    await R.logUsage('selftest', 'selftest', ai);
    const out = { raw: ai.text, model: ai.model, ms: ai.ms, dropped: ai.dropped, tokensIn: ai.tokensIn, tokensOut: ai.tokensOut, costUsd: ai.costUsd };
    if (p.original) {
      const copy = cleanCopy(ai.text);
      out.foundCleanCopy = !!copy;
      out.sections = ['Karaoke Version', 'Teacher Version', 'Meaning Version', 'Clean Copy'].filter((h) => new RegExp(h, 'i').test(ai.text)).length;
      out.askedAQuestion = !copy && /\?/.test(ai.text);
      if (copy) out.fit = await compare(p.original, copy, p.vocab);
    }
    return out;
  }

  if (row.kind === 'song') {
    // What does a Suno page look like from this server?
    const song = require('./evalroom-song');
    let lyrics = p.lyrics || '';
    if (p.selfLyrics) {
      // Positive check without storing anyone's lyrics: use a verse taken from the page itself.
      const n0 = song.normalizeSongUrl(p.url);
      const pg = n0.ok ? await song.fetchSuno(n0.canonical) : { html: '' };
      const m = (pg.html || '').match(/\[Verse[^\]]*\]\s*([\s\S]{40,900}?)\n\s*\[/);
      lyrics = m ? m[1].replace(/<[^>]+>/g, '') : '';
    }
    const out = await song.checkSong(p.url, lyrics);
    out.lyricLinesUsed = lyrics.split('\n').filter((l) => l.trim()).length;
    if (p.probe) {
      const n = song.normalizeSongUrl(p.url);
      const page = n.ok ? await song.fetchSuno(n.canonical) : { status: 0 };
      const html = page.html || '';
      const at = (needle) => { const i = html.indexOf(needle); return i === -1 ? null : html.slice(Math.max(0, i - 60), i + 420); };
      const all = (needle) => { const hits = []; let i = -1; while (hits.length < 3 && (i = html.indexOf(needle, i + 1)) !== -1) hits.push(html.slice(Math.max(0, i - 80), i + 500)); return hits; };
      out.found = {}; for (const nd of p.needles || []) out.found[nd] = all(nd);
      out.probe = { status: page.status, finalUrl: page.finalUrl, type: page.type, bytes: html.length, head: html.slice(0, 300), prompt: at('prompt'), lyrics: at('yrics'), ogDesc: at('og:description'), challenge: /cf-challenge|Just a moment|captcha/i.test(html) };
    }
    return out;
  }

  if (row.kind === 'stageflow') {
    // Walks Take the Stage end to end through the web routes, as two practice teams.
    const base = `http://127.0.0.1:${port}/api/evalroom`;
    const tok = (k) => R.signToken({ t: 'preview:' + k, n: 'Preview: ' + k, p: 1 });
    const run = 's' + Date.now().toString(36);
    const A = tok(run + '-a'); const B = tok(run + '-b');
    const call = async (method, pth, token, json, form, extra) => {
      const headers = { ...(extra || {}) }; if (token) headers['x-evalroom-token'] = token;
      let body; if (form) body = form; else if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
      const r = await fetch(base + pth, { method, headers, body }); let d = {}; try { d = await r.json(); } catch (_) {}
      return { status: r.status, d };
    };
    const steps = []; const step = (name, got, want, note) => steps.push({ name, pass: got === want, got, want, note });
    const lyr = SUITES.lyric[0].payload.text;
    const pics = (a, p) => { const f = new FormData(); for (const [k, n] of [['avatar', a], ['poster', p]]) f.append(k, new Blob([fs.readFileSync(path.join(FIXTURES, n))], { type: 'image/png' }), n); return f; };

    // Lyrics (Trove 02)
    const r1 = await call('POST', '/rehearse/lyric', A, { text: lyr }); step('rehearse lyrics', r1.status === 200 && r1.d.ok, true, 'score ' + r1.d.score);
    const rid = r1.d.id;
    step('lock without ticking the box is refused', (await call('POST', '/stage/lyric', A, { rehearsal_id: rid })).status, 400);
    step('another team cannot lock this rehearsal', (await call('POST', '/stage/lyric', B, { rehearsal_id: rid, confirm: 'true' })).status, 404);
    const bad = await call('POST', '/stage/lyric', A, { rehearsal_id: rid, confirm: 'true', song_url: 'https://example.com/my-song' }); step('lock with a made-up song link is refused', bad.status, 400, bad.d.song);
    const wrong = await call('POST', '/stage/lyric', A, { rehearsal_id: rid, confirm: 'true', song_url: p.realSong }); step('lock with a real Suno song that has different lyrics is refused', wrong.status + ':' + wrong.d.song, '400:mismatch');
    step('nothing was locked by the refused tries', Object.keys((await call('GET', '/stage', A)).d.locks || {}).length, 0);
    const chk = await call('POST', '/stage/check-song', A, { rehearsal_id: rid, song_url: 'https://suno.com/song/00000000-0000-4000-8000-000000000000' }); step('check-song on a missing Suno page says not found', chk.d.verdict, 'not-found');
    const lock = await call('POST', '/stage/lyric', A, { rehearsal_id: rid, confirm: 'true' }); step('lock lyrics', lock.status === 200 && lock.d.lock.score === r1.d.score && lock.d.practice === true, true, 'locked ' + (lock.d.lock && lock.d.lock.total));
    step('score kept equals score seen', lock.d.lock && lock.d.lock.score, r1.d.score);
    step('second lock is refused', (await call('POST', '/stage/lyric', A, { rehearsal_id: rid, confirm: 'true' })).status, 409);
    step('song added later with a bad link is refused', (await call('POST', '/stage/lyric/song', A, { song_url: 'https://suno.com/@somebody' })).status, 400);
    const late = await call('POST', '/stage/lyric/song', A, { song_url: p.realSong }); step('song added later with different lyrics is refused', late.status + ':' + late.d.song, '400:mismatch');
    step('other team sees none of this', Object.keys((await call('GET', '/stage', B)).d.locks || {}).length, 0);

    // Lesson (Trove 03) with a dance video link
    const r3 = await call('POST', '/rehearse/lesson', A, { text: SUITES.lesson[2].payload.text });
    const l3 = await call('POST', '/stage/lesson', A, { rehearsal_id: r3.d.id, confirm: 'true', dance_video_url: 'https://youtu.be/example123' }); step('lock lesson with dance video adds 10', l3.d.lock && l3.d.lock.total - l3.d.lock.score, 10);
    step('lesson lock with a broken link is refused', (await call('POST', '/stage/lesson', B, { rehearsal_id: r3.d.id, confirm: 'true', dance_video_url: 'not a link' })).status, 404);

    // Pictures (Trove 01)
    const r2 = await call('POST', '/rehearse/visual', A, null, pics('avatar_good.png', 'poster_good.png')); step('rehearse pictures', r2.status === 200 && r2.d.ok, true, 'score ' + r2.d.score);
    const { data: keptRow } = await R.supabase.from('evalroom_rehearsals').select('input_meta').eq('id', r2.d.id).single();
    step('rehearsal pictures were kept privately', !!(keptRow && keptRow.input_meta && keptRow.input_meta.kept), true);
    const l1 = await call('POST', '/stage/visual', A, { rehearsal_id: r2.d.id, confirm: 'true' }); step('lock pictures without re-uploading them', l1.status === 200 && l1.d.lock.score === r2.d.score, true);
    // Practice locks stay out of the official table.
    const { count: officialLocks } = await R.supabase.from('evalroom_locks').select('id', { count: 'exact', head: true }).eq('team_key', 'preview:' + run + '-a').is('reset_at', null);
    step('practice locks are not in the official locks table', officialLocks, 0);
    // Song happy path: a second practice team locks a verse taken from a real Suno song, with that song.
    const C = tok(run + '-c');
    const pg = await require('./evalroom-song').fetchSuno(require('./evalroom-song').normalizeSongUrl(p.realSong).canonical);
    const verse = ((pg.html || '').match(/\[Verse[^\]]*\]\s*([\s\S]{60,900}?)\n\s*\[/) || [])[1] || '';
    const rc = await call('POST', '/rehearse/lyric', C, { text: verse.replace(/<[^>]+>/g, '') });
    const lc = await call('POST', '/stage/lyric', C, { rehearsal_id: rc.d.id, confirm: 'true', song_url: 'Listen on Suno: ' + p.realSong.replace('https://', '') }); step('lock with a matching song pasted as share text adds 10', lc.d.lock && lc.d.lock.bonus, 10, lc.d.error);
    const dup = await call('POST', '/stage/lyric/song', A, { song_url: p.realSong }); step('another team cannot turn in the same song', dup.status, 400, dup.d.song);
    step('team gets its locked lyrics back', !!(lc.d.lock && lc.d.lock.locked_text), true);

    // Organizer
    step('organizer list with a wrong password is refused', (await call('GET', '/organizer/locks', null, null, null, { 'x-organizer-password': 'guess' })).status, 401);
    step('organizer list with no password is refused', (await call('GET', '/organizer/locks')).status, 401);
    const org = { 'x-organizer-password': process.env.ADMIN_PASSWORD || '' };
    const list = await call('GET', '/organizer/locks', null, null, null, org); step('organizer sees the locks', list.status === 200 && list.d.locks.some((l) => l.id === lock.d.lock.id), true);
    step('organizer reset', (await call('POST', '/organizer/reset', null, { lock_id: lock.d.lock.id, note: 'selftest' }, null, org)).status, 200);
    const again = await call('POST', '/stage/lyric', A, { rehearsal_id: rid, confirm: 'true' }); step('after a reset the team can lock again', again.status, 200);
    // Tidy up: reset every lock this run made.
    for (const l of [again.d.lock, l3.d.lock, l1.d.lock, lc.d.lock]) if (l) await call('POST', '/organizer/reset', null, { lock_id: l.id, note: 'selftest cleanup' }, null, org);
    // The official tables must be untouched by all of the above.
    const { count } = await R.supabase.from('submissions').select('id', { count: 'exact', head: true });
    return { passed: steps.filter((x) => x.pass).length, total: steps.length, failed: steps.filter((x) => !x.pass), steps: steps.map((x) => (x.pass ? 'PASS ' : 'FAIL ') + x.name + (x.note ? ' (' + x.note + ')' : '')), submissionsRows: count };
  }

  if (row.kind === 'karaoke') {
    // Makes a short test song, then runs the Song Maker's two audio steps on it and reports what came back.
    const K = require('./evalroom-karaoke')._internal;
    const key = K.elevenKey(); const out = { steps: [] };
    const original = p.original || 'Morning light is on the stage\nEvery voice begins to sing\nHand in hand we turn the page\nHear the music that we bring';
    const rewrite = p.rewrite || 'Luz del día on the stage\nMis amigos start to sing\nJuntos now we turn the page\nHear the música we bring';
    let audio = null; let kind = null;
    if (p.source !== 'speech') {
      try {
        const r = await fetch(K.API + '/v1/music', { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, signal: AbortSignal.timeout(240000),
          body: JSON.stringify({ prompt: 'A simple upbeat pop song with a clear solo female lead vocal and light band backing. The singer sings exactly these lyrics, clearly, once through:\n' + original, music_length_ms: p.lengthMs || 30000 }) });
        const buf = Buffer.from(await r.arrayBuffer());
        out.steps.push('music: ' + r.status + ' ' + (r.headers.get('content-type') || '') + ' ' + buf.length + ' bytes' + (r.ok ? '' : ' ' + buf.toString('utf8').slice(0, 400)));
        if (r.ok) { audio = buf; kind = K.sniffAudio(buf); }
      } catch (e) { out.steps.push('music error: ' + e.message); }
    }
    if (!audio || !kind) {
      const r = await fetch(K.API + '/v1/text-to-speech/' + (p.voice || '21m00Tcm4TlvDq8ikWAM'), { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, signal: AbortSignal.timeout(120000),
        body: JSON.stringify({ text: original.replace(/\n/g, '. '), model_id: 'eleven_multilingual_v2' }) });
      const buf = Buffer.from(await r.arrayBuffer());
      out.steps.push('speech: ' + r.status + ' ' + (r.headers.get('content-type') || '') + ' ' + buf.length + ' bytes' + (r.ok ? '' : ' ' + buf.toString('utf8').slice(0, 400)));
      if (r.ok) { audio = buf; kind = K.sniffAudio(buf); out.usedSpeech = true; }
    }
    if (!audio || !kind) return { ...out, error: 'no test audio could be made' };
    out.sourceKind = kind.mime;
    let split = null;
    for (const variation of (p.variations || ['two_stems_v1', ''])) {
      try { split = await K.separate(audio, kind, variation); out.steps.push('split(' + (variation || 'default') + '): ok ' + split.contentType + ' ' + split.bytes + ' bytes; files: ' + split.names.join(', ') + '; vocals=' + split.vocals.name + ' music=' + split.instrumental.name); break; }
      catch (e) { out.steps.push('split(' + (variation || 'default') + ') failed: ' + String(e.message).slice(0, 700)); }
    }
    const forAlign = split ? split.vocals : { buf: audio, ...kind };
    try {
      const a = await K.align(forAlign.buf, forAlign, K.lyricLines(original).join('\n'));
      const t = K.buildTimings(original, rewrite, a);
      out.steps.push('align: ok words=' + a.words.length + ' loss=' + a.loss);
      out.quality = t.quality; out.lines = t.lines.map((l) => l.start + '-' + l.end + ' ' + l.text + (l.guessed ? ' (guessed)' : ''));
      out.firstWords = a.words.slice(0, 8).map((w) => w.text + '@' + w.start);
    } catch (e) { out.steps.push('align failed: ' + String(e.message).slice(0, 700)); }
    return out;
  }

  if (row.kind === 'karaoke-e2e') {
    // The whole Song Maker through the web routes: upload, wait, play link, fix timing, privacy.
    const K = require('./evalroom-karaoke')._internal;
    const base = `http://127.0.0.1:${port}/api/evalroom`;
    const run = 'k' + Date.now().toString(36);
    const A = R.signToken({ t: p.team || 'preview:' + run + '-a', n: p.teamName || 'Preview: ' + run, p: 1 }); const B = R.signToken({ t: 'preview:' + run + '-b', n: 'Preview: other', p: 1 });
    const steps = []; const step = (name, got, want, note) => steps.push((got === want ? 'PASS ' : 'FAIL ') + name + (got === want ? '' : ' (got ' + JSON.stringify(got) + ')') + (note ? ' [' + note + ']' : ''));
    const original = 'Morning light is on the stage\nEvery voice begins to sing\nHand in hand we turn the page\nHear the music that we bring';
    const rewrite = 'Luz del día on the stage\nMis amigos start to sing\nJuntos now we turn the page\nHear the música we bring';
    const mr = await fetch(K.API + '/v1/music', { method: 'POST', headers: { 'xi-api-key': K.elevenKey(), 'content-type': 'application/json' }, signal: AbortSignal.timeout(240000),
      body: JSON.stringify({ prompt: 'A simple upbeat pop song with a clear solo female lead vocal and light band backing. The singer sings exactly these lyrics, clearly, once through:\n' + original, music_length_ms: 30000 }) });
    const song = Buffer.from(await mr.arrayBuffer()); step('test song made', mr.status, 200);
    const form = (fields, file) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); if (file) f.append('song', new Blob([file.buf], { type: file.type }), file.name); return f; };
    const post = async (pth, token, body, json) => { const r = await fetch(base + pth, { method: 'POST', headers: { 'x-evalroom-token': token, ...(json ? { 'content-type': 'application/json' } : {}) }, body: json ? JSON.stringify(body) : body }); let d = {}; try { d = await r.json(); } catch (_) {} return { status: r.status, d }; };
    const get = async (pth, token) => { const r = await fetch(base + pth, { headers: token ? { 'x-evalroom-token': token } : {} }); let d = {}; try { d = await r.json(); } catch (_) {} return { status: r.status, d }; };
    const good = { title: p.title || 'Selftest song', original_lyrics: original, new_lyrics: rewrite, rights: 'true' };
    if (p.sample) {
      // Leave a finished sample in a team's Song Maker so a person can listen to it.
      const m = await post('/karaoke', A, form(good, { buf: song, type: 'audio/mpeg', name: 's.mp3' }));
      const sid = m.d.song && m.d.song.id; let s2 = null; const s0 = Date.now();
      while (sid && Date.now() - s0 < 240000) { s2 = await get('/karaoke/' + sid, A); if (['ready', 'failed'].includes(s2.d.song && s2.d.song.status)) break; await new Promise((r) => setTimeout(r, 3000)); }
      return { sample: true, id: sid, status: s2 && s2.d.song && s2.d.song.status, error: (m.d && m.d.error) || (s2 && s2.d.song && s2.d.song.error), lines: s2 && s2.d.lines && s2.d.lines.map((l) => l.start + '-' + l.end + ' ' + l.text) };
    }
    step('upload without the rights box is refused', (await post('/karaoke', A, form({ ...good, rights: 'false' }, { buf: song, type: 'audio/mpeg', name: 's.mp3' }))).status, 400);
    step('a file that is not audio is refused', (await post('/karaoke', A, form(good, { buf: Buffer.from('<html>not a song</html>'), type: 'audio/mpeg', name: 's.mp3' }))).status, 400);
    step('upload with no new lyrics is refused', (await post('/karaoke', A, form({ ...good, new_lyrics: '' }, { buf: song, type: 'audio/mpeg', name: 's.mp3' }))).status, 400);
    step('signed-out upload is refused', (await post('/karaoke', '', form(good, { buf: song, type: 'audio/mpeg', name: 's.mp3' }))).status, 401);
    const made = await post('/karaoke', A, form(good, { buf: song, type: 'audio/mpeg', name: 's.mp3' })); step('upload accepted', made.status, 200, made.d.error);
    const id = made.d.song && made.d.song.id; let st = null; const t0 = Date.now(); const seen = new Set();
    while (id && Date.now() - t0 < 240000) { st = await get('/karaoke/' + id, A); seen.add(st.d.song && st.d.song.status); if (['ready', 'failed'].includes(st.d.song && st.d.song.status)) break; await new Promise((r) => setTimeout(r, 3000)); }
    step('song became ready', st && st.d.song && st.d.song.status, 'ready', (st && st.d.song && (st.d.song.error || st.d.song.note)) || [...seen].join('>'));
    const secs = Math.round((Date.now() - t0) / 1000);
    if (st && st.d.audio_url) {
      const ar = await fetch(st.d.audio_url); const ab = Buffer.from(await ar.arrayBuffer());
      step('music-only track plays from its private link', ar.status === 200 && !!K.sniffAudio(ab), true, ab.length + ' bytes ' + ar.headers.get('content-type'));
      step('every new line has a time and words', st.d.lines.length === 4 && st.d.lines.every((l, i) => l.words.length > 0 && (i === 0 || l.start > st.d.lines[i - 1].start)), true);
      step('another team cannot open this song', (await get('/karaoke/' + id, B)).status, 404);
      step('another team does not see it in their list', ((await get('/karaoke', B)).d.songs || []).length, 0);
      step('bad tap timing is refused', (await post('/karaoke/' + id + '/timings', A, { starts: [1, 2] }, true)).status, 400);
      const fix = await post('/karaoke/' + id + '/timings', A, { starts: [10, 14, 18, 22] }, true); step('tap timing is saved', fix.status === 200 && fix.d.lines[1].start === 14, true);
      step('out-of-order taps are refused', (await post('/karaoke/' + id + '/timings', A, { starts: [5, 9, 4, 8] }, true)).status, 400);
      step('taps all at one moment are refused', (await post('/karaoke/' + id + '/timings', A, { starts: [5, 5, 5, 5] }, true)).status, 400);
      const back = await post('/karaoke/' + id + '/timings/reset', A, {}, true); step('go back to automatic timing', back.status === 200 && back.d.lines[0].start === st.d.lines[0].start, true);
      step('automatic timing was judged trustworthy', st.d.song.quality && st.d.song.quality.level, 'good', JSON.stringify(st.d.song.quality));
      step('another team cannot delete this song', (await post('/karaoke/' + id + '/delete', B, {}, true)).status, 404);
      step('another team cannot change the timing', (await post('/karaoke/' + id + '/timings', B, { starts: [1, 2, 3, 4] }, true)).status, 404);
      const pathPublic = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/public/evalroom-private/preview_${run}-a/karaoke/${id}/music.mp3`);
      step('the audio is not reachable without the private link', pathPublic.status >= 400, true, 'status ' + pathPublic.status);
    }
    if (id) {
      // The real-life mess: box 2 holds the whole song (pasted twice, with a stray fragment) but the recording is a short clip.
      const wait = async (sid, tk) => { let x = null; const w0 = Date.now(); while (sid && Date.now() - w0 < 240000) { x = await get('/karaoke/' + sid, tk); if (['ready', 'failed'].includes(x.d.song && x.d.song.status)) break; await new Promise((r) => setTimeout(r, 3000)); } return x; };
      const extra = 'Later on the curtain falls\nEverybody heads for home\nNo more echoes in the halls\nI am singing all alone';
      const messy = 'Hear the music that we bring\n' + original + '\n' + extra + '\n' + original + '\n' + extra; // 17 lines, only 4 are sung
      const eightNew = rewrite + '\nCae el telón at the end\nTodos go back to their home\nNo more ecos in the hall\nCanto solo, all alone';
      const C = R.signToken({ t: 'preview:' + run + '-c', n: 'Preview: clip', p: 1 });
      const mc = await post('/karaoke', C, form({ ...good, title: 'Clip of a longer song', original_lyrics: messy, new_lyrics: eightNew }, { buf: song, type: 'audio/mpeg', name: 's.mp3' }));
      const cs = await wait(mc.d.song && mc.d.song.id, C); const cq = (cs && cs.d.song && cs.d.song.quality) || {};
      step('clip with a long messy paste: finds the 4 sung lines', cq.sungLines, 4, JSON.stringify({ mode: cq.mode, heard: cq.heardWords, matched: cq.matchedHeardPct, shown: cq.linesShown, left: cq.linesLeftOut, level: cq.level, reasons: cq.reasons }));
      const good4 = st.d.lines.map((l) => l.start); const got4 = ((cs && cs.d.lines) || []).map((l) => l.start);
      step('clip: the first 4 new lines land where the clean run put them (within 1 second)', got4.length === 4 && got4.every((x, k) => Math.abs(x - good4[k]) <= 1), true, 'clean ' + good4.join(',') + ' vs messy ' + got4.join(','));
      step('clip: the extra new lines are left out and the team is told', cq.linesLeftOut, 4);
      // Box 2 left empty: the room goes by ear.
      const D = R.signToken({ t: 'preview:' + run + '-d', n: 'Preview: by ear', p: 1 });
      const md = await post('/karaoke', D, form({ ...good, title: 'By ear', original_lyrics: '' }, { buf: song, type: 'audio/mpeg', name: 's.mp3' }));
      const ds = await wait(md.d.song && md.d.song.id, D); const dq = (ds && ds.d.song && ds.d.song.quality) || {};
      step('box 2 empty: the room goes by ear and still makes a playable song', ds && ds.d.song && ds.d.song.status === 'ready' && dq.mode === 'heard-only' && (ds.d.lines || []).length >= 2, true, JSON.stringify({ mode: dq.mode, shown: dq.linesShown, heard: (dq.heard || '').slice(0, 160), lines: ((ds && ds.d.lines) || []).map((l) => l.start) }));
      // Completely wrong lyrics: the room must not pretend they fit.
      const wrongLyrics = 'Purple elephants are dancing on the ceiling of the kitchen\nSeventeen umbrellas float across a field of frozen butter\nMy accountant plays the tuba every Wednesday after breakfast\nNobody remembers where the yellow submarine was parked';
      const E = R.signToken({ t: 'preview:' + run + '-e', n: 'Preview: wrong lyrics', p: 1 });
      const bad = await post('/karaoke', E, form({ ...good, title: 'Wrong lyrics', original_lyrics: wrongLyrics }, { buf: song, type: 'audio/mpeg', name: 's.mp3' }));
      const bs = await wait(bad.d.song && bad.d.song.id, E); const bq = (bs && bs.d.song && bs.d.song.quality) || {};
      step('wrong lyrics in box 2: the room goes by ear instead and says so', bq.mode, 'heard-instead', JSON.stringify({ sung: bq.sungLines, matched: bq.matchedHeardPct, shown: bq.linesShown, lines: ((bs && bs.d.lines) || []).map((l) => l.start) }));
      // ── Karaoke video ──
      step('another team cannot see the video', (await get('/karaoke/' + id + '/video', B)).status, 404);
      step('another team cannot start a video', (await post('/karaoke/' + id + '/video', B, {}, true)).status, 404);
      step('no video before one is asked for', (await get('/karaoke/' + id + '/video', A)).d.status, 'none');
      const v0 = await post('/karaoke/' + id + '/video', A, {}, true); step('video starts', v0.d.status, 'working', v0.d.error);
      let vv = null; const tv = Date.now();
      for (let k = 0; k < 60; k++) { await new Promise((r2) => setTimeout(r2, 3000)); vv = await get('/karaoke/' + id + '/video', A); if (vv.d.status !== 'working') break; }
      step('video becomes ready', vv && vv.d.status, 'ready', Math.round((Date.now() - tv) / 1000) + 's ' + ((vv && vv.d.error) || ''));
      if (vv && vv.d.download_url) {
        const dl = await fetch(vv.d.download_url); const vb = Buffer.from(await dl.arrayBuffer());
        step('video downloads as an MP4', dl.status === 200 && vb.slice(4, 8).toString('latin1') === 'ftyp' && vb.length > 40000, true, vb.length + ' bytes, ' + (dl.headers.get('content-disposition') || ''));
        step('asking again reuses the same video', (await post('/karaoke/' + id + '/video', A, {}, true)).d.status, 'ready');
      }
      // ── Song points for a song made in the room ──
      step('song points need locked lyrics first', (await post('/stage/lyric/room-song', A, { kind: 'karaoke', id }, true)).status, 404);
      const rr = await post('/rehearse/lyric', A, { text: rewrite + '\n' + rewrite.split('\n').reverse().join('\n') }, true);
      const lk = await post('/stage/lyric', A, { rehearsal_id: rr.d.id, confirm: 'true' }, true); step('lyrics locked for the points test', lk.status, 200, 'score ' + (lk.d.lock && lk.d.lock.score));
      step('another team cannot turn in this song', (await post('/stage/lyric/room-song', B, { kind: 'karaoke', id }, true)).status, 404);
      step('a made-up song id is refused', (await post('/stage/lyric/room-song', A, { kind: 'karaoke', id: '00000000-0000-4000-8000-000000000000' }, true)).status, 404);
      step('a wrong kind is refused', (await post('/stage/lyric/room-song', A, { kind: 'suno', id }, true)).status, 400);
      const ti = await post('/stage/lyric/room-song', A, { kind: 'karaoke', id }, true);
      step('turning in the room-made song adds 10', ti.d.lock && ti.d.lock.total - ti.d.lock.score, 10, ti.d.error);
      step('a second turn-in is refused', (await post('/stage/lyric/room-song', A, { kind: 'karaoke', id }, true)).status, 409);
      // A song whose words are not the locked lyrics earns nothing.
      const F = R.signToken({ t: 'preview:' + run + '-f', n: 'Preview: other words', p: 1 });
      const fr = await post('/rehearse/lyric', F, { text: 'Purple elephants are dancing on the ceiling\nSeventeen umbrellas float across the butter\nMy accountant plays the tuba every Wednesday\nNobody remembered where the ladder went' }, true);
      await post('/stage/lyric', F, { rehearsal_id: fr.d.id, confirm: 'true' }, true);
      const { data: mine } = await R.supabase.from('evalroom_karaoke').select('instrumental_path, timings, duration_s').eq('id', id).single();
      const { data: fsong } = await R.supabase.from('evalroom_karaoke').insert({ team_key: 'preview:' + run + '-f', team_name: 'Preview: other words', title: 'Other words', original_lyrics: original, new_lyrics: rewrite, status: 'ready', instrumental_path: mine.instrumental_path, timings: mine.timings, duration_s: mine.duration_s }).select('id').single();
      const mm = await post('/stage/lyric/room-song', F, { kind: 'karaoke', id: fsong.id }, true); step('a song with different words earns no points', mm.status, 400, mm.d.error);
      await R.supabase.from('evalroom_karaoke').update({ status: 'deleted', instrumental_path: null }).eq('id', fsong.id);
      for (const [x, tk] of [[mc, C], [md, D], [bad, E]]) if (x.d.song) await post('/karaoke/' + x.d.song.id + '/delete', tk, {}, true);
      step('a song that was turned in for points cannot be deleted', (await post('/karaoke/' + id + '/delete', A, {}, true)).status, 409);
      // Tidy up: release this run's practice locks so the test song can be removed.
      await R.supabase.from('evalroom_practice_locks').update({ reset_at: new Date().toISOString(), reset_note: 'selftest tidy-up' }).like('team_key', 'preview:' + run + '-%').is('reset_at', null);
      const del = await post('/karaoke/' + id + '/delete', A, {}, true); step('team can delete its song', del.status, 200);
      step('deleted song is gone', (await get('/karaoke/' + id, A)).status, 404);
      const { data: left } = await R.supabase.storage.from('evalroom-private').list(`preview_${run}-a/karaoke/${id}`);
      step('deleted audio is removed from storage', (left || []).length, 0);
    }
    return { passed: steps.filter((x) => x.startsWith('PASS')).length, total: steps.length, steps, secondsToReady: secs, lines: st && st.d.lines && st.d.lines.map((l) => l.start + '-' + l.end + ' ' + l.text), quality: st && st.d.song && st.d.song.quality };
  }

  if (row.kind === 'cover-schema') {
    // What the singing model accepts, read from the service itself.
    const C = require('./evalroom-cover')._internal;
    const f = await C.inputFields();
    return { model: C.MODEL, fields: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, { type: v.type || (v.allOf ? 'enum' : ''), d: String(v.description || '').slice(0, 260), def: v.default, max: v.maxLength, min: v.minLength, format: v.format }])) };
  }

  if (row.kind === 'cover') {
    // Makes a short test song, asks the singer to re-sing it with new words, then listens to what came back.
    const C = require('./evalroom-cover')._internal; const K = require('./evalroom-karaoke')._internal;
    const out = { steps: [] };
    const original = p.original || 'Morning light is on the stage\nEvery voice begins to sing\nHand in hand we turn the page\nHear the music that we bring';
    const rewrite = p.rewrite || 'Luz del día on the stage\nMis amigos start to sing\nJuntos now we turn the page\nHear the música we bring';
    const r = await fetch(K.API + '/v1/music', { method: 'POST', headers: { 'xi-api-key': K.elevenKey(), 'content-type': 'application/json' }, signal: AbortSignal.timeout(240000),
      body: JSON.stringify({ prompt: 'A simple upbeat pop song with a clear solo female lead vocal and light band backing. The singer sings exactly these lyrics, clearly, once through:\n' + original, music_length_ms: p.lengthMs || 30000 }) });
    const src = Buffer.from(await r.arrayBuffer()); const kind = r.ok && K.sniffAudio(src);
    out.steps.push('test song: ' + r.status + ' ' + src.length + ' bytes');
    if (!kind) return { ...out, error: 'no test song' };
    const spath = 'selftest/sung/' + row.id + '/source.' + kind.ext;
    const up = await R.supabase.storage.from('evalroom-private').upload(spath, src, { contentType: kind.mime, upsert: true });
    if (up.error) return { ...out, error: 'storage ' + up.error.message };
    try {
      const { data: signed } = await R.supabase.storage.from('evalroom-private').createSignedUrl(spath, 3600);
      const style = C.STYLES[p.style || 'kpop_boy'];
      const res = await C.sing(signed.signedUrl, style.prompt, rewrite);
      out.steps.push('sing: ok in ' + res.seconds + 's, lyrics sent=' + res.usedLyrics + ', fields=' + res.fields.join(','));
      const got = await fetch(res.url, { signal: AbortSignal.timeout(120000) });
      const audio = Buffer.from(await got.arrayBuffer()); const ak = K.sniffAudio(audio);
      out.steps.push('result: ' + got.status + ' ' + (got.headers.get('content-type') || '') + ' ' + audio.length + ' bytes, kind=' + (ak && ak.mime));
      out.outputHost = new URL(res.url).host;
      if (ak) {
        try { const heard = await K.transcribe(audio, ak); out.heard = (heard.text || (heard.words || []).map((w) => w.text).join(' ')).slice(0, 600); out.lastWordEnd = heard.words && heard.words.length ? heard.words[heard.words.length - 1].end : null; } catch (e) { out.steps.push('listen failed: ' + String(e.message).slice(0, 300)); }
        if (p.keep) { const kp = 'selftest/sung/' + row.id + '/result.' + ak.ext; await R.supabase.storage.from('evalroom-private').upload(kp, audio, { contentType: ak.mime, upsert: true }); out.kept = kp; }
      }
    } catch (e) { out.steps.push('sing failed: ' + String(e.message).slice(0, 900)); }
    finally { if (!p.keep) await R.supabase.storage.from('evalroom-private').remove([spath]).catch(() => {}); }
    return out;
  }

  if (row.kind === 'cover-listen') {
    // Listens to a finished recording and reports which of the lyric lines can be heard in it.
    const K = require('./evalroom-karaoke')._internal;
    const { data: c, error } = await R.supabase.from('evalroom_covers').select('lyrics, audio_path').eq('id', p.id).single();
    if (error || !c || !c.audio_path) throw new Error('no recording');
    const dl = await R.supabase.storage.from('evalroom-private').download(c.audio_path);
    if (dl.error) throw new Error(dl.error.message);
    const audio = Buffer.from(await dl.data.arrayBuffer()); const ak = K.sniffAudio(audio);
    const heard = await K.transcribe(audio, ak);
    const words = (heard.words || []).filter((w) => !w.type || w.type === 'word');
    const norm = (t) => String(t).toLowerCase().normalize('NFD').replace(/[^a-z0-9\s]/g, '').trim();
    const hw = words.map((w) => norm(w.text)).filter(Boolean);
    let at = 0; const lines = [];
    for (const line of K.lyricLines(c.lyrics)) {
      const lw = norm(line).split(/\s+/).filter(Boolean); let hit = 0; let pos = at; let first = null;
      for (const w of lw) { const i = hw.indexOf(w, pos); if (i !== -1 && i - pos < 12) { hit++; if (first === null) first = i; pos = i + 1; } }
      if (hit) at = pos;
      lines.push({ line, heardPct: Math.round(100 * hit / (lw.length || 1)), at: first !== null && words[first] ? words[first].start : null });
    }
    return { bytes: audio.length, heardText: (heard.text || '').slice(0, 2500), lastWordEnd: words.length ? words[words.length - 1].end : null, lines };
  }

  if (row.kind === 'vimeo') {
    // Can this Vimeo account take a video from the site, keep it off vimeo.com, and play it only on our pages?
    const tok = process.env.VIMEO_ACCESS_TOKEN; if (!tok) return { error: 'VIMEO_ACCESS_TOKEN is not set on this service' };
    const H = { Authorization: 'bearer ' + tok.trim(), Accept: 'application/vnd.vimeo.*+json;version=3.4' };
    const api = async (method, pth, body) => { const r = await fetch('https://api.vimeo.com' + pth, { method, headers: { ...H, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) }); let d = null; const t = await r.text(); try { d = t ? JSON.parse(t) : null; } catch (_) { d = { raw: t.slice(0, 300) }; } return { s: r.status, d }; };
    const out = { steps: [] }; const note = (name, r, extra) => out.steps.push(name + ': ' + r.s + (r.s >= 400 ? ' ' + JSON.stringify({ error: r.d && (r.d.error || r.d.raw), dev: r.d && r.d.developer_message, code: r.d && r.d.error_code }).slice(0, 400) : '') + (extra ? ' ' + extra : ''));
    const me = await api('GET', '/me?fields=account,upload_quota,uri');
    note('who am I', me, me.d && JSON.stringify({ plan: me.d.account, quota: me.d.upload_quota && { space: me.d.upload_quota.space && { free: me.d.upload_quota.space.free, max: me.d.upload_quota.space.max }, periodic: me.d.upload_quota.periodic && { free: me.d.upload_quota.periodic.free, max: me.d.upload_quota.periodic.max, reset: me.d.upload_quota.periodic.reset_date } } }));
    const scopes = await api('GET', '/oauth/verify?fields=scope'); note('token permissions', scopes, scopes.d && String(scopes.d.scope));
    if (me.s !== 200 || p.only === 'check') return out;
    // A five-second test picture with a beep, made here.
    const V = require('./evalroom-video')._internal; const os = require('os'); const { execFileSync } = require('child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vim-')); const f = path.join(dir, 't.mp4');
    execFileSync(V.ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=640x360:rate=20', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', f]);
    const buf = fs.readFileSync(f); fs.rmSync(dir, { recursive: true, force: true });
    const made = await api('POST', '/me/videos', { upload: { approach: 'tus', size: String(buf.length) }, name: 'TopKpop upload test (safe to delete)', description: 'Made by the Evaluation Room test runner.', privacy: { view: 'disable', embed: 'whitelist', download: false } });
    note('create video (hidden from vimeo.com, embed on listed sites only)', made, made.d && made.d.uri);
    let v = made;
    if (made.s >= 400) { // the privacy we want may not be on this plan: learn which part by trying plainer settings
      const plain = await api('POST', '/me/videos', { upload: { approach: 'tus', size: String(buf.length) }, name: 'TopKpop upload test (safe to delete)', privacy: { view: 'unlisted' } });
      note('create video (unlisted only)', plain, plain.d && plain.d.uri); v = plain;
    }
    if (v.s >= 400 || !v.d || !v.d.upload || !v.d.upload.upload_link) return out;
    const up = await fetch(v.d.upload.upload_link, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: buf, signal: AbortSignal.timeout(120000) });
    out.steps.push('send the file: ' + up.status + ' offset ' + up.headers.get('upload-offset') + ' of ' + buf.length);
    const id = String(v.d.uri).split('/').pop(); out.videoId = id;
    for (const dom of p.domains || ['topkpop.io', 'www.topkpop.io', 'evaluation-room-preview-production.up.railway.app']) note('allow ' + dom, await api('PUT', '/videos/' + id + '/privacy/domains/' + dom));
    if (v === made) { /* already set at creation */ } else note('set embed to listed sites only', await api('PATCH', '/videos/' + id, { privacy: { view: 'disable', embed: 'whitelist' } }));
    let st = null;
    for (let k = 0; k < 30; k++) { await new Promise((r2) => setTimeout(r2, 5000)); st = await api('GET', '/videos/' + id + '?fields=uri,link,player_embed_url,status,transcode.status,upload.status,privacy.view,privacy.embed,duration'); if (st.d && st.d.transcode && st.d.transcode.status !== 'in_progress') break; }
    note('ready to play', st, st.d && JSON.stringify({ status: st.d.status, transcode: st.d.transcode, privacy: st.d.privacy, duration: st.d.duration, embed: st.d.player_embed_url, link: st.d.link }));
    const doms = await api('GET', '/videos/' + id + '/privacy/domains'); note('allowed sites', doms, doms.d && JSON.stringify((doms.d.data || []).map((x) => x.domain)));
    if (st.d && st.d.player_embed_url) {
      const tryEmbed = async (ref) => { const r = await fetch(st.d.player_embed_url, { headers: ref ? { Referer: ref } : {}, signal: AbortSignal.timeout(30000) }); const t = await r.text(); return r.status + (/isn.t available|private|not allowed|privacy/i.test(t) ? ' (blocked message)' : ' (player page)'); };
      out.steps.push('player opened from topkpop.io: ' + await tryEmbed('https://www.topkpop.io/pages/evaluation-room/'));
      out.steps.push('player opened from another site: ' + await tryEmbed('https://example.com/'));
      out.steps.push('player opened with no site: ' + await tryEmbed(null));
    }
    if (!p.keep) note('delete the test video', await api('DELETE', '/videos/' + id));
    return out;
  }

  if (row.kind === 'refit') {
    // Re-run the syllable comparison on an answer that is already stored (no AI call).
    const { data, error } = await R.supabase.from('evalroom_selftest').select('payload, result').eq('id', p.id).single();
    if (error) throw new Error(error.message);
    const copy = cleanCopy(data.result.raw);
    return { of: p.id, foundCleanCopy: !!copy, model: data.result.model, fit: copy ? await compare(data.payload.original, copy, data.payload.vocab) : null };
  }

  if (row.kind === 'http') {
    // Calls this same server the way a browser (or an intruder) would.
    const headers = { ...(p.headers || {}) };
    let body;
    if (p.token) headers['x-evalroom-token'] = p.token === 'mint' ? R.signToken({ t: p.team_key || 'preview:selftest', n: 'Preview: Selftest', p: 1 }) : p.token;
    if (p.form) {
      body = new FormData();
      for (const [k, v] of Object.entries(p.form.fields || {})) body.append(k, v);
      for (const [k, v] of Object.entries(p.form.files || {})) {
        const buf = v.fixture ? fs.readFileSync(path.join(FIXTURES, path.basename(v.fixture))) : Buffer.from(v.text || '', 'utf8');
        body.append(k, new Blob([buf], { type: v.type || 'application/octet-stream' }), v.name || 'file');
      }
    } else if (p.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(p.json);
    }
    const t0 = Date.now();
    const out = [];
    const times = Math.min(p.repeat || 1, 40);
    for (let i = 0; i < times; i++) {
      const r = await fetch(`http://127.0.0.1:${port}${p.path}`, { method: p.method || 'GET', headers, body });
      const text = await r.text();
      out.push({ status: r.status, type: r.headers.get('content-type'), jeannieModel: r.headers.get('x-jeannie-model') || undefined, body: text.slice(0, p.keep || 1500) });
    }
    return { ms: Date.now() - t0, responses: times === 1 ? undefined : out.map((o) => o.status), ...out[out.length - 1] };
  }

  throw new Error('Unknown test kind: ' + row.kind);
}

async function tick(port) {
  if (running >= MAX_PARALLEL) return;
  const { data, error } = await R.supabase.from('evalroom_selftest').select('id').eq('status', 'pending').order('id', { ascending: true }).limit(MAX_PARALLEL - running);
  if (error || !data || !data.length) return;
  for (const { id } of data) {
    // Claim the case so it only runs once.
    const { data: claimed } = await R.supabase.from('evalroom_selftest')
      .update({ status: 'running', started_at: new Date().toISOString() }).eq('id', id).eq('status', 'pending').select('*');
    if (!claimed || !claimed.length) continue;
    running++;
    runCase(claimed[0], port)
      .then((result) => R.supabase.from('evalroom_selftest').update({ status: 'done', result, finished_at: new Date().toISOString() }).eq('id', id))
      .catch((err) => R.supabase.from('evalroom_selftest').update({ status: 'error', result: { error: String(err && err.message || err).slice(0, 800), status: err && err.status }, finished_at: new Date().toISOString() }).eq('id', id))
      .finally(() => { running--; });
  }
}

function startSelftestRunner(port) {
  if (!R.PREVIEW_MODE) return;
  console.log('Evaluation Room: preview test runner is on.');
  // Anything left "running" by a restart goes back in the queue.
  R.supabase.from('evalroom_selftest').update({ status: 'pending', started_at: null }).eq('status', 'running').then(() => {});
  setInterval(() => { tick(port).catch((e) => console.error('selftest tick error:', e.message)); }, 4000);
}

module.exports = { startSelftestRunner };
