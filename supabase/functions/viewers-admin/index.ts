// HoloulEnergy — viewers-admin Edge Function (ADMIN ONLY)
// Create / list / update / delete "viewer" accounts (read-only partners) from the
// CRM settings screen, with no SQL needed. Viewers log in through costs-api
// (viewer-login) and can only see the costs screens.
// Same admin token scheme as the finance-* functions (HMAC + session_version).

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
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
async function readToken(token: unknown): Promise<{ sub: string; ver: number; exp: number } | null> {
  if (typeof token !== "string" || token.split(".").length !== 2) return null;
  const [payloadB64, sig] = token.split(".");
  if ((await hmacSign(sessionSecret(), payloadB64)) !== sig) return null;
  try {
    const payload = JSON.parse(b64urlToString(payloadB64));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

async function checkAdminToken(token: unknown): Promise<boolean> {
  const p = await readToken(token);
  if (!p || p.sub !== "admin") return false;
  const { data, error } = await supabase.from("admin_secret").select("session_version").eq("id", 1).single();
  return !error && !!data && p.ver === data.session_version;
}
async function logAudit(actionType: string, id: number | null, label: string | null, newValue: unknown) {
  try {
    await supabase.from("audit_log").insert({
      actor: "admin", actor_role: "admin", action_type: actionType, entity_type: "viewer",
      entity_id: id, entity_label: label, old_value: null, new_value: newValue ?? null,
    });
  } catch { /* logging must never break the action */ }
}

class BadRequest extends Error {}
const bad = (m: string): never => { throw new BadRequest(m); };
const USER_RE = /^[A-Za-z0-9_.-]{3,30}$/;
const ROLES = ["viewer", "accountant"];

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
    if (action === "viewers-list") {
      const { data, error } = await supabase.from("viewers").select("id, username, display_name, active, role, created_at").order("id");
      if (error) throw error;
      return json({ ok: true, viewers: data || [] });
    }

    if (action === "viewers-save") {
      const displayName = String(body.displayName ?? "").trim().slice(0, 100);
      const password = body.password ? String(body.password) : "";
      if (password && password.length < 6) bad("كلمة المرور لازم تكون 6 خانات على الأقل");

      if (body.id) {
        const id = Number(body.id);
        if (!Number.isInteger(id) || id <= 0) bad("معرّف غير صالح");
        const update: Record<string, unknown> = {};
        if (displayName) update.display_name = displayName;
        if ("active" in body) update.active = !!body.active;
        if (body.role !== undefined) { if (!ROLES.includes(String(body.role))) bad("نوع الحساب غير صالح"); update.role = String(body.role); }
        if (password) {
          const { data: cur } = await supabase.from("viewers").select("session_version").eq("id", id).maybeSingle();
          if (!cur) bad("الحساب غير موجود");
          update.password_hash = await sha256Hex(password);
          update.session_version = (cur!.session_version || 1) + 1; // يفصل أي جلسة مفتوحة
        }
        if (!Object.keys(update).length) bad("مفيش تغيير مطلوب");
        const { error } = await supabase.from("viewers").update(update).eq("id", id);
        if (error) throw error;
        await logAudit("update_viewer", id, displayName || null, { active: update.active, password_changed: !!password });
        return json({ ok: true });
      }

      const username = String(body.username ?? "").trim();
      if (!USER_RE.test(username)) bad("اسم المستخدم حروف إنجليزية وأرقام فقط (3 إلى 30)، ممكن _ . -");
      const role = body.role === undefined || body.role === "" ? "viewer" : String(body.role);
      if (!ROLES.includes(role)) bad("نوع الحساب غير صالح");
      if (!displayName) bad("الاسم مطلوب");
      if (!password) bad("كلمة المرور مطلوبة");
      const { data, error } = await supabase.from("viewers")
        .insert({ username, display_name: displayName, role, password_hash: await sha256Hex(password) }).select("id").single();
      if (error) { if ((error as any).code === "23505") bad("اسم المستخدم ده مستخدم قبل كده"); throw error; }
      await logAudit("add_viewer", data.id, username, { display_name: displayName, role });
      return json({ ok: true, id: data.id });
    }

    if (action === "viewers-delete") {
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) bad("معرّف غير صالح");
      const { data: old } = await supabase.from("viewers").select("username").eq("id", id).maybeSingle();
      const { error } = await supabase.from("viewers").delete().eq("id", id);
      if (error) throw error;
      await logAudit("delete_viewer", id, old?.username || null, null);
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
