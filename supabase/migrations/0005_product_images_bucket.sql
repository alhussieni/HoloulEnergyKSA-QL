-- ============================================================================
-- Storage bucket for product images (category photos + per-product photos)
-- Public READ (so images display on the site), but no public WRITE — only
-- the Edge Function (service_role) can upload, via the 'upload-product-image'
-- action, gated behind the admin password.
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', true)
on conflict (id) do nothing;

-- No RLS policies granting insert/update/delete to anon/authenticated —
-- uploads only happen server-side via the Edge Function's service_role key,
-- which bypasses storage RLS entirely. Public read works automatically
-- because the bucket itself is marked public above.
