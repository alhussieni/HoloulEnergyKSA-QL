-- ============================================================================
-- HoloulEnergy KSA — Quote Line pricing backend
-- Run this once in Supabase (SQL editor, or `supabase db push`).
-- ============================================================================

-- 1) Pricing configuration (mirrors the old client-side DEFAULT_DB object).
--    A single row holding every rate/margin the pricing engine needs.
create table if not exists public.pricing_config (
  id int primary key default 1,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  constraint single_row check (id = 1)
);

-- 2) Admin password (stored as a salted hash, never in cleartext, never in the
--    frontend). Verified only inside the Edge Function.
create table if not exists public.admin_secret (
  id int primary key default 1,
  password_hash text not null,
  updated_at timestamptz not null default now(),
  constraint single_row check (id = 1)
);

-- 3) Lock both tables down completely from the browser.
--    No policies = no anon/authenticated access at all, under RLS.
--    Only the Edge Function (using the service_role key, which bypasses RLS)
--    can read or write these tables. This is the whole point: the pricing
--    logic, costs and margins never reach the client.
alter table public.pricing_config enable row level security;
alter table public.admin_secret   enable row level security;

-- 4) Seed the pricing config with the values currently baked into index.html.
--    Edit this JSON any time via the Supabase Table Editor (or the
--    'update-config' action in the Edge Function once the admin panel is wired).
insert into public.pricing_config (id, data) values (1, '{
  "vat": 0.15,
  "maxStringVoltage": 720,
  "panelsPerStringAdjust": 0,
  "stringsAdjust": 0,
  "inverterPowerIncrease": 0,
  "hpCapacityRatio": 1.15,
  "steelPanelPerHP": 16.345455,
  "cablePerMeter": 4,
  "cableHighMultiplier": 90,
  "cableLowMultiplier": 45,
  "cableMarkup": 1.25,
  "mc4PerUnit": 5,
  "structurePriceFixed": 1499,
  "structurePriceRotational": 1499,
  "concretePerUnit": 220,
  "earthingPerUnit": 2500,
  "flexTubePerUnit": 50,
  "mechInstallPerPanel": 60,
  "elecInstallPerPanel": 25,
  "transportPerTrip": 200,
  "transportMinimum": 2000,
  "combinerHeadroom": 1.1,
  "combinerMinSpareStrings": 2,
  "leadsWebhookUrl": "https://script.google.com/macros/s/AKfycbx6McxQSAcXLC84nBQDkd6KSHYx2tUVU-81yCJP4WgiatFpw0FJQ5jXCieBIXpfPhhh/exec",

  "panels": [
    {"brand":"Aiko", "power":665, "vimp":45.6, "voc":54.4, "iimp":14.59, "isc":15.24, "priceW":0.555},
    {"brand":"Aiko", "power":650, "vimp":45.3, "voc":54.0, "iimp":14.35, "isc":15.06, "priceW":0.56},
    {"brand":"JA",   "power":595, "vimp":40.45,"voc":48.7, "iimp":15.45, "isc":16.15, "priceW":0.48},
    {"brand":"JA",   "power":625, "vimp":44.64,"voc":52.58,"iimp":13.333,"isc":13.99, "priceW":0.56},
    {"brand":"JA",   "power":630, "vimp":44.64,"voc":52.58,"iimp":13.333,"isc":13.99, "priceW":0.58},
    {"brand":"JINKO","power":615, "vimp":40.46,"voc":48.88,"iimp":15.15, "isc":16.02, "priceW":0.51},
    {"brand":"JINKO","power":620, "vimp":40.74,"voc":49.08,"iimp":15.22, "isc":16.08, "priceW":0.51},
    {"brand":"TRINA","power":610, "vimp":39.79,"voc":48.09,"iimp":15.33, "isc":16.14, "priceW":0.47},
    {"brand":"Longi","power":620, "vimp":40.91,"voc":48.78,"iimp":15.16, "isc":16.05, "priceW":0.48}
  ],

  "inverters": [
    [4,0,0],[5.5,648,720],[7.5,899.1,999],[11,1019.7,1133],[18.5,1619.1,1799],
    [22,1899.9,2111],[30,2499.3,2777],[37,2999.7,3333],[55,4499.1,4999],
    [75,5199.3,5777],[90,6499.8,7222],[110,7499.7,8333],[132,10099.8,11222],
    [160,11099.7,12333],[200,15699.6,17444],[250,18999.9,21111],[315,20699.1,22999],
    [355,32999.4,36666],[400,38999.7,43333],[500,44999.1,49999],[560,47999.7,53333],
    [630,65999.7,73333],[710,71999.1,79999]
  ],

  "reactorLadder": [50,80,100,160,315,450,560,1000],
  "reactorPrices": {"50":389,"80":479,"100":499,"160":599,"315":999,"450":1374,"560":1539,"1000":2529},

  "combinerBoxes": [[4,749],[8,949],[10,1149],[16,1649],[22,2649],[30,3849],[34,4598],[38,4798],[40,4998],[46,5498],[50,6147],[56,6647],[60,7698],[64,8447],[68,8647],[70,8847],[76,9347],[90,11547]],

  "cbLadder": [32,63,80,100,125,160,200,250],

  "discountTiers": [
    {"label":"بدون خصم", "factor":0},
    {"label":"خصم عميل مزرعة", "factor":0.2},
    {"label":"خصم عميل مشروع زراعي", "factor":0.4},
    {"label":"خصم عميل شركات", "factor":0.6},
    {"label":"خصم خاص", "factor":0.8}
  ],
  "defaultDiscountIdx": 1,

  "feas": {
    "psh": 5.5,
    "panelDegradationPct": 0.65,
    "gridPrice": 0.22,
    "gridEscalationPct": 8,
    "dieselPrice": 1.79,
    "dieselConsumptionPerKWh": 0.25,
    "dieselEscalationPct": 5,
    "solarOMPctOfCapex": 1,
    "co2FactorKgPerLiter": 2.68,
    "years": 30
  }
}'::jsonb)
on conflict (id) do nothing;

-- 5) Seed a placeholder admin password hash — CHANGE THIS before going live.
--    Generate a real hash with:  supabase functions invoke compute-quote --data '{"action":"hash-password","password":"YOUR-NEW-PASSWORD"}'
--    then update this row with the returned hash, e.g.:
--      update public.admin_secret set password_hash = '...' where id = 1;
insert into public.admin_secret (id, password_hash) values (1, '')
on conflict (id) do nothing;
