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
      if (process.env.VIMEO_ACCESS_TOKEN) {
        step('sharing a video needs the agree box', (await post('/wall/share', A, { kind: 'karaoke', id }, true)).status, 400);
        const ws = await post('/wall/share', A, { kind: 'karaoke', id, confirm: 'true', public_ok: 'false' }, true);
        step('karaoke video shared on the wall adds 25', ws.d.bonus, 25, ws.d.error);
        step('the shared video has a player on the game\'s Vimeo', /^https:\/\/player\.vimeo\.com\/video\/\d+/.test((ws.d.item && ws.d.item.embed) || ''), true);
        const wl = await get('/wall', B); const seen = (wl.d.items || []).find((x) => ws.d.item && x.id === ws.d.item.id);
        step('another team sees it on the wall but cannot take it down', !!seen && seen.mine === false && (await post('/wall/' + ws.d.item.id + '/remove', B, {}, true)).status === 404, true);
        const st2 = await get('/stage', A); step('lyric score now carries song + wall points', st2.d.locks.lyric && st2.d.locks.lyric.bonus, 35);
        step('team takes its video down', (await post('/wall/' + ws.d.item.id + '/remove', A, {}, true)).status, 200);
        const st3 = await get('/stage', A); step('wall points come off again', st3.d.locks.lyric && st3.d.locks.lyric.bonus, 10);
      }
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
    const raw = String(tok); const t0 = raw.trim();
    const shape = { length: raw.length, trimmedLength: t0.length, onlyLettersAndNumbers: /^[A-Za-z0-9]+$/.test(t0), looksLikeHex: /^[0-9a-f]+$/i.test(t0), hasSpacesInside: /\s/.test(t0), hasQuotes: /["'\u201c\u201d]/.test(raw), startsWithBearer: /^bearer/i.test(t0), hasSlashOrPlus: /[\/+=]/.test(t0) };
    const out = { tokenShape: shape, steps: [] }; const note = (name, r, extra) => out.steps.push(name + ': ' + r.s + (r.s >= 400 ? ' ' + JSON.stringify({ error: r.d && (r.d.error || r.d.raw), dev: r.d && r.d.developer_message, code: r.d && r.d.error_code }).slice(0, 400) : '') + (extra ? ' ' + extra : ''));
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

  if (row.kind === 'scheduleflow') {
    // Troves open on a schedule: the room and the Trove pages both hold a closed Trove shut.
    const site = `http://127.0.0.1:${port}`; const base = site + '/api/evalroom';
    const A = R.signToken({ t: 'preview:sched' + Date.now().toString(36), n: 'Preview: schedule', p: 1 });
    const org = { 'x-organizer-password': process.env.ADMIN_PASSWORD || '', 'content-type': 'application/json' };
    const call = async (method, pth, token, json) => { const headers = {}; if (token) headers['x-evalroom-token'] = token; let body; if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); } const r = await fetch(base + pth, { method, headers, body }); let d = {}; try { d = await r.json(); } catch (_) {} return { status: r.status, d }; };
    const page = async (pth) => { const r = await fetch(site + pth); return { status: r.status, text: await r.text() }; };
    const steps = []; const step = (name, got, want, note) => steps.push((got === want ? 'PASS ' : 'FAIL ') + name + (got === want ? '' : ' (got ' + JSON.stringify(got) + ')') + (note ? ' [' + note + ']' : ''));
    const S = require('./evalroom-schedule')._internal;
    step('a summer date opens at 7:00 PM Pacific', new Date(S.unlockInstant('2026-05-24')).toISOString(), '2026-05-25T02:00:00.000Z');
    step('a winter date opens at 7:00 PM Pacific', new Date(S.unlockInstant('2026-12-06')).toISOString(), '2026-12-07T03:00:00.000Z');
    step('a Trove with no date is open', S.build({ 1: null }, Date.now())[1].open, true);
    const far = '2099-01-01';
    try {
      const s0 = await call('GET', '/schedule'); step('with no practice schedule every Trove is open', [1, 2, 3].every((n) => s0.d.troves && s0.d.troves[n].open), true);
      step('setting a practice schedule needs the organizer password', (await fetch(base + '/organizer/practice-schedule', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trove2: far }) })).status, 404);
      const set = await fetch(base + '/organizer/practice-schedule', { method: 'POST', headers: org, body: JSON.stringify({ trove1: '2020-01-01', trove2: far, trove3: far }) }); step('organizer sets a practice schedule', set.status, 200);
      const s1 = await call('GET', '/schedule'); step('Trove 01 open, 02 and 03 locked', [s1.d.troves[1].open, s1.d.troves[2].open, s1.d.troves[3].open].join(','), 'true,false,false');
      const r2 = await call('POST', '/rehearse/lyric', A, { text: 'la la la' }); step('rehearsing a locked Trove is refused', r2.status, 423); step('the refusal says when it opens', /opens/.test(r2.d.error || '') && !!r2.d.opensAt, true);
      step('the Songwriting Studio is held shut with Trove 02', (await call('POST', '/studio/chat', A, { messages: [{ role: 'user', content: 'hi' }] })).status, 423);
      step('taking the stage for a locked Trove is refused', (await call('POST', '/stage/lesson', A, { rehearsal_id: 'x', confirm: 'true' })).status, 423);
      step('turning in a Trove 02 extra is refused', (await call('POST', '/extras/video', A, { kind: 'avatar-performance' })).status, 423);
      step('an open Trove is not held back', (await call('POST', '/rehearse/visual', A, {})).status !== 423, true);
      for (const v of ['/Rehearse/lyric', '/rehearse/lyric/', '/rehearse/%6Cyric', '/Studio/chat', '/KARAOKE', '/extras/video/', '/stage/check-song']) step('a closed Trove stays shut at ' + v, (await call('POST', v, A, {})).status, 423);
      step('sharing closed-Trove work on the wall is refused', (await call('POST', '/wall/share', A, { kind: 'song', confirm: 'true' })).status, 423);
      for (const v of ['/pages/trove-02//', '/pages//trove-02/', '/pages/trove-0%32/', '/pages/trove%2D02/', '/pages/trove-02/%69ndex.html', '/pages/missions/../trove-02/', '/pages/TROVE-02/']) { const pv = await page(v); step('a closed Trove page stays shut at ' + v, !/Lyric Judge/.test(pv.text), true); }
      const p2 = await page('/pages/trove-02'); step('a locked Trove page shows the locked chest, not the directions', p2.status === 200 && /is still locked|still locked/.test(p2.text) && !/Lyric Judge/.test(p2.text), true);
      const p2b = await page('/pages/trove-02/index.html'); step('the direct file address is locked too', /still locked/.test(p2b.text) && !/Lyric Judge/.test(p2b.text), true);
      const p1 = await page('/pages/trove-01/'); step('an open Trove page shows its directions', /Visual Judge/.test(p1.text), true);
      step('reading the wall and the schedule still works while Troves are locked', (await call('GET', '/wall', A)).status, 200);
      step('with no accusation dates nothing is scheduled and nothing is revealed', s1.d.accusation && s1.d.accusation.unscheduled === true && s1.d.accusation.open === false && s1.d.reveal && s1.d.reveal.open === false, true);
      const S2 = require('./evalroom-schedule'); const mk = (d) => S2({ supabase: null, PREVIEW_MODE: true }); const sx = mk(); sx.setPractice({ accOpen: '2020-01-01', accClose: '2020-01-03' });
      step('a window that closed long ago with no reveal counts as not scheduled, not closed', (await sx.game()).accusation.unscheduled, true);
      const now0 = new Date(); const ymd = (dt) => dt.toISOString().slice(0, 10); sx.setPractice({ accOpen: ymd(new Date(now0 - 5 * 86400000)), accClose: ymd(new Date(now0.getTime() + 5 * 86400000)) });
      step('a window around today is open', (await sx.game()).accusation.open, true);
      sx.setPractice({ accOpen: ymd(new Date(now0 - 9 * 86400000)), accClose: ymd(new Date(now0 - 4 * 86400000)) });
      step('a window that closed a few days ago shows as closed', (await sx.game()).accusation.closed, true);
      const rv0 = await fetch(site + '/pages/final-reveal/', { redirect: 'manual' }); step('the reveal page is shut before the saboteur is announced', rv0.status, 302);
      const rv0b = await fetch(site + '/pages/Final-Reveal/index.html', { redirect: 'manual' }); step('however its address is spelled', rv0b.status === 302 || rv0b.status === 404, true);
      await fetch(base + '/organizer/practice-schedule', { method: 'POST', headers: org, body: JSON.stringify({ trove1: '2020-01-01', accusation_open: far, accusation_close: '2099-01-03' }) });
      const g1 = await call('GET', '/schedule'); step('a future accusation date shows as not yet open', g1.d.accusation.notYet === true && g1.d.accusation.open === false && !!g1.d.accusation.opensAt, true);
      await fetch(base + '/organizer/practice-schedule', { method: 'POST', headers: org, body: JSON.stringify({ accusation_open: '2020-01-01', accusation_close: '2020-01-03', revealed: true }) });
      const g2 = await call('GET', '/schedule'); step('a past close date shows as closed, and the reveal as out', g2.d.accusation.closed === true && g2.d.reveal.open === true, true);
      const rv1 = await fetch(site + '/pages/final-reveal/', { redirect: 'manual' }); step('once announced the reveal page opens', rv1.status, 200);
      const fa = await page('/pages/final-accusation/'); step('the accusation page links to the suspects and follows the schedule', /\/pages\/suspects/.test(fa.text) && /api\/evalroom\/schedule/.test(fa.text) && !/isOpen = true/.test(fa.text), true);
      const ms = await page('/pages/missions/'); step('Missions ends with the Final Accusation step', /accusationCta/.test(ms.text) && /missions-status\.js/.test(ms.text), true);
    } finally {
      await fetch(base + '/organizer/practice-schedule', { method: 'POST', headers: org, body: JSON.stringify({ clear: true }) }).catch(() => {});
    }
    const s2 = await call('GET', '/schedule'); step('after clearing, every Trove is open again', [1, 2, 3].every((n) => s2.d.troves && s2.d.troves[n].open), true);
    const p3 = await page('/pages/trove-02/'); step('and the Trove 02 page shows its directions again', /Lyric Judge/.test(p3.text), true);
    return { passed: steps.filter((x) => x.startsWith('PASS')).length, total: steps.length, steps };
  }
  if (row.kind === 'extrasflow') {
    // Extra tasks and the wider wall, through the web routes.
    const base = `http://127.0.0.1:${port}/api/evalroom`;
    const run = 'x' + Date.now().toString(36);
    const tok = (k) => R.signToken({ t: 'preview:' + run + '-' + k, n: 'Preview: extras ' + k, p: 1 });
    const A = tok('a'); const B = tok('b');
    const org = { 'x-organizer-password': process.env.ADMIN_PASSWORD || '' };
    const call = async (method, pth, token, json, form, extra) => { const headers = { ...(extra || {}) }; if (token) headers['x-evalroom-token'] = token; let body; if (form) body = form; else if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); } const r = await fetch(base + pth, { method, headers, body }); let d = {}; try { d = await r.json(); } catch (_) {} return { status: r.status, d }; };
    const steps = []; const step = (name, got, want, note) => steps.push((got === want ? 'PASS ' : 'FAIL ') + name + (got === want ? '' : ' (got ' + JSON.stringify(got) + ')') + (note ? ' [' + note + ']' : ''));
    const pics = () => { const f = new FormData(); for (const [k, n] of [['avatar', 'avatar_good.png'], ['poster', 'poster_good.png']]) f.append(k, new Blob([fs.readFileSync(path.join(FIXTURES, n))], { type: 'image/png' }), n); return f; };
    const bonusOf = async (j) => { const s = await call('GET', '/stage', A); return s.d.locks && s.d.locks[j] ? s.d.locks[j].bonus : null; };
    const lockOf = async (j) => { const s = await call('GET', '/stage', A); return s.d.locks && s.d.locks[j]; };
    const story = 'Our name comes from the lighthouse beside our school. Every morning its beam reminds us to guide each other. We chose it the day our team first met.';
    // A two-second test video made on the spot.
    const vdir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'erx-'));
    await new Promise((res, rej) => { const p = require('child_process').spawn(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=2', '-pix_fmt', 'yuv420p', 'v.mp4'], { cwd: vdir, stdio: 'ignore' }); p.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg ' + c)))); p.on('error', rej); });
    const vbuf = fs.readFileSync(path.join(vdir, 'v.mp4')); fs.rmSync(vdir, { recursive: true, force: true });
    const vform = (kind, buf, name, link) => { const f = new FormData(); f.append('kind', kind); if (buf) f.append('file', new Blob([buf], { type: 'video/mp4' }), name); if (link) f.append('link', link); return f; };

    step('signed-out visitor cannot see extra tasks', (await call('GET', '/extras')).status, 401);
    step('organizer extras list needs the password', (await call('GET', '/organizer/extras')).status, 401);
    const e00 = await call('GET', '/extras', A); step('room offers the Welcome Post', e00.d.welcome && e00.d.welcome.done === false && e00.d.welcome.bonus === 25, true);
    step('an empty Welcome Post is refused', (await call('POST', '/extras/welcome', A, { text: 'hi' })).status, 400);
    const wp = await call('POST', '/extras/welcome', A, { text: 'https://www.instagram.com/p/example-welcome/' }); step('Welcome Post turned in, 25 points', wp.d.bonus, 25, wp.d.error);
    step('Welcome Post a second time is refused', (await call('POST', '/extras/welcome', A, { text: 'DM sent - @persona' })).status, 409);
    step('room no longer offers the Welcome Post', ((await call('GET', '/extras', A)).d.welcome || {}).done, true);
    if (process.env.ADMIN_PASSWORD) {
      const ow = await call('GET', '/organizer/extras', null, null, null, org); const wi = (ow.d.items || []).find((x) => x.kind === 'welcome' && /extras a$/.test(x.team || '') && !x.removedAt);
      step('organizer sees the Welcome Post', !!wi, true);
      step('organizer removes the Welcome Post', (await call('POST', '/organizer/extras/remove', null, { id: wi && wi.id, note: 'selftest' }, null, org)).status, 200);
      step('after removal the room offers it again', ((await call('GET', '/extras', A)).d.welcome || {}).done, false);
    }
    step('story before taking the stage is refused', (await call('POST', '/extras/lore', A, { text: story })).status, 404);

    // Trove 01
    const r1 = await call('POST', '/rehearse/visual', A, null, pics()); const l1 = await call('POST', '/stage/visual', A, { rehearsal_id: r1.d.id, confirm: 'true' }); step('lock pictures', l1.status, 200);
    const e0 = await call('GET', '/extras', A); step('room offers the team name story', e0.d.lore && e0.d.lore.locked === true && e0.d.lore.item === null, true);
    step('one short line is refused', (await call('POST', '/extras/lore', A, { text: 'We like music.' })).status, 400);
    const lo = await call('POST', '/extras/lore', A, { text: story }); step('story turned in, 25 points', lo.d.bonus, 25, lo.d.error);
    step('locked score shows the 25', await bonusOf('visual'), 25);
    step('story a second time is refused', (await call('POST', '/extras/lore', A, { text: story })).status, 409);
    const ws = await call('POST', '/wall/share', A, { kind: 'pictures', confirm: 'true' }); step('sharing pictures adds on top (50)', ws.status === 200 && (await bonusOf('visual')), 50, ws.d.error);
    if (process.env.ADMIN_PASSWORD) {
      const ol = await call('GET', '/organizer/extras', null, null, null, org); step('organizer sees the story', !!(ol.d.items || []).find((x) => lo.d.item && x.id === lo.d.item.id && x.text === story), true);
      step('organizer removes the story', (await call('POST', '/organizer/extras/remove', null, { id: lo.d.item && lo.d.item.id, note: 'selftest' }, null, org)).status, 200);
      step('removing it again is refused', (await call('POST', '/organizer/extras/remove', null, { id: lo.d.item && lo.d.item.id }, null, org)).status, 404);
      step('only the story points come off (25 left)', await bonusOf('visual'), 25);
    }

    // Trove 02
    const r2 = await call('POST', '/rehearse/lyric', A, { text: SUITES.lyric[0].payload.text }); const l2 = await call('POST', '/stage/lyric', A, { rehearsal_id: r2.d.id, confirm: 'true' }); step('lock lyrics', l2.status, 200, l2.d.error);
    step('video with no file and no link is refused', (await call('POST', '/extras/video', A, null, vform('avatar-performance'))).status, 400);
    step('a link that is not https is refused', (await call('POST', '/extras/video', A, null, vform('avatar-performance', null, null, 'http://example.com/v'))).status, 400);
    step('a file that is not a video is refused', (await call('POST', '/extras/video', A, null, vform('avatar-performance', Buffer.from('this is not a video at all'), 'v.mp4'))).status, 400);
    step('a made-up kind is refused', (await call('POST', '/extras/video', A, null, vform('everything', vbuf, 'v.mp4'))).status, 400);
    step('a picture passed off as a video is refused', (await call('POST', '/extras/video', A, null, vform('avatar-performance', fs.readFileSync(path.join(FIXTURES, 'avatar_good.png')), 'v.mp4'))).status, 400);
    const pf = await call('POST', '/extras/video', A, null, vform('avatar-performance', vbuf, 'perf.mp4')); step('avatar performance video turned in, 25 points', pf.d.bonus, 25, pf.d.error);
    const kv = await call('POST', '/extras/video', A, null, vform('karaoke-video', null, null, 'https://youtu.be/example-karaoke')); step('outside karaoke video turned in as the song, 10 points', kv.d.bonus, 10, kv.d.error);
    const lk = await lockOf('lyric'); step('lyric lock shows 35 and the song place is taken', lk && lk.bonus === 35 && /^room:upload:/.test(lk.song_url || ''), true, JSON.stringify(lk && [lk.bonus, lk.song_url]));
    step('a second song is refused', (await call('POST', '/extras/video', A, null, vform('karaoke-video', null, null, 'https://youtu.be/another'))).status, 409);
    step('a Suno link after that is refused', (await call('POST', '/stage/lyric/song', A, { song_url: 'https://suno.com/s/abcdEFGH1234' })).status, 409);
    const w0 = await call('GET', '/wall', A); step('wall offers the turned-in song', !!(w0.d.can && w0.d.can.karaoke.turnedIn && !w0.d.can.karaoke.turnedIn.karaokeId), true);
    const sg = await call('POST', '/wall/share', A, { kind: 'song', confirm: 'true' }); step('song shared on the wall, 25 points', sg.d.bonus, 25, sg.d.error);
    step('lyric lock now shows 60', await bonusOf('lyric'), 60);
    const wb = await call('GET', '/wall', B); const it = (wb.d.items || []).find((x) => sg.d.item && x.id === sg.d.item.id); step('another team sees the song with its link', !!it && it.link === 'https://youtu.be/example-karaoke', true);
    if (process.env.ADMIN_PASSWORD) {
      const ol = await call('GET', '/organizer/extras', null, null, null, org); const pv = (ol.d.items || []).find((x) => pf.d.item && x.id === pf.d.item.id);
      const g = pv && pv.fileUrl ? await fetch(pv.fileUrl) : { status: 0 }; step('organizer can play the performance video', g.status, 200);
      step('organizer removes the karaoke video', (await call('POST', '/organizer/extras/remove', null, { id: kv.d.item && kv.d.item.id, note: 'selftest' }, null, org)).status, 200);
      const lk2 = await lockOf('lyric'); step('its 10 points and its wall share (25) come off, and the song place is free again', lk2 && lk2.bonus === 25 && !lk2.song_url, true, JSON.stringify(lk2 && [lk2.bonus, lk2.song_url]));
    }

    // Trove 03
    const r3 = await call('POST', '/rehearse/lesson', A, { text: SUITES.lesson[2].payload.text }); const l3 = await call('POST', '/stage/lesson', A, { rehearsal_id: r3.d.id, confirm: 'true' }); step('lock lesson without a dance video', l3.status, 200, l3.d.error);
    step('no dance video yet, so nothing to share', (await call('POST', '/wall/share', A, { kind: 'dance', confirm: 'true' })).status, 400);
    step('a dance link that is not a web address is refused', (await call('POST', '/stage/lesson/dance', A, { dance_video_url: 'not a link' })).status, 400);
    const dl = await call('POST', '/stage/lesson/dance', A, { dance_video_url: 'https://youtu.be/example-dance' }); step('dance video added after the lock, 10 points', dl.d.bonus, 10, dl.d.error);
    step('a second dance video is refused', (await call('POST', '/stage/lesson/dance', A, { dance_video_url: 'https://youtu.be/other' })).status, 409);
    const two = await Promise.all([call('POST', '/extras/lore', A, { text: story }), call('POST', '/wall/share', B, { kind: 'pictures', confirm: 'true' })]); step('story turned in again after removal', two[0].status, process.env.ADMIN_PASSWORD ? 200 : 409);
    const dn = await call('POST', '/wall/share', A, { kind: 'dance', confirm: 'true' }); step('dance video shared on the wall, 25 points', dn.d.bonus, 25, dn.d.error);
    step('lesson lock shows 10 + 25', await bonusOf('lesson'), 35);
    step('team without a lesson lock cannot share a dance video', (await call('POST', '/wall/share', B, { kind: 'dance', confirm: 'true' })).status, 404);

    // Reset clears what hangs off the entry
    if (process.env.ADMIN_PASSWORD) {
      const lkid = (await lockOf('lyric')).id;
      step('organizer resets the lyric entry', (await call('POST', '/organizer/reset', null, { lock_id: lkid, note: 'selftest' }, null, org)).status, 200);
      const { data: left } = await R.supabase.from('evalroom_extras').select('id, status, file_path').eq('lock_id', lkid).is('removed_at', null); step('its extra tasks are retired', (left || []).length, 0);
      const { data: files } = await R.supabase.storage.from('evalroom-private').list(`extras/${pf.d.item && pf.d.item.id}`); step('the performance video file is deleted', (files || []).length, 0);
      step('its song leaves the wall', !((await call('GET', '/wall', B)).d.items || []).find((x) => sg.d.item && x.id === sg.d.item.id), true);
      for (const j of ['visual', 'lesson']) { const l = await lockOf(j); if (l) await call('POST', '/organizer/reset', null, { lock_id: l.id, note: 'selftest tidy-up' }, null, org); }
      step('after the resets nothing of this team is on the wall', ((await call('GET', '/wall', B)).d.items || []).filter((x) => /extras a$/.test(x.team || '')).length, 0);
    }
    await R.supabase.from('evalroom_practice_locks').update({ reset_at: new Date().toISOString(), reset_note: 'selftest tidy-up' }).like('team_key', 'preview:' + run + '-%').is('reset_at', null);
    return { passed: steps.filter((x) => x.startsWith('PASS')).length, total: steps.length, steps };
  }
  if (row.kind === 'wallflow') {
    // The wall, through the web routes: lock pictures, share, see, remove.
    const base = `http://127.0.0.1:${port}/api/evalroom`;
    const run = 'w' + Date.now().toString(36);
    const tok = (k) => R.signToken({ t: 'preview:' + run + '-' + k, n: 'Preview: wall ' + k, p: 1 });
    const A = tok('a'); const B = tok('b');
    const call = async (method, pth, token, json, form, extra) => { const headers = { ...(extra || {}) }; if (token) headers['x-evalroom-token'] = token; let body; if (form) body = form; else if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); } const r = await fetch(base + pth, { method, headers, body }); let d = {}; try { d = await r.json(); } catch (_) {} return { status: r.status, d }; };
    const steps = []; const step = (name, got, want, note) => steps.push((got === want ? 'PASS ' : 'FAIL ') + name + (got === want ? '' : ' (got ' + JSON.stringify(got) + ')') + (note ? ' [' + note + ']' : ''));
    const pics = () => { const f = new FormData(); for (const [k, n] of [['avatar', 'avatar_good.png'], ['poster', 'poster_good.png']]) f.append(k, new Blob([fs.readFileSync(path.join(FIXTURES, n))], { type: 'image/png' }), n); return f; };
    step('signed-out visitor cannot see the wall', (await call('GET', '/wall')).status, 401);
    step('signed-out visitor cannot share', (await call('POST', '/wall/share', null, { kind: 'pictures', confirm: 'true' })).status, 401);
    step('organizer list needs the password', (await call('GET', '/organizer/wall')).status, 401);
    step('sharing before taking the stage is refused', (await call('POST', '/wall/share', A, { kind: 'pictures', confirm: 'true' })).status, 404);
    const r1 = await call('POST', '/rehearse/visual', A, null, pics()); step('rehearse pictures', r1.status, 200, 'score ' + r1.d.score);
    const l1 = await call('POST', '/stage/visual', A, { rehearsal_id: r1.d.id, confirm: 'true' }); step('lock pictures', l1.status, 200);
    const w0 = await call('GET', '/wall', A); step('wall says the team can share its pictures', w0.d.can && w0.d.can.pictures.locked === true && !w0.d.can.pictures.shared, true);
    step('share without the agree box is refused', (await call('POST', '/wall/share', A, { kind: 'pictures' })).status, 400);
    step('a made-up kind is refused', (await call('POST', '/wall/share', A, { kind: 'everything', confirm: 'true' })).status, 400);
    step('karaoke share without locked lyrics is refused', (await call('POST', '/wall/share', A, { kind: 'karaoke', confirm: 'true', id: '00000000-0000-4000-8000-000000000000' })).status, process.env.VIMEO_ACCESS_TOKEN ? 404 : 404);
    const sh = await call('POST', '/wall/share', A, { kind: 'pictures', confirm: 'true', public_ok: 'true' }); step('pictures shared, 25 points added', sh.d.bonus, 25, sh.d.error);
    const s1 = await call('GET', '/stage', A); step('locked score shows the 25', s1.d.locks.visual && s1.d.locks.visual.bonus, 25);
    step('sharing twice is refused', (await call('POST', '/wall/share', A, { kind: 'pictures', confirm: 'true' })).status, 409);
    const wb = await call('GET', '/wall', B); const it = (wb.d.items || []).find((x) => sh.d.item && x.id === sh.d.item.id);
    step('another team sees the item, not as its own', !!it && it.mine === false, true);
    step('other teams are not told who approved public posting', it && it.publicOk, undefined);
    if (it && it.images) {
      for (const slot of ['avatar', 'poster']) { const g = await fetch(it.images[slot].small); const b = Buffer.from(await g.arrayBuffer()); step(slot + ' small picture loads as a JPEG', g.status === 200 && b[0] === 0xff && b[1] === 0xd8, true, b.length + ' bytes'); }
      const { data: w } = await R.supabase.from('evalroom_wall').select('images, public_ok, ig_status, is_preview').eq('id', it.id).single();
      step('public approval is recorded, nothing is posted', w.public_ok === true && w.ig_status === 'approved-waiting-for-setup' && w.is_preview === true, true);
      const plain = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/public/evalroom-private/${w.images.avatar.small}`); step('pictures cannot be opened without a signed link', plain.status >= 400, true, String(plain.status));
    }
    step('another team cannot take it down', (await call('POST', '/wall/' + (sh.d.item && sh.d.item.id) + '/remove', B, {})).status, 404);
    step('organizer removal needs the password', (await call('POST', '/organizer/wall/remove', null, { id: sh.d.item && sh.d.item.id })).status, 401);
    if (process.env.ADMIN_PASSWORD) {
      const ol = await call('GET', '/organizer/wall', null, null, null, { 'x-organizer-password': process.env.ADMIN_PASSWORD }); step('organizer sees the item and the public approval', !!(ol.d.items || []).find((x) => x.id === sh.d.item.id && x.publicOk === true), true);
      const or = await call('POST', '/organizer/wall/remove', null, { id: sh.d.item.id, note: 'selftest' }, null, { 'x-organizer-password': process.env.ADMIN_PASSWORD }); step('organizer removes it', or.status, 200);
      const or2 = await call('POST', '/organizer/wall/remove', null, { id: sh.d.item.id, note: 'selftest' }, null, { 'x-organizer-password': process.env.ADMIN_PASSWORD }); step('removing it a second time is refused', or2.status, 404);
    } else step('team takes it down', (await call('POST', '/wall/' + sh.d.item.id + '/remove', A, {})).status, 200);
    const s2 = await call('GET', '/stage', A); step('the 25 points come off again', s2.d.locks.visual && s2.d.locks.visual.bonus, 0);
    step('it is gone from the wall', !((await call('GET', '/wall', B)).d.items || []).find((x) => x.id === sh.d.item.id), true);
    const { data: left } = await R.supabase.storage.from('evalroom-private').list(`wall/${sh.d.item && sh.d.item.id}`); step('its pictures are removed from storage', (left || []).length, 0);
    const again = await call('POST', '/wall/share', A, { kind: 'pictures', confirm: 'true' }); step('after removal the team may share again', again.status, 200);
    if (again.d.item) {
      const both = await Promise.all([call('POST', '/wall/' + again.d.item.id + '/remove', A, {}), call('POST', '/wall/' + again.d.item.id + '/remove', A, {})]);
      step('two removals at the same moment: only one goes through', both.map((x) => x.status).sort().join(','), '200,404');
      const s3 = await call('GET', '/stage', A); step('points come off once, never below zero', s3.d.locks.visual && s3.d.locks.visual.bonus, 0);
    }
    if (process.env.ADMIN_PASSWORD) {
      const third = await call('POST', '/wall/share', A, { kind: 'pictures', confirm: 'true' }); step('share once more', third.status, 200);
      const rs = await call('POST', '/organizer/reset', null, { lock_id: s1.d.locks.visual && s1.d.locks.visual.id, note: 'selftest' }, null, { 'x-organizer-password': process.env.ADMIN_PASSWORD }); step('organizer resets the locked entry', rs.status, 200);
      step('the shared item leaves the wall with the reset', !((await call('GET', '/wall', B)).d.items || []).find((x) => third.d.item && x.id === third.d.item.id), true);
      const wr = await call('GET', '/wall', A); step('after a reset the team is not shown as sharing', wr.d.can && wr.d.can.pictures.locked === false && !wr.d.can.pictures.shared, true);
    }
    await R.supabase.from('evalroom_practice_locks').update({ reset_at: new Date().toISOString(), reset_note: 'selftest tidy-up' }).like('team_key', 'preview:' + run + '-%').is('reset_at', null);
    return { passed: steps.filter((x) => x.startsWith('PASS')).length, total: steps.length, steps };
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
