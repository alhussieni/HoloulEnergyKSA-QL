-- Phase 2 views (applied to HoloulEnergyQL as migration "phase2_company_views"). Read-only; no data changes.
create or replace view public.v_settled_project_profit with (security_invoker = true) as
select pp.project_id, pp.project_number, pp.customer_name, f.settled_at,
       pp.contract_gross, pp.contract_net, pp.cost_gross, pp.cost_net,
       round(pp.contract_gross - pp.cost_gross, 2)                      as profit_gross,
       pp.actual_profit                                                 as profit_net,
       round((pp.contract_gross - pp.cost_gross) - pp.actual_profit, 2) as vat_due,
       pp.margin_pct, pp.collected
from public.v_project_profit pp
join public.project_finance_flags f on f.project_id = pp.project_id and f.settled_at is not null;

create or replace view public.v_company_summary with (security_invoker = true) as
with s as (select vat_rate / 100.0 as vr from public.finance_settings where id = 1),
signed as (
  select pp.* from public.v_project_profit pp
  join public.projects p on p.id = pp.project_id
  where p.contract_signed_date is not null and coalesce(p.contract_value, 0) > 0
),
settled_ids as (select project_id from public.project_finance_flags where settled_at is not null),
sp as (
  select count(*) as n, coalesce(sum(profit_gross),0) as pg, coalesce(sum(profit_net),0) as pn,
         coalesce(sum(vat_due),0) as vat
  from public.v_settled_project_profit
),
ex as (
  select coalesce(sum(e.amount) filter (where e.funded_by_partner_id is null), 0) as unf_gross,
         coalesce(sum(case when e.tax_treatment = 'recoverable' then e.amount / (1 + s.vr) else e.amount end)
                  filter (where e.funded_by_partner_id is null), 0) as unf_net,
         coalesce(sum(e.amount) filter (where e.funded_by_partner_id is not null), 0) as funded
  from public.expenses e cross join s
),
unsettled as (
  select count(*) as n,
         coalesce(sum(collected), 0) as collected,
         coalesce(sum(cost_gross), 0) as cost_gross,
         coalesce(sum(greatest(collected - cost_gross, 0)), 0) as reserve
  from signed where project_id not in (select project_id from settled_ids)
),
pay as (
  select coalesce(sum(greatest(balance, 0)), 0) as payables, coalesce(sum(advance_open), 0) as supplier_advances
  from public.v_supplier_balances
),
po as (select coalesce(sum(remaining_to_bill) filter (where remaining_to_bill > 0), 0) as open_po from public.v_purchase_orders),
cash as (select coalesce(sum(balance), 0) as cash_total from public.v_account_balances where active)
select
  (select count(*) from signed)                                         as contracts_count,
  round((select coalesce(sum(contract_gross),0) from signed), 2)        as contracts_value_gross,
  round((select coalesce(sum(contract_net),0) from signed), 2)          as contracts_value_net,
  round((select coalesce(sum(cost_gross),0) from signed), 2)            as contracts_cost_gross,
  round((select coalesce(sum(contract_gross - cost_gross),0) from signed), 2) as contracts_profit_gross,
  round((select coalesce(sum(actual_profit),0) from signed), 2)         as contracts_profit_net,
  sp.n                                                                  as settled_count,
  round(sp.pg, 2)                                                       as settled_profit_gross,
  round(sp.pn, 2)                                                       as settled_profit_net,
  round(sp.vat, 2)                                                      as settled_vat_due,
  unsettled.n                                                           as unsettled_count,
  round(unsettled.collected, 2)                                         as unsettled_collected,
  round(unsettled.cost_gross, 2)                                        as unsettled_cost_gross,
  round(unsettled.reserve, 2)                                           as unsettled_reserve,
  round(ex.unf_gross, 2)                                                as expenses_company_gross,
  round(ex.unf_net, 2)                                                  as expenses_company_net,
  round(ex.funded, 2)                                                   as expenses_partner_funded,
  round(sp.pg - ex.unf_gross, 2)                                        as distributable_gross,
  round(sp.pn - ex.unf_net, 2)                                          as distributable_net,
  round((sp.pg - ex.unf_gross) - (sp.pn - ex.unf_net), 2)               as vat_net_due,
  round(pay.payables, 2)                                                as supplier_payables,
  round(pay.supplier_advances, 2)                                       as supplier_advances,
  round(po.open_po, 2)                                                  as open_po_to_bill,
  round(cash.cash_total, 2)                                             as cash_total
from sp, ex, unsettled, pay, po, cash;


create or replace view public.v_partner_balance_v2 with (security_invoker = true) as
with s as (select vat_rate / 100.0 as vr from public.finance_settings where id = 1),
act as (select id, name from public.partners where active),
proj as (
  select ps.partner_id,
         sum(round(sp.profit_gross * ps.share_pct / 100.0, 2)) as earned_gross,
         sum(round(sp.profit_net   * ps.share_pct / 100.0, 2)) as earned_net
  from public.v_settled_project_profit sp
  join public.partner_shares ps
    on ps.effective_from <= sp.settled_at::date and (ps.effective_to is null or ps.effective_to >= sp.settled_at::date)
  group by ps.partner_id
),
exp as (
  select ps.partner_id,
         sum(round(e.amount * ps.share_pct / 100.0, 2)) as exp_gross,
         sum(round((case when e.tax_treatment = 'recoverable' then e.amount / (1 + s.vr) else e.amount end)
                   * ps.share_pct / 100.0, 2)) as exp_net
  from public.expenses e cross join s
  join public.partner_shares ps
    on ps.effective_from <= e.expense_date and (ps.effective_to is null or ps.effective_to >= e.expense_date)
  where e.funded_by_partner_id is null
  group by ps.partner_id
),
funded as (select funded_by_partner_id as partner_id, sum(amount) as funded from public.expenses
           where funded_by_partner_id is not null group by 1),
contrib as (select partner_id, sum(amount) as contributed from public.treasury_entries
            where kind = 'partner_contribution' group by 1),
dist as (select partner_id, sum(amount) as distributed from public.partner_distributions group by 1),
bearers as (
  select distinct r.partner_id from public.partner_obligation_rules r
  where r.kind in ('*','vat') and r.effective_from <= current_date
    and (r.effective_to is null or r.effective_to >= current_date)
),
vat_total as (select vat_net_due from public.v_company_summary),
led as (
  select partner_id,
         sum(amount_estimated) filter (where kind <> 'vat') as other_est,
         sum(amount_paid) as paid
  from public.partner_obligations where status <> 'waived' group by partner_id
)
select a.id as partner_id, a.name as partner_name,
       round(coalesce(proj.earned_gross, 0), 2)                                  as earned_projects_gross,
       round(coalesce(exp.exp_gross, 0), 2)                                      as company_expenses_share,
       round(coalesce(proj.earned_gross, 0) - coalesce(exp.exp_gross, 0), 2)     as entitlement_gross,
       round(coalesce(proj.earned_net, 0) - coalesce(exp.exp_net, 0), 2)         as entitlement_net,
       round(coalesce(dist.distributed, 0), 2)                                   as distributed,
       round(coalesce(funded.funded, 0), 2)                                      as funded_expenses,
       round(coalesce(contrib.contributed, 0), 2)                                as contributed,
       round(coalesce(funded.funded, 0) - coalesce(contrib.contributed, 0), 2)   as contribution_shortfall,
       round(coalesce(proj.earned_gross, 0) - coalesce(exp.exp_gross, 0)
             - coalesce(dist.distributed, 0)
             - (coalesce(funded.funded, 0) - coalesce(contrib.contributed, 0)), 2) as balance_gross,
       case when a.id in (select partner_id from bearers)
            then round((select vat_net_due from vat_total) / (select count(*) from bearers), 2) else 0 end as vat_estimated,
       round(coalesce(led.other_est, 0), 2)                                      as other_obligations_est,
       round(coalesce(led.paid, 0), 2)                                           as obligations_paid
from act a
left join proj    on proj.partner_id    = a.id
left join exp     on exp.partner_id     = a.id
left join funded  on funded.partner_id  = a.id
left join contrib on contrib.partner_id = a.id
left join dist    on dist.partner_id    = a.id
left join led     on led.partner_id     = a.id;

revoke all on public.v_settled_project_profit from anon, authenticated;
revoke all on public.v_company_summary        from anon, authenticated;
revoke all on public.v_partner_balance_v2     from anon, authenticated;
grant select on public.v_settled_project_profit, public.v_company_summary, public.v_partner_balance_v2 to service_role;
