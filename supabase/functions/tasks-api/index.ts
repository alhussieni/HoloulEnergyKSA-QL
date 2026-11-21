// HoloulEnergy — tasks-api Edge Function (المهام + توزيع العملاء على المناديب)
//
// نفس نمط crm-api / checklist-api: بيتحقق من نفس توكنز HMAC (SESSION_SECRET) ومفيش login هنا.
//   body.adminToken → أدمن
//   body.token      → مندوب ("rep:<username>") أو موظف ("staff:<username>") — بيتعرف من الـ sub
//
// الصلاحيات:
//   أدمن                       : كل حاجة
//   موظف (app_roles)           : tasks.own (مهامه)، tasks.assign (يكلّف غيره)، tasks.view_all (لوحة الفريق)،
//                                sales.reassign (يوزّع عملاء)، sales.team.view (يتابع أداء الفريق)
//   مندوب                      : مهامه هو فقط + يعمل مهمة لنفسه
//
// Actions:
//   tasks-list-mine | tasks-list-all | tasks-create | tasks-update | tasks-set-status
//   tasks-reassign | tasks-delete | tasks-stats | tasks-assignable-users
//   tasks-performance | tasks-unassigned-customers | tasks-customers-by-rep | tasks-assign-customers | tasks-distribute-customers

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

// ---------- tokens (نفس باقي الدوال) ----------
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
    const payload = JSON.parse(b64urlToString(payloadB64));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

class BadRequest extends Error {}
class Forbidden extends Error {}
const bad = (m: string): never => { throw new BadRequest(m); };
const deny = (m: string): never => { throw new Forbidden(m); };
const must = <T>(r: { data: T; error: any }): T => { if (r.error) throw r.error; return r.data; };

// ---------- identity ----------
type Kind = "admin" | "rep" | "staff";
type Who = { kind: Kind; username: string; displayName: string; perms: Set<string> };

async function permsOfRoles(roles: string[]): Promise<Set<string>> {
  const s = new Set<string>();
  if (!roles.length) return s;
  const rs = must(await supabase.from("app_roles").select("key, permissions").in("key", roles)) as any[];
  for (const r of rs) for (const p of (r.permissions || [])) s.add(p);
  return s;
}
async function authenticate(body: any): Promise<Who | null> {
  if (body.adminToken) {
    const p = await readToken(body.adminToken);
    if (p && p.sub === "admin") {
      const { data } = await supabase.from("admin_secret").select("session_version").eq("id", 1).maybeSingle();
      if (data && data.session_version === p.ver) return { kind: "admin", username: "admin", displayName: "الأدمن", perms: new Set() };
    }
  }
  for (const t of [body.token, body.repToken, body.staffToken]) {
    const p = await readToken(t);
    if (!p || typeof p.sub !== "string") continue;
    if (p.sub.startsWith("rep:")) {
      const { data } = await supabase.from("reps").select("username, display_name, active, session_version").eq("username", p.sub.slice(4)).maybeSingle();
      if (data && data.active && data.session_version === p.ver) return { kind: "rep", username: data.username, displayName: data.display_name, perms: new Set() };
    } else if (p.sub.startsWith("staff:")) {
      const { data } = await supabase.from("staff_accounts").select("username, display_name, active, session_version, roles").eq("username", p.sub.slice(6)).maybeSingle();
      if (data && data.active && data.session_version === p.ver) {
        return { kind: "staff", username: data.username, displayName: data.display_name, perms: await permsOfRoles(data.roles || []) };
      }
    }
  }
  return null;
}
const isAdmin = (w: Who) => w.kind === "admin";
const canAssign = (w: Who) => isAdmin(w) || (w.kind === "staff" && w.perms.has("tasks.assign"));
const canViewAll = (w: Who) => isAdmin(w) || (w.kind === "staff" && w.perms.has("tasks.view_all"));
const canDistribute = (w: Who) => isAdmin(w) || (w.kind === "staff" && w.perms.has("sales.reassign"));
const canPerf = (w: Who) => canViewAll(w) || (w.kind === "staff" && w.perms.has("sales.team.view"));
const hasOwnTasks = (w: Who) => w.kind === "rep" || isAdmin(w) || w.perms.has("tasks.own") || canAssign(w) || canViewAll(w);
const actorName = (w: Who) => w.username;

async function logAudit(w: Who, actionType: string, entityType: string, entityId: number | null, label: string | null, oldV: unknown, newV: unknown) {
  try {
    await supabase.from("audit_log").insert({
      actor: actorName(w), actor_role: w.kind, action_type: actionType, entity_type: entityType,
      entity_id: entityId, entity_label: label, old_value: oldV ?? null, new_value: newV ?? null,
    });
  } catch { /* never break the primary action over a logging failure */ }
}

// ---------- validation helpers ----------
const TASK_TYPES = ["general", "call", "visit", "survey", "quote", "follow_up", "delivery", "maintenance", "other"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const STATUSES = ["open", "in_progress", "done", "cancelled"];
const intId = (v: unknown, what: string): number => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) bad(`${what} غير صالح`); return n; };
const optId = (v: unknown, what: string): number | null => (v == null || v === "" ? null : intId(v, what));
const str = (v: unknown, max: number): string | null => { if (v == null) return null; const s = String(v).trim(); return s ? s.slice(0, max) : null; };
function optDate(v: unknown, what: string): string | null {
  if (v == null || v === "") return null;
  const d = new Date(String(v));
  if (isNaN(d.getTime())) bad(`${what} غير صالح`);
  return d.toISOString();
}
const oneOf = (v: unknown, list: string[], def: string, what: string): string => {
  if (v == null || v === "") return def;
  if (!list.includes(String(v))) bad(`${what} غير صالح`);
  return String(v);
};
const dateOnly = (v: unknown): string | null => {
  if (v == null || v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) bad("تاريخ المتابعة غير صالح (YYYY-MM-DD)");
  return String(v);
};

async function resolveAssignee(username: unknown, kind?: unknown): Promise<{ username: string; kind: "rep" | "staff"; display_name: string }> {
  const u = String(username ?? "").trim();
  if (!u) bad("اختر الموظف المسؤول");
  let q = supabase.from("assignable_users").select("kind, username, display_name").eq("username", u);
  if (kind === "rep" || kind === "staff") q = q.eq("kind", kind);
  const rows = must(await q) as any[];
  if (!rows.length) bad("الموظف غير موجود أو غير مفعّل");
  if (rows.length > 1) bad("الاسم موجود كمندوب وكموظف — حدّد النوع (assigneeKind)");
  return rows[0];
}
const meAsAssignee = (w: Who) => (w.kind === "admin" ? null : { username: w.username, kind: w.kind as "rep" | "staff" });
const isAssignee = (w: Who, t: any) => w.kind !== "admin" && t.assignee_username === w.username && t.assignee_kind === w.kind;
const isOverdue = (t: any, now = Date.now()) =>
  !!t.due_at && (t.status === "open" || t.status === "in_progress") && new Date(t.due_at).getTime() < now;

async function getTask(id: number) {
  const { data } = await supabase.from("tasks").select("*").eq("id", id).maybeSingle();
  if (!data) bad("المهمة غير موجودة");
  return data as any;
}
const withFlags = (rows: any[]) => { const now = Date.now(); return rows.map((t) => ({ ...t, overdue: isOverdue(t, now) })); };

const TASK_SELECT = "*, customers(id, name, phone)";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  try {
    const w = await authenticate(body);
    if (!w) return json({ error: "الجلسة منتهية، الرجاء تسجيل الدخول مجددًا" }, 401);
    if (!hasOwnTasks(w) && !canDistribute(w) && !canPerf(w)) return json({ error: "غير مصرّح" }, 403);
    const a = body.action;
    const limit = Math.min(Math.max(Number(body.limit) || 300, 1), 1000);

    // ---------------- مهامي ----------------
    if (a === "tasks-list-mine") {
      const me = meAsAssignee(w);
      if (!me) return json({ ok: true, tasks: [], note: "الأدمن ليس له مهام شخصية — استخدم tasks-list-all" });
      let q = supabase.from("tasks").select(TASK_SELECT).eq("assignee_username", me.username).eq("assignee_kind", me.kind);
      const st = body.status ?? "active";
      if (st === "active") q = q.in("status", ["open", "in_progress"]);
      else if (st !== "all") q = q.eq("status", oneOf(st, STATUSES, "open", "الحالة"));
      const rows = must(await q.order("due_at", { ascending: true, nullsFirst: false }).order("id", { ascending: false }).limit(limit)) as any[];
      return json({ ok: true, tasks: withFlags(rows) });
    }

    // ---------------- لوحة الفريق ----------------
    if (a === "tasks-list-all") {
      if (!canViewAll(w)) deny("لوحة الفريق للأدمن والمدراء فقط");
      let q = supabase.from("tasks").select(TASK_SELECT);
      if (body.assignee) q = q.eq("assignee_username", String(body.assignee));
      if (body.customerId) q = q.eq("customer_id", intId(body.customerId, "العميل"));
      const st = body.status ?? "active";
      if (st === "active") q = q.in("status", ["open", "in_progress"]);
      else if (st !== "all") q = q.eq("status", oneOf(st, STATUSES, "open", "الحالة"));
      if (body.priority) q = q.eq("priority", oneOf(body.priority, PRIORITIES, "normal", "الأولوية"));
      if (body.overdue) q = q.lt("due_at", new Date().toISOString()).in("status", ["open", "in_progress"]);
      const rows = must(await q.order("due_at", { ascending: true, nullsFirst: false }).order("id", { ascending: false }).limit(limit)) as any[];
      return json({ ok: true, tasks: withFlags(rows) });
    }

    // ---------------- إنشاء ----------------
    if (a === "tasks-create") {
      const title = str(body.title, 200); if (!title) bad("عنوان المهمة مطلوب");
      let target: { username: string; kind: "rep" | "staff" };
      const wantsOther = body.assignee && !(w.kind !== "admin" && String(body.assignee) === w.username && (!body.assigneeKind || body.assigneeKind === w.kind));
      if (wantsOther) {
        if (!canAssign(w)) deny("تكليف الآخرين بمهام متاح للأدمن والمدراء فقط");
        target = await resolveAssignee(body.assignee, body.assigneeKind);
      } else {
        const me = meAsAssignee(w);
        if (!me) bad("اختر الموظف المسؤول");
        target = me!;
      }
      const row = {
        title, description: str(body.description, 4000),
        task_type: oneOf(body.taskType, TASK_TYPES, "general", "نوع المهمة"),
        priority: oneOf(body.priority, PRIORITIES, "normal", "الأولوية"),
        status: "open", assignee_username: target.username, assignee_kind: target.kind, assigned_by: actorName(w),
        customer_id: optId(body.customerId, "العميل"), opportunity_id: optId(body.opportunityId, "الصفقة"),
        project_id: optId(body.projectId, "المشروع"), service_ticket_id: optId(body.serviceTicketId, "التذكرة"),
        due_at: optDate(body.dueAt, "الموعد"),
      };
      const t = must(await supabase.from("tasks").insert(row).select(TASK_SELECT).maybeSingle()) as any;
      await logAudit(w, "create", "task", t.id, t.title, null, { assignee: target.username, due_at: t.due_at, priority: t.priority });
      return json({ ok: true, task: { ...t, overdue: isOverdue(t) } });
    }

    // ---------------- تعديل بيانات المهمة (مين كلّف / الأدمن / المدير) ----------------
    if (a === "tasks-update") {
      const t = await getTask(intId(body.taskId, "المهمة"));
      if (!(isAdmin(w) || canAssign(w) || t.assigned_by === actorName(w))) deny("غير مصرّح بتعديل المهمة");
      const f = body.fields && typeof body.fields === "object" ? body.fields : {};
      const upd: Record<string, unknown> = {};
      if ("title" in f) { const v = str(f.title, 200); if (!v) bad("عنوان المهمة مطلوب"); upd.title = v; }
      if ("description" in f) upd.description = str(f.description, 4000);
      if ("task_type" in f) upd.task_type = oneOf(f.task_type, TASK_TYPES, "general", "نوع المهمة");
      if ("priority" in f) upd.priority = oneOf(f.priority, PRIORITIES, "normal", "الأولوية");
      if ("due_at" in f) upd.due_at = optDate(f.due_at, "الموعد");
      if ("customer_id" in f) upd.customer_id = optId(f.customer_id, "العميل");
      if (!Object.keys(upd).length) bad("مفيش حاجة للتعديل");
      const r = must(await supabase.from("tasks").update(upd).eq("id", t.id).select(TASK_SELECT).maybeSingle()) as any;
      await logAudit(w, "update", "task", t.id, t.title, { priority: t.priority, due_at: t.due_at }, upd);
      return json({ ok: true, task: { ...r, overdue: isOverdue(r) } });
    }

    // ---------------- تغيير الحالة (المسؤول نفسه أو من كلّف أو الأدمن/المدير) ----------------
    if (a === "tasks-set-status") {
      const t = await getTask(intId(body.taskId, "المهمة"));
      if (!(isAdmin(w) || isAssignee(w, t) || canAssign(w) || t.assigned_by === actorName(w))) deny("غير مصرّح بتغيير حالة المهمة");
      const status = oneOf(body.status, STATUSES, "", "الحالة"); if (!status) bad("الحالة مطلوبة");
      if (status === t.status) return json({ ok: true, task: { ...t, overdue: isOverdue(t) } });
      const upd: Record<string, unknown> = { status };
      if (body.note != null) upd.completion_note = str(body.note, 2000);
      const r = must(await supabase.from("tasks").update(upd).eq("id", t.id).select(TASK_SELECT).maybeSingle()) as any;
      await logAudit(w, "status_change", "task", t.id, t.title, { status: t.status }, { status, note: upd.completion_note ?? null });
      return json({ ok: true, task: { ...r, overdue: isOverdue(r) } });
    }

    // ---------------- إعادة تعيين ----------------
    if (a === "tasks-reassign") {
      if (!canAssign(w)) deny("إعادة تعيين المهام للأدمن والمدراء فقط");
      const t = await getTask(intId(body.taskId, "المهمة"));
      const target = await resolveAssignee(body.assignee, body.assigneeKind);
      const r = must(await supabase.from("tasks").update({ assignee_username: target.username, assignee_kind: target.kind }).eq("id", t.id).select(TASK_SELECT).maybeSingle()) as any;
      await logAudit(w, "reassign", "task", t.id, t.title, { assignee: t.assignee_username }, { assignee: target.username });
      return json({ ok: true, task: { ...r, overdue: isOverdue(r) } });
    }

    if (a === "tasks-delete") {
      if (!isAdmin(w)) deny("حذف المهام للأدمن فقط");
      const t = await getTask(intId(body.taskId, "المهمة"));
      must(await supabase.from("tasks").delete().eq("id", t.id));
      await logAudit(w, "delete", "task", t.id, t.title, { assignee: t.assignee_username, status: t.status }, null);
      return json({ ok: true });
    }

    // ---------------- إحصائيات ----------------
    if (a === "tasks-stats") {
      const now = Date.now();
      const all = canViewAll(w);
      let q = supabase.from("tasks").select("assignee_username, assignee_kind, status, due_at, completed_at, priority").limit(5000);
      if (!all) {
        const me = meAsAssignee(w);
        if (!me) return json({ ok: true, total: { open: 0, in_progress: 0, overdue: 0, done_7d: 0 }, byAssignee: [] });
        q = q.eq("assignee_username", me.username).eq("assignee_kind", me.kind);
      }
      const rows = must(await q) as any[];
      const weekAgo = now - 7 * 86400000;
      const by: Record<string, any> = {};
      const total = { open: 0, in_progress: 0, overdue: 0, done_7d: 0 };
      for (const t of rows) {
        const k = `${t.assignee_kind}:${t.assignee_username}`;
        const s = (by[k] ||= { username: t.assignee_username, kind: t.assignee_kind, open: 0, in_progress: 0, overdue: 0, done_7d: 0 });
        if (t.status === "open") { s.open++; total.open++; }
        if (t.status === "in_progress") { s.in_progress++; total.in_progress++; }
        if (isOverdue(t, now)) { s.overdue++; total.overdue++; }
        if (t.status === "done" && t.completed_at && new Date(t.completed_at).getTime() >= weekAgo) { s.done_7d++; total.done_7d++; }
      }
      return json({ ok: true, total, byAssignee: all ? Object.values(by) : [] });
    }

    // ---------------- أداء كل موظف (متابعة الإنجاز) ----------------
    if (a === "tasks-performance") {
      if (!canPerf(w)) deny("متابعة أداء الفريق للأدمن والمدراء فقط");
      const days = Math.min(Math.max(Number(body.days) || 30, 1), 365);
      const now = Date.now(), since = now - days * 86400000, sinceIso = new Date(since).toISOString();
      const users = must(await supabase.from("assignable_users").select("kind, username, display_name")) as any[];
      const tasks = must(await supabase.from("tasks").select("assignee_username, assignee_kind, status, due_at, created_at, completed_at").limit(10000)) as any[];
      const custs = must(await supabase.from("customers").select("assigned_to, priority, status").not("assigned_to", "is", null).is("merged_into_id", null).limit(10000)) as any[];
      const inter = must(await supabase.from("crm_interactions").select("rep_username").gte("created_at", sinceIso).limit(20000)) as any[];
      const T = (x: string) => new Date(x).getTime();
      const rows = users.map((u) => {
        const mine = tasks.filter((t) => t.assignee_username === u.username && t.assignee_kind === u.kind);
        const created = mine.filter((t) => T(t.created_at) >= since);
        const doneP = mine.filter((t) => t.status === "done" && t.completed_at && T(t.completed_at) >= since);
        const withDue = doneP.filter((t) => t.due_at);
        const onTime = withDue.filter((t) => T(t.completed_at) <= T(t.due_at));
        const myCust = u.kind === "rep" ? custs.filter((c) => c.assigned_to === u.username) : [];
        return {
          kind: u.kind, username: u.username, display_name: u.display_name,
          customers_count: u.kind === "rep" ? myCust.length : null,
          hot_customers: u.kind === "rep" ? myCust.filter((c) => c.priority === "hot").length : null,
          won_customers: u.kind === "rep" ? myCust.filter((c) => c.status === "won").length : null,
          open: mine.filter((t) => t.status === "open").length,
          in_progress: mine.filter((t) => t.status === "in_progress").length,
          overdue: mine.filter((t) => isOverdue(t, now)).length,
          assigned_period: created.length,
          done_period: doneP.length,
          completion_rate: created.length ? Math.round((100 * created.filter((t) => t.status === "done").length) / created.length) : null,
          on_time_rate: withDue.length ? Math.round((100 * onTime.length) / withDue.length) : null,
          interactions_period: u.kind === "rep" ? inter.filter((i) => i.rep_username === u.username).length : null,
        };
      });
      return json({ ok: true, days, rows });
    }

    // ---------------- قائمة اللي ينفع تكلّفهم + حمل كل واحد ----------------
    if (a === "tasks-assignable-users") {
      if (!canAssign(w) && !canDistribute(w) && !canViewAll(w)) deny("غير مصرّح");
      const users = must(await supabase.from("assignable_users").select("kind, username, display_name, roles")) as any[];
      const tasks = must(await supabase.from("tasks").select("assignee_username, assignee_kind, status, due_at").in("status", ["open", "in_progress"]).limit(5000)) as any[];
      const custs = must(await supabase.from("customers").select("assigned_to").not("assigned_to", "is", null).is("merged_into_id", null).limit(5000)) as any[];
      const now = Date.now();
      const out = users.map((u) => {
        const mine = tasks.filter((t) => t.assignee_username === u.username && t.assignee_kind === u.kind);
        return {
          ...u, open_tasks: mine.length, overdue_tasks: mine.filter((t) => isOverdue(t, now)).length,
          customers_count: u.kind === "rep" ? custs.filter((c) => c.assigned_to === u.username).length : null,
        };
      });
      return json({ ok: true, users: out });
    }

    // ================= توزيع العملاء (أدمن / sales.reassign) =================
    if (a === "tasks-unassigned-customers") {
      if (!canDistribute(w)) deny("توزيع العملاء للأدمن ومدير المبيعات فقط");
      let q = supabase.from("customers")
        .select("id, name, phone, city, region, status, priority, lead_source, quotes_count, last_contact_at, created_at")
        .is("assigned_to", null).is("merged_into_id", null).limit(2000);
      if (body.status) q = q.eq("status", String(body.status));
      else q = q.not("status", "in", "(won,lost)");
      if (body.priority) q = q.eq("priority", String(body.priority));
      if (body.city) q = q.eq("city", String(body.city));
      if (body.region) q = q.eq("region", String(body.region));
      if (body.leadSource) q = q.eq("lead_source", String(body.leadSource));
      const rows = must(await q) as any[];
      const rank = (p: string | null) => (p === "hot" ? 1 : p === "warm" || !p ? 2 : 3);
      rows.sort((x, y) => rank(x.priority) - rank(y.priority) || new Date(y.created_at).getTime() - new Date(x.created_at).getTime());
      return json({ ok: true, customers: rows, count: rows.length });
    }

    // عملاء مندوب معيّن (لشاشة نقل العملاء بين المناديب) + عدد مهامه وصفقاته المفتوحة على كل عميل
    if (a === "tasks-customers-by-rep") {
      if (!canDistribute(w)) deny("نقل العملاء للأدمن ومدير المبيعات فقط");
      const rep = String(body.rep ?? "").trim(); if (!rep) bad("اختر المندوب");
      let q = supabase.from("customers")
        .select("id, name, phone, city, status, priority, quotes_count, last_contact_at, created_at, assigned_at")
        .eq("assigned_to", rep).is("merged_into_id", null).limit(2000);
      if (body.status) q = q.eq("status", String(body.status));
      if (body.priority) q = q.eq("priority", String(body.priority));
      const rows = must(await q) as any[];
      const rank = (p: string | null) => (p === "hot" ? 1 : p === "warm" || !p ? 2 : 3);
      rows.sort((x, y) => rank(x.priority) - rank(y.priority) || new Date(y.created_at).getTime() - new Date(x.created_at).getTime());
      if (rows.length && rows.length <= 500) {
        const ids = rows.map((r) => r.id);
        const tk = must(await supabase.from("tasks").select("customer_id").in("customer_id", ids).in("status", ["open", "in_progress"])) as any[];
        const op = must(await supabase.from("opportunities").select("customer_id").in("customer_id", ids).not("stage", "in", "(won,lost)")) as any[];
        const cnt = (arr: any[]) => arr.reduce((m: Record<string, number>, x) => { m[x.customer_id] = (m[x.customer_id] || 0) + 1; return m; }, {});
        const tc = cnt(tk), oc = cnt(op);
        for (const r of rows) { r.open_tasks = tc[r.id] || 0; r.open_opportunities = oc[r.id] || 0; }
      }
      return json({ ok: true, customers: rows, count: rows.length });
    }

    const idsOf = (v: unknown): number[] => {
      const arr = (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
      const uniq = [...new Set(arr)].slice(0, 500);
      if (!uniq.length) bad("اختر عميل واحد على الأقل");
      return uniq;
    };

    if (a === "tasks-assign-customers") {
      if (!canDistribute(w)) deny("توزيع العملاء للأدمن ومدير المبيعات فقط");
      const ids = idsOf(body.customerIds);
      const rep = String(body.rep ?? "").trim(); if (!rep) bad("اختر المندوب");
      const n = must(await supabase.rpc("assign_customers", {
        p_customer_ids: ids, p_rep: rep, p_by: actorName(w), p_by_role: w.kind,
        p_follow_up: dateOnly(body.followUp), p_note: str(body.note, 1000), p_create_task: body.createTask !== false,
      })) as number;
      return json({ ok: true, assigned: n, skipped: ids.length - n });
    }

    if (a === "tasks-distribute-customers") {
      if (!canDistribute(w)) deny("توزيع العملاء للأدمن ومدير المبيعات فقط");
      const ids = idsOf(body.customerIds);
      const reps = [...new Set((Array.isArray(body.reps) ? body.reps : []).map((r: unknown) => String(r).trim()).filter(Boolean))].slice(0, 20);
      if (!reps.length) bad("اختر مندوب واحد على الأقل");
      const r = must(await supabase.rpc("distribute_customers", {
        p_customer_ids: ids, p_reps: reps, p_by: actorName(w), p_by_role: w.kind,
        p_follow_up: dateOnly(body.followUp), p_note: str(body.note, 1000), p_create_task: body.createTask !== false,
      })) as Record<string, number>;
      return json({ ok: true, perRep: r, assigned: Object.values(r).reduce((s, n) => s + n, 0) });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e: any) {
    if (e instanceof Forbidden) return json({ error: e.message }, 403);
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    const msg = String(e?.message || e);
    // أخطاء دوال القاعدة المعروفة بترجع 400 بدل 500
    if (/rep_not_found_or_inactive|assignee_not_found_or_inactive|no_reps_provided/.test(msg)) return json({ error: msg }, 400);
    return json({ error: msg }, 500);
  }
});
