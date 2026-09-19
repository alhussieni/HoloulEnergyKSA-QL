-- Add missing indexes on foreign key columns (flagged by Supabase performance advisor)
create index if not exists idx_assets_opportunity_id on public.assets (opportunity_id);
create index if not exists idx_assets_site_id on public.assets (site_id);
create index if not exists idx_invoices_customer_id on public.invoices (customer_id);
create index if not exists idx_invoices_milestone_id on public.invoices (milestone_id);
create index if not exists idx_invoices_source_quotation_id on public.invoices (source_quotation_id);
create index if not exists idx_maintenance_contracts_project_id on public.maintenance_contracts (project_id);
create index if not exists idx_opportunities_contact_id on public.opportunities (contact_id);
create index if not exists idx_opportunities_site_id on public.opportunities (site_id);
create index if not exists idx_projects_site_id on public.projects (site_id);
create index if not exists idx_quotations_customer_id on public.quotations (customer_id);
create index if not exists idx_quotations_linked_quote_id on public.quotations (linked_quote_id);
create index if not exists idx_service_tickets_asset_id on public.service_tickets (asset_id);
create index if not exists idx_service_tickets_project_id on public.service_tickets (project_id);
create index if not exists idx_service_tickets_site_id on public.service_tickets (site_id);
create index if not exists idx_site_surveys_site_id on public.site_surveys (site_id);
create index if not exists idx_technical_studies_quote_id on public.technical_studies (quote_id);
create index if not exists idx_technical_studies_site_survey_id on public.technical_studies (site_survey_id);

-- Fix auth_rls_initplan performance warning: wrap auth.role() in a subselect
-- so Postgres evaluates it once per query instead of once per row.
drop policy if exists "only authenticated can update settings" on public.app_settings;
create policy "only authenticated can update settings"
  on public.app_settings
  for update
  using ((select auth.role()) = 'authenticated');
