-- يرجّع كل حاجة اتضافت في 0062. تحذير: بيمسح جدول tasks بكل محتواه.
drop function if exists public.distribute_customers(bigint[], text[], text, text, date, text, boolean);
drop function if exists public.assign_customers(bigint[], text, text, text, date, text, boolean);
drop table if exists public.tasks cascade;
drop function if exists public.tasks_biu();
drop view if exists public.assignable_users;
update public.app_roles set permissions = array_remove(array_remove(array_remove(permissions,'tasks.own'),'tasks.assign'),'tasks.view_all');
alter table public.customers drop constraint if exists customers_assigned_to_fkey;
drop index if exists public.customers_assigned_to_idx;
alter table public.customers drop column if exists assigned_to, drop column if exists assigned_at, drop column if exists assigned_by;
