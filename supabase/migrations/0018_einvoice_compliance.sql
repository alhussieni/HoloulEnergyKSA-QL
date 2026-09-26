-- E-invoice (ZATCA Phase-1) compliance: new invoices columns, a trial-mode
-- config table, an atomic per-day numbering counter, and integrity triggers
-- that make an issued invoice immutable and undeletable (a credit note is
-- the only legal way to cancel/reverse one).
--
-- NOTE: this file was reconstructed from the live database schema after the
-- fact (the migration was applied directly via the Supabase dashboard/SQL
-- editor rather than through this repo — see CHANGELOG.md). The statements
-- below reproduce the actual deployed schema exactly (pulled with
-- pg_get_functiondef / pg_get_triggerdef against the live project), so this
-- file is safe to keep as the historical record even though it wasn't the
-- literal script that was run.

-- ---------------------------------------------------------------------
-- New invoices columns
-- ---------------------------------------------------------------------
alter table public.invoices
  add column if not exists document_type text not null default 'invoice',
  add column if not exists related_invoice_id bigint,
  add column if not exists reason text,
  add column if not exists issued_at timestamptz;

-- ---------------------------------------------------------------------
-- Trial-mode switch: while true, test invoices can be deleted (via
-- crm-delete-trial-invoice in invoice-api) and print with a "TEST"
-- watermark. crm-einvoice-go-live flips this off for good and wipes all
-- trial data.
-- ---------------------------------------------------------------------
create table if not exists public.einvoice_config (
  id integer primary key default 1,
  trial_mode boolean not null default true,
  constraint einvoice_config_id_check check (id = 1)
);
insert into public.einvoice_config (id, trial_mode) values (1, true)
  on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Atomic per-day invoice/credit-note numbering. One row per "prefix+date"
-- key (e.g. HEWDS20260924); next_invoice_seq() increments it atomically so
-- concurrent requests never reuse or skip a number.
-- ---------------------------------------------------------------------
create table if not exists public.invoice_counters (
  counter_key text primary key,
  last_value integer not null default 0
);

create or replace function public.next_invoice_seq(p_key text)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v integer;
begin
  insert into public.invoice_counters (counter_key, last_value) values (p_key, 1)
  on conflict (counter_key) do update set last_value = public.invoice_counters.last_value + 1
  returning last_value into v;
  return v;
end $function$;

-- ---------------------------------------------------------------------
-- One-way switch out of trial mode: wipes every trial invoice/credit note
-- and resets the numbering counters, then permanently sets trial_mode=false.
-- ---------------------------------------------------------------------
create or replace function public.einvoice_go_live()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare n integer;
begin
  if not coalesce((select trial_mode from public.einvoice_config where id = 1), false) then
    raise exception 'Already live.';
  end if;
  perform set_config('app.allow_invoice_delete', 'on', true);
  delete from public.invoices where document_type = 'credit_note';
  delete from public.invoices;
  get diagnostics n = row_count;
  delete from public.invoice_counters;
  update public.einvoice_config set trial_mode = false where id = 1;
  return n;
end $function$;

-- ---------------------------------------------------------------------
-- Integrity triggers on public.invoices:
--   1) require issued_at on insert (invoices must go through invoice-api,
--      which always sets it — a NULL here means something bypassed it)
--   2) block DELETE outright once an invoice is real (trial mode, or the
--      one-time go-live wipe, are the only exceptions, via the
--      app.allow_invoice_delete session flag)
--   3) block UPDATE of any of the legally-significant fields once issued
--      (number, totals, QR, customer identity, etc.) — a credit note is
--      the only way to reverse an issued invoice, matching ZATCA rules
-- ---------------------------------------------------------------------
create or replace function public.invoices_require_issued_at()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if new.issued_at is null then
    raise exception 'Invoices must be issued through the invoice-api function (issued_at is required).';
  end if;
  return new;
end $function$;

create or replace function public.invoices_block_delete()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if coalesce(current_setting('app.allow_invoice_delete', true), '') = 'on'
     or coalesce((select trial_mode from public.einvoice_config where id = 1), false) then
    return old;
  end if;
  raise exception 'Issued invoices cannot be deleted. Issue a credit note instead.';
end $function$;

create or replace function public.invoices_block_tamper()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  if coalesce(current_setting('app.allow_invoice_delete', true), '') = 'on' then
    return new;
  end if;
  if (new.invoice_number, new.invoice_type, new.document_type, new.related_invoice_id,
      new.items, new.discount_total, new.vat_percent, new.subtotal, new.vat_amount, new.total,
      new.qr_base64, new.issued_at, new.customer_name, new.customer_vat_number,
      new.customer_cr_number, new.customer_address, new.customer_id)
     is distinct from
     (old.invoice_number, old.invoice_type, old.document_type, old.related_invoice_id,
      old.items, old.discount_total, old.vat_percent, old.subtotal, old.vat_amount, old.total,
      old.qr_base64, old.issued_at, old.customer_name, old.customer_vat_number,
      old.customer_cr_number, old.customer_address, old.customer_id)
  then
    raise exception 'Issued invoice content is immutable. Issue a credit note and a new invoice instead.';
  end if;
  return new;
end $function$;

drop trigger if exists trg_invoices_require_issued_at on public.invoices;
create trigger trg_invoices_require_issued_at
  before insert on public.invoices
  for each row execute function public.invoices_require_issued_at();

drop trigger if exists trg_invoices_block_delete on public.invoices;
create trigger trg_invoices_block_delete
  before delete on public.invoices
  for each row execute function public.invoices_block_delete();

drop trigger if exists trg_invoices_block_tamper on public.invoices;
create trigger trg_invoices_block_tamper
  before update on public.invoices
  for each row execute function public.invoices_block_tamper();
