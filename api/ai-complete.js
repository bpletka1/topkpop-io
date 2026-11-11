/**
 * TopKpop.io — shared helper for calling OpenAI chat models safely.
 *
 * - Tries a list of models in order and skips any the account cannot use.
 * - Drops a setting a model refuses (temperature, reasoning effort) and retries.
 * - Retries briefly when OpenAI is busy.
 * - Reports the model that answered, the tokens used and an estimated cost.
 */

// Estimated USD per 1M tokens [input, output]. Used for the spending cap only.
// Override or extend with EVALROOM_PRICES='{"model":[in,out]}'.
const DEFAULT_PRICES = {
  'gpt-6.1-sol': [2, 10],
  'gpt-6-sol': [2, 10],
  'gpt-6-luna': [0.1, 0.5],
  'gpt-4o-mini': [0.15, 0.6],
  'gpt-4o': [2.5, 10],
};
const UNKNOWN_PRICE = [5, 15]; // deliberately high so the cap errs on the safe side

let PRICES = { ...DEFAULT_PRICES };
try {
  if (process.env.EVALROOM_PRICES) PRICES = { ...PRICES, ...JSON.parse(process.env.EVALROOM_PRICES) };
} catch (_) { /* ignore a malformed override */ }

function priceFor(model) {
  const m = String(model || '').toLowerCase();
  const keys = Object.keys(PRICES).sort((a, b) => b.length - a.length);
  for (const k of keys) if (m === k || m.startsWith(k + '-') || m.startsWith(k)) return PRICES[k];
  return UNKNOWN_PRICE;
}

function estimateCost(model, tokensIn, tokensOut) {
  const [pi, po] = priceFor(model);
  return Number((((tokensIn || 0) * pi + (tokensOut || 0) * po) / 1e6).toFixed(6));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isModelUnavailable(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  const code = String((err && err.code) || '').toLowerCase();
  return (
    err && (err.status === 404 || code === 'model_not_found' ||
      /model.*(does not exist|not found|not available)|do(es)? not have access to (the )?model|unsupported model|invalid model/.test(msg))
  );
}

function isBusy(err) {
  const s = err && err.status;
  const msg = String((err && err.message) || '').toLowerCase();
  return s === 429 || s === 408 || (s >= 500 && s < 600) || /timed? ?out|econnreset|socket hang up|connection error/.test(msg);
}

// Work out which request setting a 400 error is complaining about.
function rejectedParam(err, params) {
  if (!err || err.status !== 400) return null;
  const msg = String(err.message || '').toLowerCase();
  const named = String(err.param || '').toLowerCase();
  const candidates = ['temperature', 'reasoning_effort', 'max_completion_tokens', 'max_tokens', 'stream_options'];
  for (const c of candidates) {
    if (!(c in params)) continue;
    if (named === c || named.startsWith(c + '.') || msg.includes(c) || (c === 'reasoning_effort' && msg.includes('reasoning'))) return c;
  }
  return null;
}

function buildParams(model, messages, opts) {
  const params = { model, messages, max_completion_tokens: opts.maxTokens || 2000 };
  if (opts.effort) params.reasoning_effort = opts.effort;
  if (opts.temperature !== undefined && opts.temperature !== null) params.temperature = opts.temperature;
  return params;
}

// Apply the fix for a rejected setting. Returns false when nothing can be changed.
function adapt(params, param, dropped) {
  if (param === 'max_completion_tokens') {
    params.max_tokens = params.max_completion_tokens;
    delete params.max_completion_tokens;
    dropped.push('max_completion_tokens->max_tokens');
    return true;
  }
  if (param === 'max_tokens') return false;
  if (param && param in params) {
    delete params[param];
    dropped.push(param);
    return true;
  }
  return false;
}

/**
 * Non-streaming completion.
 * @returns {{text, model, requested, tokensIn, tokensOut, costUsd, ms, dropped}}
 */
async function complete(openai, models, messages, opts = {}) {
  let lastErr = new Error('No AI model is configured.');
  for (const requested of models) {
    const params = buildParams(requested, messages, opts);
    const dropped = [];
    let busyTries = 0;
    let emptyTries = 0;
    for (let guard = 0; guard < 10; guard++) {
      const t0 = Date.now();
      try {
        const r = await openai.chat.completions.create(params, { timeout: opts.timeoutMs || 150000, maxRetries: 0 });
        const text = (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content) || '';
        const u = r.usage || {};
        const tokensIn = u.prompt_tokens || 0;
        const tokensOut = u.completion_tokens || 0;
        if (!String(text).trim()) {
          // A thinking model can spend the whole allowance on thinking. Give it more room once.
          lastErr = new Error('The model returned an empty answer.');
          if (emptyTries++ < 1) {
            const key = 'max_completion_tokens' in params ? 'max_completion_tokens' : 'max_tokens';
            params[key] = Math.min((params[key] || 2000) * 2, 16000);
            continue;
          }
          break;
        }
        return {
          text: String(text), model: r.model || requested, requested, tokensIn, tokensOut,
          costUsd: estimateCost(r.model || requested, tokensIn, tokensOut), ms: Date.now() - t0, dropped,
        };
      } catch (err) {
        lastErr = err;
        if (isModelUnavailable(err)) break;
        const p = rejectedParam(err, params);
        if (p && adapt(params, p, dropped)) continue;
        if (isBusy(err) && busyTries++ < 2) { await sleep(1200 * busyTries); continue; }
        break;
      }
    }
  }
  throw lastErr;
}

/**
 * Streaming completion. Calls onDelta(text) for each piece.
 * @returns {{text, model, requested, tokensIn, tokensOut, costUsd, ms, dropped}}
 */
async function completeStream(openai, models, messages, opts = {}, onDelta = () => {}) {
  let lastErr = new Error('No AI model is configured.');
  for (const requested of models) {
    const params = buildParams(requested, messages, opts);
    params.stream = true;
    params.stream_options = { include_usage: true };
    const dropped = [];
    let busyTries = 0;
    for (let guard = 0; guard < 10; guard++) {
      const t0 = Date.now();
      let sent = false;
      try {
        const stream = await openai.chat.completions.create(params, { timeout: opts.timeoutMs || 240000, maxRetries: 0 });
        let text = '';
        let usage = null;
        let model = requested;
        for await (const chunk of stream) {
          if (chunk.model) model = chunk.model;
          if (chunk.usage) usage = chunk.usage;
          const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta && chunk.choices[0].delta.content;
          if (d) { text += d; sent = true; onDelta(d); }
        }
        const tokensIn = (usage && usage.prompt_tokens) || Math.ceil(JSON.stringify(messages).length / 4);
        const tokensOut = (usage && usage.completion_tokens) || Math.ceil(text.length / 4);
        return {
          text, model, requested, tokensIn, tokensOut,
          costUsd: estimateCost(model, tokensIn, tokensOut), ms: Date.now() - t0, dropped,
        };
      } catch (err) {
        lastErr = err;
        if (sent) throw err; // part of an answer is already on screen; do not start a second one
        if (isModelUnavailable(err)) break;
        const p = rejectedParam(err, params);
        if (p && adapt(params, p, dropped)) continue;
        if (isBusy(err) && busyTries++ < 2) { await sleep(1200 * busyTries); continue; }
        break;
      }
    }
  }
  throw lastErr;
}

module.exports = { complete, completeStream, estimateCost, priceFor };
