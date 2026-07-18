-- ============================================================================
-- Product detail enrichment — VEICHI accessories
-- ("إكسسوارات VEICHI" category, index 2, all 38 rows).
--
-- Important difference from the other 0007–0010 seeds: reactors, PV combiner
-- boxes, MC4 connectors, DC breakers (MCCB) and fuses are standardized,
-- generic electrical components — we could not find dedicated VEICHI product
-- pages for these on veichi.com (they don't appear to be a distinct VEICHI
-- R&D line the way the inverters/batteries are). So instead of citing an
-- "official VEICHI spec sheet" per row, this seed gives each row its own
-- accurate, standard electrical-engineering description of what that
-- component does and what its rating means — grounded in real electrical
-- practice, not fabricated brand claims.
--
-- Safe to re-run: MERGES (||) into whatever productDetails already exists
-- per row, so it won't erase an image or "available" flag already set.
-- ============================================================================

do $do$
declare
  r record;
  desc_text text;
  spec_extra jsonb;
begin
  for r in
    select * from (values
      -- idx, kind, rating_label, extra_label (impedance % / input count / voltage)
      (0,  'reactor', '16',   '1'),
      (1,  'reactor', '28',   '1'),
      (2,  'reactor', '50',   '1'),
      (3,  'reactor', '80',   '1'),
      (4,  'reactor', '100',  '1'),
      (5,  'reactor', '160',  '1'),
      (6,  'reactor', '224',  '1'),
      (7,  'reactor', '315',  '1'),
      (8,  'reactor', '450',  '1'),
      (9,  'reactor', '560',  '1'),
      (10, 'reactor', '690',  '1'),
      (11, 'reactor', '1000', '1'),
      (12, 'reactor', '1250', '1'),
      (13, 'reactor', '560',  '4'),
      (14, 'reactor', '1000', '4'),
      (15, 'reactor', '1250', '4'),
      (16, 'combiner', '4',  ''),
      (17, 'combiner', '8',  ''),
      (18, 'combiner', '10', ''),
      (19, 'combiner', '16', ''),
      (20, 'combiner', '22', ''),
      (21, 'combiner', '30', ''),
      (22, 'mc4_single', '1500', ''),
      (23, 'mc4_dual',   '1000', ''),
      (24, 'mc4_dual',   '1500', ''),
      (25, 'mccb', '100', ''),
      (26, 'mccb', '125', ''),
      (27, 'mccb', '160', ''),
      (28, 'mccb', '200', ''),
      (29, 'mccb', '250', ''),
      (30, 'mccb', '280', ''),
      (31, 'mccb', '400', ''),
      (32, 'mccb', '500', ''),
      (33, 'mccb', '630', ''),
      (34, 'fuse', '20', ''),
      (35, 'fuse', '25', ''),
      (36, 'fuse', '32', ''),
      (37, 'holder', '32', '')
    ) as t(idx, kind, rating_label, extra_label)
  loop

    if r.kind = 'reactor' then
      desc_text := format(
        'مفاعل تخانق (Line Reactor) بتيار مقنن %s أمبير ونسبة معاوقة %s%%، يُركّب على التوالي بين مصدر الطاقة والانفرتر لتقليل التوافقيات الكهربائية (Harmonics) والحد من تيار الاندفاع (Inrush Current) عند بدء التشغيل، مما يطيل عمر مكونات الانفرتر ويقلل التداخل الكهرومغناطيسي. %s',
        r.rating_label, r.extra_label,
        case when r.extra_label = '4' then 'فئة 4%% توفر تصفية توافقيات أعلى من فئة 1%%، وتُفضَّل مع المولدات أو الشبكات ضعيفة الاستقرار.' else 'فئة 1%% هي الأشيع للاستخدام المنزلي/التجاري القياسي.' end
      );
      spec_extra := jsonb_build_object(
        'التيار المقنن', r.rating_label || ' أمبير',
        'نسبة المعاوقة (Impedance)', r.extra_label || '%',
        'الوظيفة', 'تقليل التوافقيات (THD) والحد من تيار الاندفاع',
        'موضع التركيب المعتاد', 'على التوالي بين المصدر والانفرتر (AC أو DC حسب التصميم)'
      );

    elsif r.kind = 'combiner' then
      desc_text := format(
        'صندوق تجميع (PV Combiner Box) يدمج %s سلسلة من الألواح الشمسية (%s موجب + %s سالب) في مخرج واحد، ويحتوي عادة على فيوزات حماية لكل سلسلة على حدة ومانع صواعق (SPD)، مما يقلل عدد الكابلات الواصلة للانفرتر ويسهّل العزل عند الأعطال أو الصيانة.',
        r.rating_label, r.rating_label, r.rating_label
      );
      spec_extra := jsonb_build_object(
        'عدد مداخل السلاسل', r.rating_label || '+' || r.rating_label || ' (موجب/سالب)',
        'الوظيفة', 'تجميع تيار عدة سلاسل من الألواح الشمسية في مخرج واحد',
        'الحماية المعتادة', 'فيوز DC لكل سلسلة + مانع صواعق (SPD)',
        'درجة الحماية المعتادة', 'IP65 (تركيب خارجي)'
      );

    elsif r.kind = 'mc4_single' then
      desc_text := format(
        'موصل MC4 أحادي (زوج ذكر/أنثى) لتوصيل كابلات الألواح الشمسية بالتيار المستمر، بجهد تشغيل أقصى %s فولت، معياري ومتوافق مع أغلب الألواح والكابلات الحديثة، ومصمم ليكون مقاومًا للماء والأشعة فوق البنفسجية للتركيب الخارجي طويل الأمد.',
        r.rating_label
      );
      spec_extra := jsonb_build_object(
        'أقصى جهد تشغيل', r.rating_label || ' فولت DC',
        'النوع', 'موصل أحادي القطب (ذكر/أنثى) قياسي',
        'الاستخدام', 'توصيل كابل لوح شمسي واحد بالتسلسل'
      );

    elsif r.kind = 'mc4_dual' then
      desc_text := format(
        'موصل MC4 مزدوج النواة (وصلة Y) يُستخدم لدمج فرعين من الألواح الشمسية في خط توصيل واحد (توصيل توازي)، بجهد تشغيل أقصى %s فولت، ويقلل عدد الكابلات الرئيسية الواصلة لصندوق التجميع أو الانفرتر.',
        r.rating_label
      );
      spec_extra := jsonb_build_object(
        'أقصى جهد تشغيل', r.rating_label || ' فولت DC',
        'النوع', 'موصل مزدوج (Y-connector) لدمج فرعين توازي',
        'الاستخدام', 'دمج فرعين من سلاسل الألواح في كابل رئيسي واحد'
      );

    elsif r.kind = 'mccb' then
      desc_text := format(
        'قاطع دائرة مصبوب (MCCB) مخصص للتيار المستمر (DC) بتيار مقنن %s أمبير وجهد عزل أقصى 1000 فولت DC، يحمي دائرة الألواح الشمسية أو الانفرتر من التيار الزائد وقصر الدائرة، ويعمل أيضًا كمفتاح فصل يدوي لعزل الدائرة بأمان أثناء الصيانة.',
        r.rating_label
      );
      spec_extra := jsonb_build_object(
        'التيار المقنن', r.rating_label || ' أمبير',
        'أقصى جهد عزل', '1000 فولت DC',
        'الوظيفة', 'حماية من التيار الزائد وقصر الدائرة + فصل يدوي للعزل',
        'عدد الأقطاب المعتاد', '2P (قطبين) لدوائر DC'
      );

    else -- fuse / holder
      if r.kind = 'fuse' then
        desc_text := format(
          'فيوز (مصهر) حماية للتيار المستمر بتيار مقنن %s أمبير وجهد أقصى 1000 فولت DC، يقطع الدائرة بالانصهار عند تجاوز التيار الحد الآمن، ويُركَّب عادة داخل صندوق التجميع لحماية كل سلسلة ألواح على حدة.',
          r.rating_label
        );
        spec_extra := jsonb_build_object(
          'التيار المقنن', r.rating_label || ' أمبير',
          'أقصى جهد', '1000 فولت DC',
          'الوظيفة', 'حماية سلسلة الألواح من التيار الزائد بالانصهار عند التجاوز'
        );
      else
        desc_text := 'حامل فيوز (Fuse Holder) بتيار مقنن 32 أمبير، يُستخدم لتركيب وتثبيت الفيوزات داخل صندوق التجميع بشكل آمن وقابل للاستبدال بسهولة عند الحاجة.';
        spec_extra := jsonb_build_object(
          'التيار المقنن', '32 أمبير',
          'الوظيفة', 'تركيب وتثبيت الفيوز بشكل آمن وقابل للاستبدال'
        );
      end if;
    end if;

    update public.pricing_config
    set data = jsonb_set(
      data,
      array['productCatalog','2','productDetails', r.idx::text],
      coalesce(data->'productCatalog'->2->'productDetails'->r.idx::text, '{}'::jsonb) || jsonb_build_object(
        'description', desc_text,
        'specs', spec_extra
      ),
      true
    )
    where id = 1;

  end loop;
end;
$do$;
