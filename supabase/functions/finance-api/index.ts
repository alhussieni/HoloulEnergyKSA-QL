// HoloulEnergy — finance-api Edge Function (ADMIN ONLY)
//
// بيتحقق من نفس توكن الأدمن اللي بيصدره compute-quote ("admin-login")
// (HMAC-SHA256 بـ SESSION_SECRET + session_version) زي crm-api بالظبط.
// توكن المندوبين مرفوض: كل actions هنا للأدمن فقط. كل المبالغ بتتخزن كما دُفعت
// (شامل الضريبة) وفصل الصافي/الضريبة بيتم في views قاعدة البيانات.

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
const TAX = ["recoverable", "none"];
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
function taxOrDefault(v: unknown): string {
  if (v == null || v === "") return "recoverable";
  if (!TAX.includes(String(v))) bad("نوع الضريبة غير صالح");
  return String(v);
}
function monthStart(v: unknown): string {
  const s = String(v || "");
  const m = /^(\d{4})-(\d{2})(-\d{2})?$/.exec(s);
  if (!m || +m[2] < 1 || +m[2] > 12) bad("الشهر غير صالح (YYYY-MM)");
  return `${m[1]}-${m[2]}-01`;
}
function dayBefore(d: string): string {
  const dt = new Date(d + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const txt = (v: unknown, max: number) => (v ? String(v).slice(0, max) : null);

async function getSettings() {
  const { data, error } = await supabase.from("finance_settings").select("*").eq("id", 1).single();
  if (error) throw error;
  return data;
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
    if (action === "finance-overview") {
      const [pnl, balances, projects, settings] = await Promise.all([
        supabase.from("v_monthly_pnl").select("*").order("month", { ascending: true }),
        supabase.from("v_partner_balance").select("*").order("partner_id"),
        supabase.from("v_project_profit").select("*"),
        getSettings(),
      ]);
      if (pnl.error) throw pnl.error;
      if (balances.error) throw balances.error;
      if (projects.error) throw projects.error;
      const rows = pnl.data || [];
      const sum = (k: string) => r2(rows.reduce((s: number, r: any) => s + (Number(r[k]) || 0), 0));
      const projs = projects.data || [];
      const completed = projs.filter((p: any) => p.is_completed);
      const warnings: any[] = [];
      for (const p of completed) {
        if (Number(p.cost_gross) === 0) warnings.push({ type: "no_costs", project: p.project_number, message: "مشروع منتهٍ بدون أي تكاليف مسجلة — الربح الظاهر له مبالغ فيه على الأرجح" });
        else if (Number(p.margin_pct) < 0) warnings.push({ type: "negative_margin", project: p.project_number, message: "مشروع بخسارة" });
        if (Number(p.contract_net) === 0) warnings.push({ type: "no_contract_value", project: p.project_number, message: "مشروع منتهٍ بدون قيمة تعاقد" });
      }
      return json({
        ok: true, settings,
        totals: {
          revenue_net: sum("revenue_net"), project_costs_net: sum("project_costs_net"),
          project_profit: sum("project_profit"), expenses_net: sum("expenses_net"), net_profit: sum("net_profit"),
          contract_gross_all: r2(projs.reduce((s: number, p: any) => s + Number(p.contract_gross || 0), 0)),
          collected_all: r2(projs.reduce((s: number, p: any) => s + Number(p.collected || 0), 0)),
          remaining_all: r2(projs.reduce((s: number, p: any) => s + Number(p.remaining || 0), 0)),
          completed_projects: completed.length, total_projects: projs.length,
        },
        monthly: rows, partners: balances.data || [], warnings,
      });
    }

    if (action === "finance-projects") {
      const { data, error } = await supabase.from("v_project_profit").select("*").order("completion_date", { ascending: false });
      if (error) throw error;
      return json({ ok: true, projects: data || [] });
    }

    if (action === "finance-project-detail") {
      if (!body.projectId) bad("projectId required");
      const [profit, costs, payments, flags] = await Promise.all([
        supabase.from("v_project_profit").select("*").eq("project_id", body.projectId).maybeSingle(),
        supabase.from("project_costs").select("*").eq("project_id", body.projectId).order("created_at", { ascending: false }),
        supabase.from("payments").select("*").eq("project_id", body.projectId).order("payment_date", { ascending: false }),
        supabase.from("project_finance_flags").select("*").eq("project_id", body.projectId).maybeSingle(),
      ]);
      for (const r of [profit, costs, payments, flags]) if (r.error) throw r.error;
      if (!profit.data) return json({ error: "project not found" }, 404);
      return json({ ok: true, project: profit.data, costs: costs.data || [], payments: payments.data || [], flags: flags.data || null });
    }

    if (action === "finance-save-project-flags") {
      if (!body.projectId) bad("projectId required");
      const f = body.fields || {};
      const row: Record<string, unknown> = { project_id: body.projectId, updated_at: new Date().toISOString() };
      if ("contract_includes_vat" in f) row.contract_includes_vat = !!f.contract_includes_vat;
      if ("completion_date" in f) row.completion_date = dateOrNull(f.completion_date, "تاريخ الانتهاء");
      if ("notes" in f) row.notes = txt(f.notes, 1000);
      const { data, error } = await supabase.from("project_finance_flags").upsert(row, { onConflict: "project_id" }).select().maybeSingle();
      if (error) throw error;
      await logAudit("update_flags", "project", Number(body.projectId), null, null, row);
      return json({ ok: true, flags: data });
    }

    // ------------------------------------------------------- project costs
    if (action === "finance-add-cost") {
      if (!body.projectId) bad("projectId required");
      const row = {
        project_id: body.projectId, cost_type: String(body.costType || "other").slice(0, 50),
        description: txt(body.description, 500), amount: money(body.amount),
        cost_date: dateOrNull(body.costDate, "تاريخ التكلفة"), supplier: txt(body.supplier, 200),
        tax_treatment: taxOrDefault(body.taxTreatment),
      };
      const { data, error } = await supabase.from("project_costs").insert(row).select().maybeSingle();
      if (error) throw error;
      await logAudit("add_cost", "project", Number(body.projectId), row.cost_type, null, { amount: row.amount, tax_treatment: row.tax_treatment });
      return json({ ok: true, cost: data });
    }

    if (action === "finance-update-cost") {
      if (!body.costId) bad("costId required");
      const f = body.fields || {};
      const update: Record<string, unknown> = {};
      if ("amount" in f) update.amount = money(f.amount);
      if ("cost_type" in f) update.cost_type = String(f.cost_type || "other").slice(0, 50);
      if ("description" in f) update.description = txt(f.description, 500);
      if ("cost_date" in f) update.cost_date = dateOrNull(f.cost_date, "تاريخ التكلفة");
      if ("supplier" in f) update.supplier = txt(f.supplier, 200);
      if ("tax_treatment" in f) update.tax_treatment = taxOrDefault(f.tax_treatment);
      if (!Object.keys(update).length) bad("لا توجد حقول للتعديل");
      const { data: old } = await supabase.from("project_costs").select("project_id, amount, tax_treatment").eq("id", body.costId).maybeSingle();
      const { data, error } = await supabase.from("project_costs").update(update).eq("id", body.costId).select().maybeSingle();
      if (error) throw error;
      if (old) await logAudit("update_cost", "project", old.project_id, null, old, update);
      return json({ ok: true, cost: data });
    }

    // ------------------------------------------------------------- expenses
    if (action === "finance-list-expenses") {
      let q = supabase.from("expenses").select("*").order("expense_date", { ascending: false }).limit(2000);
      if (body.month) {
        const m = monthStart(body.month);
        const next = new Date(m + "T00:00:00Z"); next.setUTCMonth(next.getUTCMonth() + 1);
        q = q.gte("expense_date", m).lt("expense_date", next.toISOString().slice(0, 10));
      }
      if (body.category) q = q.eq("category", body.category);
      const { data, error } = await q;
      if (error) throw error;
      const { data: byCat, error: e2 } = await supabase.from("v_monthly_expenses").select("*").order("month", { ascending: false });
      if (e2) throw e2;
      return json({ ok: true, expenses: data || [], monthlyByCategory: byCat || [] });
    }

    if (action === "finance-add-expense") {
      const row = {
        expense_date: dateOrNull(body.expenseDate) || new Date().toISOString().slice(0, 10),
        category: String(body.category || "other").slice(0, 50),
        description: txt(body.description, 500),
        amount: money(body.amount),
        tax_treatment: body.category === "salary" && !body.taxTreatment ? "none" : taxOrDefault(body.taxTreatment),
        created_by: "admin",
      };
      const { data, error } = await supabase.from("expenses").insert(row).select().maybeSingle();
      if (error) throw error;
      await logAudit("add_expense", "expense", data.id, row.category, null, { amount: row.amount, date: row.expense_date });
      return json({ ok: true, expense: data });
    }

    if (action === "finance-update-expense") {
      if (!body.expenseId) bad("expenseId required");
      const f = body.fields || {};
      const update: Record<string, unknown> = {};
      if ("amount" in f) update.amount = money(f.amount);
      if ("expense_date" in f) update.expense_date = dateOrNull(f.expense_date) || bad("التاريخ مطلوب");
      if ("category" in f) update.category = String(f.category || "other").slice(0, 50);
      if ("description" in f) update.description = txt(f.description, 500);
      if ("tax_treatment" in f) update.tax_treatment = taxOrDefault(f.tax_treatment);
      if (!Object.keys(update).length) bad("لا توجد حقول للتعديل");
      const { data: old } = await supabase.from("expenses").select("amount, expense_date, category").eq("id", body.expenseId).maybeSingle();
      const { data, error } = await supabase.from("expenses").update(update).eq("id", body.expenseId).select().maybeSingle();
      if (error) throw error;
      await logAudit("update_expense", "expense", Number(body.expenseId), old?.category || null, old, update);
      return json({ ok: true, expense: data });
    }

    if (action === "finance-delete-expense") {
      if (!body.expenseId) bad("expenseId required");
      const { data: old } = await supabase.from("expenses").select("amount, expense_date, category").eq("id", body.expenseId).maybeSingle();
      const { error } = await supabase.from("expenses").delete().eq("id", body.expenseId);
      if (error) throw error;
      await logAudit("delete_expense", "expense", Number(body.expenseId), old?.category || null, old, null);
      return json({ ok: true });
    }

    // ----------------------------------------------------------- recurring
    if (action === "finance-list-recurring") {
      const { data, error } = await supabase.from("recurring_expenses").select("*").order("id");
      if (error) throw error;
      return json({ ok: true, recurring: data || [] });
    }

    if (action === "finance-save-recurring") {
      const f = body.fields || {};
      const row: Record<string, unknown> = {};
      if ("category" in f) row.category = String(f.category || "other").slice(0, 50);
      if ("description" in f) row.description = txt(f.description, 500);
      if ("amount" in f) row.amount = money(f.amount, "المبلغ", true);
      if ("tax_treatment" in f) row.tax_treatment = taxOrDefault(f.tax_treatment);
      if ("start_month" in f) row.start_month = monthStart(f.start_month);
      if ("end_month" in f) row.end_month = f.end_month ? monthStart(f.end_month) : null;
      if ("active" in f) row.active = !!f.active;
      if (body.recurringId) {
        const { data, error } = await supabase.from("recurring_expenses").update(row).eq("id", body.recurringId).select().maybeSingle();
        if (error) throw error;
        await logAudit("update_recurring", "recurring_expense", Number(body.recurringId), null, null, row);
        return json({ ok: true, recurring: data });
      }
      if (!("amount" in row)) bad("المبلغ مطلوب");
      if (row.category === "salary" && !("tax_treatment" in f)) row.tax_treatment = "none";
      const { data, error } = await supabase.from("recurring_expenses").insert(row).select().maybeSingle();
      if (error) throw error;
      await logAudit("add_recurring", "recurring_expense", data.id, String(row.category || ""), null, row);
      return json({ ok: true, recurring: data });
    }

    if (action === "finance-delete-recurring") {
      if (!body.recurringId) bad("recurringId required");
      const { error } = await supabase.from("recurring_expenses").delete().eq("id", body.recurringId);
      if (error) throw error;
      await logAudit("delete_recurring", "recurring_expense", Number(body.recurringId), null, null, null);
      return json({ ok: true });
    }

    if (action === "finance-generate-recurring") {
      const m = monthStart(body.month || new Date().toISOString().slice(0, 7));
      const { data, error } = await supabase.rpc("finance_generate_recurring", { p_month: m });
      if (error) throw error;
      await logAudit("generate_recurring", "expense", null, m, null, { created: data });
      return json({ ok: true, month: m, created: data });
    }

    // ------------------------------------------------------------- partners
    if (action === "finance-partners") {
      const today = new Date().toISOString().slice(0, 10);
      const [partners, shares, balances, dists] = await Promise.all([
        supabase.from("partners").select("*").order("id"),
        supabase.from("partner_shares").select("*").order("effective_from", { ascending: false }),
        supabase.from("v_partner_balance").select("*"),
        supabase.from("partner_distributions").select("*").order("distribution_date", { ascending: false }).limit(1000),
      ]);
      for (const r of [partners, shares, balances, dists]) if (r.error) throw r.error;
      const current = (shares.data || []).filter((s: any) => s.effective_from <= today && (!s.effective_to || s.effective_to >= today));
      return json({
        ok: true, partners: partners.data || [], shares: shares.data || [], currentShares: current,
        currentTotalPct: r2(current.reduce((s: number, x: any) => s + Number(x.share_pct), 0)),
        balances: balances.data || [], distributions: dists.data || [],
      });
    }

    if (action === "finance-save-partner") {
      const name = String(body.name || "").trim().slice(0, 100);
      if (body.partnerId) {
        const update: Record<string, unknown> = {};
        if (name) update.name = name;
        if ("active" in body) update.active = !!body.active;
        if ("notes" in body) update.notes = txt(body.notes, 500);
        if (!Object.keys(update).length) bad("لا توجد حقول للتعديل");
        const { data, error } = await supabase.from("partners").update(update).eq("id", body.partnerId).select().maybeSingle();
        if (error) throw error;
        await logAudit("update_partner", "partner", Number(body.partnerId), name || null, null, update);
        return json({ ok: true, partner: data });
      }
      if (!name) bad("اسم الشريك مطلوب");
      const { data, error } = await supabase.from("partners").insert({ name }).select().maybeSingle();
      if (error) throw error;
      await logAudit("add_partner", "partner", data.id, name, null, null);
      return json({ ok: true, partner: data, note: "الشريك الجديد بدون نسبة — اضبط النسب عبر finance-save-shares لتصبح 100%" });
    }

    // يضبط التوزيع الكامل: shares = [{partnerId, sharePct}] + effectiveFrom. لازم المجموع 100.
    // صفوف النسب المفتوحة السابقة بتتقفل اليوم السابق للتاريخ الجديد.
    if (action === "finance-save-shares") {
      const eff = dateOrNull(body.effectiveFrom, "تاريخ سريان النسب") || new Date().toISOString().slice(0, 10);
      const list = Array.isArray(body.shares) ? body.shares : [];
      if (list.length < 1) bad("لازم نسبة واحدة على الأقل");
      const seen = new Set<number>();
      let total = 0;
      for (const s of list) {
        const pid = Number(s.partnerId), pct = Number(s.sharePct);
        if (!pid || seen.has(pid)) bad("شريك مكرر أو غير صالح");
        if (!isFinite(pct) || pct <= 0 || pct > 100) bad("نسبة غير صالحة");
        seen.add(pid); total += pct;
      }
      if (Math.abs(total - 100) > 0.001) bad(`مجموع النسب لازم يساوي 100% (الحالي ${r2(total)}%)`);
      const { data: active } = await supabase.from("partners").select("id").eq("active", true);
      for (const p of active || []) if (!seen.has(p.id)) bad("كل الشركاء النشطين لازم يكون لهم نسبة في التوزيع");
      for (const pid of seen) if (!(active || []).some((p: any) => p.id === pid)) bad("شريك غير نشط أو غير موجود");

      const { data: existing, error: exErr } = await supabase.from("partner_shares").select("*").in("partner_id", [...seen]);
      if (exErr) throw exErr;
      for (const e of existing || []) {
        if (e.effective_from > eff) bad("يوجد توزيع نسب بتاريخ لاحق لهذا التاريخ — اختر تاريخًا أحدث");
      }
      for (const s of list) {
        const pid = Number(s.partnerId), pct = Number(s.sharePct);
        const open = (existing || []).filter((e: any) => e.partner_id === pid && (!e.effective_to || e.effective_to >= eff));
        let handled = false;
        for (const o of open) {
          if (o.effective_from === eff) {
            const { error } = await supabase.from("partner_shares").update({ share_pct: pct, effective_to: null }).eq("id", o.id);
            if (error) throw error;
            handled = true;
          } else {
            const { error } = await supabase.from("partner_shares").update({ effective_to: dayBefore(eff) }).eq("id", o.id);
            if (error) throw error;
          }
        }
        if (!handled) {
          const { error } = await supabase.from("partner_shares").insert({ partner_id: pid, share_pct: pct, effective_from: eff });
          if (error) throw error;
        }
      }
      await logAudit("save_shares", "partner", null, eff, null, { shares: list, effectiveFrom: eff });
      return json({ ok: true, effectiveFrom: eff });
    }

    if (action === "finance-partner-monthly") {
      const { data, error } = await supabase.from("v_partner_monthly").select("*").order("month", { ascending: false }).order("partner_id");
      if (error) throw error;
      return json({ ok: true, rows: data || [] });
    }

    if (action === "finance-add-distribution") {
      if (!body.partnerId) bad("partnerId required");
      const kind = String(body.kind || "profit");
      if (!["profit", "draw", "advance"].includes(kind)) bad("نوع التوزيع غير صالح");
      const row = {
        partner_id: body.partnerId, amount: money(body.amount),
        distribution_date: dateOrNull(body.distributionDate) || new Date().toISOString().slice(0, 10),
        kind, notes: txt(body.notes, 500),
      };
      const { data, error } = await supabase.from("partner_distributions").insert(row).select().maybeSingle();
      if (error) throw error;
      await logAudit("add_distribution", "partner", Number(body.partnerId), kind, null, { amount: row.amount, date: row.distribution_date });
      return json({ ok: true, distribution: data });
    }

    if (action === "finance-delete-distribution") {
      if (!body.distributionId) bad("distributionId required");
      const { data: old } = await supabase.from("partner_distributions").select("partner_id, amount, distribution_date").eq("id", body.distributionId).maybeSingle();
      const { error } = await supabase.from("partner_distributions").delete().eq("id", body.distributionId);
      if (error) throw error;
      if (old) await logAudit("delete_distribution", "partner", old.partner_id, null, old, null);
      return json({ ok: true });
    }

    // ------------------------------------------------------------------ VAT
    if (action === "finance-vat-report") {
      const { data, error } = await supabase.from("v_vat_monthly").select("*").order("month", { ascending: false });
      if (error) throw error;
      return json({
        ok: true, months: data || [],
        note: "تقدير: ضريبة المخرجات محسوبة من الدفعات المحصّلة، وضريبة المدخلات من التكاليف والمصاريف القابلة للاسترداد. يُطابَق مع الإقرار الفعلي لهيئة الزكاة والضريبة.",
      });
    }

    // ------------------------------------------------------------- settings
    if (action === "finance-get-settings") {
      return json({ ok: true, settings: await getSettings() });
    }
    if (action === "finance-update-settings") {
      const f = body.fields || {};
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if ("vat_rate" in f) {
        const v = Number(f.vat_rate);
        if (!isFinite(v) || v < 0 || v > 100) bad("نسبة الضريبة غير صالحة");
        update.vat_rate = v;
      }
      if ("reserve_pct" in f) {
        const v = Number(f.reserve_pct);
        if (!isFinite(v) || v < 0 || v >= 100) bad("نسبة الاحتياطي غير صالحة");
        update.reserve_pct = v;
      }
      if ("completed_statuses" in f) {
        if (!Array.isArray(f.completed_statuses) || !f.completed_statuses.length) bad("حالات الانتهاء غير صالحة");
        update.completed_statuses = f.completed_statuses.map((x: unknown) => String(x).slice(0, 50));
      }
      const old = await getSettings();
      const { data, error } = await supabase.from("finance_settings").update(update).eq("id", 1).select().maybeSingle();
      if (error) throw error;
      await logAudit("update_settings", "finance_settings", 1, null, old, update);
      return json({ ok: true, settings: data });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
