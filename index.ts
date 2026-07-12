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

  async function checkAdminPassword(pw: string | undefined): Promise<boolean> {
    if (!pw) return false;
    const { data, error } = await supabase.from("admin_secret").select("password_hash").eq("id", 1).single();
    if (error || !data || !data.password_hash) return false;
    return (await sha256Hex(pw)) === data.password_hash;
  }

  if (body.action === "admin-config") {
    if (!(await checkAdminPassword(body.adminPassword))) return json({ error: "wrong admin password" }, 401);
    return json({ config: D });
  }

  if (body.action === "update-config") {
    if (!(await checkAdminPassword(body.adminPassword))) return json({ error: "wrong admin password" }, 401);
    const { error } = await supabase.from("pricing_config")
      .update({ data: body.config, updated_at: new Date().toISOString() }).eq("id", 1);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (body.action === "change-admin-password") {
    if (!(await checkAdminPassword(body.currentPassword))) return json({ error: "wrong admin password" }, 401);
    if (!body.newPassword || body.newPassword.length < 6) return json({ error: "new password too short" }, 400);
    const { error } = await supabase.from("admin_secret")
      .update({ password_hash: await sha256Hex(body.newPassword), updated_at: new Date().toISOString() }).eq("id", 1);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (body.action === "admin-view") {
    if (!(await checkAdminPassword(body.adminPassword))) return json({ error: "wrong admin password" }, 401);
    let inp: any;
    try { inp = resolveInput(D, body.input); } catch (e) { return json({ error: (e as Error).message }, 400); }
    const q = computeQuote(D, inp);
    return json({ config: D, quote: adminView(q) });
  }

  async function checkRep(username: string | undefined, password: string | undefined) {
    if (!username || !password) return null;
    const { data, error } = await supabase.from("reps")
      .select("username, password_hash, display_name, active").eq("username", username).single();
    if (error || !data || !data.active) return null;
    if ((await sha256Hex(password)) !== data.password_hash) return null;
    return { username: data.username, displayName: data.display_name };
  }

  // ---- rep login: every rep has their own username/password ----
  if (body.action === "rep-login") {
    const rep = await checkRep(body.username, body.password);
    if (!rep) return json({ error: "بيانات الدخول غير صحيحة" }, 401);
    return json({ ok: true, displayName: rep.displayName });
  }

  // ---- has this client already received a quote, from whom, at what price? ----
  if (body.action === "find-client") {
    const rep = await checkRep(body.username, body.password);
    if (!rep) return json({ error: "بيانات الدخول غير صحيحة" }, 401);
    const name = (body.name || "").trim();
    const phone = (body.phone || "").replace(/\D/g, "");
    if (name.length < 3 && phone.length < 5) return json({ matches: [] });

    const cols = "rep_display_name, client_name, client_phone, hp, final_total, snapshot, created_at";
    const results: any[] = [];
    if (name.length >= 3) {
      const { data } = await supabase.from("quotes").select(cols)
        .ilike("client_name", name).order("created_at", { ascending: false }).limit(10);
      if (data) results.push(...data);
    }
    if (phone.length >= 5) {
      const { data } = await supabase.from("quotes").select(cols)
        .eq("client_phone", phone).order("created_at", { ascending: false }).limit(10);
      if (data) results.push(...data);
    }
    const seen = new Set<string>();
    const matches = results
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .filter(r => {
        const key = r.created_at + "|" + r.client_phone;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 10);
    return json({ matches });
  }

  // ---- save every finalized quote centrally, tagged with the rep who made it ----
  if (body.action === "save-quote") {
    const rep = await checkRep(body.username, body.password);
    if (!rep) return json({ error: "بيانات الدخول غير صحيحة" }, 401);
    const { error } = await supabase.from("quotes").insert({
      rep_username: rep.username,
      rep_display_name: rep.displayName,
      client_name: body.clientName || "",
      client_phone: (body.clientPhone || "").replace(/\D/g, ""),
      hp: body.hp || null,
      final_total: body.finalTotal || null,
      snapshot: body.snapshot || null,
    });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ---- admin: manage rep accounts ----
  if (body.action === "admin-list-reps") {
    if (!(await checkAdminPassword(body.adminPassword))) return json({ error: "wrong admin password" }, 401);
    const { data, error } = await supabase.from("reps").select("id, username, display_name, active").order("id");
    if (error) return json({ error: error.message }, 500);
    return json({ reps: data || [] });
  }

  if (body.action === "admin-save-rep") {
    if (!(await checkAdminPassword(body.adminPassword))) return json({ error: "wrong admin password" }, 401);
    const row: any = { username: body.username, display_name: body.displayName, active: body.active !== false };
    if (body.password) row.password_hash = await sha256Hex(body.password);
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
    if (!(await checkAdminPassword(body.adminPassword))) return json({ error: "wrong admin password" }, 401);
    const { error } = await supabase.from("reps").delete().eq("id", body.id);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  // ---- lead logging: relay to the sales team's Google Sheet webhook ----
  // Runs server-side so it works regardless of the caller's browser (no-cors
  // client-side fetches can silently fail); failures here never block the quote.
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
