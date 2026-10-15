-- 0019_warranty_enforce_assets.sql  (STEP 2 — run after 0018 and after a successful test invoice + certificate)
--
-- From now on a NEW asset cannot carry warranty data unless it was created by
-- issue_warranty_certificates() (i.e. from a paid + approved invoice).
-- Existing assets stay is_legacy = true and remain editable exactly as before.
-- (Dry-run tested: manual warranty insert is rejected; an asset without warranty data is still allowed.)

alter table public.assets alter column is_legacy set default false;

create or replace function public.assets_warranty_insert_guard() returns trigger language plpgsql set search_path to 'public' as $fn$
begin
  if coalesce(new.is_legacy, false) = false
     and coalesce(current_setting('app.warranty_issuing', true), '') <> 'on'
     and (new.warranty_number is not null or new.warranty_start_date is not null
          or new.warranty_end_date is not null or coalesce(new.warranty_years, 0) > 0
          or coalesce(new.performance_warranty_years, 0) > 0) then
    raise exception 'لا يمكن إضافة ضمان لأصل يدويًا — الضمان بيتصدر بس من فاتورة مسددة ومعتمدة (شاشة الفواتير ← 🛡️ الضمان)';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_assets_warranty_insert_guard on public.assets;
create trigger trg_assets_warranty_insert_guard before insert on public.assets
  for each row execute function public.assets_warranty_insert_guard();
