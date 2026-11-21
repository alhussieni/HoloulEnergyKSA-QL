-- 0062: نظام المهام + توزيع العملاء على المناديب.
-- • customers: assigned_to (username) + assigned_at + assigned_by (assigned_rep القديم بيفضل كما هو للتوافق).
-- • assignable_users: view موحّد للمناديب والموظفين (بدون password hash، مقفول على anon/authenticated).
-- • tasks: مهام الموظفين (RLS مفعّل بدون policies = service_role فقط عبر tasks-api).
-- • app_roles: صلاحيات tasks.own / tasks.assign / tasks.view_all.
-- • assign_customers() و distribute_customers() (round-robin بترتيب hot → warm → cold).
-- التراجع: supabase/rollbacks/0062_rollback.sql
-- (اتطبّقت بالفعل على Supabase باسم tasks_and_customer_assignment — لا تشغّلها تاني.)

alter table public.customers
  add column if not exists assigned_to  text,
  add column if not exists assigned_at  timestamptz,
  add column if not exists assigned_by  text;

alter table public.customers
  add constraint customers_assigned_to_fkey
  foreign key (assigned_to) references public.reps(username)
  on update cascade on delete set null;

create index if not exists customers_assigned_to_idx
  on public.customers (assigned_to) where assigned_to is not null;

-- Backfill: map the legacy display name -> username.
-- Rows with '' / NULL stay unassigned (decide manually, see notes).
update public.customers c
   set assigned_to = r.username
  from public.reps r
 where c.assigned_to is null
   and nullif(btrim(c.assigned_rep), '') = r.display_name;

-- ---------------------------------------------------------------------
-- 2) Assignable people (reps + staff) in one view, no password hashes.
--    security_invoker => base-table RLS applies; anon/authenticated get nothing.
-- ---------------------------------------------------------------------
create or replace view public.assignable_users
with (security_invoker = true) as
  select 'rep'::text   as kind, username, display_name, array['rep']::text[] as roles
    from public.reps where active
  union all
  select 'staff'::text as kind, username, display_name, roles
    from public.staff_accounts where active;

revoke all on public.assignable_users from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3) Tasks
-- ---------------------------------------------------------------------
create table if not exists public.tasks (
  id               bigint generated always as identity primary key,
  title            text not null check (length(btrim(title)) > 0),
  description      text,
  task_type        text not null default 'general'
                   check (task_type in ('general','call','visit','survey','quote',
                                        'follow_up','delivery','maintenance','other')),
  priority         text not null default 'normal'
                   check (priority in ('low','normal','high','urgent')),
  status           text not null default 'open'
                   check (status in ('open','in_progress','done','cancelled')),
  assignee_username text not null,
  assignee_kind    text not null check (assignee_kind in ('rep','staff')),
  assigned_by      text not null,
  customer_id      bigint references public.customers(id)       on delete set null,
  opportunity_id   bigint references public.opportunities(id)   on delete set null,
  project_id       bigint references public.projects(id)        on delete set null,
  service_ticket_id bigint references public.service_tickets(id) on delete set null,
  due_at           timestamptz,
  started_at       timestamptz,
  completed_at     timestamptz,
  completion_note  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists tasks_assignee_idx
  on public.tasks (assignee_username, status, due_at);
create index if not exists tasks_open_due_idx
  on public.tasks (due_at) where status in ('open','in_progress');
create index if not exists tasks_customer_idx
  on public.tasks (customer_id) where customer_id is not null;

alter table public.tasks enable row level security;   -- no policies: service_role only
revoke all on public.tasks from anon, authenticated;

-- validate assignee + maintain timestamps
create or replace function public.tasks_biu() returns trigger
language plpgsql set search_path = public as $$
begin
  if not exists (select 1 from public.assignable_users u
                  where u.username = new.assignee_username and u.kind = new.assignee_kind) then
    raise exception 'assignee_not_found_or_inactive: % (%)', new.assignee_username, new.assignee_kind;
  end if;
  new.updated_at := now();
  if tg_op = 'UPDATE' and new.status is distinct from old.status then
    if new.status = 'in_progress' and new.started_at is null then new.started_at := now(); end if;
    if new.status = 'done'        then new.completed_at := coalesce(new.completed_at, now()); end if;
    if new.status in ('open','in_progress','cancelled') and old.status = 'done' then
      new.completed_at := null;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_tasks_biu on public.tasks;
create trigger trg_tasks_biu before insert or update on public.tasks
  for each row execute function public.tasks_biu();

-- ---------------------------------------------------------------------
-- 4) Permissions in app_roles (admin is outside app_roles and has everything)
--    tasks.own       -> see/update my own tasks
--    tasks.assign    -> create/reassign tasks for others
--    tasks.view_all  -> team-wide task board
-- ---------------------------------------------------------------------
update public.app_roles
   set permissions = array_append(permissions, 'tasks.own')
 where not ('tasks.own' = any(permissions));

update public.app_roles
   set permissions = permissions || array['tasks.assign','tasks.view_all']
 where key in ('sales_manager','project_manager')
   and not ('tasks.assign' = any(permissions));

-- ---------------------------------------------------------------------
-- 5) Atomic bulk assignment (called from an Edge Function with service_role)
--    - sets assigned_to AND legacy assigned_rep (display name) so old UI stays consistent
--    - optional first follow-up date
--    - optional auto-task "call the customer" for the rep
--    - audit_log row per customer
-- ---------------------------------------------------------------------
create or replace function public.assign_customers(
  p_customer_ids bigint[],
  p_rep          text,
  p_by           text,
  p_by_role      text    default 'admin',
  p_follow_up    date    default null,
  p_note         text    default null,
  p_create_task  boolean default true
) returns integer
language plpgsql set search_path = public as $$
declare
  v_rep public.reps%rowtype;
  v_n   integer := 0;
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

    update public.customers
       set assigned_to         = v_rep.username,
           assigned_rep        = v_rep.display_name,
           assigned_at         = now(),
           assigned_by         = p_by,
           next_follow_up_date = coalesce(p_follow_up, next_follow_up_date),
           updated_at          = now()
     where id = c.id;

    insert into public.audit_log
      (actor, actor_role, action_type, entity_type, entity_id, entity_label, old_value, new_value)
    values
      (p_by, p_by_role, 'assign_customer', 'customer', c.id, c.name,
       jsonb_build_object('assigned_to', c.assigned_to),
       jsonb_build_object('assigned_to', v_rep.username, 'note', p_note));

    if p_create_task then
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

revoke all on function public.assign_customers(bigint[], text, text, text, date, text, boolean)
  from public, anon, authenticated;
grant execute on function public.assign_customers(bigint[], text, text, text, date, text, boolean)
  to service_role;

-- ---------------------------------------------------------------------
-- توزيع بالدور (round-robin) على مجموعة مناديب، العملاء مرتّبين hot ثم warm ثم cold
-- ---------------------------------------------------------------------
create or replace function public.distribute_customers(
  p_customer_ids bigint[],
  p_reps         text[],
  p_by           text,
  p_by_role      text    default 'admin',
  p_follow_up    date    default null,
  p_note         text    default null,
  p_create_task  boolean default true
) returns jsonb
language plpgsql set search_path = public as $$
declare
  v_n      integer;
  v_i      integer := 0;
  v_rep    text;
  v_result jsonb := '{}'::jsonb;
  c        record;
begin
  v_n := coalesce(array_length(p_reps, 1), 0);
  if v_n = 0 then
    raise exception 'no_reps_provided';
  end if;

  if exists (select 1 from unnest(p_reps) r
              where not exists (select 1 from public.reps x where x.username = r and x.active)) then
    raise exception 'rep_not_found_or_inactive';
  end if;

  for c in
    select id from public.customers
     where id = any(p_customer_ids) and merged_into_id is null
     order by case coalesce(priority,'warm') when 'hot' then 1 when 'warm' then 2 else 3 end,
              created_at desc
  loop
    v_rep := p_reps[(v_i % v_n) + 1];
    perform public.assign_customers(array[c.id], v_rep, p_by, p_by_role, p_follow_up, p_note, p_create_task);
    v_result := jsonb_set(v_result, array[v_rep],
                  to_jsonb(coalesce((v_result->>v_rep)::int, 0) + 1));
    v_i := v_i + 1;
  end loop;

  return v_result;
end $$;

revoke all on function public.distribute_customers(bigint[], text[], text, text, date, text, boolean)
  from public, anon, authenticated;
grant execute on function public.distribute_customers(bigint[], text[], text, text, date, text, boolean)
  to service_role;
