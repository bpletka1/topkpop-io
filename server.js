/**
 * TopKpop.io — Express Server
 * Railway Deployment Entry Point
 */
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { router: apiRouter, startScheduler } = require('./api/routes');
const jeannieRouter = require('./api/jeannie');
const { router: evalroomRouter, schedule: troveSchedule } = require('./api/evalroom');

// Preview copy: set PREVIEW_MODE=1 on a test service. It shares the live
// database, so it must never run the scheduler, send email or change game data.
const PREVIEW_MODE = process.env.PREVIEW_MODE === '1';

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use('/api/evalroom', express.json({ limit: '400kb' })); // studio conversations can be long
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Preview safety ───────────────────────────────────────────────────────────
if (PREVIEW_MODE) {
  app.use((req, res, next) => { res.set('X-Robots-Tag', 'noindex, nofollow'); next(); });
  // Allow-list: only the room, Jeannie and three public read-only pages of game info.
  const PREVIEW_PUBLIC_READS = ['/health', '/leaderboard', '/game-settings'];
  app.use('/api', (req, res, next) => {
    let p = req.path;
    try { p = decodeURIComponent(p); } catch (_) { return res.status(400).json({ error: 'Bad request.' }); }
    p = p.toLowerCase().replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
    if (p === '/evalroom' || p.startsWith('/evalroom/') || p === '/jeannie' || p.startsWith('/jeannie/')) return next();
    if (req.method === 'GET' && PREVIEW_PUBLIC_READS.includes(p)) return next();
    return res.status(403).json({ error: 'This is the preview copy. That action is switched off here.' });
  });
}

// ── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/evalroom', evalroomRouter);
app.use('/api', apiRouter);
app.use('/api/jeannie', jeannieRouter);

// ── Static assets ────────────────────────────────────────────────────────────
app.use('/css',    express.static(path.join(__dirname, 'public/css')));
app.use('/js',     express.static(path.join(__dirname, 'public/js')));
// A Trove's Instagram clue card carries its cipher, so it stays closed until that Trove opens.
app.use('/assets/instagram', async (req, res, next) => {
  let p;
  try { p = path.posix.normalize(decodeURIComponent(req.path)).toLowerCase().replace(/\/+/g, '/'); } catch (e) { return res.status(404).end(); }
  const m = /^\/trove-0([123])\.jpg$/.exec(p);
  if (!m) return res.status(404).end();
  try {
    const s = (await troveSchedule.get())[m[1]];
    if (s && !s.open) { res.set('Cache-Control', 'no-store'); return res.status(404).end(); }
  } catch (e) { /* no schedule read: same rule as the Trove pages, which stay open */ }
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));

// ── Inner pages ──────────────────────────────────────────────────────────────
// A Trove's directions stay closed until the organizer's date for it. Until then the page shows a locked chest.
app.use('/pages', async (req, res, next) => {
  let p;
  try { p = path.posix.normalize(decodeURIComponent(req.path)).toLowerCase().replace(/\/+/g, '/'); } catch (e) { return next(); }
  if (/^\/final-reveal(?:\/|$)/.test(p)) {
    try { const g = await troveSchedule.game(); if (g.reveal.open) return next(); return res.redirect(302, '/pages/missions'); } catch (e) { return next(); }
  }
  const m = /^\/trove-0([123])(?:\/|$)/.exec(p);
  if (!m) return next();
  try {
    const s = (await troveSchedule.get())[m[1]];
    if (!s || s.open) return next();
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(__dirname, 'pages/trove-locked/index.html'));
  } catch (e) { next(); }
});
app.use('/pages',  express.static(path.join(__dirname, 'pages')));

// ── SEO files ────────────────────────────────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/robots.txt'));
});
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.sendFile(path.join(__dirname, 'public/sitemap.xml'));
});

// ── Splash page (root) ───────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// ── 404 handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public/index.html'));
});

// ── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`TopKpop.io running on port ${PORT}`);
  if (PREVIEW_MODE) {
    console.log('PREVIEW_MODE is on: scheduler and emails are off.');
    require('./api/evalroom-selftest').startSelftestRunner(PORT);
  } else {
    startScheduler();
  }
});
