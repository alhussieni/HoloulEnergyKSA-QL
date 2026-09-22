# سجل التغييرات (Changelog)

كل تعديل هندسي جوهري على المشروع بيتوثق هنا بالتاريخ وسببه، عشان أي حد
(إنت أو أي حد يشتغل على المشروع بعدين) يقدر يرجع يفهم ليه اتعمل قرار معين.

## 2026-09-19

### أمان وأداء (قاعدة البيانات)
- إضافة 17 index كان ناقص على أعمدة foreign key، بناءً على تحذيرات
  Supabase Performance Advisor (migration `0017_fk_indexes_and_rls_perf_fix`).
- تصحيح مشكلة أداء في RLS policy الخاصة بجدول `app_settings`
  (`auth.role()` كانت بتتقيّم لكل صف بدل مرة واحدة لكل استعلام).

### البنية التحتية (Ops)
- إضافة `.github/workflows/daily-db-backup.yml`: نسخة احتياطية يومية كاملة
  من قاعدة البيانات، بتتحفظ كـ commit في فرع `backups` (PR #1).
- إضافة `.github/workflows/deploy-check.yml`: فحص تلقائي إن الموقع الحي
  شغال بعد كل push على `main` (PR #1).
- إضافة `README-BACKUPS.md`: خطوات إعداد الباكب والاستعادة.

### هيكلة الكود (Refactor)
- فصل الـ CSS من `index.html` (كان بلوك `<style>` من 697 سطر) إلى ملف
  مستقل `assets/css/styles.css` (PR #2). المحتوى نفسه لم يتغير حرفيًا.
- فصل الـ JavaScript من `index.html` (كان بلوك `<script>` من 5165 سطر)
  إلى ملف مستقل `assets/js/app.js`، مُحمَّل كـ script عادي (مش module) عشان
  النطاق العام يفضل زي ما هو (PR #3). المحتوى نفسه لم يتغير حرفيًا
  (تم التحقق بـ diff حرفي وبـ `node --check`).
- النتيجة: `index.html` من 375 كيلوبايت (5915 سطر) إلى أقل من 3 كيلوبايت
  (51 سطر فقط).

### مؤجّل عمدًا (لسه لم يتم)
- **تقسيم `assets/js/app.js` لملفات منطقية منفصلة** (pricing.js, admin.js,
  ui.js...): الكود متشابك بشدة من غير حدود واضحة، ومفيش بيئة اختبار
  (staging) أو متصفح حقيقي للتحقق من عدم كسر أي سلوك. يُنصح بعمله تدريجيًا
  مع اختبار يدوي بعد كل قطعة، أو بعد توفر بيئة staging.
- **حذف الـ 15 index غير المستخدم** في قاعدة البيانات: الأرقام دي مبنية
  على أسبوعين بس من الاستخدام الفعلي (المشروع بدأ يوليو 2026)، وده مش وقت
  كافٍ يبقى قرار حذف نهائي عليه مأمون — بعض الميزات (زي service_tickets،
  technical_studies) لسه صفوفها صفر أو قليلة جدًا، يعني ممكن يكون الفهرس
  مطلوب لما الاستخدام يزيد مش لأنه زيادة فعلاً. التوصية: مراقبة 2-3 شهور
  إضافية قبل الحذف.
- **حماية الباسوردات المسربة (Leaked Password Protection)** في Supabase
  Auth: يحتاج تفعيل يدوي من الداشبورد (لا يوجد API متاح لهذا الإعداد).
- **`SUPABASE_DB_URL` secret** في GitHub Actions: يحتاج القيمة الحقيقية
  من صاحب المشروع (لا يمكن توليدها أو جلبها آليًا لأسباب أمنية).

## Unreleased — E-invoicing Phase-1 hardening (ZATCA guide alignment)
- QR: seller name = registered name (same as printed), timestamp without milliseconds, single QR only (removed the invoice-number QR), 96px print size.
- Invoice: exact titles (فاتورة ضريبية / فاتورة ضريبية مبسطة), issue date+time in Asia/Riyadh, amounts with 2 decimals, per-line VAT rounding that foots to the total, document discount shown as its own row.
- Standard (B2B) invoices now require buyer name, address and VAT/CR (VAT format validated).
- Issued invoices can no longer be deleted or edited (DB triggers); cancellation = credit note (`crm-create-credit-note`).
- Atomic sequence counter (`next_invoice_seq`) using Saudi-time day boundaries; legacy project-invoice creator disabled.
- Migration `0018_einvoice_compliance.sql`. NOT included: Phase 2 (UBL XML, cryptographic stamp, CSID, clearance/reporting, QR tags 6-9).
