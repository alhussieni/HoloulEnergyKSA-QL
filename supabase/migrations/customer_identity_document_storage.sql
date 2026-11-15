-- مُطبّق بالفعل على HoloulEnergyQL (customer_identity_document_storage). للتوثيق فقط.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('customer-id-docs', 'customer-id-docs', false, 5242880,
        array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

alter table public.customer_identity
  add column if not exists doc_path text,
  add column if not exists doc_mime text,
  add column if not exists doc_size integer,
  add column if not exists doc_uploaded_by text,
  add column if not exists doc_uploaded_at timestamptz;
