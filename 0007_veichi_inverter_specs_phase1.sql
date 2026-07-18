-- ============================================================================
-- Product detail enrichment — phase 1 of 4: VEICHI SIS4 / SIS / SISV families
-- (the first 8 rows of the "شواحن/انفرترات هجين MPPT" category, index 1).
--
-- Source: official VEICHI spec sheets (veichi.com), summarized/paraphrased —
-- not copied verbatim. Two rows are flagged with a ⚠️ note where the exact
-- model code or rating in your catalog doesn't perfectly match what VEICHI
-- currently publishes; please confirm those with VEICHI/your supplier before
-- sharing with a customer.
--
-- Safe to re-run: for each row this MERGES (||) into whatever productDetails
-- already exists there, so it will NOT erase an image or "available" flag an
-- admin already set for these rows — it only adds/updates description+specs.
-- ============================================================================

update public.pricing_config
set data = jsonb_set(
  data,
  '{productCatalog,1,productDetails}',
  coalesce(data->'productCatalog'->1->'productDetails', '{}'::jsonb) || jsonb_build_object(

    -- Row 0: SIS4-12V 1KW MPPT  →  official model SIS4-1K-12-S
    '0', coalesce(data->'productCatalog'->1->'productDetails'->'0', '{}'::jsonb) || jsonb_build_object(
      'description', 'شاحن/انفرتر MPPT مدمج لأنظمة التخزين المنزلية بجهد بطارية 12 فولت، بمخرج موجة جيبية نقية (Pure Sine Wave) وشاشة LCD ملونة، ويدعم التحكم عن بعد عبر تطبيق الجوال (واي فاي/GPRS).',
      'specs', jsonb_build_object(
        'الاسم الرسمي عند فيتشي', 'SIS4-1K-12-S',
        'القدرة المقننة', '1000W / 1000VA',
        'ذروة الكفاءة (شمسي → خرج)', '98%',
        'ذروة الكفاءة (بطارية → خرج)', '94%',
        'زمن التحويل (Transfer Time)', '10ms',
        'أقصى قدرة ألواح مسموحة', '600W',
        'مدى جهد MPPT', '20–150 VDC',
        'أقصى تيار شحن شمسي', '40A',
        'أقصى تيار شحن AC', '40A',
        'الأبعاد (ط×ع×ا)', '290×240×91 مم',
        'الوزن الصافي', '3.5 كجم'
      )
    ),

    -- Row 1: SIS4-12V 2KW MPPT  →  official model SIS4-2K-12-S
    '1', coalesce(data->'productCatalog'->1->'productDetails'->'1', '{}'::jsonb) || jsonb_build_object(
      'description', 'نفس عائلة SIS4 بقدرة أعلى (2 كيلوواط) وجهد دخول شمسي أوسع يصل حتى 400 فولت، مناسب لأنظمة تخزين منزلية أكبر تحتاج قدرة ألواح إضافية.',
      'specs', jsonb_build_object(
        'الاسم الرسمي عند فيتشي', 'SIS4-2K-12-S',
        'القدرة المقننة', '2000W / 1600W',
        'ذروة الكفاءة (شمسي → خرج)', '98%',
        'ذروة الكفاءة (بطارية → خرج)', '94%',
        'زمن التحويل (Transfer Time)', '10ms (كمبيوتر) / 20ms (أجهزة منزلية)',
        'أقصى قدرة ألواح مسموحة', '3000W',
        'مدى جهد MPPT', '30–400 VDC',
        'أقصى تيار شحن شمسي', '80A',
        'أقصى تيار شحن AC', '60A',
        'منافذ الاتصال', 'RS232 / GPRS / WIFI',
        'الأبعاد (ط×ع×ا)', '357×273×95 مم',
        'الوزن الصافي', '4.6 كجم'
      )
    ),

    -- Row 2: SIS-24V 3KW MPPT  →  أقرب موديل رسمي: SIS-3K-H
    '2', coalesce(data->'productCatalog'->1->'productDetails'->'2', '{}'::jsonb) || jsonb_build_object(
      'description', 'انفرتر هجين (Hybrid) بقدرة 3 كيلوواط يدعم التوازي حتى 9 وحدات وإخراج موجة جيبية نقية، مناسب لأنظمة التخزين المنزلية متوسطة الحجم. ⚠️ ملاحظة: الجدول الرسمي المنشور لهذه السلسلة (SIS-3K-H) يذكر جهد بطارية اسمي 48 فولت وليس 24 فولت كما هو مسمى في كتالوجك — يُرجى التأكد من كود الموديل الدقيق مع فيتشي/المورّد قبل عرضه على العميل.',
      'specs', jsonb_build_object(
        'الاسم الرسمي عند فيتشي (أقرب تطابق)', 'SIS-3K-H',
        'القدرة المقننة', '3000W',
        'أقصى كفاءة تحويل (ربط شبكة)', '95%',
        'كفاءة (بطارية → تيار متردد)', '93%',
        'مدى جهد MPPT', '120–430 VDC',
        'أقصى تيار دخول DC', '13A',
        'أقصى تيار خرج AC', '13A',
        'التوازي (Parallel)', 'حتى 9 وحدات'
      )
    ),

    -- Row 3: SISV-24V 4.2KW (TWIN) MPPT  →  official model SISV-4.2K-H(TWIN)
    '3', coalesce(data->'productCatalog'->1->'productDetails'->'3', '{}'::jsonb) || jsonb_build_object(
      'description', 'انفرتر هجين بمخرجين مستقلين (TWIN) يسمح بتغذية حملين مختلفين في نفس الوقت مع أولويات وجدولة يومية قابلة للبرمجة، ويعمل بجهد بطارية 24 أو 48 فولت.',
      'specs', jsonb_build_object(
        'الاسم الرسمي عند فيتشي', 'SISV-4.2K-H(TWIN)',
        'القدرة المقننة', '4200W',
        'أقصى كفاءة تحويل', '98%',
        'كفاءة (بطارية → تيار متردد)', '94%',
        'مدى جهد MPPT', '60–450 VDC',
        'أقصى تيار دخول DC', '18A',
        'أقصى تيار خرج AC', '18.2A',
        'جهد البطارية الاسمي', '24 / 48 فولت',
        'أقصى تيار شحن شمسي', '120A',
        'أقصى تيار شحن AC', '100A',
        'أقصى حمل ثانوي (وضع البطارية)', '1400W'
      )
    ),

    -- Row 4: SIS 5KW-S MPPT  →  official model SIS-5K-H
    '4', coalesce(data->'productCatalog'->1->'productDetails'->'4', '{}'::jsonb) || jsonb_build_object(
      'description', 'انفرتر هجين بقدرة 5 كيلوواط من نفس عائلة SIS، يدعم التوازي حتى 9 وحدات، مناسب للمنازل ذات الاستهلاك الأعلى.',
      'specs', jsonb_build_object(
        'الاسم الرسمي عند فيتشي', 'SIS-5K-H',
        'القدرة المقننة', '5000W',
        'أقصى كفاءة تحويل (ربط شبكة)', '95%',
        'كفاءة (بطارية → تيار متردد)', '93%',
        'مدى جهد MPPT', '120–430 VDC',
        'أقصى تيار دخول DC', '27A',
        'أقصى تيار خرج AC', '21.7A',
        'جهد البطارية الاسمي', '48 فولت',
        'أقصى تيار شحن', '100A',
        'التوازي (Parallel)', 'حتى 9 وحدات'
      )
    ),

    -- Row 5: SISV 6.2KW (TWIN) MPPT  →  official model SISV-6.2K-H(TWIN)
    '5', coalesce(data->'productCatalog'->1->'productDetails'->'5', '{}'::jsonb) || jsonb_build_object(
      'description', 'نفس عائلة SISV ثنائية المخرج (TWIN) بقدرة أعلى (6.2 كيلوواط)، مناسب لأحمال منزلية أكبر مع نفس مزايا الأولويات والجدولة القابلة للبرمجة.',
      'specs', jsonb_build_object(
        'الاسم الرسمي عند فيتشي', 'SISV-6.2K-H(TWIN)',
        'القدرة المقننة', '6200W',
        'أقصى كفاءة تحويل', '98%',
        'كفاءة (بطارية → تيار متردد)', '94%',
        'مدى جهد MPPT', '60–450 VDC',
        'أقصى تيار دخول DC', '22A',
        'أقصى تيار خرج AC', '27A',
        'جهد البطارية الاسمي', '24 / 48 فولت',
        'أقصى تيار شحن شمسي', '140A',
        'أقصى تيار شحن AC', '100–140A'
      )
    ),

    -- Row 6: SISV 8KW (TWIN) MPPT  →  أقرب موديل رسمي: SISV-8.2K-H(TWIN)
    '6', coalesce(data->'productCatalog'->1->'productDetails'->'6', '{}'::jsonb) || jsonb_build_object(
      'description', 'نفس عائلة SISV ثنائية المخرج (TWIN)، الطراز الرسمي المنشور بقدرة 8.2 كيلوواط (كتالوجك يذكره تقريبًا كـ 8 كيلوواط).',
      'specs', jsonb_build_object(
        'الاسم الرسمي عند فيتشي (أقرب تطابق)', 'SISV-8.2K-H(TWIN)',
        'القدرة المقننة', '8200W',
        'أقصى كفاءة تحويل', '98%',
        'كفاءة (بطارية → تيار متردد)', '94%',
        'مدى جهد MPPT', '60–450 VDC',
        'أقصى تيار دخول DC', '23A',
        'أقصى تيار خرج AC', '35.6A',
        'جهد البطارية الاسمي', '24 / 48 فولت',
        'أقصى تيار شحن شمسي', '140A',
        'أقصى تيار شحن AC', '100–140A'
      )
    ),

    -- Row 7: SISV 11KW (TWIN) MPPT  →  أعلى طراز منشور رسميًا حاليًا: SISV-10.2K-H(TWIN)
    '7', coalesce(data->'productCatalog'->1->'productDetails'->'7', '{}'::jsonb) || jsonb_build_object(
      'description', 'نفس عائلة SISV ثنائية المخرج (TWIN). ⚠️ ملاحظة: أعلى طراز منشور رسميًا في هذه العائلة على موقع فيتشي هو 10.2 كيلوواط — يُرجى التأكد مع فيتشي/المورّد هل "11 كيلوواط" في كتالوجك هو نفس هذا الطراز (تقريب تسويقي) أو طراز أحدث لم يُنشر بعد على الموقع العام.',
      'specs', jsonb_build_object(
        'الاسم الرسمي عند فيتشي (أقرب تطابق)', 'SISV-10.2K-H(TWIN)',
        'القدرة المقننة', '10200W',
        'أقصى كفاءة تحويل', '98%',
        'كفاءة (بطارية → تيار متردد)', '94%',
        'مدى جهد MPPT', '60–450 VDC',
        'أقصى تيار دخول DC', '2×18A (ثنائي تتبع MPPT)',
        'أقصى تيار خرج AC', '44.3A',
        'جهد البطارية الاسمي', '24 / 48 فولت',
        'أقصى تيار شحن شمسي', '160A',
        'أقصى تيار شحن AC', '140A'
      )
    )

  ),
  true
)
where id = 1;
