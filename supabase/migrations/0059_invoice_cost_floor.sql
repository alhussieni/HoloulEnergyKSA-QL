-- 0059: الفاتورة (document_type='invoice') ما ينفعش صافيها قبل الضريبة ينزل تحت تكلفة العرض المصدر.
-- • مصدر calc: التكلفة من quote_financials (totalCost) وقت التسعير.  • مصدر quotation: quotations.cost.
-- • فاتورة الدفعة الجزئية (milestone_id): الحد بيتناسب مع نسبة اللي اتفوتر من إجمالي العرض؛ غيرها: التكلفة كاملة.
-- • لو التكلفة مجهولة (عرض قديم قبل quote_financials، أو فاتورة حرة): أي خصم (على الفاتورة أو على بند) مرفوض.
-- الإشعارات الدائنة (credit note) مستثناة. INSERT فقط (invoices_block_tamper بيمنع التعديل بعد الإصدار).
-- التراجع: drop trigger trg_invoices_cost_floor on public.invoices; drop function public.invoices_cost_floor();

create or replace function public.invoices_cost_floor() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_cost numeric; v_sell numeric; v_gross numeric; v_ratio numeric; v_min numeric; has_line_disc boolean;
begin
  if coalesce(new.document_type, 'invoice') <> 'invoice' then return new; end if;
  v_gross := coalesce(new.subtotal, 0) + coalesce(new.discount_total, 0);
  select coalesce(bool_or(coalesce(public.cart_safe_num(x->>'discount'), 0) > 0), false) into has_line_disc
    from jsonb_array_elements(case when jsonb_typeof(new.items) = 'array' then new.items else '[]'::jsonb end) x;
  if new.source_calc_quote_id is not null then
    select public.cart_safe_num(f.financials->>'totalCost'), public.cart_safe_num(f.financials->>'sellTotal')
      into v_cost, v_sell from public.quote_financials f where f.quote_id = new.source_calc_quote_id;
  elsif new.source_quotation_id is not null then
    select q.cost, coalesce(q.subtotal, 0) + coalesce(q.discount_total, 0)
      into v_cost, v_sell from public.quotations q where q.id = new.source_quotation_id;
  end if;
  if v_cost is not null and v_cost <= 0 then v_cost := null; end if;

  if v_cost is null then
    if coalesce(new.discount_total, 0) > 0 or has_line_disc then
      raise exception 'تكلفة العرض المصدر غير معروفة — لا يمكن تطبيق خصم على الفاتورة. [INVOICE_DISCOUNT_UNVERIFIABLE]' using errcode = 'P0001';
    end if;
    return new;
  end if;
  -- التناسب بس لفواتير الدفعات الجزئية (milestone_id)؛ أي فاتورة تانية تتقارن بالتكلفة كاملة (وإلا خفض البنود يخفّض الحد)
  v_ratio := case when new.milestone_id is not null and coalesce(v_sell, 0) > 0 then least(1, v_gross / v_sell) else 1 end;
  v_min := round(v_cost * v_ratio, 2);
  if coalesce(new.subtotal, 0) < v_min - 0.05 then
    raise exception 'صافي الفاتورة (%) أقل من التكلفة (%) — الخصم مرفوض. [INVOICE_BELOW_COST]', round(coalesce(new.subtotal, 0), 2), v_min using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.invoices_cost_floor() from public, anon, authenticated;

drop trigger if exists trg_invoices_cost_floor on public.invoices;
create trigger trg_invoices_cost_floor before insert on public.invoices
  for each row execute function public.invoices_cost_floor();
