-- Migration: add captain_phone to registrations
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS captain_phone TEXT;
