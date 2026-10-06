-- 0023: customer/system size segments (small / medium / large / mega) by HP.
-- Already applied on production as migration "add_customer_segments".

create table if not exists public.segment_config (
  id integer primary key default 1 check (id = 1),
  small_max numeric not null default 15,
  medium_max numeric not null default 250,
  large_max numeric not null default 800,
  updated_at timestamptz not null default now(),
  check (small_max > 0 and small_max < medium_max and medium_max < large_max)
);
alter table public.segment_config enable row level security;
insert into public.segment_config (id) values (1) on conflict (id) do nothing;

create or replace function public.hp_segment(p_hp numeric) returns text
language sql stable security definer set search_path = public as $$
  select case
    when p_hp is null or p_hp <= 0 then null
    when p_hp <= c.small_max  then 'small'
    when p_hp <= c.medium_max then 'medium'
    when p_hp <= c.large_max  then 'large'
    else 'mega' end
  from public.segment_config c where c.id = 1;
$$;

alter table public.quotes        add column if not exists segment text;
alter table public.quotations    add column if not exists segment text;
alter table public.opportunities add column if not exists segment text;

create or replace function public.trg_quotes_set_segment() returns trigger
language plpgsql security definer set search_path = public as $$
begin new.segment := public.hp_segment(new.hp); return new; end $$;

create or replace function public.trg_quotations_set_segment() returns trigger
language plpgsql security definer set search_path = public as $$
begin new.segment := public.hp_segment(new.pump_hp); return new; end $$;

create or replace function public.trg_opportunities_set_segment() returns trigger
language plpgsql security definer set search_path = public as $$
declare v numeric;
begin
  begin v := nullif(regexp_replace(coalesce(new.estimated_capacity,''), '[^0-9.]', '', 'g'), '')::numeric;
  exception when others then v := null; end;
  new.segment := public.hp_segment(v);
  return new;
end $$;

drop trigger if exists trg_quotes_set_segment on public.quotes;
create trigger trg_quotes_set_segment before insert or update of hp on public.quotes
  for each row execute function public.trg_quotes_set_segment();
drop trigger if exists trg_quotations_set_segment on public.quotations;
create trigger trg_quotations_set_segment before insert or update of pump_hp on public.quotations
  for each row execute function public.trg_quotations_set_segment();
drop trigger if exists trg_opportunities_set_segment on public.opportunities;
create trigger trg_opportunities_set_segment before insert or update of estimated_capacity on public.opportunities
  for each row execute function public.trg_opportunities_set_segment();

update public.quotes set segment = public.hp_segment(hp) where segment is distinct from public.hp_segment(hp);
update public.opportunities set segment = (
  select public.hp_segment(nullif(regexp_replace(coalesce(o.estimated_capacity,''), '[^0-9.]', '', 'g'), '')::numeric)
  from public.opportunities o where o.id = opportunities.id);

create index if not exists quotes_segment_idx on public.quotes(segment);

-- New quote in large/mega bumps the customer to 'hot' (never downgrades).
create or replace function public.trg_quotes_bump_customer_priority() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.customer_id is not null and new.segment in ('large','mega') then
    update public.customers set priority = 'hot', updated_at = now()
    where id = new.customer_id and coalesce(priority,'') <> 'hot';
  end if;
  return new;
end $$;
drop trigger if exists trg_quotes_bump_priority on public.quotes;
create trigger trg_quotes_bump_priority after insert on public.quotes
  for each row execute function public.trg_quotes_bump_customer_priority();

create or replace view public.v_segment_report with (security_invoker = true) as
select
  coalesce(q.segment, 'unclassified') as segment,
  count(*) as quotes_count,
  count(distinct q.customer_id) as customers_count,
  round(avg(q.final_total)) as avg_quote_value,
  round(sum(q.final_total)) as total_quoted_value,
  round(avg(q.final_total / nullif(q.hp,0))) as avg_price_per_hp,
  count(distinct q.customer_id) filter (where c.status = 'won') as won_customers,
  count(distinct q.customer_id) filter (where c.status = 'lost') as lost_customers,
  count(distinct q.customer_id) filter (where c.status = 'negotiating') as negotiating_customers,
  round(100.0 * count(distinct q.customer_id) filter (where c.status = 'won')
        / nullif(count(distinct q.customer_id),0), 1) as win_rate_pct
from public.quotes q
left join public.customers c on c.id = q.customer_id
group by 1
order by array_position(array['small','medium','large','mega','unclassified'], coalesce(q.segment,'unclassified'));
