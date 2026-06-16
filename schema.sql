create table if not exists public.tg_users (
  chat_id text primary key,
  username text,
  first_name text,
  watchlist jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bot_state (
  key text primary key,
  value jsonb,
  updated_at timestamptz not null default now()
);

alter table public.tg_users enable row level security;
alter table public.bot_state enable row level security;

-- The app uses BOT_SUPABASE_SERVICE_ROLE from Koyeb, not the browser anon key.
-- These grants make PostgREST/service_role access explicit for raw SQL-created tables.
grant usage on schema public to service_role;
grant all on table public.tg_users to service_role;
grant all on table public.bot_state to service_role;

-- No anon/authenticated policies are needed. Do not expose these tables publicly.
