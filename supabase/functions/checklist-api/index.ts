// HoloulEnergy — checklist-api Edge Function (فحص التشغيل والتسليم)
// Actions: chk-get | chk-save | chk-submit | chk-approve (admin) | chk-reopen (admin) | chk-settings-get | chk-settings-set (admin) | chk-status
// الصلاحيات: الأدمن، أو موظف دوره فيه project.progress (مهندس موقع / مدير مشروع). الاعتماد وإعداد «إلزامي/غير إلزامي» للأدمن فقط.
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


function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function issueToken(sub: string, ver: number, ttlSeconds: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payloadB64 = b64urlFromBytes(new TextEncoder().encode(JSON.stringify({ sub, ver, exp })));
  return `${payloadB64}.${await hmacSign(sessionSecret(), payloadB64)}`;
}

type Who = { kind: "admin" } | { kind: "staff"; id: number; username: string; displayName: string; roles: string[]; perms: Set<string> };

async function permsOfRoles(roles: string[]): Promise<Set<string>> {
  if (!roles.length) return new Set();
  const rs = must(await supabase.from("app_roles").select("key, permissions").in("key", roles)) as any[];
  const s = new Set<string>();
  for (const r of rs) for (const p of (r.permissions || [])) s.add(p);
  return s;
}
async function authenticate(body: any): Promise<Who | null> {
  if (body.adminToken && (await checkAdminToken(body.adminToken))) return { kind: "admin" };
  if (body.token) {
    const p = await readToken(body.token);
    if (p && typeof p.sub === "string" && p.sub.startsWith("staff:")) {
      const { data } = await supabase.from("staff_accounts").select("id, username, display_name, active, session_version, roles").eq("username", p.sub.slice(6)).maybeSingle();
      if (data && data.active && p.ver === data.session_version) {
        return { kind: "staff", id: data.id, username: data.username, displayName: data.display_name, roles: data.roles || [], perms: await permsOfRoles(data.roles || []) };
      }
    }
  }
  return null;
}
const can = (w: Who, perm: string) => w.kind === "admin" || w.perms.has(perm);



const idOf = (v: unknown): number => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) bad("المشروع غير صالح"); return n; };
const who2 = (w: Who) => (w.kind === "admin" ? "admin" : `staff:${w.username}`);

async function projectInfo(id: number) {
  const { data } = await supabase.from("projects")
    .select("id, project_number, scope_type, id_system_type, status, panel_spec, inverter_spec, customers(name)").eq("id", id).maybeSingle();
  if (!data) bad("المشروع غير موجود");
  const p: any = data;
  return { id: p.id, project_number: p.project_number, scope_type: p.scope_type, id_system_type: p.id_system_type, status: p.status,
           panel_spec: p.panel_spec, inverter_spec: p.inverter_spec, customer_name: p.customers?.name || "" };
}
async function required(): Promise<boolean> {
  const { data } = await supabase.from("commissioning_settings").select("required").eq("id", 1).maybeSingle();
  return !!data?.required;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  try {
    const w = await authenticate(body);
    if (!w || !can(w, "project.progress")) return json({ error: "غير مصرّح" }, 401);
    const admin = w.kind === "admin";
    const a = body.action;

    if (a === "chk-settings-get") return json({ ok: true, required: await required(), isAdmin: admin });
    if (a === "chk-settings-set") {
      if (!admin) return json({ error: "للأدمن فقط" }, 403);
      must(await supabase.from("commissioning_settings").upsert({ id: 1, required: !!body.required, updated_at: new Date().toISOString(), updated_by: "admin" }));
      return json({ ok: true, required: !!body.required });
    }
    if (a === "chk-status") {
      const ids = (Array.isArray(body.projectIds) ? body.projectIds : []).map(Number).filter((n: number) => n > 0).slice(0, 500);
      const rows = ids.length ? must(await supabase.from("project_commissioning").select("project_id, status, ready, stops").in("project_id", ids)) as any[] : [];
      return json({ ok: true, required: await required(), items: rows });
    }

    const projectId = idOf(body.projectId);
    if (a === "chk-get") {
      const project = await projectInfo(projectId);
      const { data: row } = await supabase.from("project_commissioning").select("*").eq("project_id", projectId).maybeSingle();
      return json({ ok: true, project, checklist: row || null, required: await required(), isAdmin: admin, who: who2(w) });
    }
    const { data: cur } = await supabase.from("project_commissioning").select("*").eq("project_id", projectId).maybeSingle();

    if (a === "chk-save") {
      if (cur?.status === "approved") return json({ error: "الفحص معتمد ومقفول. اطلب من الأدمن إعادة فتحه" }, 409);
      const project = await projectInfo(projectId);
      const state = body.state && typeof body.state === "object" ? body.state : {};
      if (JSON.stringify(state).length > 400000) bad("حجم البيانات كبير");
      const stops = (Array.isArray(body.stops) ? body.stops : []).map((s: unknown) => String(s).slice(0, 300)).slice(0, 20);
      must(await supabase.from("project_commissioning").upsert({
        project_id: projectId, scope_type: project.scope_type, system_type: project.id_system_type, state, ready: !!body.ready, stops,
        status: "draft", submitted_at: null, filled_by: who2(w), updated_at: new Date().toISOString(),
      }));
      return json({ ok: true });
    }
    if (a === "chk-submit") {
      if (!cur) bad("احفظ الفحص أولًا");
      if (cur.status === "approved") return json({ error: "الفحص معتمد بالفعل" }, 409);
      if (!cur.ready || (cur.stops || []).length) bad("لا يمكن إرسال الفحص: فيه بنود ناقصة أو حالات ممنوع معها الاعتماد");
      must(await supabase.from("project_commissioning").update({ status: "submitted", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("project_id", projectId));
      return json({ ok: true });
    }
    if (a === "chk-approve") {
      if (!admin) return json({ error: "الاعتماد للأدمن فقط" }, 403);
      if (!cur || cur.status !== "submitted") bad("الفحص لازم يتبعت أولًا قبل الاعتماد");
      if ((cur.stops || []).length) bad("فيه حالات ممنوع معها اعتماد التشغيل");
      must(await supabase.from("project_commissioning").update({ status: "approved", approved_at: new Date().toISOString(), approved_by: "admin", updated_at: new Date().toISOString() }).eq("project_id", projectId));
      return json({ ok: true });
    }
    if (a === "chk-reopen") {
      if (!admin) return json({ error: "للأدمن فقط" }, 403);
      must(await supabase.from("project_commissioning").update({ status: "draft", approved_at: null, approved_by: null, submitted_at: null, updated_at: new Date().toISOString() }).eq("project_id", projectId));
      return json({ ok: true });
    }
    return json({ error: "unknown_action" }, 400);
  } catch (e: any) {
    return json({ error: e?.message || String(e) }, e instanceof BadRequest ? 400 : 500);
  }
});
