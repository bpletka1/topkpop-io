/**
 * TopKpop.io — when each Treasure Trove opens.
 *
 * The dates come from the game settings the organizer sets in the admin dashboard
 * (game_start_date / trove1_unlock, trove2_unlock, trove3_unlock). A Trove opens at
 * 7:00 in the evening Pacific time on its date, the time the site and the emails tell players.
 * A Trove with no date is open. If the dates cannot be read, nothing is locked: a team is never
 * shut out by a hiccup.
 *
 * On the preview copy every Trove is open unless a practice schedule has been set for testing.
 */
const HOUR_PT = Number(process.env.EVALROOM_UNLOCK_HOUR_PT || 19);

/** The moment (ms) when it is HOUR_PT o'clock in Los Angeles on the given YYYY-MM-DD date. */
function unlockInstant(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) { const t = Date.parse(dateStr); return Number.isNaN(t) ? null : t; }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (/T\d/.test(String(dateStr))) { const t = Date.parse(dateStr); return Number.isNaN(t) ? null : t; }
  for (const off of [7, 8]) {
    const t = Date.UTC(y, mo - 1, d, HOUR_PT + off);
    const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(new Date(t))) % 24;
    if (h === HOUR_PT) return t;
  }
  return Date.UTC(y, mo - 1, d, HOUR_PT + 8);
}

function build(dates, now) {
  const out = {};
  for (const n of [1, 2, 3]) {
    const at = dates && dates[n] != null ? unlockInstant(dates[n]) : null;
    out[n] = { open: at == null || at <= now, opensAt: at == null ? null : new Date(at).toISOString() };
  }
  return out;
}

module.exports = function makeSchedule({ supabase, PREVIEW_MODE }) {
  let cache = null; let cachedAt = 0; let practice = null;
  async function dates() {
    if (PREVIEW_MODE) return practice || {};
    if (cache && Date.now() - cachedAt < 30000) return cache;
    try {
      const { data, error } = await supabase.from('game_settings').select('game_start_date, trove1_unlock, trove2_unlock, trove3_unlock, accusation_open, accusation_close, winner_announced').eq('id', 1).single();
      if (error || !data) throw new Error((error && error.message) || 'no settings');
      cache = { 1: data.game_start_date || data.trove1_unlock || null, 2: data.trove2_unlock || null, 3: data.trove3_unlock || null, accOpen: data.accusation_open || null, accClose: data.accusation_close || null, revealed: !!data.winner_announced };
      cachedAt = Date.now();
    } catch (e) { console.error('evalroom schedule read error:', e.message); if (!cache) return {}; }
    return cache;
  }
  /** The Final Accusation window (opens and closes at the same hour as the Troves) and whether the saboteur has been revealed. */
  function ending(d, now) {
    const o = d && d.accOpen ? unlockInstant(d.accOpen) : null; const c = d && d.accClose ? unlockInstant(d.accClose) : null;
    const notYet = o != null && o > now; const over = c != null && c <= now;
    return { accusation: { open: !notYet && !over, notYet, closed: over, opensAt: o == null ? null : new Date(o).toISOString(), closesAt: c == null ? null : new Date(c).toISOString() }, reveal: { open: !!(d && d.revealed) } };
  }
  return {
    get: async () => build(await dates(), Date.now()),
    game: async () => { const d = await dates(); const now = Date.now(); return { troves: build(d, now), ...ending(d, now) }; },
    /** Preview only: practice dates, or null to open everything again. */
    setPractice(p) { practice = p && typeof p === 'object' ? { 1: p[1] || null, 2: p[2] || null, 3: p[3] || null, accOpen: p.accOpen || null, accClose: p.accClose || null, revealed: !!p.revealed } : null; },
  };
};
module.exports._internal = { unlockInstant, build };
