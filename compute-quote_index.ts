// HoloulEnergy KSA — compute-quote Edge Function
//
// This function is the ONLY place the pricing engine, cost basis and margins
// live. The browser never receives DEFAULT_DB, never sees costBasis/profit,
// and never verifies the admin password itself — all of that happens here,
// server-side, using the service_role key (which is never exposed to users).
//
// Deploy with:  supabase functions deploy compute-quote

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
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(b64urlToString(payloadB64));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function pickLadder(ladder: number[], value: number) {
  for (const v of ladder) if (value <= v) return v;
  return ladder[ladder.length - 1];
}
function pickInverter(kwNeeded: number, list: number[][]) {
  for (const row of list) if (kwNeeded <= row[0]) return row;
  return list[list.length - 1];
}
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

  const invMaxSolarKw: number | undefined = inv[3];
  let inverterOversizeWarning: { message: string; recommendedInvKW: number | null } | null = null;
  if (invMaxSolarKw != null && calcKW > invMaxSolarKw) {
    const idx = invBrand.tiers.indexOf(inv);
    const nextTier = invBrand.tiers.slice(idx + 1).find((t: any[]) => t[3] == null || calcKW <= t[3]);
    const recommendedInvKW = nextTier ? nextTier[0] : null;
    inverterOversizeWarning = {
      recommendedInvKW,
      message: recommendedInvKW
        ? `⚠️ قدرة الألواح المُدخلة (${calcKW.toFixed(1)} كيلوواط) تتجاوز الحد الأقصى الذي يتحمله انفرتر ${invKW} كيلوواط (${invMaxSolarKw} كيلوواط كحد أقصى) — يلزم رفع قدرة الانفرتر إلى ${recommendedInvKW} كيلوواط على الأقل.`
        : `⚠️ قدرة الألواح المُدخلة (${calcKW.toFixed(1)} كيلوواط) تتجاوز الحد الأقصى الذي يتحمله انفرتر ${invKW} كيلوواط (${invMaxSolarKw} كيلوواط كحد أقصى) — لا يوجد طراز أعلى متاح حاليًا في قائمة الانفرتر، راجع الإعداد يدويًا.`,
    };
  }

  const reactorModel = pickLadder(D.reactorLadder, Iimp);
  const reactorPrice = D.reactorPrices[String(reactorModel)];
  const cbSize = pickLadder(D.cbLadder, IscCalc);
  const combiner = inp.combinerOverride || pickCombiner(arrays, D.combinerBoxes, D.combinerHeadroom, D.combinerMinSpareStrings);

  const panelCost = panel.priceW * calcKW * 1000;
  const panelSell = (panel.priceW + (D.panelMarginPerWatt || 0)) * calcKW * 1000;
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
  const reactorSell = reactorCost * (1 + (D.reactorMarkupPct || 0) / 100);
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

  push("panel", "ألواح الطاقة الشمسية", t.panel, panelSell, panelCost, {
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
  push("reactor", "الريأكتور", t.reactor, reactorSell, reactorCost, {
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
  const manualDiscountAmt = Math.min(netAfterDiscount, inp.specialDiscountAmt || 0);
  const netAfterManual = netAfterDiscount - manualDiscountAmt;
  const vat = netAfterManual * D.vat;
  const finalTotal = netAfterManual + vat;

  const rawItemBasis: Record<string, { sell: number; costBasis: number }> = {
    panel: { sell: panelSell, costBasis: panelCost },
    inverter: { sell: invList, costBasis: invCost },
    ip65: { sell: steelPanelCost * 1.25, costBasis: steelPanelCost },
    combiner: { sell: combinerCost * 1.3, costBasis: combinerCost },
    cables: { sell: cablesCost * D.cableMarkup, costBasis: cablesCost },
    mc4: { sell: mc4Cost * 1.5, costBasis: mc4Cost },
    structure: { sell: structureCost * 1.1, costBasis: structureCost },
    concrete: { sell: concreteCost * 1.1, costBasis: concreteCost },
    earth: { sell: earthCost, costBasis: earthCost },
    reactor: { sell: reactorSell, costBasis: reactorCost },
    install_mech: { sell: mechInstallCost, costBasis: mechInstallCost },
    install_elec: { sell: elecInstallCost, costBasis: elecInstallCost },
    transport: { sell: transportCost, costBasis: transportCost },
  };
  function variantTotal(includeKeys: string[]): number {
    let sT = 0, dT = 0;
    for (const key of includeKeys) {
      const basis = rawItemBasis[key];
      if (!basis) continue;
      const margin = basis.sell - basis.costBasis;
      dT += key === "panel" ? 0 : margin * factor;
      sT += basis.sell;
    }
    dT = Math.round(dT / 10) * 10;
    const net = sT - dT;
    return Math.round(net + net * D.vat);
  }
  const supplyOnlyTotal = variantTotal(["panel", "inverter", "combiner", "mc4", "cables"]);
  const supplyPlusInstallTotal = variantTotal([
    "panel", "inverter", "ip65", "combiner", "cables", "mc4",
    "structure", "concrete", "install_mech", "install_elec", "transport",
  ]);

  return {
    panelsPerString, arrays, totalPanels, calcKW, efficiencyRatio,
    Iimp, Vimp, Voc, Isc, IscCalc, expectedVAC,
    invBrandName: invBrand.brand,
    inverterCalcKW, invKW, invMaxSolarKw: invMaxSolarKw ?? null, inverterOversizeWarning,
    reactorModel, reactorPrice, cbSize, combiner,
    items, sellTotal, discountTotal, netAfterDiscount, manualDiscountAmt,
    netAfterManual, vat, finalTotal, sarPerKW: finalTotal / calcKW,
    supplyOnlyTotal, supplyPlusInstallTotal,
  };
}

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
  const profit = q.netAfterManual - totalCost;
  const profitPct = q.netAfterManual ? (profit / q.netAfterManual) * 100 : 0;
  return { ...q, totalCost, profit, profitPct };
}

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

function findCatalogCategory(D: any, nameIncludes: string) {
  const cat = (D.productCatalog || []).find((c: any) => (c.category || "").includes(nameIncludes));
  if (!cat) throw new Error(`productCatalog category "${nameIncludes}" not found`);
  return cat;
}

// ---------------------------------------------------------------------
// Per-(category, brand) discount registry (D.discounts). This lets the
// admin record, for a whole brand within a catalog category at once:
//   supplierDiscountPct  -> % off the catalog list price = the company's
//                            TRUE COST (never shown to client/rep/public).
//   sellDiscountPct      -> % off the catalog list price = the price
//                            actually used when computing a rep's price
//                            quote for that item (replaces the old flat
//                            markupPct mechanism for that brand once set).
//   promoDiscountPct/
//   promoActive          -> % off the catalog list price shown ONLY on
//                            the public product catalog page — fully
//                            independent of the two above, never touches
//                            cost or quote pricing.
// Validation rule: sellDiscountPct must always be <= supplierDiscountPct
// so the company can never sell below its own cost.
// If no discount row exists yet for a (category, brand) pair, every
// function below falls back exactly to the pre-existing behaviour
// (costBasis = list price, sell = list price * (1 + legacy markup%)) so
// nothing changes for brands the admin hasn't configured yet.
// ---------------------------------------------------------------------
function rowBrand(cat: any, rowIdx: number): string {
  const detail = cat.productDetails && cat.productDetails[String(rowIdx)];
  return (detail && detail.brand) || "";
}
function findDiscount(D: any, category: string, brand: string) {
  return (Array.isArray(D.discounts) ? D.discounts : [])
    .find((d: any) => d.category === category && d.brand === brand) || null;
}
function resolveCatalogPricing(
  D: any, category: string, brand: string, listPrice: number, fallbackMarkupPct: number,
): { costBasis: number; sell: number } {
  const d = findDiscount(D, category, brand);
  if (d) {
    const supplierPct = Number(d.supplierDiscountPct) || 0;
    const sellPct = Number(d.sellDiscountPct) || 0;
    return {
      costBasis: listPrice * (1 - supplierPct / 100),
      sell: listPrice * (1 - sellPct / 100),
    };
  }
  return {
    costBasis: listPrice,
    sell: listPrice * (1 + (fallbackMarkupPct || 0) / 100),
  };
}

function parseKwFromModel(model: string): number {
  const m = String(model).match(/([\d.]+)\s*KW/i);
  return m ? parseFloat(m[1]) : 0;
}
function getInverterCatalogRows(D: any) {
  const cat = findCatalogCategory(D, "انفرتر");
  const priceIdx = cat.columns.length - 2;
  return cat.rows
    .map((r: any, idx: number) => ({
      model: r[0], kw: parseKwFromModel(r[0]), listPrice: parseFloat(r[priceIdx]),
      category: cat.category, brand: rowBrand(cat, idx),
    }))
    .filter((r: any) => r.kw > 0 && !/^VLT|^VHT|Rack/i.test(r.model))
    .sort((a: any, b: any) => a.kw - b.kw);
}
function getInverterModelOptions(D: any) {
  return getInverterCatalogRows(D).map((r: any) => ({ model: r.model, kw: r.kw }));
}
function pickCatalogInverter(D: any, kwNeeded: number) {
  const rows = getInverterCatalogRows(D);
  if (!rows.length) throw new Error('لا يوجد أي موديل انفرتر هجين بقدرة (KW) واضحة في اسم الموديل داخل كتالوج "شواحن/انفرترات هجين MPPT"');
  return rows.find((r: any) => r.kw >= kwNeeded) || rows[rows.length - 1];
}
// Lets the customer pick a SPECIFIC inverter model instead of always the
// auto-nearest one — if that model's kW is less than the required peak load,
// multiple units are put in PARALLEL automatically (count = ceil(needed/unit))
// so the combined capacity still covers the load, mirroring exactly how the
// battery bank auto-stacks to reach the required voltage/capacity.
function pickCatalogInverterMulti(D: any, kwNeeded: number, requestedModel?: string) {
  const rows = getInverterCatalogRows(D);
  if (!rows.length) throw new Error('لا يوجد أي موديل انفرتر هجين بقدرة (KW) واضحة في اسم الموديل داخل كتالوج "شواحن/انفرترات هجين MPPT"');
  let unit: any;
  if (requestedModel) {
    unit = rows.find((r: any) => r.model === requestedModel);
    if (!unit) throw new Error(`الموديل "${requestedModel}" غير موجود داخل كتالوج الانفرتر`);
  } else {
    unit = rows.find((r: any) => r.kw >= kwNeeded) || rows[rows.length - 1];
  }
  const count = Math.max(1, Math.ceil(kwNeeded / unit.kw));
  return { ...unit, count, totalKw: unit.kw * count };
}
// Battery rows: [model, current(A), voltage(V), priceExclTax, priceInclTax].
// The catalog carries a battery module at several nominal voltages (e.g.
// 12.8V / 25.6V / 51.2V cells of the same chemistry) — the highest voltage
// present is treated as the "full bus" reference (typically ~48-51V for
// hybrid inverters), and any lower-voltage module the customer picks gets
// stacked in SERIES to reach that same bus voltage automatically (e.g. a
// 25.6V module needs 2 in series to reach ~51.2V), then in PARALLEL strings
// to meet the required kWh. This mirrors how these battery banks are wired
// in the field, so the customer can choose their preferred module voltage
// and still get a correctly-sized, correctly-wired bank.
function getBatteryVoltageOptions(D: any): number[] {
  const cat = findCatalogCategory(D, "بطاريات ليثيوم");
  const voltages = Array.from(new Set(
    cat.rows.map((r: any) => Math.round(parseFloat(r[2]) * 10) / 10).filter((v: number) => v > 0)
  )) as number[];
  return voltages.sort((a, b) => a - b);
}
function pickCatalogBattery(D: any, nameplateKwhNeeded: number, requestedVoltage?: number) {
  const cat = findCatalogCategory(D, "بطاريات ليثيوم");
  const allRows = cat.rows
    .map((r: any, idx: number) => ({
      model: r[0],
      voltage: Math.round(parseFloat(r[2]) * 10) / 10,
      current: parseFloat(r[1]),
      listPrice: parseFloat(r[3]),
      brand: rowBrand(cat, idx),
    }))
    .filter((r: any) => r.voltage > 0)
    .map((r: any) => ({ ...r, kwh: (r.current * r.voltage) / 1000 }));
  if (!allRows.length) throw new Error('لا يوجد أي موديل بطارية داخل كتالوج "بطاريات ليثيوم"');

  const busVoltage = Math.max(...allRows.map((r: any) => r.voltage));
  const targetVoltage = requestedVoltage && requestedVoltage > 0 ? requestedVoltage : busVoltage;

  const candidates = allRows.filter((r: any) => Math.abs(r.voltage - targetVoltage) < 0.05);
  if (!candidates.length) throw new Error(`لا يوجد أي موديل بطارية بفولت ${targetVoltage}V داخل الكتالوج`);
  const unit = candidates.sort((a: any, b: any) => b.kwh - a.kwh)[0];

  const seriesCount = Math.max(1, Math.round(busVoltage / unit.voltage));
  const packKwh = unit.kwh * seriesCount;
  const packVoltage = unit.voltage * seriesCount;
  const parallelCount = Math.max(1, Math.ceil(nameplateKwhNeeded / packKwh));
  const totalCount = seriesCount * parallelCount;

  return {
    unit, count: totalCount, totalKwh: packKwh * parallelCount,
    seriesCount, parallelCount, packVoltage, busVoltage, category: cat.category,
  };
}

function buildGenericItems(pushImpl: any, opts: {
  panel: any; totalPanels: number; calcKW: number; panelMarginPerWatt: number;
  inverterLabel: string; inverterType: string; inverterCostBasis: number; inverterSell: number; inverterCount?: number;
  structureCost: number; structureSell: number;
  cablingCost: number; cablingSell: number;
  installCost: number; installSell: number;
  battery?: { unit: any; count: number; totalKwh: number; costBasis: number; sell: number; seriesCount?: number; parallelCount?: number; packVoltage?: number };
}) {
  const panelCost = opts.panel.priceW * opts.calcKW * 1000;
  const panelSell = (opts.panel.priceW + (opts.panelMarginPerWatt || 0)) * opts.calcKW * 1000;
  pushImpl("panel", "ألواح الطاقة الشمسية", panelSell, panelCost, {
    type: `${opts.panel.brand} ${opts.panel.power}W أو ما يعادلها`, qty: `#${opts.totalPanels}#`,
    warranty: "12 سنة ضد عيوب الصناعة / 30 سنة ضد التناقص الإنتاجي عن %80",
  });
  const invCount = opts.inverterCount || 1;
  pushImpl("inverter", opts.inverterLabel, opts.inverterSell * invCount, opts.inverterCostBasis * invCount, {
    type: opts.inverterType, qty: `#${invCount}#`, warranty: "سنة واحدة",
  });
  if (opts.battery) {
    const sell = opts.battery.sell;
    const costBasis = opts.battery.costBasis;
    const wiring = (opts.battery.seriesCount || 1) > 1
      ? ` (${opts.battery.seriesCount} توالي × ${opts.battery.parallelCount} توازي = ${(opts.battery.packVoltage||0).toFixed(0)}V)`
      : ((opts.battery.parallelCount||1) > 1 ? ` (${opts.battery.parallelCount} توازي)` : '');
    pushImpl("battery", "بنك البطاريات (ليثيوم)", sell, costBasis, {
      type: `${opts.battery.unit.model} أو ما يعادلها${wiring}`, qty: `#${opts.battery.count}#`, warranty: "5 سنوات",
    });
  }
  pushImpl("structure", "الشاسيه/الحوامل", opts.structureSell, opts.structureCost, {
    type: "-", qty: `#${opts.totalPanels}#`, warranty: "عشر سنوات",
  });
  pushImpl("cabling", "الكابلات ولوحة الحماية", opts.cablingSell, opts.cablingCost, {
    type: "-", qty: "#1#", warranty: "سنة واحدة",
  });
  pushImpl("install", "التركيب والتشغيل", opts.installSell, opts.installCost, {
    type: "-", qty: "-", warranty: "عام واحد فقط من تاريخ التشغيل",
  });
}

function finalizeQuote(items: any[], discountFactor: number, D: any, manualDiscountAmt: number) {
  let sellTotal = 0, discountTotal = 0;
  for (const it of items) {
    const margin = it.sell - it.costBasis;
    const discount = it.key === "panel" ? 0 : margin * discountFactor;
    it.discount = discount;
    it.net = it.sell - discount;
    sellTotal += it.sell;
    discountTotal += discount;
  }
  discountTotal = Math.round(discountTotal / 10) * 10;
  const netAfterDiscount = sellTotal - discountTotal;
  const manualDiscount = Math.min(netAfterDiscount, manualDiscountAmt || 0);
  const netAfterManual = netAfterDiscount - manualDiscount;
  const vat = netAfterManual * D.vat;
  const finalTotal = netAfterManual + vat;
  return { sellTotal, discountTotal, netAfterDiscount, manualDiscountAmt: manualDiscount, netAfterManual, vat, finalTotal };
}

function computeOffgridQuote(D: any, inp: any) {
  const og = D.offgrid;
  const panel = inp.panel;

  const dailyKwh = inp.method === "appliances"
    ? (inp.appliances || []).reduce((s: number, a: any) => {
        const hrs = (+a.dayHours || 0) + (+a.nightHours || 0);
        return s + ((+a.watts || 0) * hrs * (+a.qty || 1)) / 1000;
      }, 0)
    : (+inp.dailyKwh || 0);
  if (dailyKwh <= 0) throw new Error("الاستهلاك اليومي يجب أن يكون أكبر من صفر");

  const peakKw = inp.method === "appliances"
    ? (inp.appliances || []).reduce((s: number, a: any) => s + ((+a.watts || 0) * (+a.qty || 1)) / 1000, 0)
    : dailyKwh / (og.peakLoadDivisor || 6);

  const requiredArrayKw = dailyKwh / (og.sunHours * og.systemEfficiency);
  const totalPanels = Math.max(1, Math.ceil((requiredArrayKw * 1000) / panel.power));
  const calcKW = (totalPanels * panel.power) / 1000;

  const autonomyDaysRaw = inp.autonomyDays;
  const autonomyDays = Math.max(
    0,
    (autonomyDaysRaw === undefined || autonomyDaysRaw === null || autonomyDaysRaw === "")
      ? (og.defaultAutonomyDays ?? 0)
      : (+autonomyDaysRaw || 0)
  );
  const nameplateBatteryKwh = (dailyKwh * autonomyDays) / og.batteryDoD;
  const battery = pickCatalogBattery(D, nameplateBatteryKwh, inp.batteryVoltage);
  const batteryPricing = resolveCatalogPricing(D, battery.category, battery.unit.brand, battery.unit.listPrice, og.batteryMarkupPct);

  const inv = pickCatalogInverterMulti(D, peakKw, inp.inverterModel);
  const invPricing = resolveCatalogPricing(D, inv.category, inv.brand, inv.listPrice, og.inverterMarkupPct);

  const items: any[] = [];
  const push = (key: string, label: string, sell: number, costBasis: number, meta: any = {}) =>
    items.push({ key, label, on: true, sell, costBasis, type: meta.type || "-", qty: meta.qty || "-", warranty: meta.warranty || "-" });

  buildGenericItems(push, {
    panel, totalPanels, calcKW, panelMarginPerWatt: D.panelMarginPerWatt || 0,
    inverterLabel: "شاحن/انفرتر هجين MPPT", inverterType: `${inv.model} أو ما يعادله`,
    inverterCostBasis: invPricing.costBasis, inverterSell: invPricing.sell, inverterCount: inv.count,
    structureCost: totalPanels * og.structurePerPanelCost, structureSell: totalPanels * og.structurePerPanelSell,
    cablingCost: og.cablingFixedCost, cablingSell: og.cablingFixedSell,
    installCost: calcKW * og.installPerKwCost, installSell: calcKW * og.installPerKwSell,
    battery: { ...battery, costBasis: batteryPricing.costBasis * battery.count, sell: batteryPricing.sell * battery.count },
  });

  const totals = finalizeQuote(items, inp.discountFactor, D, inp.specialDiscountAmt);
  return {
    dailyKwh, peakKw, actualKw: calcKW, totalPanels,
    invKw: inv.kw, invModel: inv.model, invCount: inv.count, invTotalKw: inv.totalKw,
    nameplateBatteryKwh: battery.totalKwh, autonomyDays,
    batterySeriesCount: battery.seriesCount, batteryParallelCount: battery.parallelCount,
    batteryUnitVoltage: battery.unit.voltage, batteryPackVoltage: battery.packVoltage,
    batteryUnitKwh: battery.unit.kwh, batteryCount: battery.count,
    sunHours: og.sunHours, systemEfficiency: og.systemEfficiency,
    items, ...totals, sarPerKW: totals.finalTotal / calcKW,
  };
}

function computeOngridQuote(D: any, inp: any) {
  const ng = D.ongrid;
  const panel = inp.panel;

  let systemKw: number;
  if (inp.method === "kw") {
    systemKw = +inp.systemKw || 0;
  } else {
    const monthlyKwh = inp.method === "bill" ? (+inp.billSar || 0) / ng.tariffRate : (+inp.monthlyKwh || 0);
    const annualKwh = monthlyKwh * 12;
    systemKw = annualKwh / (ng.sunHours * 365 * ng.performanceRatio);
  }
  if (systemKw <= 0) throw new Error("قدرة المنظومة المحسوبة يجب أن تكون أكبر من صفر — راجع المدخلات");

  const totalPanels = Math.max(1, Math.ceil((systemKw * 1000) / panel.power));
  const calcKW = (totalPanels * panel.power) / 1000;

  const inv = pickCatalogInverter(D, calcKW);
  const invPricing = resolveCatalogPricing(D, inv.category, inv.brand, inv.listPrice, ng.inverterMarkupPct);

  const items: any[] = [];
  const push = (key: string, label: string, sell: number, costBasis: number, meta: any = {}) =>
    items.push({ key, label, on: true, sell, costBasis, type: meta.type || "-", qty: meta.qty || "-", warranty: meta.warranty || "-" });

  buildGenericItems(push, {
    panel, totalPanels, calcKW, panelMarginPerWatt: D.panelMarginPerWatt || 0,
    inverterLabel: "الانفرتر", inverterType: `${inv.model} أو ما يعادله`,
    inverterCostBasis: invPricing.costBasis, inverterSell: invPricing.sell,
    structureCost: totalPanels * ng.structurePerPanelCost, structureSell: totalPanels * ng.structurePerPanelSell,
    cablingCost: ng.cablingFixedCost, cablingSell: ng.cablingFixedSell,
    installCost: calcKW * ng.installPerKwCost, installSell: calcKW * ng.installPerKwSell,
  });
  if (ng.netMeteringFeeCost || ng.netMeteringFeeSell) {
    push("netmetering", "رسوم صافي القياس", ng.netMeteringFeeSell, ng.netMeteringFeeCost, { type: "-", qty: "#1#", warranty: "-" });
  }

  const totals = finalizeQuote(items, inp.discountFactor, D, inp.specialDiscountAmt);
  return {
    actualKw: calcKW, totalPanels, invKw: inv.kw,
    items, ...totals, sarPerKW: totals.finalTotal / calcKW,
  };
}

function resolveOffgridOngridInput(D: any, rawInput: any) {
  const panel = D.panels[rawInput.panelIdx];
  if (!panel) throw new Error("invalid panelIdx");
  const tierIdx = (rawInput.discountTierIdx ?? D.defaultDiscountIdx ?? 1);
  const tier = D.discountTiers[tierIdx] || D.discountTiers[D.defaultDiscountIdx ?? 1];
  return { ...rawInput, panel, discountFactor: tier.factor };
}

function findExactCatalogRow(D: any, categoryNameIncludes: string, model: string) {
  const cat = findCatalogCategory(D, categoryNameIncludes);
  const idx = cat.rows.findIndex((r: any) => r[0] === model);
  if (idx === -1) throw new Error(`الموديل "${model}" غير موجود`);
  const row = cat.rows[idx];
  const priceIdx = categoryNameIncludes === "بطاريات ليثيوم" ? 3 : cat.columns.length - 2;
  return { model: row[0], listPrice: parseFloat(row[priceIdx]), category: cat.category, brand: rowBrand(cat, idx) };
}

function computeReadySystemPrice(D: any, inp: {
  panelCount: number; panelIdx?: number;
  inverterModel: string | null; batteryModel: string; batteryCount: number;
}) {
  const og = D.offgrid;
  const panel = D.panels[inp.panelIdx ?? og.panelIdx ?? 0];
  if (!panel) throw new Error("invalid panelIdx");
  const panelCost = inp.panelCount * panel.power * panel.priceW;
  const panelSell = inp.panelCount * panel.power * (panel.priceW + (D.panelMarginPerWatt || 0));

  let inverterCostBasis = 0, inverterSell = 0;
  if (inp.inverterModel) {
    const inv = findExactCatalogRow(D, "انفرتر", inp.inverterModel);
    const invPricing = resolveCatalogPricing(D, inv.category, inv.brand, inv.listPrice, og.inverterMarkupPct);
    inverterCostBasis = invPricing.costBasis;
    inverterSell = invPricing.sell;
  }

  const bat = findExactCatalogRow(D, "بطاريات ليثيوم", inp.batteryModel);
  const batPricing = resolveCatalogPricing(D, bat.category, bat.brand, bat.listPrice, og.batteryMarkupPct);
  const batteryCostBasis = batPricing.costBasis * inp.batteryCount;
  const batterySell = batPricing.sell * inp.batteryCount;

  const cablingSell = og.cablingFixedSell;
  const sellTotal = panelSell + inverterSell + batterySell + cablingSell;
  const priceSar = Math.round(sellTotal * (1 + D.vat));

  return {
    priceSar,
    breakdown: {
      panelCost: Math.round(panelCost),
      inverterCostBasis, inverterSell: Math.round(inverterSell),
      batteryCostBasis, batterySell: Math.round(batterySell),
      cablingSell, sellTotal: Math.round(sellTotal), vat: D.vat,
    },
  };
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

  if (body.action === "hash-password") {
    if (!body.password) return json({ error: "password required" }, 400);
    return json({ hash: await sha256Hex(body.password) });
  }

  const { data: cfgRow, error: cfgErr } = await supabase
    .from("pricing_config").select("data").eq("id", 1).single();
  if (cfgErr || !cfgRow) return json({ error: "pricing config not found" }, 500);
  const D = cfgRow.data;

  async function getAdminSecretRow(): Promise<{ password_hash: string; session_version: number } | null> {
    const { data, error } = await supabase.from("admin_secret").select("password_hash, session_version").eq("id", 1).single();
    if (error || !data || !data.password_hash) return null;
    return data;
  }

  async function checkAdminPassword(pw: string | undefined): Promise<boolean> {
    if (!pw) return false;
    const row = await getAdminSecretRow();
    if (!row) return false;
    return (await sha256Hex(pw)) === row.password_hash;
  }

  async function checkAdminToken(token: string | undefined): Promise<boolean> {
    const payload = await readToken(token);
    if (!payload || payload.sub !== "admin") return false;
    const row = await getAdminSecretRow();
    if (!row) return false;
    return payload.ver === row.session_version;
  }

  if (body.action === "admin-login") {
    if (!(await checkAdminPassword(body.adminPassword))) return json({ error: "wrong admin password" }, 401);
    const row = await getAdminSecretRow();
    const ttl = body.rememberMe ? 14 * 24 * 3600 : 4 * 3600;
    const token = await issueToken("admin", row!.session_version, ttl);
    return json({ ok: true, token });
  }

  if (body.action === "admin-config") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    return json({ config: D });
  }

  const SECTION_CONFIG_KEYS: Record<string, string[]> = {
    pricing: ["cableHighMultiplier", "cableLowMultiplier", "cableMarkup", "cablePerMeter", "combinerHeadroom",
      "combinerMinSpareStrings", "concretePerUnit", "defaultDiscountIdx", "defaultInverterBrand", "defaultPanelKey",
      "discountTiers", "earthingPerUnit",
      "elecInstallPerPanel", "flexTubePerUnit", "hpCapacityRatio", "inverterBrands", "mc4PerUnit",
      "mechInstallPerPanel", "panelMarginPerWatt", "panels", "reactorMarkupPct", "steelPanelPerHP", "structurePriceFixed", "structurePriceRotational",
      "transportMinimum", "transportPerTrip", "vat"],
    calcs: ["offgrid", "ongrid"],
    products: ["bomItemImages", "productCatalog", "readyOffgridSystems", "readyOngridSystems"],
    portfolio: ["portfolio"],
  };

  if (body.action === "update-config") {
    if (await checkAdminToken(body.adminToken)) {
      if (Array.isArray(body.config?.discounts)) {
        for (const d of body.config.discounts) {
          const supplierPct = Number(d.supplierDiscountPct) || 0;
          const sellPct = Number(d.sellDiscountPct) || 0;
          if (sellPct > supplierPct) {
            return json({ error: `خصم البيع (${d.category || ""} / ${d.brand || ""}) لازم يكون أقل من أو يساوي خصم المورد` }, 400);
          }
        }
      }
      const { error } = await supabase.from("pricing_config")
        .update({ data: body.config, updated_at: new Date().toISOString() }).eq("id", 1);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    const rep = await checkRepToken(body.token);
    const section = body.section as string;
    const allowedKeys = SECTION_CONFIG_KEYS[section];
    if (!rep || !allowedKeys) return json({ error: "admin session expired" }, 401);
    if (!rep.permissions || !rep.permissions[section]) return json({ error: "ليس لديك صلاحية تعديل هذا القسم" }, 403);
    const merged: any = { ...D };
    for (const k of allowedKeys) {
      if (body.config && Object.prototype.hasOwnProperty.call(body.config, k)) merged[k] = body.config[k];
    }
    const { error } = await supabase.from("pricing_config")
      .update({ data: merged, updated_at: new Date().toISOString() }).eq("id", 1);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (body.action === "rep-config") {
    const rep = await checkRepToken(body.token);
    if (!rep) return json({ error: "الجلسة منتهية، الرجاء تسجيل الدخول مجددًا" }, 401);
    const out: any = {};
    for (const [section, keys] of Object.entries(SECTION_CONFIG_KEYS)) {
      if (!rep.permissions || !rep.permissions[section]) continue;
      for (const k of keys) out[k] = (D as any)[k];
    }
    return json({ config: out, permissions: rep.permissions || {} });
  }

  if (body.action === "change-admin-password") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    if (!body.newPassword || body.newPassword.length < 6) return json({ error: "new password too short" }, 400);
    const row = await getAdminSecretRow();
    const newVer = (row?.session_version || 1) + 1;
    const { error } = await supabase.from("admin_secret")
      .update({ password_hash: await sha256Hex(body.newPassword), session_version: newVer, updated_at: new Date().toISOString() })
      .eq("id", 1);
    if (error) return json({ error: error.message }, 500);
    const token = await issueToken("admin", newVer, 4 * 3600);
    return json({ ok: true, token });
  }

  if (body.action === "admin-view") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    let inp: any;
    try { inp = resolveInput(D, body.input); } catch (e) { return json({ error: (e as Error).message }, 400); }
    const q = computeQuote(D, inp);
    return json({ config: D, quote: adminView(q) });
  }

  if (body.action === "offgrid-admin-view") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    let inp: any;
    try { inp = resolveOffgridOngridInput(D, body.input); } catch (e) { return json({ error: (e as Error).message }, 400); }
    let q: any;
    try { q = computeOffgridQuote(D, inp); } catch (e) { return json({ error: (e as Error).message }, 400); }
    return json({ config: D, quote: adminView(q) });
  }

  if (body.action === "ongrid-admin-view") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    let inp: any;
    try { inp = resolveOffgridOngridInput(D, body.input); } catch (e) { return json({ error: (e as Error).message }, 400); }
    let q: any;
    try { q = computeOngridQuote(D, inp); } catch (e) { return json({ error: (e as Error).message }, 400); }
    return json({ config: D, quote: adminView(q) });
  }

  async function checkRep(username: string | undefined, password: string | undefined) {
    if (!username || !password) return null;
    const { data, error } = await supabase.from("reps")
      .select("username, password_hash, display_name, active, session_version, permissions").eq("username", username).single();
    if (error || !data || !data.active) return null;
    if ((await sha256Hex(password)) !== data.password_hash) return null;
    return { username: data.username, displayName: data.display_name, sessionVersion: data.session_version, permissions: data.permissions || {} };
  }

  async function checkRepToken(token: string | undefined) {
    const payload = await readToken(token);
    if (!payload || !payload.sub.startsWith("rep:")) return null;
    const username = payload.sub.slice(4);
    const { data, error } = await supabase.from("reps")
      .select("username, display_name, active, session_version, permissions").eq("username", username).single();
    if (error || !data || !data.active) return null;
    if (payload.ver !== data.session_version) return null;
    return { username: data.username, displayName: data.display_name, permissions: data.permissions || {} };
  }

  function phoneKey(raw: string) {
  const digits = (raw || "").replace(/\D/g, "");
  return digits.length > 9 ? digits.slice(-9) : digits;
}

  async function upsertCustomer(name: string, phone: string, repUsername: string | null): Promise<number | null> {
    if (!phone) return null;
    const now = new Date().toISOString();
    const { data: existing } = await supabase.from("customers")
      .select("id, quotes_count").eq("phone", phone).maybeSingle();
    if (existing) {
      const upd: any = { quotes_count: (existing.quotes_count || 0) + 1, last_quote_at: now, updated_at: now };
      if (name) upd.name = name;
      if (repUsername) upd.rep_username = repUsername;
      await supabase.from("customers").update(upd).eq("id", existing.id);
      return existing.id;
    }
    const { data: inserted, error } = await supabase.from("customers")
      .insert({ name: name || "", phone, rep_username: repUsername, quotes_count: 1, first_quote_at: now, last_quote_at: now, updated_at: now })
      .select("id").single();
    if (error || !inserted) return null;
    return inserted.id;
  }

  if (body.action === "rep-login") {
    const rep = await checkRep(body.username, body.password);
    if (!rep) return json({ error: "بيانات الدخول غير صحيحة" }, 401);
    const ttl = body.rememberMe ? 14 * 24 * 3600 : 12 * 3600;
    const token = await issueToken(`rep:${rep.username}`, rep.sessionVersion, ttl);
    return json({ ok: true, displayName: rep.displayName, token, permissions: rep.permissions });
  }

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

  if (body.action === "save-quote") {
    let repUsername: string | null = null, repDisplayName = "الحاسبة الآلية (تسعير مباشر من العميل)";
    if (!body.guest) {
      const rep = await checkRepToken(body.token);
      if (!rep) return json({ error: "الجلسة منتهية، الرجاء تسجيل الدخول مجددًا" }, 401);
      repUsername = rep.username; repDisplayName = rep.displayName;
    }
    const phone = phoneKey(body.clientPhone);
    const customerId = await upsertCustomer(body.clientName || "", phone, repUsername);
    const { error } = await supabase.from("quotes").insert({
      rep_username: repUsername,
      rep_display_name: repDisplayName,
      client_name: body.clientName || "",
      client_phone: phone,
      hp: body.hp || null,
      final_total: body.finalTotal || null,
      snapshot: body.snapshot || null,
      customer_id: customerId,
    });
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true });
  }

  if (body.action === "admin-list-customers") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    const { data, error } = await supabase.from("customers")
      .select("id, name, phone, rep_username, quotes_count, first_quote_at, last_quote_at")
      .order("last_quote_at", { ascending: false }).limit(500);
    if (error) return json({ error: error.message }, 500);
    return json({ customers: data || [] });
  }

  if (body.action === "admin-customer-detail") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    if (!body.customerId) return json({ error: "customerId required" }, 400);
    const { data: customer, error: cErr } = await supabase.from("customers")
      .select("*").eq("id", body.customerId).single();
    if (cErr || !customer) return json({ error: "customer not found" }, 404);
    const { data: quotesList, error: qErr } = await supabase.from("quotes")
      .select("id, rep_display_name, hp, final_total, created_at, snapshot")
      .eq("customer_id", body.customerId).order("created_at", { ascending: false });
    if (qErr) return json({ error: qErr.message }, 500);
    return json({ customer, quotes: quotesList || [] });
  }

  if (body.action === "admin-overview-stats") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const { count: totalCustomers } = await supabase.from("customers").select("*", { count: "exact", head: true });
    const { data: monthQuotes, error: mqErr } = await supabase.from("quotes")
      .select("final_total, rep_display_name").gte("created_at", monthStart.toISOString());
    if (mqErr) return json({ error: mqErr.message }, 500);
    const list = monthQuotes || [];
    const quotesThisMonth = list.length;
    const avgQuoteValue = quotesThisMonth
      ? Math.round(list.reduce((s: number, q: any) => s + (Number(q.final_total) || 0), 0) / quotesThisMonth)
      : 0;
    const repCounts: Record<string, number> = {};
    list.forEach((q: any) => { const r = q.rep_display_name || "غير محدد"; repCounts[r] = (repCounts[r] || 0) + 1; });
    let mostActiveRep = "-", mostActiveRepCount = 0;
    Object.entries(repCounts).forEach(([r, c]) => { if (c > mostActiveRepCount) { mostActiveRep = r; mostActiveRepCount = c; } });
    return json({ totalCustomers: totalCustomers || 0, quotesThisMonth, avgQuoteValue, mostActiveRep, mostActiveRepCount });
  }

  if (body.action === "admin-list-reps") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    const { data, error } = await supabase.from("reps").select("id, username, display_name, active, permissions").order("id");
    if (error) return json({ error: error.message }, 500);
    return json({ reps: data || [] });
  }

  if (body.action === "admin-save-rep") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    const row: any = { username: body.username, display_name: body.displayName, active: body.active !== false };
    if (body.permissions && typeof body.permissions === "object") {
      const perms: Record<string, boolean> = {};
      for (const k of ["pricing", "calcs", "products", "portfolio"]) perms[k] = !!body.permissions[k];
      row.permissions = perms;
    }
    if (body.password) {
      row.password_hash = await sha256Hex(body.password);
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

  if (body.action === "upload-product-image") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    if (!body.imageBase64 || !body.filename) return json({ error: "imageBase64 and filename required" }, 400);
    try {
      const base64 = String(body.imageBase64).split(",").pop()!;
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
    const cats = (D.productCatalog || []).map((cat: any) => {
      const rows = (cat.rows || []).map((r: any, idx: number) => {
        const brand = rowBrand(cat, idx);
        const d = findDiscount(D, cat.category, brand);
        if (!d || !d.promoActive || !d.promoDiscountPct) return r;
        if (r.length < 2) return r;
        const priceIdx = r.length - 2, priceVatIdx = r.length - 1;
        const listPrice = parseFloat(r[priceIdx]);
        if (!isFinite(listPrice)) return r;
        const promoPrice = listPrice * (1 - (Number(d.promoDiscountPct) || 0) / 100);
        const newRow = [...r];
        newRow[priceIdx] = String(Math.round(promoPrice * 100) / 100);
        newRow[priceVatIdx] = String(Math.round(promoPrice * 1.15 * 100) / 100);
        return newRow;
      });
      return { ...cat, rows };
    });
    return json({ productCatalog: cats });
  }

  if (body.action === "get-panels-public") {
    const panels = (D.panels || [])
      .filter((p: any) => p.visible !== false && p.priceW)
      .map((p: any) => ({
        brand: p.brand,
        power: p.power,
        priceExclVat: Math.round((p.priceW + (D.panelMarginPerWatt || 0)) * p.power),
        image: p.image || "",
        description: p.description || "",
        specs: p.specs || {},
        datasheetUrl: p.datasheetUrl || "",
      }));
    return json({ panels });
  }

  if (body.action === "get-portfolio") {
    return json({ portfolio: D.portfolio || null });
  }

  if (body.action === "recompute-ready-system-price") {
    if (!(await checkAdminToken(body.adminToken))) return json({ error: "admin session expired" }, 401);
    try {
      const result = computeReadySystemPrice(D, body.input);
      return json(result);
    } catch (e) { return json({ error: (e as Error).message }, 400); }
  }

  if (body.action === "get-ready-offgrid-systems") {
    return json({ systems: D.readyOffgridSystems || [] });
  }

  if (body.action === "offgrid-quote") {
    let inp: any;
    try { inp = resolveOffgridOngridInput(D, body.input); } catch (e) { return json({ error: (e as Error).message }, 400); }
    let q: any;
    try { q = computeOffgridQuote(D, inp); } catch (e) { return json({ error: (e as Error).message }, 400); }
    return json({
      quote: publicView(q),
      panelOptions: D.panels
        .map((p: any, idx: number) => ({ idx, brand: p.brand, power: p.power, visible: p.visible !== false, hasPrice: !!p.priceW }))
        .filter((p: any) => p.visible && p.hasPrice)
        .map((p: any) => ({ idx: p.idx, brand: p.brand, power: p.power })),
      applianceDefaults: D.offgrid.applianceDefaults || [],
      defaultPanelKey: D.defaultPanelKey || null,
      defaultInverterBrand: D.defaultInverterBrand || null,
      batteryVoltageOptions: getBatteryVoltageOptions(D),
      inverterModelOptions: getInverterModelOptions(D),
    });
  }

  if (body.action === "ongrid-quote") {
    let inp: any;
    try { inp = resolveOffgridOngridInput(D, body.input); } catch (e) { return json({ error: (e as Error).message }, 400); }
    let q: any;
    try { q = computeOngridQuote(D, inp); } catch (e) { return json({ error: (e as Error).message }, 400); }
    return json({
      quote: publicView(q),
      panelOptions: D.panels
        .map((p: any, idx: number) => ({ idx, brand: p.brand, power: p.power, visible: p.visible !== false, hasPrice: !!p.priceW }))
        .filter((p: any) => p.visible && p.hasPrice)
        .map((p: any) => ({ idx: p.idx, brand: p.brand, power: p.power })),
      defaultPanelKey: D.defaultPanelKey || null,
      defaultInverterBrand: D.defaultInverterBrand || null,
    });
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
      } catch (_e) { }
    }
    return json({ ok: true });
  }

  let inp: any;
  try { inp = resolveInput(D, body.input); } catch (e) { return json({ error: (e as Error).message }, 400); }
  const q = computeQuote(D, inp);
  return json({
    quote: publicView(q),
    feas: D.feas,
    panelOptions: D.panels
      .map((p: any, idx: number) => ({ idx, brand: p.brand, power: p.power, visible: p.visible !== false, hasPrice: !!p.priceW }))
      .filter((p: any) => p.visible && p.hasPrice)
      .map((p: any) => ({ idx: p.idx, brand: p.brand, power: p.power })),
    inverterBrandOptions: getInverterBrands(D).map((b: any, idx: number) => ({ idx, brand: b.brand })),
    defaultPanelKey: D.defaultPanelKey || null,
    defaultInverterBrand: D.defaultInverterBrand || null,
  });
});
