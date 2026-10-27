-- 0038: ردود الموردين على RFQ بشكل مرن
--  (1) المورد يبلّغ سعر كل بند لوحده — ومش شرط كل البنود (بند أو أكتر، وتكمّل لاحقًا)
--  (2) أو يبلّغ سعر إجمالي واحد للطلب كله (lump_total)
--  (3) أي سعر يتعدّل/يتمسح، حتى بعد القبول طالما أمر الشراء ماعليهوش فواتير ولا دفعات (وبيتحدّث مبلغ الأمر تلقائيًا)

alter table public.rfqs add column if not exists lump_total numeric(14,2) check (lump_total is null or lump_total > 0);

create or replace view public.v_rfqs with (security_invoker = true) as
select r.id as rfq_id, 'RFQ-' || lpad(r.id::text, 4, '0') as rfq_number,
       r.supplier_id, s.name as supplier_name, s.phone as supplier_phone,
       r.quote_id, r.quote_ref, r.project_id, pr.project_number, r.status, r.notes,
       r.supplier_quote_ref, r.supplier_quote_date, r.vat_mode, r.valid_invoice, r.po_id,
       r.created_at, r.sent_at, r.quoted_at, r.decided_at,
       (select count(*) from public.rfq_items i where i.rfq_id = r.id) as items_count,
       coalesce(r.lump_total, n.net_total) as net_total,
       case when coalesce(r.lump_total, n.net_total) is null then null
            when r.vat_mode = 'excl' then round(coalesce(r.lump_total, n.net_total) * (1 + fs.vr), 2)
            else round(coalesce(r.lump_total, n.net_total), 2) end as total_gross,
       coalesce(n.priced_count, 0) as priced_count,
       r.lump_total
from public.rfqs r
join public.suppliers s on s.id = r.supplier_id
left join public.projects pr on pr.id = r.project_id
cross join (select vat_rate / 100.0 as vr from public.finance_settings where id = 1) fs
left join (select rfq_id, sum(qty * unit_price) as net_total, count(*) as priced_count from public.rfq_items where unit_price is not null group by rfq_id) n on n.rfq_id = r.id;

-- p: { mode: 'items'|'lump', prices:[{line_no, unit_price|null}], lump_total, vat_mode?, valid_invoice?, supplier_quote_ref?, supplier_quote_date? }
create or replace function public.finance_record_rfq_quote(p_rfq bigint, p jsonb) returns void
language plpgsql set search_path = public as $$
declare
  r rfqs%rowtype; pr jsonb; v_mode text; v_valid boolean; v_lump numeric; v_price numeric; v_line int;
  v_net numeric; v_vr numeric; v_gross numeric; v_n int;
begin
  select * into r from rfqs where id = p_rfq for update;
  if not found then raise exception 'طلب عرض السعر غير موجود'; end if;
  if r.status in ('rejected','cancelled') then raise exception 'الطلب اتقفل — مينفعش تعدّل أسعاره'; end if;
  if r.status = 'accepted' and r.po_id is not null and (
       exists (select 1 from supplier_bills where purchase_order_id = r.po_id)
    or exists (select 1 from treasury_entries where purchase_order_id = r.po_id)) then
    raise exception 'الطلب اتقبل واتسجّل على أمر الشراء فواتير أو دفعات — عدّل من تبويب أوامر الشراء';
  end if;

  v_mode := coalesce(nullif(p->>'vat_mode',''), r.vat_mode);
  if v_mode is null or v_mode not in ('incl','excl','none') then raise exception 'حدّد هل أسعار المورد شاملة الضريبة أم لا'; end if;
  v_valid := coalesce((p->>'valid_invoice')::boolean, r.valid_invoice, true);

  if coalesce(p->>'mode','items') = 'lump' then
    v_lump := round(coalesce(nullif(p->>'lump_total','')::numeric, 0), 2);
    if v_lump <= 0 then raise exception 'اكتب السعر الإجمالي اللي بلّغه المورد'; end if;
    update rfq_items set unit_price = null where rfq_id = p_rfq;       -- سعر إجمالي = مفيش أسعار بنود
  else
    v_lump := null;
    for pr in select * from jsonb_array_elements(coalesce(p->'prices', '[]'::jsonb)) loop
      v_line := (pr->>'line_no')::int;
      v_price := nullif(pr->>'unit_price','')::numeric;                -- فاضي/null = مسح السعر
      if v_price is not null and v_price < 0 then raise exception 'السعر لا يكون سالب'; end if;
      update rfq_items set unit_price = case when v_price is null then null else round(v_price, 4) end
       where rfq_id = p_rfq and line_no = v_line;
      get diagnostics v_n = row_count;
      if v_n = 0 then raise exception 'البند رقم % مش موجود في الطلب', v_line; end if;
    end loop;
    if not exists (select 1 from rfq_items where rfq_id = p_rfq and unit_price is not null) then
      raise exception 'سجّل سعر بند واحد على الأقل';
    end if;
  end if;

  update rfqs set
    status = case when status = 'accepted' then status else 'quoted' end,
    vat_mode = v_mode, valid_invoice = v_valid, lump_total = v_lump,
    supplier_quote_ref  = case when p ? 'supplier_quote_ref'  then nullif(p->>'supplier_quote_ref','')  else supplier_quote_ref end,
    supplier_quote_date = case when p ? 'supplier_quote_date' then nullif(p->>'supplier_quote_date','')::date else supplier_quote_date end,
    quoted_at = coalesce(quoted_at, now())
  where id = p_rfq;

  -- لو الطلب اتقبل قبل كده وأمر الشراء لسه نضيف: حدّث مبلغه
  if r.status = 'accepted' and r.po_id is not null then
    select coalesce(v_lump, sum(qty * unit_price), 0) into v_net from rfq_items where rfq_id = p_rfq;
    select vat_rate / 100.0 into v_vr from finance_settings where id = 1;
    v_gross := case when v_mode = 'excl' then round(v_net * (1 + v_vr), 2) else round(v_net, 2) end;
    if v_gross <= 0 then raise exception 'إجمالي العرض صفر'; end if;
    update purchase_orders set amount = v_gross,
           tax_treatment = case when v_mode = 'none' or not v_valid then 'none' else 'recoverable' end
     where id = r.po_id;
  end if;
end $$;

create or replace function public.finance_accept_rfq(p_rfq bigint, p_project bigint) returns bigint
language plpgsql set search_path = public as $$
declare r rfqs%rowtype; v_net numeric; v_vr numeric; v_gross numeric; v_proj bigint; v_po bigint; v_priced int; v_all int; v_desc text;
begin
  select * into r from rfqs where id = p_rfq for update;
  if not found then raise exception 'طلب عرض السعر غير موجود'; end if;
  if r.status <> 'quoted' then raise exception 'سجّل رد المورد (الأسعار) الأول قبل القبول'; end if;
  select count(*) filter (where unit_price is not null), count(*), coalesce(sum(qty * unit_price), 0)
    into v_priced, v_all, v_net from rfq_items where rfq_id = p_rfq;
  if r.lump_total is not null then v_net := r.lump_total; end if;
  select vat_rate / 100.0 into v_vr from finance_settings where id = 1;
  v_gross := case when r.vat_mode = 'excl' then round(v_net * (1 + v_vr), 2) else round(v_net, 2) end;
  if v_gross <= 0 then raise exception 'إجمالي العرض صفر'; end if;
  v_proj := coalesce(p_project, r.project_id);
  v_desc := 'حسب عرض سعر المورد RFQ-' || lpad(r.id::text, 4, '0')
         || case when r.lump_total is not null then ' (سعر إجمالي)'
                 when v_priced < v_all then ' (' || v_priced || ' من ' || v_all || ' بنود)' else '' end;
  insert into purchase_orders (supplier_id, project_id, amount, tax_treatment, description, rfq_id)
  values (r.supplier_id, v_proj, v_gross, case when r.vat_mode = 'none' or not r.valid_invoice then 'none' else 'recoverable' end, v_desc, r.id)
  returning id into v_po;
  update rfqs set status = 'accepted', po_id = v_po, project_id = v_proj, decided_at = now() where id = p_rfq;
  return v_po;
end $$;

do $$ declare f text; begin
  foreach f in array array['finance_record_rfq_quote(bigint,jsonb)','finance_accept_rfq(bigint,bigint)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;
