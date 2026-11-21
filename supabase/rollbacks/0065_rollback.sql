-- يشيل فلتر المالك. (بعد التراجع لازم ترجّع crm-pipeline v1 كمان وإلا هيتكسر pipeline-alerts.)
create or replace function public.pipeline_filtered(p jsonb)
 returns setof v_pipeline_opps language sql stable as $function$
  select v.* from public.v_pipeline_opps v
  where (nullif(p->>'rep','') is null or v.rep_norm = p->>'rep')
    and (nullif(p->>'segment','') is null or v.segment = p->>'segment')
    and (nullif(p->>'type','') is null or v.project_type = p->>'type')
    and (not coalesce((p->>'overdue')::boolean,false) or v.is_overdue)
    and (not coalesce((p->>'stale')::boolean,false) or v.is_stale)
    and (nullif(btrim(coalesce(p->>'search','')),'') is null or
         (coalesce(v.name,'')||' '||coalesce(v.customer_name,'')||' '||coalesce(v.customer_phone,'')||' '||coalesce(v.site_name,'')||' '||coalesce(v.next_action,''))
         ilike '%'||replace(replace(btrim(p->>'search'),'%','\%'),'_','\_')||'%')
$function$;
