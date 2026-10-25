-- 0029: الوحدة المالية (أدمن فقط عبر service_role) — إضافة فقط، لا تغيّر أي بيانات قديمة.
-- ملحوظة: اتطبقت على المشروع فعليًا باسم finance_module_v1.
-- الاتفاقية: كل تكلفة/مصروف بيتخزن بالمبلغ المدفوع فعليًا (شامل الضريبة)،
-- وفصل الصافي/الضريبة بيتم في الـ views باستخدام finance_settings.vat_rate.
-- قيم التعاقد في projects مفترض إنها شاملة الضريبة إلا لو اتغيّر في project_finance_flags.

create table if not exists public.finance_settings (
  id int primary key default 1 check (id = 1),
  vat_rate numeric not null default 15 check (vat_rate >= 0 and vat_rate <= 100),
  reserve_pct numeric not null default 0 check (reserve_pct >= 0 and reserve_pct < 100),
  completed_statuses text[] not null default array['commissioned','completed','handed_over','closed'],
  updated_at timestamptz not null default now()
);
insert into public.finance_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.partners (
  id bigint generated always as identity primary key,
  name text not null,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.partner_shares (
  id bigint generated always as identity primary key,
  partner_id bigint not null references public.partners(id) on delete cascade,
  share_pct numeric not null check (share_pct > 0 and share_pct <= 100),
  effective_from date not null default date '2000-01-01',
  effective_to date,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);
create index if not exists partner_shares_partner_idx on public.partner_shares(partner_id);

create table if not exists public.partner_distributions (
  id bigint generated always as identity primary key,
  partner_id bigint not null references public.partners(id),
  amount numeric(14,2) not null check (amount > 0),
  distribution_date date not null default current_date,
  kind text not null default 'profit' check (kind in ('profit','draw','advance')),
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.recurring_expenses (
  id bigint generated always as identity primary key,
  category text not null default 'other',
  description text,
  amount numeric(14,2) not null check (amount >= 0),
  tax_treatment text not null default 'recoverable' check (tax_treatment in ('recoverable','none')),
  start_month date not null default (date_trunc('month', current_date::timestamp))::date,
  end_month date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.expenses (
  id bigint generated always as identity primary key,
  expense_date date not null default current_date,
  category text not null default 'other',
  description text,
  amount numeric(14,2) not null check (amount >= 0),
  tax_treatment text not null default 'recoverable' check (tax_treatment in ('recoverable','none')),
  recurring_id bigint references public.recurring_expenses(id) on delete set null,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists expenses_date_idx on public.expenses(expense_date);
create unique index if not exists expenses_recurring_month_uq
  on public.expenses(recurring_id, expense_date) where recurring_id is not null;

create table if not exists public.project_finance_flags (
  project_id bigint primary key references public.projects(id) on delete cascade,
  contract_includes_vat boolean not null default true,
  completion_date date,
  notes text,
  updated_at timestamptz not null default now()
);

-- أعمدة اختيارية على project_costs (إضافة فقط)
alter table public.project_costs add column if not exists cost_date date;
alter table public.project_costs add column if not exists supplier text;
alter table public.project_costs add column if not exists tax_treatment text not null default 'recoverable';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'project_costs_tax_treatment_chk') then
    alter table public.project_costs add constraint project_costs_tax_treatment_chk
      check (tax_treatment in ('recoverable','none'));
  end if;
end $$;

-- قفل كامل: RLS مفعّل بدون policies، ولا صلاحيات لـ anon/authenticated
do $$ declare t text; begin
  foreach t in array array['finance_settings','partners','partner_shares','partner_distributions',
                           'recurring_expenses','expenses','project_finance_flags'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ------------------------- Views (security_invoker) -------------------------
create or replace view public.v_project_profit with (security_invoker = true) as
with s as (
  select vat_rate / 100.0 as vr, completed_statuses from public.finance_settings where id = 1
),
c as (
  select pc.project_id,
         sum(pc.amount) as cost_gross,
         sum(case when pc.tax_treatment = 'recoverable'
                  then pc.amount - pc.amount / (1 + (select vr from s)) else 0 end) as input_vat
  from public.project_costs pc group by pc.project_id
),
p as (select project_id, sum(amount) as collected from public.payments group by project_id),
base as (
  select pr.id as project_id, pr.project_number, pr.customer_id, cu.name as customer_name,
         pr.status, pr.contract_value,
         (pr.status = any (s.completed_statuses)) as is_completed,
         coalesce(f.completion_date, pr.actual_install_date, pr.updated_at::date) as completion_date,
         coalesce(f.contract_includes_vat, true) as contract_includes_vat,
         coalesce(pr.contract_value, 0) as cv,
         coalesce(c.cost_gross, 0) as cost_gross,
         coalesce(c.input_vat, 0) as input_vat,
         coalesce(p.collected, 0) as collected,
         s.vr
  from public.projects pr
  cross join s
  left join public.customers cu on cu.id = pr.customer_id
  left join public.project_finance_flags f on f.project_id = pr.id
  left join c on c.project_id = pr.id
  left join p on p.project_id = pr.id
),
calc as (
  select *,
    case when contract_includes_vat then cv / (1 + vr) else cv end as contract_net,
    case when contract_includes_vat then cv else cv * (1 + vr) end as contract_gross
  from base
)
select project_id, project_number, customer_id, customer_name, status, is_completed, completion_date,
       contract_includes_vat,
       round(contract_gross, 2) as contract_gross,
       round(contract_net, 2) as contract_net,
       round(contract_gross - contract_net, 2) as output_vat,
       round(cost_gross, 2) as cost_gross,
       round(input_vat, 2) as input_vat,
       round(cost_gross - input_vat, 2) as cost_net,
       round(contract_net - (cost_gross - input_vat), 2) as actual_profit,
       case when contract_net > 0
            then round((contract_net - (cost_gross - input_vat)) / contract_net * 100, 1) end as margin_pct,
       round(collected, 2) as collected,
       round(contract_gross - collected, 2) as remaining
from calc;

create or replace view public.v_monthly_expenses with (security_invoker = true) as
with s as (select vat_rate / 100.0 as vr from public.finance_settings where id = 1)
select date_trunc('month', e.expense_date::timestamp)::date as month,
       e.category,
       round(sum(e.amount), 2) as gross,
       round(sum(case when e.tax_treatment = 'recoverable' then e.amount / (1 + s.vr) else e.amount end), 2) as net,
       round(sum(case when e.tax_treatment = 'recoverable' then e.amount - e.amount / (1 + s.vr) else 0 end), 2) as input_vat
from public.expenses e cross join s
group by 1, 2;

create or replace view public.v_monthly_pnl with (security_invoker = true) as
with months as (
  select generate_series(
    date_trunc('month', least(
      coalesce((select min(completion_date) from public.v_project_profit where is_completed), current_date),
      coalesce((select min(expense_date) from public.expenses), current_date),
      current_date)::timestamp),
    date_trunc('month', current_date::timestamp),
    interval '1 month')::date as month
),
proj as (
  select date_trunc('month', completion_date::timestamp)::date as month,
         count(*) as projects_completed,
         sum(contract_net) as revenue_net,
         sum(cost_net) as project_costs_net,
         sum(actual_profit) as project_profit
  from public.v_project_profit where is_completed group by 1
),
exp as (select month, sum(net) as expenses_net from public.v_monthly_expenses group by month)
select m.month,
       coalesce(proj.projects_completed, 0) as projects_completed,
       round(coalesce(proj.revenue_net, 0), 2) as revenue_net,
       round(coalesce(proj.project_costs_net, 0), 2) as project_costs_net,
       round(coalesce(proj.project_profit, 0), 2) as project_profit,
       round(coalesce(exp.expenses_net, 0), 2) as expenses_net,
       round(coalesce(proj.project_profit, 0) - coalesce(exp.expenses_net, 0), 2) as net_profit
from months m
left join proj on proj.month = m.month
left join exp on exp.month = m.month;

create or replace view public.v_partner_monthly with (security_invoker = true) as
select pn.month, pt.id as partner_id, pt.name as partner_name, ps.share_pct, pn.net_profit,
       round(pn.net_profit * (1 - fs.reserve_pct / 100.0) * ps.share_pct / 100.0, 2) as share_amount
from public.v_monthly_pnl pn
cross join (select reserve_pct from public.finance_settings where id = 1) fs
join public.partner_shares ps
  on ps.effective_from <= ((pn.month + interval '1 month')::date - 1)
 and (ps.effective_to is null or ps.effective_to >= pn.month)
join public.partners pt on pt.id = ps.partner_id and pt.active;

create or replace view public.v_partner_balance with (security_invoker = true) as
select pt.id as partner_id, pt.name as partner_name,
       coalesce(e.earned, 0) as earned,
       coalesce(d.distributed, 0) as distributed,
       coalesce(e.earned, 0) - coalesce(d.distributed, 0) as balance
from public.partners pt
left join (select partner_id, sum(share_amount) as earned from public.v_partner_monthly group by 1) e on e.partner_id = pt.id
left join (select partner_id, sum(amount) as distributed from public.partner_distributions group by 1) d on d.partner_id = pt.id
where pt.active;

-- تقدير الضريبة: ضريبة المخرجات من الدفعات المحصّلة (مفترض شاملة الضريبة)،
-- وضريبة المدخلات من تكاليف المشاريع والمصاريف القابلة للاسترداد. يُطابق مع الإقرار الفعلي.
create or replace view public.v_vat_monthly with (security_invoker = true) as
with s as (select vat_rate / 100.0 as vr from public.finance_settings where id = 1),
outv as (
  select date_trunc('month', p.payment_date::timestamp)::date as month,
         sum(p.amount - p.amount / (1 + s.vr)) as output_vat
  from public.payments p cross join s group by 1
),
inv_proj as (
  select date_trunc('month', coalesce(pc.cost_date, pc.created_at::date)::timestamp)::date as month,
         sum(pc.amount - pc.amount / (1 + s.vr)) as input_vat
  from public.project_costs pc cross join s
  where pc.tax_treatment = 'recoverable' group by 1
),
inv_exp as (select month, sum(input_vat) as input_vat from public.v_monthly_expenses group by month),
months as (
  select month from outv union select month from inv_proj union select month from inv_exp
)
select m.month,
       round(coalesce(o.output_vat, 0), 2) as output_vat,
       round(coalesce(ip.input_vat, 0) + coalesce(ie.input_vat, 0), 2) as input_vat,
       round(coalesce(o.output_vat, 0) - coalesce(ip.input_vat, 0) - coalesce(ie.input_vat, 0), 2) as net_vat_due
from months m
left join outv o on o.month = m.month
left join inv_proj ip on ip.month = m.month
left join inv_exp ie on ie.month = m.month;

do $$ declare v text; begin
  foreach v in array array['v_project_profit','v_monthly_expenses','v_monthly_pnl',
                           'v_partner_monthly','v_partner_balance','v_vat_monthly'] loop
    execute format('revoke all on public.%I from anon, authenticated', v);
  end loop;
end $$;

-- مولّد المصاريف الثابتة (آمن للتكرار لكل بند + شهر)
create or replace function public.finance_generate_recurring(p_month date)
returns integer language plpgsql set search_path = public as $$
declare m date := date_trunc('month', p_month::timestamp)::date; n integer;
begin
  insert into public.expenses (expense_date, category, description, amount, tax_treatment, recurring_id, created_by)
  select m, r.category, r.description, r.amount, r.tax_treatment, r.id, 'recurring'
  from public.recurring_expenses r
  where r.active and r.start_month <= m and (r.end_month is null or r.end_month >= m)
  on conflict (recurring_id, expense_date) where recurring_id is not null do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.finance_generate_recurring(date) from public, anon, authenticated;

-- بيانات أولية: شريكين 50/50 (غيّر الأسماء من شاشة المالية)
insert into public.partners (name)
select v.n from (values ('الشريك الأول'), ('الشريك الثاني')) v(n)
where not exists (select 1 from public.partners);
insert into public.partner_shares (partner_id, share_pct)
select id, 50 from public.partners
where not exists (select 1 from public.partner_shares);
