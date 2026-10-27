// HoloulEnergy — finance-procurement Edge Function (ADMIN ONLY)
// طلبات عروض الأسعار من الموردين (RFQ): سحب البنود والكميات من عرض سعر العميل (من غير أسعار البيع)،
// تسجيل رد المورد، القبول (بيطلّع أمر شراء) أو الرفض، + كشف حساب المورد المتسلسل.
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

    if (action === "proc-record-quote") {
      if (!body.rfqId) bad("rfqId required");
      const prices = (Array.isArray(body.prices) ? body.prices : []).map((x: any) => {
        const n = Number(x.unitPrice);
        if (!isFinite(n) || n < 0) bad("سعر غير صالح");
        return { line_no: Number(x.lineNo), unit_price: n };
      });
      const p = {
        prices, vat_mode: body.vatMode || null, valid_invoice: body.validInvoice === false ? false : true,
        supplier_quote_ref: txt(body.supplierQuoteRef, 60), supplier_quote_date: dateOrNull(body.supplierQuoteDate, "تاريخ عرض المورد"),
      };
      await rpc("finance_record_rfq_quote", { p_rfq: body.rfqId, p });
      await logAudit("rfq_quote", "rfq", Number(body.rfqId), p.supplier_quote_ref, null, { vat_mode: p.vat_mode, lines: prices.length });
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
