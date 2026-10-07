-- 0025: server-side pipeline (board / table / alerts). Already applied on production
-- as migration "pipeline_server_side". Called only by the crm-pipeline Edge Function (service role).

create or replace function public.stage_default_prob(p_stage text) returns numeric
language sql immutable as $$
  select case p_stage
    when 'new_lead' then 10 when 'qualified' then 20 when 'initial_contact' then 20
    when 'survey_required' then 30 when 'survey_completed' then 40 when 'technical_study' then 50
    when 'quotation_sent' then 60 when 'negotiation' then 75 when 'final_approval' then 90
    when 'follow_up_later' then 10 when 'won' then 100 else 0 end
$$;

create or replace view public.v_pipeline_opps with (security_invoker = true) as
select
  o.id, o.name, o.stage, o.estimated_value, o.probability,
  coalesce(o.probability, public.stage_default_prob(o.stage)) as prob_eff,
  coalesce(o.estimated_value,0) * coalesce(o.probability, public.stage_default_prob(o.stage)) / 100 as weighted_value,
  o.project_type, o.segment, o.sales_person,
  regexp_replace(btrim(coalesce(o.sales_person,'')), '\s+', ' ', 'g') as rep_norm,
  o.next_action, o.next_follow_up_date,
  coalesce(o.stage_changed_at, o.created_at) as stage_changed_at,
  o.created_at, o.customer_id,
  c.name as customer_name, c.phone as customer_phone, s.name as site_name,
  (o.stage not in ('won','lost')) as is_open,
  (o.stage not in ('won','lost') and o.next_follow_up_date is not null
     and o.next_follow_up_date < (now() at time zone 'Asia/Riyadh')::date) as is_overdue,
  (o.stage not in ('won','lost') and coalesce(o.stage_changed_at, o.created_at) < now() - interval '14 days') as is_stale,
  greatest(0, ((now() at time zone 'Asia/Riyadh')::date - coalesce(o.stage_changed_at, o.created_at)::date)) as days_in_stage
from public.opportunities o
left join public.customers c on c.id = o.customer_id
left join public.sites s on s.id = o.site_id;

create or replace function public.pipeline_filtered(p jsonb) returns setof public.v_pipeline_opps
language sql stable as $$
  select v.* from public.v_pipeline_opps v
  where (nullif(p->>'rep','') is null or v.rep_norm = p->>'rep')
    and (nullif(p->>'segment','') is null or v.segment = p->>'segment')
    and (nullif(p->>'type','') is null or v.project_type = p->>'type')
    and (not coalesce((p->>'overdue')::boolean,false) or v.is_overdue)
    and (not coalesce((p->>'stale')::boolean,false) or v.is_stale)
    and (nullif(btrim(coalesce(p->>'search','')),'') is null or
         (coalesce(v.name,'')||' '||coalesce(v.customer_name,'')||' '||coalesce(v.customer_phone,'')||' '||coalesce(v.site_name,'')||' '||coalesce(v.next_action,''))
         ilike '%'||replace(replace(btrim(p->>'search'),'%','\%'),'_','\_')||'%')
$$;

create or replace function public.pipeline_card(j jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'id',j->'id','name',j->'name','stage',j->'stage','estimated_value',j->'estimated_value','prob_eff',j->'prob_eff',
    'project_type',j->'project_type','segment',j->'segment','sales_person',j->'sales_person',
    'next_action',j->'next_action','next_follow_up_date',j->'next_follow_up_date',
    'days_in_stage',j->'days_in_stage','is_overdue',j->'is_overdue','is_stale',j->'is_stale',
    'customer_name',j->'customer_name','customer_phone',j->'customer_phone','site_name',j->'site_name')
$$;

create or replace function public.pipeline_board(p jsonb, p_per_stage int default 12, p_expand text[] default '{}')
returns jsonb language sql stable as $$
  with f as (select * from public.pipeline_filtered(p)),
  stats as (
    select stage, count(*) n, coalesce(sum(estimated_value),0) total, coalesce(sum(weighted_value),0) weighted
    from f group by stage),
  ranked as (
    select f.*, row_number() over (partition by f.stage
      order by f.is_overdue desc, f.estimated_value desc nulls last, f.stage_changed_at desc, f.id) rn
    from f where f.is_open or f.stage = any(p_expand))
  select jsonb_build_object(
    'stages', coalesce((select jsonb_object_agg(stage, jsonb_build_object('count',n,'total',total,'weighted',round(weighted))) from stats), '{}'::jsonb),
    'cards',  coalesce((select jsonb_agg(public.pipeline_card(to_jsonb(r)) order by r.stage, r.rn) from ranked r where r.rn <= p_per_stage), '[]'::jsonb),
    'totals', jsonb_build_object(
        'count', (select count(*) from f),
        'open_count', (select count(*) from f where is_open),
        'open_value', (select coalesce(sum(estimated_value),0) from f where is_open),
        'open_weighted', (select round(coalesce(sum(weighted_value),0)) from f where is_open)),
    'all_open_weighted', (select round(coalesce(sum(weighted_value),0)) from public.v_pipeline_opps where is_open),
    'all_count', (select count(*) from public.v_pipeline_opps)
  )
$$;

create or replace function public.pipeline_stage_page(p jsonb, p_stage text, p_offset int, p_limit int)
returns jsonb language sql stable as $$
  select jsonb_build_object('cards', coalesce(jsonb_agg(public.pipeline_card(to_jsonb(t)) order by t.rn), '[]'::jsonb))
  from (
    select f.*, row_number() over (order by f.is_overdue desc, f.estimated_value desc nulls last, f.stage_changed_at desc, f.id) rn
    from public.pipeline_filtered(p) f where f.stage = p_stage
    order by rn
    offset greatest(p_offset,0) limit least(greatest(p_limit,1),200)
  ) t
$$;

create or replace function public.pipeline_table(p jsonb, p_sort text, p_dir text, p_offset int, p_limit int)
returns jsonb language plpgsql stable as $$
declare
  v_col text := case p_sort
    when 'name' then 'name' when 'customer_name' then 'customer_name' when 'estimated_value' then 'estimated_value'
    when 'prob_eff' then 'prob_eff' when 'next_follow_up_date' then 'next_follow_up_date'
    when 'days_in_stage' then 'days_in_stage' when 'sales_person' then 'sales_person'
    when 'segment' then 'segment' when 'stage' then 'stage' else 'stage_changed_at' end;
  v_dir text := case when lower(coalesce(p_dir,'')) = 'asc' then 'asc' else 'desc' end;
  v_rows jsonb; v_total bigint;
begin
  select count(*) into v_total from public.pipeline_filtered(p);
  execute format(
    'select coalesce(jsonb_agg(public.pipeline_card(to_jsonb(t)) order by t.rn), ''[]''::jsonb) from (
       select f.*, row_number() over (order by f.%I %s nulls last, f.id) rn
       from public.pipeline_filtered($1) f
       order by rn offset $2 limit $3) t',
    v_col, v_dir)
  into v_rows using p, greatest(p_offset,0), least(greatest(p_limit,1),200);
  return jsonb_build_object('rows', v_rows, 'total', v_total);
end $$;

create or replace function public.pipeline_alerts(p_rep text default null) returns jsonb
language sql stable as $$
  with base as (
    select * from public.v_pipeline_opps
    where is_open and (p_rep is null or rep_norm = p_rep)),
  today as (select (now() at time zone 'Asia/Riyadh')::date d)
  select jsonb_build_object(
    'overdue', (select count(*) from base where is_overdue),
    'stale',   (select count(*) from base where is_stale),
    'today',   (select count(*) from base, today where next_follow_up_date = today.d),
    'by_rep',  coalesce((select jsonb_agg(x order by (x->>'overdue')::int desc) from (
        select jsonb_build_object('rep', case when rep_norm='' then '(بدون مندوب)' else rep_norm end,
          'overdue', count(*) filter (where is_overdue),
          'stale', count(*) filter (where is_stale),
          'today', count(*) filter (where next_follow_up_date = (select d from today))) x
        from base group by rep_norm) s), '[]'::jsonb),
    'top_overdue', coalesce((select jsonb_agg(public.pipeline_card(to_jsonb(t)) order by t.next_follow_up_date) from (
        select * from base where is_overdue order by next_follow_up_date asc, estimated_value desc nulls last limit 8) t), '[]'::jsonb)
  )
$$;

revoke all on function public.pipeline_filtered(jsonb), public.pipeline_card(jsonb),
  public.pipeline_board(jsonb,int,text[]), public.pipeline_stage_page(jsonb,text,int,int),
  public.pipeline_table(jsonb,text,text,int,int), public.pipeline_alerts(text), public.stage_default_prob(text)
  from public, anon, authenticated;
grant execute on function public.pipeline_filtered(jsonb), public.pipeline_card(jsonb),
  public.pipeline_board(jsonb,int,text[]), public.pipeline_stage_page(jsonb,text,int,int),
  public.pipeline_table(jsonb,text,text,int,int), public.pipeline_alerts(text), public.stage_default_prob(text)
  to service_role;
revoke all on public.v_pipeline_opps from anon, authenticated;
