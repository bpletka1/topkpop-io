-- The Evaluation Room tables (already applied to Supabase as migration "evalroom_stage_a_tables").
-- Row level security is ON with no policies: only the server's secret key can read or write.
create table if not exists public.evalroom_rehearsals (
  id uuid primary key default gen_random_uuid(), team_key text not null, team_name text,
  judge text not null check (judge in ('visual','lyric','lesson')), trove int not null,
  input_text text, input_meta jsonb not null default '{}'::jsonb, ok boolean not null default false,
  score int, max_score int not null, categories jsonb, summary text, strengths jsonb, improvements jsonb,
  raw_answer text, model text, tokens_in int, tokens_out int, cost_usd numeric(10,6),
  created_at timestamptz not null default now());
create index if not exists evalroom_rehearsals_team_idx on public.evalroom_rehearsals (team_key, judge, created_at desc);
create table if not exists public.evalroom_usage (
  id bigint generated always as identity primary key, team_key text not null, kind text not null, model text,
  tokens_in int, tokens_out int, cost_usd numeric(10,6), created_at timestamptz not null default now());
create index if not exists evalroom_usage_created_idx on public.evalroom_usage (created_at desc);
create index if not exists evalroom_usage_team_idx on public.evalroom_usage (team_key, kind, created_at desc);
-- Preview-only test queue. Safe to drop once the room is live.
create table if not exists public.evalroom_selftest (
  id bigint generated always as identity primary key, suite text, label text, kind text not null,
  payload jsonb not null default '{}'::jsonb, status text not null default 'pending', result jsonb,
  created_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz);
alter table public.evalroom_rehearsals enable row level security;
alter table public.evalroom_usage enable row level security;
alter table public.evalroom_selftest enable row level security;
revoke all on public.evalroom_rehearsals, public.evalroom_usage, public.evalroom_selftest from anon, authenticated;

-- Take the Stage: official locks (live site) and practice locks (preview copy), kept apart.
create table if not exists public.evalroom_locks (
  id uuid primary key default gen_random_uuid(), team_key text not null, team_name text,
  trove int not null check (trove in (1,2,3)), judge text not null check (judge in ('visual','lyric','lesson')),
  rehearsal_id uuid not null references public.evalroom_rehearsals(id), score int not null, max_score int not null,
  bonus int not null default 0, bonus_reason text, song_url text, song_check jsonb, dance_video_url text, instagram_post_url text,
  is_preview boolean not null default false, submission_id uuid, locked_at timestamptz not null default now(), reset_at timestamptz, reset_note text);
create unique index if not exists evalroom_locks_one_active on public.evalroom_locks (team_key, trove) where reset_at is null;
create unique index if not exists evalroom_locks_song_once on public.evalroom_locks (lower(song_url)) where reset_at is null and song_url is not null;
create table if not exists public.evalroom_practice_locks (like public.evalroom_locks including defaults including constraints);
create unique index if not exists evalroom_practice_locks_one_active on public.evalroom_practice_locks (team_key, trove) where reset_at is null;
create unique index if not exists evalroom_practice_locks_song_once on public.evalroom_practice_locks (lower(song_url)) where reset_at is null and song_url is not null;
alter table public.evalroom_locks enable row level security;
alter table public.evalroom_practice_locks enable row level security;
revoke all on public.evalroom_locks, public.evalroom_practice_locks from anon, authenticated;
-- Private (non-public) storage for rehearsal pictures.
insert into storage.buckets (id, name, public) values ('evalroom-private', 'evalroom-private', false) on conflict (id) do nothing;
