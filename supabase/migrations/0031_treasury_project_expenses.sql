-- 0031: مصروفات المشروع من الخزنة/العهدة. اتطبقت باسم treasury_project_expenses_v1.
-- مصروف بيتدفع من حساب (خزنة/بنك/عهدة) + اختيار مشروع = حركة خزنة + تكلفة مشروع في خطوة واحدة (بدون إدخال مرتين).
-- من غير مشروع = مصروف عام للشركة زي ما كان.

alter table public.treasury_entries
  add column if not exists project_cost_id bigint references public.project_costs(id) on delete restrict;
create index if not exists treasury_entries_cost_idx on public.treasury_entries(project_cost_id);

create or replace function public.finance_record_entry(p jsonb) returns bigint
language plpgsql set search_path = public as $$
declare
  v_kind text := p->>'kind';
  v_amount numeric(14,2) := round(coalesce(nullif(p->>'amount','')::numeric, 0), 2);
  v_acc bigint := nullif(p->>'account_id','')::bigint;
  v_date date := coalesce(nullif(p->>'entry_date','')::date, current_date);
  v_method text := nullif(p->>'method','');
  v_ref text := nullif(p->>'reference','');
  v_notes text := nullif(p->>'notes','');
  v_project bigint := nullif(p->>'project_id','')::bigint;
  v_supplier bigint := nullif(p->>'supplier_id','')::bigint;
  v_bill bigint := nullif(p->>'bill_id','')::bigint;
  v_partner bigint := nullif(p->>'partner_id','')::bigint;
  v_dir text; v_payment bigint; v_expense bigint; v_dist bigint; v_cost bigint; v_id bigint;
  v_rem numeric; v_bsupplier bigint; v_bproject bigint;
begin
  if v_amount <= 0 then raise exception 'المبلغ غير صالح'; end if;
  if v_acc is null or not exists (select 1 from treasury_accounts where id = v_acc and active) then
    raise exception 'الحساب غير موجود أو غير نشط';
  end if;

  if v_kind = 'customer_receipt' then
    if v_project is null or not exists (select 1 from projects where id = v_project) then raise exception 'اختر المشروع'; end if;
    v_dir := 'in';
    insert into payments (project_id, amount, payment_date, method, notes)
    values (v_project, v_amount, v_date, v_method, v_notes) returning id into v_payment;

  elsif v_kind = 'supplier_payment' then
    v_dir := 'out';
    if v_bill is not null then
      select b.supplier_id, b.project_id,
             b.amount - coalesce((select sum(e.amount) from treasury_entries e where e.bill_id = b.id and e.kind = 'supplier_payment'), 0)
        into v_bsupplier, v_bproject, v_rem
      from supplier_bills b where b.id = v_bill;
      if not found then raise exception 'الفاتورة غير موجودة'; end if;
      v_supplier := v_bsupplier; v_project := v_bproject;
      if v_amount > v_rem then raise exception 'المبلغ أكبر من المتبقي على الفاتورة (%)', v_rem; end if;
    elsif v_supplier is null or not exists (select 1 from suppliers where id = v_supplier) then
      raise exception 'اختر المورد';
    end if;

  elsif v_kind = 'expense' then
    v_dir := 'out';
    if v_project is not null then
      if not exists (select 1 from projects where id = v_project) then raise exception 'المشروع غير موجود'; end if;
      -- مصروف مشروع: بيدخل تكلفة المشروع (category بتشيل نوع التكلفة)
      insert into project_costs (project_id, cost_type, description, amount, cost_date, supplier, tax_treatment)
      values (v_project, coalesce(nullif(p->>'category',''), 'other'), nullif(p->>'description',''), v_amount, v_date,
              nullif(p->>'payee',''), coalesce(nullif(p->>'tax_treatment',''), 'none'))
      returning id into v_cost;
    else
      insert into expenses (expense_date, category, description, amount, tax_treatment, created_by)
      values (v_date, coalesce(nullif(p->>'category',''), 'other'), nullif(p->>'description',''), v_amount,
              coalesce(nullif(p->>'tax_treatment',''), 'recoverable'), 'treasury') returning id into v_expense;
    end if;

  elsif v_kind = 'partner_draw' then
    v_dir := 'out';
    if v_partner is null then raise exception 'اختر الشريك'; end if;
    insert into partner_distributions (partner_id, amount, distribution_date, kind, notes)
    values (v_partner, v_amount, v_date, coalesce(nullif(p->>'dist_kind',''), 'draw'), v_notes) returning id into v_dist;

  elsif v_kind = 'other' then
    v_dir := p->>'direction';
    if v_dir is null or v_dir not in ('in','out') then raise exception 'الاتجاه غير صالح'; end if;
  else
    raise exception 'نوع الحركة غير صالح';
  end if;

  insert into treasury_entries (entry_date, account_id, direction, amount, kind, method, reference, notes,
                                project_id, supplier_id, bill_id, payment_id, expense_id, distribution_id, project_cost_id, created_by)
  values (v_date, v_acc, v_dir, v_amount, v_kind, v_method, v_ref, coalesce(v_notes, nullif(p->>'description','')),
          v_project, v_supplier, v_bill, v_payment, v_expense, v_dist, v_cost, 'admin')
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.finance_record_entry(jsonb) from public, anon, authenticated;

create or replace function public.finance_delete_entry(p_id bigint) returns void
language plpgsql set search_path = public as $$
declare e treasury_entries%rowtype;
begin
  select * into e from treasury_entries where id = p_id;
  if not found then raise exception 'الحركة غير موجودة'; end if;
  if e.transfer_group is not null then
    delete from treasury_entries where transfer_group = e.transfer_group;
  elsif e.payment_id is not null then
    delete from payments where id = e.payment_id;
  else
    delete from treasury_entries where id = p_id;
    if e.expense_id is not null then delete from expenses where id = e.expense_id; end if;
    if e.distribution_id is not null then delete from partner_distributions where id = e.distribution_id; end if;
    if e.project_cost_id is not null then delete from project_costs where id = e.project_cost_id; end if;
  end if;
end $$;
revoke all on function public.finance_delete_entry(bigint) from public, anon, authenticated;

-- حماية برسالة واضحة: تكلفة مشروع ناتجة عن حركة خزنة مينفعش تتحذف من شاشة المشروع
create or replace function public.trg_guard_linked_cost() returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.treasury_entries where project_cost_id = old.id) then
    raise exception 'التكلفة دي مرتبطة بحركة في الخزنة — احذف الحركة من شاشة الخزنة';
  end if;
  return old;
end $$;
drop trigger if exists trg_guard_linked_cost on public.project_costs;
create trigger trg_guard_linked_cost before delete on public.project_costs
  for each row execute function public.trg_guard_linked_cost();
