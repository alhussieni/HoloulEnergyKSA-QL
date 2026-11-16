-- 0057: يضيف حالة المشروع «تم التشغيل والتسليم» (handed_over). تتطبّق عند إطلاق الشاشة فقط
-- لأنها بتظهر فورًا في قوائم الحالات. هي الحالة اللي بيحرسها فحص التشغيل والتسليم لما يكون إلزاميًا.
update public.crm_settings
   set data = jsonb_set(data, '{projectStatuses}', (data->'projectStatuses') || '[{"value":"handed_over","label":"تم التشغيل والتسليم","color":"#1e8e5a"}]'::jsonb)
 where not exists (select 1 from jsonb_array_elements(data->'projectStatuses') x where x->>'value' = 'handed_over');
