-- 0028: نسخة التكاليف والهامش الفعلي وقت كل عرض سعر (للأدمن فقط)
-- بتتكتب من الـ Edge Function compute-quote عند save-quote، وبتتقرا فقط من action: admin-quote-financials.
create table if not exists public.quote_financials (
  quote_id    bigint primary key references public.quotes(id) on delete cascade,
  financials  jsonb not null,
  captured_at timestamptz not null default now()
);
alter table public.quote_financials enable row level security;
revoke all on public.quote_financials from anon, authenticated;
comment on table public.quote_financials is 'Cost basis / margin snapshot at quote time. Service-role only (admin).';
