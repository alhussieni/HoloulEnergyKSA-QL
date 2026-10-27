# ملفات للرفع فوق الريبو (نفس المسارات)

- crm.html   (مدموج: RFQ + دفعات الموردين المقدّمة/المرتجعات/كاش فلو + إصلاح الآيباد + ربط دفعات المراحل + **تعديل حركات الخزنة**)
- supabase/functions/finance-treasury/index.ts        (نسخة الدفعات المقدّمة — هي المنشورة v4)
- supabase/functions/finance-procurement/index.ts      (RFQ — منشورة v1)
- supabase/functions/finance-treasury-edit/index.ts    (جديدة — تعديل حركات الخزنة، منشورة v1)
- supabase/migrations/0036_rfq.sql                    (كان 0035_rfq.sql وبيتعارض مع 0035_milestone_payment_link.sql)
- supabase/migrations/0037_treasury_entry_edits.sql   (جدول سجل التعديلات + دالة finance_edit_entry — مطبّقة بالفعل على قاعدة البيانات)
