# ملفات للرفع فوق الريبو (نفس المسارات)

- crm.html   (مدموج: RFQ + دفعات الموردين المقدّمة/المرتجعات/كاش فلو + إصلاح الآيباد + ربط دفعات المراحل + **تعديل حركات الخزنة + بحث وفلاتر سجل الحركات + ألوان أرصدة الموردين (أحمر = علينا، أخضر = لنا)**)
- supabase/functions/finance-treasury/index.ts        (نسخة الدفعات المقدّمة — هي المنشورة v4)
- supabase/functions/finance-procurement/index.ts      (RFQ — منشورة v2: رد المورد بند بند / سعر إجمالي / تعديل)
- supabase/functions/finance-treasury-edit/index.ts    (جديدة — تعديل حركات الخزنة + بحث سجل الحركات، منشورة v2)
- supabase/migrations/0036_rfq.sql                    (كان 0035_rfq.sql وبيتعارض مع 0035_milestone_payment_link.sql)
- supabase/migrations/0037_treasury_entry_edits.sql   (جدول سجل التعديلات + دالة finance_edit_entry — مطبّقة بالفعل على قاعدة البيانات)

## الألواح الشمسية (لوحة التحكم ← المنتجات والكتالوج)
- assets/js/modules/02-client-cache.js, 05-render-calculator.js, 07-render-admin.js, 08-wiring.js
  (نافذة منبثقة للإضافة/التعديل + جدول للعرض فقط + ترتيب أبجدي. ملفات الواجهة فقط — مفيش تغيير في Supabase)

## الحاسبة: طيّ معلومات الأدمن + حد أدنى للسعر = التكلفة
- assets/js/modules/04-state.js (جديد في القائمة), 02-client-cache.js, 05-render-calculator.js, 08-wiring.js
- supabase/functions/compute-quote/index.ts  ← **لازم يتنشر (deploy)** عشان الحد الأدنى يتفرض في السيرفر كمان (مش بس في الواجهة)

## تحديثات أخيرة
- الحاسبة: شيل سطر "أقصى خصم متاح" الدائم (05-render-calculator.js) — الرقم بيظهر بس لو المندوب كتب خصم أكبر من المسموح.
- RFQ: رد المورد بند بند أو سعر إجمالي + تعديل بعد التسجيل (crm.html + finance-procurement v2 + migration 0038 — مطبّقة على قاعدة البيانات).
