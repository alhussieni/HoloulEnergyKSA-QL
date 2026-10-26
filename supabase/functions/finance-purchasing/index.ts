// HoloulEnergy — finance-purchasing Edge Function (ADMIN ONLY)
// المشتريات: طلبات الشراء، فواتير الموردين (مع ربطها بطلب شراء)، والالتزامات المتوقعة على المشروع.
// نفس توثيق باقي دوال المالية (توكن أدمن HMAC + session_version). كل actions بتبدأ بـ purchasing-.

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
const num = (v: unknown, label: string): number => {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) bad(`${label} غير صالح`);
  return Math.round(n * 100) / 100;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const TAX = ["recoverable", "none"];
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

async function resolveSupplier(id: unknown, name: unknown): Promise<number> {
  if (id) return Number(id);
  const n = String(name || "").trim().slice(0, 150);
  if (!n) bad("اختر المورد أو اكتب اسم مورد جديد");
  const { data: ex } = await supabase.from("suppliers").select("id").ilike("name", n).maybeSingle();
  if (ex) return ex.id;
  const { data, error } = await supabase.from("suppliers").insert({ name: n }).select("id").single();
  if (error) throw error;
  return data.id;
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
    if (action === "purchasing-orders") {
      let q = supabase.from("v_purchase_orders").select("*").order("order_date", { ascending: false }).order("po_id", { ascending: false }).limit(1000);
      if (body.supplierId) q = q.eq("supplier_id", body.supplierId);
      if (body.projectId) q = q.eq("project_id", body.projectId);
      if (body.openOnly) q = q.eq("status", "open").gt("remaining_to_bill", 0);
      const rows = must(await q) as any[];
      const open = rows.filter((o) => o.status === "open");
      return json({
        ok: true, orders: rows,
        totals: {
          committed_unbilled: r2(open.reduce((s, o) => s + Math.max(0, Number(o.remaining_to_bill)), 0)),
          billed_unpaid: r2(open.reduce((s, o) => s + Math.max(0, Number(o.remaining_to_pay)), 0)),
          open_count: open.length,
        },
      });
    }

    if (action === "purchasing-save-order") {
      if (body.orderId) {
        const f = body.fields || {};
        const row: Record<string, unknown> = {};
        if ("amount" in f) row.amount = num(f.amount, "المبلغ");
        if ("description" in f) row.description = txt(f.description, 500);
        if ("notes" in f) row.notes = txt(f.notes, 500);
        if ("order_date" in f) row.order_date = dateOrNull(f.order_date, "تاريخ الطلب") || bad("تاريخ الطلب مطلوب");
        if ("po_number" in f) row.po_number = txt(f.po_number, 40);
        if ("project_id" in f) row.project_id = f.project_id || null;
        if ("tax_treatment" in f) { if (!TAX.includes(String(f.tax_treatment))) bad("نوع الضريبة غير صالح"); row.tax_treatment = f.tax_treatment; }
        if ("status" in f) { if (!["open", "cancelled"].includes(String(f.status))) bad("الحالة غير صالحة"); row.status = f.status; }
        if (!Object.keys(row).length) bad("لا توجد حقول للتعديل");
        const { data: old } = await supabase.from("purchase_orders").select("amount, status, description").eq("id", body.orderId).maybeSingle();
        const data = must(await supabase.from("purchase_orders").update(row).eq("id", body.orderId).select().maybeSingle());
        await logAudit("update_po", "purchase_order", Number(body.orderId), null, old, row);
        return json({ ok: true, order: data });
      }
      const supplierId = await resolveSupplier(body.supplierId, body.supplierName);
      const tax = body.taxTreatment ? String(body.taxTreatment) : "recoverable";
      if (!TAX.includes(tax)) bad("نوع الضريبة غير صالح");
      const row = {
        supplier_id: supplierId, project_id: body.projectId || null, amount: num(body.amount, "المبلغ"),
        order_date: dateOrNull(body.orderDate, "تاريخ الطلب") || new Date().toISOString().slice(0, 10),
        description: txt(body.description, 500), notes: txt(body.notes, 500), po_number: txt(body.poNumber, 40), tax_treatment: tax,
      };
      const data: any = must(await supabase.from("purchase_orders").insert(row).select().maybeSingle());
      await logAudit("add_po", "purchase_order", data.id, row.po_number, null, { amount: row.amount, supplier_id: supplierId, project_id: row.project_id });
      return json({ ok: true, order: data });
    }

    if (action === "purchasing-delete-order") {
      if (!body.orderId) bad("orderId required");
      const { count } = await supabase.from("supplier_bills").select("id", { count: "exact", head: true }).eq("purchase_order_id", body.orderId);
      if (count && count > 0) bad("الطلب عليه فواتير — الغيه (بدل ما تحذفه) أو احذف الفواتير الأول");
      const { error } = await supabase.from("purchase_orders").delete().eq("id", body.orderId);
      if (error) throw error;
      await logAudit("delete_po", "purchase_order", Number(body.orderId), null, null, null);
      return json({ ok: true });
    }

    // التكاليف المتوقعة على مشروع: طلبات شراء مفتوحة لسه ماتفوترتش
    if (action === "purchasing-project-commitments") {
      if (!body.projectId) bad("projectId required");
      const rows = must(await supabase.from("v_purchase_orders").select("*").eq("project_id", body.projectId).eq("status", "open").gt("remaining_to_bill", 0)) as any[];
      return json({ ok: true, orders: rows, total: r2(rows.reduce((s, o) => s + Number(o.remaining_to_bill), 0)) });
    }

    if (action === "purchasing-bills") {
      let q = supabase.from("v_supplier_bills").select("*").order("bill_date", { ascending: false }).order("bill_id", { ascending: false }).limit(1000);
      if (body.supplierId) q = q.eq("supplier_id", body.supplierId);
      if (body.openOnly) q = q.gt("remaining", 0);
      const rows = must(await q) as any[];
      return json({ ok: true, bills: rows, totalRemaining: r2(rows.reduce((s, b) => s + Math.max(0, Number(b.remaining)), 0)) });
    }

    // فاتورة مورد (اختياريًا مربوطة بطلب شراء): بتدخل تكلفة المشروع/مصروف + مستحق للمورد
    if (action === "purchasing-record-bill") {
      const tax = body.taxTreatment ? String(body.taxTreatment) : "recoverable";
      if (!TAX.includes(tax)) bad("نوع الضريبة غير صالح");
      const p = {
        supplier_id: body.supplierId || null, supplier_name: txt(body.supplierName, 150), po_id: body.poId || null,
        project_id: body.projectId || null, amount: num(body.amount, "المبلغ"),
        bill_date: dateOrNull(body.billDate, "تاريخ الفاتورة"), bill_number: txt(body.billNumber, 60),
        description: txt(body.description, 500), tax_treatment: tax, cost_type: txt(body.costType, 50),
      };
      const id = await rpc("finance_record_bill", { p });
      await logAudit("add_bill", "supplier_bill", Number(id), p.bill_number, null, { amount: p.amount, project_id: p.project_id, po_id: p.po_id });
      return json({ ok: true, billId: id });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
