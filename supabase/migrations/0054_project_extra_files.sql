-- 0054: مستندات موافقة العميل على الأعمال الإضافية (صورة / PDF). إضافة بحتة.
-- نفس الـ bucket الخاص supplier-bill-files (المسارات بتبدأ بـ extra-<id>/) والوصول بس عن طريق finance-attachments.
-- من غير FOREIGN KEY عن قصد (إلغاء الأعمال الإضافية يفضل شغال زي ما هو).
create table if not exists public.project_extra_files (
  id           bigint generated always as identity primary key,
  extra_id     bigint not null,
  storage_path text   not null unique,
  file_name    text   not null,
  mime_type    text   not null,
  size_bytes   integer not null check (size_bytes > 0),
  created_at   timestamptz not null default now()
);
create index if not exists project_extra_files_extra_idx on public.project_extra_files (extra_id);
alter table public.project_extra_files enable row level security;
