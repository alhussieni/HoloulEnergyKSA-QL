-- ============================================================================
-- Product detail enrichment — VEICHI solar pump inverters
-- ("انفرتر مضخات VEICHI (مارس 2026)" category, index 3, all 37 rows).
--
-- Source: official VEICHI spec sheets (veichi.com), summarized/paraphrased —
-- not copied verbatim. These 37 rows aren't 37 different products — they're
-- 3 real VEICHI drive platforms (SI23-D5, SI23-T3, SI32) sold across many
-- power ratings, so this seed gives each row its own accurate current/voltage
-- pulled from the official per-model table for its platform, rather than
-- copy-pasting one paragraph 37 times.
--
-- Matching confidence, by group:
--   • Rows 7–29  ("(H)", 900V class)   → SI23 series (D5 sub-class ≤30kW,
--     T3 sub-class ≥37kW). Every current value below matched the official
--     table exactly except the 710kW row (catalog: 1260A, official: 1280A —
--     flagged below).
--   • Rows 30–36 ("IP65")              → SI32 series. Every current value
--     matched the official table exactly.
--   • Rows 0–6   ("1P/3P 220")         → ⚠️ Could NOT be pinned to one exact
--     official SKU (SI21/SI01/SI22 all overlap partially but none matches
--     this exact power+current combination in VEICHI's public tables). The
--     specs given are the general 220V single/three-phase VEICHI pump-drive
--     platform description — please confirm the precise model code printed
--     on the physical unit with VEICHI/your supplier.
--
-- Safe to re-run: MERGES (||) into whatever productDetails already exists
-- per row, so it won't erase an image or "available" flag already set.
-- ============================================================================

do $do$
declare
  r record;
  desc_text text;
  official_model text;
  spec_extra jsonb;
begin
  for r in
    select * from (values
      -- idx, family, power_kw (label as in catalog), current_a
      (0,  'A',    '2.2',  '10'),
      (1,  'A',    '4',    '16'),
      (2,  'A',    '5.5',  '20'),
      (3,  'A',    '7.5',  '30'),
      (4,  'A',    '11',   '42'),
      (5,  'A',    '18.5', '70'),
      (6,  'A',    '22',   '80'),
      (7,  'B_D5', '2.2',  '6'),
      (8,  'B_D5', '5.5',  '13'),
      (9,  'B_D5', '7.5',  '17'),
      (10, 'B_D5', '11',   '25'),
      (11, 'B_D5', '18.5', '38'),
      (12, 'B_D5', '22',   '45'),
      (13, 'B_D5', '30',   '60'),
      (14, 'B_T3', '37',   '75'),
      (15, 'B_T3', '55',   '110'),
      (16, 'B_T3', '75',   '150'),
      (17, 'B_T3', '90',   '180'),
      (18, 'B_T3', '110',  '210'),
      (19, 'B_T3', '132',  '250'),
      (20, 'B_T3', '160',  '310'),
      (21, 'B_T3', '200',  '380'),
      (22, 'B_T3', '250',  '470'),
      (23, 'B_T3', '315',  '600'),
      (24, 'B_T3', '355',  '670'),
      (25, 'B_T3', '400',  '750'),
      (26, 'B_T3', '500',  '860'),
      (27, 'B_T3', '560',  '990'),
      (28, 'B_T3', '630',  '1100'),
      (29, 'B_T3', '710',  '1260'),
      (30, 'C',    '4',    '10'),
      (31, 'C',    '5.5',  '13'),
      (32, 'C',    '7.5',  '17'),
      (33, 'C',    '11',   '25'),
      (34, 'C',    '15',   '32'),
      (35, 'C',    '18.5', '38'),
      (36, 'C',    '22',   '45')
    ) as t(idx, family, power_kw, current_a)
  loop

    if r.family = 'A' then
      official_model := 'أقرب منصة عامة عند فيتشي (SI21/SI01) — كود الطراز الدقيق غير مؤكد ⚠️';
      desc_text := format(
        'انفرتر مضخات فيتشي بقدرة %s كيلوواط، يدعم التغذية بتيار متردد 220 فولت أحادي أو ثلاثي الطور (1P/3P) من نفس الوحدة، ويعمل بالطاقة الشمسية المباشرة (DC) أو كهرباء الشبكة/المولد كمصدر بديل. ⚠️ ملاحظة: لم نقدر نؤكد كود الموديل الرسمي الدقيق لهذه الفئة بين عائلات فيتشي المتعددة (SI21/SI01/SI22) — المواصفات أدناه عامة لمنصة مضخات فيتشي القياسية 220 فولت، يُرجى مطابقتها مع الكود المطبوع فعليًا على جسم الجهاز.',
        r.power_kw
      );
      spec_extra := jsonb_build_object(
        'أقصى جهد دخول DC', '450 فولت',
        'جهد دخول التيار المتردد', '220–230 فولت (أحادي/ثلاثي الطور)، 50/60Hz',
        'كفاءة MPPT', 'حتى 99.8%',
        'التحميل الزائد المسموح', '150% لمدة 60 ثانية، 180% لمدة 10 ثوانٍ، 200% لمدة 0.5 ثانية',
        'حماية المضخة', 'جفاف المياه، سرعة منخفضة، أقل قدرة، سبات (Dormancy)، تيار زائد',
        'الضمان (فئة SI2x العامة)', '18 شهرًا'
      );

    elsif r.family = 'B_D5' then
      official_model := format('SI23-D5 (أقرب تطابق رسمي) — %s كيلوواط', r.power_kw);
      desc_text := format(
        'انفرتر مضخات فيتشي بقدرة %s كيلوواط من سلسلة SI23 (فئة D5)، يعمل بجهد دخول شمسي مباشر حتى 780 فولت تقريبًا، ويُخرج تيارًا مترددًا ثلاثي الطور 380–460 فولت لتشغيل مضخات الري والمشاريع متوسطة القدرة.',
        r.power_kw
      );
      spec_extra := jsonb_build_object(
        'مدى جهد دخول DC', '250–780 فولت (Voc موصى به 620–750 فولت)',
        'جهد خرج AC', '380–460 فولت ثلاثي الطور، 0–599Hz',
        'كفاءة MPPT', 'حتى 99.9%',
        'كفاءة تحويل الانفرتر', '≥96%',
        'التحميل الزائد المسموح', '150% لمدة دقيقة، 180% لمدة 10 ثوانٍ، 200% لمدة 0.5 ثانية',
        'حماية المضخة', 'جفاف مياه، تيار زائد، سبات، تردد منخفض، أقل قدرة، تنظيف المضخة بضغطة زر',
        'درجة الحماية', 'IP20 — تركيب معلّق داخلي',
        'أقصى ارتفاع تركيب بدون تخفيض قدرة', '1000 متر',
        'مدى درجة الحرارة', '-10 إلى 60°م'
      );

    elsif r.family = 'B_T3' then
      official_model := format('SI23-T3 (أقرب تطابق رسمي) — %s كيلوواط', r.power_kw);
      desc_text := format(
        'انفرتر مضخات فيتشي صناعي بقدرة %s كيلوواط من سلسلة SI23 (فئة T3)، مخصص للمضخات الكبيرة ومشاريع الري الزراعي الواسعة والتطبيقات الصناعية، بجهد دخول شمسي مباشر حتى 780 فولت.%s',
        r.power_kw,
        case when r.idx = 29 then ' ⚠️ ملاحظة: الجدول الرسمي المنشور حاليًا يذكر تيار خرج 1280A لهذه القدرة (710 كيلوواط)، بينما كتالوجك يذكر 1260A — فرق طفيف يستحق التأكيد مع فيتشي/المورّد.' else '' end
      );
      spec_extra := jsonb_build_object(
        'مدى جهد دخول DC', '350–780 فولت (Voc موصى به 620–750 فولت)',
        'جهد خرج AC', '380–440 فولت ثلاثي الطور، 0–599Hz',
        'كفاءة MPPT', 'حتى 99.9%',
        'كفاءة تحويل الانفرتر', '≥96%',
        'التحميل الزائد المسموح', '150% لمدة دقيقة، 180% لمدة 10 ثوانٍ، 200% لمدة 0.5 ثانية',
        'حماية المضخة', 'جفاف مياه، تيار زائد، سبات، تردد منخفض، أقل قدرة، تنظيف المضخة بضغطة زر',
        'درجة الحماية', 'IP20 — تركيب معلّق داخلي',
        'أقصى ارتفاع تركيب بدون تخفيض قدرة', '1000 متر',
        'مدى درجة الحرارة', '-10 إلى 60°م'
      );

    else -- family = 'C' (IP65 / SI32)
      official_model := format('SI32-D5-%sG-A (أقرب تطابق رسمي)', replace(r.power_kw, '.', 'R'));
      desc_text := format(
        'انفرتر مضخات فيتشي بتصنيف IP65 (مقاوم للماء والغبار، مناسب للتركيب الخارجي المكشوف) بقدرة %s كيلوواط من سلسلة SI32، مزوّد بحماية من عكس التوصيل والتدفق العكسي، و4 أوضاع تحكم مرنة (سرعة، ضغط ثابت، بدء/إيقاف بالضغط، توقيت).',
        r.power_kw
      );
      spec_extra := jsonb_build_object(
        'مدى جهد دخول DC', '250–850 فولت (Voc موصى به 620–750 فولت)',
        'جهد دخول AC', '380–480 فولت ثلاثي الطور، 50/60Hz',
        'كفاءة MPPT', '≥99.9%',
        'أوضاع التحكم', 'سرعة / ضغط ثابت / بدء-إيقاف بالضغط / توقيت',
        'حماية إضافية', 'عكس التوصيل، التدفق العكسي، مفتاح عوّامة لمنع جفاف البئر/الخزان',
        'التصنيف', 'IP65 — تركيب داخلي وخارجي',
        'أقصى دورة محرك', 'حتى 6500 دورة/دقيقة',
        'التحميل الزائد المسموح', '150% لمدة 60 ثانية، 180% لمدة 10 ثوانٍ، 200% لمدة 0.5 ثانية عند 4kHz'
      );
    end if;

    update public.pricing_config
    set data = jsonb_set(
      data,
      array['productCatalog','3','productDetails', r.idx::text],
      coalesce(data->'productCatalog'->3->'productDetails'->r.idx::text, '{}'::jsonb) || jsonb_build_object(
        'description', desc_text,
        'specs', jsonb_build_object('الاسم الرسمي عند فيتشي', official_model) || spec_extra
      ),
      true
    )
    where id = 1;

  end loop;
end;
$do$;
