-- 0018_warranty_activate.sql  (STEP 1 — run AFTER the new crm.html is uploaded and live)
--
-- Switches the warranty-certificate rules ON. Until this table has rows, the invoice trigger
-- (trg_invoices_enrich_warranty) is a no-op and invoices behave exactly as before.
--
-- After this:
--   * product lines in these catalog categories get warranty_class / model / years frozen into the invoice items
--   * "serial" categories REQUIRE an SN (one unit per line, unique across non-cancelled invoices)
--   * "optional" categories take an optional serial/batch number (quantity > 1 allowed)
--
-- Categories NOT listed here (lithium batteries, reactors, MC4, DC breakers) get no certificate.
-- Add a row to extend the rule (needs a matching entry in crm_settings.standardWarranties for its years):
--   insert into public.warranty_category_map values ('<catalog category>', '<warranty_class>', true);
-- Change requires_serial for combiner boxes to true if you want each box serialised:
--   update public.warranty_category_map set requires_serial = true where warranty_class = 'combiner_box';

insert into public.warranty_category_map (category, warranty_class, requires_serial) values
  ('ألواح الطاقة الشمسية',           'solar_panel',  false),
  ('شواحن/انفرترات هجين MPPT',       'inverter',     true),
  ('انفرتر مضخات VEICHI',            'inverter',     true),
  ('صناديق التجميع (Combiner Box)',  'combiner_box', false)
on conflict (category) do update
  set warranty_class = excluded.warranty_class, requires_serial = excluded.requires_serial;
