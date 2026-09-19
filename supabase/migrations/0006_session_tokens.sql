-- ============================================================================
-- Session-token support
-- Adds a "session_version" counter to admin_secret and reps. Login tokens
-- embed the version that was current at issue time; bumping the counter
-- (on password change / rep deactivation-reactivation) instantly invalidates
-- every token issued before the bump, without needing a token blacklist.
-- ============================================================================

alter table public.admin_secret add column if not exists session_version integer not null default 1;
alter table public.reps          add column if not exists session_version integer not null default 1;
