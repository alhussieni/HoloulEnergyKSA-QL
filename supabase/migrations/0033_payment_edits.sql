-- 0033: تعديل دفعة محصّلة (مبلغ و/أو تاريخ) بواسطة الأدمن مع سجل تعديلات دائم. اتطبقت باسم payment_edits_v1.
-- الدفعة بتتحدّث مكانها (فالـ CRM وتقرير الضريبة وحالة السداد كلهم يشوفوا القيمة الصحيحة)،
-- وحركة الخزنة المرتبطة بتتحدّث معاها، وكل تعديل بيتسجل بالقيمة القديمة والجديدة والسبب.
-- payment_edits من غير FK على payments عمدًا: السجل لازم يفضل حتى لو الدفعة اتحذفت بعدين.

create table if not exists public.payment_edits (
  id bigint generated always as identity primary key,
  payment_id bigint not null,
  project_id bigint references public.projects(id) on delete set null,
  old_amount numeric(14,2) not null,
  new_amount numeric(14,2) not null check (new_amount > 0),
  old_date date not null,
  new_date date not null,
  reason text not null check (length(btrim(reason)) > 0),
  edited_by text not null default 'admin',
  edited_at timestamptz not null default now()
);
create index if not exists payment_edits_payment_idx on public.payment_edits(payment_id);
create index if not exists payment_edits_project_idx on public.payment_edits(project_id);
alter table public.payment_edits enable row level security;
revoke all on public.payment_edits from anon, authenticated;

create or replace function public.finance_edit_payment(p_payment bigint, p_amount numeric, p_date date, p_reason text)
returns bigint language plpgsql set search_path = public as $$
declare pay payments%rowtype; a numeric(14,2) := round(coalesce(p_amount, 0), 2); v_id bigint;
begin
  if a <= 0 then raise exception 'المبلغ غير صالح'; end if;
  if p_date is null then raise exception 'التاريخ مطلوب'; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then raise exception 'اكتب سبب التعديل'; end if;
  select * into pay from payments where id = p_payment for update;
  if not found then raise exception 'الدفعة غير موجودة'; end if;
  if a = round(pay.amount, 2) and p_date = pay.payment_date::date then
    raise exception 'مفيش تغيير: المبلغ والتاريخ زي ما هم';
  end if;
  insert into payment_edits (payment_id, project_id, old_amount, new_amount, old_date, new_date, reason, edited_by)
  values (pay.id, pay.project_id, round(pay.amount, 2), a, pay.payment_date::date, p_date, btrim(p_reason), 'admin')
  returning id into v_id;
  update payments set amount = a, payment_date = p_date where id = pay.id;      -- trg_payments_recalc بيعيد حساب حالة السداد
  update treasury_entries set amount = a, entry_date = p_date where payment_id = pay.id;
  return v_id;
end $$;
revoke all on function public.finance_edit_payment(bigint, numeric, date, text) from public, anon, authenticated;
