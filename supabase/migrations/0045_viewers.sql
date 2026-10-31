-- ============================================================================
-- "Viewer" accounts: read-only partners/followers (e.g. a partner who only
-- follows cash flow and projects). Completely separate from `reps`:
--   * own table, own login (viewer-login in costs-api), own token type
--     (sub = "viewer:<username>").
--   * only the costs-api Edge Function accepts that token. crm-api,
--     compute-quote and every finance-* function accept only "rep:" or
--     "admin" tokens, so a viewer can never create quotes, follow up
--     customers, or change anything.
--
-- Supersedes 0044 (reps.can_view_costs): costs-api no longer accepts rep
-- tokens at all, so that column is dropped.
-- ============================================================================

create table if not exists public.viewers (
  id              bigint generated always as identity primary key,
  username        text not null unique,
  password_hash   text not null,
  display_name    text not null,
  active          boolean not null default true,
  session_version integer not null default 1,
  created_at      timestamptz not null default now()
);

alter table public.viewers enable row level security;   -- no policies: service role only
revoke all on public.viewers from anon, authenticated;

alter table public.reps drop column if exists can_view_costs;
