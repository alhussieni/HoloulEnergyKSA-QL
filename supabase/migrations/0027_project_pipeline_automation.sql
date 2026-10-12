-- 0027_project_pipeline_automation.sql
--
-- Makes the CRM pipeline automatic for supply-only projects: the opportunity
-- stage, customer status and project status now follow what happens on the
-- project (creation, payments, receipt from the warehouse, cancellation).
--
-- Everything is done with triggers, so it works no matter which Edge Function
-- (or SQL) writes the row. Every trigger FAILS OPEN: if an automatic step
-- errors, it only raises a warning and the user's own save still succeeds.
--
-- Rules
--   quote saved for a customer ............ customer 'new' -> 'contacted'
--   project created ....................... opportunity -> 'won', customer -> 'won',
--                                           latest draft/sent quotation -> 'accepted',
--                                           status 'pending' -> 'preparing'
--   payments change / contract value change  projects.payment_status = unpaid | partial | paid
--   actual_supply_date filled ............. project status -> 'commissioned'
--                                           (shown as "تم الاستلام من المخزن")
--   actual_supply_date cleared ............ 'commissioned' -> 'preparing'
--   project cancelled or deleted .......... opportunity 'won' -> 'negotiation' (+ follow-up),
--                                           customer 'won' -> 'negotiating' (only if no other live project)
--   project restored from 'cancelled' ..... back to won
-- Existing rows are not rewritten except for the new payment_status column.

-- 1) payment status on the project ------------------------------------------
alter table public.projects
  add column if not exists payment_status text not null default 'unpaid';

comment on column public.projects.payment_status is
  'unpaid | partial | paid — derived from payments vs contract_value by trigger';

-- 2) system audit helper ------------------------------------------------------
create or replace function public.sys_audit(
  p_action text, p_entity text, p_id bigint, p_label text, p_old jsonb, p_new jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log
    (actor, actor_role, action_type, entity_type, entity_id, entity_label, old_value, new_value)
  values ('system', 'system', p_action, p_entity, p_id, p_label, p_old, p_new);
exception when others then
  null; -- never break the primary action over a logging failure
end $$;

-- 3) payments -> projects.payment_status --------------------------------------
create or replace function public.fn_project_recalc_payment(p_project bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cv numeric; v_old text; v_label text; v_paid numeric; v_new text;
begin
  select contract_value, payment_status, project_number
    into v_cv, v_old, v_label
    from public.projects where id = p_project;
  if not found then return; end if;

  select coalesce(sum(amount), 0) into v_paid
    from public.payments where project_id = p_project;

  v_new := case
    when v_paid <= 0 then 'unpaid'
    when coalesce(v_cv, 0) > 0 and v_paid >= v_cv then 'paid'
    else 'partial' end;

  if v_new is distinct from v_old then
    update public.projects set payment_status = v_new where id = p_project;
    perform public.sys_audit('auto_sync', 'project', p_project, v_label,
      jsonb_build_object('payment_status', v_old, 'paid', v_paid),
      jsonb_build_object('payment_status', v_new, 'paid', v_paid));
  end if;
end $$;

create or replace function public.trg_payments_recalc()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if tg_op in ('INSERT', 'UPDATE') then
      perform public.fn_project_recalc_payment(new.project_id);
    end if;
    if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.project_id is distinct from new.project_id) then
      perform public.fn_project_recalc_payment(old.project_id);
    end if;
  exception when others then
    raise warning 'trg_payments_recalc failed: %', sqlerrm;
  end;
  return null;
end $$;

drop trigger if exists trg_payments_recalc on public.payments;
create trigger trg_payments_recalc
  after insert or update or delete on public.payments
  for each row execute function public.trg_payments_recalc();

create or replace function public.trg_projects_contract_recalc()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if new.contract_value is distinct from old.contract_value then
      perform public.fn_project_recalc_payment(new.id);
    end if;
  exception when others then
    raise warning 'trg_projects_contract_recalc failed: %', sqlerrm;
  end;
  return null;
end $$;

drop trigger if exists trg_projects_contract_recalc on public.projects;
create trigger trg_projects_contract_recalc
  after update of contract_value on public.projects
  for each row execute function public.trg_projects_contract_recalc();

-- 4) receipt from warehouse -> project status ---------------------------------
create or replace function public.trg_projects_status_auto()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if tg_op = 'INSERT' then
      if new.status is null or new.status = 'pending' then
        new.status := 'preparing';
      end if;
      if new.actual_supply_date is not null and new.status <> 'cancelled' then
        new.status := 'commissioned';
      end if;
    else
      if new.actual_supply_date is distinct from old.actual_supply_date then
        if new.actual_supply_date is not null and new.status <> 'cancelled' then
          new.status := 'commissioned';
        elsif new.actual_supply_date is null
              and new.status = 'commissioned' and old.status = 'commissioned' then
          new.status := 'preparing';
        end if;
      end if;
    end if;
  exception when others then
    raise warning 'trg_projects_status_auto failed: %', sqlerrm;
  end;
  return new;
end $$;

drop trigger if exists trg_projects_status_auto on public.projects;
create trigger trg_projects_status_auto
  before insert or update of actual_supply_date on public.projects
  for each row execute function public.trg_projects_status_auto();

-- 5) project -> opportunity + customer ---------------------------------------
create or replace function public.fn_sync_project_pipeline(p_opp bigint, p_cust bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_today date := (now() at time zone 'Asia/Riyadh')::date;
begin
  if exists (select 1 from public.projects
              where opportunity_id = p_opp and status <> 'cancelled') then
    -- a live project exists: the deal is won
    for r in select id, name, stage from public.opportunities
              where id = p_opp and stage is distinct from 'won' loop
      update public.opportunities
         set stage = 'won', stage_changed_at = now(), probability = 100,
             next_follow_up_date = null, updated_at = now()
       where id = r.id;
      perform public.sys_audit('stage_change', 'opportunity', r.id, r.name,
        jsonb_build_object('stage', r.stage), jsonb_build_object('stage', 'won', 'auto', true));
    end loop;

    if not exists (select 1 from public.quotations
                    where opportunity_id = p_opp and status = 'accepted') then
      update public.quotations set status = 'accepted', updated_at = now()
       where id = (select id from public.quotations
                    where opportunity_id = p_opp and status in ('draft', 'sent')
                    order by version desc, id desc limit 1);
    end if;

    for r in select id, name, status from public.customers
              where id = p_cust and status is distinct from 'won' loop
      update public.customers set status = 'won', updated_at = now() where id = r.id;
      perform public.sys_audit('status_change', 'customer', r.id, r.name,
        jsonb_build_object('status', r.status), jsonb_build_object('status', 'won', 'auto', true));
    end loop;
  else
    -- no live project left: reopen the deal for follow-up
    for r in select id, name, stage from public.opportunities
              where id = p_opp and stage = 'won' loop
      update public.opportunities
         set stage = 'negotiation', stage_changed_at = now(), probability = null,
             next_action = 'متابعة بعد إلغاء المشروع',
             next_follow_up_date = v_today + 2, updated_at = now()
       where id = r.id;
      perform public.sys_audit('stage_change', 'opportunity', r.id, r.name,
        jsonb_build_object('stage', 'won'), jsonb_build_object('stage', 'negotiation', 'auto', true));
    end loop;

    if not exists (select 1 from public.projects
                    where customer_id = p_cust and status <> 'cancelled') then
      for r in select id, name from public.customers
                where id = p_cust and status = 'won' loop
        update public.customers set status = 'negotiating', updated_at = now() where id = r.id;
        perform public.sys_audit('status_change', 'customer', r.id, r.name,
          jsonb_build_object('status', 'won'), jsonb_build_object('status', 'negotiating', 'auto', true));
      end loop;
    end if;
  end if;
end $$;

create or replace function public.trg_projects_pipeline_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if tg_op = 'INSERT' then
      perform public.fn_sync_project_pipeline(new.opportunity_id, new.customer_id);
    elsif tg_op = 'DELETE' then
      perform public.fn_sync_project_pipeline(old.opportunity_id, old.customer_id);
    elsif tg_op = 'UPDATE'
          and ((old.status = 'cancelled') is distinct from (new.status = 'cancelled')) then
      perform public.fn_sync_project_pipeline(new.opportunity_id, new.customer_id);
    end if;
  exception when others then
    raise warning 'trg_projects_pipeline_sync failed: %', sqlerrm;
  end;
  return null;
end $$;

drop trigger if exists trg_projects_pipeline_sync on public.projects;
create trigger trg_projects_pipeline_sync
  after insert or delete or update of status on public.projects
  for each row execute function public.trg_projects_pipeline_sync();

-- 6) a saved quote means the customer was contacted ---------------------------
create or replace function public.trg_quotes_mark_contacted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    if new.customer_id is not null then
      update public.customers set status = 'contacted', updated_at = now()
       where id = new.customer_id and status = 'new';
    end if;
  exception when others then
    raise warning 'trg_quotes_mark_contacted failed: %', sqlerrm;
  end;
  return new;
end $$;

drop trigger if exists trg_quotes_mark_contacted on public.quotes;
create trigger trg_quotes_mark_contacted
  after insert on public.quotes
  for each row execute function public.trg_quotes_mark_contacted();

-- 7) status labels (supply-only: the customer installs and commissions) -------
update public.crm_settings
   set data = jsonb_set(data, '{projectStatuses}', (
         select jsonb_agg(
                  case when e->>'value' = 'commissioned'
                       then jsonb_set(e, '{label}', '"تم الاستلام من المخزن"')
                       else e end
                  order by ord)
                || case when exists (select 1
                                       from jsonb_array_elements(data->'projectStatuses') x
                                      where x->>'value' = 'cancelled')
                        then '[]'::jsonb
                        else '[{"value":"cancelled","label":"ملغي","color":"#e0553f"}]'::jsonb end
           from jsonb_array_elements(data->'projectStatuses') with ordinality t(e, ord)
       )),
       updated_at = now()
 where id = 1;

-- 8) backfill ONLY the new payment_status column (no status/stage rewrite) ----
update public.projects p
   set payment_status = case
         when coalesce(s.paid, 0) <= 0 then 'unpaid'
         when coalesce(p.contract_value, 0) > 0 and s.paid >= p.contract_value then 'paid'
         else 'partial' end
  from (select pr.id, coalesce(sum(py.amount), 0) paid
          from public.projects pr
          left join public.payments py on py.project_id = pr.id
         group by pr.id) s
 where s.id = p.id;

-- 9) these are trigger helpers, not API: lock them away from the REST layer ---
revoke execute on function public.sys_audit(text, text, bigint, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.fn_project_recalc_payment(bigint) from public, anon, authenticated;
revoke execute on function public.fn_sync_project_pipeline(bigint, bigint) from public, anon, authenticated;
revoke execute on function public.trg_payments_recalc() from public, anon, authenticated;
revoke execute on function public.trg_projects_contract_recalc() from public, anon, authenticated;
revoke execute on function public.trg_projects_status_auto() from public, anon, authenticated;
revoke execute on function public.trg_projects_pipeline_sync() from public, anon, authenticated;
revoke execute on function public.trg_quotes_mark_contacted() from public, anon, authenticated;
