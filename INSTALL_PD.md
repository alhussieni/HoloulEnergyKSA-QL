# تركيب PD (مستندات المشاريع) — متوافق مع الدخول الموحّد (auth-api)

المسارات في هذا المجلد تطابق بنية مستودعكم الحالية (`supabase/functions/<name>/` و`supabase/migrations/`)، فتُنسخ كما هي إلى جذر المستودع.

## 1) ما أُضيف (لا يعدّل أي ملف أو جدول أو دالة قائمة)

| المسار | الغرض |
|---|---|
| `supabase/migrations/customer_identity_v1.sql` | جدول هوية العملاء الأفراد + قيود صيغة السجل والضريبة والموحد |
| `supabase/migrations/pd_documents_v1.sql` | جدول المستندات الصادرة (لقطات مجمّدة) + trigger يمنع تعديلها |
| `supabase/functions/customer-identity/` | دالة الهوية (admin يقرأ ويكتب، المندوب يرى مسجّلة/غير مسجّلة) |
| `supabase/functions/docs-api/` | دالة PD (قراءة من الـCRM، كتابة في `pd_documents` و`audit_log` فقط) |
| `PD/index.html` | الصفحة، على الرابط `.../HoloulEnergyKSA-QL/PD/` |

## 2) التوافق مع التحديثات الأخيرة (login.html / auth-api / holoul-auth.js)

- **لا تملك PD نموذج دخول.** الدخول الوحيد هو `login.html`. الصفحة تقرأ توكن الأدمن من الجلسة المشتركة `holoul_session_v1` (localStorage أو sessionStorage)، وتتحقق منه عبر `auth-api` (`session-check`)، وإن لم يوجد توكن أدمن تعرض رابط `../login.html`.
- **صيغة التوكن لم تتغير** (`{sub, ver, exp}` موقّعة بـ`SESSION_SECRET`، وأدمن = `sub:"admin"` وفحص `admin_secret.session_version`)، فالدالتان الجديدتان تتحققان بنفس منطق `crm-api` و`auth-api`.
- **حماية التخمين** (6 محاولات / 10 دقائق) تشمل PD تلقائياً لأنها لا تملك مسار دخول آخر.
- **قراءة بنية الجلسة افتراضية:** لم أستطع قراءة `assets/js/holoul-auth.js`. الصفحة تبحث عن `tokens.admin` داخل القيمة المخزنة (كما تُرجعها `auth-api`). **اختبر هذا أول شيء بعد النشر**: ادخل من `login.html` كأدمن ثم افتح `/PD/`. إن ظهرت بوابة الدخول رغم أنك داخل، أرسل لي محتوى `holoul-auth.js` وأضبط الدالة `findAdminToken`.

## 3) تسجيل PD في بوابة `home.html` (تعديل سطر واحد في `auth-api`)

`home.html` تعرض الصفحات من `MODULES` داخل `supabase/functions/auth-api/index.ts`. أضف هذا السطر بعد سطر `crm`:

```ts
  { key: "pd", label: "مستندات المشاريع (PD)", desc: "إصدار العقود والمستندات من بيانات العملاء والصفقات المقبولة", icon: "📄", url: "PD/index.html", kinds: ["admin"] },
```

ثم `supabase functions deploy auth-api`. لا أنشر أنا شيئاً؛ هذا قرارك.

## 4) تبويب «العقود» داخل CRM أسفل «المبيعات»

لم يُنفَّذ: لا أقرأ `crm.html` (الأداة ترفض الرابط). ارفع الملف أو الصق كتلة القائمة الجانبية لأعطيك التعديل بالضبط.

## 5) تنبيهات قبل الدفع إلى GitHub

- **المستودع عام.** ملف `supabase/functions/docs-api/template.ts` يحوي **نص العقد وشروطه** (سقف المسؤولية، نسب الدفعات، التسليم الحكمي…). إن تبعتم عادتكم بحفظ مصدر الدوال في المستودع فسيصبح منشوراً. إما أضفه إلى `.gitignore` وانشره من جهازك بالـCLI، وإما أنقل نص القالب إلى مخزن خاص (أخبرني وأفعل).
- **`verify_jwt = false`** للدالتين الجديدتين (مثل `crm-api`)، وإن كان عندكم `supabase/config.toml` فأضف لهما `[functions.docs-api]` و`[functions.customer-identity]`.
- **ترتيب الـmigrations:** `customer_identity_v1` أولاً ثم `pd_documents_v1`. أرقام الملفات عندكم غير موحدة (0017… ومسميات `*_v1`)؛ سمّيتهما على نمط `*_v1` وغيّر الاسم كما تفضل.
- **تفاعل مع `change_journal`:** لا تُضف `customer_identity` ولا `pd_documents` إلى trigger المتتبع (فيها هوية العميل).
- **تحقق بعد النشر:** افتح `/PD/` ← اختر صفقة ← عرض سعر ← أصدر عقداً تجريبياً ← افتحه واطبعه ← غيّر اسم العميل في CRM وأعد فتح العقد (يجب أن يبقى الاسم القديم والبصمة سليمة).
