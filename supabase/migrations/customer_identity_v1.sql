-- customer_identity_v1.sql
-- هيكلي فقط: لا يعدّل أي بيانات موجودة. إضافي (expand-only).
--
-- 1) جدول 1:1 لهوية العملاء الأفراد، خارج `customers` عمداً:
--    - crm-api (admin-crm-customer-detail) يعيد select(*) من customers لأي مندوب،
--      فوضع الهوية هناك يكشفها لكل المندوبين.
--    - change_journal يتتبع customers وينسخ الصف كاملاً (old_row/new_row).
--    هذا الجدول غير مربوط بـ change_journal، وبلا سياسات RLS، فالوصول فقط عبر
--    Edge Function بمفتاح service_role.
-- 2) قيود صيغة على السجل التجاري والرقم الضريبي والرقم الموحد في customers.
--    تم فحص الصفوف الحالية قبل إعداد الملف: السجلات المعبأة (1 CR، 1 VAT، 0 موحد)
--    كلها مطابقة، فلن يفشل أي UPDATE قائم (ومنه trigger عروض الأسعار).

begin;

create table if not exists public.customer_identity (
  customer_id bigint primary key references public.customers(id) on delete cascade,
  id_type     text   not null,
  id_number   text   not null,
  updated_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint customer_identity_type_chk
    check (id_type in ('national_id','iqama','gcc_id','passport')),
  constraint customer_identity_fmt_chk check (
       (id_type = 'national_id'            and id_number ~ '^1[0-9]{9}$')
    or (id_type = 'iqama'                  and id_number ~ '^2[0-9]{9}$')
    or (id_type in ('gcc_id','passport')   and id_number ~ '^[A-Z0-9]{5,20}$')
  )
);

comment on table public.customer_identity is
  'رقم الهوية للعملاء الأفراد. بيانات شخصية حساسة: وصول عبر Edge Function (admin فقط للقراءة الكاملة). لا تُضف الجدول إلى change_journal ولا تكتب الرقم كاملاً في audit_log.';

alter table public.customer_identity enable row level security;   -- بلا سياسات = لا وصول مباشر
revoke all on public.customer_identity from anon, authenticated;

create unique index if not exists customer_identity_uq
  on public.customer_identity (id_type, id_number);

-- قيود الصيغة على بيانات المنشآت (تقبل NULL والفراغ).
alter table public.customers
  add constraint customers_cr_fmt_chk
    check (commercial_registration is null or commercial_registration = ''
           or commercial_registration ~ '^[0-9]{10}$'),
  add constraint customers_vat_fmt_chk
    check (vat_number is null or vat_number = ''
           or vat_number ~ '^3[0-9]{13}3$'),
  add constraint customers_unified_fmt_chk
    check (unified_number is null or unified_number = ''
           or unified_number ~ '^7[0-9]{9}$');

commit;

-- ============================ الرجوع عنه (rollback) ============================
-- begin;
--   drop table if exists public.customer_identity;
--   alter table public.customers
--     drop constraint if exists customers_cr_fmt_chk,
--     drop constraint if exists customers_vat_fmt_chk,
--     drop constraint if exists customers_unified_fmt_chk;
-- commit;
