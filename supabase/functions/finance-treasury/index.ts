// HoloulEnergy — finance-treasury Edge Function (ADMIN ONLY)
// الخزنة والحسابات اليومية: حسابات (خزنة/بنك/عهد)، موردين، فواتير مورد، حركات قبض ودفع، تحويلات.
// نفس توثيق finance-api/crm-api (توكن أدمن HMAC + session_version). كل actions تبدأ بـ treasury-.
// العمليات المركّبة بتتم داخل دوال Postgres (finance_*) عشان تكون ذرّية.

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
const num = (v: unknown, label: string, allowZero = false): number => {
  const n = Number(v);
  if (!isFinite(n) || n < 0 || (!allowZero && n === 0)) bad(`${label} غير صالح`);
  return Math.round(n * 100) / 100;
};
const TAX = ["recoverable", "none"];

// DB-function errors raised by us (P0001) or by validation (22xxx/23xxx) are the caller's fault → 400.
async function rpc(name: string, args: Record<string, unknown>) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const c = String(error.code || "");
    if (c === "P0001" || c.startsWith("22") || c.startsWith("23")) bad(error.message);
    throw error;
  }
  return data;
}
const must = <T>(r: { data: T; error: any }): T => { if (r.error) throw r.error; return r.data; };

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
    // قوائم الاختيار لنماذج الإدخال
    if (action === "treasury-lookups") {
      const [accounts, suppliers, projects, bills, partners] = await Promise.all([
        supabase.from("v_account_balances").select("*").order("account_id"),
        supabase.from("v_supplier_balances").select("*").order("name"),
        supabase.from("v_project_profit").select("project_id, project_number, customer_name, contract_gross, collected, remaining").order("project_id", { ascending: false }),
        supabase.from("v_supplier_bills").select("*").gt("remaining", 0).order("bill_date"),
        supabase.from("partners").select("id, name").eq("active", true).order("id"),
      ]);
      return json({ ok: true, accounts: must(accounts), suppliers: must(suppliers), projects: must(projects), openBills: must(bills), partners: must(partners) });
    }

    if (action === "treasury-overview") {
      const [accounts, unassigned, suppliers] = await Promise.all([
        supabase.from("v_account_balances").select("*").order("account_id"),
        supabase.from("v_unassigned_receipts").select("*").order("payment_date", { ascending: false }),
        supabase.from("v_supplier_balances").select("*").order("name"),
      ]);
      const sup = must(suppliers) as any[];
      const acc = must(accounts) as any[];
      return json({
        ok: true, accounts: acc, unassigned: must(unassigned),
        totalBalance: Math.round(acc.filter((a) => a.active).reduce((s, a) => s + Number(a.balance), 0) * 100) / 100,
        totalPayable: Math.round(sup.reduce((s, x) => s + Math.max(0, Number(x.balance)), 0) * 100) / 100,
      });
    }

    if (action === "treasury-ledger") {
      let q = supabase.from("v_treasury_ledger").select("*").order("entry_date", { ascending: false }).order("id", { ascending: false }).limit(500);
      if (body.accountId) q = q.eq("account_id", body.accountId);
      if (body.projectId) q = q.eq("project_id", body.projectId);
      if (body.supplierId) q = q.eq("supplier_id", body.supplierId);
      if (body.kind) q = q.eq("kind", String(body.kind));
      const from = dateOrNull(body.from, "من تاريخ"), to = dateOrNull(body.to, "إلى تاريخ");
      if (from) q = q.gte("entry_date", from);
      if (to) q = q.lte("entry_date", to);
      return json({ ok: true, rows: must(await q) });
    }

    if (action === "treasury-save-account") {
      const f = body.fields || {};
      const row: Record<string, unknown> = {};
      if ("name" in f) row.name = txt(String(f.name || "").trim(), 100) || bad("اسم الحساب مطلوب");
      if ("kind" in f) { if (!["cash", "bank", "custody"].includes(String(f.kind))) bad("نوع الحساب غير صالح"); row.kind = f.kind; }
      if ("holder" in f) row.holder = txt(f.holder, 100);
      if ("opening_balance" in f) { const n = Number(f.opening_balance); if (!isFinite(n)) bad("الرصيد الافتتاحي غير صالح"); row.opening_balance = Math.round(n * 100) / 100; }
      if ("opening_date" in f) row.opening_date = dateOrNull(f.opening_date, "تاريخ الرصيد الافتتاحي") || bad("تاريخ الرصيد الافتتاحي مطلوب");
      if ("active" in f) row.active = !!f.active;
      if (body.accountId) {
        if (!Object.keys(row).length) bad("لا توجد حقول للتعديل");
        const data = must(await supabase.from("treasury_accounts").update(row).eq("id", body.accountId).select().maybeSingle());
        await logAudit("update_account", "treasury_account", Number(body.accountId), String(row.name || ""), null, row);
        return json({ ok: true, account: data });
      }
      if (!row.name || !row.kind) bad("الاسم ونوع الحساب مطلوبان");
      const data: any = must(await supabase.from("treasury_accounts").insert(row).select().maybeSingle());
      await logAudit("add_account", "treasury_account", data.id, String(row.name), null, row);
      return json({ ok: true, account: data });
    }

    if (action === "treasury-save-supplier") {
      const f = body.fields || {};
      const row: Record<string, unknown> = {};
      if ("name" in f) row.name = txt(String(f.name || "").trim(), 150) || bad("اسم المورد مطلوب");
      if ("vat_number" in f) row.vat_number = txt(f.vat_number, 30);
      if ("phone" in f) row.phone = txt(f.phone, 30);
      if ("notes" in f) row.notes = txt(f.notes, 500);
      if ("active" in f) row.active = !!f.active;
      if (body.supplierId) {
        if (!Object.keys(row).length) bad("لا توجد حقول للتعديل");
        const data = must(await supabase.from("suppliers").update(row).eq("id", body.supplierId).select().maybeSingle());
        return json({ ok: true, supplier: data });
      }
      if (!row.name) bad("اسم المورد مطلوب");
      const { data, error } = await supabase.from("suppliers").insert(row).select().maybeSingle();
      if (error) { if (error.code === "23505") bad("المورد ده مسجل بالفعل"); throw error; }
      await logAudit("add_supplier", "supplier", (data as any).id, String(row.name), null, null);
      return json({ ok: true, supplier: data });
    }

    if (action === "treasury-supplier-statement") {
      if (!body.supplierId) bad("supplierId required");
      const [sup, bills, pays] = await Promise.all([
        supabase.from("v_supplier_balances").select("*").eq("supplier_id", body.supplierId).maybeSingle(),
        supabase.from("v_supplier_bills").select("*").eq("supplier_id", body.supplierId).order("bill_date", { ascending: false }),
        supabase.from("v_treasury_ledger").select("*").eq("supplier_id", body.supplierId).eq("kind", "supplier_payment").order("entry_date", { ascending: false }),
      ]);
      const s = must(sup);
      if (!s) return json({ error: "المورد غير موجود" }, 404);
      return json({ ok: true, supplier: s, bills: must(bills), payments: must(pays) });
    }

    if (action === "treasury-record-bill") {
      const tax = body.taxTreatment ? String(body.taxTreatment) : "recoverable";
      if (!TAX.includes(tax)) bad("نوع الضريبة غير صالح");
      const p = {
        supplier_id: body.supplierId || null, supplier_name: txt(body.supplierName, 150),
        project_id: body.projectId || null, amount: num(body.amount, "المبلغ"),
        bill_date: dateOrNull(body.billDate, "تاريخ الفاتورة"), bill_number: txt(body.billNumber, 60),
        description: txt(body.description, 500), tax_treatment: tax, cost_type: txt(body.costType, 50),
      };
      const id = await rpc("finance_record_bill", { p });
      await logAudit("add_bill", "supplier_bill", Number(id), p.bill_number, null, { amount: p.amount, project_id: p.project_id });
      return json({ ok: true, billId: id });
    }

    if (action === "treasury-delete-bill") {
      if (!body.billId) bad("billId required");
      await rpc("finance_delete_bill", { p_id: body.billId });
      await logAudit("delete_bill", "supplier_bill", Number(body.billId), null, null, null);
      return json({ ok: true });
    }

    if (action === "treasury-record-entry") {
      const p: Record<string, unknown> = {
        kind: String(body.kind || ""), account_id: body.accountId || null, amount: num(body.amount, "المبلغ"),
        entry_date: dateOrNull(body.entryDate), method: txt(body.method, 50), reference: txt(body.reference, 100),
        notes: txt(body.notes, 500), project_id: body.projectId || null, supplier_id: body.supplierId || null,
        bill_id: body.billId || null, partner_id: body.partnerId || null, dist_kind: txt(body.distKind, 20),
        category: txt(body.category, 50), description: txt(body.description, 500),
        tax_treatment: body.taxTreatment ? String(body.taxTreatment) : null, direction: txt(body.direction, 3),
      };
      if (p.tax_treatment && !TAX.includes(String(p.tax_treatment))) bad("نوع الضريبة غير صالح");
      const id = await rpc("finance_record_entry", { p });
      await logAudit("add_treasury_entry", "treasury_entry", Number(id), String(p.kind), null, { amount: p.amount, account_id: p.account_id });
      return json({ ok: true, entryId: id });
    }

    if (action === "treasury-record-transfer") {
      const g = await rpc("finance_record_transfer", {
        p_from: body.fromAccountId || null, p_to: body.toAccountId || null, p_amount: num(body.amount, "المبلغ"),
        p_date: dateOrNull(body.entryDate), p_notes: txt(body.notes, 500),
      });
      await logAudit("add_transfer", "treasury_entry", null, String(g), null, { amount: body.amount });
      return json({ ok: true, transferGroup: g });
    }

    if (action === "treasury-assign-payment") {
      if (!body.paymentId || !body.accountId) bad("paymentId و accountId مطلوبان");
      const id = await rpc("finance_assign_payment", { p_payment: body.paymentId, p_account: body.accountId });
      await logAudit("assign_payment", "treasury_entry", Number(id), null, null, { payment_id: body.paymentId, account_id: body.accountId });
      return json({ ok: true, entryId: id });
    }

    if (action === "treasury-delete-entry") {
      if (!body.entryId) bad("entryId required");
      const { data: old } = await supabase.from("treasury_entries").select("kind, amount, direction, account_id, entry_date").eq("id", body.entryId).maybeSingle();
      await rpc("finance_delete_entry", { p_id: body.entryId });
      await logAudit("delete_treasury_entry", "treasury_entry", Number(body.entryId), old?.kind || null, old, null);
      return json({ ok: true });
    }

    // ---- خصم تسوية على العميل (كسور): بيخفّض قيمة التعاقد ويتسجّل بسببه، وممكن يتلغى ----
    if (action === "treasury-project-discounts") {
      if (!body.projectId) bad("projectId required");
      const rows = must(await supabase.from("project_discounts").select("*").eq("project_id", body.projectId).order("created_at", { ascending: false })) as any[];
      return json({ ok: true, discounts: rows, total: Math.round(rows.reduce((s, d) => s + Number(d.amount), 0) * 100) / 100 });
    }

    if (action === "treasury-apply-discount") {
      if (!body.projectId) bad("projectId required");
      const reason = txt(String(body.reason || "").trim(), 300);
      if (!reason) bad("اكتب سبب الخصم");
      const amount = num(body.amount, "مبلغ الخصم");
      const id = await rpc("finance_apply_discount", { p_project: body.projectId, p_amount: amount, p_reason: reason, p_date: dateOrNull(body.discountDate, "تاريخ الخصم") });
      await logAudit("apply_discount", "project", Number(body.projectId), reason, null, { amount, discount_id: id });
      return json({ ok: true, discountId: id });
    }

    if (action === "treasury-undo-discount") {
      if (!body.discountId) bad("discountId required");
      const { data: old } = await supabase.from("project_discounts").select("project_id, amount, reason").eq("id", body.discountId).maybeSingle();
      await rpc("finance_undo_discount", { p_id: body.discountId });
      await logAudit("undo_discount", "project", old?.project_id ?? null, old?.reason || null, old, null);
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
