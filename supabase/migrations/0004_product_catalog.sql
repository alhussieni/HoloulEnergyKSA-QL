-- ============================================================================
-- Product catalog — reference list prices for standalone product sales
-- (batteries, hybrid inverters, accessories, pump inverters...). This is
-- completely separate from the discounted rates used inside the Quote Line
-- pricing engine — these are full list prices reps use to answer ad-hoc
-- "how much does X cost" questions, or to quote off-grid components.
--
-- Safe to run even if already deployed: only adds the field if missing.
-- ============================================================================

update public.pricing_config
set data = data || jsonb_build_object(
  'productCatalog',
  jsonb_build_array(

    jsonb_build_object(
      'category', 'بطاريات ليثيوم',
      'columns', jsonb_build_array('الموديل', 'التيار', 'الفولت', 'السعر', 'السعر شامل الضريبة'),
      'rows', jsonb_build_array(
        jsonb_build_array('VCLB-1.2K-100-Li', '100A', '12.8V', '782', '899'),
        jsonb_build_array('VCLB-2.5K-200-Li', '200A', '12.8V', '1100', '1265'),
        jsonb_build_array('VCLB-2.5K-100-Li', '100A', '25.6V', '1100', '1265'),
        jsonb_build_array('VCLB-5.1K-200-Li', '200A', '25.6V', '2100', '2415'),
        jsonb_build_array('VCLB-5k-w01', '100A', '51.2V', '2609', '3000'),
        jsonb_build_array('VCLB-10k-w02', '200A', '51.2V', '4500', '5175'),
        jsonb_build_array('VCLB-15k-BC', '280A', '51.2V', '5652', '6500')
      )
    ),

    jsonb_build_object(
      'category', 'شواحن/انفرترات هجين MPPT',
      'columns', jsonb_build_array('الموديل', 'التيار (A)', 'أقصى جهد DC', 'السعر', 'السعر شامل الضريبة'),
      'rows', jsonb_build_array(
        jsonb_build_array('SIS4-12V 1KW MPPT', '40A', '150 VDC', '449', '516'),
        jsonb_build_array('SIS4-12V 2KW MPPT', '80A', '400 VDC', '699', '804'),
        jsonb_build_array('SIS-24V 3KW MPPT', '100A', '450 VDC', '999', '1149'),
        jsonb_build_array('SISV-24V 4.2KW (TWIN) MPPT', '120A', '500 VDC', '1049', '1206'),
        jsonb_build_array('SIS 5KW-S MPPT', '100A', '500 VDC', '1149', '1321'),
        jsonb_build_array('SISV 6.2KW (TWIN) MPPT', '120A', '500 VDC', '1199', '1379'),
        jsonb_build_array('SISV 8KW (TWIN) MPPT', '120A', '500 VDC', '2299', '2644'),
        jsonb_build_array('SISV 11KW (TWIN) MPPT', '150A', '500 VDC', '2499', '2874'),
        jsonb_build_array('VLT 10KW 3P IP65', '220A', '800 VDC', '5899', '6784'),
        jsonb_build_array('VLT 12KW 3P IP65', '250A', '800 VDC', '6399', '7359'),
        jsonb_build_array('VLT 15KW 3P IP65', '290A', '800 VDC', '7499', '8624'),
        jsonb_build_array('VHT 20KW IP65', '40A', '1000 VDC', '8499', '9774'),
        jsonb_build_array('VHT 30KW IP65', '100A', '1000 VDC', '15499', '17824'),
        jsonb_build_array('VHT 50KW IP65', '100A', '1000 VDC', '19499', '22424'),
        jsonb_build_array('VCHB-61.4K-STF High Voltage Rack', '1C', '-', '43999', '50599')
      )
    ),

    jsonb_build_object(
      'category', 'إكسسوارات VEICHI',
      'columns', jsonb_build_array('الصنف', 'الوصف', 'السعر', 'السعر شامل الضريبة'),
      'rows', jsonb_build_array(
        jsonb_build_array('VEICHI Reactor 16A', '1%', '296', '340'),
        jsonb_build_array('VEICHI Reactor 28A', '1%', '319', '367'),
        jsonb_build_array('VEICHI Reactor 50A', '1%', '389', '447'),
        jsonb_build_array('VEICHI Reactor 80A', '1%', '479', '551'),
        jsonb_build_array('VEICHI Reactor 100A', '1%', '499', '574'),
        jsonb_build_array('VEICHI Reactor 160A', '1%', '599', '689'),
        jsonb_build_array('VEICHI Reactor 224A', '1%', '839', '965'),
        jsonb_build_array('VEICHI Reactor 315A', '1%', '999', '1149'),
        jsonb_build_array('VEICHI Reactor 450A', '1%', '1374', '1580'),
        jsonb_build_array('VEICHI Reactor 560A', '1%', '1539', '1770'),
        jsonb_build_array('VEICHI Reactor 690A', '1%', '1594', '1833'),
        jsonb_build_array('VEICHI Reactor 1000A', '1%', '2529', '2908'),
        jsonb_build_array('VEICHI Reactor 1250A', '1%', '2999', '3449'),
        jsonb_build_array('VEICHI Reactor 560A', '4%', '4899', '5634'),
        jsonb_build_array('VEICHI Reactor 1000A', '4%', '5799', '6669'),
        jsonb_build_array('VEICHI Reactor 1250A', '4%', '6299', '7244'),
        jsonb_build_array('VEICHI Combiner BOX 04', '4+4 Input', '749', '861'),
        jsonb_build_array('VEICHI Combiner BOX 08', '8+8 Input', '949', '1091'),
        jsonb_build_array('VEICHI Combiner BOX 10', '10+10 Input', '1149', '1321'),
        jsonb_build_array('VEICHI Combiner BOX 16', '16+16 Input', '1649', '1896'),
        jsonb_build_array('VEICHI Combiner BOX 22', '22+22 Input', '2649', '3046'),
        jsonb_build_array('VEICHI Combiner BOX 30', '30+30 Input', '3849', '4426'),
        jsonb_build_array('VEICHI MC4 Single', '1500 VDC', '4', '5'),
        jsonb_build_array('VEICHI MC4 Dual Core', '1000 VDC', '18', '21'),
        jsonb_build_array('VEICHI MC4 Dual Core', '1500 VDC', '22', '25'),
        jsonb_build_array('MCCB DC 100A', '1000 VDC', '139', '159.9'),
        jsonb_build_array('MCCB DC 125A', '1000 VDC', '149', '171.4'),
        jsonb_build_array('MCCB DC 160A', '1000 VDC', '169', '194.4'),
        jsonb_build_array('MCCB DC 200A', '1000 VDC', '189', '217.4'),
        jsonb_build_array('MCCB DC 250A', '1000 VDC', '239', '274.9'),
        jsonb_build_array('MCCB DC 280A', '1000 VDC', '369', '424.4'),
        jsonb_build_array('MCCB DC 400A', '1000 VDC', '799', '918.9'),
        jsonb_build_array('MCCB DC 500A', '1000 VDC', '899', '1033.9'),
        jsonb_build_array('MCCB DC 630A', '1000 VDC', '1099', '1263.9'),
        jsonb_build_array('FUSE 20A', '1000 VDC', '9', '10.4'),
        jsonb_build_array('FUSE 25A', '1000 VDC', '11', '12.7'),
        jsonb_build_array('FUSE 32A', '1000 VDC', '14', '16.1'),
        jsonb_build_array('Holder 32A', '-', '12', '13.8')
      )
    ),

    jsonb_build_object(
      'category', 'انفرتر مضخات VEICHI (مارس 2026)',
      'columns', jsonb_build_array('الموديل', 'أقصى جهد DC', 'التيار المقنن', 'السعر', 'السعر شامل الضريبة'),
      'rows', jsonb_build_array(
        jsonb_build_array('VEICHI PUMP Inverter 2.2KW 1P/3P 220', '450V', '10A', '666', '766'),
        jsonb_build_array('VEICHI PUMP Inverter 4KW 1P/3P 220', '450V', '16A', '799', '919'),
        jsonb_build_array('VEICHI PUMP Inverter 5.5KW 1P/3P 220', '450V', '20A', '1111', '1278'),
        jsonb_build_array('VEICHI PUMP Inverter 7.5KW 1P/3P 220', '450V', '30A', '1666', '1916'),
        jsonb_build_array('VEICHI PUMP Inverter 11KW 1P/3P 220', '450V', '42A', '2444', '2811'),
        jsonb_build_array('VEICHI PUMP Inverter 18.5KW 1P/3P 220', '450V', '70A', '3333', '3833'),
        jsonb_build_array('VEICHI PUMP Inverter 22KW 1P/3P 220', '450V', '80A', '4999', '5749'),
        jsonb_build_array('VEICHI PUMP Inverter 2.2KW', '900V', '6A', '610', '702'),
        jsonb_build_array('VEICHI PUMP Inverter 5.5KW (H)', '900V', '13A', '720', '828'),
        jsonb_build_array('VEICHI PUMP Inverter 7.5KW (H)', '900V', '17A', '999', '1149'),
        jsonb_build_array('VEICHI PUMP Inverter 11KW (H)', '900V', '25A', '1133', '1303'),
        jsonb_build_array('VEICHI PUMP Inverter 18.5KW (H)', '900V', '38A', '1799', '2069'),
        jsonb_build_array('VEICHI PUMP Inverter 22KW (H)', '900V', '45A', '2111', '2428'),
        jsonb_build_array('VEICHI PUMP Inverter 30KW (H)', '900V', '60A', '2777', '3194'),
        jsonb_build_array('VEICHI PUMP Inverter 37KW (H)', '900V', '75A', '3333', '3833'),
        jsonb_build_array('VEICHI PUMP Inverter 55KW (H)', '900V', '110A', '4999', '5749'),
        jsonb_build_array('VEICHI PUMP Inverter 75KW (H)', '900V', '150A', '5777', '6644'),
        jsonb_build_array('VEICHI PUMP Inverter 90KW (H)', '900V', '180A', '7222', '8305'),
        jsonb_build_array('VEICHI PUMP Inverter 110KW (H)', '900V', '210A', '8333', '9583'),
        jsonb_build_array('VEICHI PUMP Inverter 132KW (H)', '900V', '250A', '11222', '12905'),
        jsonb_build_array('VEICHI PUMP Inverter 160KW (H)', '900V', '310A', '12333', '14183'),
        jsonb_build_array('VEICHI PUMP Inverter 200KW (H)', '900V', '380A', '17444', '20061'),
        jsonb_build_array('VEICHI PUMP Inverter 250KW (H)', '900V', '470A', '21111', '24278'),
        jsonb_build_array('VEICHI PUMP Inverter 315KW (H)', '900V', '600A', '22999', '26449'),
        jsonb_build_array('VEICHI PUMP Inverter 355KW (H)', '900V', '670A', '36666', '42166'),
        jsonb_build_array('VEICHI PUMP Inverter 400KW (H)', '900V', '750A', '43333', '49833'),
        jsonb_build_array('VEICHI PUMP Inverter 500KW (H)', '900V', '860A', '49999', '57499'),
        jsonb_build_array('VEICHI PUMP Inverter 560KW (H)', '900V', '990A', '53333', '61333'),
        jsonb_build_array('VEICHI PUMP Inverter 630KW (H)', '900V', '1100A', '73333', '84333'),
        jsonb_build_array('VEICHI PUMP Inverter 710KW (H)', '900V', '1260A', '79999', '91999'),
        jsonb_build_array('VEICHI PUMP Inverter IP65 4KW', '900V', '10A', '999', '1149'),
        jsonb_build_array('VEICHI PUMP Inverter IP65 5.5KW', '900V', '13A', '1055', '1213'),
        jsonb_build_array('VEICHI PUMP Inverter IP65 7.5KW', '900V', '17A', '1277', '1469'),
        jsonb_build_array('VEICHI PUMP Inverter IP65 11KW', '900V', '25A', '1444', '1661'),
        jsonb_build_array('VEICHI PUMP Inverter IP65 15KW', '900V', '32A', '1722', '1980'),
        jsonb_build_array('VEICHI PUMP Inverter IP65 18.5KW', '900V', '38A', '1944', '2236'),
        jsonb_build_array('VEICHI PUMP Inverter IP65 22KW', '900V', '45A', '2222', '2555')
      )
    )

  )
)
where id = 1
  and not (data ? 'productCatalog');
