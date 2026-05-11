/**
 * TopKpop.io — Express Server
 * Railway Deployment Entry Point
 */
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { router: apiRouter, startScheduler } = require('./api/routes');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── API Routes ───────────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ── Static assets ────────────────────────────────────────────────────────────
app.use('/css',    express.static(path.join(__dirname, 'public/css')));
app.use('/js',     express.static(path.join(__dirname, 'public/js')));
app.use('/assets', express.static(path.join(__dirname, 'public/assets')));

// ── Inner pages ──────────────────────────────────────────────────────────────
app.use('/pages',  express.static(path.join(__dirname, 'pages')));

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
  startScheduler();
});
