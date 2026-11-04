-- Phase 3A (applied to HoloulEnergyQL as migration "phase3a_invoicing_vat_exposure").
-- Adds 3 settings columns + two read-only views. No invoice/customer/supplier data is changed.
alter table public.finance_settings
  add column if not exists invoice_b2b_due_days int not null default 15 check (invoice_b2b_due_days >= 0),
  add column if not exists invoice_b2c_due_days int not null default 0  check (invoice_b2c_due_days >= 0),
  add column if not exists block_settle_without_invoice boolean not null default false;

create or replace view public.v_project_invoicing with (security_invoker = true) as
with st as (
  select coalesce(vat_rate, 15) / 100.0 as vr, invoice_b2b_due_days as b2b, invoice_b2c_due_days as b2c
  from public.finance_settings where id = 1
),
inv as (
  select i.project_id,
         count(*) filter (where i.document_type = 'invoice') as invoice_count,
         coalesce(sum(case when i.document_type = 'credit_note' then -i.total      else i.total      end), 0) as invoiced_gross,
         coalesce(sum(case when i.document_type = 'credit_note' then -i.vat_amount else i.vat_amount end), 0) as output_vat_invoiced,
         min(coalesce(i.supply_date, i.issued_at::date)) filter (where i.document_type = 'invoice') as first_invoice_date
  from public.invoices i where i.project_id is not null group by i.project_id
),
pay as (select project_id, min(payment_date) as first_pay from public.payments group by project_id),
base as (
  select pp.project_id, pp.project_number, pp.customer_name, p.customer_id,
         coalesce(c.customer_type, 'individual') as customer_type,
         (c.vat_number is not null and c.vat_number <> '') as customer_is_b2b,
         pp.contract_gross, pp.collected,
         case when p.actual_supply_date is null and coalesce(inv.invoice_count, 0) = 0 then pp.collected else pp.contract_gross end as basis_gross,
         round(pp.cost_gross - pp.cost_net, 2) as input_vat,
         coalesce(inv.invoice_count, 0) as invoice_count,
         round(coalesce(inv.invoiced_gross, 0), 2) as invoiced_gross,
         round(coalesce(inv.output_vat_invoiced, 0), 2) as output_vat_invoiced,
         p.actual_supply_date as supply_date, pay.first_pay as first_payment_date,
         f.tax_point_date as tax_point_override,
         coalesce(f.tax_point_date, least(p.actual_supply_date, pay.first_pay, inv.first_invoice_date)) as tax_point,
         st.vr, st.b2b, st.b2c
  from public.v_project_profit pp
  join public.projects p on p.id = pp.project_id
  left join public.customers c on c.id = p.customer_id
  left join inv on inv.project_id = pp.project_id
  left join pay on pay.project_id = pp.project_id
  left join public.project_finance_flags f on f.project_id = pp.project_id
  cross join st
  where p.contract_signed_date is not null and coalesce(p.contract_value, 0) > 0
)
select project_id, project_number, customer_name, customer_id, customer_type, customer_is_b2b,
       contract_gross, collected, round(basis_gross, 2) as basis_gross,
       invoice_count, invoiced_gross, output_vat_invoiced,
       round(basis_gross - invoiced_gross, 2) as uninvoiced_gross,
       round(greatest(basis_gross - invoiced_gross, 0) * vr / (1 + vr), 2) as output_vat_uninvoiced_est,
       round(output_vat_invoiced + greatest(basis_gross - invoiced_gross, 0) * vr / (1 + vr), 2) as output_vat_effective,
       input_vat, supply_date, first_payment_date, tax_point, tax_point_override,
       case when tax_point is null then null else to_char(tax_point, 'YYYY"-Q"Q') end as quarter,
       case when tax_point is null then null
            when customer_is_b2b then ((date_trunc('month', tax_point) + interval '1 month - 1 day')::date + b2b)
            else tax_point + b2c end as invoice_due_date,
       case when tax_point is null or (basis_gross - invoiced_gross) <= 1 then 0
            else greatest(current_date - (case when customer_is_b2b
                   then ((date_trunc('month', tax_point) + interval '1 month - 1 day')::date + b2b)
                   else tax_point + b2c end), 0) end as days_overdue
from base;

create or replace view public.v_vat_exposure_quarterly with (security_invoker = true) as
with st as (select coalesce(vat_rate, 15) / 100.0 as vr from public.finance_settings where id = 1),
pj as (
  select coalesce(quarter, 'غير محدد') as quarter,
         count(*) as projects,
         count(*) filter (where uninvoiced_gross > 1) as uninvoiced_projects,
         coalesce(sum(output_vat_invoiced), 0) as output_vat_invoiced,
         coalesce(sum(output_vat_uninvoiced_est), 0) as output_vat_estimated,
         coalesce(sum(input_vat), 0) as input_vat_projects
  from public.v_project_invoicing group by 1
),
ex as (
  select to_char(e.expense_date, 'YYYY"-Q"Q') as quarter,
         coalesce(sum(e.amount - e.amount / (1 + st.vr)), 0) as input_vat_expenses
  from public.expenses e cross join st
  where e.tax_treatment = 'recoverable' group by 1
)
select coalesce(pj.quarter, ex.quarter) as quarter,
       coalesce(pj.projects, 0) as projects,
       coalesce(pj.uninvoiced_projects, 0) as uninvoiced_projects,
       round(coalesce(pj.output_vat_invoiced, 0), 2) as output_vat_invoiced,
       round(coalesce(pj.output_vat_estimated, 0), 2) as output_vat_estimated,
       round(coalesce(pj.output_vat_invoiced, 0) + coalesce(pj.output_vat_estimated, 0), 2) as output_vat_total,
       round(coalesce(pj.input_vat_projects, 0), 2) as input_vat_projects,
       round(coalesce(ex.input_vat_expenses, 0), 2) as input_vat_expenses,
       round(coalesce(pj.output_vat_invoiced, 0) + coalesce(pj.output_vat_estimated, 0)
             - coalesce(pj.input_vat_projects, 0) - coalesce(ex.input_vat_expenses, 0), 2) as net_vat
from pj full join ex on ex.quarter = pj.quarter;

revoke all on public.v_project_invoicing, public.v_vat_exposure_quarterly from anon, authenticated;
grant select on public.v_project_invoicing, public.v_vat_exposure_quarterly to service_role;
