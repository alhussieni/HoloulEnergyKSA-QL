-- 0056: فحص التشغيل والتسليم لكل مشروع (إضافي بالكامل، مفيش تغيير على جداول موجودة).
-- project_commissioning: نموذج الفحص لكل مشروع (الحالة draft → submitted → approved). النموذج نفسه (الأقسام والقيم) في عمود state.
-- commissioning_settings: صف واحد؛ required=false افتراضيًا. لما الأدمن يفعّله بيتمنع تحويل المشروع لحالة «تم التسليم» (handed_over)
-- من غير فحص معتمد، والمنع على مستوى قاعدة البيانات بحيث ينطبق على أي شاشة أو API.
-- RLS شغال من غير policies = service-role بس (زي باقي جداول المالية).

create table if not exists public.project_commissioning (
  project_id   bigint primary key references public.projects(id) on delete cascade,
  scope_type   text,
  system_type  text,
  state        jsonb not null default '{}'::jsonb,
  status       text not null default 'draft' check (status in ('draft','submitted','approved')),
  ready        boolean not null default false,
  stops        jsonb not null default '[]'::jsonb,
  filled_by    text,
  submitted_at timestamptz,
  approved_at  timestamptz,
  approved_by  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create table if not exists public.commissioning_settings (
  id         int primary key check (id = 1),
  required   boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.commissioning_settings (id, required) values (1, false) on conflict (id) do nothing;

alter table public.project_commissioning enable row level security;
alter table public.commissioning_settings enable row level security;
revoke all on public.project_commissioning, public.commissioning_settings from anon, authenticated;

create or replace function public.enforce_commissioning_before_handover() returns trigger
language plpgsql as $$
begin
  if new.status = 'handed_over' and new.status is distinct from old.status then
    if coalesce((select required from public.commissioning_settings where id = 1), false)
       and not exists (select 1 from public.project_commissioning c where c.project_id = new.id and c.status = 'approved') then
      raise exception 'لا يمكن تسليم المشروع قبل اعتماد فحص التشغيل والتسليم (مفعّل كشرط إلزامي من الأدمن)';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_commissioning_before_handover on public.projects;
create trigger trg_commissioning_before_handover before update of status on public.projects
  for each row execute function public.enforce_commissioning_before_handover();
