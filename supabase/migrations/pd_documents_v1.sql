-- pd_documents_v1.sql
-- صفحة PD (Projects Documents): جدول المستندات الصادرة. إضافي فقط (expand-only).
--
-- المبدأ: PD تقرأ من الـCRM ولا تعدّل فيه. كل ما يُصدر يُحفظ هنا كلقطة مجمّدة (snapshot)،
-- فتعديل اسم العميل أو السعر في الـCRM لاحقاً لا يغيّر مستنداً صدر.
-- الجدول بلا سياسات RLS ومسحوب منه anon/authenticated: الوصول فقط عبر Edge Function (docs-api)
-- بمفتاح service_role وبعد التحقق من توكن الأدمن.
-- لا تضف هذا الجدول إلى change_journal: اللقطة تحوي هوية العميل.

begin;

create table if not exists public.pd_documents (
  id               bigint generated always as identity primary key,
  doc_type         text   not null default 'contract',
  doc_no           text   not null,
  status           text   not null default 'issued',
  customer_id      bigint references public.customers(id)     on delete restrict,
  opportunity_id   bigint references public.opportunities(id) on delete set null,
  project_id       bigint references public.projects(id)      on delete set null,
  quote_id         bigint references public.quotes(id)        on delete set null,
  template_key     text   not null,
  template_version text   not null,
  snapshot         jsonb  not null,
  snapshot_hash    text   not null,
  issued_by        text,
  issued_at        timestamptz not null default now(),
  signed_on        date,
  signed_note      text,
  void_reason      text,
  voided_at        timestamptz,
  constraint pd_documents_doc_no_uq unique (doc_no),
  constraint pd_documents_type_chk
    check (doc_type in ('contract','site_handover','commissioning','variation_order','payment_notice','waiver')),
  constraint pd_documents_status_chk
    check (status in ('issued','signed','void')),
  constraint pd_documents_signed_chk
    check (status <> 'signed' or signed_on is not null),
  constraint pd_documents_void_chk
    check (status <> 'void' or void_reason is not null)
);

comment on table public.pd_documents is
  'مستندات المشاريع الصادرة (عقود وغيرها) كلقطات مجمّدة. تحوي بيانات شخصية: وصول عبر docs-api فقط (أدمن).';

create index if not exists pd_documents_customer_idx    on public.pd_documents (customer_id, issued_at desc);
create index if not exists pd_documents_opportunity_idx on public.pd_documents (opportunity_id);

-- منع تعديل اللقطة بعد الإصدار (يُسمح فقط بتغيير الحالة وملاحظاتها).
create or replace function public.pd_documents_freeze()
returns trigger language plpgsql as $$
begin
  if new.snapshot is distinct from old.snapshot
     or new.snapshot_hash is distinct from old.snapshot_hash
     or new.doc_no is distinct from old.doc_no
     or new.doc_type is distinct from old.doc_type
     or new.template_version is distinct from old.template_version then
    raise exception 'pd_documents: الحقول المجمّدة لا تُعدَّل بعد الإصدار (أصدر مستنداً جديداً)';
  end if;
  return new;
end $$;

drop trigger if exists pd_documents_freeze_trg on public.pd_documents;
create trigger pd_documents_freeze_trg
  before update on public.pd_documents
  for each row execute function public.pd_documents_freeze();

alter table public.pd_documents enable row level security;   -- بلا سياسات = لا وصول مباشر
revoke all on public.pd_documents from anon, authenticated;

commit;

-- ============================ الرجوع عنه (rollback) ============================
-- begin;
--   drop trigger if exists pd_documents_freeze_trg on public.pd_documents;
--   drop function if exists public.pd_documents_freeze();
--   drop table if exists public.pd_documents;
-- commit;
