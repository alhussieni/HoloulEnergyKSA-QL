// HoloulEnergy — supply-api Edge Function
// Project supply tracking: what was supplied to the project (lines), serial numbers per unit,
// readiness before invoicing, and lock-after-invoice. NEW projects only (projects.supply_tracking).
//
// Auth = same signed HMAC session tokens as compute-quote / crm-api / costs-api (SESSION_SECRET):
//   adminToken            -> super admin (everything, incl. editing after the invoice)
//   token (rep:<user>)    -> rep / warehouse, requires reps.permissions.supply === true
//   token (viewer:<user>) -> only role "accountant" is allowed
// All business rules live in the database (functions + triggers); this layer authenticates,
// validates input, maps errors to Arabic, and never trusts the client for roles.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

// ---------- token helpers (identical scheme to the other functions) ----------
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
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function readToken(token: unknown): Promise<{ sub: string; ver: number; exp: number } | null> {
  if (typeof token !== "string" || token.split(".").length !== 2) return null;
  const [payloadB64, sig] = token.split(".");
  if (!safeEq(await hmacSign(sessionSecret(), payloadB64), sig)) return null;
  try {
    const p = JSON.parse(b64urlToString(payloadB64));
    if (!p.exp || p.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof p.sub !== "string") return null;
    return p;
  } catch { return null; }
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

type Role = "admin" | "rep" | "accountant";
type Auth = { role: Role; actor: string; isAdmin: boolean };

async function authenticate(body: any): Promise<Auth | null> {
  if (body.adminToken) {
    const p = await readToken(body.adminToken);
    if (p && p.sub === "admin") {
      const { data, error } = await supabase.from("admin_secret").select("session_version").eq("id", 1).single();
      if (!error && data && p.ver === data.session_version) return { role: "admin", actor: "admin", isAdmin: true };
    }
  }
  if (body.token) {
    const p = await readToken(body.token);
    if (p && p.sub.startsWith("rep:")) {
      const { data, error } = await supabase.from("reps")
        .select("username, active, session_version, permissions").eq("username", p.sub.slice(4)).single();
      if (!error && data && data.active && p.ver === data.session_version && (data.permissions as any)?.supply === true) {
        return { role: "rep", actor: data.username, isAdmin: false };
      }
    }
    if (p && p.sub.startsWith("viewer:")) {
      const { data, error } = await supabase.from("viewers")
        .select("username, active, session_version, role").eq("username", p.sub.slice(7)).single();
      if (!error && data && data.active && p.ver === data.session_version && data.role === "accountant") {
        return { role: "accountant", actor: data.username, isAdmin: false };
      }
    }
  }
  return null;
}

// ---------- validation helpers ----------
class BadRequest extends Error { code?: string; detail?: unknown; constructor(m: string, code?: string, detail?: unknown) { super(m); this.code = code; this.detail = detail; } }
const bad = (m: string, code?: string, detail?: unknown): never => { throw new BadRequest(m, code, detail); };
const must = <T>(r: { data: T; error: any }): T => { if (r.error) throw r.error; return r.data; };
const idOf = (v: unknown, label: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) bad(`${label} غير صالح`);
  return n;
};
const intOf = (v: unknown, label: string, min: number, max: number): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) bad(`${label} لازم يكون رقم صحيح بين ${min} و ${max}`);
  return n;
};
const textOrNull = (v: unknown, max = 300): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

// Manual entry from an Arabic keyboard: map Arabic-Indic / Persian / full-width digits to ASCII.
function asciiDigits(s: string): string {
  return s
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06F0))
    .replace(/[\uFF10-\uFF19]/g, (c) => String(c.charCodeAt(0) - 0xFF10));
}
function cleanSerial(raw: unknown): string {
  // strip zero-width / bidi marks and control chars, collapse inner whitespace
  const s = asciiDigits(String(raw ?? ""))
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s;
}
// Same rule as the invoice form (crm.html) and the invoice `SN:` extraction: no spaces or / , ; in a serial.
const SERIAL_RE = /^[A-Za-z0-9._\-]{3,60}$/;
function assertSerialFormat(s: string): void {
  if (!SERIAL_RE.test(s)) bad(`الرقم التسلسلي "${s.slice(0, 40)}" غير صالح — حروف إنجليزية وأرقام و . _ - فقط، بدون مسافات، من 3 إلى 60 حرف`, "BAD_SERIAL_FORMAT");
}
function parseSerials(input: unknown): string[] {
  const parts = Array.isArray(input) ? input.map(String) : String(input ?? "").split(/[\n\r,;\t\u060C\u061B]+/);
  const out = parts.map(cleanSerial).filter(Boolean);
  if (!out.length) bad("اكتب رقمًا تسلسليًا واحدًا على الأقل", "NO_SERIALS");
  if (out.length > 500) bad("الحد الأقصى 500 رقم تسلسلي في المرة الواحدة");
  out.forEach(assertSerialFormat);
  return out;
}

// ---------- DB error -> Arabic ----------
function parseDetail(d: unknown): any { try { return typeof d === "string" ? JSON.parse(d) : d; } catch { return null; } }
function mapDbError(err: any): BadRequest | null {
  const code = String(err?.message || "").trim();
  const det = parseDetail(err?.details);
  const M: Record<string, string> = {
    LINE_NOT_FOUND: "بند التوريد غير موجود",
    SERIAL_NOT_FOUND: "الرقم التسلسلي غير موجود",
    PROJECT_NOT_FOUND: "المشروع غير موجود",
    INVOICE_NOT_FOUND: "الفاتورة غير موجودة",
    INVOICE_PROJECT_MISMATCH: "الفاتورة غير مرتبطة بهذا المشروع",
    LINE_NOT_SERIAL: "هذا البند يُسجَّل بالكمية فقط، وليس بأرقام تسلسلية",
    LINE_NOT_QTY: "هذا البند يُسجَّل بأرقام تسلسلية، وليس بالكمية",
    NO_SERIALS: "اكتب رقمًا تسلسليًا واحدًا على الأقل",
    EMPTY_SERIAL: "الرقم التسلسلي فارغ",
    QTY_ZERO: "الكمية لازم تكون مختلفة عن صفر",
    BELOW_ZERO: "الكمية المسلَّمة لا يمكن أن تقل عن صفر",
    REASON_REQUIRED: "سبب التعديل إجباري بعد إصدار الفاتورة",
    BAD_TRANSITION: "لا يمكن نقل القطعة من حالتها الحالية إلى هذه الحالة",
    ALREADY_INVOICED: "هذا الرقم التسلسلي مفوتَر ولا يمكن حذفه",
    ALREADY_LOCKED: "سجل توريد هذا المشروع مقفل بالفعل بعد إصدار الفاتورة",
    TRACKING_DISABLED: "تتبّع التوريد غير مفعّل لهذا المشروع (المشاريع القديمة خارج النطاق)",
    LOCKED_AFTER_INVOICE: "تم إصدار الفاتورة وقُفل سجل التوريد — التعديل متاح للسوبر أدمن فقط",
  };
  if (code === "EXCEEDS_PLANNED") {
    return new BadRequest(`العدد يتجاوز الكمية المخططة (المخطط ${det?.planned ?? "؟"}، المسجّل ${det?.current ?? "؟"}، المطلوب إضافته ${det?.adding ?? "؟"})`, code, det);
  }
  if (code === "DUPLICATE_SERIALS") {
    const parts: string[] = [];
    if (det?.in_input?.length) parts.push(`مكررة داخل المدخلات: ${det.in_input.join("، ")}`);
    if (det?.in_project_serials?.length) parts.push(`مسجّلة قبل كده في توريدات المشاريع: ${det.in_project_serials.map((x: any) => x.serial).join("، ")}`);
    if (det?.in_assets?.length) parts.push(`موجودة في سجل الأصول: ${det.in_assets.join("، ")}`);
    if (det?.in_warranty?.length) parts.push(`لها شهادة ضمان فعّالة: ${det.in_warranty.join("، ")}`);
    return new BadRequest(`أرقام تسلسلية مكررة — لم يُسجَّل أي رقم. ${parts.join(" | ")}`, code, det);
  }
  if (code === "NOT_READY") {
    return new BadRequest("التوريد غير مكتمل — لا يمكن إصدار الفاتورة قبل اكتمال الأرقام والكميات", code, parseDetail(err?.details));
  }
  if (M[code]) return new BadRequest(M[code], code, det ?? undefined);
  return null;
}

async function rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) { const m = mapDbError(error); if (m) throw m; throw error; }
  return data as T;
}

async function logAudit(a: Auth, action: string, entityId: number | null, label: string | null, oldV: unknown, newV: unknown) {
  try {
    await supabase.from("audit_log").insert({
      actor: a.actor, actor_role: a.role, action_type: action, entity_type: "project_supply",
      entity_id: entityId, entity_label: label, old_value: oldV ?? null, new_value: newV ?? null,
    });
  } catch { /* never break the main action over a logging failure */ }
}

async function loadProject(projectId: number) {
  const p = must(await supabase.from("projects")
    .select("id, project_number, status, supply_tracking, supply_locked_at").eq("id", projectId).maybeSingle());
  if (!p) bad("المشروع غير موجود");
  return p as any;
}
async function loadLine(lineId: number) {
  const l = must(await supabase.from("project_supply_lines").select("*").eq("id", lineId).maybeSingle());
  if (!l) bad("بند التوريد غير موجود", "LINE_NOT_FOUND");
  return l as any;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// Turn invoice rows that match a supply line into what the invoice trigger expects:
//  - serial-tracked product: one row per serial, qty 1, name "... / SN:<serial>"
//  - quantity-tracked product (e.g. panels): invoice qty must equal the delivered quantity (if the line is on the invoice)
function expandSupplyItems(items: any[], lines: any[]): any[] {
  let out: any[] = items.map((i) => ({ ...i }));
  for (const line of lines) {
    const code = String(line.catalog_code || "");
    if (!code) continue;
    const isMatch = (it: any) => it && it.type === "product" && String(it.code) === code;
    const total = out.filter(isMatch).reduce((s, it) => s + (Number(it.qty) || 0), 0);
    const present = out.some(isMatch);
    if (line.tracking_mode === "serial") {
      const serials: string[] = line.serials || [];
      if (!present) bad(`بند التوريد "${line.name}" غير موجود في بنود الفاتورة — أضفه من المنتجات (${serials.length} وحدة)`, "LINE_MISSING_ON_INVOICE");
      if (total !== serials.length) bad(`كمية "${line.name}" في الفاتورة (${total}) لا تساوي عدد الأرقام التسلسلية المسجّلة في التوريد (${serials.length})`, "QTY_MISMATCH");
      let k = 0;
      out = out.flatMap((it) => {
        if (!isMatch(it)) return [it];
        const q = Number(it.qty);
        if (!Number.isInteger(q) || q < 1) bad(`كمية "${line.name}" لازم تكون رقم صحيح`);
        const base = String(it.name || line.name).replace(/\s*\/\s*SN:.*$/i, "");
        const unit = Number(it.unitPrice) || 0, disc = Number(it.discount) || 0;
        const perDisc = Math.floor((disc / q) * 100) / 100;
        const rows: any[] = [];
        for (let j = 0; j < q; j++) {
          const sn = serials[k++];
          const d = j === q - 1 ? round2(disc - perDisc * (q - 1)) : perDisc;
          rows.push({ type: "product", code, name: `${base} / SN:${sn}`.slice(0, 300), qty: 1, unitPrice: unit, discount: d, lineTotal: round2(unit - d), serial: sn });
        }
        return rows;
      });
    } else if (present && total !== Number(line.delivered)) {
      bad(`كمية "${line.name}" في الفاتورة (${total}) لا تساوي الكمية المسلَّمة للمشروع (${line.delivered})`, "QTY_MISMATCH");
    }
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  const action = String(body.action || "");

  const auth = await authenticate(body);
  if (!auth) return json({ error: "الجلسة منتهية أو لا تملك صلاحية التوريدات، الرجاء تسجيل الدخول مجددًا" }, 401);

  try {
    // ---- read: everything the project's supply tab needs, in one call ----
    if (action === "supply-project") {
      const pid = idOf(body.projectId, "projectId");
      const project = await loadProject(pid);
      const [lines, serials, readiness] = await Promise.all([
        supabase.from("project_supply_lines_v").select("*").eq("project_id", pid).order("id"),
        supabase.from("project_serials")
          .select("id, line_id, serial_number, status, delivered_at, installed_at, invoice_id, recorded_by, notes, created_at")
          .eq("project_id", pid).order("id"),
        supabase.rpc("supply_readiness", { p_project_id: pid }),
      ]);
      if (readiness.error) throw readiness.error;
      return json({ ok: true, project, lines: must(lines) || [], serials: must(serials) || [], readiness: readiness.data, canAdminEdit: auth.isAdmin });
    }

    // ---- read: what can be added as a supply line ----
    if (action === "supply-catalog") {
      const [prods, cfg] = await Promise.all([
        supabase.from("products").select("product_code, name_ar, brand, family, category, requires_serial, status").eq("status", "active").order("product_code"),
        supabase.from("pricing_config").select("data").limit(1).maybeSingle(),
      ]);
      const panels = ((cfg.data as any)?.data?.panels || []).filter((p: any) => p && p.visible !== false)
        .map((p: any) => ({ brand: p.brand, power: p.power, model: p.model || null }));
      return json({ ok: true, products: must(prods) || [], panels });
    }

    if (action === "supply-events") {
      const pid = idOf(body.projectId, "projectId");
      const limit = Math.min(Math.max(Number(body.limit) || 200, 1), 1000);
      const ev = must(await supabase.from("supply_events").select("*").eq("project_id", pid)
        .order("id", { ascending: false }).limit(limit));
      return json({ ok: true, events: ev || [] });
    }

    if (action === "supply-readiness") {
      const pid = idOf(body.projectId, "projectId");
      return json({ ok: true, readiness: await rpc("supply_readiness", { p_project_id: pid }) });
    }

    // ---- lines ----
    if (action === "supply-add-line") {
      const pid = idOf(body.projectId, "projectId");
      const planned = intOf(body.plannedQty, "الكمية المخططة", 1, 100000);
      const kind = String(body.kind || "product");
      const row: Record<string, unknown> = { project_id: pid, planned_qty: planned, notes: textOrNull(body.notes, 500), created_by: auth.actor };

      if (kind === "product") {
        const code = String(body.productCode || "").trim();
        if (!code) bad("اختر الصنف");
        const prod = must(await supabase.from("products").select("product_code, name_ar, brand, requires_serial").eq("product_code", code).maybeSingle());
        if (!prod) bad("الصنف غير موجود في الكتالوج");
        Object.assign(row, {
          tracking_mode: (prod as any).requires_serial ? "serial" : "qty",
          product_code: (prod as any).product_code, name: (prod as any).name_ar, brand: (prod as any).brand || null,
        });
      } else if (kind === "panel") {
        const cfg = must(await supabase.from("pricing_config").select("data").limit(1).maybeSingle()) as any;
        const power = Number(body.power);
        const brand = String(body.brand || "").trim().toLowerCase();
        const panel = (cfg?.data?.panels || []).find((p: any) => String(p.brand || "").trim().toLowerCase() === brand && Number(p.power) === power);
        if (!panel) bad("اللوح غير موجود في كتالوج الألواح");
        Object.assign(row, {
          tracking_mode: "qty", product_code: `PANEL-${panel.brand}-${panel.power}W`,
          name: `لوح شمسي ${panel.brand} ${panel.power}W`, brand: panel.brand, model: panel.model || textOrNull(body.model, 100),
          power_w: Number(panel.power),
        });
      } else if (kind === "custom") {
        const name = textOrNull(body.name, 200);
        if (!name) bad("اكتب اسم البند");
        Object.assign(row, { tracking_mode: "qty", name, brand: textOrNull(body.brand, 100), model: textOrNull(body.model, 100) });
      } else bad("نوع البند غير معروف");

      const line = must(await supabase.from("project_supply_lines").insert(row).select().maybeSingle()) as any;
      await logAudit(auth, "add_supply_line", pid, line.name, null, { planned_qty: planned, tracking_mode: line.tracking_mode });
      return json({ ok: true, line });
    }

    if (action === "supply-update-line") {
      const lineId = idOf(body.lineId, "lineId");
      const line = await loadLine(lineId);
      const patch: Record<string, unknown> = {};
      if (body.plannedQty != null) {
        const planned = intOf(body.plannedQty, "الكمية المخططة", 1, 100000);
        const v = must(await supabase.from("project_supply_lines_v").select("delivered_qty").eq("id", lineId).maybeSingle()) as any;
        if (planned < Number(v?.delivered_qty || 0)) bad(`الكمية المخططة لا يمكن أن تقل عن المسجّل فعلاً (${v.delivered_qty})`);
        patch.planned_qty = planned;
      }
      if ("notes" in body) patch.notes = textOrNull(body.notes, 500);
      if ("model" in body) patch.model = textOrNull(body.model, 100);
      if (!Object.keys(patch).length) bad("لا توجد تغييرات");
      const { data, error } = await supabase.from("project_supply_lines").update(patch).eq("id", lineId).select().maybeSingle();
      if (error) { const m = mapDbError(error); if (m) throw m; throw error; }
      await logAudit(auth, "update_supply_line", line.project_id, line.name, { planned_qty: line.planned_qty }, patch);
      return json({ ok: true, line: data });
    }

    if (action === "supply-delete-line") {
      const lineId = idOf(body.lineId, "lineId");
      const line = await loadLine(lineId);
      const [{ count: ev }, { count: se }] = await Promise.all([
        supabase.from("supply_events").select("id", { count: "exact", head: true }).eq("line_id", lineId),
        supabase.from("project_serials").select("id", { count: "exact", head: true }).eq("line_id", lineId),
      ]);
      if ((ev || 0) > 0 || (se || 0) > 0) bad("لا يمكن حذف بند عليه حركات توريد مسجّلة — عدّل الكمية المخططة بدل الحذف");
      const { error } = await supabase.from("project_supply_lines").delete().eq("id", lineId);
      if (error) { const m = mapDbError(error); if (m) throw m; throw error; }
      await logAudit(auth, "delete_supply_line", line.project_id, line.name, { planned_qty: line.planned_qty }, null);
      return json({ ok: true });
    }

    // ---- serials / quantities ----
    if (action === "supply-add-serials") {
      const lineId = idOf(body.lineId, "lineId");
      const serials = parseSerials(body.serials);
      const r = await rpc("supply_add_serials", { p_line_id: lineId, p_serials: serials, p_actor: auth.actor, p_actor_role: auth.role });
      return json({ ok: true, result: r });
    }

    if (action === "supply-record-qty") {
      const lineId = idOf(body.lineId, "lineId");
      const qty = intOf(body.qty, "الكمية", -100000, 100000);
      const r = await rpc("supply_record_qty", { p_line_id: lineId, p_qty: qty, p_actor: auth.actor, p_actor_role: auth.role, p_note: textOrNull(body.note, 300) });
      return json({ ok: true, result: r });
    }

    if (action === "supply-edit-serial") {
      const serialId = idOf(body.serialId, "serialId");
      const serial = cleanSerial(body.serial);
      if (!serial) bad("الرقم التسلسلي فارغ");
      assertSerialFormat(serial);
      // locked projects: the DB requires the explicit override flag; only the super admin may set it
      const sr = must(await supabase.from("project_serials").select("project_id").eq("id", serialId).maybeSingle()) as any;
      if (!sr) bad("الرقم التسلسلي غير موجود");
      const proj = await loadProject(sr.project_id);
      const locked = !!proj.supply_locked_at;
      if (locked && !auth.isAdmin) bad("تم إصدار الفاتورة وقُفل سجل التوريد — التعديل متاح للسوبر أدمن فقط", "LOCKED_AFTER_INVOICE");
      const r = await rpc("supply_edit_serial", {
        p_serial_id: serialId, p_new_serial: serial, p_actor: auth.actor, p_actor_role: auth.role,
        p_reason: textOrNull(body.reason, 300), p_admin_override: locked && auth.isAdmin,
      });
      return json({ ok: true, result: r });
    }

    if (action === "supply-remove-serial") {
      const serialId = idOf(body.serialId, "serialId");
      const r = await rpc("supply_remove_serial", { p_serial_id: serialId, p_actor: auth.actor, p_actor_role: auth.role, p_reason: textOrNull(body.reason, 300) });
      return json({ ok: true, result: r });
    }

    if (action === "supply-set-status") {
      const serialId = idOf(body.serialId, "serialId");
      const status = String(body.status || "");
      if (!["delivered", "installed", "returned"].includes(status)) bad("حالة غير صالحة");
      const r = await rpc("supply_set_serial_status", { p_serial_id: serialId, p_status: status, p_actor: auth.actor, p_actor_role: auth.role, p_reason: textOrNull(body.reason, 300) });
      return json({ ok: true, result: r });
    }

    // ---- project-level switch (super admin only) ----
    if (action === "supply-set-tracking") {
      if (!auth.isAdmin) return json({ error: "تفعيل/إيقاف تتبّع التوريد متاح للأدمن فقط" }, 403);
      const pid = idOf(body.projectId, "projectId");
      const enabled = body.enabled === true;
      const project = await loadProject(pid);
      if (project.supply_locked_at) bad("سجل التوريد مقفل بعد إصدار الفاتورة");
      if (!enabled) {
        const { count } = await supabase.from("project_supply_lines").select("id", { count: "exact", head: true }).eq("project_id", pid);
        if ((count || 0) > 0) bad("لا يمكن إيقاف التتبّع وعلى المشروع بنود توريد مسجّلة");
      }
      must(await supabase.from("projects").update({ supply_tracking: enabled }).eq("id", pid).select("id").maybeSingle());
      await logAudit(auth, "set_supply_tracking", pid, project.project_number, { supply_tracking: project.supply_tracking }, { supply_tracking: enabled });
      return json({ ok: true, supplyTracking: enabled });
    }

    // ---- invoice form: which of this customer's projects have a supply registry ----
    if (action === "supply-customer-projects") {
      const cid = idOf(body.customerId, "customerId");
      const projs = must(await supabase.from("projects").select("id, project_number, status, supply_tracking, supply_locked_at")
        .eq("customer_id", cid).eq("supply_tracking", true).order("id", { ascending: false })) as any[];
      const out: any[] = [];
      for (const p of projs || []) {
        const r = await rpc<any>("supply_readiness", { p_project_id: p.id });
        out.push({ id: p.id, project_number: p.project_number, status: p.status, locked: !!p.supply_locked_at, ready: r.ready, lines: (r.lines || []).length });
      }
      return json({ ok: true, projects: out });
    }

    // ---- issue the invoice FROM a project's supply registry ----
    // Validates readiness, expands serial-tracked lines to one invoice line per serial (qty 1, "/ SN:xxx" in the
    // name — that is how invoice-api / the invoice trigger read serials), forwards the request UNCHANGED to the
    // existing invoice-api (ZATCA logic untouched), then locks the supply registry to the issued invoice.
    if (action === "supply-create-invoice") {
      if (auth.role === "accountant") return json({ error: "إصدار الفواتير متاح للأدمن والمناديب فقط" }, 403);
      const pid = idOf(body.projectId, "projectId");
      const payload = (body.payload && typeof body.payload === "object") ? { ...body.payload } : bad("بيانات الفاتورة ناقصة");
      const project = await loadProject(pid);
      if (!project.supply_tracking) bad("تتبّع التوريد غير مفعّل لهذا المشروع", "TRACKING_DISABLED");
      if (project.supply_locked_at) bad("هذا المشروع صدرت له فاتورة بالفعل وسجل التوريد مقفل", "ALREADY_LOCKED");
      const proj2 = must(await supabase.from("projects").select("customer_id").eq("id", pid).maybeSingle()) as any;
      if (Number(payload.customerId) !== Number(proj2?.customer_id)) bad("العميل المختار في الفاتورة غير صاحب هذا المشروع");

      const readiness = await rpc<any>("supply_readiness", { p_project_id: pid });
      if (!readiness.ready) {
        const msg = (readiness.issues || []).map((i: any) => i.code === "COUNT_MISMATCH"
          ? `${i.name}: المسجّل ${i.delivered} من ${i.planned}` : i.code === "NO_LINES" ? "لا توجد بنود توريد" : i.code).join("، ");
        bad(`التوريد غير مكتمل — لا يمكن إصدار الفاتورة قبل اكتماله. ${msg}`, "NOT_READY", readiness.issues);
      }
      payload.items = expandSupplyItems(Array.isArray(payload.items) ? payload.items : [], readiness.lines || []);

      const fwd: Record<string, unknown> = { ...payload, action: "crm-create-pos-invoice" };
      if (body.adminToken) fwd.adminToken = body.adminToken; else fwd.token = body.token;
      delete (fwd as any).projectId;
      const res = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/invoice-api`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(fwd),
      });
      let inv: any; try { inv = await res.json(); } catch { throw new Error("رد غير متوقع من خدمة الفواتير"); }
      if (!res.ok || inv.error) return json({ error: inv.error || "تعذر إصدار الفاتورة" }, res.ok ? 400 : res.status);

      // invoice exists now (legal document) — lock the registry; if that fails, say so loudly and log it
      let supply: Record<string, unknown> = { linked: true };
      const { error: lockErr } = await supabase.rpc("supply_mark_invoiced", { p_project_id: pid, p_invoice_id: inv.invoice.id, p_actor: auth.actor, p_actor_role: auth.role });
      if (lockErr) {
        supply = { linked: false, warning: "تم إصدار الفاتورة لكن تعذّر ربطها وقفل سجل التوريد — راجع الأدمن لتنفيذ الربط يدويًا." };
        await logAudit(auth, "supply_link_failed", pid, inv.invoice.invoice_number, null, { invoice_id: inv.invoice.id, error: String(lockErr.message || lockErr) });
      } else {
        await logAudit(auth, "supply_invoiced", pid, inv.invoice.invoice_number, null, { invoice_id: inv.invoice.id });
      }
      return json({ ...inv, supply });
    }

    // ---- repair: link an already-issued invoice to a project's registry (super admin) ----
    if (action === "supply-link-invoice") {
      if (!auth.isAdmin) return json({ error: "متاح للأدمن فقط" }, 403);
      const pid = idOf(body.projectId, "projectId"), iid = idOf(body.invoiceId, "invoiceId");
      const r = await rpc("supply_mark_invoiced", { p_project_id: pid, p_invoice_id: iid, p_actor: auth.actor, p_actor_role: auth.role });
      await logAudit(auth, "supply_invoiced", pid, null, null, { invoice_id: iid, manual: true });
      return json({ ok: true, result: r });
    }

    // ---- grant / revoke the "supply" permission for a rep (super admin only) ----
    // Kept out of compute-quote's admin-save-rep on purpose (it whitelists 4 keys); the DB trigger
    // reps_preserve_supply_perm keeps this key alive when that function rewrites reps.permissions.
    if (action === "supply-set-rep-access") {
      if (!auth.isAdmin) return json({ error: "متاح للأدمن فقط" }, 403);
      const repId = idOf(body.repId, "repId");
      const enabled = body.enabled === true;
      const rep = must(await supabase.from("reps").select("id, username, permissions").eq("id", repId).maybeSingle()) as any;
      if (!rep) bad("المندوب غير موجود");
      const perms = { ...(rep.permissions || {}), supply: enabled };
      must(await supabase.from("reps").update({ permissions: perms }).eq("id", repId).select("id").maybeSingle());
      await logAudit(auth, "set_rep_supply_access", repId, rep.username, { supply: !!rep.permissions?.supply }, { supply: enabled });
      return json({ ok: true, enabled });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message, code: err.code, detail: err.detail }, 400);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
