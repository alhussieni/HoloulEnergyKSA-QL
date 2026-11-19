-- 0060: خصم التسوية (finance_apply_discount) ما ينفعش ينزل بقيمة المشروع (بدون ضريبة) تحت التكاليف
-- المسجلة على المشروع (project_costs)، بنفس حساب الصافي المستخدم في وحدة المالية.
-- لو مفيش تكاليف مسجلة لسه، الحد صفر (مفيش حماية) — اعرف ده.
-- التراجع: أعد تشغيل تعريف الدالة من 0032_project_discounts.sql.

create or replace function public.finance_apply_discount(p_project bigint, p_amount numeric, p_reason text, p_date date)
returns bigint language plpgsql set search_path = public as $$
declare
  v_cv numeric; v_inc boolean; v_vr numeric; v_paid numeric; v_gross numeric; v_red numeric;
  a numeric(14,2) := round(coalesce(p_amount, 0), 2); v_id bigint; v_cost numeric; v_new_ex numeric;
begin
  if a <= 0 then raise exception 'مبلغ الخصم غير صالح'; end if;
  if p_reason is null or length(btrim(p_reason)) = 0 then raise exception 'اكتب سبب الخصم'; end if;
  select contract_value into v_cv from projects where id = p_project for update;
  if not found then raise exception 'المشروع غير موجود'; end if;
  v_inc := coalesce((select contract_includes_vat from project_finance_flags where project_id = p_project), true);
  select vat_rate / 100.0 into v_vr from finance_settings where id = 1;
  v_paid := coalesce((select sum(amount) from payments where project_id = p_project), 0);
  v_gross := case when v_inc then coalesce(v_cv, 0) else round(coalesce(v_cv, 0) * (1 + v_vr), 2) end;
  if a > v_gross - v_paid then
    raise exception 'الخصم (%) أكبر من المتبقي على العميل (%)', a, round(v_gross - v_paid, 2);
  end if;
  v_red := case when v_inc then a else round(a / (1 + v_vr), 2) end;

  -- نفس قاعدة النظام (0029/0051): التكلفة الصافية = amount/(1+vat) لو recoverable، وإلا amount
  v_cost := coalesce((select sum(case when tax_treatment = 'recoverable' then amount / (1 + coalesce(v_vr, 0.15)) else amount end)
                        from project_costs where project_id = p_project), 0);
  v_new_ex := case when v_inc then (coalesce(v_cv, 0) - v_red) / (1 + coalesce(v_vr, 0.15)) else coalesce(v_cv, 0) - v_red end;
  if v_new_ex < v_cost - 0.05 then
    raise exception 'الخصم مرفوض: قيمة المشروع بعد الخصم (% بدون ضريبة) أقل من التكاليف المسجلة (%)', round(v_new_ex, 2), round(v_cost, 2);
  end if;

  update projects set contract_value = coalesce(contract_value, 0) - v_red where id = p_project;
  insert into project_discounts (project_id, amount, contract_value_reduction, reason, discount_date, created_by)
  values (p_project, a, v_red, btrim(p_reason), coalesce(p_date, current_date), 'admin') returning id into v_id;
  return v_id;
end $$;
revoke all on function public.finance_apply_discount(bigint, numeric, text, date) from public, anon, authenticated;
