// HoloulEnergy — docs-api (صفحة PD: Projects Documents)
//
// دالة مرافقة على نمط crm-api / customer-identity: لا تعدّل أي دالة قائمة.
// تقرأ من الـCRM (customers, opportunities, projects, sites, quotes, company_profile,
// customer_identity) ولا تكتب فيه إطلاقاً. تكتب فقط في pd_documents و audit_log.
// أدمن فقط (نفس توكن الجلسة الذي تصدره compute-quote).
//
// الإجراءات: pd-overview | pd-prepare | pd-issue | pd-docs | pd-render | pd-status
//
// النشر: ثلاثة ملفات (index.ts + template.ts + validate.ts) و verify_jwt = false.
// template.ts يحوي نص العقد وشروطه: لا تضعه في مستودع GitHub العام.

import { createClient } from "npm:@supabase/supabase-js@2";
import { normalizeId, validateId } from "./validate.ts";
import { DEFAULT_TERMS, renderDocument, TEMPLATE_KEY, TEMPLATE_VERSION, type Snap } from "./template.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---- نفس منطق التوكن في crm-api (يجب أن يبقى متطابقاً) ----
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
    const p = JSON.parse(b64urlToString(payloadB64));
    if (!p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
    return p;
  } catch { return null; }
}

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function checkAdminToken(token: string | undefined): Promise<boolean> {
  const p = await readToken(token);
  if (!p || p.sub !== "admin") return false;
  const { data, error } = await sb.from("admin_secret").select("session_version").eq("id", 1).single();
  return !error && !!data && p.ver === data.session_version;
}

async function audit(actionType: string, entityId: number | null, label: string | null, newV: unknown) {
  try {
    await sb.from("audit_log").insert({
      actor: "admin", actor_role: "admin", action_type: actionType, entity_type: "pd_document",
      entity_id: entityId, entity_label: label, old_value: null, new_value: newV ?? null,
    });
  } catch { /* لا نكسر العملية الأساسية */ }
}

// ------------------------------------------------------------------ أدوات
const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function localPhone(raw: unknown): string {
  let d = str(raw).replace(/[^0-9]/g, "");
  if (d.startsWith("00966")) d = d.slice(5);
  else if (d.startsWith("966")) d = d.slice(3);
  if (d.length === 9 && d.startsWith("5")) d = "0" + d;
  return d;
}

async function canonicalHash(obj: unknown): Promise<string> {
  const canon = (v: any): any =>
    Array.isArray(v) ? v.map(canon)
    : v && typeof v === "object" ? Object.keys(v).sort().reduce((o: any, k) => (o[k] = canon(v[k]), o), {})
    : v;
  const bytes = new TextEncoder().encode(JSON.stringify(canon(obj)));
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(h).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------ قراءة المصدر
interface Source {
  opp: any; customer: any; contacts: any[]; identity: any | null; site: any | null; project: any | null;
  milestones: any[]; company: any; quotes: any[]; quote: any | null; lastDoc: any | null;
}

async function gather(opportunityId: number, quoteId?: number): Promise<Source> {
  const { data: opp, error: oErr } = await sb.from("opportunities").select("*").eq("id", opportunityId).maybeSingle();
  if (oErr) throw oErr;
  if (!opp) throw new Error("الفرصة غير موجودة");
  const { data: customer } = await sb.from("customers")
    .select("id, name, phone, customer_type, commercial_registration, vat_number, unified_number, city, region").eq("id", opp.customer_id).maybeSingle();
  if (!customer) throw new Error("العميل غير موجود");
  const [{ data: contacts }, { data: identity }, { data: project }, { data: company }, { data: quotes }, { data: lastDocs }] = await Promise.all([
    sb.from("contacts").select("id, name, position, mobile, email, decision_power").eq("customer_id", customer.id),
    sb.from("customer_identity").select("id_type, id_number").eq("customer_id", customer.id).maybeSingle(),
    sb.from("projects").select("id, project_number, contract_value, contract_signed_date, site_id").eq("opportunity_id", opp.id).maybeSingle(),
    sb.from("company_profile").select("*").eq("id", 1).maybeSingle(),
    sb.from("quotes").select("id, ref_code, revision_no, hp, final_total, created_at, snapshot").eq("customer_id", customer.id).order("created_at", { ascending: false }).limit(30),
    sb.from("pd_documents").select("snapshot").eq("doc_type", "contract").neq("status", "void").order("issued_at", { ascending: false }).limit(1),
  ]);
  let site: any = null;
  const siteId = opp.site_id || project?.site_id;
  if (siteId) site = (await sb.from("sites").select("id, name, location_address, google_maps_link, gps_lat, gps_lng, city, region").eq("id", siteId).maybeSingle()).data;
  else site = (await sb.from("sites").select("id, name, location_address, google_maps_link, gps_lat, gps_lng, city, region").eq("customer_id", customer.id).order("created_at", { ascending: false }).limit(1)).data?.[0] || null;
  const milestones = project
    ? ((await sb.from("payment_milestones").select("title, percentage, amount, status, due_date").eq("project_id", project.id).order("id")).data || [])
    : [];
  const qList = (quotes || []).filter((q: any) => q.snapshot && q.snapshot.frozenQuote);
  const quote = quoteId ? qList.find((q: any) => q.id === quoteId) || null : null;
  return { opp, customer, contacts: contacts || [], identity: identity || null, site, project: project || null,
    milestones, company, quotes: qList, quote, lastDoc: lastDocs?.[0] || null };
}

function parseQuote(row: any) {
  const snap = row.snapshot, fq = snap.frozenQuote;
  const toggles: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(snap.toggles || {})) toggles[k] = !!v;
  const label = str(fq.panelLabel);
  const m = label.match(/(\d{3,4})\s*W/i);
  const total = num(fq.finalTotal), vat = num(fq.vat), exVat = round2(total - vat);
  return {
    refCode: str(row.ref_code), hp: fq.hp ?? row.hp ?? null, calcKW: num(fq.calcKW), invKW: fq.invKW != null ? num(fq.invKW) : null,
    totalPanels: num(fq.totalPanels), panelLabel: label, panelWatt: m ? Number(m[1]) : null,
    invBrand: str(fq.invBrandName), structureType: str(snap.structureType), toggles,
    items: (Array.isArray(fq.items) ? fq.items : []).map((it: any) => ({ label: str(it.label), qty: str(it.qty).replace(/#/g, "") })),
    commercial: { exVat, vat: round2(vat), total: round2(total), vatPct: exVat > 0 ? Math.round((vat / exVat) * 100) : 15 },
  };
}

function companyView(c: any) {
  const a = c?.address || {};
  const addr = [a.city, a.district, a.street, a.buildingNo ? `مبنى ${a.buildingNo}` : "", a.postalCode ? `الرمز البريدي ${a.postalCode}` : "",
    a.additionalNo ? `الرقم الإضافي ${a.additionalNo}` : "", c?.national_address_code ? `العنوان المختصر ${c.national_address_code}` : ""]
    .filter(Boolean).join("، ");
  // في company_profile الحقلان cr_number و commercial_reg قد يكونان مقلوبين: نميّز بالنمط (الموحد يبدأ بـ 7).
  const cands = [str(c?.commercial_reg), str(c?.cr_number)].filter(Boolean);
  const unified = cands.find((v) => /^7[0-9]{9}$/.test(v)) || "";
  const cr = cands.find((v) => v !== unified) || "";
  return { name: str(c?.name_ar), cr, unified, vat: str(c?.vat_number), address: addr,
    phone: localPhone(c?.whatsapp || c?.phone), email: str(c?.email) };
}

// ------------------------------------------------------------------ التجميع والتحقق
const DEFAULT_WARRANTY = {
  panels: "ضمان المصنّع: 30 سنة ضد انخفاض الإنتاجية عن 80%، و12 سنة ضد عيوب الصناعة",
  structure: "5 سنوات ضمان المورّد ضد عيوب التصنيع",
  inverter: "سنة واحدة (المصنّع / الموزع)", cables: "سنة واحدة", combiner: "سنة واحدة",
};

function defaultPayments(toggles: Record<string, boolean>) {
  const third = (toggles.concrete ? "عند الانتهاء من الأعمال الخرسانية بمحضر مصوّر، وقبل توريد المكونات إلى الموقع، " : "قبل توريد المكونات إلى الموقع، ") +
    "بعد معاينة الطرف الثاني (أو من ينوب عنه) للمكونات المتاحة في المخزن بأرقامها التسلسلية ومطابقتها للملحق (أ)";
  return [
    { title: "الدفعة الأولى", pct: 40, trigger: "عند توقيع العقد" },
    { title: "الدفعة الثانية", pct: 30, trigger: "عند نزول الفريق إلى الموقع وبدء الأعمال الميدانية" },
    { title: "الدفعة الثالثة", pct: 30, trigger: third },
  ];
}

type Err = { field: string; msg: string };

function assemble(src: Source, inp: any, docNo: string, issuedAt: string): { snap: Snap | null; errors: Err[]; defaults: any } {
  const errors: Err[] = [];
  const need = (cond: unknown, field: string, msg: string) => { if (!cond) errors.push({ field, msg }); };
  inp = inp || {};
  const last = src.lastDoc?.snapshot;
  const co = companyView(src.company);

  const cust = src.customer;
  const isCompany = !(cust.customer_type == null || cust.customer_type === "" || cust.customer_type === "individual" || cust.customer_type === "فرد");
  const mainContact = src.contacts.find((c: any) => c.email) || src.contacts[0];

  // بيانات مرجعية افتراضية (للعرض في النموذج) تُبنى حتى لو لا يوجد عرض سعر مختار بعد
  const q = src.quote ? parseQuote(src.quote) : null;
  const toggles = q?.toggles || {};

  const defaults = {
    place: last?.place || "الرياض",
    companyRep: last ? { name: last.company.repName, title: last.company.repTitle, authority: last.company.repAuthority } : { name: "", title: "", authority: "" },
    bank: last?.bank || { holder: co.name, bank: "", iban: "" },
    warranty: last?.inputs?.warranty || DEFAULT_WARRANTY,
    payments: defaultPayments(toggles),
    earthingDeadline: last?.inputs?.earthingDeadline || "بدء توريد المكونات إلى الموقع",
    contactYears: last?.terms?.contactYears ?? DEFAULT_TERMS.contactYears,
    customerEmail: mainContact?.email || "",
    customerPhone: localPhone(cust.phone || mainContact?.mobile),
  };

  // ---------- شروط عامة
  need(src.quote && q, "quote", "اختر عرض السعر المعتمد (يجب أن يكون مجمّداً)");
  need(co.name && co.cr && co.unified && co.vat, "company", "بيانات الشركة ناقصة في company_profile (الاسم/السجل/الموحد/الضريبة)");
  need(/^[0-9]{10}$/.test(co.cr), "company.cr", "السجل التجاري للشركة غير صالح في company_profile");
  need(co.address, "company.address", "عنوان الشركة غير موجود في company_profile");

  const cRep = { name: str(inp.companyRep?.name), title: str(inp.companyRep?.title), authority: str(inp.companyRep?.authority) };
  need(cRep.name && cRep.title && cRep.authority, "companyRep", "بيانات ممثل الطرف الأول (الاسم/الصفة/سند التفويض) مطلوبة");

  const bank = { holder: str(inp.bank?.holder), bank: str(inp.bank?.bank), iban: str(inp.bank?.iban).replace(/\s/g, "").toUpperCase() };
  need(bank.holder && bank.bank, "bank", "اسم صاحب الحساب والبنك مطلوبان");
  need(/^SA[0-9]{22}$/.test(bank.iban), "bank.iban", "رقم الآيبان يجب أن يكون SA متبوعاً بـ 22 رقماً");

  // ---------- الطرف الثاني
  let idType: string | undefined, idNumber: string | undefined, idSource = "";
  if (!isCompany) {
    if (src.identity) { idType = src.identity.id_type; idNumber = src.identity.id_number; idSource = "crm"; }
    else if (inp.manualId?.idType) {
      idType = str(inp.manualId.idType); idNumber = normalizeId(idType, inp.manualId.idNumber); idSource = "manual";
      const v = validateId(idType, idNumber || "");
      need(v.ok, "manualId", v.error || "رقم الهوية غير صالح");
    } else need(false, "manualId", "رقم الهوية غير مسجّل في النظام: أدخله هنا (يُحفظ في المستند فقط) أو سجّله في بطاقة العميل");
  } else {
    need(/^[0-9]{10}$/.test(str(cust.commercial_registration)), "customer.cr", "السجل التجاري للعميل (منشأة) ناقص أو غير صالح في بيانات العميل");
  }
  const cusAddress = str(inp.customerAddress);
  need(cusAddress, "customerAddress", "العنوان الوطني أو البريدي للطرف الثاني مطلوب");
  const cusEmail = str(inp.customerEmail) || str(defaults.customerEmail);
  need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cusEmail), "customerEmail", "بريد الطرف الثاني مطلوب (للإخطارات)");
  const cusPhone = localPhone(cust.phone || mainContact?.mobile);
  need(/^05[0-9]{8}$/.test(cusPhone), "customerPhone", "جوال الطرف الثاني غير صالح في بيانات العميل");
  if (isCompany) {
    need(str(inp.customerRep?.name) && str(inp.customerRep?.title) && str(inp.customerRep?.authority), "customerRep", "ممثل المنشأة (الاسم/الصفة/سند التفويض) مطلوب");
  }

  // ---------- الموقع
  const site = src.site;
  const hasGps = site?.gps_lat != null && site?.gps_lng != null;
  const siteText = str(inp.siteText);
  need(hasGps || str(site?.google_maps_link) || siteText, "site", "إحداثيات الموقع أو رابط الخريطة غير مسجّلة: أدخل وصف/إحداثيات الموقع هنا (يُحفظ في المستند فقط)");

  // ---------- خيارات العقد
  const tg = toggles;
  let earthingStatus = tg.earth ? "included" : str(inp.earthingStatus);
  let reactorStatus = tg.reactor ? "included" : str(inp.reactorStatus);
  need(["included", "optional", "waived"].includes(earthingStatus), "earthingStatus", "حدّد حالة التأريض (اختياري بسعر / مرفوض بإقرار)");
  need(["included", "optional", "waived"].includes(reactorStatus), "reactorStatus", "حدّد حالة الـREACTOR");
  if (earthingStatus === "optional") need(num(inp.earthingPrice) > 0, "earthingPrice", "سعر التأريض الاختياري مطلوب");
  if (reactorStatus === "optional") need(num(inp.reactorPrice) > 0, "reactorPrice", "سعر الـREACTOR الاختياري مطلوب");
  const earthingDeadline = str(inp.earthingDeadline) || defaults.earthingDeadline;

  const guard = str(inp.guard);
  need(["company", "client", "paid"].includes(guard), "guard", "حدّد من يتولى الحراسة أثناء التنفيذ");
  if (guard === "paid") need(num(inp.guardPrice) > 0, "guardPrice", "مقابل الحراسة مطلوب");
  const disputeType = str(inp.disputeType);
  need(["court", "arbitration"].includes(disputeType), "disputeType", "حدّد المحكمة أو التحكيم");
  if (disputeType === "court") need(str(inp.courtName) && str(inp.courtCity), "court", "اسم المحكمة ومدينتها مطلوبان");
  if (disputeType === "arbitration") need(str(inp.arbitrationCenter) && str(inp.arbitrationSeat), "arbitration", "جهة التحكيم ومقره مطلوبان");
  need(typeof inp.photoConsent === "boolean", "photoConsent", "حدّد موافقة العميل على التصوير والعرض");

  // ---------- الدفعات
  const payIn: Array<{ title: string; pct: number; trigger: string }> = Array.isArray(inp.payments) && inp.payments.length ? inp.payments : defaults.payments;
  const pctSum = round2(payIn.reduce((a, p) => a + num(p.pct), 0));
  need(payIn.length >= 1 && payIn.length <= 6, "payments", "عدد الدفعات من 1 إلى 6");
  need(pctSum === 100, "payments", `مجموع نسب الدفعات ${pctSum}% ويجب أن يكون 100%`);
  need(payIn.every((p) => str(p.title) && str(p.trigger) && num(p.pct) > 0), "payments", "كل دفعة تحتاج عنواناً واستحقاقاً ونسبة");

  if (errors.length || !q) return { snap: null, errors, defaults };

  let acc = 0;
  const payments = payIn.map((p, i) => {
    const amount = i === payIn.length - 1 ? round2(q.commercial.total - acc) : round2((q.commercial.total * num(p.pct)) / 100);
    acc = round2(acc + amount);
    return { title: str(p.title), pct: num(p.pct), trigger: str(p.trigger), amount };
  });

  const w = { ...DEFAULT_WARRANTY, ...(defaults.warranty || {}), ...(inp.warranty || {}) };
  const terms = { ...DEFAULT_TERMS, contactYears: Math.max(1, Math.min(30, Math.round(num(inp.contactYears) || defaults.contactYears))) };
  const g = site;
  const snap: Snap = {
    docNo, templateVersion: TEMPLATE_VERSION, issuedAt, place: str(inp.place) || defaults.place,
    company: { ...co, repName: cRep.name, repTitle: cRep.title, repAuthority: cRep.authority, formerName: str(inp.formerName) || undefined },
    customer: {
      name: str(cust.name), isCompany, idType, idNumber, crNo: str(cust.commercial_registration) || undefined,
      vatNo: str(cust.vat_number) || undefined, unifiedNo: str(cust.unified_number) || undefined,
      address: cusAddress, phone: cusPhone, email: cusEmail,
      repName: str(inp.customerRep?.name) || undefined, repTitle: str(inp.customerRep?.title) || undefined, repAuthority: str(inp.customerRep?.authority) || undefined,
    },
    site: { lat: hasGps ? Number(g.gps_lat) : null, lng: hasGps ? Number(g.gps_lng) : null,
      mapsLink: hasGps ? undefined : (str(g?.google_maps_link) || siteText), address: str(g?.location_address) || (hasGps ? siteText : "") || undefined },
    quote: { refCode: q.refCode, hp: q.hp, calcKW: q.calcKW, invKW: q.invKW, totalPanels: q.totalPanels, panelLabel: q.panelLabel,
      panelWatt: q.panelWatt, invBrand: q.invBrand, structureType: q.structureType, toggles: q.toggles, items: q.items },
    commercial: q.commercial, payments, bank,
    inputs: {
      earthingStatus: earthingStatus as any, earthingPrice: num(inp.earthingPrice) || undefined,
      reactorStatus: reactorStatus as any, reactorPrice: num(inp.reactorPrice) || undefined, earthingDeadline,
      guard: guard as any, guardPrice: num(inp.guardPrice) || undefined, photoConsent: !!inp.photoConsent,
      disputeType: disputeType as any, courtName: str(inp.courtName) || undefined, courtCity: str(inp.courtCity) || undefined,
      arbitrationCenter: str(inp.arbitrationCenter) || undefined, arbitrationSeat: str(inp.arbitrationSeat) || undefined,
      cableLengthText: str(inp.cableLengthText) || undefined, cablePricePerM: num(inp.cablePricePerM) || undefined,
      concreteDims: str(inp.concreteDims) || undefined, warranty: w,
    },
    terms,
  };
  // مصدر كل قيمة (للتدقيق لاحقاً): ما جاء من النظام وما أُدخل يدوياً
  (snap as any).provenance = {
    identity: isCompany ? "n/a" : idSource, quoteId: src.quote.id, opportunityId: src.opp.id, customerId: cust.id,
    projectId: src.project?.id ?? null, siteSource: hasGps ? "crm" : "manual",
    projectContractValue: src.project?.contract_value ?? null,
  };
  return { snap, errors, defaults };
}

// ------------------------------------------------------------------ الإجراءات
function docNoFor(phone: string, now: Date, suffix = ""): string {
  const mon = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][now.getUTCMonth()];
  return `CON-${phone || "0000000000"}-${mon}${now.getUTCFullYear()}${suffix}`;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!(await checkAdminToken(body.adminToken))) return json({ error: "الجلسة منتهية أو الصفحة للأدمن فقط" }, 401);

  try {
    const action = body.action;

    if (action === "pd-overview") {
      const { data: opps, error } = await sb.from("opportunities")
        .select("id, name, stage, customer_id, estimated_value, estimated_capacity, stage_changed_at, project_type")
        .eq("stage", "won").order("stage_changed_at", { ascending: false }).limit(200);
      if (error) throw error;
      const custIds = [...new Set((opps || []).map((o: any) => o.customer_id))];
      const oppIds = (opps || []).map((o: any) => o.id);
      const [{ data: custs }, { data: projs }, { data: docs }] = await Promise.all([
        custIds.length ? sb.from("customers").select("id, name, phone").in("id", custIds) : Promise.resolve({ data: [] as any[] }),
        oppIds.length ? sb.from("projects").select("id, opportunity_id, project_number, contract_value, status").in("opportunity_id", oppIds) : Promise.resolve({ data: [] as any[] }),
        sb.from("pd_documents").select("id, doc_type, doc_no, status, opportunity_id, customer_id, issued_at, signed_on").order("issued_at", { ascending: false }).limit(300),
      ]);
      const cMap = new Map((custs || []).map((c: any) => [c.id, c]));
      const pMap = new Map((projs || []).map((p: any) => [p.opportunity_id, p]));
      const items = (opps || []).map((o: any) => ({
        ...o, customer: cMap.get(o.customer_id) || null, project: pMap.get(o.id) || null,
        docs: (docs || []).filter((d: any) => d.opportunity_id === o.id),
      }));
      return json({ ok: true, items, recent: (docs || []).slice(0, 50) });
    }

    if (action === "pd-prepare") {
      const src = await gather(Number(body.opportunityId), body.quoteId ? Number(body.quoteId) : undefined);
      const a = assemble(src, body.inputs, "PREVIEW", new Date().toISOString());
      const quotes = src.quotes.map((q: any) => ({ id: q.id, ref_code: q.ref_code, revision_no: q.revision_no, hp: q.hp, final_total: q.final_total, created_at: q.created_at }));
      const q = src.quote ? parseQuote(src.quote) : null;
      const projectValueDiff = q && src.project?.contract_value != null
        ? round2(num(src.project.contract_value) - q.commercial.total) : null;
      return json({
        ok: true, errors: a.errors, defaults: a.defaults, quotes,
        view: {
          customer: { id: src.customer.id, name: src.customer.name, type: src.customer.customer_type, phone: src.customer.phone,
            cr: src.customer.commercial_registration, vat: src.customer.vat_number },
          isCompany: !(src.customer.customer_type == null || src.customer.customer_type === "" || src.customer.customer_type === "individual" || src.customer.customer_type === "فرد"),
          identityPresent: !!src.identity,
          site: src.site ? { hasGps: src.site.gps_lat != null && src.site.gps_lng != null, hasLink: !!src.site.google_maps_link, address: src.site.location_address } : null,
          project: src.project, crmMilestones: src.milestones,
          quote: q, projectValueDiff, company: companyView(src.company),
        },
      });
    }

    if (action === "pd-issue") {
      const oppId = Number(body.opportunityId), quoteId = Number(body.quoteId);
      if (!oppId || !quoteId) return json({ error: "opportunityId و quoteId مطلوبان" }, 400);
      const src = await gather(oppId, quoteId);
      const now = new Date();
      const base = docNoFor(localPhone(src.customer.phone), now);
      const a = assemble(src, body.inputs, base, now.toISOString());
      if (!a.snap) return json({ ok: false, errors: a.errors }, 200);

      // عقد قائم لنفس الفرصة؟
      const { data: existing } = await sb.from("pd_documents").select("id, doc_no, status").eq("opportunity_id", oppId)
        .eq("doc_type", "contract").neq("status", "void");
      const signed = (existing || []).find((d: any) => d.status === "signed");
      if (signed) return json({ ok: false, errors: [{ field: "existing", msg: `يوجد عقد موقّع ${signed.doc_no}. ألغِه صراحة أولاً إن كنت تريد استبداله` }] });
      if ((existing || []).length && !body.replaceExisting) {
        return json({ ok: false, needsConfirm: true, message: `يوجد عقد صادر غير موقّع (${existing![0].doc_no}). سيُلغى ويُستبدل بالجديد. أكّد للمتابعة.` });
      }

      let docNo = base;
      const { data: clash } = await sb.from("pd_documents").select("id").eq("doc_no", docNo).maybeSingle();
      if (clash) {
        const hhmm = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Riyadh" }).format(now).replace(":", "");
        docNo = `${base}-${hhmm}`;
      }
      a.snap.docNo = docNo;
      const hash = await canonicalHash(a.snap);
      const row = {
        doc_type: "contract", doc_no: docNo, status: "issued", customer_id: src.customer.id, opportunity_id: oppId,
        project_id: src.project?.id ?? null, quote_id: quoteId, template_key: TEMPLATE_KEY, template_version: TEMPLATE_VERSION,
        snapshot: a.snap, snapshot_hash: hash, issued_by: "admin", issued_at: now.toISOString(),
      };
      const { data: ins, error: iErr } = await sb.from("pd_documents").insert(row).select("id, doc_no").single();
      if (iErr) throw iErr;
      for (const d of existing || []) {
        await sb.from("pd_documents").update({ status: "void", void_reason: `استُبدل بالعقد ${docNo}`, voided_at: now.toISOString() }).eq("id", d.id);
      }
      await audit("create", ins.id, ins.doc_no, { doc_type: "contract", template: TEMPLATE_VERSION, hash });
      return json({ ok: true, id: ins.id, docNo: ins.doc_no, hash });
    }

    if (action === "pd-docs") {
      let q = sb.from("pd_documents").select("id, doc_type, doc_no, status, customer_id, opportunity_id, issued_at, signed_on, void_reason, template_version, snapshot_hash")
        .order("issued_at", { ascending: false }).limit(200);
      if (body.opportunityId) q = q.eq("opportunity_id", Number(body.opportunityId));
      const { data, error } = await q;
      if (error) throw error;
      return json({ ok: true, docs: data || [] });
    }

    if (action === "pd-render") {
      const { data, error } = await sb.from("pd_documents").select("*").eq("id", Number(body.docId)).maybeSingle();
      if (error) throw error;
      if (!data) return json({ error: "المستند غير موجود" }, 404);
      const intact = (await canonicalHash(data.snapshot)) === data.snapshot_hash;
      let html = renderDocument(data.snapshot as Snap);
      if (data.status === "void") html = html.replace("<body>", `<body><div style="color:#b42318;font-weight:700;text-align:center;border:2px solid #b42318;padding:6px;margin-bottom:8px">ملغى — ${String(data.void_reason || "").replace(/</g, "&lt;")}</div>`);
      await audit("view", data.id, data.doc_no, null);
      return json({ ok: true, html, intact, meta: { id: data.id, doc_no: data.doc_no, status: data.status, issued_at: data.issued_at, signed_on: data.signed_on } });
    }

    if (action === "pd-status") {
      const id = Number(body.docId), status = str(body.status);
      const { data: cur } = await sb.from("pd_documents").select("id, doc_no, status").eq("id", id).maybeSingle();
      if (!cur) return json({ error: "المستند غير موجود" }, 404);
      if (cur.status === "void") return json({ error: "المستند ملغى ولا يُعدَّل" }, 409);
      let patch: any;
      if (status === "signed") {
        const on = str(body.signedOn);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return json({ error: "تاريخ التوقيع مطلوب (YYYY-MM-DD)" }, 400);
        patch = { status: "signed", signed_on: on, signed_note: str(body.note) || null };
      } else if (status === "void") {
        const reason = str(body.reason);
        if (!reason) return json({ error: "سبب الإلغاء مطلوب" }, 400);
        patch = { status: "void", void_reason: reason, voided_at: new Date().toISOString() };
      } else return json({ error: "حالة غير معروفة" }, 400);
      const { error } = await sb.from("pd_documents").update(patch).eq("id", id);
      if (error) throw error;
      await audit("update", id, cur.doc_no, { status });
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
