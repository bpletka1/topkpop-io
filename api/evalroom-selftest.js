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
    const out = await song.checkSong(p.url, p.lyrics || '');
    if (p.probe) {
      const n = song.normalizeSongUrl(p.url);
      const page = n.ok ? await song.fetchSuno(n.canonical) : { status: 0 };
      const html = page.html || '';
      const at = (needle) => { const i = html.indexOf(needle); return i === -1 ? null : html.slice(Math.max(0, i - 60), i + 420); };
      out.probe = { status: page.status, finalUrl: page.finalUrl, type: page.type, bytes: html.length, head: html.slice(0, 300), prompt: at('prompt'), lyrics: at('yrics'), ogDesc: at('og:description'), challenge: /cf-challenge|Just a moment|captcha/i.test(html) };
    }
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
