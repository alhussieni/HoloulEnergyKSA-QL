-- 0065: فلتر «مالك العميل» (customers.assigned_to) في لوحة الصفقات — بيتفرض من crm-pipeline على المندوب.
--   pipeline_filtered(p): مفتاح جديد p->>'owner'.    pipeline_alerts(p_rep, p_owner): بارامتر جديد.
-- التراجع: supabase/rollbacks/0065_rollback.sql
-- (اتطبّقت بالفعل على Supabase باسم pipeline_owner_scope + pipeline_filtered_fix_like_escape — لا تشغّلها تاني.)

create or replace function public.pipeline_filtered(p jsonb)
 returns setof v_pipeline_opps
 language sql stable
as $function$
  select v.* from public.v_pipeline_opps v
  where (nullif(p->>'rep','') is null or v.rep_norm = p->>'rep')
    and (nullif(p->>'owner','') is null or exists (
          select 1 from public.customers c where c.id = v.customer_id and c.assigned_to = p->>'owner'))
    and (nullif(p->>'segment','') is null or v.segment = p->>'segment')
    and (nullif(p->>'type','') is null or v.project_type = p->>'type')
    and (not coalesce((p->>'overdue')::boolean,false) or v.is_overdue)
    and (not coalesce((p->>'stale')::boolean,false) or v.is_stale)
    and (nullif(btrim(coalesce(p->>'search','')),'') is null or
         (coalesce(v.name,'')||' '||coalesce(v.customer_name,'')||' '||coalesce(v.customer_phone,'')||' '||coalesce(v.site_name,'')||' '||coalesce(v.next_action,''))
         ilike '%'||replace(replace(btrim(p->>'search'),'%','\%'),'_','\_')||'%')
$function$;

drop function if exists public.pipeline_alerts(text);
create or replace function public.pipeline_alerts(p_rep text default null, p_owner text default null)
 returns jsonb
 language sql stable
as $function$
  with base as (
    select * from public.v_pipeline_opps v
    where is_open and (p_rep is null or rep_norm = p_rep)
      and (p_owner is null or exists (select 1 from public.customers c where c.id = v.customer_id and c.assigned_to = p_owner))),
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
$function$;
revoke all on function public.pipeline_alerts(text, text) from public, anon, authenticated;
grant execute on function public.pipeline_alerts(text, text) to service_role;
