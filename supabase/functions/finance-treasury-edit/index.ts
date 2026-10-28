// HoloulEnergy — finance-treasury-edit Edge Function (ADMIN ONLY)
// تعديل حركات الخزنة (الحساب / التاريخ / المبلغ / المشروع / أمر الشراء / المرجع / الملاحظات) مع سجل تعديلات.
// التعديل نفسه بيتم جوه دالة Postgres واحدة ذرّية: finance_edit_entry.
// نفس توثيق باقي دوال المالية (توكن أدمن HMAC + session_version). actions: treasury-get-entry, treasury-edit-entry, treasury-get-bill, treasury-edit-bill, treasury-ledger-search (فلاتر: حساب/نوع/مشروع/مورد/فترة/نص + ملخصات الكروت).

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

const KIND_AR: Record<string, string> = {
  customer_receipt: "قبض من عميل", supplier_payment: "دفع لمورد", supplier_refund: "استرداد من مورد",
  expense: "مصروف", partner_draw: "سحب شريك", transfer: "تحويل", other: "أخرى",
};
// تطبيع النص العربي للبحث: يشيل التشكيل ويوحّد الألف والياء والتاء المربوطة
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[\u064B-\u0652]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");

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
    // بيانات الحركة الخام + سجل تعديلاتها + أوامر شراء المورد (لو حركة مورد)
    if (action === "treasury-get-entry") {
      if (!body.entryId) bad("entryId required");
      const ent: any = must(await supabase.from("treasury_entries").select("*").eq("id", body.entryId).maybeSingle());
      if (!ent) return json({ error: "الحركة غير موجودة" }, 404);
      const [edits, orders] = await Promise.all([
        supabase.from("treasury_entry_edits").select("*").eq("entry_id", body.entryId).order("edited_at", { ascending: false }),
        ent.supplier_id
          ? supabase.from("v_purchase_orders").select("po_id, po_number, project_id, project_number, status").eq("supplier_id", ent.supplier_id).order("po_id", { ascending: false })
          : Promise.resolve({ data: [], error: null }),
      ]);
      return json({ ok: true, entry: ent, edits: must(edits), orders: must(orders) });
    }

    if (action === "treasury-edit-entry") {
      if (!body.entryId) bad("entryId required");
      const f = body.fields || {};
      const reason = txt(String(body.reason || "").trim(), 300);
      if (!reason) bad("اكتب سبب التعديل");
      const p: Record<string, unknown> = {};
      if ("accountId" in f) p.account_id = f.accountId || null;
      if ("entryDate" in f) p.entry_date = dateOrNull(f.entryDate) || bad("التاريخ مطلوب");
      if ("amount" in f) p.amount = num(f.amount, "المبلغ");
      if ("method" in f) p.method = txt(f.method, 50);
      if ("reference" in f) p.reference = txt(f.reference, 100);
      if ("notes" in f) p.notes = txt(f.notes, 500);
      if ("projectId" in f) p.project_id = f.projectId || null;
      if ("poId" in f) p.po_id = f.poId || null;
      if (!Object.keys(p).length) bad("لا توجد حقول للتعديل");
      const id = await rpc("finance_edit_entry", { p_id: body.entryId, p, p_reason: reason });
      await logAudit("edit_treasury_entry", "treasury_entry", Number(body.entryId), reason, null, p);
      return json({ ok: true, editId: id });
    }

    // سجل الحركات + ملخصات الكروت. الفلاتر: حساب / نوع / مشروع / مورد / فترة / بحث نصّي (اسم عميل / مورد / رقم فاتورة / مشروع / مرجع / ملاحظات / مبلغ).
    // بنسحب كل الحركات لحد "إلى تاريخ" من غير فلاتر عشان نحسب: رصيد كل حساب في آخر الفترة + رصيد أول الفترة،
    // وبعدين نطبّق الفلاتر في الذاكرة لحساب الوارد/الصادر والصافي لكل حساب وحسب نوع الحركة.
    if (action === "treasury-ledger-search") {
      const from = dateOrNull(body.from, "من تاريخ"), to = dateOrNull(body.to, "إلى تاريخ");
      let q = supabase.from("v_treasury_ledger").select("*").order("entry_date", { ascending: false }).order("id", { ascending: false }).limit(20000);
      if (to) q = q.lte("entry_date", to);
      const [rowsR, billsR, allocR, accR] = await Promise.all([
        q,
        supabase.from("supplier_bills").select("id, bill_number").limit(50000),
        supabase.from("supplier_payment_allocations").select("entry_id, bill_id").limit(50000),
        supabase.from("treasury_accounts").select("id, name, kind, holder, opening_balance, active").order("id"),
      ]);
      const billNo: Record<string, string> = {};
      for (const b of must(billsR) as any[]) if (b.bill_number) billNo[String(b.id)] = String(b.bill_number);
      const allocBy: Record<string, string[]> = {};
      for (const a of must(allocR) as any[]) { const n = billNo[String(a.bill_id)]; if (n) (allocBy[String(a.entry_id)] ||= []).push(n); }
      const terms = norm(body.q).split(/\s+/).filter(Boolean);
      const accId = body.accountId ? String(body.accountId) : "";
      const prjId = body.projectId ? String(body.projectId) : "";
      const supId = body.supplierId ? String(body.supplierId) : "";
      const kindF = body.kind ? String(body.kind) : "";
      const r2 = (n: number) => Math.round(n * 100) / 100;
      // إحصائيات كل حساب
      const accs: Record<string, any> = {};
      for (const a of must(accR) as any[]) {
        accs[String(a.id)] = { account_id: a.id, name: a.name, kind: a.kind, holder: a.holder, active: a.active,
          opening: Number(a.opening_balance), balance: Number(a.opening_balance), in: 0, out: 0, count: 0 };
      }
      const byKind: Record<string, { in: number; out: number }> = {};
      const out: any[] = [];
      let sumIn = 0, sumOut = 0, total = 0;
      for (const r of must(rowsR) as any[]) {
        const amt = Number(r.amount), sgn = r.direction === "in" ? 1 : -1;
        const A = accs[String(r.account_id)];
        if (A) {
          A.balance += sgn * amt;                              // رصيد الحساب في آخر الفترة (بغض النظر عن باقي الفلاتر)
          if (from && r.entry_date < from) { A.opening += sgn * amt; continue; } // قبل بداية الفترة: يدخل في رصيد أول الفترة بس
        } else if (from && r.entry_date < from) continue;
        if (accId && String(r.account_id) !== accId) continue;
        if (kindF && r.kind !== kindF) continue;
        if (prjId && String(r.project_id ?? "") !== prjId) continue;
        if (supId && String(r.supplier_id ?? "") !== supId) continue;
        const nums = new Set<string>(allocBy[String(r.id)] || []);
        if (r.bill_id && billNo[String(r.bill_id)]) nums.add(billNo[String(r.bill_id)]);
        const bill_numbers = [...nums];
        if (terms.length) {
          const hay = norm([r.customer_name, r.supplier_name, r.project_number, r.reference, r.notes, r.account_name, r.method, KIND_AR[r.kind], r.kind,
            String(r.amount), String(Number(r.amount)), ...bill_numbers].join(" "));
          if (!terms.every((t) => hay.includes(t))) continue;
        }
        total++;
        if (r.direction === "in") sumIn += amt; else sumOut += amt;
        if (A) { A[r.direction === "in" ? "in" : "out"] += amt; A.count++; }
        const K = (byKind[r.kind] ||= { in: 0, out: 0 });
        K[r.direction === "in" ? "in" : "out"] += amt;
        if (out.length < 500) out.push({ ...r, bill_numbers });
      }
      const accounts = Object.values(accs).map((A: any) => ({ ...A, opening: r2(A.opening), balance: r2(A.balance), in: r2(A.in), out: r2(A.out) }));
      for (const k of Object.keys(byKind)) { byKind[k].in = r2(byKind[k].in); byKind[k].out = r2(byKind[k].out); }
      return json({ ok: true, rows: out, total, sumIn: r2(sumIn), sumOut: r2(sumOut), accounts, byKind });
    }

    // فاتورة/مرتجع مورد: بياناتها + سجل تعديلاتها + المدفوع/المخصوم عليها
    if (action === "treasury-get-bill") {
      if (!body.billId) bad("billId required");
      const b: any = must(await supabase.from("supplier_bills").select("*").eq("id", body.billId).maybeSingle());
      if (!b) return json({ error: "الفاتورة غير موجودة" }, 404);
      const [edits, pays, allocs] = await Promise.all([
        supabase.from("supplier_bill_edits").select("*").eq("bill_id", body.billId).order("edited_at", { ascending: false }),
        supabase.from("treasury_entries").select("amount").eq("bill_id", body.billId),
        supabase.from("supplier_payment_allocations").select("amount").eq("bill_id", body.billId),
      ]);
      const used = [...(must(pays) as any[]), ...(must(allocs) as any[])].reduce((t, x) => t + Number(x.amount), 0);
      return json({ ok: true, bill: b, edits: must(edits), used: Math.round(used * 100) / 100 });
    }

    // تعديل التاريخ / القيمة / الرقم / البيان (بيتعدّل معاها تكلفة المشروع أو المصروف). سبب التعديل إجباري.
    if (action === "treasury-edit-bill") {
      if (!body.billId) bad("billId required");
      const f = body.fields || {};
      const reason = txt(String(body.reason || "").trim(), 300);
      if (!reason) bad("اكتب سبب التعديل");
      const p: Record<string, unknown> = {};
      if ("billDate" in f) p.bill_date = dateOrNull(f.billDate) || bad("التاريخ مطلوب");
      if ("amount" in f) p.amount = num(f.amount, "المبلغ");
      if ("billNumber" in f) p.bill_number = txt(f.billNumber, 100);
      if ("description" in f) p.description = txt(f.description, 500);
      if (!Object.keys(p).length) bad("لا توجد حقول للتعديل");
      const id = await rpc("finance_edit_bill", { p_id: body.billId, p, p_reason: reason });
      await logAudit("edit_supplier_bill", "supplier_bill", Number(body.billId), reason, null, p);
      return json({ ok: true, editId: id });
    }

    // تحويل واحد لمورد موزّع على أكتر من مشروع / فاتورة / أمر شراء (كل سطر = حركة بمشروعها، وبتتجمّع بمعرّف مجموعة)
    if (action === "treasury-split-payment") {
      const lines = (Array.isArray(body.lines) ? body.lines : []).map((l: any) => ({
        amount: num(l.amount, "مبلغ السطر"), project_id: l.projectId || null, po_id: l.poId || null, bill_id: l.billId || null, notes: txt(l.notes, 500),
      }));
      if (!lines.length) bad("أضف سطر واحد على الأقل");
      if (!body.supplierId) bad("اختر المورد");
      if (!body.accountId) bad("اختر الحساب");
      const p = {
        supplier_id: body.supplierId, account_id: body.accountId, entry_date: dateOrNull(body.entryDate) || bad("التاريخ مطلوب"),
        method: txt(body.method, 50), reference: txt(body.reference, 100), notes: txt(body.notes, 500),
        total: body.total ? num(body.total, "مبلغ التحويل") : 0, lines,
      };
      const group = await rpc("finance_record_split_payment", { p });
      await logAudit("add_split_payment", "treasury_entry", null, String(group), null, { lines: lines.length, total: lines.reduce((t: number, l: any) => t + l.amount, 0) });
      return json({ ok: true, group });
    }

    if (action === "treasury-split-payment-delete") {
      if (!body.group) bad("group required");
      const n = await rpc("finance_delete_split_payment", { p_group: body.group });
      await logAudit("delete_split_payment", "treasury_entry", null, String(body.group), null, { entries: n });
      return json({ ok: true, deleted: n });
    }

    // فاتورة واحدة من المورد موزّعة على أكتر من مشروع (كل سطر = فاتورة بمشروعها بنفس الرقم، وبتتجمّع بمعرّف مجموعة)
    if (action === "treasury-split-bill") {
      const lines = (Array.isArray(body.lines) ? body.lines : []).map((l: any) => ({
        amount: num(l.amount, "مبلغ السطر"), project_id: l.projectId || null, po_id: l.poId || null, description: txt(l.description, 500), cost_type: txt(l.costType, 50),
      }));
      if (!lines.length) bad("أضف سطر واحد على الأقل");
      const p = {
        supplier_id: body.supplierId || null, supplier_name: txt(body.supplierName, 150), bill_date: dateOrNull(body.billDate) || bad("التاريخ مطلوب"),
        tax_treatment: body.taxTreatment || null, description: txt(body.description, 500), bill_number: txt(body.billNumber, 100), cost_type: txt(body.costType, 50),
        doc_type: body.docType === "credit_note" ? "credit_note" : "invoice", total: body.total ? num(body.total, "قيمة الفاتورة") : 0, lines,
      };
      const group = await rpc("finance_record_split_bill", { p });
      await logAudit("add_split_bill", "supplier_bill", null, String(group), null, { lines: lines.length, total: lines.reduce((t: number, l: any) => t + l.amount, 0) });
      return json({ ok: true, group });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
