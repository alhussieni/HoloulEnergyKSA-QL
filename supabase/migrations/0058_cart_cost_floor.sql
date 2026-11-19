-- 0058: سلة المنتجات — السيرفر يتحقق من سعر الصنف ويمنع أي خصم ينزل بالصافي تحت تكلفة الأصناف.
-- القاعدة: أقصى خصم = (إجمالي الأصناف - تكلفتها). التركيب والنقل بدون نموذج تكلفة فبيتعاملوا بدون هامش
-- (الخصم عمره ما ياكل منهم). الصنف اللي مش في الكتالوج: بيتحسب بتكلفة = سعره (بدون هامش).
-- الرفض بيتم بـ raise exception برسالة عربي واضحة وفي آخرها كود بين أقواس [CART_*] (الواجهة بتفسّره). لو التحقق نفسه فشل لأي سبب
-- وفيه خصم موجب → بنرفض (fail-closed)؛ من غير خصم → بيكمل زي قبل.
-- التراجع: 0058_rollback.sql (يرجّع التعريف السابق للـ trigger ويحذف الدالة المساعدة).

create or replace function public.cart_item_basis(p_cfg jsonb, p_category text, p_name text)
returns jsonb language plpgsql stable set search_path = public as $$
declare
  rec record; rr record; d jsonb; v_list numeric; v_brand text; v_pct numeric;
  v_sell numeric; v_cost numeric;
begin
  for rec in select t.cat, t.ord from jsonb_array_elements(coalesce(p_cfg->'productCatalog', '[]'::jsonb)) with ordinality as t(cat, ord) loop
    if rec.cat->>'category' is distinct from p_category then continue; end if;
    for rr in select x.rw, x.idx from jsonb_array_elements(coalesce(rec.cat->'rows', '[]'::jsonb)) with ordinality as x(rw, idx) loop
      if rr.rw->>0 is distinct from p_name then continue; end if;
      v_list := public.cart_safe_num(rr.rw->>(jsonb_array_length(rr.rw) - 2));
      if v_list is null then return null; end if;
      v_brand := coalesce(rec.cat->'productDetails'->((rr.idx - 1)::text)->>'brand', '');
      select t.dd into d from jsonb_array_elements(coalesce(p_cfg->'discounts', '[]'::jsonb)) as t(dd)
        where t.dd->>'category' = p_category and t.dd->>'brand' = v_brand limit 1;
      v_pct := coalesce(public.cart_safe_num(d->>'promoDiscountPct'), 0);
      v_sell := case when d is not null and d->>'promoActive' = 'true' and v_pct <> 0
                     then round(v_list * (1 - v_pct / 100), 2) else v_list end;
      if d is null then
        v_cost := v_list;
      else
        v_cost := v_list * (1 - coalesce(public.cart_safe_num(d->>'supplierDiscountPct'), 0) / 100);
      end if;
      return jsonb_build_object('sell', v_sell, 'cost', v_cost);
    end loop;
  end loop;
  return null;
end $$;
revoke all on function public.cart_item_basis(jsonb, text, text) from public, anon, authenticated;

create or replace function public.quotes_cart_enforce()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
declare
  cfg jsonb; vatr numeric; is_rep boolean;
  k text; kc jsonb; it jsonb; e jsonb; b jsonb;
  mode text; unit text; price numeric; qty numeric; amt numeric; minimum numeric;
  repedit boolean; label text; cprice numeric; p numeric; q numeric;
  items_sub numeric := 0; extras_sub numeric := 0; gross numeric;
  adj_in numeric; adj numeric; net numeric; vat_amt numeric; total numeric;
  out_extras jsonb := '[]'::jsonb; seen text[] := '{}';
  items_cost numeric := 0; max_disc numeric := 0; v_err text := null; v_failed boolean := false;
begin
  if new.snapshot is null or new.snapshot->>'type' is distinct from 'product-cart' then
    return new;
  end if;
  begin
    select data into cfg from public.pricing_config where id = 1;
    vatr := coalesce(public.cart_safe_num(cfg->>'vat'), 0.15);
    is_rep := coalesce(new.rep_username, '') <> '';

    if jsonb_typeof(new.snapshot->'items') = 'array' then
      for it in select * from jsonb_array_elements(new.snapshot->'items') loop
        p := coalesce(public.cart_safe_num(it->>'price'), 0);
        q := greatest(1, round(coalesce(public.cart_safe_num(it->>'qty'), 1)));
        items_sub := items_sub + greatest(p, 0) * q;
        b := public.cart_item_basis(cfg, it->>'category', it->>'name');
        if b is null then
          items_cost := items_cost + greatest(p, 0) * q;           -- خارج الكتالوج: بدون هامش
        else
          items_cost := items_cost + (b->>'cost')::numeric * q;
          if abs(p - (b->>'sell')::numeric) > 0.011 and v_err is null then
            v_err := 'سعر الصنف "' || coalesce(it->>'name', '') || '" اتغيّر (السعر الحالي ' || (b->>'sell') || ') — حدّث الصفحة وراجع العرض. [CART_PRICE_CHANGED|' || (b->>'sell') || ']';
          end if;
        end if;
      end loop;
    end if;
    max_disc := greatest(0, floor((items_sub - items_cost) * 100) / 100);

    if is_rep and jsonb_typeof(new.snapshot->'extras') = 'array' then
      for e in select * from jsonb_array_elements(new.snapshot->'extras') loop
        k := e->>'key';
        if k is null or k not in ('civil', 'elec', 'transport') or k = any(seen) then continue; end if;
        seen := seen || k;
        kc := cfg->'offgrid'->'cartExtras'->k;
        mode := case when kc->>'mode' = 'fixed' then 'fixed' else 'variable' end;
        unit := coalesce(nullif(kc->>'unit', ''), case k when 'transport' then 'trip' else 'panel' end);
        price := coalesce(public.cart_safe_num(kc->>'price'),
                   public.cart_safe_num(case k when 'civil' then cfg->>'mechInstallPerPanel'
                                               when 'elec' then cfg->>'elecInstallPerPanel'
                                               else cfg->>'transportPerTrip' end), 0);
        minimum := case when k = 'transport'
                        then coalesce(public.cart_safe_num(kc->>'minimum'), public.cart_safe_num(cfg->>'transportMinimum'), 0)
                        else 0 end;
        repedit := coalesce(kc->>'repEdit' = 'true', false);
        label := coalesce(nullif(kc->>'label', ''),
                   case k when 'civil' then 'أعمال التركيب المدني' when 'elec' then 'أعمال التركيب الكهربائي' else 'النقل' end);
        cprice := public.cart_safe_num(e->>'unitPrice');
        if repedit and cprice is not null and cprice >= 0 then price := cprice; end if;
        if mode = 'fixed' then
          qty := 1; amt := price;
        else
          qty := greatest(0, coalesce(public.cart_safe_num(e->>'qty'), 0));
          amt := qty * price;
          if k = 'transport' and qty > 0 and minimum > 0 then amt := greatest(amt, minimum); end if;
        end if;
        amt := round(amt, 2);
        if amt > 0 then
          out_extras := out_extras || jsonb_build_array(jsonb_build_object(
            'key', k, 'label', label, 'mode', mode, 'unit', unit, 'qty', qty,
            'unitPrice', price, 'amount', amt, 'repEditable', repedit));
          extras_sub := extras_sub + amt;
        end if;
      end loop;
    end if;

    adj_in := case when is_rep then coalesce(public.cart_safe_num(new.snapshot->>'specialDiscountAmt'), 0) else 0 end;
    if adj_in > max_disc + 0.011 and v_err is null then
      v_err := 'الخصم أكبر من الحد المسموح (' || max_disc::text || ' ر.س) — السعر ما ينفعش ينزل تحت التكلفة. [CART_DISCOUNT_BELOW_COST|' || max_disc::text || ']';
    end if;
    gross := items_sub + extras_sub;
    adj := case when adj_in > 0 then least(gross, adj_in) else adj_in end;
    net := gross - adj;
    vat_amt := net * vatr;
    total := net + vat_amt;

    new.snapshot := new.snapshot || jsonb_build_object(
      'extras', out_extras, 'itemsSubtotal', round(items_sub, 2), 'extrasSubtotal', round(extras_sub, 2),
      'specialDiscountAmt', adj, 'subtotal', round(net, 2), 'vat', round(vat_amt, 2),
      'total', round(total, 2), 'vatRate', vatr, 'serverVerified', true);
    new.final_total := round(total);
  exception when others then
    v_failed := true;
    raise warning 'quotes_cart_enforce skipped: %', sqlerrm;
  end;
  if v_err is not null then
    raise exception '%', v_err using errcode = 'P0001';
  end if;
  if v_failed and coalesce(new.rep_username, '') <> ''
     and coalesce(public.cart_safe_num(new.snapshot->>'specialDiscountAmt'), 0) > 0 then
    raise exception 'تعذّر التحقق من حد التكلفة — الخصم مرفوض. [CART_CANNOT_VERIFY]' using errcode = 'P0001';
  end if;
  return new;
end $function$;
