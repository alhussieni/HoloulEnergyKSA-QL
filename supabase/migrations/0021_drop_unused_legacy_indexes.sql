-- Dropping 15 pre-existing unused indexes after the agreed monitoring period
-- (originally flagged in the security/performance review, deferred for
-- 2-3 months to let real usage patterns develop, still confirmed unused
-- as of 2026-09-27 via Supabase's performance advisor).
--
-- Deliberately NOT dropped:
--   - The 16 FK indexes added in migration 0017 (they exist to prevent a
--     known Postgres performance issue on FK-related delete/update
--     cascades, which doesn't always show as an "index scan" in usage
--     stats even when it's doing real work)
--   - idx_invoices_related_invoice_id / idx_invoices_source_calc_quote_id
--     (days old, tied to the just-launched invoice/credit-note features
--     from migrations 0018-0020 -- too early to judge)
drop index if exists public.idx_opps_stage;
drop index if exists public.idx_opps_follow_up;
drop index if exists public.quotes_client_name_idx;
drop index if exists public.invoices_rep_username_idx;
drop index if exists public.idx_projects_status;
drop index if exists public.idx_assets_serial;
drop index if exists public.idx_customers_status;
drop index if exists public.idx_sites_region;
drop index if exists public.idx_quotations_number;
drop index if exists public.idx_tickets_status;
drop index if exists public.idx_tickets_priority;
drop index if exists public.invoices_approval_status_idx;
drop index if exists public.idx_audit_log_entity;
drop index if exists public.idx_invoices_project;
drop index if exists public.idx_invoices_number;
