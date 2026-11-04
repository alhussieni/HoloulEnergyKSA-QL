-- 0053: أعمال إضافية متفق عليها مع العميل أثناء التنفيذ (أمر تغيير). عكس الخصم تمامًا: بتزوّد projects.contract_value
-- فكل التقارير (المتبقي، الربحية، حالة السداد عبر trg_projects_contract_recalc) بتتحدّث لوحدها.
-- المبلغ شامل الضريبة. لو التعاقد مسجّل "غير شامل الضريبة" بيتحوّل لصافي قبل الإضافة (نفس منطق الخصم).
-- الإضافة بتتسجّل بتفاصيلها وتاريخ وإقرار العميل، وممكن تتلغى (بشرط ما يبقاش المحصّل أكبر من التعاقد بعد الإلغاء).

create table if not exists public.project_extras (
  id bigint generated always as identity primary key,
  project_id bigint not null references public.projects(id) on delete cascade,
  title text not null check (length(btrim(title)) > 0),
  details text,
  amount numeric(14,2) not null check (amount > 0),                         -- قيمة الإضافة (شامل الضريبة)
  contract_value_increase numeric(14,2) not null check (contract_value_increase > 0), -- اللي اتزاد فعليًا على contract_value
  extra_date date not null default current_date,
  approved_on date,                                                          -- تاريخ موافقة العميل
  approval_note text,                                                        -- شكل الإقرار (واتساب / توقيع / رقم أمر ...)
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists project_extras_project_idx on public.project_extras(project_id);
alter table public.project_extras enable row level security;
revoke all on public.project_extras from anon, authenticated;

create or replace function public.finance_add_extra(p_project bigint, p_title text, p_details text, p_amount numeric, p_date date, p_approved date, p_note text)
returns bigint language plpgsql set search_path = public as $$
declare
  v_inc boolean; v_vr numeric; v_inc_cv numeric; v_id bigint;
  a numeric(14,2) := round(coalesce(p_amount, 0), 2);
begin
  if a <= 0 then raise exception 'قيمة الأعمال الإضافية غير صالحة'; end if;
  if p_title is null or length(btrim(p_title)) = 0 then raise exception 'اكتب عنوان الأعمال الإضافية'; end if;
  perform 1 from projects where id = p_project for update;
  if not found then raise exception 'المشروع غير موجود'; end if;
  v_inc := coalesce((select contract_includes_vat from project_finance_flags where project_id = p_project), true);
  select vat_rate / 100.0 into v_vr from finance_settings where id = 1;
  v_inc_cv := case when v_inc then a else round(a / (1 + coalesce(v_vr, 0)), 2) end;
  update projects set contract_value = coalesce(contract_value, 0) + v_inc_cv where id = p_project;
  insert into project_extras (project_id, title, details, amount, contract_value_increase, extra_date, approved_on, approval_note, created_by)
  values (p_project, btrim(p_title), nullif(btrim(coalesce(p_details, '')), ''), a, v_inc_cv, coalesce(p_date, current_date), p_approved, nullif(btrim(coalesce(p_note, '')), ''), 'admin')
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.finance_undo_extra(p_id bigint) returns void
language plpgsql set search_path = public as $$
declare x project_extras%rowtype; v_cv numeric; v_inc boolean; v_vr numeric; v_paid numeric; v_gross numeric;
begin
  select * into x from project_extras where id = p_id;
  if not found then raise exception 'الأعمال الإضافية غير موجودة'; end if;
  select contract_value into v_cv from projects where id = x.project_id for update;
  v_inc := coalesce((select contract_includes_vat from project_finance_flags where project_id = x.project_id), true);
  select vat_rate / 100.0 into v_vr from finance_settings where id = 1;
  v_paid := coalesce((select sum(amount) from payments where project_id = x.project_id), 0);
  v_gross := case when v_inc then coalesce(v_cv, 0) - x.contract_value_increase
                  else round((coalesce(v_cv, 0) - x.contract_value_increase) * (1 + coalesce(v_vr, 0)), 2) end;
  if v_paid > v_gross + 0.005 then
    raise exception 'مينفعش تلغي الإضافة: المحصّل (%) هيبقى أكبر من قيمة التعاقد بعد الإلغاء (%)', v_paid, round(v_gross, 2);
  end if;
  update projects set contract_value = coalesce(contract_value, 0) - x.contract_value_increase where id = x.project_id;
  delete from project_extras where id = p_id;
end $$;

revoke all on function public.finance_add_extra(bigint, text, text, numeric, date, date, text) from public, anon, authenticated;
revoke all on function public.finance_undo_extra(bigint) from public, anon, authenticated;

-- سجل التغييرات (نفس باقي جداول الأعمال)
do $$ begin
  if to_regclass('public.change_journal') is not null then
    drop trigger if exists trg_journal on public.project_extras;
    create trigger trg_journal after insert or update or delete on public.project_extras for each row execute function public.journal_row_change();
  end if;
end $$;
