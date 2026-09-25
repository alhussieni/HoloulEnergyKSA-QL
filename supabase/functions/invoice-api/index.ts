// HoloulEnergy — invoice-api Edge Function
//
// Issues and manages the e-invoices (ZATCA Phase-1: QR code, credit notes,
// sequential numbering). Lives next to `crm-api` and verifies the SAME signed
// session tokens issued by `compute-quote`. Kept as its own function so the
// invoice rules can change without touching the live CRM function.
// Actions handled here: crm-create-pos-invoice, crm-list-pos-invoices,
// crm-create-credit-note, crm-delete-trial-invoice, crm-einvoice-go-live.
// (crm-approve-pos-invoice stays in crm-api — approval only flips approval flags.)

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
// ZATCA QR payload (Base64-encoded TLV) — Phase-1 fields, per the
// "Guide to Developed FATOORA Compliant QR Code":
//   tag 1 = seller name        tag 2 = VAT registration number
//   tag 3 = timestamp (ISO 8601, e.g. 2022-04-25T15:30:00Z — NO milliseconds)
//   tag 4 = invoice total incl. VAT     tag 5 = VAT total
// Each field = 1 byte tag + 1 byte length (of the UTF-8 bytes) + UTF-8 value,
// concatenated with no separators, then Base64 of the whole byte array.
// NOTE: this does NOT do Phase-2 (Integration) — no UBL XML, no cryptographic
// stamp, no CSID onboarding, no clearance/reporting to Fatoora, and QR tags
// 6-9 are not produced. That needs a separate ZATCA integration.
// ---------------------------------------------------------------------
// SELLER_NAME must equal the name registered with ZATCA (it is printed on the
// invoice AND encoded in QR tag 1). Legal trade name since 18/04/2026 per the
// Ministry of Commerce letter no. 553833. The VAT certificate dated 22/12/2025
// still shows the OLD name — update the ZATCA registration, then re-check this.
const SELLER_NAME = "مؤسسة حلول الطاقة المتجددة والمقاولات";
const SELLER_VAT_NUMBER = "311386341200003";
const SELLER_CR_NUMBER = "7037810988";          // الرقم الوطني الموحد (as shown on the VAT certificate)
const SELLER_COMMERCIAL_REG = "1010970687";     // رقم السجل التجاري
const SELLER_NATIONAL_ADDRESS = "RDMC8001"; // short national address code
// Source: National Address proof no. 1077132936 (SPL). NOTE: the ZATCA VAT certificate shows a
// different street/postal code (علي القفطي / 13754) — align the ZATCA record with this address.
const SELLER_ADDRESS = { buildingNo: "8001", street: "أحمد الكازروني", district: "حي المهدية", city: "الرياض", postalCode: "13752", additionalNo: "2343", country: "المملكة العربية السعودية" };
const SELLER_INFO = { name: SELLER_NAME, vatNumber: SELLER_VAT_NUMBER, crNumber: SELLER_CR_NUMBER, commercialReg: SELLER_COMMERCIAL_REG, nationalAddress: SELLER_NATIONAL_ADDRESS, address: SELLER_ADDRESS };

function tlvField(tag: number, value: string): Uint8Array {
  const valueBytes = new TextEncoder().encode(value);
  if (valueBytes.length > 255) throw new Error(`QR field ${tag} too long (${valueBytes.length} bytes, max 255)`);
  const out = new Uint8Array(2 + valueBytes.length);
  out[0] = tag;
  out[1] = valueBytes.length;
  out.set(valueBytes, 2);
  return out;
}
// ISO-8601 UTC with seconds precision and a trailing Z (no milliseconds).
function qrTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
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

// Money maths shared by invoices and credit notes. VAT is computed PER LINE
// (rounded to 2 dp) and summed, and a document-level discount reduces the VAT
// by the VAT on that discount — so the printed table always foots exactly.
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
function computeTotals(lineNets: number[], discountTotal: number, vatPercent: number) {
  const rate = vatPercent / 100;
  const gross = round2(lineNets.reduce((s, n) => s + n, 0));
  const subtotal = round2(gross - discountTotal);
  const vatAmount = round2(lineNets.reduce((s, n) => s + round2(n * rate), 0) - round2(discountTotal * rate));
  const total = round2(subtotal + vatAmount);
  return { gross, subtotal, vatAmount, total };
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
const CREDIT_NOTE_PREFIX = "HEWCN";
// Day boundaries follow Saudi time (UTC+3), not the server's UTC clock.
function riyadhDateKey(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Riyadh" }).format(d).replace(/-/g, "");
}
// Atomic per-day counter (Postgres function next_invoice_seq) — safe under
// concurrent requests, never reuses a number.
async function generateInvoiceNumber(prefix = INVOICE_PREFIX): Promise<string> {
  const key = `${prefix}${riyadhDateKey(new Date())}`;
  const { data, error } = await supabase.rpc("next_invoice_seq", { p_key: key });
  if (error) throw error;
  return `${key}-${String(data).padStart(3, "0")}`;
}

// Trial mode: while true, test invoices can be deleted and printouts carry a
// "TEST" watermark. `crm-einvoice-go-live` wipes the test data, resets the
// numbering and switches it off for good.
async function isTrialMode(): Promise<boolean> {
  const { data } = await supabase.from("einvoice_config").select("trial_mode").eq("id", 1).maybeSingle();
  return data ? !!data.trial_mode : false;
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
      const items = [...quotationItems, ...cleanItems];
      const discountTotal = round2(Number(body.discountTotal) || 0);
      const vatPercent = body.vatPercent != null ? Number(body.vatPercent) : 15;
      const lineNets = items.map((it: any) => round2(Number(it.qty) * Number(it.unitPrice) - (Number(it.discount) || 0)));
      if (lineNets.some((n) => !isFinite(n) || n < 0)) return json({ error: "قيمة أحد البنود غير صحيحة" }, 400);
      if (discountTotal < 0 || discountTotal > lineNets.reduce((s, n) => s + n, 0)) {
        return json({ error: "قيمة الخصم على الفاتورة غير صحيحة" }, 400);
      }
      const { subtotal, vatAmount, total } = computeTotals(lineNets, discountTotal, vatPercent);
      if (total <= 0) return json({ error: "إجمالي الفاتورة لازم يكون أكبر من صفر" }, 400);

      // Standard (B2B) tax invoice = buyer has a VAT / CR number. It then MUST
      // carry the buyer's name, address and tax identity.
      const buyerVat = String(body.customerVatNumber || customer.vat_number || "").trim();
      const buyerCr = String(body.customerCrNumber || customer.commercial_registration || "").trim();
      const buyerName = String(body.customerName || customer.name || "").trim();
      const buyerAddress = String(body.customerAddress || "").trim();
      const isStandard = !!(body.customerVatNumber || body.customerCrNumber);
      if (isStandard) {
        if (!buyerName) return json({ error: "الفاتورة الضريبية (لمنشأة) تحتاج اسم العميل" }, 400);
        if (!buyerAddress) return json({ error: "الفاتورة الضريبية (لمنشأة) تحتاج عنوان العميل" }, 400);
        if (!buyerVat && !buyerCr) return json({ error: "الفاتورة الضريبية (لمنشأة) تحتاج رقم ضريبي أو سجل تجاري للعميل" }, 400);
        if (buyerVat && !/^3\d{13}3$/.test(buyerVat)) return json({ error: "الرقم الضريبي للعميل لازم يكون 15 رقم يبدأ وينتهي بـ 3" }, 400);
      }
      const invoiceType = isStandard ? "standard" : "simplified";

      const invoiceNumber = await generateInvoiceNumber();
      const issuedAt = new Date();
      const nowIso = issuedAt.toISOString();
      const qrBase64 = buildZatcaQrBase64(SELLER_NAME, SELLER_VAT_NUMBER, qrTimestamp(issuedAt), total, vatAmount);

      const row = {
        project_id: null, customer_id: customerId, milestone_id: null,
        source_quotation_id: sourceQuotationId,
        invoice_number: invoiceNumber, invoice_type: invoiceType, document_type: "invoice",
        issued_at: nowIso,
        due_date: null,
        customer_name: body.customerName || customer.name || null, customer_phone: customer.phone,
        customer_address: buyerAddress || null,
        customer_vat_number: buyerVat || null,
        customer_cr_number: buyerCr || null,
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
      return json({ ok: true, invoice: data, seller: SELLER_INFO, trialMode: await isTrialMode() });
    }

    if (action === "crm-list-pos-invoices") {
      let q = supabase.from("invoices").select("*").is("project_id", null)
        .order("created_at", { ascending: false }).limit(500);
      if (!auth.isAdmin && auth.rep) q = q.eq("rep_username", auth.rep.username);
      if (body.search) {
        const term = String(body.search).replace(/[,()%]/g, " ");
        q = q.or(`invoice_number.ilike.%${term}%,customer_phone.ilike.%${term}%,customer_name.ilike.%${term}%`);
      }
      const { data, error } = await q;
      if (error) throw error;
      return json({ ok: true, invoices: data || [], seller: SELLER_INFO, trialMode: await isTrialMode() });
    }

    // Credit note (إشعار دائن): the only legal way to cancel / reverse an issued
    // invoice. v1 = full reversal, admin only, mandatory reason. It gets its own
    // sequential number and its own QR (same 5 TLV fields, new timestamp).
    if (action === "crm-create-credit-note") {
      if (!auth.isAdmin) return json({ error: "إصدار الإشعارات الدائنة متاح للأدمن بس" }, 403);
      const reason = String(body.reason || "").trim();
      if (!body.invoiceId) return json({ error: "invoiceId required" }, 400);
      if (reason.length < 3) return json({ error: "سبب الإشعار الدائن مطلوب" }, 400);
      const { data: orig, error: origErr } = await supabase.from("invoices").select("*").eq("id", body.invoiceId).maybeSingle();
      if (origErr) throw origErr;
      if (!orig) return json({ error: "الفاتورة غير موجودة" }, 404);
      if (orig.document_type !== "invoice") return json({ error: "الإشعار الدائن يصدر على فاتورة فقط" }, 400);
      if (orig.approval_status !== "approved") return json({ error: "الفاتورة لسه غير معتمدة — مفيش داعي لإشعار دائن" }, 400);
      const { data: existing } = await supabase.from("invoices").select("id").eq("related_invoice_id", orig.id).eq("document_type", "credit_note").maybeSingle();
      if (existing) return json({ error: "تم إصدار إشعار دائن لهذه الفاتورة من قبل" }, 409);

      const number = await generateInvoiceNumber(CREDIT_NOTE_PREFIX);
      const issuedAt = new Date();
      const nowIso = issuedAt.toISOString();
      const qr = buildZatcaQrBase64(SELLER_NAME, SELLER_VAT_NUMBER, qrTimestamp(issuedAt), Number(orig.total), Number(orig.vat_amount));
      const row = {
        project_id: null, customer_id: orig.customer_id, milestone_id: null, source_quotation_id: null,
        invoice_number: number, invoice_type: orig.invoice_type, document_type: "credit_note",
        related_invoice_id: orig.id, reason, issued_at: nowIso, due_date: null,
        customer_name: orig.customer_name, customer_phone: orig.customer_phone, customer_address: orig.customer_address,
        customer_vat_number: orig.customer_vat_number, customer_cr_number: orig.customer_cr_number,
        items: orig.items, discount_total: orig.discount_total, vat_percent: orig.vat_percent,
        subtotal: orig.subtotal, vat_amount: orig.vat_amount, total: orig.total,
        status: "issued", payment_method: orig.payment_method, paid_at: null,
        rep_username: "admin", qr_base64: qr, notes: null, created_by: "admin",
        approval_status: "approved", approved_by: "admin", approved_at: nowIso,
      };
      const { data, error } = await supabase.from("invoices").insert(row).select().maybeSingle();
      if (error) throw error;
      await supabase.from("invoices").update({ status: "cancelled", updated_at: nowIso }).eq("id", orig.id);
      await logAudit(auth, "credit_note", "invoice", data.id, number, { invoice: orig.invoice_number }, { total: data.total, reason });
      return json({ ok: true, invoice: data, original: orig.invoice_number, seller: SELLER_INFO, trialMode: await isTrialMode() });
    }

    // Trial only: delete ONE test invoice (its credit note, if any, goes with it).
    if (action === "crm-delete-trial-invoice") {
      if (!auth.isAdmin) return json({ error: "حذف فواتير التجربة متاح للأدمن بس" }, 403);
      if (!(await isTrialMode())) return json({ error: "الفترة التجريبية انتهت — الحذف غير مسموح. أصدر إشعار دائن." }, 403);
      if (!body.invoiceId) return json({ error: "invoiceId required" }, 400);
      const { data: current } = await supabase.from("invoices").select("invoice_number, document_type, related_invoice_id").eq("id", body.invoiceId).maybeSingle();
      if (!current) return json({ error: "الفاتورة غير موجودة" }, 404);
      // deleting a credit note alone would leave its invoice marked cancelled — reopen it
      if (current.document_type === "credit_note" && current.related_invoice_id) {
        await supabase.from("invoices").update({ status: "paid", updated_at: new Date().toISOString() }).eq("id", current.related_invoice_id);
      }
      await supabase.from("invoices").delete().eq("related_invoice_id", body.invoiceId).eq("document_type", "credit_note");
      const { error } = await supabase.from("invoices").delete().eq("id", body.invoiceId);
      if (error) throw error;
      await logAudit(auth, "delete_trial", "invoice", Number(body.invoiceId), current.invoice_number, null, null);
      return json({ ok: true });
    }

    // One-way switch: wipe ALL test invoices, restart numbering at 001, leave trial mode.
    if (action === "crm-einvoice-go-live") {
      if (!auth.isAdmin) return json({ error: "متاح للأدمن بس" }, 403);
      if (body.confirm !== "GO-LIVE") return json({ error: "التأكيد مطلوب" }, 400);
      if (!(await isTrialMode())) return json({ error: "النظام بالفعل في وضع التشغيل الفعلي" }, 409);
      const { data, error } = await supabase.rpc("einvoice_go_live");
      if (error) throw error;
      await logAudit(auth, "go_live", "einvoice", null, "trial ended", null, { deleted: data });
      return json({ ok: true, deleted: data });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
