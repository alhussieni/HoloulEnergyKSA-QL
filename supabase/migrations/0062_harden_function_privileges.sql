-- 0062_harden_function_privileges.sql
-- Source: Supabase advisors (security) on project HoloulEnergyQL, 2026-11-20.
-- NOT applied automatically. Review, run PART A, test, then decide on PART B.
--
-- Checked before writing this file:
--   * Every rpc() call in this repo runs inside an edge function created with
--     SUPABASE_SERVICE_ROLE_KEY. No browser code calls /rest/v1 or rpc directly.
--   * service_role keeps its own EXECUTE grant (seen in proacl), so edge functions
--     are unaffected by the revokes below.
--   * Trigger functions are not EXECUTE-checked when a trigger fires (only at
--     CREATE TRIGGER time), so existing triggers keep working.
--   * hp_segment() is called only by three SECURITY DEFINER trigger functions,
--     which run as the owner (postgres), who keeps EXECUTE.
--   * Signatures below were read from the live database, not from older
--     migrations: e.g. live pipeline_alerts is (text,text), while 0025 defines
--     one argument. The repo migrations have drifted from the live schema.

-- =====================================================================
-- PART A  (advisor lints 0028 / 0029): remove public RPC access
-- =====================================================================
begin;

revoke execute on function public.hp_segment(numeric)                      from public, anon, authenticated;
revoke execute on function public.trg_milestone_paid_sync()                from public, anon, authenticated;
revoke execute on function public.trg_opportunities_set_segment()          from public, anon, authenticated;
revoke execute on function public.trg_payment_delete_milestone()           from public, anon, authenticated;
revoke execute on function public.trg_payment_match_milestone()            from public, anon, authenticated;
revoke execute on function public.trg_quotations_set_segment()             from public, anon, authenticated;
revoke execute on function public.trg_quotes_auto_opportunity()            from public, anon, authenticated;
revoke execute on function public.trg_quotes_bump_customer_priority()      from public, anon, authenticated;
revoke execute on function public.trg_quotes_redirect_merged()             from public, anon, authenticated;
revoke execute on function public.trg_quotes_refresh_merged_counts()       from public, anon, authenticated;
revoke execute on function public.trg_quotes_set_segment()                 from public, anon, authenticated;

commit;

-- =====================================================================
-- PART B  (advisor lint 0011): pin search_path. Low value, optional.
-- plpgsql functions: safe.
-- =====================================================================
begin;

alter function public.trg_guard_linked_expense()       set search_path = public, pg_temp;
alter function public.trg_guard_linked_distribution()  set search_path = public, pg_temp;
alter function public.trg_guard_linked_cost()          set search_path = public, pg_temp;
alter function public.pipeline_table(jsonb, text, text, integer, integer) set search_path = public, pg_temp;

commit;

-- =====================================================================
-- PART C  (optional, probably skip): LANGUAGE SQL pipeline functions.
-- A SET clause stops Postgres from inlining a SQL function into the calling
-- query, which can slow the CRM pipeline queries. These functions are already
-- executable only by postgres and service_role (no anon/authenticated), so the
-- risk this fixes is small. Language per migration 0025; confirm live first.
-- =====================================================================
-- begin;
-- alter function public.stage_default_prob(text)                           set search_path = public, pg_temp;
-- alter function public.pipeline_filtered(jsonb)                           set search_path = public, pg_temp;
-- alter function public.pipeline_card(jsonb)                               set search_path = public, pg_temp;
-- alter function public.pipeline_board(jsonb, integer, text[])             set search_path = public, pg_temp;
-- alter function public.pipeline_stage_page(jsonb, text, integer, integer) set search_path = public, pg_temp;
-- alter function public.pipeline_alerts(text, text)                        set search_path = public, pg_temp;
-- commit;

-- =====================================================================
-- VERIFY (read-only) after running PART A
-- =====================================================================
-- select p.oid::regprocedure as fn, p.proacl
-- from pg_proc p join pg_namespace n on n.oid = p.pronamespace
-- where n.nspname = 'public' and (p.proname = 'hp_segment' or p.proname like 'trg\_%')
-- order by 1;
-- Expect: no "=X/postgres", no "anon=", no "authenticated=" on the 11 functions above.
-- Then re-run the Supabase security advisor: lints 0028 and 0029 should drop to 0.

-- =====================================================================
-- ROLLBACK
-- =====================================================================
-- PART A:
--   grant execute on function public.hp_segment(numeric) to public, anon, authenticated;
--   (repeat for each of the 10 trg_* functions listed in PART A)
-- PART B / C:
--   alter function <name>(<args>) reset search_path;
