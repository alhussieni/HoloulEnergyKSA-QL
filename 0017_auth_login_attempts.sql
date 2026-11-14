-- 0017: throttling table for the unified login endpoint (auth-api). Already applied on the live project.
create table if not exists public.auth_login_attempts (
  id bigserial primary key,
  ip text not null,
  username text not null,
  success boolean not null default false,
  at timestamptz not null default now()
);
create index if not exists auth_login_attempts_user_ip_at_idx on public.auth_login_attempts (username, ip, at desc);
create index if not exists auth_login_attempts_ip_at_idx on public.auth_login_attempts (ip, at desc);
alter table public.auth_login_attempts enable row level security; -- no policies on purpose: service_role only
