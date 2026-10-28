-- 0039: تعديل فاتورة/مرتجع مورد (التاريخ / القيمة / الرقم / البيان) بواسطة الأدمن مع سجل تعديلات دائم. اتطبقت باسم supplier_bill_edits_v1.
-- التعديل بيحدّث تكلفة المشروع أو المصروف المرتبط بالفاتورة معاها، وبيمنع تقليل القيمة لأقل من المدفوع/المخصوم عليها.
create table if not exists public.supplier_bill_edits (
  id bigint generated always as identity primary key,
  bill_id bigint not null,
  supplier_id bigint,
  old_values jsonb not null,
  new_values jsonb not null,
  reason text not null check (length(btrim(reason)) > 0),
  edited_by text not null default 'admin',
  edited_at timestamptz not null default now()
);
create index if not exists supplier_bill_edits_bill_idx on public.supplier_bill_edits(bill_id);
alter table public.supplier_bill_edits enable row level security;
revoke all on public.supplier_bill_edits from anon, authenticated;

create or replace function public.finance_edit_bill(p_id bigint, p jsonb, p_reason text)
returns bigint language plpgsql set search_path = public as $$
declare
  b supplier_bills%rowtype;
  n_date date; n_amt numeric(14,2); n_num text; n_desc text;
  v_old jsonb := '{}'::jsonb; v_new jsonb := '{}'::jsonb;
  v_used numeric; v_id bigint; v_sign int; v_def text; v_cdesc text;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then raise exception 'اكتب سبب التعديل'; end if;
  select * into b from supplier_bills where id = p_id for update;
  if not found then raise exception 'الفاتورة غير موجودة'; end if;

  n_date := case when p ? 'bill_date'   then nullif(p->>'bill_date','')::date else b.bill_date end;
  n_amt  := case when p ? 'amount'      then round(coalesce(nullif(p->>'amount','')::numeric, 0), 2) else b.amount end;
  n_num  := case when p ? 'bill_number' then nullif(btrim(p->>'bill_number'),'') else b.bill_number end;
  n_desc := case when p ? 'description' then nullif(btrim(p->>'description'),'') else b.description end;

  if n_amt <= 0 then raise exception 'المبلغ غير صالح'; end if;
  if n_date is null then raise exception 'التاريخ مطلوب'; end if;

  if n_date is distinct from b.bill_date          then v_old := v_old || jsonb_build_object('bill_date', b.bill_date);     v_new := v_new || jsonb_build_object('bill_date', n_date); end if;
  if n_amt  is distinct from round(b.amount, 2)   then v_old := v_old || jsonb_build_object('amount', b.amount);            v_new := v_new || jsonb_build_object('amount', n_amt); end if;
  if n_num  is distinct from b.bill_number        then v_old := v_old || jsonb_build_object('bill_number', b.bill_number); v_new := v_new || jsonb_build_object('bill_number', n_num); end if;
  if n_desc is distinct from b.description        then v_old := v_old || jsonb_build_object('description', b.description); v_new := v_new || jsonb_build_object('description', n_desc); end if;
  if v_new = '{}'::jsonb then raise exception 'مفيش تغيير'; end if;

  -- مينفعش القيمة تبقى أقل من اللي اتدفع أو اتخصم من دفعات مقدّمة على الفاتورة
  if n_amt < round(b.amount, 2) then
    v_used := coalesce((select sum(amount) from treasury_entries where bill_id = b.id), 0)
            + coalesce((select sum(amount) from supplier_payment_allocations where bill_id = b.id), 0);
    if n_amt < v_used - 0.005 then
      raise exception 'القيمة الجديدة أقل من المدفوع/المخصوم على الفاتورة (%) — عدّل أو احذف الدفعات الأول', v_used;
    end if;
  end if;

  update supplier_bills set bill_date = n_date, amount = n_amt, bill_number = n_num, description = n_desc where id = b.id;

  v_sign := case when b.doc_type = 'credit_note' then -1 else 1 end;
  v_def  := case when b.doc_type = 'credit_note' then 'مرتجع ' else 'فاتورة ' end;
  v_cdesc := coalesce(n_desc, v_def || coalesce(n_num, ''));
  if b.project_cost_id is not null then
    update project_costs set amount = v_sign * n_amt, cost_date = n_date,
           description = case when (p ? 'description') or (b.description is null and p ? 'bill_number') then v_cdesc else description end
     where id = b.project_cost_id;
  end if;
  if b.expense_id is not null then
    update expenses set amount = n_amt, expense_date = n_date,
           description = case when p ? 'description' then coalesce(n_desc, description) else description end
     where id = b.expense_id;
  end if;

  -- لو القيمة زادت، الدفعات المقدّمة المتاحة بتتخصم تلقائيًا
  if b.doc_type = 'invoice' and n_amt > round(b.amount, 2) then perform fn_allocate_bill(b.id); end if;

  insert into supplier_bill_edits (bill_id, supplier_id, old_values, new_values, reason)
  values (b.id, b.supplier_id, v_old, v_new, btrim(p_reason)) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.finance_edit_bill(bigint, jsonb, text) from public, anon, authenticated;
