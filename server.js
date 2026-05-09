/**
 * TopKpop.io — Express Server
 * Railway Deployment Entry Point
 *
 * Phase 1: Static site serving (splash page + placeholder pages)
 * Phase 2: Will add dynamic routes for missions, leaderboard, registration
 * Phase 3: Will add API routes for AI scoring, database, admin dashboard
 */

const express = require('express');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Static assets (CSS, JS, images, characters) ──
app.use('/css',    express.static(path.join(__dirname, 'public/css')));
app.use('/js',     express.static(path.join(__dirname, 'public/js')));
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));

// ── Inner pages ──
app.use('/pages',  express.static(path.join(__dirname, 'pages')));

// ── Splash page (root) ──
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// ── API placeholder (Phase 3) ──
app.get('/api', (req, res) => {
  res.json({
    status: 'ok',
    message: 'TopKpop.io API — Phase 3 coming soon',
    version: '1.0.0-phase1'
  });
});

// ── 404 handler ──
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
  console.log(`TopKpop.io running on port ${PORT}`);
});
