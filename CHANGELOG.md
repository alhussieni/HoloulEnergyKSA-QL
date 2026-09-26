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

## 2026-09-24 — Structure cleanup, accessibility, and repo/DB sync

### Frontend structure
- Split `assets/js/app.js` (5165 lines) into 8 logical modules under
  `assets/js/modules/`, following the section boundaries already marked in
  the code (`01-supabase-engine.js` through `08-wiring.js`). Loaded as plain
  (non-module) scripts, in order, so global scope is unchanged.
- Added `tests/regression/`: 20 automated tests for the calculation
  functions that drive customer-facing numbers (payback period, IRR, phone
  normalization, appliance load, XSS-safety of `esc`/`escAttr`). Runs
  automatically in CI on any change to `assets/js/modules/`.
- Removed ~12MB of dead duplicate image assets (an orphaned `/curves/`
  directory, itself containing a further duplicate at `curves/curves/`, and
  two duplicate copies of the logo) — confirmed via exhaustive grep that
  nothing referenced them before deleting. The live, used copy
  (`assets/curves/`) was untouched.
- Reorganized loose root files into `supabase/migrations/`,
  `supabase/functions/{compute-quote,crm-api}/`, and `archive/` (old
  patches, a superseded source file) — a conventional structure instead of
  everything sitting at repo root.

### Accessibility / performance (Lighthouse-style pass)
- Fixed a failing color-contrast pair in the portfolio timeline
  (`.timeline-item strong`): gold text on a pale-gold background measured
  1.84:1 against WCAG AA's 4.5:1 minimum. Added `--sun-dark`, a darker gold
  in the same hue (same technique as the existing `--teal`/`--teal-dark`
  pair), bringing it to 5.04:1.
- Added `loading="lazy"` (and `alt` text where missing) to list/grid images
  in the admin panel (catalog cards, category cards, ready-system cards,
  BOM item thumbnails) — deferred loading images no different for the
  admin's list. Twice reverted by manual file uploads that were based on a
  stale local copy, and re-applied both times.
- Declined: compressing `assets/curves/` pump-curve images — the technical
  data inside them needs to stay at full quality for the engineer reading
  them.

### Repo/database sync (after invoice/ZATCA work done outside git)
A chunk of e-invoicing work happened directly via the Supabase dashboard
and GitHub's web upload, bypassing this repo's branches/PRs entirely. A
full audit turned up:
- `supabase/functions/invoice-api/index.ts` — a **third Edge Function**
  that had never been tracked anywhere (QR codes, credit notes, atomic
  invoice numbering, trial-mode). Synced from the live deployment.
- `supabase/functions/compute-quote/index.ts` had drifted (v106 → v114),
  including a real bug fix: `phoneKey()` used to drop the leading "0" from
  Saudi numbers while `crm-api`/`invoice-api` kept it, so the same customer
  could end up as two different database rows. Now consistent everywhere.
- `supabase/migrations/0018_einvoice_compliance.sql` — reconstructed from
  the live schema (not guessed): `einvoice_config`, `invoice_counters` +
  `next_invoice_seq()`, `einvoice_go_live()`, and the 3 integrity triggers
  that make an issued invoice immutable/undeletable.
- `supabase/migrations/0019_fix_invoice_trigger_search_path.sql` — a real
  security finding from this review (Supabase advisor:
  `function_search_path_mutable` on the 3 new trigger functions), fixed on
  the live database and captured as a migration.

Two more manual uploads added a legitimate feature (shared admin login
between `index.html` and `crm.html` via the same server-verified token) —
reviewed, no issues, left as-is.

