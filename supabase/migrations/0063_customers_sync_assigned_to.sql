-- 0063: أي كتابة قديمة على customers.assigned_rep (اسم معروض، من crm-api / crm.html) بتحدّث assigned_to تلقائيًا.
-- بيخلي العمودين متطابقين لحد ما الواجهة والـ crm-api يتحدّثوا. لو الاسم مش مطابق لمندوب → assigned_to = NULL.
-- التراجع: supabase/rollbacks/0063_rollback.sql
-- (اتطبّقت بالفعل على Supabase باسم customers_sync_assigned_to — لا تشغّلها تاني.)

create or replace function public.customers_sync_assigned_to() returns trigger
language plpgsql set search_path = public as $$
declare v_user text;
begin
  if tg_op = 'INSERT' then
    if new.assigned_to is null and nullif(btrim(new.assigned_rep), '') is not null then
      select username into v_user from public.reps where display_name = btrim(new.assigned_rep) limit 1;
      new.assigned_to := v_user;
      if v_user is not null then new.assigned_at := coalesce(new.assigned_at, now()); end if;
    end if;
  elsif new.assigned_rep is distinct from old.assigned_rep
        and new.assigned_to is not distinct from old.assigned_to then
    select username into v_user from public.reps
     where display_name = nullif(btrim(new.assigned_rep), '') limit 1;
    new.assigned_to := v_user;
    new.assigned_at := case when v_user is null then null else now() end;
  end if;
  return new;
end $$;

drop trigger if exists trg_customers_sync_assigned_to on public.customers;
create trigger trg_customers_sync_assigned_to
  before insert or update of assigned_rep on public.customers
  for each row execute function public.customers_sync_assigned_to();
