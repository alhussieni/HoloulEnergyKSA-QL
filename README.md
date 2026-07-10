# Backend for HoloulEnergy KSA – Quote Line

**Status: `index.html` is now fully wired to this backend** (Project URL and
anon key are already embedded in the file). Nothing left to edit in the
frontend — just deploy the steps below and it works. The full flow (quote
calculation, admin login, rate editing, discount unlock, password change,
lead logging) was tested end-to-end against a simulated version of this
Edge Function and produced correct results with zero errors — but that's a
simulation, not your live Supabase project, so please click through
everything yourself once deployed before using it with real clients.

This moves the pricing engine, cost basis, margins and admin-password check
out of the browser and into Supabase, where the client can't read them.

## Why this was needed
The current `index.html` computes everything (cost, margin, admin password
check) inside the browser's JavaScript. Anyone can open DevTools (F12) and
read the source, the cost of every item, and even flip `adminInfoUnlocked =
true` in the console to bypass the password entirely. Moving the engine to
an Edge Function fixes this: the browser only ever receives the final sell
prices, never the underlying cost/margin data, and the admin password is
checked on the server.

## 1) Deploy the database schema
In the Supabase dashboard → SQL Editor, paste and run:
`supabase/migrations/0001_init.sql`

(or, if you use the Supabase CLI locally: `supabase db push`)

This creates two tables, both fully locked down by Row Level Security with
**no policies at all** — meaning the browser (anon key) cannot read or write
them under any circumstance. Only the Edge Function, using the
`service_role` key, can touch them.

- `pricing_config` — every rate/margin the engine uses (mirrors the old
  `DEFAULT_DB` object in index.html). Edit anytime via Table Editor.
- `admin_secret` — a SHA-256 hash of the admin password. Never store the
  password itself.

## 2) Set the real admin password
The migration seeds `admin_secret` with an **empty** hash, so the admin
panel is inaccessible until you set one. Generate a hash by calling the
function once it's deployed:

```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/compute-quote \
  -H "Authorization: Bearer <anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"action":"hash-password","password":"YOUR-NEW-PASSWORD"}'
```

Copy the returned `hash` value, then in the SQL editor:

```sql
update public.admin_secret set password_hash = '<paste-hash-here>' where id = 1;
```

## 3) Deploy the Edge Function
```bash
supabase login
supabase link --project-ref <project-ref>
supabase functions deploy compute-quote
```

Supabase sets `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` automatically
for Edge Functions — you don't need to configure those secrets yourself,
and you should never paste the service_role key into the frontend, a chat
tool, or anywhere client-side.

## 4) What the frontend needs
Only two values, both safe to embed in `index.html` (the anon key is
public-by-design; Row Level Security is what keeps data safe, not secrecy
of this key):
- Project URL: `https://<project-ref>.supabase.co`
- Anon public key (Settings → API in the dashboard)

Send these to me (or drop them directly into the constants at the top of
`index.html` once I wire it up) and I'll connect the quote calculator and
the admin panel to this function, keeping the exact same look and
behaviour as today — the only difference is where the math happens.

## API summary
`POST /functions/v1/compute-quote`

| action | auth | returns |
|---|---|---|
| `quote` | none (anon key only) | sell prices, quantities, totals — no cost/margin |
| `admin-view` | `adminPassword` field | same quote + cost basis, total cost, profit, profit % |
| `update-config` | `adminPassword` field | overwrites `pricing_config` with a new rates object |
| `hash-password` | none | returns a SHA-256 hash to seed `admin_secret` |
