// HoloulEnergy — cart-extras Edge Function
//
// Read-only. Returns the admin's installation (civil / electrical) and transport
// settings for product-cart quotes (pricing_config.data.offgrid.cartExtras) to a
// logged-in REP (or admin). Nothing else from pricing_config — no costs, margins
// or discount tiers — ever leaves this function.
//
// Like crm-api / invoice-api / crm-pipeline it has no login of its own: it verifies
// the same signed session token issued by compute-quote (HMAC-SHA256 with the
// SESSION_SECRET project secret) and re-checks the rep is still active.
// The DB trigger quotes_cart_enforce (migration 0026) uses the SAME defaults when it
// re-prices the cart at save time, so keep normalizeCartExtras() and the trigger in sync.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

function b64urlToString(s: string): string {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}
function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64urlFromBytes(new Uint8Array(sig));
}
function sessionSecret(): string {
  const s = Deno.env.get("SESSION_SECRET");
  if (!s) throw new Error("SESSION_SECRET is not configured for this project");
  return s;
}
async function readToken(token: any): Promise<any> {
  if (!token || typeof token !== "string" || token.split(".").length !== 2) return null;
  const [payloadB64, sig] = token.split(".");
  const expected = await hmacSign(sessionSecret(), payloadB64);
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(b64urlToString(payloadB64));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

const supabase: any = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function checkAdminToken(token: any): Promise<boolean> {
  const payload = await readToken(token);
  if (!payload || payload.sub !== "admin") return false;
  const { data, error } = await supabase.from("admin_secret").select("session_version").eq("id", 1).single();
  if (error || !data) return false;
  return payload.ver === data.session_version;
}
async function checkRepToken(token: any): Promise<boolean> {
  const payload = await readToken(token);
  if (!payload || typeof payload.sub !== "string" || !payload.sub.startsWith("rep:")) return false;
  const username = payload.sub.slice(4);
  const { data, error } = await supabase.from("reps").select("active, session_version").eq("username", username).single();
  if (error || !data || !data.active) return false;
  return payload.ver === data.session_version;
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return isFinite(n) ? n : null;
}

// Same defaults as the quotes_cart_enforce() trigger: when the admin hasn't saved
// offgrid.cartExtras yet, fall back to the pump-calculator install/transport rates.
export function normalizeCartExtras(D: any): any {
  const cx = (D && D.offgrid && D.offgrid.cartExtras) || {};
  const build = (key: string, defLabel: string, defUnit: string, defPrice: any) => {
    const c = cx[key] || {};
    const out: any = {
      key,
      label: (typeof c.label === "string" && c.label.trim()) ? c.label.trim() : defLabel,
      mode: c.mode === "fixed" ? "fixed" : "variable",
      unit: (typeof c.unit === "string" && c.unit) ? c.unit : defUnit,
      price: num(c.price) ?? num(defPrice) ?? 0,
      repEdit: c.repEdit === true,
    };
    return out;
  };
  const civil = build("civil", "أعمال التركيب المدني", "panel", D && D.mechInstallPerPanel);
  const elec = build("elec", "أعمال التركيب الكهربائي", "panel", D && D.elecInstallPerPanel);
  const transport = build("transport", "النقل", "trip", D && D.transportPerTrip);
  const t = (cx.transport || {});
  transport.minimum = num(t.minimum) ?? num(D && D.transportMinimum) ?? 0;
  transport.kwPerTrip = (num(t.kwPerTrip) ?? 20) > 0 ? (num(t.kwPerTrip) ?? 20) : 20;
  if (civil.unit !== "kw") civil.unit = "panel";
  if (elec.unit !== "kw") elec.unit = "panel";
  transport.unit = "trip";
  return { civil, elec, transport };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  try {
    const body = await req.json().catch(() => ({}));
    const ok = (body.adminToken && await checkAdminToken(body.adminToken)) || (body.token && await checkRepToken(body.token));
    if (!ok) return json({ error: "الجلسة منتهية، الرجاء تسجيل الدخول مجددًا" }, 401);
    const { data, error } = await supabase.from("pricing_config").select("data").eq("id", 1).single();
    if (error || !data) return json({ error: "تعذر قراءة الإعدادات" }, 500);
    const D = data.data || {};
    return json({ ok: true, vat: num(D.vat) ?? 0.15, extras: normalizeCartExtras(D) });
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
