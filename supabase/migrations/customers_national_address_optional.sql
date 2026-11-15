-- مُطبّق بالفعل على HoloulEnergyQL (customers_national_address_optional). للتوثيق فقط.
alter table public.customers add column if not exists national_address jsonb;
alter table public.customers add constraint customers_national_address_obj_chk
  check (national_address is null or jsonb_typeof(national_address) = 'object');
comment on column public.customers.national_address is
  'العنوان الوطني للعميل (اختياري). jsonb مرن بانتظار تأكيد المحاسب القانوني للبنية.';
