/**
 * Preview-only: counts syllables with a plain program (no AI) so the
 * Songwriting Studio's line-by-line fit can be checked.
 *   English  -> CMU Pronouncing Dictionary, then the "syllable" library for unknown words
 *   Korean   -> one syllable per Hangul block
 *   Spanish  -> vowel-group rule (approximate)
 */
let dict = null; let heuristic = null;
async function load() {
  if (dict) return;
  dict = (await import('cmu-pronouncing-dictionary')).dictionary;
  heuristic = (await import('syllable')).syllable;
}

const STRONG = 'aeoáéóíú';
function spanishCount(w) {
  w = w.toLowerCase().replace(/qu/g, 'q').replace(/gu([eiéí])/g, 'g$1').replace(/ü/g, 'u');
  if (/y$/.test(w) && w.length > 1) w = w.slice(0, -1) + 'i';
  let n = 0;
  for (const group of w.match(/[aeiouáéíóú]+/g) || []) {
    const strong = [...group].filter((c) => STRONG.includes(c)).length;
    n += Math.max(1, strong);
  }
  return Math.max(1, n);
}

function wordCount(word, spanishSet) {
  const hangul = (word.match(/[가-힣]/g) || []).length;
  if (hangul) return hangul;
  const w = word.toLowerCase().replace(/[’`]/g, "'").replace(/^'+|'+$/g, '');
  if (!/[a-záéíóúñü]/.test(w)) return /\d/.test(w) ? 1 : 0;
  const plain = w.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/[áéíóúñü]/.test(w) || spanishSet.has(w) || spanishSet.has(plain)) return spanishCount(w);
  const p = dict[w] || dict[w.replace(/'/g, '')] || (w.endsWith("'s") ? dict[w.slice(0, -2)] : null);
  if (p) return (p.match(/\d/g) || []).length || 1;
  return heuristic(plain) || 1;
}

function lineCount(line, spanishSet) {
  // Leave out romanization or translations given in brackets after a word.
  const text = line.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  const words = text.split(/[\s—–\-\/]+/).map((x) => x.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '')).filter(Boolean);
  return words.reduce((s, w) => s + wordCount(w, spanishSet), 0);
}

const lyricLines = (t) => String(t || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^[\[(].*[\])]$/.test(l) && !/^(verse|chorus|bridge|intro|outro|pre-chorus)\b[\s\d:]*$/i.test(l));

function vocabSet(vocab) {
  const set = new Set();
  for (const line of String(vocab || '').split('\n')) {
    const term = line.split(/\s[—–-]\s|:/)[0].replace(/\([^)]*\)/g, '').trim().toLowerCase();
    for (const w of term.split(/\s+/)) if (w && /[a-záéíóúñü]/.test(w)) { set.add(w); set.add(w.normalize('NFD').replace(/[̀-ͯ]/g, '')); }
  }
  return set;
}

/** Compare a rewrite with its original, line by line. */
async function compare(original, rewrite, vocab) {
  await load();
  const set = vocabSet(vocab);
  const a = lyricLines(original); const b = lyricLines(rewrite);
  const n = Math.min(a.length, b.length);
  const lines = [];
  let exact = 0; let within1 = 0;
  for (let i = 0; i < n; i++) {
    const oa = lineCount(a[i], set); const ob = lineCount(b[i], set);
    if (oa === ob) exact++;
    if (Math.abs(oa - ob) <= 1) within1++;
    lines.push({ o: oa, r: ob, orig: a[i], rew: b[i] });
  }
  // Which vocabulary words made it into the rewrite?
  const terms = String(vocab || '').split('\n').map((l) => l.split(/\s[—–-]\s|:/)[0].replace(/\([^)]*\)/g, '').trim()).filter(Boolean);
  const low = rewrite.toLowerCase();
  const used = terms.filter((t) => low.includes(t.toLowerCase()));
  return {
    originalLines: a.length, rewriteLines: b.length, sameLineCount: a.length === b.length,
    compared: n, exact, within1, exactPct: n ? Math.round(100 * exact / n) : 0, within1Pct: n ? Math.round(100 * within1 / n) : 0,
    vocabTotal: terms.length, vocabUsed: used.length, lines,
  };
}

module.exports = { compare, lyricLines };
