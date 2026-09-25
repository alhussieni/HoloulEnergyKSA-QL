-- Fix: the 3 invoice-integrity trigger functions (added in 0018) were
-- missing SET search_path, flagged by Supabase's security advisor
-- (function_search_path_mutable) — a function without a fixed search_path
-- is vulnerable to search_path hijacking. Adds the same fixed search_path
-- already used by next_invoice_seq/einvoice_go_live in 0018.
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
