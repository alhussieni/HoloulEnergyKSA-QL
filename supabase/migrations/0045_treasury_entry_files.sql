-- مستندات حركات الخزنة (إيصال قبض من عميل / تحويل دفع لمورد / تحويل بين الحسابات / مصروف ...). إضافة بحتة.
-- نفس الـ bucket الخاص supplier-bill-files (المسارات بتبدأ بـ entry-<id>/). الوصول بس عن طريق دالة finance-attachments.
-- من غير FOREIGN KEY عن قصد (حذف حركة أو الرجوع عنها يفضل شغال زي ما هو).
-- التحويل بين الحسابات (transfer_group) والدفعة الموزّعة (payment_group) بيشاركوا نفس المستندات:
-- المالك هو أصغر id في المجموعة، والدالة هي اللي بتحلّ ده.

create table if not exists public.treasury_entry_files (
  id           bigint generated always as identity primary key,
  entry_id     bigint not null,
  storage_path text   not null unique,
  file_name    text   not null,
  mime_type    text   not null,
  size_bytes   integer not null check (size_bytes > 0),
  created_at   timestamptz not null default now()
);
create index if not exists treasury_entry_files_entry_idx on public.treasury_entry_files (entry_id);

-- RLS شغال ومفيش policies = service-role بس (نفس باقي جداول المالية)
alter table public.treasury_entry_files enable row level security;
