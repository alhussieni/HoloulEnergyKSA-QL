-- 0043_change_journal.sql
-- سجل تغييرات كامل (صورة الصف قبل/بعد) للجداول التشغيلية + دوال الرجوع عن آخر 6 عمليات (للأدمن فقط عبر دالة admin-undo).
--
-- التصميم:
--  * trigger بعد كل INSERT/UPDATE/DELETE على الجداول المذكورة بيسجّل الصف كامل في change_journal.
--    "العملية" = كل التغييرات اللي حصلت في نفس الـ transaction (بما فيها اللي بتعملها الـ triggers التانية).
--  * الـ trigger ما بيوقّفش أي عملية تجارية أبدًا: أي خطأ فيه بيتحوّل لتحذير فقط.
--  * الرجوع من الأحدث للأقدم، ومحصور في آخر 6 عمليات، وفي transaction واحدة (يا كله يا ولا حاجة).
--  * قبل الرجوع بيتأكد إن الصف لسه زي ما سجّلته العملية (لو اتغيّر بعدها يرفض بدل ما يكتب فوق شغل أحدث).
--  * مستبعد عمدًا: الفواتير الإلكترونية وعدّاداتها وشهادات الضمان (امتثال)، بيانات دخول الأدمن/المناديب، المنتجات والتسعير، جدول quotes.

create table if not exists public.change_journal (
  id           bigserial primary key,
  txid         bigint      not null,
  op           text        not null check (op in ('INSERT','UPDATE','DELETE')),
  tbl          text        not null,
  row_id       bigint      not null,
  old_row      jsonb,
  new_row      jsonb,
  undo_of_txid bigint,
  created_at   timestamptz not null default now()
);
create index if not exists change_journal_txid_idx    on public.change_journal (txid);
create index if not exists change_journal_undo_idx    on public.change_journal (undo_of_txid) where undo_of_txid is not null;
create index if not exists change_journal_created_idx on public.change_journal (created_at);

alter table public.change_journal enable row level security;   -- من غير policies = مقفول على anon/authenticated، والـ service role بس
revoke all on public.change_journal from anon, authenticated;
revoke all on sequence public.change_journal_id_seq from anon, authenticated;

-- ---------- trigger function ----------
create or replace function public.journal_row_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_old jsonb; v_new jsonb; v_id bigint; v_undo bigint;
begin
  begin
    if tg_op = 'DELETE' then
      v_old := to_jsonb(old); v_id := (v_old->>'id')::bigint;
    elsif tg_op = 'INSERT' then
      v_new := to_jsonb(new); v_id := (v_new->>'id')::bigint;
    else
      v_old := to_jsonb(old); v_new := to_jsonb(new);
      if v_old = v_new then return null; end if;                -- تحديث ما غيّرش حاجة
      v_id := (v_new->>'id')::bigint;
    end if;
    begin v_undo := nullif(current_setting('app.undo_of_txid', true), '')::bigint;
    exception when others then v_undo := null; end;
    insert into public.change_journal (txid, op, tbl, row_id, old_row, new_row, undo_of_txid)
    values (txid_current(), tg_op, tg_table_name, v_id, v_old, v_new, v_undo);
  exception when others then
    raise warning 'journal_row_change skipped (%): %', tg_table_name, sqlerrm;   -- السجل ما يوقّفش الشغل أبدًا
  end;
  return null;
end $$;

-- ---------- attach to business tables ----------
do $$
declare t text;
begin
  foreach t in array array[
    'customers','contacts','sites','opportunities','activities','crm_interactions',
    'projects','project_costs','payments','payment_milestones','project_discounts',
    'assets','maintenance_contracts','service_tickets','site_surveys','technical_studies','quotations',
    'expenses','recurring_expenses','partners','partner_shares','partner_distributions',
    'suppliers','supplier_bills','supplier_payment_allocations','purchase_orders','rfqs','rfq_items',
    'treasury_accounts','treasury_entries'
  ] loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('drop trigger if exists trg_journal on public.%I', t);
      execute format('create trigger trg_journal after insert or update or delete on public.%I for each row execute function public.journal_row_change()', t);
    end if;
  end loop;
end $$;

-- ---------- helpers ----------
create or replace function public.journal_brief(r jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
  from jsonb_each(coalesce(r, '{}'::jsonb)) e(k, v)
  where k = any (array['name','title','project_number','customer_name','phone','amount','contract_value','status','stage',
                       'cost_type','description','payment_date','cost_date','bill_number','supplier_id','project_id','entry_type','account_id'])
    and jsonb_typeof(v) <> 'null'
$$;

-- آخر 6 عمليات (غير الرجوعات) مع علامة: undone (اتراجع عنها) و undoable (دي اللي الرجوع هيشتغل عليها)
create or replace function public.journal_recent_operations(p_limit int default 6) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  delete from public.change_journal where created_at < now() - interval '60 days';
  with ops as (
    select txid, max(id) mx, min(created_at) as first_at
    from public.change_journal where undo_of_txid is null
    group by txid order by max(id) desc limit least(greatest(coalesce(p_limit, 6), 1), 6)
  ), flagged as (
    select o.*, exists (select 1 from public.change_journal u where u.undo_of_txid = o.txid) as undone from ops o
  ), first_open as (
    select txid from flagged where not undone order by mx desc limit 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'txid', f.txid, 'at', f.first_at, 'undone', f.undone,
      'undoable', f.txid = (select txid from first_open),
      'changes', (select jsonb_agg(jsonb_build_object('tbl', j.tbl, 'op', j.op, 'row_id', j.row_id,
                                                      'brief', public.journal_brief(coalesce(j.new_row, j.old_row))) order by j.id)
                  from public.change_journal j where j.txid = f.txid and j.undo_of_txid is null)
    ) order by f.mx desc), '[]'::jsonb)
  into v from flagged f;
  return v;
end $$;

-- الرجوع عن آخر عملية متاحة (من الأحدث للأقدم، داخل آخر 6 فقط). p_expected_txid = العملية اللي الأدمن شافها على الشاشة.
create or replace function public.journal_undo_last(p_expected_txid bigint default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tx bigint; r record; cur jsonb; v_cnt int := 0; v_sets text; v_tables text[] := '{}';
begin
  perform pg_advisory_xact_lock(704301);

  with ops as (
    select txid, max(id) mx from public.change_journal where undo_of_txid is null group by txid order by max(id) desc limit 6
  )
  select o.txid into v_tx from ops o
  where not exists (select 1 from public.change_journal u where u.undo_of_txid = o.txid)
  order by o.mx desc limit 1;

  if v_tx is null then
    return jsonb_build_object('ok', false, 'error', 'مفيش عمليات متاحة للرجوع عنها (الحد آخر 6 عمليات)');
  end if;
  if p_expected_txid is not null and p_expected_txid <> v_tx then
    return jsonb_build_object('ok', false, 'error', 'القايمة اتغيّرت من وقت ما فتحتها — حدّثها وجرّب تاني');
  end if;

  perform set_config('app.undo_of_txid', v_tx::text, true);   -- أي كتابة جاية بتتسجّل كـ "رجوع" مش عملية جديدة

  for r in select * from public.change_journal where txid = v_tx and undo_of_txid is null order by id desc loop
    if to_regclass(format('public.%I', r.tbl)) is null then
      raise exception 'تعذر الرجوع: الجدول % غير موجود', r.tbl;
    end if;

    if r.op = 'INSERT' then
      execute format('select to_jsonb(t) from public.%I t where t.id = $1', r.tbl) into cur using r.row_id;
      if cur is null then raise exception 'تعذر الرجوع: السجل (% #%) اتمسح بعد العملية دي', r.tbl, r.row_id; end if;
      if cur is distinct from r.new_row then raise exception 'تعذر الرجوع: السجل (% #%) اتعدّل بعد العملية دي', r.tbl, r.row_id; end if;
      execute format('delete from public.%I where id = $1', r.tbl) using r.row_id;

    elsif r.op = 'DELETE' then
      execute format('select to_jsonb(t) from public.%I t where t.id = $1', r.tbl) into cur using r.row_id;
      if cur is not null then raise exception 'تعذر الرجوع: السجل (% #%) موجود بالفعل', r.tbl, r.row_id; end if;
      execute format('insert into public.%I overriding system value select * from jsonb_populate_record(null::public.%I, $1)', r.tbl, r.tbl) using r.old_row;

    else -- UPDATE
      execute format('select to_jsonb(t) from public.%I t where t.id = $1', r.tbl) into cur using r.row_id;
      if cur is null then raise exception 'تعذر الرجوع: السجل (% #%) اتمسح بعد العملية دي', r.tbl, r.row_id; end if;
      if cur is distinct from r.new_row then raise exception 'تعذر الرجوع: السجل (% #%) اتعدّل بعد العملية دي', r.tbl, r.row_id; end if;
      select string_agg(format('%I = r.%I', k, k), ', ') into v_sets from jsonb_object_keys(r.old_row) k where k <> 'id';
      execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I, $1) r where t.id = $2', r.tbl, v_sets, r.tbl)
        using r.old_row, r.row_id;
    end if;

    v_cnt := v_cnt + 1;
    if not (r.tbl = any (v_tables)) then v_tables := v_tables || r.tbl; end if;
  end loop;

  return jsonb_build_object('ok', true, 'undone_txid', v_tx, 'rows', v_cnt, 'tables', to_jsonb(v_tables));
end $$;

-- التنفيذ لـ service_role فقط (دالة admin-undo بعد التحقق من توكن الأدمن)
revoke execute on function public.journal_row_change()            from public, anon, authenticated;
revoke execute on function public.journal_recent_operations(int)  from public, anon, authenticated;
revoke execute on function public.journal_undo_last(bigint)       from public, anon, authenticated;
grant  execute on function public.journal_recent_operations(int)  to service_role;
grant  execute on function public.journal_undo_last(bigint)       to service_role;
