-- ============================================================================
-- Upgrade: inverters -> inverterBrands (adds support for multiple inverter
-- product lines, each with its own full capacity range / list price /
-- discount / sell price — not just a single flat VEICHI ladder).
--
-- Safe to run even if you've already deployed 0001_init.sql: it only touches
-- rows that don't yet have an "inverterBrands" key, wrapping the existing
-- flat "inverters" ladder as a single brand named "VEICHI" so nothing about
-- your current pricing changes. Run this once in the SQL editor.
-- ============================================================================

update public.pricing_config
set data = data || jsonb_build_object(
  'inverterBrands',
  jsonb_build_array(
    jsonb_build_object('brand', 'VEICHI', 'tiers', data->'inverters')
  )
)
where id = 1
  and not (data ? 'inverterBrands');
