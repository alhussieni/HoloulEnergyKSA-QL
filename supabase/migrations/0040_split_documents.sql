-- 0040: تحويل مقسّم على أكتر من مشروع/فاتورة/أمر شراء + فاتورة مقسّمة على أكتر من مشروع + طلب عرض سعر مشترك لأكتر من عرض/مشروع.
-- اتطبقت باسم split_documents_v1.
-- المبدأ: مفيش تغيير في منطق الحسابات. كل جزء = حركة/فاتورة عادية بمشروعها، وبتتجمّع بمعرّف مجموعة (payment_group / bill_group).
-- الطلب المشترك: كل بند ليه توزيع كميات (alloc) على (عرض/مشروع). القبول بيطلّع أمر شراء لكل مشروع بنصيبه.

alter table public.treasury_entries add column if not exists payment_group uuid;
alter table public.supplier_bills add column if not exists bill_group uuid;
alter table public.rfq_items add column if not exists alloc jsonb;
alter table public.rfqs add column if not exists is_multi boolean not null default false;
create index if not exists treasury_entries_pgroup_idx on public.treasury_entries(payment_group) where payment_group is not null;
create index if not exists supplier_bills_bgroup_idx on public.supplier_bills(bill_group) where bill_group is not null;
create index if not exists purchase_orders_rfq_idx on public.purchase_orders(rfq_id) where rfq_id is not null;

create or replace view public.v_treasury_ledger with (security_invoker = true) as
select e.id, e.entry_date, e.account_id, a.name as account_name, a.kind as account_kind,
       e.direction, e.amount, e.kind, e.method, e.reference, e.notes,
       e.project_id, pr.project_number, cu.name as customer_name,
       e.supplier_id, s.name as supplier_name, e.bill_id, e.transfer_group, e.created_at,
       a.opening_balance + sum(case when e.direction = 'in' then e.amount else -e.amount end)
         over (partition by e.account_id order by e.entry_date, e.id) as running_balance,
       e.payment_group
from public.treasury_entries e
join public.treasury_accounts a on a.id = e.account_id
left join public.projects pr on pr.id = e.project_id
left join public.customers cu on cu.id = pr.customer_id
left join public.suppliers s on s.id = e.supplier_id
where e.entry_date >= a.opening_date;
revoke all on public.v_treasury_ledger from anon, authenticated;

create or replace view public.v_rfqs with (security_invoker = true) as
 SELECT r.id AS rfq_id, 'RFQ-'::text || lpad(r.id::text, 4, '0'::text) AS rfq_number, r.supplier_id, s.name AS supplier_name, s.phone AS supplier_phone,
    r.quote_id, r.quote_ref, r.project_id, pr.project_number, r.status, r.notes, r.supplier_quote_ref, r.supplier_quote_date, r.vat_mode, r.valid_invoice, r.po_id,
    r.created_at, r.sent_at, r.quoted_at, r.decided_at,
    ( SELECT count(*) FROM rfq_items i WHERE i.rfq_id = r.id) AS items_count,
    COALESCE(r.lump_total, n.net_total) AS net_total,
        CASE
            WHEN COALESCE(r.lump_total, n.net_total) IS NULL THEN NULL::numeric
            WHEN r.vat_mode = 'excl'::text THEN round(COALESCE(r.lump_total, n.net_total) * (1::numeric + fs.vr), 2)
            ELSE round(COALESCE(r.lump_total, n.net_total), 2)
        END AS total_gross,
    COALESCE(n.priced_count, 0::bigint) AS priced_count,
    r.lump_total,
    r.is_multi
   FROM rfqs r
     JOIN suppliers s ON s.id = r.supplier_id
     LEFT JOIN projects pr ON pr.id = r.project_id
     CROSS JOIN ( SELECT finance_settings.vat_rate / 100.0 AS vr FROM finance_settings WHERE finance_settings.id = 1) fs
     LEFT JOIN ( SELECT rfq_items.rfq_id, sum(rfq_items.qty * rfq_items.unit_price) AS net_total, count(*) AS priced_count
           FROM rfq_items WHERE rfq_items.unit_price IS NOT NULL GROUP BY rfq_items.rfq_id) n ON n.rfq_id = r.id;
revoke all on public.v_rfqs from anon, authenticated;

-- ---------------------------- تحويل مقسّم ----------------------------
create or replace function public.finance_record_split_payment(p jsonb) returns uuid
language plpgsql set search_path = public as $$
declare g uuid := gen_random_uuid(); ln jsonb; v_sum numeric := 0; v_total numeric := round(coalesce(nullif(p->>'total','')::numeric, 0), 2);
  v_amt numeric; v_id bigint; v_ids bigint[] := '{}'; v_sup bigint := nullif(p->>'supplier_id','')::bigint; v_bsup bigint;
begin
  if v_sup is null or not exists (select 1 from suppliers where id = v_sup) then raise exception 'اختر المورد'; end if;
  if jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') < 1 then raise exception 'أضف سطر واحد على الأقل'; end if;
  for ln in select * from jsonb_array_elements(p->'lines') loop
    v_amt := round(coalesce(nullif(ln->>'amount','')::numeric, 0), 2);
    if v_amt <= 0 then raise exception 'مبلغ أحد الأسطر غير صالح'; end if;
    v_sum := v_sum + v_amt;
    if nullif(ln->>'bill_id','') is not null then
      select supplier_id into v_bsup from supplier_bills where id = (ln->>'bill_id')::bigint;
      if v_bsup is distinct from v_sup then raise exception 'إحدى الفواتير بتاعة مورد تاني'; end if;
    end if;
  end loop;
  if v_total > 0 and abs(v_sum - v_total) > 0.005 then raise exception 'مجموع الأسطر (%) لا يساوي مبلغ التحويل (%)', v_sum, v_total; end if;
  for ln in select * from jsonb_array_elements(p->'lines') loop
    v_id := finance_record_entry(jsonb_build_object('kind','supplier_payment','account_id',p->>'account_id','entry_date',p->>'entry_date',
      'method',p->>'method','reference',p->>'reference','notes',coalesce(nullif(ln->>'notes',''), p->>'notes'),'supplier_id',p->>'supplier_id',
      'amount',ln->>'amount','project_id',ln->>'project_id','po_id',ln->>'po_id','bill_id',ln->>'bill_id'));
    v_ids := v_ids || v_id;
  end loop;
  update treasury_entries set payment_group = g where id = any(v_ids);
  return g;
end $$;
revoke all on function public.finance_record_split_payment(jsonb) from public, anon, authenticated;

create or replace function public.finance_delete_split_payment(p_group uuid) returns int
language plpgsql set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select id from treasury_entries where payment_group = p_group order by id loop
    perform finance_delete_entry(r.id); n := n + 1;
  end loop;
  if n = 0 then raise exception 'التحويل غير موجود'; end if;
  return n;
end $$;
revoke all on function public.finance_delete_split_payment(uuid) from public, anon, authenticated;

-- ---------------------------- فاتورة مقسّمة ----------------------------
create or replace function public.finance_record_split_bill(p jsonb) returns uuid
language plpgsql set search_path = public as $$
declare g uuid := gen_random_uuid(); ln jsonb; v_sum numeric := 0; v_total numeric := round(coalesce(nullif(p->>'total','')::numeric, 0), 2);
  v_amt numeric; v_id bigint; v_ids bigint[] := '{}';
begin
  if jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') < 1 then raise exception 'أضف سطر واحد على الأقل'; end if;
  for ln in select * from jsonb_array_elements(p->'lines') loop
    v_amt := round(coalesce(nullif(ln->>'amount','')::numeric, 0), 2);
    if v_amt <= 0 then raise exception 'مبلغ أحد الأسطر غير صالح'; end if;
    v_sum := v_sum + v_amt;
  end loop;
  if v_total > 0 and abs(v_sum - v_total) > 0.005 then raise exception 'مجموع الأسطر (%) لا يساوي قيمة الفاتورة (%)', v_sum, v_total; end if;
  for ln in select * from jsonb_array_elements(p->'lines') loop
    v_id := finance_record_bill(jsonb_build_object('supplier_id',p->>'supplier_id','supplier_name',p->>'supplier_name','project_id',ln->>'project_id','po_id',ln->>'po_id',
      'amount',ln->>'amount','bill_date',p->>'bill_date','tax_treatment',p->>'tax_treatment','description',coalesce(nullif(ln->>'description',''), p->>'description'),
      'bill_number',p->>'bill_number','cost_type',coalesce(nullif(ln->>'cost_type',''), p->>'cost_type'),'doc_type',p->>'doc_type'));
    v_ids := v_ids || v_id;
  end loop;
  update supplier_bills set bill_group = g where id = any(v_ids);
  return g;
end $$;
revoke all on function public.finance_record_split_bill(jsonb) from public, anon, authenticated;

-- ---------------------------- طلب عرض سعر مشترك ----------------------------
create or replace function public.finance_create_rfq(p jsonb)
returns bigint language plpgsql set search_path = public as $$
declare
  v_sup bigint := nullif(p->>'supplier_id','')::bigint;
  v_name text := nullif(btrim(coalesce(p->>'supplier_name','')), '');
  v_id bigint; it jsonb; al jsonb; n int := 0; v_label text; v_qty numeric; v_multi boolean := false; v_alloc jsonb; v_aq numeric;
begin
  if v_sup is null and v_name is not null then
    select id into v_sup from suppliers where lower(name) = lower(v_name);
    if v_sup is null then insert into suppliers (name) values (v_name) returning id into v_sup; end if;
  end if;
  if v_sup is null or not exists (select 1 from suppliers where id = v_sup) then raise exception 'اختر المورد أو اكتب اسم مورد جديد'; end if;
  if jsonb_typeof(p->'items') is distinct from 'array' or jsonb_array_length(p->'items') = 0 then raise exception 'اختر بند واحد على الأقل'; end if;
  select exists (select 1 from jsonb_array_elements(p->'items') x where jsonb_typeof(x->'alloc') = 'array') into v_multi;
  insert into rfqs (supplier_id, quote_id, quote_ref, project_id, notes, is_multi)
  values (v_sup, case when v_multi then null else nullif(p->>'quote_id','')::bigint end, nullif(p->>'quote_ref',''),
          case when v_multi then null else nullif(p->>'project_id','')::bigint end, nullif(p->>'notes',''), v_multi)
  returning id into v_id;
  for it in select * from jsonb_array_elements(p->'items') loop
    v_label := btrim(coalesce(it->>'label', ''));
    v_qty := coalesce(nullif(it->>'qty','')::numeric, 0);
    v_alloc := null;
    if v_multi and jsonb_typeof(it->'alloc') = 'array' then
      v_qty := 0; v_alloc := '[]'::jsonb;
      for al in select * from jsonb_array_elements(it->'alloc') loop
        v_aq := coalesce(nullif(al->>'qty','')::numeric, 0);
        if v_aq <= 0 then continue; end if;
        v_qty := v_qty + v_aq;
        v_alloc := v_alloc || jsonb_build_array(jsonb_build_object('quote_id', nullif(al->>'quote_id','')::bigint, 'project_id', nullif(al->>'project_id','')::bigint, 'qty', v_aq));
      end loop;
    elsif v_multi then
      continue;   -- بند من غير توزيع في طلب مشترك: مش داخل
    end if;
    if v_label = '' then continue; end if;
    if v_qty <= 0 then raise exception 'اكتب كمية صحيحة للبند: %', v_label; end if;
    n := n + 1;
    insert into rfq_items (rfq_id, line_no, label, qty, unit, qty_note, alloc)
    values (v_id, n, v_label, v_qty, nullif(btrim(coalesce(it->>'unit','')), ''), nullif(btrim(coalesce(it->>'qty_note','')), ''), v_alloc);
  end loop;
  if n = 0 then raise exception 'اختر بند واحد على الأقل'; end if;
  return v_id;
end $$;
revoke all on function public.finance_create_rfq(jsonb) from public, anon, authenticated;

create or replace function public.fn_rfq_project_net(p_rfq bigint, p_project bigint) returns numeric
language sql stable set search_path = public as $$
  select coalesce(sum(i.unit_price * (select coalesce(sum((a->>'qty')::numeric), 0) from jsonb_array_elements(i.alloc) a
                                      where nullif(a->>'project_id','')::bigint is not distinct from p_project)), 0)
  from rfq_items i where i.rfq_id = p_rfq and i.unit_price is not null and i.alloc is not null $$;
revoke all on function public.fn_rfq_project_net(bigint, bigint) from public, anon, authenticated;

create or replace function public.fn_rfq_sync_pos(p_rfq bigint) returns void
language plpgsql set search_path = public as $$
declare r rfqs%rowtype; v_vr numeric; v_net numeric; v_gross numeric; po record;
begin
  select * into r from rfqs where id = p_rfq;
  select vat_rate / 100.0 into v_vr from finance_settings where id = 1;
  if not r.is_multi then
    if r.po_id is null then return; end if;
    select coalesce(r.lump_total, sum(qty * unit_price), 0) into v_net from rfq_items where rfq_id = p_rfq;
    v_gross := case when r.vat_mode = 'excl' then round(v_net * (1 + v_vr), 2) else round(v_net, 2) end;
    if v_gross <= 0 then raise exception 'إجمالي العرض صفر'; end if;
    update purchase_orders set amount = v_gross, tax_treatment = case when r.vat_mode = 'none' or not r.valid_invoice then 'none' else 'recoverable' end where id = r.po_id;
  else
    for po in select id, project_id from purchase_orders where rfq_id = p_rfq loop
      v_net := fn_rfq_project_net(p_rfq, po.project_id);
      v_gross := case when r.vat_mode = 'excl' then round(v_net * (1 + v_vr), 2) else round(v_net, 2) end;
      if v_gross <= 0 then raise exception 'إجمالي أمر الشراء %: صفر — سجّل سعر بند واحد على الأقل لكل مشروع', po.id; end if;
      update purchase_orders set amount = v_gross, tax_treatment = case when r.vat_mode = 'none' or not r.valid_invoice then 'none' else 'recoverable' end where id = po.id;
    end loop;
  end if;
end $$;
revoke all on function public.fn_rfq_sync_pos(bigint) from public, anon, authenticated;

create or replace function public.finance_record_rfq_quote(p_rfq bigint, p jsonb)
returns void language plpgsql set search_path = public as $$
declare
  r rfqs%rowtype; pr jsonb; v_mode text; v_valid boolean; v_lump numeric; v_price numeric; v_line int; v_n int;
begin
  select * into r from rfqs where id = p_rfq for update;
  if not found then raise exception 'طلب عرض السعر غير موجود'; end if;
  if r.status in ('rejected','cancelled') then raise exception 'الطلب اتقفل — مينفعش تعدّل أسعاره'; end if;
  if r.status = 'accepted' and (
       exists (select 1 from supplier_bills b join purchase_orders o on o.id = b.purchase_order_id where o.rfq_id = p_rfq)
    or exists (select 1 from treasury_entries t join purchase_orders o on o.id = t.purchase_order_id where o.rfq_id = p_rfq)) then
    raise exception 'الطلب اتقبل واتسجّل على أمر الشراء فواتير أو دفعات — عدّل من تبويب أوامر الشراء';
  end if;

  v_mode := coalesce(nullif(p->>'vat_mode',''), r.vat_mode);
  if v_mode is null or v_mode not in ('incl','excl','none') then raise exception 'حدّد هل أسعار المورد شاملة الضريبة أم لا'; end if;
  v_valid := coalesce((p->>'valid_invoice')::boolean, r.valid_invoice, true);

  if coalesce(p->>'mode','items') = 'lump' then
    if r.is_multi then raise exception 'السعر الإجمالي الواحد مش متاح في الطلب المشترك — سجّل سعر كل بند'; end if;
    v_lump := round(coalesce(nullif(p->>'lump_total','')::numeric, 0), 2);
    if v_lump <= 0 then raise exception 'اكتب السعر الإجمالي اللي بلّغه المورد'; end if;
    update rfq_items set unit_price = null where rfq_id = p_rfq;
  else
    v_lump := null;
    for pr in select * from jsonb_array_elements(coalesce(p->'prices', '[]'::jsonb)) loop
      v_line := (pr->>'line_no')::int;
      v_price := nullif(pr->>'unit_price','')::numeric;
      if v_price is not null and v_price < 0 then raise exception 'السعر لا يكون سالب'; end if;
      update rfq_items set unit_price = case when v_price is null then null else round(v_price, 4) end where rfq_id = p_rfq and line_no = v_line;
      get diagnostics v_n = row_count;
      if v_n = 0 then raise exception 'البند رقم % مش موجود في الطلب', v_line; end if;
    end loop;
    if not exists (select 1 from rfq_items where rfq_id = p_rfq and unit_price is not null) then raise exception 'سجّل سعر بند واحد على الأقل'; end if;
  end if;

  update rfqs set
    status = case when status = 'accepted' then status else 'quoted' end,
    vat_mode = v_mode, valid_invoice = v_valid, lump_total = v_lump,
    supplier_quote_ref  = case when p ? 'supplier_quote_ref'  then nullif(p->>'supplier_quote_ref','')  else supplier_quote_ref end,
    supplier_quote_date = case when p ? 'supplier_quote_date' then nullif(p->>'supplier_quote_date','')::date else supplier_quote_date end,
    quoted_at = coalesce(quoted_at, now())
  where id = p_rfq;

  if r.status = 'accepted' then perform fn_rfq_sync_pos(p_rfq); end if;
end $$;
revoke all on function public.finance_record_rfq_quote(bigint, jsonb) from public, anon, authenticated;

create or replace function public.finance_accept_rfq(p_rfq bigint, p_project bigint)
returns bigint language plpgsql set search_path = public as $$
declare r rfqs%rowtype; v_net numeric; v_vr numeric; v_gross numeric; v_proj bigint; v_po bigint; v_first bigint; v_priced int; v_all int; v_desc text; v_tax text; pj record; v_cnt int := 0;
begin
  select * into r from rfqs where id = p_rfq for update;
  if not found then raise exception 'طلب عرض السعر غير موجود'; end if;
  if r.status <> 'quoted' then raise exception 'سجّل رد المورد (الأسعار) الأول قبل القبول'; end if;
  select vat_rate / 100.0 into v_vr from finance_settings where id = 1;
  v_tax := case when r.vat_mode = 'none' or not r.valid_invoice then 'none' else 'recoverable' end;
  select count(*) filter (where unit_price is not null), count(*) into v_priced, v_all from rfq_items where rfq_id = p_rfq;

  if r.is_multi then
    for pj in select distinct nullif(a->>'project_id','')::bigint as project_id
                from rfq_items i, jsonb_array_elements(i.alloc) a where i.rfq_id = p_rfq and i.alloc is not null loop
      v_net := fn_rfq_project_net(p_rfq, pj.project_id);
      if v_net <= 0 then continue; end if;
      v_gross := case when r.vat_mode = 'excl' then round(v_net * (1 + v_vr), 2) else round(v_net, 2) end;
      v_desc := 'حسب عرض سعر المورد RFQ-' || lpad(r.id::text, 4, '0') || ' (طلب مشترك — حصة المشروع)'
             || case when v_priced < v_all then ' (' || v_priced || ' من ' || v_all || ' بنود مسعّرة)' else '' end;
      insert into purchase_orders (supplier_id, project_id, amount, tax_treatment, description, rfq_id)
      values (r.supplier_id, pj.project_id, v_gross, v_tax, v_desc, r.id) returning id into v_po;
      if v_first is null then v_first := v_po; end if;
      v_cnt := v_cnt + 1;
    end loop;
    if v_cnt = 0 then raise exception 'إجمالي العرض صفر'; end if;
    update rfqs set status = 'accepted', po_id = v_first, decided_at = now() where id = p_rfq;
    return v_first;
  end if;

  select coalesce(sum(qty * unit_price), 0) into v_net from rfq_items where rfq_id = p_rfq;
  if r.lump_total is not null then v_net := r.lump_total; end if;
  v_gross := case when r.vat_mode = 'excl' then round(v_net * (1 + v_vr), 2) else round(v_net, 2) end;
  if v_gross <= 0 then raise exception 'إجمالي العرض صفر'; end if;
  v_proj := coalesce(p_project, r.project_id);
  v_desc := 'حسب عرض سعر المورد RFQ-' || lpad(r.id::text, 4, '0')
         || case when r.lump_total is not null then ' (سعر إجمالي)' when v_priced < v_all then ' (' || v_priced || ' من ' || v_all || ' بنود)' else '' end;
  insert into purchase_orders (supplier_id, project_id, amount, tax_treatment, description, rfq_id)
  values (r.supplier_id, v_proj, v_gross, v_tax, v_desc, r.id) returning id into v_po;
  update rfqs set status = 'accepted', po_id = v_po, project_id = v_proj, decided_at = now() where id = p_rfq;
  return v_po;
end $$;
revoke all on function public.finance_accept_rfq(bigint, bigint) from public, anon, authenticated;
