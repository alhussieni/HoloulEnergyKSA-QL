-- 0026 — Server-side enforcement for rep-prepared PRODUCT-CART quotes.
--
-- Adds installation (civil / electrical), transport, and the special
-- discount / price-increase amount to cart quotes, priced from the admin's
-- settings (pricing_config.data.offgrid.cartExtras) — never from whatever the
-- browser sent:
--   * a line whose price the admin has LOCKED (repEdit = false) is always saved
--     at the admin price; if repEdit = true the rep's unit price is accepted;
--   * fixed lines count once, variable lines = unit price x quantity,
--     transport honours the admin minimum;
--   * subtotal / VAT (pricing_config.vat) / total / final_total are recomputed.
-- Guest (rep_username null) cart saves never carry extras or an adjustment.
-- Only touches rows whose snapshot.type = 'product-cart'. Fails OPEN (keeps the
-- submitted values and raises a WARNING) so a bad config can never block saving.
--
-- cartExtras shape (all optional, defaults come from the pump-calculator rates):
--   { civil|elec|transport: { price, mode: 'fixed'|'variable', unit: 'panel'|'kw'|'trip',
--                             repEdit: bool, minimum (transport), kwPerTrip (transport, UI only), label } }

create or replace function public.cart_safe_num(t text) returns numeric
language sql immutable set search_path to 'public' as $$
  select case when replace(coalesce(t, ''), ',', '') ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
              then btrim(replace(t, ',', ''))::numeric else null end
$$;

create or replace function public.quotes_cart_enforce() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare
  cfg jsonb; vatr numeric; is_rep boolean;
  k text; kc jsonb; it jsonb; e jsonb;
  mode text; unit text; price numeric; qty numeric; amt numeric; minimum numeric;
  repedit boolean; label text; cprice numeric; p numeric; q numeric;
  items_sub numeric := 0; extras_sub numeric := 0; gross numeric;
  adj_in numeric; adj numeric; net numeric; vat_amt numeric; total numeric;
  out_extras jsonb := '[]'::jsonb; seen text[] := '{}';
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
      end loop;
    end if;

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
    gross := items_sub + extras_sub;
    adj := case when adj_in > 0 then least(gross, adj_in) else adj_in end;  -- positive = discount, negative = increase
    net := gross - adj;
    vat_amt := net * vatr;
    total := net + vat_amt;

    new.snapshot := new.snapshot || jsonb_build_object(
      'extras', out_extras, 'itemsSubtotal', round(items_sub, 2), 'extrasSubtotal', round(extras_sub, 2),
      'specialDiscountAmt', adj, 'subtotal', round(net, 2), 'vat', round(vat_amt, 2),
      'total', round(total, 2), 'vatRate', vatr, 'serverVerified', true);
    new.final_total := round(total);
  exception when others then
    raise warning 'quotes_cart_enforce skipped: %', sqlerrm;
  end;
  return new;
end $$;

revoke all on function public.cart_safe_num(text) from public, anon, authenticated;
revoke all on function public.quotes_cart_enforce() from public, anon, authenticated;

-- named "a_" so it fires BEFORE trg_quotes_set_segment / trg_quotes_stamp_codes (alphabetical order)
drop trigger if exists trg_quotes_a_cart_enforce on public.quotes;
create trigger trg_quotes_a_cart_enforce before insert on public.quotes
  for each row execute function public.quotes_cart_enforce();
