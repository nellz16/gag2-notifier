create table if not exists tg_users (
  chat_id text primary key,
  username text,
  first_name text,
  watchlist jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bot_state (
  key text primary key,
  value jsonb,
  updated_at timestamptz not null default now()
);

alter table tg_users enable row level security;
alter table bot_state enable row level security;

-- No public policies are needed. The bot uses the service_role key from Koyeb env vars.
