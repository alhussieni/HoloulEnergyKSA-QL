-- 0037: تعديل حركات الخزنة (أدمن) — الحساب / التاريخ / المبلغ / المشروع / طلب الشراء / المرجع / الملاحظات
-- كل تعديل ذرّي ويتسجّل في treasury_entry_edits بسببه والقيم القديمة والجديدة.

create table if not exists public.treasury_entry_edits (
  id bigint generated always as identity primary key,
  entry_id bigint not null,               -- من غير FK عشان السجل يفضل حتى لو الحركة اتحذفت
  kind text,
  old_values jsonb not null,
  new_values jsonb not null,
  reason text not null,
  edited_by text not null default 'admin',
  edited_at timestamptz not null default now()
);
create index if not exists treasury_entry_edits_entry_idx on public.treasury_entry_edits (entry_id, edited_at desc);
alter table public.treasury_entry_edits enable row level security;

create or replace function public.finance_edit_entry(p_id bigint, p jsonb, p_reason text)
returns bigint
language plpgsql
set search_path to 'public'
as $function$
declare
  e treasury_entries%rowtype; pay payments%rowtype; r_exp expenses%rowtype; r_cost project_costs%rowtype;
  n_acc bigint; n_date date; n_amt numeric(14,2); n_method text; n_ref text; n_notes text; n_proj bigint; n_po bigint;
  v_old jsonb := '{}'::jsonb; v_new jsonb := '{}'::jsonb; v_id bigint;
  other_acc bigint; v_rem numeric; v_cost bigint; v_exp bigint; v_posup bigint; v_poproj bigint; v_desc text;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then raise exception 'اكتب سبب التعديل'; end if;
  select * into e from treasury_entries where id = p_id for update;
  if not found then raise exception 'الحركة غير موجودة'; end if;

  n_acc    := case when p ? 'account_id' then nullif(p->>'account_id','')::bigint else e.account_id end;
  n_date   := case when p ? 'entry_date' then nullif(p->>'entry_date','')::date else e.entry_date end;
  n_amt    := case when p ? 'amount' then round(coalesce(nullif(p->>'amount','')::numeric, 0), 2) else e.amount end;
  n_method := case when p ? 'method' then nullif(btrim(p->>'method'),'') else e.method end;
  n_ref    := case when p ? 'reference' then nullif(btrim(p->>'reference'),'') else e.reference end;
  n_notes  := case when p ? 'notes' then nullif(btrim(p->>'notes'),'') else e.notes end;
  n_proj   := case when p ? 'project_id' then nullif(p->>'project_id','')::bigint else e.project_id end;
  n_po     := case when p ? 'po_id' then nullif(p->>'po_id','')::bigint else e.purchase_order_id end;

  if n_amt <= 0 then raise exception 'المبلغ غير صالح'; end if;
  if n_date is null then raise exception 'التاريخ مطلوب'; end if;
  if n_acc is null then raise exception 'اختر الحساب'; end if;
  if n_acc is distinct from e.account_id and not exists (select 1 from treasury_accounts where id = n_acc and active) then
    raise exception 'الحساب غير موجود أو غير نشط';
  end if;
  -- حقول لا تنطبق على أنواع معيّنة تفضل زي ما هي
  if e.kind not in ('supplier_payment','supplier_refund') then n_po := e.purchase_order_id; end if;
  if e.kind in ('partner_draw','transfer') then n_proj := e.project_id; end if;
  if n_proj is not null and n_proj is distinct from e.project_id and not exists (select 1 from projects where id = n_proj) then
    raise exception 'المشروع غير موجود';
  end if;

  -- القيم القديمة/الجديدة للسجل (اللي اتغيّر بس)
  if n_acc    is distinct from e.account_id        then v_old := v_old || jsonb_build_object('account_id', e.account_id);        v_new := v_new || jsonb_build_object('account_id', n_acc); end if;
  if n_date   is distinct from e.entry_date        then v_old := v_old || jsonb_build_object('entry_date', e.entry_date);        v_new := v_new || jsonb_build_object('entry_date', n_date); end if;
  if n_amt    is distinct from round(e.amount, 2)  then v_old := v_old || jsonb_build_object('amount', e.amount);                v_new := v_new || jsonb_build_object('amount', n_amt); end if;
  if n_method is distinct from e.method            then v_old := v_old || jsonb_build_object('method', e.method);                v_new := v_new || jsonb_build_object('method', n_method); end if;
  if n_ref    is distinct from e.reference         then v_old := v_old || jsonb_build_object('reference', e.reference);          v_new := v_new || jsonb_build_object('reference', n_ref); end if;
  if n_notes  is distinct from e.notes             then v_old := v_old || jsonb_build_object('notes', e.notes);                  v_new := v_new || jsonb_build_object('notes', n_notes); end if;
  if n_proj   is distinct from e.project_id        then v_old := v_old || jsonb_build_object('project_id', e.project_id);        v_new := v_new || jsonb_build_object('project_id', n_proj); end if;
  if n_po     is distinct from e.purchase_order_id then v_old := v_old || jsonb_build_object('purchase_order_id', e.purchase_order_id); v_new := v_new || jsonb_build_object('purchase_order_id', n_po); end if;
  if v_new = '{}'::jsonb then raise exception 'مفيش تغيير'; end if;

  if e.kind = 'transfer' then
    if e.transfer_group is null then raise exception 'تحويل غير مكتمل'; end if;
    select account_id into other_acc from treasury_entries where transfer_group = e.transfer_group and id <> e.id limit 1;
    if n_acc = other_acc then raise exception 'حساب التحويل (من) و(إلى) لازم يختلفوا'; end if;
    update treasury_entries set entry_date = n_date, amount = n_amt, method = n_method, reference = n_ref, notes = n_notes
     where transfer_group = e.transfer_group;
    update treasury_entries set account_id = n_acc where id = e.id;

  else
    if e.kind = 'customer_receipt' then
      select * into pay from payments where id = e.payment_id for update;
      if not found then raise exception 'دفعة العميل غير موجودة'; end if;
      if n_proj is null then raise exception 'اختر المشروع'; end if;
      if n_proj is distinct from e.project_id and pay.milestone_id is not null then
        raise exception 'الدفعة مربوطة بمرحلة دفع في مشروعها — مينفعش تتنقل لمشروع تاني';
      end if;
      update payments set amount = n_amt, payment_date = n_date, method = n_method, notes = n_notes, project_id = n_proj where id = pay.id;
      if n_amt <> round(pay.amount, 2) or n_date <> pay.payment_date::date then
        insert into payment_edits (payment_id, project_id, old_amount, new_amount, old_date, new_date, reason, edited_by)
        values (pay.id, n_proj, round(pay.amount, 2), n_amt, pay.payment_date::date, n_date, btrim(p_reason), 'admin');
      end if;

    elsif e.kind in ('supplier_payment','supplier_refund') then
      if e.kind = 'supplier_payment' and e.bill_id is not null then
        if n_proj is distinct from e.project_id or n_po is distinct from e.purchase_order_id then
          raise exception 'الدفعة على فاتورة — المشروع والطلب بيتحددوا من الفاتورة';
        end if;
        select b.amount
               - coalesce((select sum(x.amount) from treasury_entries x where x.bill_id = b.id and x.kind = 'supplier_payment' and x.id <> e.id), 0)
               - coalesce((select sum(a.amount) from supplier_payment_allocations a where a.bill_id = b.id), 0)
          into v_rem from supplier_bills b where b.id = e.bill_id;
        if n_amt > coalesce(v_rem, 0) + 0.005 then raise exception 'المبلغ أكبر من المتبقي على الفاتورة (%)', v_rem; end if;
      else
        if n_po is not null then
          select supplier_id, project_id into v_posup, v_poproj from purchase_orders where id = n_po;
          if not found then raise exception 'أمر الشراء غير موجود'; end if;
          if v_posup <> e.supplier_id then raise exception 'أمر الشراء ده بتاع مورد تاني'; end if;
          if n_proj is null then n_proj := v_poproj; end if;
        end if;
        if e.kind = 'supplier_payment' then delete from supplier_payment_allocations where entry_id = e.id; end if;
      end if;

    elsif e.kind = 'expense' then
      v_desc := case when p ? 'notes' then n_notes else coalesce(e.notes, null) end;
      if e.expense_id is not null then
        select * into r_exp from expenses where id = e.expense_id for update;
        if n_proj is null then
          update expenses set expense_date = n_date, amount = n_amt, description = coalesce(v_desc, description) where id = r_exp.id;
        else  -- مصروف عام ← بيتنقل لتكلفة على مشروع
          if r_exp.recurring_id is not null then raise exception 'مصروف متكرر — مينفعش يتنقل لمشروع'; end if;
          insert into project_costs (project_id, cost_type, description, amount, cost_date, supplier, tax_treatment)
          values (n_proj, coalesce(r_exp.category,'other'), coalesce(v_desc, r_exp.description), n_amt, n_date, null, coalesce(r_exp.tax_treatment,'none'))
          returning id into v_cost;
          update treasury_entries set expense_id = null, project_cost_id = v_cost where id = e.id;
          delete from expenses where id = r_exp.id;
        end if;
      elsif e.project_cost_id is not null then
        select * into r_cost from project_costs where id = e.project_cost_id for update;
        if n_proj is null then  -- تكلفة مشروع ← بتتحوّل لمصروف عام
          insert into expenses (expense_date, category, description, amount, tax_treatment, created_by)
          values (n_date, coalesce(r_cost.cost_type,'other'), coalesce(v_desc, r_cost.description), n_amt, coalesce(r_cost.tax_treatment,'none'), 'treasury')
          returning id into v_exp;
          update treasury_entries set project_cost_id = null, expense_id = v_exp where id = e.id;
          delete from project_costs where id = r_cost.id;
        else
          update project_costs set project_id = n_proj, cost_date = n_date, amount = n_amt, description = coalesce(v_desc, description) where id = r_cost.id;
        end if;
      end if;

    elsif e.kind = 'partner_draw' then
      if e.distribution_id is not null then
        update partner_distributions set amount = n_amt, distribution_date = n_date,
               notes = case when p ? 'notes' then n_notes else notes end where id = e.distribution_id;
      end if;
    end if;

    update treasury_entries set account_id = n_acc, entry_date = n_date, amount = n_amt, method = n_method, reference = n_ref,
           notes = n_notes, project_id = n_proj, purchase_order_id = n_po where id = e.id;
    if e.kind = 'supplier_payment' and e.bill_id is null then perform finance_auto_allocate_supplier(e.supplier_id); end if;
  end if;

  insert into treasury_entry_edits (entry_id, kind, old_values, new_values, reason)
  values (e.id, e.kind, v_old, v_new, btrim(p_reason)) returning id into v_id;
  return v_id;
end $function$;

revoke all on function public.finance_edit_entry(bigint, jsonb, text) from public, anon, authenticated;
