-- ============================================================================
-- Portfolio content — made admin-editable
-- Moves the "البورتفوليو" tab's content (hero text/photo, KPIs, timeline,
-- capability steps, projects, ROI cases, partner logos) from hardcoded
-- JavaScript into pricing_config.data->'portfolio', so it can be edited from
-- the admin panel exactly like the pricing/product-catalog data already is.
--
-- IDEMPOTENT BY DESIGN: the WHERE clause only sets this the first time (when
-- ->'portfolio' is still null). Re-running this file is always safe and will
-- never overwrite content an admin has since edited through the panel.
-- ============================================================================

update public.pricing_config
set data = jsonb_set(
  data,
  '{portfolio}',
  jsonb_build_object(
    'hero', jsonb_build_object(
      'image', 'assets/portfolio/solar-field.jpg',
      'title', 'بورتفوليو حلول الطاقة',
      'description', 'حلول EPC متخصصة في أنظمة الري الزراعي بالطاقة الشمسية داخل المملكة، مبنية على خبرة هندسية في مصر ومشاريع منفذة في وادي الدواسر.'
    ),
    'panelTitle', 'Engineering Value Beyond Solar',
    'panelNote', 'نقيس نجاح المشروع بالعائد الذي يحققه للعميل، وليس بعدد الألواح فقط. هدفنا تقليل تكلفة التشغيل، رفع الاعتمادية، وبناء أصل طويل الأجل للمزرعة.',
    'kpis', jsonb_build_array(
      jsonb_build_object('v', '5', 'l', 'مشاريع منفذة في السعودية'),
      jsonb_build_object('v', '60-500 HP', 'l', 'نطاق قدرات الري المنفذة'),
      jsonb_build_object('v', 'EPC', 'l', 'هندسة، توريد، تنفيذ، تشغيل'),
      jsonb_build_object('v', '2026', 'l', 'تشغيل داخل المملكة')
    ),
    'timeline', jsonb_build_array(
      jsonb_build_object('label', 'الأصل', 'title', 'Alasl Solar - Egypt', 'desc', 'تنفيذ مشاريع ري شمسي، Off-grid، ومشاريع تجارية وصناعية.', 'image', 'assets/portfolio/foundation-egypt.jpg'),
      jsonb_build_object('label', 'النمو', 'title', 'تخصص زراعي', 'desc', 'تركيز عميق على أنظمة الضخ والري من 30 HP إلى 500 HP.', 'image', null),
      jsonb_build_object('label', '2026', 'title', 'Holoul Energy KSA', 'desc', 'تأسيس وتشغيل في المملكة مع مشاريع منفذة في وادي الدواسر.', 'image', null)
    ),
    'capabilitySteps', jsonb_build_array(
      jsonb_build_object('v', '01', 'l', 'Survey ودراسة الموقع'),
      jsonb_build_object('v', '02', 'l', 'تصميم هندسي وتحجيم النظام'),
      jsonb_build_object('v', '03', 'l', 'توريد من شركاء موثوقين'),
      jsonb_build_object('v', '04', 'l', 'تركيب واختبارات حماية'),
      jsonb_build_object('v', '05', 'l', 'Commissioning وتسليم'),
      jsonb_build_object('v', '06', 'l', 'دعم فني وتشغيل وصيانة')
    ),
    'projectsTitle', 'مشاريع منفذة في المملكة',
    'projectsTag', 'وادي الدواسر - 2026',
    'projects', jsonb_build_array(
      jsonb_build_object('hp', '500 HP', 'img', 'assets/portfolio/project-500hp.jpg', 'title', 'منظومة ري زراعي بالطاقة الشمسية', 'place', 'وادي الدواسر - 2026', 'desc', 'مشروع عالي القدرة لتقليل تكلفة تشغيل مضخات الديزل وتحسين استقرار التشغيل.', 'tags', jsonb_build_array('استثمار 720,000 ريال', 'استرداد تقريبي 10 أشهر')),
      jsonb_build_object('hp', '200 HP', 'img', 'assets/portfolio/project-200hp.jpg', 'title', 'منظومة ري زراعي بالطاقة الشمسية', 'place', 'وادي الدواسر - 2026', 'desc', 'تصميم وتنفيذ منظومة ضخ شمسي بقدرة متوسطة لخدمة احتياج ري يومي مستمر.', 'tags', jsonb_build_array('EPC', 'تشغيل زراعي')),
      jsonb_build_object('hp', '125 HP', 'img', 'assets/portfolio/project-125hp.jpg', 'title', 'منظومة ري زراعي بالطاقة الشمسية', 'place', 'وادي الدواسر - 2026', 'desc', 'حل هندسي موجه للمزارع التي تحتاج تكلفة طاقة يمكن التنبؤ بها على المدى الطويل.', 'tags', jsonb_build_array('تصميم', 'توريد وتركيب')),
      jsonb_build_object('hp', '60 HP', 'img', 'assets/portfolio/project-60hp-a.jpg', 'title', 'منظومة ري زراعي بالطاقة الشمسية', 'place', 'وادي الدواسر - 2026', 'desc', 'حالة أعمال حققت تخفيضًا ملموسًا في تكلفة الوقود الشهرية للمزرعة.', 'tags', jsonb_build_array('استثمار 85,000 ريال', 'استرداد تقريبي 9 أشهر')),
      jsonb_build_object('hp', '60 HP', 'img', 'assets/portfolio/project-60hp-b.jpg', 'title', 'منظومة ري زراعي بالطاقة الشمسية', 'place', 'وادي الدواسر - 2026', 'desc', 'تنفيذ منظومة شمسية للري مع اختبار وتشغيل وتسليم فني للموقع.', 'tags', jsonb_build_array('اختبار وتشغيل', 'دعم فني'))
    ),
    'roiCases', jsonb_build_array(
      jsonb_build_object('v', '60 HP', 'l', 'تكلفة ديزل شهرية 10-12 ألف ريال، استرداد تقريبي 9 أشهر.'),
      jsonb_build_object('v', '500 HP', 'l', 'تكلفة ديزل شهرية تقارب 75 ألف ريال، استرداد تقريبي 10 أشهر.')
    ),
    'partners', jsonb_build_array(
      jsonb_build_object('name', 'SUNARABIA', 'img', 'assets/portfolio/partner-sunarabia.png'),
      jsonb_build_object('name', 'AFKARCO', 'img', 'assets/portfolio/partner-afkarco.png'),
      jsonb_build_object('name', 'VEICHI', 'img', 'assets/portfolio/partner-veichi.png'),
      jsonb_build_object('name', 'RISEN', 'img', 'assets/portfolio/partner-risen.png'),
      jsonb_build_object('name', 'JA Solar', 'img', 'assets/portfolio/partner-ja-solar.png'),
      jsonb_build_object('name', 'LEADER', 'img', 'assets/portfolio/partner-leader.png')
    )
  ),
  true
)
where id = 1 and (data->'portfolio') is null;
