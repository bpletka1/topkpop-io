-- TopKpop.io Supabase Database Schema
-- Run this in Supabase SQL Editor to create all tables

-- ── Registrations ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS registrations (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  team_name       TEXT NOT NULL,
  captain_name    TEXT NOT NULL,
  captain_email   TEXT NOT NULL UNIQUE,
  school_name     TEXT NOT NULL,
  district        TEXT,
  role            TEXT,
  grade_levels    TEXT[],
  member2_name    TEXT,
  member2_email   TEXT,
  member3_name    TEXT,
  member3_email   TEXT,
  member4_name    TEXT,
  member4_email   TEXT,
  status          TEXT DEFAULT 'active',  -- active | disqualified | winner
  mailchimp_added BOOLEAN DEFAULT FALSE,
  welcome_sent    BOOLEAN DEFAULT FALSE,
  notes           TEXT
);

-- ── Submissions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS submissions (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  team_id         UUID REFERENCES registrations(id) ON DELETE CASCADE,
  team_name       TEXT NOT NULL,
  trove_number    INTEGER NOT NULL CHECK (trove_number IN (1, 2, 3)),
  -- File storage paths in Supabase Storage
  file1_path      TEXT,  -- Trove 01: avatar | Trove 02: lyrics | Trove 03: lesson plan
  file1_name      TEXT,
  file2_path      TEXT,  -- Trove 01: poster | Trove 02: suno track | Trove 03: reflection
  file2_name      TEXT,
  file3_path      TEXT,  -- Trove 02: music video
  file3_name      TEXT,
  notes           TEXT,
  -- Scoring
  oracle_score    INTEGER,
  admin_score     INTEGER,
  final_score     INTEGER,
  scored_at       TIMESTAMPTZ,
  score_email_sent BOOLEAN DEFAULT FALSE,
  UNIQUE(team_id, trove_number)
);

-- ── Final Accusations ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS accusations (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  team_id         UUID REFERENCES registrations(id) ON DELETE CASCADE,
  team_name       TEXT NOT NULL,
  accused_suspect TEXT NOT NULL,
  evidence_summary TEXT,
  motive          TEXT,
  is_correct      BOOLEAN,
  accusation_score INTEGER DEFAULT 0,  -- bonus points for correct accusation
  result_email_sent BOOLEAN DEFAULT FALSE
);

-- ── Game Settings ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_settings (
  id              INTEGER PRIMARY KEY DEFAULT 1,  -- single row
  game_start_date DATE,
  trove1_unlock   DATE,
  trove2_unlock   DATE,
  trove3_unlock   DATE,
  accusation_open DATE,
  accusation_close DATE,
  correct_saboteur TEXT,  -- kept confidential
  trove1_email_sent BOOLEAN DEFAULT FALSE,
  trove2_email_sent BOOLEAN DEFAULT FALSE,
  trove3_email_sent BOOLEAN DEFAULT FALSE,
  accusation_email_sent BOOLEAN DEFAULT FALSE,
  winner_announced BOOLEAN DEFAULT FALSE,
  winner_team_id  UUID REFERENCES registrations(id),
  prize_email_sent BOOLEAN DEFAULT FALSE,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default game settings row
INSERT INTO game_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Leaderboard View ────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW leaderboard AS
SELECT
  r.id,
  r.team_name,
  r.school_name,
  r.district,
  COALESCE(s1.final_score, 0) AS trove1_score,
  COALESCE(s2.final_score, 0) AS trove2_score,
  COALESCE(s3.final_score, 0) AS trove3_score,
  COALESCE(a.accusation_score, 0) AS accusation_bonus,
  (COALESCE(s1.final_score, 0) + COALESCE(s2.final_score, 0) + COALESCE(s3.final_score, 0) + COALESCE(a.accusation_score, 0)) AS total_score,
  r.status
FROM registrations r
LEFT JOIN submissions s1 ON s1.team_id = r.id AND s1.trove_number = 1
LEFT JOIN submissions s2 ON s2.team_id = r.id AND s2.trove_number = 2
LEFT JOIN submissions s3 ON s3.team_id = r.id AND s3.trove_number = 3
LEFT JOIN accusations a ON a.team_id = r.id
WHERE r.status != 'disqualified'
ORDER BY total_score DESC;

-- ── Row Level Security (disable for service key access) ─────────────────────
ALTER TABLE registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE accusations ENABLE ROW LEVEL SECURITY;
ALTER TABLE game_settings ENABLE ROW LEVEL SECURITY;

-- Allow all operations via service role (backend uses service key)
CREATE POLICY "Service role full access" ON registrations FOR ALL USING (true);
CREATE POLICY "Service role full access" ON submissions FOR ALL USING (true);
CREATE POLICY "Service role full access" ON accusations FOR ALL USING (true);
CREATE POLICY "Service role full access" ON game_settings FOR ALL USING (true);
