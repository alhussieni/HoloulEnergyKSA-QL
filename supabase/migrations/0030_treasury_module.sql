-- 0030: الخزنة والموردين (إضافة فقط، أدمن فقط عبر service_role). اتطبقت باسم treasury_module_v1.
-- المبدأ: treasury_entries = حركات فلوس فقط. فاتورة المورد التزام: بتنشئ تكلفة مشروع (أو مصروف) من غير حركة خزنة.
-- قبض العميل / المصروف / سحب الشريك بيتكتبوا في جداولهم الحالية داخل دوال finance_* بشكل ذرّي (بدون إدخال مرتين).

create table if not exists public.treasury_accounts (
  id bigint generated always as identity primary key,
  name text not null,
  kind text not null check (kind in ('cash','bank','custody')),
  holder text,
  opening_balance numeric(14,2) not null default 0,
  opening_date date not null default current_date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.suppliers (
  id bigint generated always as identity primary key,
  name text not null,
  vat_number text,
  phone text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists suppliers_name_uq on public.suppliers (lower(name));

create table if not exists public.supplier_bills (
  id bigint generated always as identity primary key,
  supplier_id bigint not null references public.suppliers(id),
  project_id bigint references public.projects(id) on delete set null,
  bill_number text,
  bill_date date not null default current_date,
  amount numeric(14,2) not null check (amount > 0),
  tax_treatment text not null default 'recoverable' check (tax_treatment in ('recoverable','none')),
  description text,
  project_cost_id bigint references public.project_costs(id) on delete set null,
  expense_id bigint references public.expenses(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists supplier_bills_supplier_idx on public.supplier_bills(supplier_id);
create index if not exists supplier_bills_project_idx on public.supplier_bills(project_id);

create table if not exists public.treasury_entries (
  id bigint generated always as identity primary key,
  entry_date date not null default current_date,
  account_id bigint not null references public.treasury_accounts(id),
  direction text not null check (direction in ('in','out')),
  amount numeric(14,2) not null check (amount > 0),
  kind text not null check (kind in ('customer_receipt','supplier_payment','expense','partner_draw','transfer','other')),
  method text,
  reference text,
  notes text,
  project_id bigint references public.projects(id) on delete set null,
  supplier_id bigint references public.suppliers(id),
  bill_id bigint references public.supplier_bills(id),
  payment_id bigint references public.payments(id) on delete cascade,
  expense_id bigint references public.expenses(id) on delete restrict,
  distribution_id bigint references public.partner_distributions(id) on delete restrict,
  transfer_group uuid,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists treasury_entries_account_date_idx on public.treasury_entries(account_id, entry_date, id);
create index if not exists treasury_entries_bill_idx on public.treasury_entries(bill_id);
create index if not exists treasury_entries_supplier_idx on public.treasury_entries(supplier_id);
create index if not exists treasury_entries_payment_idx on public.treasury_entries(payment_id);
create index if not exists treasury_entries_project_idx on public.treasury_entries(project_id);

do $$ declare t text; begin
  foreach t in array array['treasury_accounts','suppliers','supplier_bills','treasury_entries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- ------------------------------ Views ------------------------------
create or replace view public.v_account_balances with (security_invoker = true) as
select a.id as account_id, a.name, a.kind, a.holder, a.active, a.opening_balance, a.opening_date,
       coalesce(sum(case when e.direction = 'in' then e.amount end), 0) as total_in,
       coalesce(sum(case when e.direction = 'out' then e.amount end), 0) as total_out,
       a.opening_balance
         + coalesce(sum(case when e.direction = 'in' then e.amount end), 0)
         - coalesce(sum(case when e.direction = 'out' then e.amount end), 0) as balance
from public.treasury_accounts a
left join public.treasury_entries e on e.account_id = a.id and e.entry_date >= a.opening_date
group by a.id;

create or replace view public.v_treasury_ledger with (security_invoker = true) as
select e.id, e.entry_date, e.account_id, a.name as account_name, a.kind as account_kind,
       e.direction, e.amount, e.kind, e.method, e.reference, e.notes,
       e.project_id, pr.project_number, cu.name as customer_name,
       e.supplier_id, s.name as supplier_name, e.bill_id, e.transfer_group, e.created_at,
       a.opening_balance + sum(case when e.direction = 'in' then e.amount else -e.amount end)
         over (partition by e.account_id order by e.entry_date, e.id) as running_balance
from public.treasury_entries e
join public.treasury_accounts a on a.id = e.account_id
left join public.projects pr on pr.id = e.project_id
left join public.customers cu on cu.id = pr.customer_id
left join public.suppliers s on s.id = e.supplier_id
where e.entry_date >= a.opening_date;

create or replace view public.v_supplier_bills with (security_invoker = true) as
select b.id as bill_id, b.supplier_id, s.name as supplier_name, b.project_id, pr.project_number,
       b.bill_number, b.bill_date, b.description, b.amount, b.tax_treatment,
       coalesce(p.paid, 0) as paid, b.amount - coalesce(p.paid, 0) as remaining
from public.supplier_bills b
join public.suppliers s on s.id = b.supplier_id
left join public.projects pr on pr.id = b.project_id
left join (select bill_id, sum(amount) as paid from public.treasury_entries
           where kind = 'supplier_payment' and bill_id is not null group by bill_id) p on p.bill_id = b.id;

create or replace view public.v_supplier_balances with (security_invoker = true) as
select s.id as supplier_id, s.name, s.vat_number, s.phone, s.active,
       coalesce(b.total_bills, 0) as total_bills,
       coalesce(p.total_paid, 0) as total_paid,
       coalesce(b.total_bills, 0) - coalesce(p.total_paid, 0) as balance
from public.suppliers s
left join (select supplier_id, sum(amount) as total_bills from public.supplier_bills group by supplier_id) b on b.supplier_id = s.id
left join (select supplier_id, sum(amount) as total_paid from public.treasury_entries
           where kind = 'supplier_payment' group by supplier_id) p on p.supplier_id = s.id;

-- دفعات عملاء اتسجلت من أماكن تانية (شاشة المشروع/قديمة) ولسه مش مربوطة بحساب خزنة/بنك
create or replace view public.v_unassigned_receipts with (security_invoker = true) as
select p.id as payment_id, p.project_id, pr.project_number, cu.name as customer_name,
       p.amount, p.payment_date, p.method, p.notes
from public.payments p
left join public.projects pr on pr.id = p.project_id
left join public.customers cu on cu.id = pr.customer_id
where not exists (select 1 from public.treasury_entries e where e.payment_id = p.id);

do $$ declare v text; begin
  foreach v in array array['v_account_balances','v_treasury_ledger','v_supplier_bills','v_supplier_balances','v_unassigned_receipts'] loop
    execute format('revoke all on public.%I from anon, authenticated', v);
  end loop;
end $$;

-- ----------------------- Atomic write functions ---------------------
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
  v_dir text; v_payment bigint; v_expense bigint; v_dist bigint; v_id bigint;
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
    insert into expenses (expense_date, category, description, amount, tax_treatment, created_by)
    values (v_date, coalesce(nullif(p->>'category',''), 'other'), nullif(p->>'description',''), v_amount,
            coalesce(nullif(p->>'tax_treatment',''), 'recoverable'), 'treasury') returning id into v_expense;

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
                                project_id, supplier_id, bill_id, payment_id, expense_id, distribution_id, created_by)
  values (v_date, v_acc, v_dir, v_amount, v_kind, v_method, v_ref, v_notes,
          v_project, v_supplier, v_bill, v_payment, v_expense, v_dist, 'admin')
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.finance_record_transfer(p_from bigint, p_to bigint, p_amount numeric,
                                                          p_date date, p_notes text) returns uuid
language plpgsql set search_path = public as $$
declare g uuid := gen_random_uuid(); a numeric(14,2) := round(coalesce(p_amount, 0), 2);
begin
  if a <= 0 then raise exception 'المبلغ غير صالح'; end if;
  if p_from is null or p_to is null or p_from = p_to then raise exception 'اختر حسابين مختلفين'; end if;
  if not exists (select 1 from treasury_accounts where id = p_from and active)
     or not exists (select 1 from treasury_accounts where id = p_to and active) then
    raise exception 'الحساب غير موجود أو غير نشط';
  end if;
  insert into treasury_entries (entry_date, account_id, direction, amount, kind, notes, transfer_group, created_by)
  values (coalesce(p_date, current_date), p_from, 'out', a, 'transfer', p_notes, g, 'admin'),
         (coalesce(p_date, current_date), p_to, 'in', a, 'transfer', p_notes, g, 'admin');
  return g;
end $$;

create or replace function public.finance_assign_payment(p_payment bigint, p_account bigint) returns bigint
language plpgsql set search_path = public as $$
declare pay payments%rowtype; v_id bigint;
begin
  select * into pay from payments where id = p_payment;
  if not found then raise exception 'الدفعة غير موجودة'; end if;
  if exists (select 1 from treasury_entries where payment_id = p_payment) then raise exception 'الدفعة مرتبطة بحساب بالفعل'; end if;
  if not exists (select 1 from treasury_accounts where id = p_account and active) then raise exception 'الحساب غير موجود أو غير نشط'; end if;
  insert into treasury_entries (entry_date, account_id, direction, amount, kind, method, notes, project_id, payment_id, created_by)
  values (pay.payment_date, p_account, 'in', pay.amount, 'customer_receipt', pay.method, pay.notes, pay.project_id, pay.id, 'admin')
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.finance_delete_entry(p_id bigint) returns void
language plpgsql set search_path = public as $$
declare e treasury_entries%rowtype;
begin
  select * into e from treasury_entries where id = p_id;
  if not found then raise exception 'الحركة غير موجودة'; end if;
  if e.transfer_group is not null then
    delete from treasury_entries where transfer_group = e.transfer_group;
  elsif e.payment_id is not null then
    delete from payments where id = e.payment_id;          -- بيحذف الحركة بالتتالي، و trg_payments_recalc بيشتغل
  else
    delete from treasury_entries where id = p_id;
    if e.expense_id is not null then delete from expenses where id = e.expense_id; end if;
    if e.distribution_id is not null then delete from partner_distributions where id = e.distribution_id; end if;
  end if;
end $$;

create or replace function public.finance_record_bill(p jsonb) returns bigint
language plpgsql set search_path = public as $$
declare
  v_supplier bigint := nullif(p->>'supplier_id','')::bigint;
  v_name text := nullif(btrim(coalesce(p->>'supplier_name','')), '');
  v_project bigint := nullif(p->>'project_id','')::bigint;
  v_amount numeric(14,2) := round(coalesce(nullif(p->>'amount','')::numeric, 0), 2);
  v_date date := coalesce(nullif(p->>'bill_date','')::date, current_date);
  v_tax text := coalesce(nullif(p->>'tax_treatment',''), 'recoverable');
  v_desc text := nullif(p->>'description','');
  v_num text := nullif(p->>'bill_number','');
  v_sname text; v_cost bigint; v_exp bigint; v_id bigint;
begin
  if v_amount <= 0 then raise exception 'المبلغ غير صالح'; end if;
  if v_supplier is null and v_name is not null then
    select id into v_supplier from suppliers where lower(name) = lower(v_name);
    if v_supplier is null then insert into suppliers (name) values (v_name) returning id into v_supplier; end if;
  end if;
  select name into v_sname from suppliers where id = v_supplier;
  if v_sname is null then raise exception 'اختر المورد أو اكتب اسم مورد جديد'; end if;
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

  insert into supplier_bills (supplier_id, project_id, bill_number, bill_date, amount, tax_treatment, description, project_cost_id, expense_id)
  values (v_supplier, v_project, v_num, v_date, v_amount, v_tax, v_desc, v_cost, v_exp) returning id into v_id;
  return v_id;
end $$;

create or replace function public.finance_delete_bill(p_id bigint) returns void
language plpgsql set search_path = public as $$
declare b supplier_bills%rowtype;
begin
  select * into b from supplier_bills where id = p_id;
  if not found then raise exception 'الفاتورة غير موجودة'; end if;
  if exists (select 1 from treasury_entries where bill_id = p_id) then
    raise exception 'الفاتورة عليها مدفوعات — احذف المدفوعات أولًا';
  end if;
  delete from supplier_bills where id = p_id;
  if b.project_cost_id is not null then delete from project_costs where id = b.project_cost_id; end if;
  if b.expense_id is not null then delete from expenses where id = b.expense_id; end if;
end $$;

do $$ declare f text; begin
  foreach f in array array['finance_record_entry(jsonb)','finance_record_transfer(bigint,bigint,numeric,date,text)',
                           'finance_assign_payment(bigint,bigint)','finance_delete_entry(bigint)',
                           'finance_record_bill(jsonb)','finance_delete_bill(bigint)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;

-- حمايات برسائل واضحة: مصروف/سحب مرتبط بحركة خزنة مينفعش يتحذف من شاشته
create or replace function public.trg_guard_linked_expense() returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.treasury_entries where expense_id = old.id) then
    raise exception 'المصروف ده مرتبط بحركة في الخزنة — احذف الحركة من شاشة الخزنة';
  end if;
  if exists (select 1 from public.supplier_bills where expense_id = old.id) then
    raise exception 'المصروف ده ناتج عن فاتورة مورد — احذف الفاتورة من شاشة الموردين';
  end if;
  return old;
end $$;
drop trigger if exists trg_guard_linked_expense on public.expenses;
create trigger trg_guard_linked_expense before delete on public.expenses
  for each row execute function public.trg_guard_linked_expense();

create or replace function public.trg_guard_linked_distribution() returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.treasury_entries where distribution_id = old.id) then
    raise exception 'السحب ده مرتبط بحركة في الخزنة — احذف الحركة من شاشة الخزنة';
  end if;
  return old;
end $$;
drop trigger if exists trg_guard_linked_distribution on public.partner_distributions;
create trigger trg_guard_linked_distribution before delete on public.partner_distributions
  for each row execute function public.trg_guard_linked_distribution();

-- حسابات أولية (غيّر الأسماء من الشاشة، وضيف العهد الشخصية كـ custody)
insert into public.treasury_accounts (name, kind)
select v.n, v.k from (values ('خزنة المكتب','cash'), ('الحساب البنكي','bank')) v(n,k)
where not exists (select 1 from public.treasury_accounts);
