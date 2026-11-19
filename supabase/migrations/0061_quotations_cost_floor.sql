-- 0061: عروض الأسعار الرسمية (quotations): صافي العرض قبل الضريبة (total - vat_amount) لا ينزل تحت cost.
-- • لو cost فاضي أو صفر: أي خصم (discount_total > 0) مرفوض (cost بيكتبه المرسل، فتصفيره ما يفتحش ثغرة).
-- • بيشتغل على INSERT وعلى UPDATE لـ total / vat_amount / cost / discount_total.
-- • مبني على total - vat_amount عشان معنى subtotal (قبل/بعد الخصم) مش موثّق في الجدول.
-- التراجع: supabase/rollbacks/0061_rollback.sql
-- (اتطبّقت بالفعل على Supabase باسم quotations_cost_floor — لا تشغّلها تاني.)

create or replace function public.quotations_cost_floor() returns trigger language plpgsql set search_path = public as $$
declare v_net numeric;
begin
  v_net := coalesce(new.total, 0) - coalesce(new.vat_amount, 0);
  if new.cost is null or new.cost <= 0 then
    if coalesce(new.discount_total, 0) > 0 then
      raise exception 'تكلفة العرض غير مسجلة — لا يمكن تطبيق خصم. [QUOTATION_DISCOUNT_UNVERIFIABLE]' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if v_net < new.cost - 0.05 then
    raise exception 'صافي العرض (%) أقل من التكلفة (%) — مرفوض. [QUOTATION_BELOW_COST]', round(v_net, 2), round(new.cost, 2) using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.quotations_cost_floor() from public, anon, authenticated;

drop trigger if exists trg_quotations_cost_floor on public.quotations;
create trigger trg_quotations_cost_floor before insert or update of total, vat_amount, cost, discount_total on public.quotations
  for each row execute function public.quotations_cost_floor();
