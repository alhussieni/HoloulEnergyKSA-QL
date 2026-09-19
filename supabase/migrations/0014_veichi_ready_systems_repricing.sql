-- ============================================================================
-- Re-prices all 9 readyOffgridSystems (seeded in 0013) using VEICHI
-- equipment pulled from the real productCatalog, instead of the original
-- OSSUN-flyer brands (هويمايلز / كيوصن). Applied directly on the live DB on
-- 2026-07-21; this file documents that change so a fresh deploy ends up with
-- the same data GitHub/production actually has.
--
-- BUSINESS DECISIONS BAKED INTO THESE NUMBERS (confirmed by the business
-- owner in conversation, not assumed by the AI):
--   - Materials-only pricing: NO install cost, NO steel structure/chassis
--     line item. Only panels + inverter + battery + a flat cabling estimate.
--   - Every system's price went UP after this swap (+13% to +117%), purely
--     because VEICHI lithium batteries cost more than the lead-acid/gel
--     batteries the small systems (المدهال and below) used to ship with.
--     This is a real technology change for those 5 systems, not a margin
--     decision — flagged explicitly in each row's "notes" field below.
--
-- ASSUMPTIONS the business owner has NOT explicitly confirmed (still worth a
-- second look before treating these as final client-facing prices):
--   - The old dry/gel batteries were assumed 12V per unit to convert their
--     Ah rating into an equivalent kWh target for picking a VEICHI lithium
--     module. If they were actually 24V, the sizing/pricing below is off.
--   - Panel swapped to Aiko 665W (the only panel in D.panels with a real
--     price) at a panel COUNT recomputed to preserve each system's original
--     total wattage — only "الراعي" changed count (2 -> 1) as a result.
--   - Cabling cost uses the flat D.offgrid.cablingFixedSell estimate, not
--     an itemized recount of each system's original cable/connector list.
--
-- Inverter/battery model selection excludes VLT/VHT/"Rack" rows from
-- productCatalog's "شواحن/انفرترات هجين MPPT" category — those are
-- industrial pump VFDs and a DC busbar rack that got lumped into the same
-- category by mistake, not actual hybrid solar+battery inverters. See the
-- pickCatalogInverter() fix in index.ts (same fix applied there).
--
-- The admin panel (لوحة التحكم -> منظومات أوف-جريد جاهزة) now lets an admin
-- pick a different inverter/battery model per system from a live dropdown
-- and recompute the price, so these numbers are a reviewable starting point,
-- not a one-way door.
-- ============================================================================

update public.pricing_config
set data = jsonb_set(data, '{readyOffgridSystems}', jsonb_build_array(

  jsonb_build_object(
    'id',1,'name','ديوانية الدوري','status','متوفر','priceSar',31829,
    'inverterBrand','فيتشي','inverterModel','SISV 8KW (TWIN) MPPT','inverterPowerW',8000,
    'batteryType','ليثيوم','batteryModel','VCLB-10k-w02','batteryUnitCapacity',10.24,'batteryCapacityUnit','kWh','batteryCount',3,
    'panelCount',18,'panelPowerW',665,'panelBrand','Aiko',
    'acType','سبيلت','acCountDay',2,'acPowerDayW',1500,'acHoursDay',8,
    'acCountNight',2,'acPowerNightW',1500,'acHoursNight',6,
    'fridgeCount',1,'fridgePowerW',100,'fridgeHours',24,
    'lampCount',20,'lampPowerW',15,'lampHours',12,
    'otherDevices','شاشة تلفزيون 100 واط - 4 ساعات',
    'cables','60 كيبل 6ML 6م، 4 توصيلات MC4-1، 8 وصلة 35مل مع نهاية كيبل 1م',
    'notes','أُعيد تسعيرها بمعدات فيتشي (توريد خامات فقط، بدون تركيب/شاسيه). السعر القديم كان 27,370 بمعدات هويمايلز.'
  ),

  jsonb_build_object(
    'id',2,'name','مجلس المقناص','status','متوفر','priceSar',25360,
    'inverterBrand','فيتشي','inverterModel','SISV 8KW (TWIN) MPPT','inverterPowerW',8000,
    'batteryType','ليثيوم','batteryModel','VCLB-10k-w02','batteryUnitCapacity',10.24,'batteryCapacityUnit','kWh','batteryCount',2,
    'panelCount',18,'panelPowerW',665,'panelBrand','Aiko',
    'acType','سبيلت','acCountDay',2,'acPowerDayW',1500,'acHoursDay',8,
    'acCountNight',1,'acPowerNightW',1500,'acHoursNight',6,
    'fridgeCount',1,'fridgePowerW',100,'fridgeHours',24,
    'lampCount',10,'lampPowerW',15,'lampHours',12,
    'otherDevices','',
    'cables','60 كيبل 6ML 6م، 4 توصيلات MC4-1، 6 وصلة 35مل مع نهاية كيبل 1م',
    'notes','أُعيد تسعيرها بمعدات فيتشي (توريد خامات فقط). السعر القديم كان 22,345.'
  ),

  jsonb_build_object(
    'id',3,'name','غرفة السكن','status','متوفر','priceSar',18760,
    'inverterBrand','فيتشي','inverterModel','SISV 6.2KW (TWIN) MPPT','inverterPowerW',6200,
    'batteryType','ليثيوم','batteryModel','VCLB-5k-w01','batteryUnitCapacity',5.12,'batteryCapacityUnit','kWh','batteryCount',3,
    'panelCount',10,'panelPowerW',665,'panelBrand','Aiko',
    'acType','سبيلت','acCountDay',1,'acPowerDayW',1500,'acHoursDay',8,
    'acCountNight',1,'acPowerNightW',1500,'acHoursNight',6,
    'fridgeCount',1,'fridgePowerW',100,'fridgeHours',24,
    'lampCount',15,'lampPowerW',15,'lampHours',8,
    'otherDevices','',
    'cables','40 كيبل 6ML 6م، 2 توصيلات MC4-1، 8م كيبل 35مل أحمر وأسود',
    'notes','أُعيد تسعيرها بمعدات فيتشي (توريد خامات فقط). السعر القديم كان 14,285.'
  ),

  jsonb_build_object(
    'id',4,'name','غرفة المشراق','status','متوفر','priceSar',13129,
    'inverterBrand','فيتشي','inverterModel','SISV 6.2KW (TWIN) MPPT','inverterPowerW',6200,
    'batteryType','ليثيوم','batteryModel','VCLB-10k-w02','batteryUnitCapacity',10.24,'batteryCapacityUnit','kWh','batteryCount',1,
    'panelCount',8,'panelPowerW',665,'panelBrand','Aiko',
    'acType','سبيلت نهارًا + صحراوي ليلاً','acCountDay',1,'acPowerDayW',1000,'acHoursDay',6,
    'acCountNight',1,'acPowerNightW',100,'acHoursNight',7,
    'fridgeCount',1,'fridgePowerW',100,'fridgeHours',24,
    'lampCount',10,'lampPowerW',15,'lampHours',12,
    'otherDevices','',
    'cables','30 كيبل 6ML 6م، 2 توصيلات MC4-1، 6 وصلة 35مل مع نهاية كيبل 1م',
    'notes','أُعيد تسعيرها بمعدات فيتشي. السعر القديم كان 10,900. مصحّحة سابقًا: جهازا تبريد مختلفان (سبيلت نهارًا / صحراوي أضعف ليلاً).'
  ),

  jsonb_build_object(
    'id',5,'name','كرفان المدهال','status','متوفر','priceSar',11642,
    'inverterBrand','فيتشي','inverterModel','SISV-24V 4.2KW (TWIN) MPPT','inverterPowerW',4200,
    'batteryType','ليثيوم','batteryModel','VCLB-5.1K-200-Li','batteryUnitCapacity',5.12,'batteryCapacityUnit','kWh','batteryCount',2,
    'panelCount',6,'panelPowerW',665,'panelBrand','Aiko',
    'acType','سبيلت (نهارًا فقط)','acCountDay',1,'acPowerDayW',1500,'acHoursDay',8,
    'acCountNight',0,'acPowerNightW',0,'acHoursNight',0,
    'fridgeCount',1,'fridgePowerW',100,'fridgeHours',24,
    'lampCount',10,'lampPowerW',10,'lampHours',6,
    'otherDevices','',
    'cables','20 كيبل 6ML 6م، 1 توصيلات MC4-1، 1 وصلة 35مل مع نهاية كيبل 1م',
    'notes','أُعيد تسعيرها بمعدات فيتشي: تحول تقني من بطارية جافة (200Ah) لليثيوم — السعر القديم كان 7,210 بفرق +61%. افتراض: البطارية الجافة القديمة كانت 12V.'
  ),

  jsonb_build_object(
    'id',6,'name','المخيم الاقتصادي','status','متوفر','priceSar',11148,
    'inverterBrand','فيتشي','inverterModel','SIS-24V 3KW MPPT','inverterPowerW',3000,
    'batteryType','ليثيوم','batteryModel','VCLB-5.1K-200-Li','batteryUnitCapacity',5.12,'batteryCapacityUnit','kWh','batteryCount',2,
    'panelCount',5,'panelPowerW',665,'panelBrand','Aiko',
    'acType','صحراوي','acCountDay',1,'acPowerDayW',100,'acHoursDay',8,
    'acCountNight',1,'acPowerNightW',100,'acHoursNight',6,
    'fridgeCount',1,'fridgePowerW',100,'fridgeHours',24,
    'lampCount',15,'lampPowerW',10,'lampHours',6,
    'otherDevices','',
    'cables','20 كيبل 6ML 6م، 1 توصيلات MC4-1، 1 وصلة 35مل مع نهاية كيبل 1م',
    'notes','أُعيد تسعيرها بمعدات فيتشي: تحول من بطارية جافة لليثيوم — السعر القديم كان 6,200 بفرق +80%. افتراض: البطارية الجافة القديمة كانت 12V. 15 لمبة × 10 واط = 150 واط، مؤكَّد من العميل سابقًا.'
  ),

  jsonb_build_object(
    'id',7,'name','المخيم الصغير','status','متوفر','priceSar',8130,
    'inverterBrand','فيتشي','inverterModel','SIS-24V 3KW MPPT','inverterPowerW',3000,
    'batteryType','ليثيوم','batteryModel','VCLB-5.1K-200-Li','batteryUnitCapacity',5.12,'batteryCapacityUnit','kWh','batteryCount',1,
    'panelCount',5,'panelPowerW',665,'panelBrand','Aiko',
    'acType','صحراوي (نهارًا فقط)','acCountDay',1,'acPowerDayW',200,'acHoursDay',8,
    'acCountNight',0,'acPowerNightW',0,'acHoursNight',0,
    'fridgeCount',1,'fridgePowerW',100,'fridgeHours',24,
    'lampCount',10,'lampPowerW',10,'lampHours',8,
    'otherDevices','',
    'cables','20 كيبل 6ML 6م، 1 توصيلات MC4-1، 1 وصلة 35مل مع نهاية كيبل 1م',
    'notes','أُعيد تسعيرها بمعدات فيتشي. السعر القديم كان 5,145 بفرق +58%. افتراض: البطارية الجافة القديمة كانت 12V.'
  ),

  jsonb_build_object(
    'id',8,'name','مكشات','status','متوفر','priceSar',7705,
    'inverterBrand','فيتشي','inverterModel','SIS-24V 3KW MPPT','inverterPowerW',3000,
    'batteryType','ليثيوم','batteryModel','VCLB-5.1K-200-Li','batteryUnitCapacity',5.12,'batteryCapacityUnit','kWh','batteryCount',1,
    'panelCount',4,'panelPowerW',665,'panelBrand','Aiko',
    'acType','لا يوجد','acCountDay',0,'acPowerDayW',0,'acHoursDay',0,
    'acCountNight',0,'acPowerNightW',0,'acHoursNight',0,
    'fridgeCount',1,'fridgePowerW',100,'fridgeHours',24,
    'lampCount',10,'lampPowerW',10,'lampHours',8,
    'otherDevices','',
    'cables','20 كيبل 6ML 6م، 1 توصيلات MC4-1، 1 وصلة 35مل مع نهاية كيبل 1م',
    'notes','أُعيد تسعيرها بمعدات فيتشي. السعر القديم كان 4,315 بفرق +79%. لا يوجد مكيف في هذه المنظومة إطلاقًا - غير مناسبة لعميل محتاج تبريد.'
  ),

  jsonb_build_object(
    'id',9,'name','الراعي','status','نفدت الكمية','priceSar',3159,
    'inverterBrand','لا يوجد (منظم شحن كيوصن 20A فقط)','inverterModel',null,'inverterPowerW',0,
    'batteryType','ليثيوم','batteryModel','VCLB-1.2K-100-Li','batteryUnitCapacity',1.28,'batteryCapacityUnit','kWh','batteryCount',1,
    'panelCount',1,'panelPowerW',665,'panelBrand','Aiko',
    'acType','لا يوجد','acCountDay',0,'acPowerDayW',0,'acHoursDay',0,
    'acCountNight',0,'acPowerNightW',0,'acHoursNight',0,
    'fridgeCount',0,'fridgePowerW',0,'fridgeHours',0,
    'lampCount',1,'lampPowerW',10,'lampHours',8,
    'otherDevices','شاحن جوال (بدون تفاصيل قدرة)',
    'cables','10 كيبل 6ML 6م، 1 توصيلات MC4-1، 1 وصلة 35مل مع نهاية كيبل 1م',
    'notes','أُعيد تسعيرها بمعدات فيتشي: تحول من بطارية جافة لليثيوم — السعر القديم كان 1,453 بفرق +117%. لا يوجد إنفرتر أصلاً (منظم شحن فقط)، فرق السعر بالكامل من البطارية.'
  )

));
