# الوضع الأوفلاين — دليل الرفع (هذا الملف للقراءة فقط، لا ترفعه على GitHub)

## اللي اتنفّذ فعلاً على Supabase (HoloulEnergyQL) — لايف الآن
- Migration `offline_leases_and_ops`: جداول device_leases / device_state / offline_ops / offline_keys + دالة offline_register_op (RLS مفعّل، صلاحيات anon/authenticated مسحوبة). إضافي فقط.
- Edge Function `sync-api` (v1، verify_jwt=false زي باقي دوالك). دالة جديدة؛ ما اتغيّرتش أي دالة قائمة.
- اتختبرت دالة قاعدة البيانات في transaction بتتراجع (10 حالات: قبول، تكرار، إعادة رقم، فجوة، متأخر، تأريخ رجعي، عقد غلط، مندوب غلط، سقف 24 ساعة).

## اللي لازم ترفعه على GitHub (المسارات = مسارات الريبو)
assets/js/holoul-offline.js · sw.js · manifest.webmanifest · crm.html · home.html · login.html ·
supabase/functions/sync-api/index.ts · supabase/migrations/0067_offline_leases_and_ops.sql

رفع الملفات = تفعيل الميزة (المفتاح العام مضمّن). للتعطيل الفوري: LEASE_PUBKEY_JWK = null في holoul-offline.js وارفعه.

## اختبار قبول بعد الرفع (لازم قبل الاعتماد عليه)
1. افتح crm.html بحساب أدمن مع نت، سجّل استلام نقدية صغير → لازم يظهر في الخزينة عادي.
   يتأكد: جدول offline_ops فيه صف status=applied.
2. اقطع النت (DevTools → Network → Offline)، سجّل استلام نقدية → يظهر الشريط «بانتظار المزامنة». رجّع النت → يتحول «تمت» ويظهر في الخزينة مرة واحدة.
3. لو الخطوة 1 فشلت أو ظهر «بانتظار المزامنة» والنت شغال: بلّغني فورًا (الدالة ما اتجرّبتش end-to-end من بيئتي).
