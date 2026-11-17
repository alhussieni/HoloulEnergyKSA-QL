// HoloulEnergy KSA — compare-panels Edge Function
//
// Runs the EXISTING compute-quote engine once per available panel, for both
// offer scopes ("materials" = توريد فقط, "turnkey" = توريد وتركيب), with the
// exact same inputs the rep has on screen (HP, string/inverter adjustments,
// discount tier, special discount). It contains NO pricing logic of its own,
// so the numbers always match what the calculator would quote.
//
// - No adminToken  -> public view: sell prices only (no cost, no margin).
// - With adminToken -> compute-quote's own `admin-view` (token is validated
//   there): adds cost basis, profit and margin %. Never sent to reps.

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

// Same presets as the "نوع العرض" buttons in the calculator (08-wiring.js).
export const SCOPE_TOGGLES: Record<string, Record<string, boolean>> = {
  materials: { panel: true, inverter: true, ip65: false, combiner: true, cables: true, mc4: true,
    structure: false, concrete: false, earth: false, reactor: false, civilworks: false, elecworks: false, supply: false },
  turnkey: { panel: true, inverter: true, ip65: true, combiner: true, cables: true, mc4: true,
    structure: true, concrete: true, earth: false, reactor: false, civilworks: true, elecworks: true, supply: true },
};

const MAX_PANELS = 20;

type CallEngine = (action: string, payload: any) => Promise<{ status: number; data: any }>;

function scopeSummary(q: any, admin: boolean) {
  const net = q.netAfterManual;
  const out: any = {
    net,                       // السعر قبل الضريبة
    vat: q.vat,
    final: q.finalTotal,       // الإجمالي شامل الضريبة
    perKw: q.calcKW ? q.finalTotal / q.calcKW : null,
  };
  if (admin) {
    out.cost = q.totalCost;    // التكلفة (قبل الضريبة)
    out.profit = q.profit;     // الهامش بالريال (السعر قبل الضريبة − التكلفة)
    out.profitPct = q.profitPct;
  }
  return out;
}

export async function buildComparison(callEngine: CallEngine, input: any, adminToken?: string) {
  const admin = !!adminToken;
  const baseInput = { ...input, toggles: SCOPE_TOGGLES.materials };

  // 1) available panels = same list the calculator dropdown shows (visible + priced)
  const base = await callEngine("quote", { input: baseInput });
  if (base.status !== 200) return { status: base.status, body: { error: base.data?.error || "engine error" } };
  const options: any[] = (base.data.panelOptions || []).slice(0, MAX_PANELS);

  // 2) each panel x each scope through the real engine
  const jobs: Promise<any>[] = [];
  for (const opt of options) {
    for (const scope of Object.keys(SCOPE_TOGGLES)) {
      const inp = { ...input, panelIdx: opt.idx, toggles: SCOPE_TOGGLES[scope] };
      const p = admin ? callEngine("admin-view", { adminToken, input: inp }) : callEngine("quote", { input: inp });
      jobs.push(p.then((r) => ({ opt, scope, r })));
    }
  }
  const results = await Promise.all(jobs);

  const rows: Record<number, any> = {};
  for (const { opt, scope, r } of results) {
    if (r.status === 401) return { status: 401, body: { error: r.data?.error || "admin session expired" } };
    if (r.status !== 200 || !r.data?.quote) continue; // skip a panel the engine can't price
    const q = r.data.quote;
    const row = rows[opt.idx] || (rows[opt.idx] = {
      idx: opt.idx, brand: opt.brand, power: opt.power,
      totalPanels: q.totalPanels, panelsPerString: q.panelsPerString, arrays: q.arrays,
      calcKW: q.calcKW, Voc: q.Voc, Vimp: q.Vimp, Isc: q.Isc, Iimp: q.Iimp,
      combinerInputs: Array.isArray(q.combiner) ? q.combiner[0] : null, // size only — never the box cost
      invKW: q.invKW, invBrand: q.invBrandName,
      warning: q.inverterOversizeWarning ? q.inverterOversizeWarning.message : null,
      scopes: {},
    });
    row.scopes[scope] = scopeSummary(q, admin);
  }

  const list = Object.values(rows).filter((r: any) => r.scopes.materials && r.scopes.turnkey);
  return { status: 200, body: { admin, hp: input.hp, invKW: list[0]?.invKW ?? null, panels: list } };
}

if (import.meta.main !== false && typeof Deno !== "undefined") {
  Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
    if (!body.input || typeof body.input !== "object") return json({ error: "input required" }, 400);

    const url = Deno.env.get("SUPABASE_URL")! + "/functions/v1/compute-quote";
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": req.headers.get("authorization") || "",
      "apikey": req.headers.get("apikey") || "",
    };
    const callEngine: CallEngine = async (action, payload) => {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ action, ...payload }) });
      let data: any = null;
      try { data = await res.json(); } catch { /* keep null */ }
      return { status: res.status, data };
    };

    try {
      const out = await buildComparison(callEngine, body.input, body.adminToken || undefined);
      return json(out.body, out.status);
    } catch (e) {
      return json({ error: (e as Error).message || "compare failed" }, 500);
    }
  });
}
