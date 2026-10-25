-- 0032: خصم تسوية على العميل (كسور/سماح). اتطبقت باسم project_discounts_v1 + project_discounts_fix_constraint.
-- مثال: عرض 10,512 والعميل سدّد 10,500 → خصم 12 بيخلّي مديونية العميل صفر.
-- الخصم شامل الضريبة (تخفيض سعر: بينزّل الإيراد وضريبة المبيعات معًا). بيخفّض projects.contract_value،
-- فالـ trigger الموجود (trg_projects_contract_recalc) بيعيد حساب حالة السداد (غير مدفوع/جزئي/مدفوع) في كل مكان.
-- المبلغ الأصلي محفوظ هنا للتدقيق والإلغاء.

create table if not exists public.project_discounts (
  id bigint generated always as identity primary key,
  project_id bigint not null references public.projects(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),                 -- المبلغ المخصوم للعميل (شامل الضريبة)
  contract_value_reduction numeric(14,2) not null check (contract_value_reduction > 0), -- اللي اتخصم فعليًا من contract_value
  reason text not null check (length(btrim(reason)) > 0),
  discount_date date not null default current_date,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists project_discounts_project_idx on public.project_discounts(project_id);
alter table public.project_discounts enable row level security;
revoke all on public.project_discounts from anon, authenticated;

create or replace function public.finance_apply_discount(p_project bigint, p_amount numeric, p_reason text, p_date date)
returns bigint language plpgsql set search_path = public as $$
declare
  v_cv numeric; v_inc boolean; v_vr numeric; v_paid numeric; v_gross numeric; v_red numeric;
  a numeric(14,2) := round(coalesce(p_amount, 0), 2); v_id bigint;
begin
  if a <= 0 then raise exception 'مبلغ الخصم غير صالح'; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then raise exception 'اكتب سبب الخصم'; end if;
  select contract_value into v_cv from projects where id = p_project for update;
  if not found then raise exception 'المشروع غير موجود'; end if;
  v_inc := coalesce((select contract_includes_vat from project_finance_flags where project_id = p_project), true);
  select vat_rate / 100.0 into v_vr from finance_settings where id = 1;
  v_paid := coalesce((select sum(amount) from payments where project_id = p_project), 0);
  v_gross := case when v_inc then coalesce(v_cv, 0) else round(coalesce(v_cv, 0) * (1 + v_vr), 2) end;
  if a > v_gross - v_paid then
    raise exception 'الخصم (%) أكبر من المتبقي على العميل (%)', a, round(v_gross - v_paid, 2);
  end if;
  v_red := case when v_inc then a else round(a / (1 + v_vr), 2) end;
  update projects set contract_value = coalesce(contract_value, 0) - v_red where id = p_project;
  insert into project_discounts (project_id, amount, contract_value_reduction, reason, discount_date, created_by)
  values (p_project, a, v_red, btrim(p_reason), coalesce(p_date, current_date), 'admin') returning id into v_id;
  return v_id;
end $$;

create or replace function public.finance_undo_discount(p_id bigint) returns void
language plpgsql set search_path = public as $$
declare d project_discounts%rowtype;
begin
  select * into d from project_discounts where id = p_id;
  if not found then raise exception 'الخصم غير موجود'; end if;
  perform 1 from projects where id = d.project_id for update;
  update projects set contract_value = coalesce(contract_value, 0) + d.contract_value_reduction where id = d.project_id;
  delete from project_discounts where id = p_id;
end $$;

revoke all on function public.finance_apply_discount(bigint, numeric, text, date) from public, anon, authenticated;
revoke all on function public.finance_undo_discount(bigint) from public, anon, authenticated;
