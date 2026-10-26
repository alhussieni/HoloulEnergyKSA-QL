-- 0035: ربط بنود خطة السداد (payment_milestones) بالدفعات الفعلية (payments) بدون تكرار.
--  * اتسددت  -> بتتربط بدفعة موجودة بنفس المبلغ، أو بتتسجل دفعة ناقصة فقط (auto_created) لو مفيش.
--  * إضافة دفعة (من المشروع أو الخزنة) بمبلغ بند مستحق -> البند بيتقفل تلقائيًا.
--  * الرجوع من "اتسددت" -> الدفعة التلقائية بتتحذف (لو مش مربوطة بحساب خزنة)، والمسجّلة يدويًا بتفضل.
--  * الخزنة: تحصيل بنفس مبلغ دفعة تلقائية بيتبنّاها بدل ما يكرّرها.

alter table public.payments
  add column if not exists milestone_id bigint references public.payment_milestones(id) on delete set null,
  add column if not exists auto_created boolean not null default false;
create unique index if not exists uq_payments_milestone_id on public.payments(milestone_id) where milestone_id is not null;

-- ---------- ربط البيانات القديمة (بدون إنشاء أي دفعة جديدة) ----------
do $$
declare m record; v_pay bigint;
begin
  for m in select id, project_id, amount from public.payment_milestones
           where status = 'paid' and amount is not null order by project_id, due_date nulls last, id loop
    select p.id into v_pay from public.payments p
     where p.project_id = m.project_id and p.milestone_id is null and abs(p.amount - m.amount) < 0.005
     order by p.payment_date, p.id limit 1;
    if v_pay is not null then update public.payments set milestone_id = m.id where id = v_pay; end if;
  end loop;
end $$;

-- ---------- تغيير حالة البند ----------
create or replace function public.trg_milestone_paid_sync() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_pay bigint; v_avail numeric; v_short numeric;
begin
  if coalesce(current_setting('app.skip_ms_sync', true), '') = '1' then return new; end if;
  if new.status is not distinct from old.status then return new; end if;

  if new.status = 'paid' then
    if exists (select 1 from payments where milestone_id = new.id) then return new; end if;
    if coalesce(new.amount, 0) <= 0 then return new; end if;
    -- 1) دفعة موجودة بنفس المبلغ -> نربطها ومنكرّرهاش
    select id into v_pay from payments
     where project_id = new.project_id and milestone_id is null and abs(amount - new.amount) < 0.005
     order by payment_date, id limit 1 for update;
    if v_pay is not null then
      update payments set milestone_id = new.id where id = v_pay;
      return new;
    end if;
    -- 2) المحصّل غير المخصّص يغطي البند؟ (بعد خصم بنود تانية مسددة وغير مربوطة)
    select coalesce(sum(amount), 0) into v_avail from payments where project_id = new.project_id and milestone_id is null;
    v_avail := v_avail - coalesce((select sum(m.amount) from payment_milestones m
        where m.project_id = new.project_id and m.id <> new.id and m.status = 'paid'
          and not exists (select 1 from payments x where x.milestone_id = m.id)), 0);
    v_short := new.amount - greatest(v_avail, 0);
    if v_short > 0.005 then
      insert into payments (project_id, amount, payment_date, notes, milestone_id, auto_created)
      values (new.project_id, round(v_short, 2), current_date, 'تلقائي من خطة السداد: ' || coalesce(new.title, ''), new.id, true);
    end if;

  elsif old.status = 'paid' then
    delete from payments p where p.milestone_id = new.id and p.auto_created
       and not exists (select 1 from treasury_entries e where e.payment_id = p.id);
    update payments set milestone_id = null where milestone_id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists trg_milestone_paid_sync on public.payment_milestones;
create trigger trg_milestone_paid_sync before update of status on public.payment_milestones
  for each row execute function public.trg_milestone_paid_sync();

-- ---------- إضافة دفعة جديدة -> قفل البند المطابق ----------
create or replace function public.trg_payment_match_milestone() returns trigger
language plpgsql security definer set search_path to 'public' as $$
declare v_m bigint;
begin
  if new.milestone_id is not null then return new; end if;
  select m.id into v_m from payment_milestones m
   where m.project_id = new.project_id and m.status <> 'paid' and m.amount is not null
     and abs(m.amount - new.amount) < 0.005
     and not exists (select 1 from payments x where x.milestone_id = m.id)
   order by m.due_date nulls last, m.id limit 1 for update;
  if v_m is not null then
    new.milestone_id := v_m;
    perform set_config('app.skip_ms_sync', '1', true);
    update payment_milestones set status = 'paid', updated_at = now() where id = v_m;
    perform set_config('app.skip_ms_sync', '0', true);
  end if;
  return new;
end $$;

drop trigger if exists trg_payment_match_milestone on public.payments;
create trigger trg_payment_match_milestone before insert on public.payments
  for each row execute function public.trg_payment_match_milestone();

-- ---------- حذف دفعة -> البند يرجع مستحق ----------
create or replace function public.trg_payment_delete_milestone() returns trigger
language plpgsql security definer set search_path to 'public' as $$
begin
  if pg_trigger_depth() > 1 or old.milestone_id is null then return null; end if;
  perform set_config('app.skip_ms_sync', '1', true);
  update payment_milestones set status = 'pending', updated_at = now() where id = old.milestone_id and status = 'paid';
  perform set_config('app.skip_ms_sync', '0', true);
  return null;
end $$;

drop trigger if exists trg_payment_delete_milestone on public.payments;
create trigger trg_payment_delete_milestone after delete on public.payments
  for each row execute function public.trg_payment_delete_milestone();

-- ---------- الخزنة: تبنّي الدفعة التلقائية بدل تكرارها ----------
do $mig$
declare d text;
begin
  d := pg_get_functiondef('public.finance_record_entry(jsonb)'::regprocedure);
  if position('adopt_auto_payment' in d) = 0 then
    d := replace(d,
$old$    insert into payments (project_id, amount, payment_date, method, notes)
    values (v_project, v_amount, v_date, v_method, v_notes) returning id into v_payment;
$old$,
$new$    -- adopt_auto_payment: دفعة اتسجلت تلقائيًا من خطة السداد ولسه مش مربوطة بحساب -> نتبنّاها ومنكرّرهاش
    select p.id into v_payment from payments p
     where p.project_id = v_project and p.auto_created and abs(p.amount - v_amount) < 0.005
       and not exists (select 1 from treasury_entries e where e.payment_id = p.id)
     order by p.id limit 1 for update;
    if v_payment is not null then
      update payments set payment_date = v_date, method = coalesce(v_method, method),
             notes = coalesce(v_notes, notes), auto_created = false where id = v_payment;
    else
      insert into payments (project_id, amount, payment_date, method, notes)
      values (v_project, v_amount, v_date, v_method, v_notes) returning id into v_payment;
    end if;
$new$);
    if position('adopt_auto_payment' in d) = 0 then raise exception 'finance_record_entry pattern not found'; end if;
    execute d;
  end if;
end $mig$;
