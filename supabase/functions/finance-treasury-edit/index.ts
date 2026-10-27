// HoloulEnergy — finance-treasury-edit Edge Function (ADMIN ONLY)
// تعديل حركات الخزنة (الحساب / التاريخ / المبلغ / المشروع / أمر الشراء / المرجع / الملاحظات) مع سجل تعديلات.
// التعديل نفسه بيتم جوه دالة Postgres واحدة ذرّية: finance_edit_entry.
// نفس توثيق باقي دوال المالية (توكن أدمن HMAC + session_version). actions: treasury-get-entry, treasury-edit-entry.

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

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
