-- =====================================================================
-- Phase 1 — Company / Partners schema (HoloulEnergyQL: xhgwvszdatqlvlgqiikj)
-- DRAFT FOR REVIEW — NOT APPLIED.
-- Additive only: no existing rows are deleted; one CHECK constraint is
-- replaced (treasury_entries_kind_check) to add a new allowed value.
-- Access model (matches existing code): RLS enabled with NO policies on new
-- tables; access only through service_role (Edge Functions / RPC).
-- =====================================================================
begin;

-- ---------------------------------------------------------------------
-- 1) Partner contact details
-- ---------------------------------------------------------------------
alter table public.partners
  add column if not exists phone             text,
  add column if not exists whatsapp          text,
  add column if not exists email             text,
  add column if not exists preferred_contact text;

alter table public.partners drop constraint if exists partners_preferred_contact_check;
alter table public.partners add constraint partners_preferred_contact_check
  check (preferred_contact is null or preferred_contact in ('phone','whatsapp','email'));

-- ---------------------------------------------------------------------
-- 2) Partner bank accounts (admin-only data; never exposed to viewer)
-- ---------------------------------------------------------------------
create table if not exists public.partner_bank_accounts (
  id             bigint generated always as identity primary key,
  partner_id     bigint not null references public.partners(id) on delete restrict,
  bank_name      text   not null,
  account_holder text   not null,
  iban           text,
  account_number text,
  is_default     boolean not null default false,
  active         boolean not null default true,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint partner_bank_iban_format check (
    iban is null
    or (iban ~ '^[A-Z]{2}[0-9A-Z]{13,32}$' and (iban !~ '^SA' or iban ~ '^SA[0-9]{22}$'))
  ),
  constraint partner_bank_has_identifier check (iban is not null or account_number is not null)
);

create index if not exists partner_bank_accounts_partner_idx
  on public.partner_bank_accounts (partner_id);

-- at most one active default account per partner
create unique index if not exists partner_bank_one_default
  on public.partner_bank_accounts (partner_id)
  where is_default and active;

-- normalise IBAN (strip spaces, uppercase) and keep updated_at fresh
create or replace function public.trg_partner_bank_normalize()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.iban is not null then
    new.iban := upper(regexp_replace(new.iban, '\s', '', 'g'));
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists partner_bank_normalize on public.partner_bank_accounts;
create trigger partner_bank_normalize
  before insert or update on public.partner_bank_accounts
  for each row execute function public.trg_partner_bank_normalize();

-- ---------------------------------------------------------------------
-- 3) partner_shares integrity: valid range + no overlapping periods
-- ---------------------------------------------------------------------
alter table public.partner_shares drop constraint if exists partner_shares_pct_range;
alter table public.partner_shares add constraint partner_shares_pct_range
  check (share_pct > 0 and share_pct <= 100);

create or replace function public.trg_partner_shares_no_overlap()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.effective_to is not null and new.effective_to < new.effective_from then
    raise exception 'partner_shares: effective_to is before effective_from';
  end if;
  if exists (
    select 1 from public.partner_shares s
    where s.partner_id = new.partner_id
      and s.id is distinct from new.id
      and daterange(s.effective_from, s.effective_to, '[]')
          && daterange(new.effective_from, new.effective_to, '[]')
  ) then
    raise exception 'partner_shares: overlapping period for partner %', new.partner_id;
  end if;
  return new;
end $$;

drop trigger if exists partner_shares_no_overlap on public.partner_shares;
create trigger partner_shares_no_overlap
  before insert or update on public.partner_shares
  for each row execute function public.trg_partner_shares_no_overlap();

-- helper: total share percentage effective on a date (must equal 100)
create or replace function public.partner_shares_sum(p_date date default current_date)
returns numeric language sql stable set search_path = public as $$
  select coalesce(sum(share_pct), 0)
  from public.partner_shares
  where effective_from <= p_date and (effective_to is null or effective_to >= p_date);
$$;

-- ---------------------------------------------------------------------
-- 4) Project settlement + reserve + tax point
--    "Completed" (for partner entitlement) = settled_at IS NOT NULL
-- ---------------------------------------------------------------------
alter table public.project_finance_flags
  add column if not exists settled_at     timestamptz,
  add column if not exists settled_by     text,
  add column if not exists expected_cost  numeric check (expected_cost is null or expected_cost >= 0),
  add column if not exists tax_point_date date;

-- ---------------------------------------------------------------------
-- 5) Partner-funded expenses (rent + salary funded by Mubarak)
-- ---------------------------------------------------------------------
alter table public.recurring_expenses
  add column if not exists funded_by_partner_id bigint references public.partners(id) on delete restrict,
  add column if not exists payee_type text;

alter table public.expenses
  add column if not exists funded_by_partner_id bigint references public.partners(id) on delete restrict,
  add column if not exists payee_type text;

alter table public.recurring_expenses drop constraint if exists recurring_expenses_payee_type_check;
alter table public.recurring_expenses add constraint recurring_expenses_payee_type_check
  check (payee_type is null or payee_type in ('employee','partner','supplier','government','other'));

alter table public.expenses drop constraint if exists expenses_payee_type_check;
alter table public.expenses add constraint expenses_payee_type_check
  check (payee_type is null or payee_type in ('employee','partner','supplier','government','other'));

create index if not exists expenses_funded_by_idx
  on public.expenses (funded_by_partner_id) where funded_by_partner_id is not null;

-- new generated expenses inherit funding/payee from their recurring template
create or replace function public.trg_expense_inherit_recurring()
returns trigger language plpgsql set search_path = public as $$
declare f bigint; pt text;
begin
  if new.recurring_id is not null then
    select r.funded_by_partner_id, r.payee_type into f, pt
    from public.recurring_expenses r where r.id = new.recurring_id;
    new.funded_by_partner_id := coalesce(new.funded_by_partner_id, f);
    new.payee_type           := coalesce(new.payee_type, pt);
  end if;
  return new;
end $$;

drop trigger if exists expense_inherit_recurring on public.expenses;
create trigger expense_inherit_recurring
  before insert on public.expenses
  for each row execute function public.trg_expense_inherit_recurring();

-- backfill: rent + salary templates are funded by Mubarak (partner id 2)
update public.recurring_expenses
   set funded_by_partner_id = 2
 where category in ('rent','salary')
   and funded_by_partner_id is null
   and exists (select 1 from public.partners p where p.id = 2 and p.name like 'مبارك%');

update public.recurring_expenses set payee_type = 'employee'
 where category = 'salary' and payee_type is null;

update public.expenses e
   set funded_by_partner_id = r.funded_by_partner_id,
       payee_type           = coalesce(e.payee_type, r.payee_type)
  from public.recurring_expenses r
 where e.recurring_id = r.id
   and e.funded_by_partner_id is null
   and r.funded_by_partner_id is not null;

-- ---------------------------------------------------------------------
-- 6) Treasury: partner contributions (not revenue, not an expense)
-- ---------------------------------------------------------------------
alter table public.treasury_entries
  add column if not exists partner_id bigint references public.partners(id) on delete restrict;

alter table public.treasury_entries drop constraint if exists treasury_entries_kind_check;
alter table public.treasury_entries add constraint treasury_entries_kind_check
  check (kind = any (array['customer_receipt','supplier_payment','supplier_refund',
                           'expense','partner_draw','partner_contribution','transfer','other']));

alter table public.treasury_entries drop constraint if exists treasury_contribution_check;
alter table public.treasury_entries add constraint treasury_contribution_check
  check (kind <> 'partner_contribution' or (direction = 'in' and partner_id is not null));

create index if not exists treasury_entries_partner_idx
  on public.treasury_entries (partner_id) where partner_id is not null;

-- ---------------------------------------------------------------------
-- 7) Partner obligations ledger (government obligations borne by a partner,
--    paid by that partner directly, OUTSIDE the treasury)
-- ---------------------------------------------------------------------
create table if not exists public.partner_obligation_rules (
  id             bigint generated always as identity primary key,
  partner_id     bigint not null references public.partners(id) on delete restrict,
  kind           text   not null default '*'
                 check (kind in ('*','vat','fine','zakat','fee','other')),
  effective_from date   not null,
  effective_to   date,
  notes          text,
  created_at     timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);

create table if not exists public.partner_obligations (
  id               bigint generated always as identity primary key,
  partner_id       bigint not null references public.partners(id) on delete restrict,
  kind             text   not null check (kind in ('vat','fine','zakat','fee','other')),
  project_id       bigint references public.projects(id) on delete set null,
  period_label     text,                       -- e.g. '2026-Q3'
  description      text,
  amount_estimated numeric not null default 0 check (amount_estimated >= 0),
  amount_paid      numeric not null default 0 check (amount_paid >= 0),
  status           text   not null default 'estimated'
                   check (status in ('estimated','partial','paid','waived')),
  due_date         date,
  paid_date        date,
  reference        text,                       -- return number / receipt number
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists partner_obligations_partner_status_idx
  on public.partner_obligations (partner_id, status);
create index if not exists partner_obligations_project_idx
  on public.partner_obligations (project_id) where project_id is not null;

create or replace function public.trg_touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists partner_obligations_touch on public.partner_obligations;
create trigger partner_obligations_touch
  before update on public.partner_obligations
  for each row execute function public.trg_touch_updated_at();

-- agreement: all government obligations (VAT, fines, zakat, fees) are Mubarak's
insert into public.partner_obligation_rules (partner_id, kind, effective_from, notes)
select 2, '*', coalesce((select min(effective_from) from public.partner_shares), date '2026-01-01'),
       'Agreement: government obligations (VAT, fines, zakat, fees) borne by this partner'
where exists (select 1 from public.partners p where p.id = 2 and p.name like 'مبارك%')
  and not exists (select 1 from public.partner_obligation_rules where partner_id = 2 and kind = '*');

-- ---------------------------------------------------------------------
-- 8) Settings
-- ---------------------------------------------------------------------
alter table public.finance_settings
  add column if not exists vat_filing_period text not null default 'quarterly';

alter table public.finance_settings drop constraint if exists finance_settings_vat_filing_period_check;
alter table public.finance_settings add constraint finance_settings_vat_filing_period_check
  check (vat_filing_period in ('monthly','quarterly'));

-- ---------------------------------------------------------------------
-- 9) Security: RLS on, no policies, service_role only
-- ---------------------------------------------------------------------
alter table public.partner_bank_accounts    enable row level security;
alter table public.partner_obligation_rules enable row level security;
alter table public.partner_obligations      enable row level security;

revoke all on public.partner_bank_accounts    from anon, authenticated;
revoke all on public.partner_obligation_rules from anon, authenticated;
revoke all on public.partner_obligations      from anon, authenticated;

grant all on public.partner_bank_accounts    to service_role;
grant all on public.partner_obligation_rules to service_role;
grant all on public.partner_obligations      to service_role;

revoke all on function public.partner_shares_sum(date) from public, anon, authenticated;
grant execute on function public.partner_shares_sum(date) to service_role;

commit;

-- ---------------------------------------------------------------------
-- Verification (run after applying)
-- select public.partner_shares_sum(current_date);                       -- expect 100
-- select id, category, funded_by_partner_id, payee_type from public.recurring_expenses;
-- select count(*) from public.expenses where recurring_id is not null and funded_by_partner_id = 2;  -- expect 15
-- select * from public.partner_obligation_rules;
-- ---------------------------------------------------------------------
-- Rollback (manual, if needed; drops only objects created above)
-- drop table if exists public.partner_obligations, public.partner_obligation_rules, public.partner_bank_accounts;
-- drop trigger if exists expense_inherit_recurring on public.expenses;
-- drop trigger if exists partner_shares_no_overlap on public.partner_shares;
-- alter table public.treasury_entries drop constraint if exists treasury_contribution_check;
-- (restore treasury_entries_kind_check without 'partner_contribution'; columns can stay)
-- ---------------------------------------------------------------------
