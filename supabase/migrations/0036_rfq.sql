-- 0035: طلبات عروض الأسعار من الموردين (RFQ). اتطبقت باسم rfq_v1 + rfq_items_unit_note (هنا النسخة النهائية في ملف واحد).
-- الدورة: عرض سعر العميل ← بنود وكميات (من غير أسعار البيع) ← طلب للمورد ← رد المورد بالأسعار ← قبول (بيطلّع أمر شراء) أو رفض.
-- كل طلب = مورد واحد. للمقارنة بين موردين لاحقًا: اعمل طلب تاني من نفس عرض العميل. مفيش أثر محاسبي لحد ما فاتورة المورد تتسجّل.

create table if not exists public.rfqs (
  id bigint generated always as identity primary key,
  supplier_id bigint not null references public.suppliers(id),
  quote_id bigint references public.quotes(id) on delete set null,
  quote_ref text,
  project_id bigint references public.projects(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','sent','quoted','accepted','rejected','cancelled')),
  notes text,
  supplier_quote_ref text,
  supplier_quote_date date,
  vat_mode text check (vat_mode in ('incl','excl','none')),   -- أسعار المورد شاملة / غير شاملة الضريبة / بدون
  valid_invoice boolean not null default true,                 -- فاتورة ضريبية صالحة (الضريبة بتتسترد)
  po_id bigint references public.purchase_orders(id) on delete set null,
  created_at timestamptz not null default now(),
  sent_at timestamptz, quoted_at timestamptz, decided_at timestamptz
);
create index if not exists rfqs_supplier_idx on public.rfqs(supplier_id);
create index if not exists rfqs_quote_idx on public.rfqs(quote_id);

create table if not exists public.rfq_items (
  id bigint generated always as identity primary key,
  rfq_id bigint not null references public.rfqs(id) on delete cascade,
  line_no int not null,
  label text not null,
  qty numeric(14,3) not null check (qty > 0),
  unit text,
  qty_note text,
  unit_price numeric(14,4) check (unit_price >= 0),            -- سعر المورد (NULL لحد ما رده يتسجّل)
  unique (rfq_id, line_no)
);

alter table public.purchase_orders add column if not exists rfq_id bigint references public.rfqs(id) on delete set null;

do $$ declare t text; begin
  foreach t in array array['rfqs','rfq_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

create or replace view public.v_rfqs with (security_invoker = true) as
select r.id as rfq_id, 'RFQ-' || lpad(r.id::text, 4, '0') as rfq_number,
       r.supplier_id, s.name as supplier_name, s.phone as supplier_phone,
       r.quote_id, r.quote_ref, r.project_id, pr.project_number, r.status, r.notes,
       r.supplier_quote_ref, r.supplier_quote_date, r.vat_mode, r.valid_invoice, r.po_id,
       r.created_at, r.sent_at, r.quoted_at, r.decided_at,
       (select count(*) from public.rfq_items i where i.rfq_id = r.id) as items_count,
       n.net_total,
       case when n.net_total is null then null
            when r.vat_mode = 'excl' then round(n.net_total * (1 + fs.vr), 2)
            else round(n.net_total, 2) end as total_gross
from public.rfqs r
join public.suppliers s on s.id = r.supplier_id
left join public.projects pr on pr.id = r.project_id
cross join (select vat_rate / 100.0 as vr from public.finance_settings where id = 1) fs
left join (select rfq_id, sum(qty * unit_price) as net_total from public.rfq_items where unit_price is not null group by rfq_id) n on n.rfq_id = r.id;
revoke all on public.v_rfqs from anon, authenticated;

create or replace function public.finance_create_rfq(p jsonb) returns bigint
language plpgsql set search_path = public as $$
declare
  v_sup bigint := nullif(p->>'supplier_id','')::bigint;
  v_name text := nullif(btrim(coalesce(p->>'supplier_name','')), '');
  v_id bigint; it jsonb; n int := 0; v_label text; v_qty numeric;
begin
  if v_sup is null and v_name is not null then
    select id into v_sup from suppliers where lower(name) = lower(v_name);
    if v_sup is null then insert into suppliers (name) values (v_name) returning id into v_sup; end if;
  end if;
  if v_sup is null or not exists (select 1 from suppliers where id = v_sup) then raise exception 'اختر المورد أو اكتب اسم مورد جديد'; end if;
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') = 0 then raise exception 'اختر بند واحد على الأقل'; end if;
  insert into rfqs (supplier_id, quote_id, quote_ref, project_id, notes)
  values (v_sup, nullif(p->>'quote_id','')::bigint, nullif(p->>'quote_ref',''), nullif(p->>'project_id','')::bigint, nullif(p->>'notes',''))
  returning id into v_id;
  for it in select * from jsonb_array_elements(p->'items') loop
    v_label := btrim(coalesce(it->>'label', ''));
    v_qty := coalesce(nullif(it->>'qty','')::numeric, 0);
    if v_label = '' then continue; end if;
    if v_qty <= 0 then raise exception 'اكتب كمية صحيحة للبند: %', v_label; end if;
    n := n + 1;
    insert into rfq_items (rfq_id, line_no, label, qty, unit, qty_note)
    values (v_id, n, v_label, v_qty, nullif(btrim(coalesce(it->>'unit','')), ''), nullif(btrim(coalesce(it->>'qty_note','')), ''));
  end loop;
  if n = 0 then raise exception 'اختر بند واحد على الأقل'; end if;
  return v_id;
end $$;

create or replace function public.finance_record_rfq_quote(p_rfq bigint, p jsonb) returns void
language plpgsql set search_path = public as $$
declare r rfqs%rowtype; pr jsonb; v_mode text := p->>'vat_mode';
begin
  select * into r from rfqs where id = p_rfq for update;
  if not found then raise exception 'طلب عرض السعر غير موجود'; end if;
  if r.status in ('accepted','rejected','cancelled') then raise exception 'الطلب اتقفل — مينفعش تعدّل أسعاره'; end if;
  if v_mode is null or v_mode not in ('incl','excl','none') then raise exception 'حدّد هل أسعار المورد شاملة الضريبة أم لا'; end if;
  for pr in select * from jsonb_array_elements(coalesce(p->'prices', '[]'::jsonb)) loop
    update rfq_items set unit_price = round((pr->>'unit_price')::numeric, 4)
    where rfq_id = p_rfq and line_no = (pr->>'line_no')::int;
  end loop;
  if exists (select 1 from rfq_items where rfq_id = p_rfq and unit_price is null) then raise exception 'كل البنود لازم يتسعّر'; end if;
  update rfqs set status = 'quoted', vat_mode = v_mode, valid_invoice = coalesce((p->>'valid_invoice')::boolean, true),
         supplier_quote_ref = nullif(p->>'supplier_quote_ref',''), supplier_quote_date = nullif(p->>'supplier_quote_date','')::date,
         quoted_at = now()
  where id = p_rfq;
end $$;

create or replace function public.finance_accept_rfq(p_rfq bigint, p_project bigint) returns bigint
language plpgsql set search_path = public as $$
declare r rfqs%rowtype; v_net numeric; v_vr numeric; v_gross numeric; v_proj bigint; v_po bigint;
begin
  select * into r from rfqs where id = p_rfq for update;
  if not found then raise exception 'طلب عرض السعر غير موجود'; end if;
  if r.status <> 'quoted' then raise exception 'سجّل رد المورد (الأسعار) الأول قبل القبول'; end if;
  select coalesce(sum(qty * unit_price), 0) into v_net from rfq_items where rfq_id = p_rfq;
  select vat_rate / 100.0 into v_vr from finance_settings where id = 1;
  v_gross := case when r.vat_mode = 'excl' then round(v_net * (1 + v_vr), 2) else round(v_net, 2) end;
  if v_gross <= 0 then raise exception 'إجمالي العرض صفر'; end if;
  v_proj := coalesce(p_project, r.project_id);
  insert into purchase_orders (supplier_id, project_id, amount, tax_treatment, description, rfq_id)
  values (r.supplier_id, v_proj, v_gross, case when r.vat_mode = 'none' or not r.valid_invoice then 'none' else 'recoverable' end,
          'حسب عرض سعر المورد RFQ-' || lpad(r.id::text, 4, '0'), r.id)
  returning id into v_po;
  update rfqs set status = 'accepted', po_id = v_po, project_id = v_proj, decided_at = now() where id = p_rfq;
  return v_po;
end $$;

create or replace function public.finance_reject_rfq(p_rfq bigint) returns void
language plpgsql set search_path = public as $$
declare r rfqs%rowtype;
begin
  select * into r from rfqs where id = p_rfq for update;
  if not found then raise exception 'طلب عرض السعر غير موجود'; end if;
  if r.status not in ('draft','sent','quoted') then raise exception 'الطلب اتقفل بالفعل'; end if;
  update rfqs set status = 'rejected', decided_at = now() where id = p_rfq;
end $$;

do $$ declare f text; begin
  foreach f in array array['finance_create_rfq(jsonb)','finance_record_rfq_quote(bigint,jsonb)','finance_accept_rfq(bigint,bigint)','finance_reject_rfq(bigint)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
