-- invoice-api v2: lets a rep/admin link an invoice to one of the customer's
-- raw calculator estimates (the `quotes` table — public solar-calculator
-- runs), not just formal `quotations`. Reconstructed from the live schema.
alter table public.invoices
  add column if not exists source_calc_quote_id bigint;
