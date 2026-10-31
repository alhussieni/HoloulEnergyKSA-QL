-- ============================================================================
-- Account types for read-only accounts (table `viewers`):
--   viewer     = partner/follower: projects (costs), suppliers, treasury.
--   accountant = follows treasury + financial movement with customers and
--                suppliers (no project profit / cost breakdown).
-- Both are strictly read-only and only accepted by costs-api. The type is read
-- from this table on every request (not stored in the token), so changing it
-- takes effect immediately.
-- ============================================================================

alter table public.viewers
  add column if not exists role text not null default 'viewer';

alter table public.viewers drop constraint if exists viewers_role_check;
alter table public.viewers
  add constraint viewers_role_check check (role in ('viewer', 'accountant'));
