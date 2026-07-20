-- ============================================================================
-- Fixes the missing backend for the off-grid / on-grid calculator tabs, and
-- adds the "ready-made off-grid packages" browsing feature.
--
-- BUG THIS FIXES: index.html already calls the actions "offgrid-quote",
-- "offgrid-admin-view", "ongrid-quote", "ongrid-admin-view" — but index.ts
-- never had a handler for any of them, so those calls always failed.
--
-- NOTE ON THIS PROJECT SPECIFICALLY: pricing_config already had real
-- "offgrid"/"ongrid" config rows (seeded ahead of the handler code — likely
-- by hand, before this file existed). The two guarded blocks below
-- (`and not (data ? 'offgrid')` / `'ongrid'`) correctly no-op against that
-- real data on this database; they only matter for a fresh deploy that has
-- neither key yet. Ran against the live DB on 2026-07-20: offgrid/ongrid
-- blocks no-opped as expected, only readyOffgridSystems was inserted (9
-- rows). Do not assume the placeholder numbers below are what's live —
-- check the admin panel (لوحة التحكم) for the real configured values.
--
-- Inverter/battery pricing for both calculators is pulled from the existing
-- productCatalog categories ("شواحن/انفرترات هجين MPPT" and "بطاريات ليثيوم")
-- seeded in 0004_product_catalog.sql — verified against the live data:
-- battery rows at 51.2V (5k/10k/15k modules) and inverter rows with "KW" in
-- the model name both parse and price correctly.
--
-- Safe to run even if already deployed: each key is only added if missing.
-- ============================================================================

update public.pricing_config
set data = data || jsonb_build_object(
  'offgrid', jsonb_build_object(
    'sunHours', 5.5,
    'systemEfficiency', 0.80,
    'batteryDoD', 0.90,
    'defaultAutonomyDays', 1,
    'peakLoadDivisor', 6,
    'batteryMarkupPct', 30,
    'inverterMarkupPct', 30,
    'structurePerPanelCost', 250,
    'structurePerPanelSell', 350,
    'cablingFixedCost', 800,
    'cablingFixedSell', 1200,
    'installPerKwCost', 150,
    'installPerKwSell', 250
  )
)
where id = 1
  and not (data ? 'offgrid');

update public.pricing_config
set data = data || jsonb_build_object(
  'ongrid', jsonb_build_object(
    'sunHours', 5.5,
    'performanceRatio', 0.80,
    'tariffRate', 0.18,
    'inverterMarkupPct', 30,
    'structurePerPanelCost', 250,
    'structurePerPanelSell', 350,
    'cablingFixedCost', 800,
    'cablingFixedSell', 1200,
    'netMeteringFeeCost', 0,
    'netMeteringFeeSell', 0,
    'installPerKwCost', 150,
    'installPerKwSell', 250
  )
)
where id = 1
  and not (data ? 'ongrid');

-- ----------------------------------------------------------------------------
-- Ready-made off-grid packages — fixed named systems a rep/client browses and
-- picks from directly (no sizing calculation). "name" is the only field meant
-- to be edited routinely from the admin panel; everything else documents the
-- real load the package was built for.
--
-- Data notes (flagged, not silently resolved):
--  - "غرفة المشراق": corrected from an earlier assumption of one AC unit
--    running both day and night. It is actually two different devices: a
--    1000W split AC by day (6h) and a separate 100W desert cooler by night
--    (7h) — lower power, different technology.
--  - "المخيم الاقتصادي": lamp count is 15, not 10 (10 lamps x 10W = 100W
--    would not match the vendor's stated 150W total; 15 x 10W = 150W does).
--  - "مكشات": has no AC unit at all — not suitable for a client who needs
--    cooling; don't let it surface as a weak cooling option in any filter.
--  - "الراعي": has no inverter, only a 20A charge controller, and no fridge.
--    Out of stock at time of entry (status below).
-- ----------------------------------------------------------------------------

update public.pricing_config
set data = data || jsonb_build_object(
  'readyOffgridSystems', jsonb_build_array(

    jsonb_build_object(
      'id',1,'name','ديوانية الدوري','status','متوفر','priceSar',27370,
      'inverterBrand','هويمايلز','inverterPowerW',8000,
      'batteryType','ليثيوم','batteryUnitCapacity',10,'batteryCapacityUnit','kWh','batteryCount',3,
      'panelCount',18,'panelPowerW',640,
      'acType','سبيلت','acCountDay',2,'acPowerDayW',1500,'acHoursDay',8,
      'acCountNight',2,'acPowerNightW',1500,'acHoursNight',6,
      'fridgeCount',1,'fridgePowerW',100,'fridgeHours',24,
      'lampCount',20,'lampPowerW',15,'lampHours',12,
      'otherDevices','شاشة تلفزيون 100 واط - 4 ساعات',
      'cables','60 كيبل 6ML 6م، 4 توصيلات MC4-1، 8 وصلة 35مل مع نهاية كيبل 1م',
      'notes',''
    ),

    jsonb_build_object(
      'id',2,'name','مجلس المقناص','status','متوفر','priceSar',22345,
      'inverterBrand','هويمايلز','inverterPowerW',8000,
      'batteryType','ليثيوم','batteryUnitCapacity',10,'batteryCapacityUnit','kWh','batteryCount',2,
      'panelCount',18,'panelPowerW',640,
      'acType','سبيلت','acCountDay',2,'acPowerDayW',1500,'acHoursDay',8,
      'acCountNight',1,'acPowerNightW',1500,'acHoursNight',6,
      'fridgeCount',1,'fridgePowerW',100,'fridgeHours',24,
      'lampCount',10,'lampPowerW',15,'lampHours',12,
      'otherDevices','',
      'cables','60 كيبل 6ML 6م، 4 توصيلات MC4-1، 6 وصلة 35مل مع نهاية كيبل 1م',
      'notes',''
    ),

    jsonb_build_object(
      'id',3,'name','غرفة السكن','status','متوفر','priceSar',14285,
      'inverterBrand','هويمايلز','inverterPowerW',6000,
      'batteryType','ليثيوم','batteryUnitCapacity',5,'batteryCapacityUnit','kWh','batteryCount',3,
      'panelCount',10,'panelPowerW',640,
      'acType','سبيلت','acCountDay',1,'acPowerDayW',1500,'acHoursDay',8,
      'acCountNight',1,'acPowerNightW',1500,'acHoursNight',6,
      'fridgeCount',1,'fridgePowerW',100,'fridgeHours',24,
      'lampCount',15,'lampPowerW',15,'lampHours',8,
      'otherDevices','',
      'cables','40 كيبل 6ML 6م، 2 توصيلات MC4-1، 8م كيبل 35مل أحمر وأسود',
      'notes',''
    ),

    jsonb_build_object(
      'id',4,'name','غرفة المشراق','status','متوفر','priceSar',10900,
      'inverterBrand','هويمايلز','inverterPowerW',6000,
      'batteryType','ليثيوم','batteryUnitCapacity',5,'batteryCapacityUnit','kWh','batteryCount',2,
      'panelCount',8,'panelPowerW',640,
      'acType','سبيلت نهارًا + صحراوي ليلاً','acCountDay',1,'acPowerDayW',1000,'acHoursDay',6,
      'acCountNight',1,'acPowerNightW',100,'acHoursNight',7,
      'fridgeCount',1,'fridgePowerW',100,'fridgeHours',24,
      'lampCount',10,'lampPowerW',15,'lampHours',12,
      'otherDevices','',
      'cables','30 كيبل 6ML 6م، 2 توصيلات MC4-1، 6 وصلة 35مل مع نهاية كيبل 1م',
      'notes','مصحّحة: جهازا تبريد مختلفان (سبيلت نهارًا / صحراوي أضعف ليلاً)، مش جهاز واحد.'
    ),

    jsonb_build_object(
      'id',5,'name','كرفان المدهال','status','متوفر','priceSar',7210,
      'inverterBrand','كيوصن','inverterPowerW',4000,
      'batteryType','جافة','batteryUnitCapacity',200,'batteryCapacityUnit','Ah','batteryCount',4,
      'panelCount',6,'panelPowerW',640,
      'acType','سبيلت (نهارًا فقط)','acCountDay',1,'acPowerDayW',1500,'acHoursDay',8,
      'acCountNight',0,'acPowerNightW',0,'acHoursNight',0,
      'fridgeCount',1,'fridgePowerW',100,'fridgeHours',24,
      'lampCount',10,'lampPowerW',10,'lampHours',6,
      'otherDevices','',
      'cables','20 كيبل 6ML 6م، 1 توصيلات MC4-1، 1 وصلة 35مل مع نهاية كيبل 1م',
      'notes',''
    ),

    jsonb_build_object(
      'id',6,'name','المخيم الاقتصادي','status','متوفر','priceSar',6200,
      'inverterBrand','كيوصن','inverterPowerW',2500,
      'batteryType','جافة','batteryUnitCapacity',200,'batteryCapacityUnit','Ah','batteryCount',4,
      'panelCount',5,'panelPowerW',640,
      'acType','صحراوي','acCountDay',1,'acPowerDayW',100,'acHoursDay',8,
      'acCountNight',1,'acPowerNightW',100,'acHoursNight',6,
      'fridgeCount',1,'fridgePowerW',100,'fridgeHours',24,
      'lampCount',15,'lampPowerW',10,'lampHours',6,
      'otherDevices','',
      'cables','20 كيبل 6ML 6م، 1 توصيلات MC4-1، 1 وصلة 35مل مع نهاية كيبل 1م',
      'notes','15 لمبة × 10 واط = 150 واط، مؤكَّد من العميل.'
    ),

    jsonb_build_object(
      'id',7,'name','المخيم الصغير','status','متوفر','priceSar',5145,
      'inverterBrand','كيوصن','inverterPowerW',3000,
      'batteryType','جافة','batteryUnitCapacity',200,'batteryCapacityUnit','Ah','batteryCount',2,
      'panelCount',5,'panelPowerW',640,
      'acType','صحراوي (نهارًا فقط)','acCountDay',1,'acPowerDayW',200,'acHoursDay',8,
      'acCountNight',0,'acPowerNightW',0,'acHoursNight',0,
      'fridgeCount',1,'fridgePowerW',100,'fridgeHours',24,
      'lampCount',10,'lampPowerW',10,'lampHours',8,
      'otherDevices','',
      'cables','20 كيبل 6ML 6م، 1 توصيلات MC4-1، 1 وصلة 35مل مع نهاية كيبل 1م',
      'notes',''
    ),

    jsonb_build_object(
      'id',8,'name','مكشات','status','متوفر','priceSar',4315,
      'inverterBrand','كيوصن','inverterPowerW',2500,
      'batteryType','جافة','batteryUnitCapacity',200,'batteryCapacityUnit','Ah','batteryCount',2,
      'panelCount',4,'panelPowerW',640,
      'acType','لا يوجد','acCountDay',0,'acPowerDayW',0,'acHoursDay',0,
      'acCountNight',0,'acPowerNightW',0,'acHoursNight',0,
      'fridgeCount',1,'fridgePowerW',100,'fridgeHours',24,
      'lampCount',10,'lampPowerW',10,'lampHours',8,
      'otherDevices','',
      'cables','20 كيبل 6ML 6م، 1 توصيلات MC4-1، 1 وصلة 35مل مع نهاية كيبل 1م',
      'notes','لا يوجد مكيف في هذه المنظومة إطلاقًا - غير مناسبة لعميل محتاج تبريد.'
    ),

    jsonb_build_object(
      'id',9,'name','الراعي','status','نفدت الكمية','priceSar',1453,
      'inverterBrand','لا يوجد (منظم شحن كيوصن 20A فقط)','inverterPowerW',0,
      'batteryType','جافة','batteryUnitCapacity',100,'batteryCapacityUnit','Ah','batteryCount',1,
      'panelCount',2,'panelPowerW',245,
      'acType','لا يوجد','acCountDay',0,'acPowerDayW',0,'acHoursDay',0,
      'acCountNight',0,'acPowerNightW',0,'acHoursNight',0,
      'fridgeCount',0,'fridgePowerW',0,'fridgeHours',0,
      'lampCount',1,'lampPowerW',10,'lampHours',8,
      'otherDevices','شاحن جوال (بدون تفاصيل قدرة)',
      'cables','10 كيبل 6ML 6م، 1 توصيلات MC4-1، 1 وصلة 35مل مع نهاية كيبل 1م',
      'notes','لا يوجد إنفرتر - منظم شحن فقط. غير مناسبة لأي حمل AC. لا ثلاجة ولا مكيف.'
    )

  )
)
where id = 1
  and not (data ? 'readyOffgridSystems');
