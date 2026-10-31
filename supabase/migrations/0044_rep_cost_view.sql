-- ============================================================================
-- Per-rep read-only access to costs (suppliers / projects / treasury).
--
-- Why a dedicated column and NOT a key inside reps.permissions:
--   compute-quote's "admin-save-rep" rebuilds permissions from a fixed list of
--   keys (pricing/calcs/products/portfolio), so any extra key stored there
--   would be silently wiped the next time the admin saves that rep from the
--   control panel. A separate boolean column is only touched when written
--   explicitly.
--
-- Enforced server-side in the `costs-api` Edge Function (read-only). Nothing
-- in the browser decides access; the UI only hides the tab for reps without it.
-- ============================================================================

alter table public.reps
  add column if not exists can_view_costs boolean not null default false;

comment on column public.reps.can_view_costs is
  'true = this rep may open the read-only "التكاليف" tab (suppliers, project costs, treasury) served by the costs-api Edge Function. Default false.';

-- Grant to Mubarak (username "Mubark").
update public.reps set can_view_costs = true where username = 'Mubark';
