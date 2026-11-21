-- 0064: (١) أي عميل جديد يسجّله مندوب (rep_username) يتربط بيه تلقائيًا (assigned_to) لحد ما الأدمن/المدير ينقله،
--        ومينفعش مندوب يسجّل عميل باسم مندوب تاني.  العميل اللي يسجّله الأدمن بيفضل غير معيّن لحد التوزيع.
--       (٢) نقل عميل من مندوب لمندوب (assign_customers): المهام المفتوحة والصفقات المفتوحة بتتنقل معاه،
--        والمنتهية/المكسوبة/الخاسرة بتفضل في تاريخها. ومهمة «التواصل مع العميل» التلقائية للتعيين الأول بس (مش للنقل).
-- (اتطبّقت بالفعل على Supabase باسم rep_owns_registered_customers_and_transfer — لا تشغّلها تاني.)

create or replace function public.customers_sync_assigned_to() returns trigger
language plpgsql set search_path = public as $$
declare v_user text; v_disp text;
begin
  if tg_op = 'INSERT' then
    if new.rep_username is not null then
      select username, display_name into v_user, v_disp from public.reps where username = new.rep_username;
      if v_user is not null then
        new.assigned_to := v_user;
        new.assigned_rep := v_disp;
        new.assigned_at := coalesce(new.assigned_at, now());
        new.assigned_by := coalesce(new.assigned_by, v_user);
        return new;
      end if;
    end if;
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

create or replace function public.assign_customers(
  p_customer_ids bigint[],
  p_rep          text,
  p_by           text,
  p_by_role      text    default 'admin',
  p_follow_up    date    default null,
  p_note         text    default null,
  p_create_task  boolean  default true
) returns integer
language plpgsql set search_path = public as $$
declare
  v_rep public.reps%rowtype;
  v_n   integer := 0;
  v_t   integer;
  v_o   integer;
  c     record;
begin
  select * into v_rep from public.reps where username = p_rep and active;
  if not found then
    raise exception 'rep_not_found_or_inactive: %', p_rep;
  end if;

  for c in
    select id, name, assigned_to
      from public.customers
     where id = any(p_customer_ids) and merged_into_id is null
     for update
  loop
    continue when c.assigned_to is not distinct from v_rep.username;
    v_t := 0; v_o := 0;

    update public.customers
       set assigned_to         = v_rep.username,
           assigned_rep        = v_rep.display_name,
           assigned_at         = now(),
           assigned_by         = p_by,
           next_follow_up_date = coalesce(p_follow_up, next_follow_up_date),
           updated_at          = now()
     where id = c.id;

    if c.assigned_to is not null then
      update public.tasks
         set assignee_username = v_rep.username, assignee_kind = 'rep'
       where customer_id = c.id and assignee_kind = 'rep' and assignee_username = c.assigned_to
         and status in ('open','in_progress');
      get diagnostics v_t = row_count;
      update public.opportunities
         set sales_person = v_rep.display_name, updated_at = now()
       where customer_id = c.id and stage not in ('won','lost');
      get diagnostics v_o = row_count;
    end if;

    insert into public.audit_log
      (actor, actor_role, action_type, entity_type, entity_id, entity_label, old_value, new_value)
    values
      (p_by, p_by_role, case when c.assigned_to is null then 'assign_customer' else 'transfer_customer' end,
       'customer', c.id, c.name,
       jsonb_build_object('assigned_to', c.assigned_to),
       jsonb_build_object('assigned_to', v_rep.username, 'note', p_note, 'moved_tasks', v_t, 'moved_opportunities', v_o));

    if p_create_task and c.assigned_to is null then
      insert into public.tasks
        (title, description, task_type, assignee_username, assignee_kind,
         assigned_by, customer_id, due_at)
      values
        ('التواصل مع العميل: ' || coalesce(c.name, '#' || c.id), p_note, 'call',
         v_rep.username, 'rep', p_by, c.id,
         coalesce(p_follow_up::timestamptz, now() + interval '1 day'));
    end if;

    v_n := v_n + 1;
  end loop;

  return v_n;
end $$;

revoke all on function public.assign_customers(bigint[], text, text, text, date, text, boolean) from public, anon, authenticated;
grant execute on function public.assign_customers(bigint[], text, text, text, date, text, boolean) to service_role;
