-- 0034: طلبات الشراء (المشتريات). اتطبقت باسم purchase_orders_v1.
-- الدورة: طلب شراء (التزام متفق عليه، مفيش أثر محاسبي) ← فاتورة مورد (تكلفة مشروع/مصروف + مستحق للمورد) ← دفع (خروج فلوس).

create table if not exists public.purchase_orders (
  id bigint generated always as identity primary key,
  po_number text,
  supplier_id bigint not null references public.suppliers(id),
  project_id bigint references public.projects(id) on delete set null,
  order_date date not null default current_date,
  description text,
  amount numeric(14,2) not null check (amount > 0),            -- المبلغ المتفق عليه شامل الضريبة
  tax_treatment text not null default 'recoverable' check (tax_treatment in ('recoverable','none')),
  status text not null default 'open' check (status in ('open','cancelled')),
  notes text,
  created_at timestamptz not null default now()
);
create index if not exists purchase_orders_supplier_idx on public.purchase_orders(supplier_id);
create index if not exists purchase_orders_project_idx on public.purchase_orders(project_id);
alter table public.purchase_orders enable row level security;
revoke all on public.purchase_orders from anon, authenticated;

alter table public.supplier_bills
  add column if not exists purchase_order_id bigint references public.purchase_orders(id) on delete restrict;
create index if not exists supplier_bills_po_idx on public.supplier_bills(purchase_order_id);

create or replace view public.v_purchase_orders with (security_invoker = true) as
select po.id as po_id, coalesce(po.po_number, 'PO-' || lpad(po.id::text, 4, '0')) as po_number,
       po.supplier_id, s.name as supplier_name, po.project_id, pr.project_number,
       po.order_date, po.description, po.amount, po.tax_treatment, po.status, po.notes,
       coalesce(b.billed, 0) as billed, coalesce(b.paid, 0) as paid,
       po.amount - coalesce(b.billed, 0) as remaining_to_bill,
       coalesce(b.billed, 0) - coalesce(b.paid, 0) as remaining_to_pay
from public.purchase_orders po
join public.suppliers s on s.id = po.supplier_id
left join public.projects pr on pr.id = po.project_id
left join (
  select sb.purchase_order_id, sum(sb.amount) as billed, sum(coalesce(p.paid, 0)) as paid
  from public.supplier_bills sb
  left join (select bill_id, sum(amount) as paid from public.treasury_entries
             where kind = 'supplier_payment' and bill_id is not null group by bill_id) p on p.bill_id = sb.id
  where sb.purchase_order_id is not null group by sb.purchase_order_id
) b on b.purchase_order_id = po.id;
revoke all on public.v_purchase_orders from anon, authenticated;

-- finance_record_bill بيقبل po_id اختياري (المورد والمشروع بيتورّثوا من الطلب)
create or replace function public.finance_record_bill(p jsonb) returns bigint
language plpgsql set search_path = public as $$
declare
  v_supplier bigint := nullif(p->>'supplier_id','')::bigint;
  v_name text := nullif(btrim(coalesce(p->>'supplier_name','')), '');
  v_project bigint := nullif(p->>'project_id','')::bigint;
  v_po bigint := nullif(p->>'po_id','')::bigint;
  v_amount numeric(14,2) := round(coalesce(nullif(p->>'amount','')::numeric, 0), 2);
  v_date date := coalesce(nullif(p->>'bill_date','')::date, current_date);
  v_tax text := coalesce(nullif(p->>'tax_treatment',''), 'recoverable');
  v_desc text := nullif(p->>'description','');
  v_num text := nullif(p->>'bill_number','');
  v_sname text; v_cost bigint; v_exp bigint; v_id bigint; v_posup bigint; v_poproj bigint; v_postatus text;
begin
  if v_amount <= 0 then raise exception 'المبلغ غير صالح'; end if;
  if v_po is not null then
    select supplier_id, project_id, status into v_posup, v_poproj, v_postatus from purchase_orders where id = v_po;
    if not found then raise exception 'طلب الشراء غير موجود'; end if;
    if v_postatus = 'cancelled' then raise exception 'طلب الشراء ملغي'; end if;
    if v_supplier is null and v_name is null then v_supplier := v_posup; end if;
    if v_project is null then v_project := v_poproj; end if;
  end if;
  if v_supplier is null and v_name is not null then
    select id into v_supplier from suppliers where lower(name) = lower(v_name);
    if v_supplier is null then insert into suppliers (name) values (v_name) returning id into v_supplier; end if;
  end if;
  select name into v_sname from suppliers where id = v_supplier;
  if v_sname is null then raise exception 'اختر المورد أو اكتب اسم مورد جديد'; end if;
  if v_po is not null and v_supplier <> v_posup then raise exception 'طلب الشراء ده بتاع مورد تاني'; end if;
  if v_project is not null and not exists (select 1 from projects where id = v_project) then raise exception 'المشروع غير موجود'; end if;

  if v_project is not null then
    insert into project_costs (project_id, cost_type, description, amount, cost_date, supplier, tax_treatment)
    values (v_project, coalesce(nullif(p->>'cost_type',''), 'other'), coalesce(v_desc, 'فاتورة ' || coalesce(v_num, '')), v_amount, v_date, v_sname, v_tax)
    returning id into v_cost;
  else
    insert into expenses (expense_date, category, description, amount, tax_treatment, created_by)
    values (v_date, 'other', coalesce(v_desc, 'مشتريات من ' || v_sname), v_amount, v_tax, 'treasury')
    returning id into v_exp;
  end if;

  insert into supplier_bills (supplier_id, project_id, bill_number, bill_date, amount, tax_treatment, description, project_cost_id, expense_id, purchase_order_id)
  values (v_supplier, v_project, v_num, v_date, v_amount, v_tax, v_desc, v_cost, v_exp, v_po) returning id into v_id;
  return v_id;
end $$;
revoke all on function public.finance_record_bill(jsonb) from public, anon, authenticated;
