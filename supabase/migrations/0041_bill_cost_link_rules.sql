-- 0041 (اتطبقت باسمي guard_bill_linked_cost و detach_bill_on_cost_delete)
-- لو تكلفة مشروع ناتجة عن فاتورة مورد اتحذفت من شاشة المشروع: الفاتورة تفضل عند المورد، ويتشال منها المشروع، والمبلغ يتحسب مصروف عام.
create or replace function public.trg_guard_linked_cost() returns trigger language plpgsql as $$
declare b record; v_exp bigint;
begin
  if exists (select 1 from public.treasury_entries where project_cost_id = old.id) then
    raise exception 'التكلفة دي مرتبطة بحركة في الخزنة — احذف الحركة من شاشة الخزنة';
  end if;
  if exists (select 1 from public.projects where id = old.project_id) then
    for b in select * from public.supplier_bills where project_cost_id = old.id loop
      v_exp := null;
      if b.doc_type = 'invoice' then
        insert into public.expenses (expense_date, category, description, amount, tax_treatment, created_by)
        values (b.bill_date, 'other', coalesce(b.description, 'فاتورة ' || coalesce(b.bill_number, '') || ' (اتشالت من المشروع)'), b.amount, b.tax_treatment, 'treasury')
        returning id into v_exp;
      end if;
      update public.supplier_bills set project_id = null, project_cost_id = null, expense_id = v_exp where id = b.id;
    end loop;
  end if;
  return old;
end $$;
