-- مرفقات فواتير الموردين (صور / PDF). إضافة بحتة: مفيش أي تعديل على جداول أو دوال موجودة.
-- الملفات في bucket خاص (private) والوصول بس عن طريق دالة finance-attachments (توكن أدمن + signed URL قصير).
-- مقصود: من غير FOREIGN KEY على supplier_bills عشان حذف فاتورة (أو الرجوع عن العملية) يفضل شغال زي ما هو.

create table if not exists public.supplier_bill_files (
  id           bigint generated always as identity primary key,
  bill_id      bigint not null,
  storage_path text   not null unique,
  file_name    text   not null,
  mime_type    text   not null,
  size_bytes   integer not null check (size_bytes > 0),
  created_at   timestamptz not null default now()
);
create index if not exists supplier_bill_files_bill_idx on public.supplier_bill_files (bill_id);

-- RLS شغال ومفيش policies = service-role بس (نفس باقي جداول المالية)
alter table public.supplier_bill_files enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('supplier-bill-files', 'supplier-bill-files', false, 8388608,
        array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;
