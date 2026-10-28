// HoloulEnergy — finance-procurement Edge Function (ADMIN ONLY)
// طلبات عروض الأسعار من الموردين (RFQ): سحب البنود والكميات من عرض سعر العميل (من غير أسعار البيع)،
// تسجيل رد المورد، القبول (بيطلّع أمر شراء) أو الرفض، + كشف حساب المورد المتسلسل + مقارنة التسعير (proc-pricing-compare).
// نفس توثيق باقي دوال المالية (توكن أدمن HMAC + session_version). كل actions بتبدأ بـ proc-.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
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
  return b64urlFromBytes(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))));
}
function sessionSecret(): string {
  const s = Deno.env.get("SESSION_SECRET");
  if (!s) throw new Error("SESSION_SECRET is not configured for this project");
  return s;
}
async function readToken(token: string | undefined): Promise<{ sub: string; ver: number; exp: number } | null> {
  if (!token || token.split(".").length !== 2) return null;
  const [payloadB64, sig] = token.split(".");
  if ((await hmacSign(sessionSecret(), payloadB64)) !== sig) return null;
  try {
    const payload = JSON.parse(b64urlToString(payloadB64));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function checkAdminToken(token: string | undefined): Promise<boolean> {
  const payload = await readToken(token);
  if (!payload || payload.sub !== "admin") return false;
  const { data, error } = await supabase.from("admin_secret").select("session_version").eq("id", 1).single();
  if (error || !data) return false;
  return payload.ver === data.session_version;
}
async function logAudit(actionType: string, entityType: string, entityId: number | null, label: string | null, oldValue: unknown, newValue: unknown) {
  try {
    await supabase.from("audit_log").insert({
      actor: "admin", actor_role: "admin", action_type: actionType, entity_type: entityType,
      entity_id: entityId, entity_label: label, old_value: oldValue ?? null, new_value: newValue ?? null,
    });
  } catch { /* logging must never break the action */ }
}

class BadRequest extends Error {}
const bad = (m: string): never => { throw new BadRequest(m); };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateOrNull = (v: unknown, label = "التاريخ"): string | null => {
  if (v == null || v === "") return null;
  const s = String(v);
  if (!DATE_RE.test(s) || isNaN(Date.parse(s))) bad(`${label} غير صالح (YYYY-MM-DD)`);
  return s;
};
const txt = (v: unknown, max: number) => (v == null || v === "" ? null : String(v).slice(0, max));
const r2 = (n: number) => Math.round(n * 100) / 100;
const must = <T>(r: { data: T; error: any }): T => { if (r.error) throw r.error; return r.data; };

async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const c = String(error.code || "");
    if (c === "P0001" || c.startsWith("22") || c.startsWith("23")) bad(error.message);
    throw error;
  }
  return data;
}

// الكمية في عرض السعر نص بـ 3 أشكال: "#896#" (عدد) — "1000 متر (تقريبي — ...)" — "مطابق للمخطط" (مش رقم).
function parseQty(raw: unknown): { qty: number | null; unit: string | null; note: string | null } {
  const s = String(raw ?? "").trim();
  let m = /^#\s*(\d+(?:\.\d+)?)\s*#$/.exec(s);
  if (m) return { qty: Number(m[1]), unit: null, note: null };
  m = /^(\d+(?:\.\d+)?)\s*(.*)$/.exec(s);
  if (m) {
    const rest = m[2] || "";
    return { qty: Number(m[1]), unit: /متر/.test(rest) ? "متر" : null, note: /تقريب/.test(rest) ? "كمية تقريبية — تتحدد نهائيًا عند التوريد" : null };
  }
  return { qty: null, unit: null, note: s || null };
}
// بنود خدمات مش بتتشترى من مورد: بتتعلّم غير مختارة تلقائيًا (المستخدم يقدر يغيّر)
const SERVICE_RE = /(النقل|التركيبات|الأعمال الميدانية|العمالة)/;


// ============ مقارنة التسعير: سعر البيع في عرض العميل مقابل سعر الشراء من المورد (أوامر الشراء المقبولة) ============
// المقارنة على أساس صافي (قبل الضريبة): أسعار المورد الشاملة بتتقسم على (1+الضريبة). المطابقة بين بند العرض وبند الطلب بالاسم (نفس البنود اتسحبت من العرض).
const PRICING_TARGET_MARGIN = 10; // % — أقل من كده = هامش ضعيف
const nrm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[ً-ْ]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, " ").trim();
const r1 = (n: number) => Math.round(n * 10) / 10;

async function buildPricing(projectId?: number) {
  let rq = supabase.from("rfqs").select("id, supplier_id, quote_id, project_id, vat_mode, lump_total, po_id").eq("status", "accepted").not("project_id", "is", null).not("quote_id", "is", null);
  if (projectId) rq = rq.eq("project_id", projectId);
  const rfqs = must(await rq) as any[];
  const uniq = (a: any[]) => [...new Set(a.filter((x) => x != null))];
  const rfqIds = rfqs.map((r) => r.id), poIds = uniq(rfqs.map((r) => r.po_id)), supIds = uniq(rfqs.map((r) => r.supplier_id)),
    quoteIds = uniq(rfqs.map((r) => r.quote_id)), projIds = uniq(rfqs.map((r) => r.project_id));
  const none = { vatRate: 15, target: PRICING_TARGET_MARGIN, projects: [] as any[], items: [] as any[] };
  if (!rfqs.length) return none;
  const [itemsR, supsR, posR, quotesR, profR, stR] = await Promise.all([
    supabase.from("rfq_items").select("rfq_id, line_no, label, qty, unit, unit_price").in("rfq_id", rfqIds).order("line_no"),
    supabase.from("suppliers").select("id, name").in("id", supIds),
    poIds.length ? supabase.from("v_purchase_orders").select("po_id, po_number, amount, billed, paid, status, order_date").in("po_id", poIds) : Promise.resolve({ data: [], error: null }),
    supabase.from("quotes").select("id, ref_code, ql_code, client_name, frozen:snapshot->frozenItems").in("id", quoteIds),
    supabase.from("v_project_profit").select("*").in("project_id", projIds),
    supabase.from("finance_settings").select("vat_rate").eq("id", 1).maybeSingle(),
  ]);
  const vatRate = Number((must(stR) as any)?.vat_rate) || 15, vr = vatRate / 100;
  const supName: Record<string, string> = {}; for (const x of must(supsR) as any[]) supName[String(x.id)] = x.name;
  const poBy: Record<string, any> = {}; for (const x of must(posR) as any[]) poBy[String(x.po_id)] = x;
  const quoteBy: Record<string, any> = {}; for (const x of must(quotesR) as any[]) quoteBy[String(x.id)] = x;
  const profBy: Record<string, any> = {}; for (const x of must(profR) as any[]) profBy[String(x.project_id)] = x;
  const itemsBy: Record<string, any[]> = {}; for (const x of must(itemsR) as any[]) (itemsBy[String(x.rfq_id)] ||= []).push(x);

  const projects: Record<string, any> = {};
  for (const rf of rfqs) {
    const po = rf.po_id ? poBy[String(rf.po_id)] : null;
    if (po && po.status === "cancelled") continue;                       // أمر شراء ملغي مش داخل في المقارنة
    const P = (projects[String(rf.project_id)] ||= { project_id: rf.project_id, quotes: {}, pos: [], lump_groups: [], extras: [] });
    const Q = (P.quotes[String(rf.quote_id)] ||= { quote_id: rf.quote_id, buys: {} as Record<string, any[]>, matched: new Set<string>() });
    const f = rf.vat_mode === "incl" ? 1 / (1 + vr) : 1;
    const its = itemsBy[String(rf.id)] || [];
    const supplier = supName[String(rf.supplier_id)] || "";
    const base = { po_id: rf.po_id, po_number: po?.po_number || null, supplier, order_date: po?.order_date || null };
    let poNet = 0;
    const addBuy = (it: any, qty: number, unitNet: number, totalNet: number, lump: boolean) => {
      (Q.buys[nrm(it.label)] ||= []).push({ ...base, qty, unit_net: r2(unitNet * 10000) / 10000, total_net: r2(totalNet), lump });
      poNet += totalNet;
    };
    if (rf.lump_total != null) {
      const net = Number(rf.lump_total) * f;
      if (its.length === 1) addBuy(its[0], Number(its[0].qty), net / Number(its[0].qty), net, true);
      else { P.lump_groups.push({ ...base, quote_id: rf.quote_id, labels: its.map((i: any) => i.label), keys: its.map((i: any) => nrm(i.label)), total_net: r2(net) }); poNet += net; }
    } else {
      for (const it of its) if (it.unit_price != null) addBuy(it, Number(it.qty), Number(it.unit_price) * f, Number(it.qty) * Number(it.unit_price) * f, false);
    }
    if (po) P.pos.push({ ...base, amount: Number(po.amount), billed: Number(po.billed), paid: Number(po.paid), net: r2(poNet), vat_mode: rf.vat_mode, invoice_diff: Number(po.billed) > 0 ? r2(Number(po.billed) - Number(po.amount)) : null });
  }

  const aggr: Record<string, any> = {};
  const outProjects: any[] = [];
  for (const P of Object.values(projects) as any[]) {
    const pr = profBy[String(P.project_id)] || {};
    const quotesOut: any[] = [];
    let sellTotal = 0, matchedSell = 0, matchedCost = 0, orderedNet = 0, notBoughtSell = 0, lossLines = 0, lowLines = 0;
    for (const Q of Object.values(P.quotes) as any[]) {
      const qrow = quoteBy[String(Q.quote_id)]; if (!qrow) continue;
      const frozen: any[] = Array.isArray(qrow.frozen) ? qrow.frozen : [];
      const seen = new Set<string>();
      const lines: any[] = [];
      for (const fi of frozen) {
        const label = String(fi?.label || "").trim(), sell = Number(fi?.sell || 0);
        if (!label || !(sell > 0)) continue;
        const key = nrm(label); seen.add(key);
        const pq = parseQty(fi.qty), qty = pq.qty, approx = !!pq.note && /تقريب/.test(pq.note);
        const buys: any[] = Q.buys[key] || [];
        const grp = P.lump_groups.findIndex((g: any) => g.quote_id === Q.quote_id && g.keys.includes(key));
        const buyQty = buys.reduce((t: number, b: any) => t + b.qty, 0), buyTotal = buys.reduce((t: number, b: any) => t + b.total_net, 0);
        const sellUnit = qty ? sell / qty : null, buyUnit = buyQty ? buyTotal / buyQty : null;
        let costForSell: number | null = null;
        if (buyUnit != null) costForSell = qty ? buyUnit * qty : buyTotal;
        const profit = costForSell != null ? sell - costForSell : null;
        const marginPct = profit != null ? r1((profit / sell) * 100) : null;
        let status = "none";
        if (grp >= 0 && !buys.length) status = "group";
        else if (profit != null) status = profit < -0.005 ? "loss" : (marginPct as number) < PRICING_TARGET_MARGIN ? "low" : "ok";
        const flags: string[] = [];
        if (buys.length) {
          if (qty && !approx && buyQty > qty + 0.0005) flags.push("over");
          if (qty && !approx && buyQty < qty - 0.0005) flags.push("under");
          if (new Set(buys.map((b: any) => b.supplier)).size > 1) flags.push("multi");
        }
        sellTotal += sell;
        if (buys.length) {
          orderedNet += buyTotal; matchedSell += sell; matchedCost += costForSell as number;
          if (status === "loss") lossLines++; else if (status === "low") lowLines++;
          const A = (aggr[key] ||= { key, label, projects: new Set(), sell_qty: 0, sell_total: 0, buy_qty: 0, buy_total: 0, min_buy: null, max_buy: null, loss_count: 0, low_count: 0, lines: 0, suppliers: new Set(), last_date: null, last_buy_unit: null });
          A.projects.add(P.project_id); A.lines++;
          if (qty) { A.sell_qty += qty; A.sell_total += sell; }
          A.buy_qty += buyQty; A.buy_total += buyTotal;
          for (const b of buys) {
            A.suppliers.add(b.supplier);
            A.min_buy = A.min_buy == null ? b.unit_net : Math.min(A.min_buy, b.unit_net); A.max_buy = A.max_buy == null ? b.unit_net : Math.max(A.max_buy, b.unit_net);
            if (b.order_date && (!A.last_date || b.order_date >= A.last_date)) { A.last_date = b.order_date; A.last_buy_unit = b.unit_net; }
          }
          if (status === "loss") A.loss_count++; else if (status === "low") A.low_count++;
        } else if (status !== "group") notBoughtSell += sell;
        lines.push({ label, qty, qty_raw: String(fi.qty ?? ""), approx, sell_total: r2(sell), sell_unit: sellUnit != null ? r2(sellUnit * 100) / 100 : null, buys, buy_qty: r2(buyQty), buy_unit: buyUnit != null ? r2(buyUnit * 100) / 100 : null, buy_total: r2(buyTotal), profit: profit != null ? r2(profit) : null, margin_pct: marginPct, status, flags, group: grp >= 0 ? grp : null });
      }
      // بنود اتشرت ومش في عرض السعر
      const extras: any[] = [];
      for (const [k, bs] of Object.entries(Q.buys) as any[]) if (!seen.has(k)) for (const b of bs) { extras.push({ label: k, ...b }); orderedNet += b.total_net; }
      quotesOut.push({ quote_id: Q.quote_id, ref: qrow.ql_code || qrow.ref_code, client_name: qrow.client_name, lines, extras });
    }
    for (const g of P.lump_groups) orderedNet += g.total_net;
    const contractNet = Number(pr.contract_net || 0);
    outProjects.push({
      project_id: P.project_id, project_number: pr.project_number, customer_name: pr.customer_name,
      contract_net: contractNet, contract_gross: Number(pr.contract_gross || 0), actual_cost_net: Number(pr.cost_net || 0), actual_profit: Number(pr.actual_profit || 0), margin_pct_actual: pr.margin_pct,
      collected: Number(pr.collected || 0),
      sell_total: r2(sellTotal), ordered_net: r2(orderedNet), remaining_value: r2(contractNet - orderedNet),
      matched_sell: r2(matchedSell), matched_cost: r2(matchedCost), matched_margin_pct: matchedSell > 0 ? r1(((matchedSell - matchedCost) / matchedSell) * 100) : null,
      not_bought_sell: r2(notBoughtSell), loss_lines: lossLines, low_lines: lowLines,
      quotes: quotesOut, pos: P.pos, lump_groups: P.lump_groups.map((g: any) => ({ po_number: g.po_number, supplier: g.supplier, labels: g.labels, total_net: g.total_net })),
    });
  }
  outProjects.sort((a, b) => Number(b.project_id) - Number(a.project_id));
  const items = Object.values(aggr).map((A: any) => {
    const sellU = A.sell_qty ? A.sell_total / A.sell_qty : null, buyU = A.buy_qty ? A.buy_total / A.buy_qty : null;
    const m = sellU != null && buyU != null && sellU > 0 ? r1(((sellU - buyU) / sellU) * 100) : null;
    return { label: A.label, projects_count: A.projects.size, lines: A.lines, avg_sell_unit: sellU != null ? r2(sellU * 100) / 100 : null, avg_buy_unit: buyU != null ? r2(buyU * 100) / 100 : null,
      min_buy: A.min_buy, max_buy: A.max_buy, margin_pct: m, loss_count: A.loss_count, low_count: A.low_count, suppliers: [...A.suppliers], last_buy_unit: A.last_buy_unit, last_date: A.last_date,
      status: m == null ? "none" : m < 0 ? "loss" : m < PRICING_TARGET_MARGIN ? "low" : "ok" };
  }).sort((a: any, b: any) => (a.margin_pct ?? 999) - (b.margin_pct ?? 999));
  return { vatRate, target: PRICING_TARGET_MARGIN, projects: outProjects, items };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!(await checkAdminToken(body.adminToken))) {
    return json({ error: "الجلسة منتهية أو غير مصرّح، الرجاء تسجيل الدخول كأدمن" }, 401);
  }
  const action = body.action;

  try {
    if (action === "proc-quotes") {
      let q = supabase.from("quotes").select("id, ref_code, ql_code, client_name, revision_no, customer_id, created_at").order("id", { ascending: false }).limit(300);
      const s = String(body.search || "").trim().replace(/[%,()]/g, "");
      if (s) q = q.or(`client_name.ilike.%${s}%,ref_code.ilike.%${s}%,ql_code.ilike.%${s}%`);
      return json({ ok: true, quotes: must(await q) });
    }

    // بنود عرض السعر (بدون أسعار البيع) جاهزة للاختيار
    if (action === "proc-quote-items") {
      if (!body.quoteId) bad("quoteId required");
      const q: any = must(await supabase.from("quotes").select("id, ref_code, ql_code, client_name, snapshot").eq("id", body.quoteId).maybeSingle());
      if (!q) return json({ error: "عرض السعر غير موجود" }, 404);
      const raw = Array.isArray(q.snapshot?.frozenItems) ? q.snapshot.frozenItems : [];
      const items = raw.map((it: any) => {
        const label = String(it?.label || "").trim();
        const p = parseQty(it?.qty);
        return { label, qty: p.qty, unit: p.unit, qty_note: p.note, selected: !SERVICE_RE.test(label) && p.qty != null };
      }).filter((i: any) => i.label);
      return json({ ok: true, quote: { id: q.id, ref: q.ql_code || q.ref_code, client_name: q.client_name }, items });
    }

    if (action === "proc-rfqs") {
      const rows = must(await supabase.from("v_rfqs").select("*").order("rfq_id", { ascending: false }).limit(500));
      return json({ ok: true, rfqs: rows });
    }

    if (action === "proc-rfq") {
      if (!body.rfqId) bad("rfqId required");
      const [r, items] = await Promise.all([
        supabase.from("v_rfqs").select("*").eq("rfq_id", body.rfqId).maybeSingle(),
        supabase.from("rfq_items").select("*").eq("rfq_id", body.rfqId).order("line_no"),
      ]);
      const rfq: any = must(r);
      if (!rfq) return json({ error: "طلب عرض السعر غير موجود" }, 404);
      let po = null;
      if (rfq.po_id) po = must(await supabase.from("v_purchase_orders").select("po_id, po_number, amount, billed, paid").eq("po_id", rfq.po_id).maybeSingle());
      return json({ ok: true, rfq, items: must(items), po });
    }

    if (action === "proc-create-rfq") {
      let quoteRef: string | null = null;
      if (body.quoteId) {
        const q: any = must(await supabase.from("quotes").select("ref_code, ql_code").eq("id", body.quoteId).maybeSingle());
        quoteRef = q ? (q.ql_code || q.ref_code) : null;
      }
      const items = (Array.isArray(body.items) ? body.items : []).map((i: any) => ({
        label: txt(i.label, 200), qty: i.qty, unit: txt(i.unit, 20), qty_note: txt(i.qty_note, 200),
      }));
      const p = {
        supplier_id: body.supplierId || null, supplier_name: txt(body.supplierName, 150), quote_id: body.quoteId || null, quote_ref: quoteRef,
        project_id: body.projectId || null, notes: txt(body.notes, 500), items,
      };
      const id = await rpc("finance_create_rfq", { p });
      await logAudit("add_rfq", "rfq", Number(id), quoteRef, null, { items: items.length, supplier_id: p.supplier_id });
      return json({ ok: true, rfqId: id });
    }

    // رد المورد: سعر كل بند لوحده (مش شرط كلهم — والسعر الفاضي بيمسح السعر) أو سعر إجمالي واحد. تقدر تعدّله بعد كده.
    if (action === "proc-record-quote") {
      if (!body.rfqId) bad("rfqId required");
      const lump = body.mode === "lump";
      const prices = lump ? [] : (Array.isArray(body.prices) ? body.prices : []).map((x: any) => {
        if (x.unitPrice === null || x.unitPrice === undefined || String(x.unitPrice).trim() === "") return { line_no: Number(x.lineNo), unit_price: null };
        const n = Number(x.unitPrice);
        if (!isFinite(n) || n < 0) bad("سعر غير صالح");
        return { line_no: Number(x.lineNo), unit_price: n };
      });
      const p: Record<string, unknown> = { mode: lump ? "lump" : "items", prices };
      if (lump) {
        const t = Number(body.lumpTotal);
        if (!isFinite(t) || t <= 0) bad("اكتب السعر الإجمالي اللي بلّغه المورد");
        p.lump_total = t;
      }
      if (body.vatMode) p.vat_mode = body.vatMode;
      if (body.validInvoice !== undefined) p.valid_invoice = body.validInvoice !== false;
      if ("supplierQuoteRef" in body) p.supplier_quote_ref = txt(body.supplierQuoteRef, 60);
      if ("supplierQuoteDate" in body) p.supplier_quote_date = dateOrNull(body.supplierQuoteDate, "تاريخ عرض المورد");
      await rpc("finance_record_rfq_quote", { p_rfq: body.rfqId, p });
      await logAudit("rfq_quote", "rfq", Number(body.rfqId), (p.supplier_quote_ref as string) || null, null, { mode: p.mode, vat_mode: p.vat_mode ?? null, lines: prices.length, lump_total: p.lump_total ?? null });
      return json({ ok: true });
    }

    if (action === "proc-mark-sent") {
      if (!body.rfqId) bad("rfqId required");
      const { error } = await supabase.from("rfqs").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", body.rfqId).eq("status", "draft");
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "proc-accept") {
      if (!body.rfqId) bad("rfqId required");
      const poId = await rpc("finance_accept_rfq", { p_rfq: body.rfqId, p_project: body.projectId || null });
      await logAudit("accept_rfq", "rfq", Number(body.rfqId), null, null, { po_id: poId });
      return json({ ok: true, poId });
    }

    if (action === "proc-reject") {
      if (!body.rfqId) bad("rfqId required");
      await rpc("finance_reject_rfq", { p_rfq: body.rfqId });
      await logAudit("reject_rfq", "rfq", Number(body.rfqId), null, null, null);
      return json({ ok: true });
    }

    if (action === "proc-delete") {
      if (!body.rfqId) bad("rfqId required");
      const r: any = must(await supabase.from("rfqs").select("status").eq("id", body.rfqId).maybeSingle());
      if (!r) bad("الطلب غير موجود");
      if (r.status === "accepted") bad("الطلب اتقبل وطلّع أمر شراء — مينفعش يتحذف");
      const { error } = await supabase.from("rfqs").delete().eq("id", body.rfqId);
      if (error) throw error;
      await logAudit("delete_rfq", "rfq", Number(body.rfqId), null, null, null);
      return json({ ok: true });
    }

    // مقارنة التسعير: projectId اختياري (من غيره = كل المشاريع للتقرير المجمّع)
    if (action === "proc-pricing-compare") {
      const pid = body.projectId ? Number(body.projectId) : undefined;
      return json({ ok: true, ...(await buildPricing(pid)) });
    }

    // كشف حساب المورد: فواتير (عليك) + مدفوعات (دفعت) بالتاريخ مع رصيد جاري.
    // الرصيد الموجب = عليك للمورد (هو الدائن)، والسالب = دفعت زيادة (ليك رصيد عنده).
    if (action === "proc-supplier-ledger") {
      if (!body.supplierId) bad("supplierId required");
      const [sup, bills, pays] = await Promise.all([
        supabase.from("v_supplier_balances").select("*").eq("supplier_id", body.supplierId).maybeSingle(),
        supabase.from("v_supplier_bills").select("*").eq("supplier_id", body.supplierId),
        supabase.from("v_treasury_ledger").select("*").eq("supplier_id", body.supplierId).eq("kind", "supplier_payment"),
      ]);
      const s: any = must(sup);
      if (!s) return json({ error: "المورد غير موجود" }, 404);
      const rows: any[] = [
        ...(must(bills) as any[]).map((b) => ({ date: String(b.bill_date).slice(0, 10), ord: 0, id: b.bill_id, type: "bill", ref: b.bill_number || ("#" + b.bill_id), project: b.project_number, description: b.description, amount: Number(b.amount), paid: Number(b.paid), remaining: Number(b.remaining), bill_id: b.bill_id })),
        ...(must(pays) as any[]).map((p) => ({ date: String(p.entry_date).slice(0, 10), ord: 1, id: p.id, type: "payment", ref: p.reference, account: p.account_name, method: p.method, project: p.project_number, bill_id: p.bill_id, amount: Number(p.amount) })),
      ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.ord - b.ord || a.id - b.id));
      let running = 0;
      for (const r of rows) { running = r2(running + (r.type === "bill" ? r.amount : -r.amount)); r.balance = running; }
      return json({ ok: true, supplier: s, rows, balance: running });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
