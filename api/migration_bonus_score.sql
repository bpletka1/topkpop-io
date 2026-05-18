-- ── TopKpop.io Migration: Add bonus_score to submissions ────────────────────
-- Run this in Supabase SQL Editor

-- 1. Add bonus_score column to submissions table
ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS bonus_score INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS instagram_post_url TEXT,
  ADD COLUMN IF NOT EXISTS bonus_awarded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bonus_awarded_by TEXT;

-- 2. Add winner approval and pending fields to game_settings (if not already present)
ALTER TABLE game_settings
  ADD COLUMN IF NOT EXISTS winner_pending_approval BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS winner_team_name TEXT,
  ADD COLUMN IF NOT EXISTS winner_captain_email TEXT,
  ADD COLUMN IF NOT EXISTS winner_total_score INTEGER,
  ADD COLUMN IF NOT EXISTS winner_accusation_correct BOOLEAN,
  ADD COLUMN IF NOT EXISTS winner_data JSONB,
  ADD COLUMN IF NOT EXISTS admin_email TEXT,
  ADD COLUMN IF NOT EXISTS reveal_unlock DATE;

-- 3. Update the leaderboard view to include bonus_score in total
CREATE OR REPLACE VIEW leaderboard AS
SELECT
  r.id,
  r.team_name,
  r.school_name,
  r.district,
  COALESCE(s1.final_score, 0) AS trove1_score,
  COALESCE(s2.final_score, 0) AS trove2_score,
  COALESCE(s3.final_score, 0) AS trove3_score,
  COALESCE(s1.bonus_score, 0) AS trove1_bonus,
  COALESCE(s2.bonus_score, 0) AS trove2_bonus,
  COALESCE(s3.bonus_score, 0) AS trove3_bonus,
  COALESCE(a.accusation_score, 0) AS accusation_bonus,
  (
    COALESCE(s1.final_score, 0) + COALESCE(s2.final_score, 0) + COALESCE(s3.final_score, 0)
    + COALESCE(s1.bonus_score, 0) + COALESCE(s2.bonus_score, 0) + COALESCE(s3.bonus_score, 0)
    + COALESCE(a.accusation_score, 0)
  ) AS total_score,
  r.status
FROM registrations r
LEFT JOIN submissions s1 ON s1.team_id = r.id AND s1.trove_number = 1
LEFT JOIN submissions s2 ON s2.team_id = r.id AND s2.trove_number = 2
LEFT JOIN submissions s3 ON s3.team_id = r.id AND s3.trove_number = 3
LEFT JOIN accusations a ON a.team_id = r.id
WHERE r.status != 'disqualified'
ORDER BY total_score DESC;
