# TopKpop.io — K-Pop AI Super Sleuth

A professional development game for K–8 educators, principals, and instructional aides. Teams use real AI tools to solve a K-Pop sabotage mystery over four weeks — and take every artifact they create back to their classroom.

---

## Project Structure

```
topkpop_railway/
│
├── server.js               # Express entry point (Railway)
├── package.json
├── .gitignore
│
├── public/                 # Static assets served at root
│   ├── index.html          # ★ Splash page (Phase 1 complete)
│   ├── css/
│   │   └── style.css       # Global stylesheet (all phases)
│   ├── js/
│   │   └── nav.js          # Shared navigation JS
│   └── assets/
│       ├── characters/     # All 9 character portraits
│       │   ├── minseo.jpg
│       │   ├── sunny_anna.jpg
│       │   ├── james_paul.jpg
│       │   ├── nari.jpg
│       │   ├── emilise.jpg
│       │   ├── star_tammy.jpg
│       │   ├── hanbit_phil.jpg
│       │   ├── anna_im.jpg
│       │   ├── bobby_lee.jpg
│       │   └── detective_recruit.jpg
│       ├── images/         # Background & UI images
│       │   ├── hero_bg.jpg
│       │   ├── treasure_trove_locked.jpg
│       │   ├── educator_teacher.jpg
│       │   ├── educator_principal.jpg
│       │   └── educator_aide.jpg
│       ├── icons/          # Phase 2: custom SVG icons
│       └── video/          # Phase 2: intro video assets
│
├── pages/                  # Inner pages (Phase 2 content)
│   ├── the-case/           # Full narrative + CEO Minseo story
│   ├── suspects/           # All 6 suspect dossiers
│   ├── missions/           # Treasure Troves 1–3 + submission forms
│   ├── leaderboard/        # Live score dashboard
│   ├── resources/          # FAQ, rules, ChatGPT tool links
│   ├── register/           # Team registration form
│   └── admin/              # Admin dashboard (Phase 3)
│
├── api/                    # Phase 3: backend API routes
│   # Will contain:
│   # - /api/submit         POST: receive artifact submissions
│   # - /api/score          POST: trigger OpenAI rubric scoring
│   # - /api/leaderboard    GET:  return live scores
│   # - /api/register       POST: register new team
│   # - /api/admin          GET/POST: admin controls
│   # - /api/schedule       GET:  return current game schedule/unlock status
│
└── components/             # Shared HTML snippets
    └── nav.html            # Navigation component reference
```

---

## Build Phases

### Phase 1 — Splash Page (Complete)
- Full cinematic splash page deployed on Railway
- All 9 character portraits (Neon Noir K-Pop style)
- Educator audience section (Teachers, Principals, Aides)
- Suspects grid with hover interactions
- Supporting cast section
- Missions preview (locked state)
- Leaderboard preview (placeholder)
- Registration CTA
- Placeholder pages for all inner routes

### Phase 2 — Full Site Content
- The Case page: full narrative, CEO story, timeline
- Suspects page: complete dossiers, evidence board layout
- Missions page: Treasure Troves 1–3 with full instructions
- Leaderboard page: styled score table (static data)
- Resources page: FAQ, rules, ChatGPT tool links
- Register page: team registration form (frontend only)
- Weekly content unlock system (timed reveal UI)

### Phase 3 — Web Apps & Backend
- Express API routes (see /api/ above)
- MySQL database on Railway (teams, submissions, scores)
- OpenAI API integration for automated rubric scoring
- Live leaderboard pulling from database
- Admin dashboard: manage game schedule, review submissions, override scores
- Email notifications on submission and scoring
- Automated weekly content unlock (cron-based)
- Final Accusation form with deadline enforcement

---

## Deployment

Hosted on Railway. Connect this repo to your Railway project and it deploys automatically on every push.

```bash
# Local development
npm install
npm start
# → http://localhost:3000
```

Domain: topkpop.io
