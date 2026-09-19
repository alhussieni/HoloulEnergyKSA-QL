-- ============================================================================
-- Rep accounts + shared quotes log
-- Lets every rep log in with their own username/password, and lets any rep
-- look up whether a client already received a quote before (from whom, and
-- at what final price) so two reps never quote the same client differently.
-- ============================================================================

create table if not exists public.reps (
  id serial primary key,
  username text not null unique,
  password_hash text not null,
  display_name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.reps enable row level security;
-- No policies -> completely inaccessible from the browser (anon/authenticated
-- keys). Only the Edge Function, using the service_role key, can read/write.

create table if not exists public.quotes (
  id bigserial primary key,
  rep_username text,
  rep_display_name text,
  client_name text,
  client_phone text,
  hp numeric,
  final_total numeric,
  snapshot jsonb,
  created_at timestamptz not null default now()
);
alter table public.quotes enable row level security;
-- Same: locked down completely, Edge Function only.

create index if not exists quotes_client_name_idx on public.quotes (lower(client_name));
create index if not exists quotes_client_phone_idx on public.quotes (client_phone);

-- No starter rep is seeded here on purpose. After deploying the updated
-- Edge Function, log into the Admin Dashboard with the master admin password
-- and use the new "إدارة المناديب" screen to add rep accounts — you type a
-- plain password there and the server hashes it for you, no manual SQL step
-- needed.
