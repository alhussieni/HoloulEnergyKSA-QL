-- Correction to 0021_drop_unused_legacy_indexes.sql: idx_invoices_project
-- was mistakenly included in that drop list. It was actually covering the
-- invoices_project_id_fkey foreign key -- confirmed by Supabase's
-- performance advisor immediately flagging "unindexed_foreign_keys" for
-- that constraint right after the drop. This contradicted the explicit
-- rule stated in 0021 itself (keep indexes that cover foreign keys), so
-- it was a mistake to drop this one. Re-adding it here.
create index if not exists idx_invoices_project on public.invoices (project_id);
