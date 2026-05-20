-- Migration: Add early_submission flag to submissions table
-- Marks Trove 01 submissions received before the Week 1 deadline (before trove2_unlock)
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS early_submission BOOLEAN DEFAULT FALSE;
