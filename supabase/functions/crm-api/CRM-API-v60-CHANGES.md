# crm-api v60 — نطاق المندوب (rep data scope)

⚠️ مصدر الحقيقة هو النسخة المنشورة على Supabase (v60). مجلد `crm-api` في الـ repo قبل كده كان فيه كود لوحة الصفقات (pipeline)
مش crm-api الفعلي، فمرفقش هنا نسخة كاملة؛ الملف `rep-scope-guard.ts` هو الحارس نفسه (متجرّب بـ ١٧ حالة اختبار)،
وده ملخص التعديلات اللي اتعملت على v59 → v60. لو عايز الملف كامل: Supabase Dashboard ← Edge Functions ← crm-api ← Download.

## القاعدة
المندوب يشوف عملاءه (`customers.assigned_to = username`) وكل اللي مرتبط بيهم فقط. الأدمن مش بيتأثر.

## التعديلات
1. **حارس مركزي** `repScopeCheck` بيتنادى لأي طلب من مندوب: أي مرجع في الطلب (customerId / siteId / assetId / opportunityId /
   projectId / contactId / quotationId / invoiceId / ticketId / contractId / milestoneId / paymentId / costId / assetIds[] /
   fields.site_id|contact_id|opportunity_id) لازم يتبع عميل من عملائه، وإلا 403.
2. **القوائم بتتفلتر بعملاء المندوب:** list-customers · list-sites · list-opportunities · list-assets · list-projects ·
   list-maintenance-contracts · list-tickets · crm-list-pos-invoices · global-search.
3. **الإحصائيات بتتحسب على عملائه بس:** admin-crm-stats · pipeline-stats · warranty-stats · maintenance-stats.
4. **admin-crm-update:** المندوب مينفعش يغيّر `assigned_rep` (النقل من شاشة توزيع العملاء فقط).
5. **admin-crm-create-customer (مندوب):** المالك هو المندوب نفسه دايمًا؛ لو الجوال مسجّل عنده يرجّع العميل الموجود،
   ولو مسجّل عند مندوب آخر/غير معيّن → 409 «كلّم المدير لنقل العميل ليك».
6. **crm-create-pos-invoice (النسخة اللي جوه crm-api):** المندوب يفوتر لعميله بس.
7. list-customers بيرجّع `assigned_to` كمان.

## لسه ما اتغطّاش (دوال تانية بتقبل توكن المندوب)
invoice-api · warranty-api · customer-identity · supply-api · cart-extras · crm-quotes · compute-quote — راجع HANDOFF.
