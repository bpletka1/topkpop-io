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
const { router: evalroomRouter } = require('./api/evalroom');

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
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));

// ── Inner pages ──────────────────────────────────────────────────────────────
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
