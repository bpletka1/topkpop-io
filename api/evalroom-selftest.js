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
    step('lock with different pictures is refused', (await call('POST', '/stage/visual', A, null, (() => { const f = pics('avatar_good.png', 'poster_weak.png'); f.append('rehearsal_id', r2.d.id); f.append('confirm', 'true'); return f; })())).status, 400);
    const l1 = await call('POST', '/stage/visual', A, null, (() => { const f = pics('avatar_good.png', 'poster_good.png'); f.append('rehearsal_id', r2.d.id); f.append('confirm', 'true'); return f; })()); step('lock with the same pictures', l1.status === 200 && l1.d.lock.score === r2.d.score, true);

    // Organizer
    step('organizer list with a wrong password is refused', (await call('GET', '/organizer/locks', null, null, null, { 'x-organizer-password': 'guess' })).status, 401);
    step('organizer list with no password is refused', (await call('GET', '/organizer/locks')).status, 401);
    const org = { 'x-organizer-password': process.env.ADMIN_PASSWORD || '' };
    const list = await call('GET', '/organizer/locks', null, null, null, org); step('organizer sees the locks', list.status === 200 && list.d.locks.some((l) => l.id === lock.d.lock.id), true);
    step('organizer reset', (await call('POST', '/organizer/reset', null, { lock_id: lock.d.lock.id, note: 'selftest' }, null, org)).status, 200);
    const again = await call('POST', '/stage/lyric', A, { rehearsal_id: rid, confirm: 'true' }); step('after a reset the team can lock again', again.status, 200);
    // Tidy up: reset every lock this run made.
    for (const l of [again.d.lock, l3.d.lock, l1.d.lock]) if (l) await call('POST', '/organizer/reset', null, { lock_id: l.id, note: 'selftest cleanup' }, null, org);
    // The official tables must be untouched by all of the above.
    const { count } = await R.supabase.from('submissions').select('id', { count: 'exact', head: true });
    return { passed: steps.filter((x) => x.pass).length, total: steps.length, failed: steps.filter((x) => !x.pass), steps: steps.map((x) => (x.pass ? 'PASS ' : 'FAIL ') + x.name + (x.note ? ' (' + x.note + ')' : '')), submissionsRows: count };
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
