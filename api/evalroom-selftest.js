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

async function runCase(row, port) {
  const p = row.payload || {};
  const models = p.model ? [p.model] : undefined;

  if (row.kind === 'judge') {
    const j = R.JUDGES[p.judge];
    const { ai, parsed, saidMissing } = await R.runJudge(j, judgeInput(j, p), { models, effort: p.effort });
    await R.logUsage('selftest', 'selftest', ai);
    return { ...parsed, saidMissing, raw: ai.text, model: ai.model, ms: ai.ms, dropped: ai.dropped, tokensIn: ai.tokensIn, tokensOut: ai.tokensOut, costUsd: ai.costUsd };
  }

  if (row.kind === 'baseline') {
    // The old Oracle, rebuilt: the saved instructions alone, the entry sent the way a person would paste it.
    const j = R.JUDGES[p.judge];
    const input = judgeInput(j, p);
    const user = j.input === 'images'
      ? [{ type: 'text', text: 'Here are my avatar and my poster.' }, { type: 'image_url', image_url: { url: input.avatarDataUrl } }, { type: 'image_url', image_url: { url: input.posterDataUrl } }]
      : input.text;
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
    return { raw: ai.text, model: ai.model, ms: ai.ms, dropped: ai.dropped, tokensIn: ai.tokensIn, tokensOut: ai.tokensOut, costUsd: ai.costUsd };
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
      out.push({ status: r.status, type: r.headers.get('content-type'), body: text.slice(0, p.keep || 1500) });
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
  setInterval(() => { tick(port).catch((e) => console.error('selftest tick error:', e.message)); }, 4000);
}

module.exports = { startSelftestRunner };
