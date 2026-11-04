// HoloulEnergy — finance-extras Edge Function (ADMIN ONLY)
// أعمال إضافية متفق عليها مع العميل أثناء التنفيذ (أمر تغيير): بتزوّد قيمة التعاقد وتتسجّل بتفاصيلها وإقرار العميل، وممكن تتلغى.
// actions: extras-list ({projectId} | {customerId}) | extras-add | extras-undo
// الحساب الفعلي في دوال قاعدة البيانات finance_add_extra / finance_undo_extra (migration 0053).


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
const must = <T>(r: { data: T; error: any }): T => { if (r.error) throw r.error; return r.data; };


const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateOrNull = (v: unknown, label = "التاريخ"): string | null => {
  if (v == null || v === "") return null;
  const s = String(v);
  if (!DATE_RE.test(s) || isNaN(Date.parse(s))) bad(`${label} غير صالح (YYYY-MM-DD)`);
  return s;
};
const txt = (v: unknown, max: number) => (v == null || String(v).trim() === "" ? null : String(v).trim().slice(0, max));
const money = (v: unknown, label: string): number => {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) bad(`${label} غير صالح`);
  return Math.round(n * 100) / 100;
};
const idOf = (v: unknown, msg: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) bad(msg);
  return n;
};
// أخطاء دوال قاعدة البيانات اللي إحنا رفعناها (P0001) أو التحقق (22xxx/23xxx) = غلط الطالب → 400
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
    // أعمال إضافية مشروع (أو كل مشاريع عميل). بترجع قايمة + إجمالي لكل مشروع.
    if (action === "extras-list") {
      let ids: number[];
      if (body.customerId) {
        const ps = must(await supabase.from("projects").select("id").eq("customer_id", idOf(body.customerId, "رقم العميل غير صالح"))) as any[];
        ids = ps.map((p) => p.id);
      } else ids = [idOf(body.projectId, "رقم المشروع غير صالح")];
      const rows = ids.length ? must(await supabase.from("project_extras").select("*").in("project_id", ids).order("extra_date").order("id")) as any[] : [];
      const total: Record<string, number> = {};
      for (const r of rows) total[String(r.project_id)] = Math.round(((total[String(r.project_id)] || 0) + Number(r.amount)) * 100) / 100;
      return json({ ok: true, extras: rows, totals: total });
    }

    if (action === "extras-add") {
      const projectId = idOf(body.projectId, "رقم المشروع غير صالح");
      const title = txt(body.title, 200); if (!title) bad("اكتب عنوان الأعمال الإضافية");
      const details = txt(body.details, 2000);
      const amount = money(body.amount, "قيمة الأعمال الإضافية");
      const extraDate = dateOrNull(body.extraDate, "تاريخ الأعمال");
      const approvedOn = dateOrNull(body.approvedOn, "تاريخ موافقة العميل");
      const note = txt(body.approvalNote, 300);
      const id = await rpc("finance_add_extra", { p_project: projectId, p_title: title, p_details: details, p_amount: amount, p_date: extraDate, p_approved: approvedOn, p_note: note });
      await logAudit("add_extra", "project", projectId, title, null, { extra_id: id, amount, approved_on: approvedOn });
      return json({ ok: true, extraId: id });
    }

    if (action === "extras-undo") {
      const id = idOf(body.extraId, "رقم الأعمال الإضافية غير صالح");
      const { data: old } = await supabase.from("project_extras").select("project_id, title, amount").eq("id", id).maybeSingle();
      await rpc("finance_undo_extra", { p_id: id });
      await logAudit("undo_extra", "project", old?.project_id ?? null, old?.title || null, old, null);
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
