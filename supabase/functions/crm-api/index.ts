// HoloulEnergy — crm-api Edge Function
//
// Companion function to `compute-quote`. It does NOT implement its own
// login — it verifies the SAME signed session tokens issued by
// `compute-quote`'s "rep-login" / "admin-login" actions (HMAC-SHA256,
// signed with the SESSION_SECRET project secret already configured for
// this project). The frontend logs in against compute-quote first, then
// sends that token here for every CRM action.
//
// This file intentionally never touches compute-quote / index.ts — the
// pricing engine stays completely untouched.

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
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
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

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function checkAdminToken(token: string | undefined): Promise<boolean> {
  const payload = await readToken(token);
  if (!payload || payload.sub !== "admin") return false;
  const { data, error } = await supabase.from("admin_secret").select("session_version").eq("id", 1).single();
  if (error || !data) return false;
  return payload.ver === data.session_version;
}

async function checkRepToken(token: string | undefined): Promise<{ username: string; displayName: string } | null> {
  const payload = await readToken(token);
  if (!payload || !payload.sub.startsWith("rep:")) return null;
  const username = payload.sub.slice(4);
  const { data, error } = await supabase.from("reps")
    .select("username, display_name, active, session_version").eq("username", username).single();
  if (error || !data || !data.active) return null;
  if (payload.ver !== data.session_version) return null;
  return { username: data.username, displayName: data.display_name };
}

async function authenticate(body: any): Promise<{ isAdmin: boolean; rep: { username: string; displayName: string } | null } | null> {
  if (body.adminToken) {
    const ok = await checkAdminToken(body.adminToken);
    if (ok) return { isAdmin: true, rep: null };
  }
  if (body.token) {
    const rep = await checkRepToken(body.token);
    if (rep) return { isAdmin: false, rep };
  }
  return null;
}

// Normalizes any phone number the reps/CRM might type into the single
// canonical Saudi local-dialing format used everywhere in this app:
// a leading "0" followed by the 9-digit subscriber number (e.g.
// "0561274344"). Accepts input with or without a "+966"/"966"/"00966"
// country-code prefix, with or without the leading 0, with spaces,
// dashes, etc. — all collapse to the same key so the SAME customer is
// always matched/deduped regardless of how the number was typed.
// IMPORTANT: this must stay byte-for-byte in sync with the phoneKey()
// in compute-quote/index.ts — both functions write into the shared
// `customers`/`quotes` tables and MUST normalize identically, or the
// same customer ends up as two different rows.
function phoneKey(raw: string) {
  let digits = (raw || "").replace(/\D/g, "");
  if (digits.startsWith("00966")) digits = digits.slice(5);
  else if (digits.startsWith("966") && digits.length > 9) digits = digits.slice(3);
  if (digits.length === 9) digits = "0" + digits;
  return digits;
}

async function customerIdsMatching(search: string): Promise<number[]> {
  if (!search) return [];
  const { data } = await supabase.from("customers").select("id")
    .or(`phone.ilike.%${search}%,name.ilike.%${search}%`).limit(100);
  return (data || []).map((c: any) => c.id);
}

async function logAudit(
  auth: { isAdmin: boolean; rep: { username: string; displayName: string } | null },
  actionType: string, entityType: string, entityId: number | null, entityLabel: string | null,
  oldValue: unknown, newValue: unknown,
) {
  try {
    await supabase.from("audit_log").insert({
      actor: auth.isAdmin ? "admin" : (auth.rep ? auth.rep.username : "unknown"),
      actor_role: auth.isAdmin ? "admin" : "rep",
      action_type: actionType, entity_type: entityType, entity_id: entityId, entity_label: entityLabel,
      old_value: oldValue ?? null, new_value: newValue ?? null,
    });
  } catch { /* never break the primary action over a logging failure */ }
}

// ---------------------------------------------------------------------
// ZATCA-style "simplified tax invoice" QR payload (Base64-encoded TLV):
// tag 1 = seller name, 2 = VAT number, 3 = timestamp, 4 = invoice total
// (incl. VAT), 5 = VAT total. This is the standard 5-field simplified
// e-invoice QR content used for retail/walk-in sales in Saudi Arabia.
// Note: this produces a compliant-looking QR for a printed/PDF invoice;
// it does NOT submit the invoice to ZATCA's Fatoora platform (that needs
// a separate ZATCA integration/CSID, which is outside this function).
// ---------------------------------------------------------------------
const SELLER_NAME = "حلول الطاقة المتجددة والمقاولات - HoloulEnergy";
const SELLER_VAT_NUMBER = "311386341200003";
const SELLER_CR_NUMBER = "7037810988";
const SELLER_NATIONAL_ADDRESS = "RDMC8001";

function tlvField(tag: number, value: string): Uint8Array {
  const valueBytes = new TextEncoder().encode(value);
  const out = new Uint8Array(2 + valueBytes.length);
  out[0] = tag;
  out[1] = valueBytes.length;
  out.set(valueBytes, 2);
  return out;
}
function buildZatcaQrBase64(sellerName: string, vatNumber: string, timestampIso: string, total: number, vatAmount: number): string {
  const fields = [
    tlvField(1, sellerName),
    tlvField(2, vatNumber),
    tlvField(3, timestampIso),
    tlvField(4, total.toFixed(2)),
    tlvField(5, vatAmount.toFixed(2)),
  ];
  const totalLen = fields.reduce((s, f) => s + f.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const f of fields) { out.set(f, offset); offset += f.length; }
  let bin = "";
  out.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

// ---------------------------------------------------------------------
// Product catalog + ready-made packages, sourced from pricing_config.
// pricing_config also holds the full pricing ENGINE (margins, markups,
// formulas) which must never reach the client — these two helpers pick
// out only the customer-facing name/code/price fields.
// ---------------------------------------------------------------------
function flattenProductCatalog(raw: any): Array<{ code: string; name: string; category: string; unitPrice: number; unitPriceVat: number }> {
  const out: Array<{ code: string; name: string; category: string; unitPrice: number; unitPriceVat: number }> = [];
  if (!Array.isArray(raw)) return out;
  for (const block of raw) {
    const category = block?.category || "";
    const rows: any[] = Array.isArray(block?.rows) ? block.rows : [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const code = String(row[0] ?? "").trim();
      if (!code) continue;
      // Convention across every category block: the last two columns are
      // ["السعر", "السعر شامل الضريبة"] (price excl. VAT, price incl. VAT).
      const priceExcl = parseFloat(String(row[row.length - 2] ?? "").replace(/,/g, ""));
      const priceIncl = parseFloat(String(row[row.length - 1] ?? "").replace(/,/g, ""));
      if (!isFinite(priceExcl) || priceExcl <= 0) continue; // skip rows with no price yet (not orderable)
      out.push({ code, name: code, category, unitPrice: priceExcl, unitPriceVat: isFinite(priceIncl) ? priceIncl : priceExcl * 1.15 });
    }
  }
  return out;
}

function flattenReadyPackages(raw: any): Array<{ id: string; name: string; price: number; components: string[] }> {
  const out: Array<{ id: string; name: string; price: number; components: string[] }> = [];
  if (!Array.isArray(raw)) return out;
  for (const p of raw) {
    if (!p || p.status === "غير متوفر") continue;
    const components: string[] = [];
    if (p.panelCount) components.push(`${p.panelCount}× لوح شمسي ${p.panelBrand || ""} ${p.panelPowerW ? p.panelPowerW + " وات" : ""}`.trim());
    if (p.inverterModel) components.push(`انفرتر ${p.inverterBrand || ""} ${p.inverterModel}${p.inverterPowerW ? " — قدرة " + p.inverterPowerW + " وات" : ""}`.trim());
    if (p.batteryModel) components.push(`${p.batteryCount || 1}× بطارية ${p.batteryType || ""} ${p.batteryModel}${p.batteryUnitCapacity ? " (" + p.batteryUnitCapacity + " " + (p.batteryCapacityUnit || "kWh") + ")" : ""}`.trim());
    if (p.acType && p.acType !== "لا يوجد") components.push(`تكييف: ${p.acType}${p.acCountDay ? " — " + p.acCountDay + " وحدة نهارًا" : ""}`);
    if (p.fridgeCount) components.push(`${p.fridgeCount}× ثلاجة (${p.fridgeHours || 24} ساعة تشغيل)`);
    if (p.lampCount) components.push(`${p.lampCount}× لمبة إضاءة ${p.lampPowerW ? p.lampPowerW + " وات" : ""}`.trim());
    if (p.otherDevices) components.push(p.otherDevices);
    if (p.cables) components.push(`الكابلات: ${p.cables}`);
    out.push({ id: String(p.id), name: p.name || `باكدج ${p.id}`, price: Number(p.priceSar) || 0, components });
  }
  return out;
}

// Solar panels live in their own list (pricing_config.panels — brand/power/
// priceW, shaped for the quote-calculator engine), completely separate from
// productCatalog. Without this, panels would never show up as an addable
// invoice product even though they're the core product this company sells.
// Only visible, priced panels are exposed, one catalog row per panel model,
// using the SAME per-watt margin the public quote calculator uses
// (pricing_config.panelMarginPerWatt) so the invoice price matches what a
// customer would be quoted for that same panel elsewhere in the app.
function flattenPanelsAsProducts(panels: any, marginPerWatt: number): Array<{ code: string; name: string; category: string; unitPrice: number; unitPriceVat: number }> {
  const out: Array<{ code: string; name: string; category: string; unitPrice: number; unitPriceVat: number }> = [];
  if (!Array.isArray(panels)) return out;
  for (const p of panels) {
    if (!p || p.visible === false || !p.priceW) continue;
    const code = `PANEL-${p.brand}-${p.power}W`;
    const unitPrice = Math.round((Number(p.priceW) + (Number(marginPerWatt) || 0)) * Number(p.power) * 100) / 100;
    if (!isFinite(unitPrice) || unitPrice <= 0) continue;
    out.push({
      code, name: `لوح شمسي ${p.brand} ${p.power}W`, category: "ألواح الطاقة الشمسية",
      unitPrice, unitPriceVat: Math.round(unitPrice * 1.15 * 100) / 100,
    });
  }
  return out;
}

// ---------------------------------------------------------------------
// Invoice numbering: HEWDS + date (YYYYMMDD) + daily sequence.
// HEWDS = HoloulEnergy Wadi Dawaser Solar (the issuing branch code).
// The sequence resets every day and is shared by both invoice flows
// (project-linked invoices and walk-in POS invoices) so numbers stay
// globally sequential per day across the whole business, with no gaps
// or collisions between the two flows.
// ---------------------------------------------------------------------
const INVOICE_PREFIX = "HEWDS";
async function generateInvoiceNumber(): Promise<string> {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const datePart = `${y}${m}${d}`;
  const prefix = `${INVOICE_PREFIX}${datePart}-`;
  const { count } = await supabase.from("invoices").select("id", { count: "exact", head: true })
    .like("invoice_number", `${prefix}%`);
  return `${prefix}${String((count || 0) + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------
// Structured reference numbers (agreed naming scheme):
//   PROJ-{mobile}-{SCOPE}-{TYPE}-{MMMYYY}-{spec...}   e.g. PROJ-0561274344-INS-OFG-AUG2026
//   GC-{mobile}-{itemCount}-{MMMYYY}                  (MMMYYY = warranty START month)
//   QL-{DDMonYYYY}-{SCOPE}-{TYPE}-{spec...}-{mobile}
// On a genuine collision (identical string already exists), append the
// issue time (HHmm) — never a running counter — so numbers stay short in
// the overwhelming common case.
// ---------------------------------------------------------------------
const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function mobileForId(raw: string | null | undefined): string {
  const digits = (raw || "").replace(/\D/g, "");
  return digits || "0000000000";
}
function monthYearTag(d: Date): string {
  return `${MONTH_ABBR[d.getMonth()]}${d.getFullYear()}`.toUpperCase();
}
function dayMonthYearTag(d: Date): string {
  return `${String(d.getDate()).padStart(2, "0")}${MONTH_ABBR[d.getMonth()]}${d.getFullYear()}`;
}
function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
}
async function codeFor(listKey: "idSystemTypes" | "idScopeTypes", value: string | null | undefined, fallback: string): Promise<string> {
  if (!value) return fallback;
  const { data: settingsRow } = await supabase.from("crm_settings").select("data").eq("id", 1).maybeSingle();
  const list = settingsRow?.data?.[listKey];
  const match = Array.isArray(list) ? list.find((x: any) => x.value === value) : null;
  return match?.code || fallback;
}
async function ensureUniqueRefNumber(table: string, column: string, base: string, now: Date): Promise<string> {
  const { data: existing } = await supabase.from(table).select("id").eq(column, base).maybeSingle();
  if (!existing) return base;
  return `${base}-${hhmm(now)}`;
}

async function generateProjectNumber(
  mobile: string, scopeType: string | null, systemType: string | null,
  spec: { inverterSpec?: string | null; panelSpec?: string | null; structureType?: string | null } = {},
): Promise<string> {
  const now = new Date();
  const scopeCode = await codeFor("idScopeTypes", scopeType, "LUM");
  const typeCode = await codeFor("idSystemTypes", systemType, "OFG");
  const parts = [`PROJ-${mobileForId(mobile)}`, scopeCode, typeCode, monthYearTag(now)];
  if (spec.inverterSpec) parts.push(spec.inverterSpec.toUpperCase().replace(/\s+/g, ""));
  if (spec.panelSpec) parts.push(spec.panelSpec.toUpperCase().replace(/\s+/g, ""));
  if (spec.structureType) parts.push(spec.structureType.toUpperCase().replace(/\s+/g, ""));
  const base = parts.join("-");
  return ensureUniqueRefNumber("projects", "project_number", base, now);
}

// GC = Guarantee Certificate (renamed from the earlier "WC"/"CG" working names).
// Composed from mobile + how many products the certificate covers + the
// WARRANTY'S START month/year (not the date it happened to be saved/printed)
// — a single-asset certificate always covers exactly 1 item.
async function generateCertificateNumber(mobile: string, itemCount: number, warrantyStartDate: string | Date): Promise<string> {
  const now = new Date();
  const startDate = typeof warrantyStartDate === "string" ? new Date(warrantyStartDate + "T00:00:00") : warrantyStartDate;
  const base = `GC-${mobileForId(mobile)}-${Math.max(1, itemCount)}-${monthYearTag(startDate)}`;
  return ensureUniqueRefNumber("assets", "warranty_number", base, now);
}

// Group certificates cover several already-registered assets in one printed
// document; there's no single DB row to key uniqueness off, so this is
// deterministic (same customer + same item count + same warranty-start month
// always reproduces the same number on reprint) rather than collision-checked.
function buildGroupCertificateNumber(mobile: string, itemCount: number, warrantyStartDate: string | Date): string {
  const startDate = typeof warrantyStartDate === "string" ? new Date(warrantyStartDate + "T00:00:00") : warrantyStartDate;
  return `GC-${mobileForId(mobile)}-${Math.max(1, itemCount)}-${monthYearTag(startDate)}`;
}

async function generateQuoteReference(mobile: string, scopeType: string | null, systemType: string | null, spec: {
  capacityKw?: number | null; inverterSpec?: string | null;
  panelSpec?: string | null; structureType?: string | null;
}): Promise<string> {
  const now = new Date();
  const scopeCode = await codeFor("idScopeTypes", scopeType, "LUM");
  const typeCode = await codeFor("idSystemTypes", systemType, "PKG");
  const parts = [`QL-${dayMonthYearTag(now)}`, scopeCode, typeCode];
  if (spec.capacityKw) parts.push(`${spec.capacityKw}KW`);
  if (systemType === "pump") {
    if (spec.inverterSpec) parts.push(spec.inverterSpec.toUpperCase().replace(/\s+/g, ""));
    if (spec.panelSpec) parts.push(spec.panelSpec.toUpperCase().replace(/\s+/g, ""));
    if (spec.structureType) parts.push(spec.structureType.toUpperCase().replace(/\s+/g, ""));
  }
  parts.push(mobileForId(mobile));
  const base = parts.join("-");
  return ensureUniqueRefNumber("quotations", "ql_reference", base, now);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  const action = body.action;
  const auth = await authenticate(body);
  if (!auth) return json({ error: "الجلسة منتهية، الرجاء تسجيل الدخول مجددًا" }, 401);

  try {
    if (action === "admin-crm-list-customers") {
      let q = supabase.from("customers")
        .select("id, name, phone, rep_username, quotes_count, first_quote_at, last_quote_at, " +
          "status, price_feedback, blocker_reason, blocker_notes, next_follow_up_date, last_contact_at, " +
          "assigned_rep, priority, lost_reason_detail, city, opportunities(id, stage)")
        .order("last_quote_at", { ascending: false, nullsFirst: false }).limit(1000);
      if (body.status) q = q.eq("status", body.status);
      if (body.assignedRep) q = q.eq("assigned_rep", body.assignedRep);
      if (body.search) q = q.or(`name.ilike.%${body.search}%,phone.ilike.%${body.search}%`);
      const today = new Date().toISOString().slice(0, 10);
      if (body.followUpDue === "overdue") q = q.lt("next_follow_up_date", today);
      if (body.followUpDue === "today") q = q.eq("next_follow_up_date", today);
      const { data, error } = await q;
      if (error) throw error;
      return json({ ok: true, customers: data || [] });
    }

    if (action === "admin-crm-customer-detail") {
      if (!body.customerId) return json({ error: "customerId required" }, 400);
      const { data: customer, error: cErr } = await supabase.from("customers").select("*").eq("id", body.customerId).maybeSingle();
      if (cErr) throw cErr;
      if (!customer) return json({ error: "customer not found" }, 404);
      const { data: quotes, error: qErr } = await supabase.from("quotes")
        .select("id, rep_display_name, hp, final_total, created_at, snapshot")
        .eq("customer_id", body.customerId).order("created_at", { ascending: false });
      if (qErr) throw qErr;
      const { data: interactions, error: iErr } = await supabase.from("crm_interactions")
        .select("*").eq("customer_id", body.customerId).order("created_at", { ascending: false });
      if (iErr) throw iErr;
      const { data: contacts, error: ctErr } = await supabase.from("contacts")
        .select("*").eq("customer_id", body.customerId).order("created_at", { ascending: false });
      if (ctErr) throw ctErr;
      const { data: sites, error: siErr } = await supabase.from("sites")
        .select("*").eq("customer_id", body.customerId).order("created_at", { ascending: false });
      if (siErr) throw siErr;
      const { data: opportunities, error: opErr } = await supabase.from("opportunities")
        .select("*").eq("customer_id", body.customerId).order("created_at", { ascending: false });
      if (opErr) throw opErr;
      const { data: assets, error: asErr } = await supabase.from("assets")
        .select("*").eq("customer_id", body.customerId).order("created_at", { ascending: false });
      if (asErr) throw asErr;
      return json({ ok: true, customer, quotes: quotes || [], interactions: interactions || [], contacts: contacts || [], sites: sites || [], opportunities: opportunities || [], assets: assets || [] });
    }

    if (action === "admin-crm-update") {
      if (!body.customerId) return json({ error: "customerId required" }, 400);
      const allowed = ["name", "phone", "city", "status", "price_feedback", "blocker_reason",
        "blocker_notes", "next_follow_up_date", "assigned_rep", "priority", "lost_reason_detail",
        "customer_type", "classification", "commercial_registration", "vat_number", "unified_number", "region", "lead_source"];
      const update: Record<string, unknown> = {};
      for (const k of allowed) if (body.fields && k in body.fields) update[k] = body.fields[k];
      if ("phone" in update) update.phone = phoneKey(String(update.phone || ""));
      update.updated_at = new Date().toISOString();
      const { data, error } = await supabase.from("customers").update(update).eq("id", body.customerId).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, customer: data });
    }

    if (action === "admin-crm-add-interaction") {
      if (!body.customerId) return json({ error: "customerId required" }, 400);
      const repUsername = auth.rep ? auth.rep.username : "admin";
      const { data, error } = await supabase.from("crm_interactions").insert({
        customer_id: body.customerId,
        rep_username: repUsername,
        interaction_type: body.interactionType || "call",
        note: body.note || null,
        outcome: body.outcome || null,
        status_after: body.statusAfter || null,
      }).select().maybeSingle();
      if (error) throw error;
      await supabase.from("customers")
        .update({ last_contact_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", body.customerId);
      return json({ ok: true, interaction: data });
    }

    if (action === "admin-crm-create-customer") {
      const phone = phoneKey(body.phone);
      if (!phone) return json({ error: "phone required" }, 400);
      const { data, error } = await supabase.from("customers").insert({
        name: body.name || "", phone,
        assigned_rep: body.assignedRep || (auth.rep ? auth.rep.displayName : null),
        city: body.city || null,
        rep_username: auth.rep ? auth.rep.username : null,
        quotes_count: 0,
      }).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, customer: data });
    }

    if (action === "admin-crm-stats") {
      const { data: customers, error } = await supabase.from("customers")
        .select("id, status, price_feedback, blocker_reason, priority, next_follow_up_date");
      if (error) throw error;
      const { data: quotes, error: qe } = await supabase.from("quotes").select("customer_id, final_total");
      if (qe) throw qe;

      const today = new Date().toISOString().slice(0, 10);
      const statusCounts: Record<string, number> = {};
      const blockerCounts: Record<string, number> = {};
      const priceFeedbackCounts: Record<string, number> = {};
      let overdue = 0, dueToday = 0;
      for (const c of customers || []) {
        statusCounts[c.status] = (statusCounts[c.status] || 0) + 1;
        if (c.blocker_reason) blockerCounts[c.blocker_reason] = (blockerCounts[c.blocker_reason] || 0) + 1;
        if (c.price_feedback) priceFeedbackCounts[c.price_feedback] = (priceFeedbackCounts[c.price_feedback] || 0) + 1;
        if (c.next_follow_up_date) {
          if (c.next_follow_up_date < today && c.status !== "won" && c.status !== "lost") overdue++;
          if (c.next_follow_up_date === today) dueToday++;
        }
      }
      const bestByCustomer: Record<string, number> = {};
      for (const qt of quotes || []) {
        if (!qt.customer_id) continue;
        bestByCustomer[qt.customer_id] = Math.max(bestByCustomer[qt.customer_id] || 0, Number(qt.final_total) || 0);
      }
      let wonSum = 0, wonN = 0, lostSum = 0, lostN = 0;
      for (const c of customers || []) {
        const v = bestByCustomer[c.id];
        if (v == null) continue;
        if (c.status === "won") { wonSum += v; wonN++; }
        if (c.status === "lost") { lostSum += v; lostN++; }
      }
      const totalLeads = (customers || []).length;
      const won = statusCounts["won"] || 0;
      return json({
        ok: true,
        totalLeads, statusCounts, blockerCounts, priceFeedbackCounts,
        overdueFollowUps: overdue, dueToday,
        conversionRate: totalLeads ? (won / totalLeads) * 100 : 0,
        avgWonValue: wonN ? Math.round(wonSum / wonN) : 0,
        avgLostValue: lostN ? Math.round(lostSum / lostN) : 0,
        wonCount: won, lostCount: statusCounts["lost"] || 0,
      });
    }

    if (action === "admin-crm-settings") {
      const { data, error } = await supabase.from("crm_settings").select("data").eq("id", 1).maybeSingle();
      if (error) throw error;
      return json({ ok: true, settings: data ? data.data : {} });
    }

    if (action === "admin-crm-update-settings") {
      if (!auth.isAdmin) return json({ error: "الإعدادات متاحة للأدمن بس" }, 403);
      if (!body.settings || typeof body.settings !== "object") return json({ error: "settings required" }, 400);
      const { data, error } = await supabase.from("crm_settings")
        .update({ data: body.settings, updated_at: new Date().toISOString() }).eq("id", 1).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, settings: data.data });
    }

    if (action === "admin-crm-delete-customer") {
      if (!auth.isAdmin) return json({ error: "حذف العملاء متاح للأدمن بس" }, 403);
      if (!body.customerId) return json({ error: "customerId required" }, 400);
      const { data: current } = await supabase.from("customers").select("name, phone").eq("id", body.customerId).maybeSingle();
      await supabase.from("crm_interactions").delete().eq("customer_id", body.customerId);
      const { error } = await supabase.from("customers").delete().eq("id", body.customerId);
      if (error) throw error;
      await logAudit(auth, "delete", "customer", Number(body.customerId), current ? (current.name || current.phone) : null, null, null);
      return json({ ok: true });
    }

    if (action === "admin-crm-add-contact") {
      if (!body.customerId) return json({ error: "customerId required" }, 400);
      if (!body.name) return json({ error: "name required" }, 400);
      const { data, error } = await supabase.from("contacts").insert({
        customer_id: body.customerId, name: body.name, position: body.position || null,
        mobile: body.mobile || null, whatsapp: body.whatsapp || null, email: body.email || null,
        preferred_contact_method: body.preferredContactMethod || null,
        decision_power: body.decisionPower || null, notes: body.notes || null,
      }).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, contact: data });
    }

    if (action === "admin-crm-update-contact") {
      if (!body.contactId) return json({ error: "contactId required" }, 400);
      const allowed = ["name", "position", "mobile", "whatsapp", "email", "preferred_contact_method", "decision_power", "notes"];
      const update: Record<string, unknown> = {};
      for (const k of allowed) if (body.fields && k in body.fields) update[k] = body.fields[k];
      update.updated_at = new Date().toISOString();
      const { data, error } = await supabase.from("contacts").update(update).eq("id", body.contactId).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, contact: data });
    }

    if (action === "admin-crm-delete-contact") {
      if (!body.contactId) return json({ error: "contactId required" }, 400);
      const { error } = await supabase.from("contacts").delete().eq("id", body.contactId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "admin-crm-add-site") {
      if (!body.customerId) return json({ error: "customerId required" }, 400);
      if (!body.name) return json({ error: "name required" }, 400);
      const siteFields = [
        "region", "city", "location_address", "gps_lat", "gps_lng", "google_maps_link",
        "farm_area", "agricultural_activity", "number_of_wells", "number_of_pumps",
        "water_source", "well_depth", "required_water_flow", "required_operating_hours",
        "current_energy_source", "diesel_consumption", "electricity_consumption",
        "existing_system", "technical_notes",
      ];
      const row: Record<string, unknown> = { customer_id: body.customerId, name: body.name };
      for (const k of siteFields) if (body.fields && k in body.fields) row[k] = body.fields[k];
      const { data, error } = await supabase.from("sites").insert(row).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, site: data });
    }

    if (action === "admin-crm-update-site") {
      if (!body.siteId) return json({ error: "siteId required" }, 400);
      const siteFields = [
        "name", "region", "city", "location_address", "gps_lat", "gps_lng", "google_maps_link",
        "farm_area", "agricultural_activity", "number_of_wells", "number_of_pumps",
        "water_source", "well_depth", "required_water_flow", "required_operating_hours",
        "current_energy_source", "diesel_consumption", "electricity_consumption",
        "existing_system", "technical_notes",
      ];
      const update: Record<string, unknown> = {};
      for (const k of siteFields) if (body.fields && k in body.fields) update[k] = body.fields[k];
      update.updated_at = new Date().toISOString();
      const { data, error } = await supabase.from("sites").update(update).eq("id", body.siteId).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, site: data });
    }

    if (action === "admin-crm-delete-site") {
      if (!body.siteId) return json({ error: "siteId required" }, 400);
      const { error } = await supabase.from("sites").delete().eq("id", body.siteId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "admin-crm-list-sites") {
      let q = supabase.from("sites")
        .select("id, customer_id, name, region, location_address, technical_notes, created_at, customers(name, phone)")
        .order("created_at", { ascending: false }).limit(1000);
      if (body.region) q = q.eq("region", body.region);
      const { data, error } = await q;
      if (error) throw error;
      return json({ ok: true, sites: data || [] });
    }

    if (action === "admin-crm-list-opportunities") {
      let q = supabase.from("opportunities")
        .select("*, customers(id, name, phone), sites(id, name), contacts(id, name)")
        .order("stage_changed_at", { ascending: false }).limit(1000);
      if (body.stage) q = q.eq("stage", body.stage);
      if (body.customerId) q = q.eq("customer_id", body.customerId);
      if (body.salesPerson) q = q.eq("sales_person", body.salesPerson);
      const { data, error } = await q;
      if (error) throw error;
      return json({ ok: true, opportunities: data || [] });
    }

    if (action === "admin-crm-opportunity-detail") {
      if (!body.opportunityId) return json({ error: "opportunityId required" }, 400);
      const { data: opportunity, error: oErr } = await supabase.from("opportunities")
        .select("*, customers(id, name, phone), sites(id, name), contacts(id, name)")
        .eq("id", body.opportunityId).maybeSingle();
      if (oErr) throw oErr;
      if (!opportunity) return json({ error: "opportunity not found" }, 404);
      const { data: activities, error: aErr } = await supabase.from("activities")
        .select("*").eq("opportunity_id", body.opportunityId).order("created_at", { ascending: false });
      if (aErr) throw aErr;
      const { data: survey, error: svErr } = await supabase.from("site_surveys")
        .select("*").eq("opportunity_id", body.opportunityId).maybeSingle();
      if (svErr) throw svErr;
      const { data: study, error: stErr } = await supabase.from("technical_studies")
        .select("*, quotes(id, final_total, hp, created_at)").eq("opportunity_id", body.opportunityId).maybeSingle();
      if (stErr) throw stErr;
      const { data: customerQuotes, error: cqErr } = await supabase.from("quotes")
        .select("id, hp, final_total, created_at").eq("customer_id", opportunity.customer_id).order("created_at", { ascending: false });
      if (cqErr) throw cqErr;
      return json({ ok: true, opportunity, activities: activities || [], survey: survey || null, study: study || null, customerQuotes: customerQuotes || [] });
    }

    if (action === "admin-crm-add-opportunity") {
      if (!body.customerId) return json({ error: "customerId required" }, 400);
      if (!body.name) return json({ error: "name required" }, 400);
      const oppFields = [
        "site_id", "contact_id", "project_type", "estimated_capacity", "estimated_value",
        "expected_cost", "probability", "expected_closing_date", "sales_person", "notes",
        "next_action", "next_follow_up_date",
      ];
      const row: Record<string, unknown> = {
        customer_id: body.customerId, name: body.name,
        sales_person: auth.rep ? auth.rep.displayName : (body.salesPerson || null),
      };
      for (const k of oppFields) if (body.fields && k in body.fields) row[k] = body.fields[k];
      const { data, error } = await supabase.from("opportunities").insert(row).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, opportunity: data });
    }

    if (action === "admin-crm-update-opportunity") {
      if (!body.opportunityId) return json({ error: "opportunityId required" }, 400);
      const oppFields = [
        "name", "site_id", "contact_id", "project_type", "stage", "estimated_capacity",
        "estimated_value", "expected_cost", "probability", "expected_closing_date",
        "sales_person", "competitor_name", "competitor_price", "lost_reason",
        "next_action", "next_follow_up_date", "notes",
      ];
      const update: Record<string, unknown> = {};
      for (const k of oppFields) if (body.fields && k in body.fields) update[k] = body.fields[k];
      let stageChanged = false, oldStage: string | null = null;
      if (update.stage) {
        const { data: current } = await supabase.from("opportunities").select("stage, name").eq("id", body.opportunityId).maybeSingle();
        if (current && current.stage !== update.stage) {
          update.stage_changed_at = new Date().toISOString();
          stageChanged = true; oldStage = current.stage;
        }
      }
      update.updated_at = new Date().toISOString();
      const { data, error } = await supabase.from("opportunities").update(update).eq("id", body.opportunityId).select().maybeSingle();
      if (error) throw error;
      if (stageChanged && data) {
        await logAudit(auth, "stage_change", "opportunity", data.id, data.name, { stage: oldStage }, { stage: data.stage });
      }
      return json({ ok: true, opportunity: data });
    }

    if (action === "admin-crm-delete-opportunity") {
      if (!auth.isAdmin) return json({ error: "حذف الصفقات متاح للأدمن بس" }, 403);
      if (!body.opportunityId) return json({ error: "opportunityId required" }, 400);
      const { data: opp } = await supabase.from("opportunities").select("name").eq("id", body.opportunityId).maybeSingle();
      const { error } = await supabase.from("opportunities").delete().eq("id", body.opportunityId);
      if (error) throw error;
      await logAudit(auth, "delete", "opportunity", Number(body.opportunityId), opp?.name || null, null, null);
      return json({ ok: true });
    }

    if (action === "admin-crm-add-activity") {
      if (!body.opportunityId || !body.customerId) return json({ error: "opportunityId and customerId required" }, 400);
      const repUsername = auth.rep ? auth.rep.username : "admin";
      const { data, error } = await supabase.from("activities").insert({
        opportunity_id: body.opportunityId, customer_id: body.customerId,
        activity_type: body.activityType || "call",
        description: body.description || null, result: body.result || null,
        next_action: body.nextAction || null, next_follow_up_date: body.nextFollowUpDate || null,
        rep_username: repUsername,
      }).select().maybeSingle();
      if (error) throw error;
      const oppUpdate: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (body.nextAction) oppUpdate.next_action = body.nextAction;
      if (body.nextFollowUpDate) oppUpdate.next_follow_up_date = body.nextFollowUpDate;
      await supabase.from("opportunities").update(oppUpdate).eq("id", body.opportunityId);
      return json({ ok: true, activity: data });
    }

    if (action === "admin-crm-pipeline-stats") {
      const { data: opps, error } = await supabase.from("opportunities")
        .select("stage, estimated_value, probability, next_follow_up_date, lost_reason, project_type");
      if (error) throw error;
      const today = new Date().toISOString().slice(0, 10);
      const stageCounts: Record<string, number> = {};
      const stageValue: Record<string, number> = {};
      const lostReasonCounts: Record<string, number> = {};
      const projectTypeCounts: Record<string, number> = {};
      let pipelineValue = 0, wonValue = 0, lostValue = 0, wonCount = 0, lostCount = 0, overdue = 0;
      for (const o of opps || []) {
        stageCounts[o.stage] = (stageCounts[o.stage] || 0) + 1;
        const val = Number(o.estimated_value) || 0;
        stageValue[o.stage] = (stageValue[o.stage] || 0) + val;
        if (o.project_type) projectTypeCounts[o.project_type] = (projectTypeCounts[o.project_type] || 0) + 1;
        if (o.stage === "won") { wonValue += val; wonCount++; }
        else if (o.stage === "lost") {
          lostValue += val; lostCount++;
          if (o.lost_reason) lostReasonCounts[o.lost_reason] = (lostReasonCounts[o.lost_reason] || 0) + 1;
        } else {
          pipelineValue += val;
          if (o.next_follow_up_date && o.next_follow_up_date < today) overdue++;
        }
      }
      const total = (opps || []).length;
      return json({
        ok: true, totalOpportunities: total, stageCounts, stageValue, lostReasonCounts, projectTypeCounts,
        pipelineValue, wonValue, lostValue, wonCount, lostCount, overdueFollowUps: overdue,
        conversionRate: (wonCount + lostCount) ? (wonCount / (wonCount + lostCount)) * 100 : 0,
        avgDealValue: wonCount ? Math.round(wonValue / wonCount) : 0,
      });
    }

    // -----------------------------------------------------------------
    // Warranty years: reps can set up to the standard factory term for the
    // asset type freely. Anything ABOVE that standard term is an exceptional
    // increase that only takes effect after an admin approves it — until
    // then the asset keeps whatever warranty_years/end_date it already had.
    // Admins can always set any value directly, no approval needed.
    // -----------------------------------------------------------------
    async function resolveWarrantyIncrease(assetType: string, requestedYears: number | null): Promise<Record<string, unknown>> {
      if (requestedYears == null || !isFinite(requestedYears)) return {};
      if (auth.isAdmin) {
        return { warranty_years: requestedYears, warranty_years_requested: null, warranty_request_status: "none", warranty_requested_by: null };
      }
      const { data: settingsRow } = await supabase.from("crm_settings").select("data").eq("id", 1).maybeSingle();
      const standard = settingsRow?.data?.standardWarranties?.[assetType]?.defectYears;
      if (standard == null || requestedYears <= Number(standard)) {
        return { warranty_years: requestedYears, warranty_years_requested: null, warranty_request_status: "none", warranty_requested_by: null };
      }
      // exceeds the standard term — hold as a pending request, don't touch the active warranty_years yet
      return {
        warranty_years_requested: requestedYears,
        warranty_request_status: "pending",
        warranty_requested_by: auth.rep ? auth.rep.username : null,
      };
    }

async function maybeAssignWarrantyNumber(
  target: Record<string, unknown>, customerId: number | null | undefined, opportunityId: number | null | undefined,
  existingNumber: string | null | undefined, effectiveStart: unknown, effectiveYears: unknown,
): Promise<void> {
  if (existingNumber) return; // already issued — keep it stable across edits/reprints
  if (!effectiveStart || !effectiveYears) return;
  const { data: cust } = await supabase.from("customers").select("phone").eq("id", customerId).maybeSingle();
  target.warranty_number = await generateCertificateNumber(cust?.phone || "", 1, effectiveStart as string);
}

    if (action === "admin-crm-add-asset") {
      if (!body.customerId) return json({ error: "customerId required" }, 400);
      const assetFields = [
        "site_id", "opportunity_id", "asset_type", "manufacturer", "model", "serial_number",
        "capacity", "quantity", "location_note", "installation_date",
        "warranty_start_date", "warranty_end_date",
        "performance_warranty_years", "performance_warranty_end_date",
        "status", "notes",
      ];
      const row: Record<string, unknown> = { customer_id: body.customerId };
      for (const k of assetFields) if (body.fields && k in body.fields) row[k] = body.fields[k];
      const requestedYears = body.fields && body.fields.warranty_years != null && body.fields.warranty_years !== ""
        ? Number(body.fields.warranty_years) : null;
      Object.assign(row, await resolveWarrantyIncrease(String(row.asset_type || ""), requestedYears));
      await maybeAssignWarrantyNumber(row, Number(body.customerId), (row.opportunity_id as number) || null, null, row.warranty_start_date, row.warranty_years);
      const { data, error } = await supabase.from("assets").insert(row).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, asset: data });
    }

    if (action === "admin-crm-update-asset") {
      if (!body.assetId) return json({ error: "assetId required" }, 400);
      const assetFields = [
        "site_id", "opportunity_id", "asset_type", "manufacturer", "model", "serial_number",
        "capacity", "quantity", "location_note", "installation_date",
        "warranty_start_date", "warranty_end_date",
        "performance_warranty_years", "performance_warranty_end_date",
        "status", "notes",
      ];
      const update: Record<string, unknown> = {};
      for (const k of assetFields) if (body.fields && k in body.fields) update[k] = body.fields[k];
      const { data: current } = await supabase.from("assets")
        .select("asset_type, customer_id, opportunity_id, warranty_number, warranty_start_date, warranty_years")
        .eq("id", body.assetId).maybeSingle();
      const effectiveAssetType = (update.asset_type as string | undefined) || current?.asset_type || "";
      const requestedYears = body.fields && body.fields.warranty_years != null && body.fields.warranty_years !== ""
        ? Number(body.fields.warranty_years) : null;
      Object.assign(update, await resolveWarrantyIncrease(effectiveAssetType, requestedYears));
      const finalOppId = (update.opportunity_id !== undefined ? update.opportunity_id : current?.opportunity_id) as number | null;
      const finalStart = update.warranty_start_date !== undefined ? update.warranty_start_date : current?.warranty_start_date;
      const finalYears = "warranty_years" in update ? update.warranty_years : current?.warranty_years;
      await maybeAssignWarrantyNumber(update, current?.customer_id, finalOppId, current?.warranty_number, finalStart, finalYears);
      update.updated_at = new Date().toISOString();
      const { data, error } = await supabase.from("assets").update(update).eq("id", body.assetId).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, asset: data });
    }

    if (action === "crm-generate-group-cert-number") {
      if (!body.customerId || !Array.isArray(body.assetIds) || !body.assetIds.length) {
        return json({ error: "customerId and assetIds required" }, 400);
      }
      const { data: cust } = await supabase.from("customers").select("phone").eq("id", body.customerId).maybeSingle();
      const { data: selectedAssets } = await supabase.from("assets").select("warranty_start_date").in("id", body.assetIds);
      const startDates = (selectedAssets || []).map((a: any) => a.warranty_start_date).filter(Boolean).sort();
      const earliestStart = startDates[0] || new Date().toISOString().slice(0, 10);
      const reference = buildGroupCertificateNumber(cust?.phone || "", body.assetIds.length, earliestStart);
      return json({ ok: true, reference });
    }

    if (action === "crm-approve-warranty-increase" || action === "crm-reject-warranty-increase") {
      if (!auth.isAdmin) return json({ error: "اعتماد زيادة الضمان متاح للأدمن بس" }, 403);
      if (!body.assetId) return json({ error: "assetId required" }, 400);
      const { data: asset, error: aErr } = await supabase.from("assets")
        .select("warranty_start_date, warranty_years_requested, warranty_request_status, model, serial_number, customer_id, opportunity_id, warranty_number")
        .eq("id", body.assetId).maybeSingle();
      if (aErr) throw aErr;
      if (!asset || asset.warranty_request_status !== "pending") return json({ error: "مفيش طلب زيادة ضمان معلّق على المنتج ده" }, 400);

      if (action === "crm-reject-warranty-increase") {
        const { data, error } = await supabase.from("assets").update({
          warranty_years_requested: null, warranty_request_status: "rejected",
          warranty_approved_by: "admin", warranty_approved_at: new Date().toISOString(),
        }).eq("id", body.assetId).select().maybeSingle();
        if (error) throw error;
        await logAudit(auth, "reject_warranty_increase", "asset", data.id, asset.model || asset.serial_number || null, null, null);
        return json({ ok: true, asset: data });
      }

      const years = Number(asset.warranty_years_requested);
      let endDate: string | null = null;
      if (asset.warranty_start_date && years) {
        const d = new Date(asset.warranty_start_date + "T00:00:00");
        const whole = Math.floor(years);
        const fracMonths = Math.round((years - whole) * 12);
        d.setFullYear(d.getFullYear() + whole);
        d.setMonth(d.getMonth() + fracMonths);
        endDate = d.toISOString().slice(0, 10);
      }
      const approvalUpdate: Record<string, unknown> = {
        warranty_years: years, warranty_end_date: endDate,
        warranty_years_requested: null, warranty_request_status: "approved",
        warranty_approved_by: "admin", warranty_approved_at: new Date().toISOString(),
      };
      await maybeAssignWarrantyNumber(approvalUpdate, asset.customer_id, asset.opportunity_id, asset.warranty_number, asset.warranty_start_date, years);
      const { data, error } = await supabase.from("assets").update(approvalUpdate).eq("id", body.assetId).select().maybeSingle();
      if (error) throw error;
      await logAudit(auth, "approve_warranty_increase", "asset", data.id, asset.model || asset.serial_number || null, null, { warranty_years: years });
      return json({ ok: true, asset: data });
    }

    if (action === "admin-crm-delete-asset") {
      if (!body.assetId) return json({ error: "assetId required" }, 400);
      const { error } = await supabase.from("assets").delete().eq("id", body.assetId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "admin-crm-list-assets") {
      let q = supabase.from("assets")
        .select("*, customers(id, name, phone)")
        .order("warranty_end_date", { ascending: true, nullsFirst: false }).limit(1000);
      if (body.customerId) q = q.eq("customer_id", body.customerId);
      if (body.search) {
        const custIds = await customerIdsMatching(body.search);
        const orParts = [`serial_number.ilike.%${body.search}%`, `model.ilike.%${body.search}%`, `manufacturer.ilike.%${body.search}%`];
        if (custIds.length) orParts.push(`customer_id.in.(${custIds.join(",")})`);
        q = q.or(orParts.join(","));
      }
      const { data, error } = await q;
      if (error) throw error;
      return json({ ok: true, assets: data || [] });
    }

    if (action === "admin-crm-warranty-stats") {
      const { data: assets, error } = await supabase.from("assets")
        .select("id, warranty_end_date, status");
      if (error) throw error;
      const today = new Date();
      const in30 = new Date(today.getTime() + 30 * 86400000).toISOString().slice(0, 10);
      const in60 = new Date(today.getTime() + 60 * 86400000).toISOString().slice(0, 10);
      const todayStr = today.toISOString().slice(0, 10);
      let active = 0, expiring30 = 0, expiring60 = 0, expired = 0, noWarranty = 0;
      for (const a of assets || []) {
        if (!a.warranty_end_date) { noWarranty++; continue; }
        if (a.warranty_end_date < todayStr) expired++;
        else if (a.warranty_end_date <= in30) expiring30++;
        else if (a.warranty_end_date <= in60) expiring60++;
        else active++;
      }
      return json({ ok: true, total: (assets || []).length, active, expiring30, expiring60, expired, noWarranty });
    }

    if (action === "admin-crm-save-site-survey") {
      if (!body.opportunityId) return json({ error: "opportunityId required" }, 400);
      const surveyFields = [
        "site_id", "engineer_name", "survey_date", "gps_lat", "gps_lng",
        "pump_type", "pump_manufacturer", "pump_model", "pump_hp", "pump_kw",
        "flow", "head", "well_depth", "static_water_level", "dynamic_water_level",
        "motor_manufacturer", "motor_model", "motor_hp", "motor_kw", "motor_voltage",
        "motor_current", "motor_frequency", "motor_rpm", "motor_power_factor", "motor_efficiency",
        "existing_diesel_generator", "generator_capacity", "diesel_consumption",
        "electricity_grid", "electricity_tariff", "existing_solar",
        "hours_per_day", "days_per_month", "seasonal_operation", "required_water_production",
        "available_area", "roof_or_ground", "shading", "orientation", "tilt",
        "soil", "access", "distance", "cable_length", "technical_notes",
      ];
      const { data: opp, error: oppErr } = await supabase.from("opportunities").select("customer_id").eq("id", body.opportunityId).maybeSingle();
      if (oppErr) throw oppErr;
      if (!opp) return json({ error: "opportunity not found" }, 404);
      const row: Record<string, unknown> = { opportunity_id: body.opportunityId, customer_id: opp.customer_id, updated_at: new Date().toISOString() };
      for (const k of surveyFields) if (body.fields && k in body.fields) row[k] = body.fields[k];
      const { data, error } = await supabase.from("site_surveys")
        .upsert(row, { onConflict: "opportunity_id" }).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, survey: data });
    }

    if (action === "admin-crm-save-technical-study") {
      if (!body.opportunityId) return json({ error: "opportunityId required" }, 400);
      const studyFields = [
        "site_survey_id", "quote_id", "pv_capacity", "number_of_panels", "panel_model", "panel_wattage",
        "inverter", "inverter_capacity", "pump", "vfd", "structure",
        "dc_cables", "ac_cables", "protection", "combiner_boxes", "monitoring",
        "expected_production", "expected_operating_hours",
        "estimated_diesel_saving", "estimated_electricity_saving",
        "capex", "opex", "estimated_roi", "payback_period", "notes",
      ];
      const row: Record<string, unknown> = { opportunity_id: body.opportunityId, updated_at: new Date().toISOString() };
      for (const k of studyFields) if (body.fields && k in body.fields) row[k] = body.fields[k];
      const { data, error } = await supabase.from("technical_studies")
        .upsert(row, { onConflict: "opportunity_id" }).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, study: data });
    }

    function stripCostFields(q: any) {
      if (auth.isAdmin || !q) return q;
      const { cost, gross_profit, gross_margin, ...rest } = q;
      return rest;
    }

    if (action === "admin-crm-list-quotations") {
      if (!body.opportunityId) return json({ error: "opportunityId required" }, 400);
      const { data, error } = await supabase.from("quotations")
        .select("*").eq("opportunity_id", body.opportunityId).order("version", { ascending: false });
      if (error) throw error;
      return json({ ok: true, quotations: (data || []).map(stripCostFields) });
    }

    if (action === "admin-crm-create-quotation-version") {
      if (!body.opportunityId) return json({ error: "opportunityId required" }, 400);
      const { data: opp, error: oppErr } = await supabase.from("opportunities")
        .select("customer_id, customers(phone)").eq("id", body.opportunityId).maybeSingle();
      if (oppErr) throw oppErr;
      if (!opp) return json({ error: "opportunity not found" }, 404);

      const { data: existing, error: exErr } = await supabase.from("quotations")
        .select("quotation_number, version").eq("opportunity_id", body.opportunityId)
        .order("version", { ascending: false }).limit(1);
      if (exErr) throw exErr;

      let quotationNumber: string, version: number;
      if (existing && existing.length) {
        quotationNumber = existing[0].quotation_number;
        version = existing[0].version + 1;
      } else {
        const year = new Date().getFullYear();
        const { count } = await supabase.from("quotations").select("id", { count: "exact", head: true })
          .like("quotation_number", `Q-${year}-%`);
        quotationNumber = `Q-${year}-${String((count || 0) + 1).padStart(3, "0")}`;
        version = 1;
      }

      const items = Array.isArray(body.items) ? body.items : [];
      let subtotal = 0;
      for (const it of items) {
        const lineTotal = (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0) - (Number(it.discount) || 0);
        subtotal += lineTotal;
      }
      const discountTotal = Number(body.discountTotal) || 0;
      subtotal = Math.max(0, subtotal - discountTotal);
      const vatPercent = body.vatPercent != null ? Number(body.vatPercent) : 15;
      const vatAmount = subtotal * (vatPercent / 100);
      const total = subtotal + vatAmount;
      const cost = body.cost != null && body.cost !== "" ? Number(body.cost) : null;
      const grossProfit = cost != null ? subtotal - cost : null;
      const grossMargin = cost != null && subtotal > 0 ? (grossProfit! / subtotal) * 100 : null;

      const mobile = (opp as any).customers?.phone || "";
      const scopeType = body.scopeType || null;
      const idSystemType = body.idSystemType || null;
      const pumpHp = body.pumpHp != null && body.pumpHp !== "" ? Number(body.pumpHp) : null;
      const capacityKw = body.capacityKw != null && body.capacityKw !== "" ? Number(body.capacityKw) : null;
      const qlReference = await generateQuoteReference(mobile, scopeType, idSystemType, {
        capacityKw, inverterSpec: body.inverterSpec || null, panelSpec: body.panelSpec || null, structureType: body.structureType || null,
      });

      const row = {
        opportunity_id: body.opportunityId, customer_id: opp.customer_id,
        quotation_number: quotationNumber, version,
        ql_reference: qlReference,
        scope_type: scopeType, id_system_type: idSystemType, pump_hp: pumpHp, capacity_kw: capacityKw,
        inverter_spec: body.inverterSpec || null, panel_spec: body.panelSpec || null, structure_type: body.structureType || null,
        linked_quote_id: body.linkedQuoteId || null,
        valid_until: body.validUntil || null,
        sales_person: body.salesPerson || (auth.rep ? auth.rep.displayName : null),
        engineer: body.engineer || null,
        items, discount_total: discountTotal, vat_percent: vatPercent,
        subtotal, vat_amount: vatAmount, total,
        cost, gross_profit: grossProfit, gross_margin: grossMargin,
        status: body.status || "draft", notes: body.notes || null,
        created_by: auth.rep ? auth.rep.username : "admin",
      };
      const { data, error } = await supabase.from("quotations").insert(row).select().maybeSingle();
      if (error) throw error;
      await logAudit(auth, "create_version", "quotation", data.id, `${quotationNumber} v${version}`, null, { total: data.total, status: data.status });
      return json({ ok: true, quotation: stripCostFields(data) });
    }

    if (action === "admin-crm-update-quotation-status") {
      if (!body.quotationId) return json({ error: "quotationId required" }, 400);
      const { data: current } = await supabase.from("quotations").select("status, quotation_number, version").eq("id", body.quotationId).maybeSingle();
      const { data, error } = await supabase.from("quotations")
        .update({ status: body.status, updated_at: new Date().toISOString() })
        .eq("id", body.quotationId).select().maybeSingle();
      if (error) throw error;
      if (current && data) {
        await logAudit(auth, "status_change", "quotation", data.id, `${current.quotation_number} v${current.version}`, { status: current.status }, { status: data.status });
      }
      return json({ ok: true, quotation: stripCostFields(data) });
    }

    if (action === "admin-crm-delete-quotation") {
      if (!auth.isAdmin) return json({ error: "حذف عروض الأسعار متاح للأدمن بس" }, 403);
      if (!body.quotationId) return json({ error: "quotationId required" }, 400);
      const { data: current } = await supabase.from("quotations").select("quotation_number, version").eq("id", body.quotationId).maybeSingle();
      const { error } = await supabase.from("quotations").delete().eq("id", body.quotationId);
      if (error) throw error;
      await logAudit(auth, "delete", "quotation", Number(body.quotationId), current ? `${current.quotation_number} v${current.version}` : null, null, null);
      return json({ ok: true });
    }

    function stripProjectCostFields(p: any) {
      if (auth.isAdmin || !p) return p;
      const { total_cost, gross_profit, gross_margin, costs, ...rest } = p;
      return rest;
    }

    if (action === "admin-crm-create-project") {
      if (!body.opportunityId) return json({ error: "opportunityId required" }, 400);
      const { data: opp, error: oppErr } = await supabase.from("opportunities")
        .select("customer_id, site_id, estimated_value, customers(phone)").eq("id", body.opportunityId).maybeSingle();
      if (oppErr) throw oppErr;
      if (!opp) return json({ error: "opportunity not found" }, 404);
      const projFields = [
        "contract_value", "scope_type", "id_system_type", "contract_signed_date", "project_manager", "engineer",
        "planned_supply_date", "actual_supply_date", "planned_install_date", "actual_install_date",
        "status", "notes",
      ];
      const row: Record<string, unknown> = {
        opportunity_id: body.opportunityId, customer_id: opp.customer_id, site_id: opp.site_id,
        contract_value: opp.estimated_value || null,
      };
      for (const k of projFields) if (body.fields && k in body.fields) row[k] = body.fields[k];

      // Auto-copy the technical spec from the winning quotation so PROJ carries
      // the same inverter/panel/structure info that was quoted to the customer.
      const { data: acceptedQ } = await supabase.from("quotations")
        .select("inverter_spec, panel_spec, structure_type")
        .eq("opportunity_id", body.opportunityId).eq("status", "accepted")
        .order("version", { ascending: false }).limit(1).maybeSingle();
      if (acceptedQ) {
        row.inverter_spec = acceptedQ.inverter_spec;
        row.panel_spec = acceptedQ.panel_spec;
        row.structure_type = acceptedQ.structure_type;
      }

      const mobile = (opp as any).customers?.phone || "";
      row.project_number = await generateProjectNumber(mobile, row.scope_type as string, row.id_system_type as string, {
        inverterSpec: row.inverter_spec as string, panelSpec: row.panel_spec as string, structureType: row.structure_type as string,
      });
      const { data, error } = await supabase.from("projects").insert(row).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, project: stripProjectCostFields(data) });
    }

    if (action === "admin-crm-update-project") {
      if (!body.projectId) return json({ error: "projectId required" }, 400);
      const projFields = [
        "contract_value", "scope_type", "id_system_type", "contract_signed_date", "project_manager", "engineer",
        "planned_supply_date", "actual_supply_date", "planned_install_date", "actual_install_date",
        "status", "notes",
      ];
      const { data: current } = await supabase.from("projects").select("status, contract_value, project_number").eq("id", body.projectId).maybeSingle();
      const update: Record<string, unknown> = {};
      for (const k of projFields) if (body.fields && k in body.fields) update[k] = body.fields[k];
      update.updated_at = new Date().toISOString();
      const { data, error } = await supabase.from("projects").update(update).eq("id", body.projectId).select().maybeSingle();
      if (error) throw error;
      if (current && data && (current.status !== data.status || Number(current.contract_value) !== Number(data.contract_value))) {
        await logAudit(auth, "update", "project", data.id, current.project_number,
          { status: current.status, contract_value: current.contract_value },
          { status: data.status, contract_value: data.contract_value });
      }
      return json({ ok: true, project: stripProjectCostFields(data) });
    }

    if (action === "admin-crm-project-by-opportunity") {
      if (!body.opportunityId) return json({ error: "opportunityId required" }, 400);
      const { data: project, error } = await supabase.from("projects").select("*").eq("opportunity_id", body.opportunityId).maybeSingle();
      if (error) throw error;
      if (!project) return json({ ok: true, project: null });
      return await buildProjectDetail(project);
    }

    if (action === "admin-crm-project-detail") {
      if (!body.projectId) return json({ error: "projectId required" }, 400);
      const { data: project, error } = await supabase.from("projects").select("*").eq("id", body.projectId).maybeSingle();
      if (error) throw error;
      if (!project) return json({ error: "project not found" }, 404);
      return await buildProjectDetail(project);
    }

    async function buildProjectDetail(project: any) {
      const { data: costs, error: cErr } = await supabase.from("project_costs").select("*").eq("project_id", project.id).order("created_at", { ascending: false });
      if (cErr) throw cErr;
      const { data: payments, error: pErr } = await supabase.from("payments").select("*").eq("project_id", project.id).order("payment_date", { ascending: false });
      if (pErr) throw pErr;
      const { data: milestones, error: mErr } = await supabase.from("payment_milestones").select("*").eq("project_id", project.id).order("due_date", { ascending: true, nullsFirst: false });
      if (mErr) throw mErr;
      const totalCost = (costs || []).reduce((s: number, c: any) => s + (Number(c.amount) || 0), 0);
      const collected = (payments || []).reduce((s: number, p: any) => s + (Number(p.amount) || 0), 0);
      const contractValue = Number(project.contract_value) || 0;
      const grossProfit = contractValue - totalCost;
      const grossMargin = contractValue > 0 ? (grossProfit / contractValue) * 100 : 0;
      const result: any = {
        ok: true,
        project: stripProjectCostFields({ ...project, total_cost: totalCost, gross_profit: grossProfit, gross_margin: grossMargin }),
        payments: payments || [], remaining: contractValue - collected, collected,
        milestones: milestones || [],
      };
      if (auth.isAdmin) result.costs = costs || [];
      return json(result);
    }

    if (action === "admin-crm-add-milestone") {
      if (!body.projectId) return json({ error: "projectId required" }, 400);
      if (!body.title) return json({ error: "title required" }, 400);
      const { data: proj } = await supabase.from("projects").select("contract_value").eq("id", body.projectId).maybeSingle();
      const contractValue = Number(proj?.contract_value) || 0;
      let amount = body.amount != null && body.amount !== "" ? Number(body.amount) : null;
      const percentage = body.percentage != null && body.percentage !== "" ? Number(body.percentage) : null;
      if (amount == null && percentage != null) amount = Math.round(contractValue * (percentage / 100));
      const { data, error } = await supabase.from("payment_milestones").insert({
        project_id: body.projectId, title: body.title, percentage, amount,
        due_date: body.dueDate || null, notes: body.notes || null,
      }).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, milestone: data });
    }

    if (action === "admin-crm-update-milestone") {
      if (!body.milestoneId) return json({ error: "milestoneId required" }, 400);
      const { data: current } = await supabase.from("payment_milestones").select("status, title, project_id").eq("id", body.milestoneId).maybeSingle();
      const fields = ["title", "percentage", "amount", "due_date", "status", "notes"];
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const k of fields) if (body.fields && k in body.fields) update[k] = body.fields[k];
      const { data, error } = await supabase.from("payment_milestones").update(update).eq("id", body.milestoneId).select().maybeSingle();
      if (error) throw error;
      if (current && data && current.status !== data.status) {
        await logAudit(auth, "status_change", "payment_milestone", data.id, current.title, { status: current.status }, { status: data.status });
      }
      return json({ ok: true, milestone: data });
    }

    if (action === "admin-crm-delete-milestone") {
      if (!body.milestoneId) return json({ error: "milestoneId required" }, 400);
      const { error } = await supabase.from("payment_milestones").delete().eq("id", body.milestoneId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "admin-crm-list-invoices") {
      if (!body.projectId) return json({ error: "projectId required" }, 400);
      const { data, error } = await supabase.from("invoices")
        .select("*").eq("project_id", body.projectId).order("created_at", { ascending: false });
      if (error) throw error;
      return json({ ok: true, invoices: data || [] });
    }

    if (action === "admin-crm-create-invoice") {
      if (!body.projectId) return json({ error: "projectId required" }, 400);
      const { data: proj, error: projErr } = await supabase.from("projects")
        .select("customer_id, customers(name, phone, vat_number, commercial_registration)")
        .eq("id", body.projectId).maybeSingle();
      if (projErr) throw projErr;
      if (!proj) return json({ error: "project not found" }, 404);
      const cust: any = (proj as any).customers || {};

      const invoiceNumber = await generateInvoiceNumber();

      const items = Array.isArray(body.items) ? body.items : [];
      let subtotal = 0;
      for (const it of items) {
        subtotal += (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0) - (Number(it.discount) || 0);
      }
      const discountTotal = Number(body.discountTotal) || 0;
      subtotal = Math.max(0, subtotal - discountTotal);
      const vatPercent = body.vatPercent != null ? Number(body.vatPercent) : 15;
      const vatAmount = subtotal * (vatPercent / 100);
      const total = subtotal + vatAmount;

      const row = {
        project_id: body.projectId, customer_id: proj.customer_id,
        milestone_id: body.milestoneId || null,
        invoice_number: invoiceNumber,
        due_date: body.dueDate || null,
        customer_name: cust.name || null, customer_phone: cust.phone || null,
        customer_vat_number: cust.vat_number || null, customer_cr_number: cust.commercial_registration || null,
        items, discount_total: discountTotal, vat_percent: vatPercent,
        subtotal, vat_amount: vatAmount, total,
        status: body.status || "draft", notes: body.notes || null,
        created_by: auth.rep ? auth.rep.username : "admin",
      };
      const { data, error } = await supabase.from("invoices").insert(row).select().maybeSingle();
      if (error) throw error;
      await logAudit(auth, "create", "invoice", data.id, invoiceNumber, null, { total: data.total, status: data.status });
      return json({ ok: true, invoice: data });
    }

    if (action === "admin-crm-update-invoice-status") {
      if (!body.invoiceId) return json({ error: "invoiceId required" }, 400);
      const { data: current } = await supabase.from("invoices").select("status, invoice_number").eq("id", body.invoiceId).maybeSingle();
      const { data, error } = await supabase.from("invoices")
        .update({ status: body.status, updated_at: new Date().toISOString() })
        .eq("id", body.invoiceId).select().maybeSingle();
      if (error) throw error;
      if (current && data) {
        await logAudit(auth, "status_change", "invoice", data.id, current.invoice_number, { status: current.status }, { status: data.status });
      }
      return json({ ok: true, invoice: data });
    }

    if (action === "admin-crm-delete-invoice") {
      if (!auth.isAdmin) return json({ error: "حذف الفواتير متاح للأدمن بس" }, 403);
      if (!body.invoiceId) return json({ error: "invoiceId required" }, 400);
      const { data: current } = await supabase.from("invoices").select("invoice_number").eq("id", body.invoiceId).maybeSingle();
      const { error } = await supabase.from("invoices").delete().eq("id", body.invoiceId);
      if (error) throw error;
      await logAudit(auth, "delete", "invoice", Number(body.invoiceId), current?.invoice_number || null, null, null);
      return json({ ok: true });
    }

    // -----------------------------------------------------------------
    // Product catalog + ready-made packages for the invoice item picker.
    // Available to both reps and admins (sale prices only — no cost/margin
    // fields from pricing_config ever leave this function).
    // -----------------------------------------------------------------
    if (action === "crm-list-catalog") {
      const { data: pc, error } = await supabase.from("pricing_config").select("data").limit(1).maybeSingle();
      if (error) throw error;
      const products = [
        ...flattenPanelsAsProducts(pc?.data?.panels, pc?.data?.panelMarginPerWatt),
        ...flattenProductCatalog(pc?.data?.productCatalog),
      ];
      const packages = flattenReadyPackages(pc?.data?.readyOffgridSystems);
      return json({ ok: true, products, packages });
    }

    // -----------------------------------------------------------------
    // Walk-in / point-of-sale invoices — a standalone invoice for an
    // ALREADY-REGISTERED customer only (no create-on-the-fly here — the
    // customer must exist in the customers table first, via the CRM's
    // own customer registration). Line items must either:
    //   (a) come from the live product catalog / ready-made packages
    //       (validated by code against pricing_config server-side), or
    //   (b) be pulled directly from one of the customer's own existing
    //       quotations (supply-only / installation-only / lump-sum) via
    //       `quotationId` — those items are re-fetched from the
    //       quotations table here, never trusted from the client, so
    //       they can't be tampered with in transit.
    // Does NOT require an opportunity or a project. Used for over-the-
    // counter sales that are paid in full immediately.
    //
    // Reps can create these, but the invoice is NOT print-ready until an
    // admin approves it (approval_status). Admin-created invoices are
    // auto-approved. Deleting an invoice remains admin-only (shared with
    // admin-crm-delete-invoice above).
    // -----------------------------------------------------------------
    if (action === "crm-list-customer-quotations") {
      if (!body.customerId) return json({ error: "customerId required" }, 400);
      const { data, error } = await supabase.from("quotations")
        .select("id, quotation_number, version, scope_type, status, items, subtotal, vat_amount, total, created_at")
        .eq("customer_id", body.customerId).order("created_at", { ascending: false });
      if (error) throw error;
      return json({ ok: true, quotations: data || [] });
    }

    if (action === "crm-create-pos-invoice") {
      const rawItems = Array.isArray(body.items) ? body.items : [];

      // --- Customer must already be registered — no create-on-the-fly. ---
      let customer: any = null;
      if (body.customerId) {
        const { data, error: findErr } = await supabase.from("customers")
          .select("id, name, phone, city, vat_number, commercial_registration").eq("id", body.customerId).maybeSingle();
        if (findErr) throw findErr;
        customer = data;
      } else {
        const phone = phoneKey(body.customerPhone || "");
        if (!phone) return json({ error: "اختر عميل مسجّل مسبقًا لإصدار الفاتورة" }, 400);
        const { data, error: findErr } = await supabase.from("customers")
          .select("id, name, phone, city, vat_number, commercial_registration").eq("phone", phone).maybeSingle();
        if (findErr) throw findErr;
        customer = data;
      }
      if (!customer) {
        return json({ error: "العميل غير مسجّل في النظام — سجّله أولًا من شاشة العملاء قبل إصدار فاتورة له" }, 400);
      }
      const customerId: number = customer.id;
      {
        const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if (body.customerCity && !customer.city) patch.city = body.customerCity;
        if (body.customerVatNumber && !customer.vat_number) patch.vat_number = body.customerVatNumber;
        if (body.customerCrNumber && !customer.commercial_registration) patch.commercial_registration = body.customerCrNumber;
        if (Object.keys(patch).length > 1) await supabase.from("customers").update(patch).eq("id", customerId);
      }

      // --- Optional: pull items straight from one of the customer's own
      // quotations, fetched fresh from the DB (never trust client-sent
      // copies of these items). ---
      let quotationItems: any[] = [];
      let sourceQuotationId: number | null = null;
      if (body.quotationId) {
        const { data: quo, error: quoErr } = await supabase.from("quotations")
          .select("id, customer_id, quotation_number, items").eq("id", body.quotationId).maybeSingle();
        if (quoErr) throw quoErr;
        if (!quo || Number(quo.customer_id) !== Number(customerId)) {
          return json({ error: "عرض السعر المحدد غير مرتبط بهذا العميل" }, 400);
        }
        sourceQuotationId = quo.id;
        quotationItems = (Array.isArray(quo.items) ? quo.items : []).map((it: any) => {
          const qty = Number(it.quantity) || 0;
          const unitPrice = Number(it.unitPrice) || 0;
          const discount = Number(it.discount) || 0;
          return {
            type: "quotation", code: null,
            name: String(it.description || `بند من عرض السعر ${quo.quotation_number}`).slice(0, 300),
            qty, unitPrice, discount, lineTotal: qty * unitPrice - discount,
          };
        });
      }

      if (!rawItems.length && !quotationItems.length) {
        return json({ error: "لازم صنف واحد على الأقل — من المنتجات/الباكدجات، أو من عرض سعر للعميل" }, 400);
      }

      // --- Any manually-added items (not sourced from a quotation) must
      // reference a real, currently-available catalog product code or
      // ready-made package id — this is enforced here, not just in the UI. ---
      const { data: pc } = await supabase.from("pricing_config").select("data").limit(1).maybeSingle();
      const catalogProducts = [
        ...flattenPanelsAsProducts(pc?.data?.panels, pc?.data?.panelMarginPerWatt),
        ...flattenProductCatalog(pc?.data?.productCatalog),
      ];
      const catalogPackages = flattenReadyPackages(pc?.data?.readyOffgridSystems);
      const productCodeSet = new Set(catalogProducts.map((p) => p.code));
      const packageIdSet = new Set(catalogPackages.map((p) => String(p.id)));

      let subtotal = 0;
      const cleanItems = rawItems.map((it: any) => {
        const type = it.type === "package" ? "package" : "product";
        const code = String(it.code || "").slice(0, 100);
        if (type === "package") {
          if (it.custom) {
            // Customer-specific one-off bundle: not in the shared packages
            // catalog, but every line inside it must still be a real,
            // currently-available catalog product — re-validated here.
            const comps = Array.isArray(it.components) ? it.components : [];
            if (!comps.length) throw new Error(`الباكدج "${it.name || "مخصص"}" لازم يحتوي على صنف واحد على الأقل من الكتالوج`);
            for (const c of comps) {
              const ccode = String(c?.code || "").trim();
              if (!ccode || !productCodeSet.has(ccode)) {
                throw new Error(`الصنف "${c?.name || ccode || "بدون كود"}" داخل باكدج "${it.name || "مخصص"}" غير موجود في كتالوج المنتجات`);
              }
            }
          } else {
            const pkgId = code.replace(/^PKG-/, "");
            if (!packageIdSet.has(pkgId)) throw new Error(`الباكدج "${it.name || code}" غير متاح حاليًا في كتالوج الباكدجات`);
          }
        } else {
          if (!productCodeSet.has(code)) throw new Error(`الصنف "${code || it.name}" غير موجود في كتالوج المنتجات — اختاره من القائمة`);
        }
        const qty = Number(it.qty ?? it.quantity) || 0;
        const unitPrice = Number(it.unitPrice) || 0;
        const discount = Number(it.discount) || 0;
        const lineTotal = qty * unitPrice - discount;
        subtotal += lineTotal;
        const cleanItem: Record<string, unknown> = {
          type, code,
          name: String(it.name || "").slice(0, 300),
          qty, unitPrice, discount, lineTotal,
        };
        if (type === "package" && it.custom) {
          cleanItem.custom = true;
          cleanItem.components = (Array.isArray(it.components) ? it.components : []).slice(0, 30).map((c: any) => ({
            code: String(c?.code || "").slice(0, 100),
            name: String(c?.name || "").slice(0, 300),
            qty: Number(c?.qty) || 0,
            unitPrice: Number(c?.unitPrice) || 0,
          }));
        } else if (type === "package" && Array.isArray(it.components)) {
          cleanItem.components = it.components.slice(0, 30).map((c: any) => ({
            name: String(c?.name || "").slice(0, 300),
            serial: String(c?.serial || "").slice(0, 100),
          }));
        }
        return cleanItem;
      });
      for (const qi of quotationItems) subtotal += qi.lineTotal;
      const items = [...quotationItems, ...cleanItems];
      const discountTotal = Number(body.discountTotal) || 0;
      subtotal = Math.max(0, subtotal - discountTotal);
      const vatPercent = body.vatPercent != null ? Number(body.vatPercent) : 15;
      const vatAmount = Math.round(subtotal * (vatPercent / 100) * 100) / 100;
      const total = Math.round((subtotal + vatAmount) * 100) / 100;

      const invoiceNumber = await generateInvoiceNumber();

      const nowIso = new Date().toISOString();
      const qrBase64 = buildZatcaQrBase64(SELLER_NAME, SELLER_VAT_NUMBER, nowIso, total, vatAmount);
      const invoiceType = (body.customerVatNumber || body.customerCrNumber) ? "standard" : "simplified";

      const row = {
        project_id: null, customer_id: customerId, milestone_id: null,
        source_quotation_id: sourceQuotationId,
        invoice_number: invoiceNumber, invoice_type: invoiceType,
        due_date: null,
        customer_name: body.customerName || customer.name || null, customer_phone: customer.phone,
        customer_address: body.customerAddress || null,
        customer_vat_number: body.customerVatNumber || customer.vat_number || null,
        customer_cr_number: body.customerCrNumber || customer.commercial_registration || null,
        items, discount_total: discountTotal, vat_percent: vatPercent,
        subtotal, vat_amount: vatAmount, total,
        status: "paid", payment_method: body.paymentMethod || "cash", paid_at: nowIso,
        rep_username: auth.rep ? auth.rep.username : "admin",
        qr_base64: qrBase64,
        notes: body.notes || null,
        created_by: auth.rep ? auth.rep.username : "admin",
        approval_status: auth.isAdmin ? "approved" : "pending",
        approved_by: auth.isAdmin ? "admin" : null,
        approved_at: auth.isAdmin ? nowIso : null,
      };
      const { data, error } = await supabase.from("invoices").insert(row).select().maybeSingle();
      if (error) throw error;
      await logAudit(auth, "create", "invoice", data.id, invoiceNumber, null, { total: data.total, status: data.status, type: invoiceType, approval: row.approval_status });
      return json({ ok: true, invoice: data, seller: { name: SELLER_NAME, vatNumber: SELLER_VAT_NUMBER, crNumber: SELLER_CR_NUMBER, nationalAddress: SELLER_NATIONAL_ADDRESS } });
    }

    if (action === "crm-list-pos-invoices") {
      let q = supabase.from("invoices").select("*").is("project_id", null)
        .order("created_at", { ascending: false }).limit(500);
      if (!auth.isAdmin && auth.rep) q = q.eq("rep_username", auth.rep.username);
      if (body.search) {
        const term = body.search;
        q = q.or(`invoice_number.ilike.%${term}%,customer_phone.ilike.%${term}%,customer_name.ilike.%${term}%`);
      }
      const { data, error } = await q;
      if (error) throw error;
      return json({ ok: true, invoices: data || [], seller: { name: SELLER_NAME, vatNumber: SELLER_VAT_NUMBER, crNumber: SELLER_CR_NUMBER, nationalAddress: SELLER_NATIONAL_ADDRESS } });
    }

    if (action === "crm-approve-pos-invoice") {
      if (!auth.isAdmin) return json({ error: "اعتماد الفواتير للطباعة متاح للأدمن بس" }, 403);
      if (!body.invoiceId) return json({ error: "invoiceId required" }, 400);
      const { data: current } = await supabase.from("invoices").select("invoice_number, approval_status").eq("id", body.invoiceId).maybeSingle();
      const { data, error } = await supabase.from("invoices")
        .update({ approval_status: "approved", approved_by: "admin", approved_at: new Date().toISOString() })
        .eq("id", body.invoiceId).select().maybeSingle();
      if (error) throw error;
      if (current) await logAudit(auth, "approve_print", "invoice", data.id, current.invoice_number, { approval_status: current.approval_status }, { approval_status: "approved" });
      return json({ ok: true, invoice: data });
    }

    if (action === "admin-crm-list-projects") {
      let q = supabase.from("projects").select("*, customers(id, name, phone)").order("created_at", { ascending: false }).limit(1000);
      if (body.status) q = q.eq("status", body.status);
      if (body.search) {
        const custIds = await customerIdsMatching(body.search);
        const orParts = [`project_number.ilike.%${body.search}%`];
        if (custIds.length) orParts.push(`customer_id.in.(${custIds.join(",")})`);
        q = q.or(orParts.join(","));
      }
      const { data, error } = await q;
      if (error) throw error;
      return json({ ok: true, projects: (data || []).map(stripProjectCostFields) });
    }

    if (action === "admin-crm-add-cost") {
      if (!auth.isAdmin) return json({ error: "تسجيل التكاليف متاح للأدمن بس" }, 403);
      if (!body.projectId) return json({ error: "projectId required" }, 400);
      const { data, error } = await supabase.from("project_costs").insert({
        project_id: body.projectId, cost_type: body.costType || "other",
        description: body.description || null, amount: Number(body.amount) || 0,
      }).select().maybeSingle();
      if (error) throw error;
      await logAudit(auth, "add_cost", "project", Number(body.projectId), body.costType || "other", null, { amount: data.amount, description: data.description });
      return json({ ok: true, cost: data });
    }

    if (action === "admin-crm-delete-cost") {
      if (!auth.isAdmin) return json({ error: "حذف التكاليف متاح للأدمن بس" }, 403);
      if (!body.costId) return json({ error: "costId required" }, 400);
      const { data: current } = await supabase.from("project_costs").select("project_id, amount, cost_type").eq("id", body.costId).maybeSingle();
      const { error } = await supabase.from("project_costs").delete().eq("id", body.costId);
      if (error) throw error;
      if (current) await logAudit(auth, "delete_cost", "project", current.project_id, current.cost_type, { amount: current.amount }, null);
      return json({ ok: true });
    }

    if (action === "admin-crm-add-payment") {
      if (!body.projectId) return json({ error: "projectId required" }, 400);
      const { data, error } = await supabase.from("payments").insert({
        project_id: body.projectId, amount: Number(body.amount) || 0,
        payment_date: body.paymentDate || new Date().toISOString().slice(0, 10),
        method: body.method || null, notes: body.notes || null,
      }).select().maybeSingle();
      if (error) throw error;
      await logAudit(auth, "add_payment", "project", Number(body.projectId), null, null, { amount: data.amount, payment_date: data.payment_date });
      return json({ ok: true, payment: data });
    }

    if (action === "admin-crm-delete-payment") {
      if (!body.paymentId) return json({ error: "paymentId required" }, 400);
      const { error } = await supabase.from("payments").delete().eq("id", body.paymentId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "admin-crm-list-maintenance-contracts") {
      let q = supabase.from("maintenance_contracts").select("*, customers(id, name, phone)").order("next_visit_date", { ascending: true, nullsFirst: false }).limit(1000);
      if (body.customerId) q = q.eq("customer_id", body.customerId);
      if (body.search) {
        const custIds = await customerIdsMatching(body.search);
        const orParts = [`contract_number.ilike.%${body.search}%`];
        if (custIds.length) orParts.push(`customer_id.in.(${custIds.join(",")})`);
        q = q.or(orParts.join(","));
      }
      const { data, error } = await q;
      if (error) throw error;
      return json({ ok: true, contracts: data || [] });
    }

    if (action === "admin-crm-save-maintenance-contract") {
      const fields = ["project_id", "contract_number", "start_date", "end_date", "contract_value",
        "visits_per_year", "next_visit_date", "responsible_engineer", "status", "notes"];
      if (body.contractId) {
        const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
        for (const k of fields) if (body.fields && k in body.fields) update[k] = body.fields[k];
        const { data, error } = await supabase.from("maintenance_contracts").update(update).eq("id", body.contractId).select().maybeSingle();
        if (error) throw error;
        return json({ ok: true, contract: data });
      }
      if (!body.customerId) return json({ error: "customerId required" }, 400);
      const row: Record<string, unknown> = { customer_id: body.customerId };
      for (const k of fields) if (body.fields && k in body.fields) row[k] = body.fields[k];
      const { data, error } = await supabase.from("maintenance_contracts").insert(row).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, contract: data });
    }

    if (action === "admin-crm-delete-maintenance-contract") {
      if (!body.contractId) return json({ error: "contractId required" }, 400);
      const { error } = await supabase.from("maintenance_contracts").delete().eq("id", body.contractId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "admin-crm-list-tickets") {
      let q = supabase.from("service_tickets").select("*, customers(id, name, phone)").order("created_at", { ascending: false }).limit(1000);
      if (body.status) q = q.eq("status", body.status);
      if (body.priority) q = q.eq("priority", body.priority);
      if (body.customerId) q = q.eq("customer_id", body.customerId);
      if (body.search) {
        const custIds = await customerIdsMatching(body.search);
        const orParts = [`ticket_number.ilike.%${body.search}%`];
        if (custIds.length) orParts.push(`customer_id.in.(${custIds.join(",")})`);
        q = q.or(orParts.join(","));
      }
      const { data, error } = await q;
      if (error) throw error;
      return json({ ok: true, tickets: data || [] });
    }

    if (action === "admin-crm-create-ticket") {
      if (!body.customerId) return json({ error: "customerId required" }, 400);
      const year = new Date().getFullYear();
      const { count } = await supabase.from("service_tickets").select("id", { count: "exact", head: true }).like("ticket_number", `TCK-${year}-%`);
      const ticketNumber = `TCK-${year}-${String((count || 0) + 1).padStart(3, "0")}`;
      const { data, error } = await supabase.from("service_tickets").insert({
        customer_id: body.customerId, site_id: body.siteId || null, asset_id: body.assetId || null, project_id: body.projectId || null,
        ticket_number: ticketNumber, issue_description: body.issueDescription || null,
        priority: body.priority || "medium", status: "open", assigned_engineer: body.assignedEngineer || null,
      }).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, ticket: data });
    }

    if (action === "admin-crm-update-ticket") {
      if (!body.ticketId) return json({ error: "ticketId required" }, 400);
      const fields = ["priority", "status", "assigned_engineer", "resolution_notes", "issue_description"];
      const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const k of fields) if (body.fields && k in body.fields) update[k] = body.fields[k];
      if (update.status === "resolved" || update.status === "closed") update.resolved_at = new Date().toISOString();
      const { data, error } = await supabase.from("service_tickets").update(update).eq("id", body.ticketId).select().maybeSingle();
      if (error) throw error;
      return json({ ok: true, ticket: data });
    }

    if (action === "admin-crm-delete-ticket") {
      if (!body.ticketId) return json({ error: "ticketId required" }, 400);
      const { error } = await supabase.from("service_tickets").delete().eq("id", body.ticketId);
      if (error) throw error;
      return json({ ok: true });
    }

    if (action === "admin-crm-maintenance-stats") {
      const { data: tickets, error: tErr } = await supabase.from("service_tickets").select("status, priority");
      if (tErr) throw tErr;
      const { data: contracts, error: cErr } = await supabase.from("maintenance_contracts").select("status, next_visit_date");
      if (cErr) throw cErr;
      const today = new Date().toISOString().slice(0, 10);
      const openTickets = (tickets || []).filter((t: any) => t.status !== "resolved" && t.status !== "closed").length;
      const criticalTickets = (tickets || []).filter((t: any) => t.priority === "critical" && t.status !== "resolved" && t.status !== "closed").length;
      const activeContracts = (contracts || []).filter((c: any) => c.status === "active").length;
      const upcomingVisits = (contracts || []).filter((c: any) => c.next_visit_date && c.next_visit_date >= today).length;
      return json({ ok: true, totalTickets: (tickets || []).length, openTickets, criticalTickets, activeContracts, upcomingVisits });
    }

    if (action === "admin-crm-global-search") {
      const term = (body.query || "").trim();
      if (!term || term.length < 2) return json({ ok: true, empty: true });

      const custIds = await customerIdsMatching(term);
      const custFilter = custIds.length ? `customer_id.in.(${custIds.join(",")})` : null;

      const [customersR, sitesR, oppsR, projectsR, ticketsR, assetsR, maintR] = await Promise.all([
        supabase.from("customers").select("id, name, phone, status").or(`name.ilike.%${term}%,phone.ilike.%${term}%`).limit(6),
        supabase.from("sites").select("id, customer_id, name, region, location_address, customers(name, phone)")
          .or([`name.ilike.%${term}%`, `region.ilike.%${term}%`, `location_address.ilike.%${term}%`, custFilter].filter(Boolean).join(",")).limit(6),
        supabase.from("opportunities").select("id, name, stage, customer_id, customers(name, phone)")
          .or([`name.ilike.%${term}%`, custFilter].filter(Boolean).join(",")).limit(6),
        supabase.from("projects").select("id, opportunity_id, project_number, status, customer_id, customers(name, phone)")
          .or([`project_number.ilike.%${term}%`, custFilter].filter(Boolean).join(",")).limit(6),
        supabase.from("service_tickets").select("id, ticket_number, status, priority, customer_id, customers(name, phone)")
          .or([`ticket_number.ilike.%${term}%`, `issue_description.ilike.%${term}%`, custFilter].filter(Boolean).join(",")).limit(6),
        supabase.from("assets").select("id, customer_id, asset_type, serial_number, model, customers(name, phone)")
          .or([`serial_number.ilike.%${term}%`, `model.ilike.%${term}%`, `manufacturer.ilike.%${term}%`, custFilter].filter(Boolean).join(",")).limit(6),
        supabase.from("maintenance_contracts").select("id, contract_number, status, customer_id, customers(name, phone)")
          .or([`contract_number.ilike.%${term}%`, custFilter].filter(Boolean).join(",")).limit(6),
      ]);
      return json({
        ok: true,
        customers: customersR.data || [], sites: sitesR.data || [], opportunities: oppsR.data || [],
        projects: projectsR.data || [], tickets: ticketsR.data || [], assets: assetsR.data || [], maintenanceContracts: maintR.data || [],
      });
    }

    if (action === "admin-crm-list-audit-log") {
      if (!auth.isAdmin) return json({ error: "سجل التغييرات متاح للأدمن بس" }, 403);
      let q = supabase.from("audit_log").select("*").order("created_at", { ascending: false }).limit(200);
      if (body.entityType) q = q.eq("entity_type", body.entityType);
      if (body.search) q = q.or(`entity_label.ilike.%${body.search}%,actor.ilike.%${body.search}%`);
      const { data, error } = await q;
      if (error) throw error;
      return json({ ok: true, entries: data || [] });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
