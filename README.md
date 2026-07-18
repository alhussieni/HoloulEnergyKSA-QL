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
In the Supabase dashboard → SQL Editor, paste and run, in order:
`0001_init.sql`, `0002_inverter_brands.sql`, `0003_reps_and_quotes.sql`,
`0004_product_catalog.sql`, `0005_product_images_bucket.sql`,
`0006_session_tokens.sql`, `0007_veichi_inverter_specs_phase1.sql`,
`0008_veichi_inverter_specs_phase234.sql`, `0009_veichi_pump_inverter_specs.sql`,
`0010_veichi_battery_specs.sql`, `0011_veichi_accessories_specs.sql`,
`0012_portfolio_content.sql`

(or, if you use the Supabase CLI locally: `supabase db push`)

This creates all tables, fully locked down by Row Level Security with
**no policies at all** — meaning the browser (anon key) cannot read or write
them under any circumstance. Only the Edge Function, using the
`service_role` key, can touch them.

- `pricing_config` — every rate/margin the engine uses (mirrors the old
  `DEFAULT_DB` object in index.html). Edit anytime via Table Editor.
- `admin_secret` — a SHA-256 hash of the admin password, plus a
  `session_version` counter used to invalidate old admin sessions the
  moment the password is changed.
- `reps` — one row per rep (username/password hash/display name/active
  flag), plus its own `session_version` counter for the same reason.

## 1.5) Set SESSION_SECRET (required for logins to work)
Rep and admin logins now issue a **signed, short-lived session token**
instead of the browser resending the plaintext password on every request
(see "What changed" below). The Edge Function signs these tokens with a
secret that only it knows:

```bash
supabase secrets set SESSION_SECRET="$(openssl rand -hex 32)"
```

Use a long random value — anyone who obtains it could forge admin/rep
sessions. Never put it in `index.html` or anywhere client-side.

## What changed: session tokens instead of resent passwords
Previously the browser held the rep's/admin's **plaintext password** in
memory (or, for reps, in `sessionStorage`) and sent it back to the server
on every single request that needed authorization. Now:
- `rep-login` / `admin-login` verify the password **once** and return a
  signed token (rep tokens last 12h, admin tokens last 4h).
- Every other action (`find-client`, `save-quote`, `admin-view`,
  `update-config`, `admin-save-rep`, etc.) takes that `token` /
  `adminToken` instead of a password field.
- Changing the admin password, or resetting a rep's password, bumps a
  `session_version` counter server-side, which instantly invalidates every
  token issued before that change — no need to track/blacklist tokens.
- Deactivating a rep (`active = false`) also instantly blocks their token,
  since `checkRepToken` re-checks the `active` flag on every call.

This does **not** eliminate brute-force risk on the login endpoints
themselves (`rep-login` / `admin-login` still take a password each time) —
adding rate-limiting on those two actions is a good next step if you want
to close that gap too.

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
| `rep-login` | `username` + `password` | `{ displayName, token }` — use `token` below for 12h |
| `admin-login` | `adminPassword` | `{ token }` — use `adminToken` below for 4h |
| `find-client` | `token` | prior quotes tied to a phone number (rep name, specs, price) |
| `save-quote` | `token` (or `guest:true`) | logs a finalized quote centrally |
| `admin-view` | `adminToken` | same quote + cost basis, total cost, profit, profit % |
| `update-config` | `adminToken` | overwrites `pricing_config` with a new rates object |
| `change-admin-password` | `adminToken` | rotates the password + session; returns a fresh `token` |
| `admin-list-reps` / `admin-save-rep` / `admin-delete-rep` | `adminToken` | manage rep accounts |
| `upload-product-image` | `adminToken` | uploads to the `product-images` Storage bucket |
| `get-product-catalog` | none | public reference list prices for any rep |
| `get-portfolio` | none | public portfolio content (hero, projects, partners, timeline) |
| `hash-password` | none | convenience helper — not used by the frontend anymore |
