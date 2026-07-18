// HoloulEnergy KSA — compute-quote Edge Function
//
// This function is the ONLY place the pricing engine, cost basis and margins
// live. The browser never receives DEFAULT_DB, never sees costBasis/profit,
// and never verifies the admin password itself — all of that happens here,
// server-side, using the service_role key (which is never exposed to users).
//
// Actions (POST body: { action, ...payload }):
//   "quote"           -> public. Returns sell prices only (no cost/margin).
//   "admin-view"      -> requires a correct `adminPassword`. Returns the same
//                        quote PLUS per-item cost basis, total cost and profit.
//   "update-config"   -> requires a correct `adminPassword`. Overwrites
//                        pricing_config.data with the given `config` object.
//   "hash-password"   -> convenience helper to generate a password hash to
//                        paste into admin_secret.password_hash (see migration).
//
// Deploy with:  supabase functions deploy compute-quote
// Required secrets (supabase secrets set ...):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (Supabase sets these automatically)

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Session tokens — signed with SESSION_SECRET (HMAC-SHA256), never the raw
// password. The browser logs in once (rep-login / admin-login) with the
// password, gets a short-lived token back, and uses that token for every
// later call instead of resending the password on every request.
//
// Token shape: "<base64url(payload json)>.<base64url(hmac signature)>"
// payload = { sub: "rep:<username>" | "admin", ver: <session_version>, exp: <unix seconds> }
//
// `ver` is compared against the row's live session_version column, so
// changing a password (rep or admin) or deactivating a rep instantly
// invalidates every token issued before that change — no blacklist needed.
// ---------------------------------------------------------------------------
function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToString(s: string): string {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}
async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64urlFromBytes(new Uint8Array(sig));
}
function sessionSecret(): string {
  const s = Deno.env.get("SESSION_SECRET");
  if (!s) throw new Error("SESSION_SECRET is not configured — set it with `supabase secrets set SESSION_SECRET=...`");
  return s;
}
async function issueToken(sub: string, ver: number, ttlSeconds: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payloadB64 = b64urlFromBytes(new TextEncoder().encode(JSON.stringify({ sub, ver, exp })));
  const sig = await hmacSign(sessionSecret(), payloadB64);
  return `${payloadB64}.${sig}`;
}
async function readToken(token: string | undefined): Promise<{ sub: string; ver: number; exp: number } | null> {
  if (!token || token.split(".").length !== 2) return null;
  const [payloadB64, sig] = token.split(".");
  const expected = await hmacSign(sessionSecret(), payloadB64);
  if (expected !== sig) return null; // signature mismatch — tampered or forged
  try {
    const payload = JSON.parse(b64urlToString(payloadB64));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null; // expired
    return payload;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Pricing engine — ported 1:1 from the client-side engine that used to live
// in index.html. Keep this in sync if the business rules change.
// ---------------------------------------------------------------------------
function pickLadder(ladder: number[], value: number) {
  for (const v of ladder) if (value <= v) return v;
  return ladder[ladder.length - 1];
}
function pickInverter(kwNeeded: number, list: number[][]) {
  for (const row of list) if (kwNeeded <= row[0]) return row;
  return list[list.length - 1];
}
// Inverters used to be one flat ladder (implicitly "VEICHI"). They're now a
// list of brands, each with its own ladder — but older deployments still
// have D.inverters as a flat array, so we transparently wrap that as a
// single "VEICHI" brand instead of requiring a manual data migration.
function getInverterBrands(D: any) {
  if (Array.isArray(D.inverterBrands) && D.inverterBrands.length) return D.inverterBrands;
  return [{ brand: "VEICHI", tiers: D.inverters || [] }];
}
function pickCombiner(minInputs: number, boxes: number[][], headroom: number, minSpare: number) {
  const need = Math.max(Math.ceil(minInputs * headroom), minInputs + (minSpare || 0));
  for (const row of boxes) if (need <= row[0]) return row;
  return boxes[boxes.length - 1];
}

function computeQuote(D: any, inp: any) {
  const panel = inp.panel, hp = inp.hp;

  const panelsPerString = Math.floor(D.maxStringVoltage / panel.vimp) - (inp.panelsPerStringAdjust ?? D.panelsPerStringAdjust);
  const arrays = Math.round(hp * 1000 * D.hpCapacityRatio / (panelsPerString * panel.power)) - (inp.stringsAdjust ?? D.stringsAdjust);
  const totalPanels = panelsPerString * arrays;
  const calcKW = panel.power * totalPanels / 1000;
  const efficiencyRatio = calcKW / hp;

  const Iimp = arrays * panel.iimp;
  const Vimp = panelsPerString * panel.vimp;
  const Voc = panelsPerString * panel.voc;
  const Isc = arrays * panel.isc;
  const IscCalc = Isc * 1.25;
  const expectedVAC = Vimp * 0.88 / Math.SQRT2;

  const inverterCalcKW = Math.ceil(hp * 0.8) + (inp.inverterPowerIncrease ?? D.inverterPowerIncrease);
  const invBrand = inp.invBrand;
  const inv = pickInverter(inverterCalcKW, invBrand.tiers);
  const invKW = inv[0], invCost = inv[1], invList = inv[2];

  const reactorModel = pickLadder(D.reactorLadder, Iimp);
  const reactorPrice = D.reactorPrices[String(reactorModel)];
  const cbSize = pickLadder(D.cbLadder, IscCalc);
  const combiner = inp.combinerOverride || pickCombiner(arrays, D.combinerBoxes, D.combinerHeadroom, D.combinerMinSpareStrings);

  const panelCost = panel.priceW * calcKW * 1000;
  const steelPanelCost = D.steelPanelPerHP * hp;
  const combinerCost = combiner[1];

  const cableRaw = calcKW >= 100 ? D.cableHighMultiplier * arrays : D.cableLowMultiplier * arrays;
  const roundedHundreds = Math.round(cableRaw / 100) * 100;
  const hundredsUnit = roundedHundreds / 100;
  const evenUnit = (hundredsUnit % 2 === 0) ? hundredsUnit : (hundredsUnit > 0 ? hundredsUnit + 1 : hundredsUnit - 1);
  const cablesLen = evenUnit * 100;
  const cablesCost = cablesLen * D.cablePerMeter;

  const mc4Cost = arrays * D.mc4PerUnit;
  const structurePrice = inp.structureType === "ROTATIONAL" ? D.structurePriceRotational : D.structurePriceFixed;
  const structureCost = arrays * structurePrice;
  const concreteQty = Math.round(arrays * 8 / 3.5);
  const concreteCost = concreteQty * D.concretePerUnit;
  const earthQty = Math.round(calcKW / 40);
  const earthCost = earthQty * D.earthingPerUnit;
  const reactorCost = reactorPrice;
  const flexQty = Math.round(cablesLen / 40);
  const flexCost = flexQty * D.flexTubePerUnit;
  const mechInstallQty = totalPanels;
  const mechInstallCost = mechInstallQty * D.mechInstallPerPanel;
  const elecInstallQty = totalPanels;
  const elecInstallCost = elecInstallQty * D.elecInstallPerPanel;
  const transportQty = Math.ceil(calcKW / 20);
  const transportCost = Math.max(transportQty * D.transportPerTrip, D.transportMinimum);

  const t = inp.toggles;
  const items: any[] = [];
  const push = (key: string, label: string, on: boolean, sell: number, costBasis: number, meta: any = {}) =>
    items.push({
      key, label, on, sell: on ? sell : 0, costBasis,
      type: meta.type || "-", qty: on ? (meta.qty || "-") : "لا يوجد", warranty: on ? (meta.warranty || "-") : "لا يوجد",
    });

  push("panel", "ألواح الطاقة الشمسية", t.panel, panelCost, panelCost, {
    type: `${panel.brand} ${panel.power}W أو ما يعادلها`, qty: `#${totalPanels}#`,
    warranty: "12 سنة ضد عيوب الصناعة / 30 سنة ضد التناقص الإنتاجي عن %80",
  });
  push("inverter", "الانفرتر", t.inverter, invList, invCost, {
    type: `${invBrand.brand} أو ما يعادلها ${invKW} KW`, qty: "#1#", warranty: "سنة واحدة",
  });
  push("ip65", "لوحة الحماية IP65", t.ip65, steelPanelCost * 1.25, steelPanelCost, {
    type: `خاصة بانفرتر ${invKW} KW`, qty: "#1#", warranty: "سنة واحدة",
  });
  push("combiner", `VEICHI Combiner box ${String(combiner[0]).padStart(3, "0")}`, t.combiner, combinerCost * 1.3, combinerCost, {
    type: "-", qty: "#1#", warranty: "سنة واحدة",
  });
  push("cables", "الكابلات - DC", t.cables, cablesCost * D.cableMarkup, cablesCost, {
    type: "VEICHI / LEADER / SUNTREE 6mm", qty: `${cablesLen} متر (تقريبي — يُحدد نهائيًا عند التوريد)`, warranty: "سنة واحدة",
  });
  push("mc4", "وصلات MC4", t.mc4, mc4Cost * 1.5, mc4Cost, {
    type: "Suntree / VEICHI / LEADER", qty: `#${arrays}#`, warranty: "---",
  });
  push("structure", "الشاسيه/الحوامل (" + (inp.structureType === "ROTATIONAL" ? "متحرك" : "ثابت") + ")", t.structure, structureCost * 1.1, structureCost, {
    type: "HDG مجلفن مستورد", qty: `#${arrays}#`, warranty: "عشر سنوات",
  });
  push("concrete", "الخرسانة", t.concrete, concreteCost * 1.1, concreteCost, {
    type: "مصبوبة في الموقع", qty: "مطابق للمخطط", warranty: "---",
  });
  push("earth", "التأريض (بئر أرضي)", t.earth, earthCost, earthCost, {
    type: "-", qty: `#${earthQty}#`, warranty: "سنة واحدة",
  });
  push("reactor", "الريأكتور", t.reactor, reactorCost, reactorCost, {
    type: `${reactorModel}A`, qty: "#1#", warranty: "سنة واحدة",
  });
  push("install_mech", "الأعمال الميدانية وتثبيت الألواح", t.civilworks, mechInstallCost, mechInstallCost, {
    type: "-", qty: `#${mechInstallQty}#`, warranty: "عام واحد فقط من تاريخ التشغيل",
  });
  push("install_elec", "التركيبات والتوصيلات الكهربائية", t.elecworks, elecInstallCost, elecInstallCost, {
    type: "-", qty: `#${elecInstallQty}#`, warranty: "عام واحد فقط من تاريخ التشغيل",
  });
  push("transport", "النقل", t.supply, transportCost, transportCost, {
    type: "-", qty: `#${transportQty}#`, warranty: "---",
  });

  const factor = inp.discountFactor;
  let sellTotal = 0, discountTotal = 0;
  for (const it of items) {
    if (!it.on) { it.discount = 0; it.net = 0; continue; }
    const margin = it.sell - it.costBasis;
    const discount = it.key === "panel" ? 0 : margin * factor;
    it.discount = discount;
    it.net = it.sell - discount;
    sellTotal += it.sell;
    discountTotal += discount;
  }
  discountTotal = Math.round(discountTotal / 10) * 10;
  const netAfterDiscount = sellTotal - discountTotal;
  const manualDiscountAmt = Math.min(netAfterDiscount, Math.max(0, inp.specialDiscountAmt || 0));
  const netAfterManual = netAfterDiscount - manualDiscountAmt;
  const vat = netAfterManual * D.vat;
  const finalTotal = netAfterManual + vat;

  return {
    panelsPerString, arrays, totalPanels, calcKW, efficiencyRatio,
    Iimp, Vimp, Voc, Isc, IscCalc, expectedVAC,
    invBrandName: invBrand.brand,
    inverterCalcKW, invKW, reactorModel, reactorPrice, cbSize, combiner,
    items, sellTotal, discountTotal, netAfterDiscount, manualDiscountAmt,
    netAfterManual, vat, finalTotal, sarPerKW: finalTotal / calcKW,
  };
}

// Strip anything an ordinary client should never see.
function publicView(q: any) {
  return {
    ...q,
    items: q.items.map((it: any) => {
      const { costBasis, discount, net, ...rest } = it;
      return rest;
    }),
  };
}

function adminView(q: any) {
  const onItems = q.items.filter((it: any) => it.on);
  const totalCost = onItems.reduce((s: number, it: any) => s + it.costBasis, 0);
  const profit = q.netAfterDiscount - totalCost;
  const profitPct = q.netAfterDiscount ? (profit / q.netAfterDiscount) * 100 : 0;
  return { ...q, totalCost, profit, profitPct };
}

// Resolve panel + inverter brand + discount factor server-side. The client
// sends indices only (panelIdx, inverterBrandIdx, discountTierIdx) — it
// never needs to know priceW, inverter list/cost, or any discount factor.
function resolveInput(D: any, rawInput: any) {
  const panel = D.panels[rawInput.panelIdx];
  if (!panel) throw new Error("invalid panelIdx");
  const brands = getInverterBrands(D);
  const invBrand = brands[rawInput.inverterBrandIdx ?? 0] || brands[0];
  if (!invBrand) throw new Error("invalid inverterBrandIdx");
  const tierIdx = (rawInput.discountTierIdx ?? D.defaultDiscountIdx ?? 1);
  const tier = D.discountTiers[tierIdx] || D.discountTiers[D.defaultDiscountIdx ?? 1];
  return { ...rawInput, panel, invBrand, discountFactor: tier.factor };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ---- convenience: generate a password hash to seed admin_secret ----
  if (body.action === "hash-password") {
    if (!body.password) return json({ error: "password required" }, 400);
    return json({ hash: await sha256Hex(body.password) });
  }

  // ---- load pricing config (server-side only) ----
  const { data: cfgRow, error: cfgErr } = await supabase
    .from("pricing_config").select("data").eq("id", 1).single();
  if (cfgErr || !cfgRow) return json({ error: "pricing config not found" }, 500);
  const D = cfgRow.data;

  async function getAdminSecretRow(): Promise<{ password_hash: string; session_version: number } | null> {
    const { data, error } = await supabase.from("admin_secret").select("password_hash, session_version").eq("id", 1).single();
    if (error || !data || !data.password_hash) return null;
    return data;
  }

  // Verifies the admin PASSWORD directly. Only used by admin-login now — every
  // other admin action verifies a short-lived TOKEN instead (see checkAdminToken).
  async function checkAdminPassword(pw: string | undefined): Promise<boolean> {
    if (!pw) return false;
    const row = await getAdminSecretRow();
    if (!row) return false;
    return (await sha256Hex(pw)) === row.password_hash;
  }

  // Verifies an admin session token: signature, expiry, subject, AND that its
  // embedded `ver` still matches admin_secret.session_version (so changing the
  // admin password instantly kills every token issued before the change).
  async function checkAdminToken(token: string | undefined): Promise<boolean> {
    const payload = await readToken(token);
    if (!payload || payload.sub !== "admin") return false;
    const row = await getAdminSecretRow();
    if (!row) return false;
    return payload.ver === row.session_version;
  }

  // ---- admin login: verify the password ONCE, return a short-lived token ----
  if (body.action === "admin-login") {
    if (!(await checkAdminPassword(body.adminPassword))) return json({ error: "wrong admin password" }, 401);
    const row = await getAdminSecretRow();
    const token = await issueToken("admin", row!.session_version, 4 * 3600); // 4h
    return json({ ok: true, token });
  }

  if (body.action === "admin-config") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    return json({ config: D });
  }

  if (body.action === "update-config") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    const { error } = await supabase.from("pricing_config")
      .update({ data: body.config, updated_at: new Date().toISOString() }).eq("id", 1);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (body.action === "change-admin-password") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    if (!body.newPassword || body.newPassword.length < 6) return json({ error: "new password too short" }, 400);
    const row = await getAdminSecretRow();
    const newVer = (row?.session_version || 1) + 1; // bump -> every other open admin session is logged out
    const { error } = await supabase.from("admin_secret")
      .update({ password_hash: await sha256Hex(body.newPassword), session_version: newVer, updated_at: new Date().toISOString() })
      .eq("id", 1);
    if (error) return json({ error: error.message }, 500);
    const token = await issueToken("admin", newVer, 4 * 3600); // keep the current tab logged in
    return json({ ok: true, token });
  }

  if (body.action === "admin-view") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    let inp: any;
    try { inp = resolveInput(D, body.input); } catch (e) { return json({ error: (e as Error).message }, 400); }
    const q = computeQuote(D, inp);
    return json({ config: D, quote: adminView(q) });
  }

  // Verifies a rep's PASSWORD directly. Only used by rep-login now — every
  // other rep action verifies a short-lived TOKEN instead (see checkRepToken).
  async function checkRep(username: string | undefined, password: string | undefined) {
    if (!username || !password) return null;
    const { data, error } = await supabase.from("reps")
      .select("username, password_hash, display_name, active, session_version").eq("username", username).single();
    if (error || !data || !data.active) return null;
    if ((await sha256Hex(password)) !== data.password_hash) return null;
    return { username: data.username, displayName: data.display_name, sessionVersion: data.session_version };
  }

  // Verifies a rep session token: signature, expiry, subject, still-active
  // flag, AND that its embedded `ver` matches reps.session_version (so a
  // password reset or deactivation instantly kills tokens issued before it).
  async function checkRepToken(token: string | undefined) {
    const payload = await readToken(token);
    if (!payload || !payload.sub.startsWith("rep:")) return null;
    const username = payload.sub.slice(4);
    const { data, error } = await supabase.from("reps")
      .select("username, display_name, active, session_version").eq("username", username).single();
    if (error || !data || !data.active) return null;
    if (payload.ver !== data.session_version) return null;
    return { username: data.username, displayName: data.display_name };
  }

  function phoneKey(raw: string) {
  const digits = (raw || "").replace(/\D/g, "");
  return digits.length > 9 ? digits.slice(-9) : digits;
}

// ---- rep login: verify the password ONCE, return a short-lived token ----
  if (body.action === "rep-login") {
    const rep = await checkRep(body.username, body.password);
    if (!rep) return json({ error: "بيانات الدخول غير صحيحة" }, 401);
    const token = await issueToken(`rep:${rep.username}`, rep.sessionVersion, 12 * 3600); // 12h
    return json({ ok: true, displayName: rep.displayName, token });
  }

  // ---- has this client already received a quote, from whom, at what price? ----
  if (body.action === "find-client") {
    const rep = await checkRepToken(body.token);
    if (!rep) return json({ error: "الجلسة منتهية، الرجاء تسجيل الدخول مجددًا" }, 401);
    const phone = phoneKey(body.phone);
    if (phone.length < 5) return json({ matches: [] });

    const cols = "rep_display_name, client_name, client_phone, hp, final_total, snapshot, created_at";
    const rawDigits = (body.phone || "").replace(/\D/g, "");
    const { data, error } = await supabase.from("quotes").select(cols)
      .or(`client_phone.eq.${phone},client_phone.eq.${rawDigits}`)
      .order("created_at", { ascending: false }).limit(20);
    if (error) return json({ error: error.message }, 500);

    const invBrands = getInverterBrands(D);
    const matches = (data || []).map((m: any) => {
      const s = m.snapshot || {};
      const panel = D.panels[s.panelIdx];
      const invBrand = invBrands[s.inverterBrandIdx ?? 0];
      return {
        ...m,
        panelLabel: panel ? `${panel.brand} ${panel.power}W` : "-",
        invBrandLabel: invBrand ? invBrand.brand : "-",
        structureType: s.structureType === "ROTATIONAL" ? "متحرك" : "ثابت",
      };
    });
    return json({ matches });
  }

  // ---- save every finalized quote centrally, tagged with the rep who made it ----
  if (body.action === "save-quote") {
    let repUsername: string | null = null, repDisplayName = "الحاسبة الآلية (تسعير مباشر من العميل)";
    if (!body.guest) {
      const rep = await checkRepToken(body.token);
      if (!rep) return json({ error: "الجلسة منتهية، الرجاء تسجيل الدخول مجددًا" }, 401);
      repUsername = rep.username; repDisplayName = rep.displayName;
    }
    const { error } = await supabase.from("quotes").insert({
      rep_username: repUsername,
      rep_display_name: repDisplayName,
      client_name: body.clientName || "",
      client_phone: phoneKey(body.clientPhone),
      hp: body.hp || null,
      final_total: body.finalTotal || null,
      snapshot: body.snapshot || null,
    });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ---- admin: manage rep accounts ----
  if (body.action === "admin-list-reps") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    const { data, error } = await supabase.from("reps").select("id, username, display_name, active").order("id");
    if (error) return json({ error: error.message }, 500);
    return json({ reps: data || [] });
  }

  if (body.action === "admin-save-rep") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    const row: any = { username: body.username, display_name: body.displayName, active: body.active !== false };
    if (body.password) {
      row.password_hash = await sha256Hex(body.password);
      // New password -> bump this rep's session_version so any of their
      // existing tokens (e.g. on a phone they lost) stop working immediately.
      if (body.id) {
        const { data: existing } = await supabase.from("reps").select("session_version").eq("id", body.id).single();
        row.session_version = (existing?.session_version || 1) + 1;
      }
    }
    if (body.id) {
      const { error } = await supabase.from("reps").update(row).eq("id", body.id);
      if (error) return json({ error: error.message }, 500);
    } else {
      if (!body.password) return json({ error: "password required for new rep" }, 400);
      const { error } = await supabase.from("reps").insert(row);
      if (error) return json({ error: error.message }, 500);
    }
    return json({ ok: true });
  }

  if (body.action === "admin-delete-rep") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    const { error } = await supabase.from("reps").delete().eq("id", body.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ---- lead logging: relay to the sales team's Google Sheet webhook ----
  // Runs server-side so it works regardless of the caller's browser (no-cors
  // client-side fetches can silently fail); failures here never block the quote.
  // ---- product catalog: reference list prices for standalone sales (any rep can view) ----
  // ---- admin: upload a product/category image to Supabase Storage ----
  if (body.action === "upload-product-image") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    if (!body.imageBase64 || !body.filename) return json({ error: "imageBase64 and filename required" }, 400);
    try {
      const base64 = String(body.imageBase64).split(",").pop()!; // strip data:...;base64, prefix if present
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const ext = (body.filename.split(".").pop() || "jpg").toLowerCase();
      const safeName = `${crypto.randomUUID()}.${ext}`;
      const contentType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      const { error: upErr } = await supabase.storage.from("product-images").upload(safeName, bytes, { contentType, upsert: true });
      if (upErr) return json({ error: upErr.message }, 500);
      const { data: pub } = supabase.storage.from("product-images").getPublicUrl(safeName);
      return json({ url: pub.publicUrl });
    } catch (e) {
      return json({ error: (e as Error).message }, 500);
    }
  }

  if (body.action === "get-product-catalog") {
    return json({ productCatalog: D.productCatalog || [] });
  }

  if (body.action === "log-lead") {
    const url = D.leadsWebhookUrl;
    if (url) {
      try {
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: JSON.stringify(body.lead || {}),
        });
      } catch (_e) { /* best-effort, ignore */ }
    }
    return json({ ok: true });
  }

  // default: "quote" — public, sell-side numbers only
  let inp: any;
  try { inp = resolveInput(D, body.input); } catch (e) { return json({ error: (e as Error).message }, 400); }
  const q = computeQuote(D, inp);
  return json({
    quote: publicView(q),
    feas: D.feas,
    // panel options for the dropdown: brand/power only, never the per-watt cost
    panelOptions: D.panels
      .map((p: any, idx: number) => ({ idx, brand: p.brand, power: p.power, visible: p.visible !== false, hasPrice: !!p.priceW }))
      .filter((p: any) => p.visible && p.hasPrice)
      .map((p: any) => ({ idx: p.idx, brand: p.brand, power: p.power })),
    // inverter brand options for the dropdown: brand name only, never list/cost/discount
    inverterBrandOptions: getInverterBrands(D).map((b: any, idx: number) => ({ idx, brand: b.brand })),
  });
});
