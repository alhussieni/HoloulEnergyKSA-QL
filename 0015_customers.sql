-- ============================================================================
-- Central customers table
-- One row per unique client (deduped by phone), aggregating every quote
-- they've ever received across all reps/devices. This replaces the browser
-- localStorage "leads" cache and the direct-from-browser Google Sheet fetch
-- as the source of truth for the admin dashboard.
--
-- Deliberately lean for now (identity + aggregate counters only) — no status
-- pipeline, no interaction log, no deal/contract tracking yet. Those are the
-- next phase (the future CRM) and will be added as new tables that reference
-- customers.id, so nothing here needs to be redesigned when that happens.
-- ============================================================================

create table if not exists public.customers (
  id bigserial primary key,
  name text,
  phone text not null unique,          -- normalized via the same phoneKey() logic as quotes.client_phone
  rep_username text,                    -- most recent rep to quote this customer (null = guest/self-service)
  quotes_count integer not null default 0,
  first_quote_at timestamptz,
  last_quote_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.customers enable row level security;
-- No policies -> completely inaccessible from the browser (anon/authenticated
-- keys), same as every other table here. Only the Edge Function (service_role) touches it.

create index if not exists customers_phone_idx on public.customers (phone);
create index if not exists customers_last_quote_idx on public.customers (last_quote_at desc);

-- Link every quote back to its customer record. Nullable + ON DELETE SET NULL
-- so deleting a customer (if that's ever needed) never breaks quote history.
alter table public.quotes add column if not exists customer_id bigint references public.customers(id) on delete set null;
create index if not exists quotes_customer_id_idx on public.quotes (customer_id);

-- Backfill: link existing quotes to customers rows, creating one customer
-- per distinct phone number found in quotes.client_phone (safe to run once;
-- ON CONFLICT skips phones that already have a customer row).
insert into public.customers (name, phone, rep_username, quotes_count, first_quote_at, last_quote_at, updated_at)
select
  (array_agg(client_name order by created_at desc))[1] as name,
  client_phone,
  (array_agg(rep_username order by created_at desc))[1] as rep_username,
  count(*) as quotes_count,
  min(created_at) as first_quote_at,
  max(created_at) as last_quote_at,
  now()
from public.quotes
where client_phone is not null and client_phone <> ''
group by client_phone
on conflict (phone) do nothing;

update public.quotes q
set customer_id = c.id
from public.customers c
where q.customer_id is null and q.client_phone = c.phone;
