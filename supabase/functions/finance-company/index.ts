// HoloulEnergy — finance-company Edge Function (ADMIN ONLY)
// تاب "الشركة": ملخص الشركة، الشركاء (تواصل + حسابات بنكية)، التصفية، الالتزامات، مساهمات الشركاء.
// نفس مصادقة finance-api (توكن الأدمن + session_version). كل actions هنا بتبدأ بـ company-.
// ملاحظة: الأرقام كلها من views في قاعدة البيانات (v_company_summary / v_partner_balance_v2).

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
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64urlFromBytes(new Uint8Array(sig));
}
function sessionSecret(): string {
  const s = Deno.env.get("SESSION_SECRET");
  if (!s) throw new Error("SESSION_SECRET is not configured for this project");
  return s;
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

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function checkAdminToken(token: string | undefined): Promise<boolean> {
  const payload = await readToken(token);
  if (!payload || payload.sub !== "admin") return false;
  const { data, error } = await supabase.from("admin_secret").select("session_version").eq("id", 1).single();
  if (error || !data) return false;
  return payload.ver === data.session_version;
}

async function logAudit(actionType: string, entityType: string, entityId: number | null, entityLabel: string | null, oldValue: unknown, newValue: unknown) {
  try {
    await supabase.from("audit_log").insert({
      actor: "admin", actor_role: "admin", action_type: actionType, entity_type: entityType,
      entity_id: entityId, entity_label: entityLabel, old_value: oldValue ?? null, new_value: newValue ?? null,
    });
  } catch { /* never break the primary action over a logging failure */ }
}

// ------------------------- validation helpers -------------------------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
class BadRequest extends Error {}
function bad(msg: string): never { throw new BadRequest(msg); }
function money(v: unknown, label = "المبلغ", allowZero = false): number {
  const n = Number(v);
  if (!isFinite(n) || n < 0 || (!allowZero && n === 0)) bad(`${label} غير صالح`);
  return Math.round(n * 100) / 100;
}
function dateOrNull(v: unknown, label = "التاريخ"): string | null {
  if (v == null || v === "") return null;
  const s = String(v);
  if (!DATE_RE.test(s) || isNaN(Date.parse(s))) bad(`${label} غير صالح (YYYY-MM-DD)`);
  return s;
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const txt = (v: unknown, max: number) => (v ? String(v).trim().slice(0, max) || null : null);
const today = () => new Date().toISOString().slice(0, 10);
const num = (v: unknown, label: string): number => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) bad(`${label} مطلوب`); return n; };

const OBL_KINDS = ["vat", "fine", "zakat", "fee", "other"];
const DIST_KINDS = ["profit", "draw", "advance"];
const CONTACT = ["phone", "whatsapp", "email"];
const IBAN_RE = /^[A-Z]{2}[0-9A-Z]{13,32}$/;
const maskIban = (s: string | null) => (s ? s.slice(0, 4) + "…" + s.slice(-4) : null);

async function one<T = any>(q: PromiseLike<{ data: T | null; error: any }>): Promise<T | null> {
  const { data, error } = await q;
  if (error) throw error;
  return data;
}
async function many<T = any>(q: PromiseLike<{ data: T[] | null; error: any }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
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
    // ------------------------------------------------------------ overview
    if (action === "company-overview") {
      const t = today();
      const [summary, balances, settled, pp, partners, shares, banks, obligations, contribs, accounts, dists, sharesSum, einv] = await Promise.all([
        one(supabase.from("v_company_summary").select("*").maybeSingle()),
        many(supabase.from("v_partner_balance_v2").select("*").order("partner_id")),
        many(supabase.from("v_settled_project_profit").select("*").order("settled_at", { ascending: false })),
        many(supabase.from("v_project_profit").select("project_id,project_number,customer_name,status,is_completed,completion_date,contract_gross,contract_net,cost_gross,cost_net,actual_profit,margin_pct,collected,remaining")),
        many(supabase.from("partners").select("id,name,active,notes,phone,whatsapp,email,preferred_contact").order("id")),
        many(supabase.from("partner_shares").select("*").order("effective_from", { ascending: false })),
        many(supabase.from("partner_bank_accounts").select("*").eq("active", true).order("partner_id").order("id")),
        many(supabase.from("partner_obligations").select("*").order("created_at", { ascending: false }).limit(300)),
        many(supabase.from("treasury_entries").select("id,entry_date,account_id,amount,reference,notes,partner_id").eq("kind", "partner_contribution").order("entry_date", { ascending: false }).limit(300)),
        many(supabase.from("treasury_accounts").select("id,name,kind,holder").eq("active", true).order("id")),
        many(supabase.from("partner_distributions").select("*").order("distribution_date", { ascending: false }).limit(300)),
        supabase.rpc("partner_shares_sum", { p_date: t }),
        supabase.from("einvoice_config").select("trial_mode").limit(1).maybeSingle(),
      ]);
      if (sharesSum.error) throw sharesSum.error;
      const settledIds = new Set(settled.map((s: any) => s.project_id));
      const unsettled = pp.filter((p: any) => !settledIds.has(p.project_id)).map((p: any) => ({
        ...p, reserve: r2(Math.max(Number(p.collected) - Number(p.cost_gross), 0)),
      }));
      const current = shares.filter((s: any) => s.effective_from <= t && (!s.effective_to || s.effective_to >= t));
      const warnings: any[] = [];
      if (Number(sharesSum.data) !== 100) warnings.push({ type: "shares_sum", message: `مجموع النسب السارية ${sharesSum.data}% وليس 100%` });
      for (const p of unsettled) {
        if (p.is_completed && Number(p.cost_gross) === 0) warnings.push({ type: "no_costs", project: p.project_number, message: "مشروع منتهٍ بدون تكاليف مسجلة — لا تصفّه قبل تسجيل التكاليف" });
      }
      if (einv?.data?.trial_mode) warnings.push({ type: "einvoice_trial", message: "الفاتورة الإلكترونية في وضع تجريبي (trial_mode) — الفواتير قد لا تُبلَّغ إلى ZATCA" });
      const contribByPartner: Record<number, number> = {};
      for (const c of contribs) contribByPartner[c.partner_id] = r2((contribByPartner[c.partner_id] || 0) + Number(c.amount));
      return json({
        ok: true, summary, balances, settled, unsettled, partners, currentShares: current,
        currentTotalPct: r2(current.reduce((s: number, x: any) => s + Number(x.share_pct), 0)),
        banks, obligations, contributions: contribs, accounts, distributions: dists, warnings,
      });
    }

    // ------------------------------------------------------ partner details
    if (action === "company-save-partner-info") {
      const id = num(body.partnerId, "الشريك");
      const f = body.fields || {};
      const update: Record<string, unknown> = {};
      if ("phone" in f) update.phone = txt(f.phone, 30);
      if ("whatsapp" in f) update.whatsapp = txt(f.whatsapp, 30);
      if ("email" in f) {
        const e = txt(f.email, 120);
        if (e && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) bad("البريد الإلكتروني غير صالح");
        update.email = e;
      }
      if ("preferred_contact" in f) {
        const v = f.preferred_contact ? String(f.preferred_contact) : null;
        if (v && !CONTACT.includes(v)) bad("وسيلة التواصل غير صالحة");
        update.preferred_contact = v;
      }
      if ("notes" in f) update.notes = txt(f.notes, 500);
      if (!Object.keys(update).length) bad("لا توجد حقول للتعديل");
      const old = await one(supabase.from("partners").select("phone,whatsapp,email,preferred_contact,notes").eq("id", id).maybeSingle());
      const data = await one(supabase.from("partners").update(update).eq("id", id).select().maybeSingle());
      await logAudit("update_partner_info", "partner", id, null, old, update);
      return json({ ok: true, partner: data });
    }

    // --------------------------------------------------------- bank accounts
    if (action === "company-save-bank") {
      const partnerId = num(body.partnerId, "الشريك");
      const f = body.fields || {};
      const bankName = txt(f.bank_name, 100), holder = txt(f.account_holder, 120);
      if (!bankName) bad("اسم البنك مطلوب");
      if (!holder) bad("اسم صاحب الحساب مطلوب");
      const iban = f.iban ? String(f.iban).replace(/\s+/g, "").toUpperCase() : null;
      const accNo = txt(f.account_number, 40);
      if (!iban && !accNo) bad("أدخل رقم الآيبان أو رقم الحساب");
      if (iban) {
        if (!IBAN_RE.test(iban)) bad("صيغة الآيبان غير صالحة");
        if (iban.startsWith("SA") && !/^SA[0-9]{22}$/.test(iban)) bad("الآيبان السعودي = SA + 22 رقمًا");
      }
      const row = {
        partner_id: partnerId, bank_name: bankName, account_holder: holder, iban, account_number: accNo,
        is_default: !!f.is_default, active: true, notes: txt(f.notes, 300),
      };
      let saved: any;
      if (body.bankId) {
        const id = num(body.bankId, "الحساب");
        if (row.is_default) await supabase.from("partner_bank_accounts").update({ is_default: false }).eq("partner_id", partnerId).neq("id", id);
        saved = await one(supabase.from("partner_bank_accounts").update(row).eq("id", id).eq("partner_id", partnerId).select().maybeSingle());
      } else {
        if (row.is_default) await supabase.from("partner_bank_accounts").update({ is_default: false }).eq("partner_id", partnerId);
        saved = await one(supabase.from("partner_bank_accounts").insert(row).select().maybeSingle());
      }
      await logAudit(body.bankId ? "update_partner_bank" : "add_partner_bank", "partner", partnerId, bankName, null, { ...row, iban: maskIban(iban), account_number: accNo ? "…" + accNo.slice(-4) : null });
      return json({ ok: true, bank: saved });
    }

    if (action === "company-delete-bank") {
      const id = num(body.bankId, "الحساب");
      const old = await one(supabase.from("partner_bank_accounts").select("partner_id,bank_name,iban").eq("id", id).maybeSingle());
      await one(supabase.from("partner_bank_accounts").update({ active: false, is_default: false }).eq("id", id).select().maybeSingle());
      if (old) await logAudit("delete_partner_bank", "partner", old.partner_id, old.bank_name, { iban: maskIban(old.iban) }, null);
      return json({ ok: true });
    }

    // ------------------------------------------------------------ settlement
    if (action === "company-settle-project") {
      const projectId = num(body.projectId, "المشروع");
      const p = await one(supabase.from("v_project_profit").select("project_id,project_number,is_completed,status,cost_gross,collected,contract_gross").eq("project_id", projectId).maybeSingle());
      if (!p) bad("المشروع غير موجود");
      if (!p.is_completed) bad(`المشروع لسه مش منتهٍ (الحالة: ${p.status})`);
      if (Number(p.cost_gross) === 0 && !body.force) bad("لا توجد تكاليف مسجلة لهذا المشروع. سجّل التكاليف أولًا، أو أكّد التصفية يدويًا.");
      const invc = await one(supabase.from("v_project_invoicing").select("uninvoiced_gross").eq("project_id", projectId).maybeSingle());
      const cfg = await one(supabase.from("finance_settings").select("block_settle_without_invoice").eq("id", 1).maybeSingle());
      const uninv = invc ? Number(invc.uninvoiced_gross) : 0;
      if (uninv > 1) {
        if (cfg?.block_settle_without_invoice) bad(`لا يمكن تصفية المشروع: غير مفوتر بقيمة ${uninv.toFixed(2)} (التصفية ممنوعة بدون فاتورة حسب الإعدادات)`);
        if (!body.acknowledgeNoInvoice) return json({ ok: false, needsConfirm: true, message: `المشروع غير مفوتر بقيمة ${uninv.toFixed(2)} (شامل الضريبة). التصفية بدون فاتورة تعني أرباحًا وضريبة مقدّرة فقط. متابعة؟` });
      }
      const at = dateOrNull(body.settledAt, "تاريخ التصفية");
      const row: Record<string, unknown> = {
        project_id: projectId, settled_at: at ? at + "T00:00:00Z" : new Date().toISOString(), settled_by: "admin", updated_at: new Date().toISOString(),
      };
      const data = await one(supabase.from("project_finance_flags").upsert(row, { onConflict: "project_id" }).select().maybeSingle());
      await logAudit("settle_project", "project", projectId, p.project_number, null, { settled_at: row.settled_at, cost_gross: p.cost_gross, collected: p.collected });
      return json({ ok: true, flags: data });
    }

    if (action === "company-unsettle-project") {
      const projectId = num(body.projectId, "المشروع");
      const old = await one(supabase.from("project_finance_flags").select("settled_at").eq("project_id", projectId).maybeSingle());
      if (!old || !old.settled_at) bad("المشروع غير مصفّى");
      const data = await one(supabase.from("project_finance_flags").update({ settled_at: null, settled_by: null, updated_at: new Date().toISOString() }).eq("project_id", projectId).select().maybeSingle());
      await logAudit("unsettle_project", "project", projectId, null, old, { settled_at: null });
      return json({ ok: true, flags: data });
    }

    // ----------------------------------------------------------- obligations
    if (action === "company-add-obligation") {
      const partnerId = num(body.partnerId, "الشريك");
      const kind = String(body.kind || "");
      if (!OBL_KINDS.includes(kind)) bad("نوع الالتزام غير صالح");
      const row = {
        partner_id: partnerId, kind, amount_estimated: money(body.amount, "المبلغ", true),
        amount_paid: 0, status: "estimated", period_label: txt(body.periodLabel, 30),
        due_date: dateOrNull(body.dueDate, "تاريخ الاستحقاق"), project_id: body.projectId ? num(body.projectId, "المشروع") : null,
        description: txt(body.description, 300), reference: txt(body.reference, 80), notes: txt(body.notes, 300),
      };
      const data = await one(supabase.from("partner_obligations").insert(row).select().maybeSingle());
      await logAudit("add_obligation", "partner", partnerId, kind, null, row);
      return json({ ok: true, obligation: data });
    }

    if (action === "company-pay-obligation") {
      const id = num(body.obligationId, "الالتزام");
      const o = await one(supabase.from("partner_obligations").select("*").eq("id", id).maybeSingle());
      if (!o) bad("الالتزام غير موجود");
      const add = money(body.amount, "المبلغ المسدد");
      const paid = r2(Number(o.amount_paid) + add);
      const est = Number(o.amount_estimated);
      const status = est > 0 && paid >= est ? "paid" : "partial";
      const upd = { amount_paid: paid, status, paid_date: dateOrNull(body.paidDate, "تاريخ السداد") || today(), reference: txt(body.reference, 80) || o.reference };
      const data = await one(supabase.from("partner_obligations").update(upd).eq("id", id).select().maybeSingle());
      await logAudit("pay_obligation", "partner", o.partner_id, o.kind, { amount_paid: o.amount_paid, status: o.status }, upd);
      return json({ ok: true, obligation: data });
    }

    if (action === "company-delete-obligation") {
      const id = num(body.obligationId, "الالتزام");
      const old = await one(supabase.from("partner_obligations").select("*").eq("id", id).maybeSingle());
      if (!old) bad("الالتزام غير موجود");
      const { error } = await supabase.from("partner_obligations").delete().eq("id", id);
      if (error) throw error;
      await logAudit("delete_obligation", "partner", old.partner_id, old.kind, old, null);
      return json({ ok: true });
    }

    // ---------------------------------------------- partner contributions
    // مساهمة شريك: حركة واردة في الخزنة، مش إيراد ومش مصروف.
    if (action === "company-add-contribution") {
      const partnerId = num(body.partnerId, "الشريك");
      const accountId = num(body.accountId, "الحساب");
      const acc = await one(supabase.from("treasury_accounts").select("id,active").eq("id", accountId).maybeSingle());
      if (!acc || !acc.active) bad("الحساب غير موجود أو غير فعّال");
      const row = {
        entry_date: dateOrNull(body.entryDate) || today(), account_id: accountId, direction: "in",
        amount: money(body.amount), kind: "partner_contribution", partner_id: partnerId,
        reference: txt(body.reference, 80), notes: txt(body.notes, 300), created_by: "admin",
      };
      const data = await one(supabase.from("treasury_entries").insert(row).select().maybeSingle());
      await logAudit("add_contribution", "partner", partnerId, null, null, { amount: row.amount, date: row.entry_date, account_id: accountId });
      return json({ ok: true, entry: data });
    }

    if (action === "company-delete-contribution") {
      const id = num(body.entryId, "الحركة");
      const old = await one(supabase.from("treasury_entries").select("id,partner_id,amount,entry_date,kind").eq("id", id).maybeSingle());
      if (!old || old.kind !== "partner_contribution") bad("الحركة ليست مساهمة شريك");
      const { error } = await supabase.from("treasury_entries").delete().eq("id", id);
      if (error) throw error;
      await logAudit("delete_contribution", "partner", old.partner_id, null, old, null);
      return json({ ok: true });
    }

    // ------------------------------------------------------ expense funder
    // تغيير الممول لمصروف: null = الشركة. الممول من شريك بيطلع من وعاء ربح الشركة، وبيتحسب كالتزام مساهمة على الشريك.
    if (action === "company-set-expense-funder") {
      const id = num(body.expenseId, "المصروف");
      const pid = body.partnerId == null || body.partnerId === "" ? null : num(body.partnerId, "الشريك");
      const old = await one(supabase.from("expenses").select("funded_by_partner_id,category,amount").eq("id", id).maybeSingle());
      if (!old) bad("المصروف غير موجود");
      if (pid !== null) {
        const pt = await one(supabase.from("partners").select("id,active").eq("id", pid).maybeSingle());
        if (!pt || !pt.active) bad("الشريك غير موجود أو غير فعّال");
      }
      await one(supabase.from("expenses").update({ funded_by_partner_id: pid }).eq("id", id).select().maybeSingle());
      await logAudit("set_expense_funder", "expense", id, old.category, { funded_by_partner_id: old.funded_by_partner_id }, { funded_by_partner_id: pid });
      return json({ ok: true });
    }

    // ------------------------------------------------ invoicing / VAT exposure
    if (action === "company-invoicing-overview") {
      const [projects, quarters, unlinked, settings, einv] = await Promise.all([
        many(supabase.from("v_project_invoicing").select("*").order("project_id")),
        many(supabase.from("v_vat_exposure_quarterly").select("*").order("quarter")),
        many(supabase.from("invoices").select("id,invoice_number,invoice_type,document_type,issued_at,supply_date,customer_id,customer_name,total,vat_amount").is("project_id", null).eq("document_type", "invoice").order("issued_at", { ascending: false }).limit(200)),
        one(supabase.from("finance_settings").select("invoice_b2b_due_days,invoice_b2c_due_days,block_settle_without_invoice,vat_rate").eq("id", 1).maybeSingle()),
        supabase.from("einvoice_config").select("trial_mode").limit(1).maybeSingle(),
      ]);
      return json({ ok: true, projects, quarters, unlinked, settings, trialMode: !!einv?.data?.trial_mode });
    }

    if (action === "company-link-invoice") {
      const invId = num(body.invoiceId, "الفاتورة");
      const pid = body.projectId == null || body.projectId === "" ? null : num(body.projectId, "المشروع");
      const inv = await one(supabase.from("invoices").select("id,invoice_number,customer_id,project_id").eq("id", invId).maybeSingle());
      if (!inv) bad("الفاتورة غير موجودة");
      if (pid !== null) {
        const pr = await one(supabase.from("projects").select("id,customer_id").eq("id", pid).maybeSingle());
        if (!pr) bad("المشروع غير موجود");
        if (inv.customer_id && pr.customer_id && inv.customer_id !== pr.customer_id && !body.force) bad("عميل الفاتورة غير عميل المشروع");
      }
      // project_id غير محمي من التعديل بعد الإصدار؛ الإشعارات الدائنة المرتبطة تتبع فاتورتها
      const { error: e1 } = await supabase.from("invoices").update({ project_id: pid }).eq("id", invId);
      if (e1) throw e1;
      const { error: e2 } = await supabase.from("invoices").update({ project_id: pid }).eq("related_invoice_id", invId).eq("document_type", "credit_note");
      if (e2) throw e2;
      await logAudit("link_invoice", "invoice", invId, inv.invoice_number, { project_id: inv.project_id }, { project_id: pid });
      return json({ ok: true });
    }

    if (action === "company-set-tax-point") {
      const projectId = num(body.projectId, "المشروع");
      const d = dateOrNull(body.date, "تاريخ نقطة الاستحقاق");
      const data = await one(supabase.from("project_finance_flags").upsert({ project_id: projectId, tax_point_date: d, updated_at: new Date().toISOString() }, { onConflict: "project_id" }).select().maybeSingle());
      await logAudit("set_tax_point", "project", projectId, null, null, { tax_point_date: d });
      return json({ ok: true, flags: data });
    }

    if (action === "company-save-invoicing-settings") {
      const b2b = Number(body.b2bDays), b2c = Number(body.b2cDays);
      if (!Number.isInteger(b2b) || b2b < 0 || b2b > 90) bad("أيام فاتورة المنشآت غير صالحة");
      if (!Number.isInteger(b2c) || b2c < 0 || b2c > 90) bad("أيام فاتورة الأفراد غير صالحة");
      const upd = { invoice_b2b_due_days: b2b, invoice_b2c_due_days: b2c, block_settle_without_invoice: !!body.blockSettle };
      await one(supabase.from("finance_settings").update(upd).eq("id", 1).select().maybeSingle());
      await logAudit("save_invoicing_settings", "settings", 1, null, null, upd);
      return json({ ok: true });
    }

    // التزام ضريبة ربع: المبلغ تقدير النظام، والمسدّد الفعلي يُسجَّل بـ company-pay-obligation. التقدير المخزّن لا يدخل الرصيد (يُحتسب من المشاريع) تفاديًا للعدّ المزدوج.
    if (action === "company-create-vat-obligation") {
      const quarter = String(body.quarter || "");
      const m = /^(\d{4})-Q([1-4])$/.exec(quarter);
      if (!m) bad("الربع غير صالح (مثال 2026-Q3)");
      const q = await one(supabase.from("v_vat_exposure_quarterly").select("net_vat").eq("quarter", quarter).maybeSingle());
      if (!q) bad("لا توجد بيانات لهذا الربع");
      const t = today();
      const rules = await many(supabase.from("partner_obligation_rules").select("partner_id,effective_from,effective_to").in("kind", ["*", "vat"]).lte("effective_from", t));
      const bearer = rules.find((r: any) => !r.effective_to || r.effective_to >= t);
      if (!bearer) bad("لا توجد قاعدة تحدد من يتحمل الضريبة");
      const exists = await one(supabase.from("partner_obligations").select("id").eq("kind", "vat").eq("period_label", quarter).eq("partner_id", bearer.partner_id).maybeSingle());
      if (exists) bad("يوجد التزام ضريبة لهذا الربع بالفعل");
      const due = new Date(Date.UTC(Number(m![1]), Number(m![2]) * 3 + 1, 0)).toISOString().slice(0, 10);
      const row = {
        partner_id: bearer.partner_id, kind: "vat", period_label: quarter, amount_estimated: Math.max(r2(Number(q.net_vat)), 0), amount_paid: 0, status: "estimated",
        due_date: due, description: `ضريبة ${quarter} — تقدير النظام. عدّل المبلغ لقيمة الإقرار الفعلي.`,
      };
      const data = await one(supabase.from("partner_obligations").insert(row).select().maybeSingle());
      await logAudit("create_vat_obligation", "partner", bearer.partner_id, quarter, null, row);
      return json({ ok: true, obligation: data });
    }

    // --------------------------------------------------------- distributions
    // سقف الصرف: ما يزيد عن الرصيد المستحق مرفوض (إلا السلفة، وهي بحكم تعريفها قبل الاستحقاق).
    if (action === "company-add-distribution") {
      const partnerId = num(body.partnerId, "الشريك");
      const kind = String(body.kind || "profit");
      if (!DIST_KINDS.includes(kind)) bad("نوع التوزيع غير صالح");
      const amount = money(body.amount);
      if (kind !== "advance") {
        const b = await one(supabase.from("v_partner_balance_v2").select("balance_gross,partner_name").eq("partner_id", partnerId).maybeSingle());
        if (!b) bad("الشريك غير موجود أو غير فعّال");
        const avail = r2(Math.max(Number(b.balance_gross), 0));
        if (amount > avail) bad(`المبلغ أكبر من الرصيد المستحق للصرف (${avail.toFixed(2)}). اعتمد تصفية المشاريع وسجّل المساهمات أولًا، أو سجّلها كسلفة.`);
      }
      const row = {
        partner_id: partnerId, amount, kind, distribution_date: dateOrNull(body.distributionDate) || today(), notes: txt(body.notes, 500),
      };
      const data = await one(supabase.from("partner_distributions").insert(row).select().maybeSingle());
      await logAudit("add_distribution", "partner", partnerId, kind, null, { amount, date: row.distribution_date });
      return json({ ok: true, distribution: data });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
