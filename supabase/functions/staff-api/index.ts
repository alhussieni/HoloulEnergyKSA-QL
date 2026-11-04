// HoloulEnergy — staff-api Edge Function
// حسابات الموظفين + الأدوار والصلاحيات (المرحلة 1).
//   دخول موظف:  staff-login | staff-me
//   بيانات القراءة (بتتحقق من صلاحية دور الموظف في السيرفر): staff-projects | staff-project-detail | staff-profit |
//                 staff-suppliers | staff-supplier-statement | staff-customers | staff-customer-statement | staff-treasury
//   إدارة (أدمن فقط): roles-list | roles-save | roles-delete | staff-list | staff-save | staff-delete
// الصلاحية الفعلية للموظف = اتحاد صلاحيات أدواره (بتتقرا من app_roles في كل طلب، فأي تعديل من الأدمن بيسري فورًا).

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
async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
// كلمات المرور الجديدة: PBKDF2-SHA256 بـ salt عشوائي. الحسابات المنقولة من viewers لسه sha256 قديم وبتتحدّث تلقائيًا أول دخول.
const PBKDF2_ITER = 100000;
const hex = (u: Uint8Array) => Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("");
async function pbkdf2(password: string, saltHex: string, iter: number): Promise<string> {
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256)));
}
async function hashPassword(password: string): Promise<string> {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2$${PBKDF2_ITER}$${salt}$${await pbkdf2(password, salt, PBKDF2_ITER)}`;
}
async function verifyPassword(password: string, stored: string): Promise<{ ok: boolean; upgrade: boolean }> {
  if (stored.startsWith("pbkdf2$")) {
    const [, it, salt, h] = stored.split("$");
    return { ok: safeEq(await pbkdf2(password, salt, Number(it)), h), upgrade: false };
  }
  return { ok: safeEq(await sha256Hex(password), stored), upgrade: true };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateOrNull = (v: unknown, label: string): string | null => {
  if (v == null || v === "") return null;
  const s = String(v);
  if (!DATE_RE.test(s) || isNaN(Date.parse(s))) bad(`${label} غير صالح (YYYY-MM-DD)`);
  return s;
};
const idOf = (v: unknown, label: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) bad(`${label} غير صالح`);
  return n;
};
const r2 = (n: number) => Math.round(n * 100) / 100;
const USER_RE = /^[A-Za-z0-9_.-]{3,30}$/;
const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;

// كتالوج الصلاحيات. active=true يعني متنفّذة فعلًا في السيرفر دلوقتي؛ الباقي بيظهر "قريبًا" في لوحة الأدمن لحد ما شاشاته تتبني.
const CATALOG = [
  { key: "projects.view", label: "نظرة مالية على المشاريع (التعاقد والتكاليف والمحصّل والمتبقي والربح)", group: "المالية", active: true },
  { key: "profit.view", label: "الربح العام للشركة ونسبته وقيمته", group: "المالية", active: true },
  { key: "suppliers.view", label: "الموردون وكشوف حساباتهم وأوامر الشراء والفواتير", group: "المالية", active: true },
  { key: "customers.fin.view", label: "حسابات العملاء (التعاقد والمحصّل والمتبقي)", group: "المالية", active: true },
  { key: "treasury.view", label: "الخزنة وأرصدة الحسابات وسجل الحركات", group: "المالية", active: true },
  { key: "accounting.review", label: "مراجعة الأداء المحاسبي", group: "المحاسبة", active: false },
  { key: "accounting.approve", label: "اعتماد توزيع الأرباح والتقفيلات", group: "المحاسبة", active: false },
  { key: "products.cost.view", label: "رؤية تكلفة المنتجات", group: "المنتجات والمشتريات", active: false },
  { key: "products.edit", label: "إضافة وتعديل المنتجات", group: "المنتجات والمشتريات", active: false },
  { key: "purchasing.manage", label: "إدارة المشتريات (طلبات عروض، أوامر شراء)", group: "المنتجات والمشتريات", active: false },
  { key: "sales.prices.view", label: "رؤية أسعار بيع المنتجات والمنظومات", group: "المبيعات", active: false },
  { key: "sales.customers.own", label: "متابعة العملاء المسندين له فقط", group: "المبيعات", active: false },
  { key: "sales.team.view", label: "رؤية المناديب وأدائهم", group: "المبيعات", active: false },
  { key: "sales.reassign", label: "نقل عميل من مندوب لمندوب", group: "المبيعات", active: false },
  { key: "stock.view", label: "رؤية المخزون", group: "المخزن والتسليم", active: false },
  { key: "stock.serials", label: "تسجيل الأرقام التسلسلية والصرف والاستلام", group: "المخزن والتسليم", active: false },
  { key: "delivery.receive", label: "استلام المكونات ومطابقتها وتوقيع العميل على سند الاستلام", group: "المخزن والتسليم", active: false },
  { key: "project.progress", label: "متابعة سير المشروع ومراحل التنفيذ", group: "المشاريع", active: false },
];
const PERM_KEYS = new Set(CATALOG.map((c) => c.key));

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

// كل أكشن قراءة بيحتاج صلاحية معيّنة (الأدمن بيعدّي على الكل)
const NEED: Record<string, string> = {
  "staff-projects": "projects.view", "staff-project-detail": "projects.view",
  "staff-profit": "profit.view",
  "staff-suppliers": "suppliers.view", "staff-supplier-statement": "suppliers.view",
  "staff-customers": "customers.fin.view", "staff-customer-statement": "customers.fin.view",
  "staff-treasury": "treasury.view",
};
const CUSTOMER_COLS = "project_id, project_number, customer_id, customer_name, status, contract_gross, collected, remaining";
const PROJECT_COLS = "project_id, project_number, customer_name, status, is_completed, completion_date, contract_gross, cost_gross, cost_net, collected, remaining";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  const action = body.action;

  try {
    if (action === "staff-login") {
      const username = String(body.username || "").trim(), password = String(body.password || "");
      if (!username || !password) return json({ error: "بيانات الدخول غير صحيحة" }, 401);
      const { data } = await supabase.from("staff_accounts").select("id, username, password_hash, display_name, active, session_version, roles").eq("username", username).maybeSingle();
      const v = data && data.active ? await verifyPassword(password, data.password_hash) : { ok: false, upgrade: false };
      if (!data || !data.active || !v.ok) return json({ error: "بيانات الدخول غير صحيحة" }, 401);
      if (v.upgrade) await supabase.from("staff_accounts").update({ password_hash: await hashPassword(password) }).eq("id", data.id);
      const token = await issueToken(`staff:${data.username}`, data.session_version, 12 * 3600);
      return json({ ok: true, token, displayName: data.display_name, roles: data.roles || [], permissions: [...(await permsOfRoles(data.roles || []))] });
    }

    const who = await authenticate(body);
    if (!who) return json({ error: "الجلسة منتهية، الرجاء تسجيل الدخول مجددًا" }, 401);

    if (action === "staff-me") {
      if (who.kind === "admin") return json({ ok: true, displayName: "الأدمن", roles: [], permissions: CATALOG.map((c) => c.key) });
      const names = must(await supabase.from("app_roles").select("key, name_ar").in("key", who.roles.length ? who.roles : ["-"])) as any[];
      return json({ ok: true, displayName: who.displayName, roles: who.roles, roleNames: names.map((n) => n.name_ar), permissions: [...who.perms] });
    }

    // ===== إدارة الأدوار والموظفين (أدمن فقط) =====
    if (action === "roles-list" || action === "roles-save" || action === "roles-delete" || action === "staff-list" || action === "staff-save" || action === "staff-delete") {
      if (who.kind !== "admin") return json({ error: "الصفحة دي للأدمن فقط" }, 403);

      if (action === "roles-list") {
        const roles = must(await supabase.from("app_roles").select("*").order("sort").order("key")) as any[];
        return json({ ok: true, roles, catalog: CATALOG });
      }
      if (action === "roles-save") {
        const key = String(body.key || "").trim();
        if (!ROLE_KEY_RE.test(key)) bad("مفتاح الدور حروف إنجليزية صغيرة وأرقام و _ فقط");
        const perms: string[] = Array.isArray(body.permissions) ? [...new Set(body.permissions.map(String))] as string[] : [];
        for (const p of perms) if (!PERM_KEYS.has(p)) bad(`صلاحية غير معروفة: ${p}`);
        const { data: cur } = await supabase.from("app_roles").select("key, name_ar, permissions").eq("key", key).maybeSingle();
        if (cur) {
          const upd: Record<string, unknown> = { permissions: perms };
          if (body.nameAr !== undefined) { const n = String(body.nameAr).trim().slice(0, 60); if (!n) bad("اسم الدور مطلوب"); upd.name_ar = n; }
          if (body.description !== undefined) upd.description = String(body.description).trim().slice(0, 300) || null;
          must(await supabase.from("app_roles").update(upd).eq("key", key));
          await logAudit("update_role", "app_role", null, key, { permissions: cur.permissions }, { permissions: perms });
        } else {
          const n = String(body.nameAr || "").trim().slice(0, 60); if (!n) bad("اسم الدور مطلوب");
          must(await supabase.from("app_roles").insert({ key, name_ar: n, description: String(body.description || "").trim().slice(0, 300) || null, permissions: perms, is_system: false, sort: 200 }));
          await logAudit("add_role", "app_role", null, key, null, { permissions: perms });
        }
        return json({ ok: true });
      }
      if (action === "roles-delete") {
        const key = String(body.key || "");
        const { data: r } = await supabase.from("app_roles").select("is_system").eq("key", key).maybeSingle();
        if (!r) bad("الدور غير موجود");
        if (r!.is_system) bad("الأدوار الأساسية مينفعش تتحذف — تقدر تعدّل صلاحياتها");
        const used = must(await supabase.from("staff_accounts").select("id").contains("roles", [key]).limit(1)) as any[];
        if (used.length) bad("الدور ده مربوط بموظفين — شيله منهم الأول");
        must(await supabase.from("app_roles").delete().eq("key", key));
        await logAudit("delete_role", "app_role", null, key, null, null);
        return json({ ok: true });
      }
      if (action === "staff-list") {
        const rows = must(await supabase.from("staff_accounts").select("id, username, display_name, active, roles, created_at").order("id")) as any[];
        return json({ ok: true, staff: rows });
      }
      if (action === "staff-delete") {
        const id = idOf(body.id, "معرّف");
        const { data: old } = await supabase.from("staff_accounts").select("username").eq("id", id).maybeSingle();
        must(await supabase.from("staff_accounts").delete().eq("id", id));
        await logAudit("delete_staff", "staff", id, old?.username || null, null, null);
        return json({ ok: true });
      }
      // staff-save: إنشاء أو تعديل
      const roles: string[] = Array.isArray(body.roles) ? [...new Set(body.roles.map(String))] as string[] : [];
      if (roles.length) {
        const ok = must(await supabase.from("app_roles").select("key").in("key", roles)) as any[];
        if (ok.length !== roles.length) bad("دور غير معروف");
      }
      const displayName = String(body.displayName ?? "").trim().slice(0, 100);
      const password = body.password ? String(body.password) : "";
      if (password && password.length < 6) bad("كلمة المرور لازم تكون 6 خانات على الأقل");
      if (body.id) {
        const id = idOf(body.id, "معرّف");
        const upd: Record<string, unknown> = {};
        if (displayName) upd.display_name = displayName;
        if ("active" in body) upd.active = !!body.active;
        if (Array.isArray(body.roles)) upd.roles = roles;
        if (password) {
          const { data: cur } = await supabase.from("staff_accounts").select("session_version").eq("id", id).maybeSingle();
          if (!cur) bad("الحساب غير موجود");
          upd.password_hash = await hashPassword(password); upd.session_version = (cur!.session_version || 1) + 1;
        } else if (upd.active === false) {
          const { data: cur } = await supabase.from("staff_accounts").select("session_version").eq("id", id).maybeSingle();
          if (cur) upd.session_version = (cur.session_version || 1) + 1;
        }
        if (!Object.keys(upd).length) bad("مفيش تغيير مطلوب");
        must(await supabase.from("staff_accounts").update(upd).eq("id", id));
        await logAudit("update_staff", "staff", id, displayName || null, null, { roles: upd.roles, active: upd.active, password_changed: !!password });
        return json({ ok: true });
      }
      const username = String(body.username ?? "").trim();
      if (!USER_RE.test(username)) bad("اسم المستخدم حروف إنجليزية وأرقام فقط (3 إلى 30)، ممكن _ . -");
      if (!displayName) bad("الاسم مطلوب");
      if (!password) bad("كلمة المرور مطلوبة");
      const ins = await supabase.from("staff_accounts").insert({ username, display_name: displayName, password_hash: await hashPassword(password), roles }).select("id").single();
      if (ins.error) { if ((ins.error as any).code === "23505") bad("اسم المستخدم ده مستخدم قبل كده"); throw ins.error; }
      await logAudit("add_staff", "staff", ins.data.id, username, null, { display_name: displayName, roles });
      return json({ ok: true, id: ins.data.id });
    }

    // ===== بيانات القراءة بالصلاحيات =====
    const need = NEED[action];
    if (!need) return json({ error: "unknown_action" }, 400);
    if (!can(who, need)) return json({ error: "ليس لديك صلاحية على هذه الشاشة" }, 403);

    if (action === "staff-projects") {
      const rows = must(await supabase.from("v_project_profit").select(PROJECT_COLS + ", actual_profit, margin_pct").order("project_id", { ascending: false }).limit(1000)) as any[];
      return json({ ok: true, projects: rows });
    }
    if (action === "staff-project-detail") {
      const pid = idOf(body.projectId, "المشروع");
      const [proj, costs, bills, orders, pays] = await Promise.all([
        supabase.from("v_project_profit").select(PROJECT_COLS + ", actual_profit, margin_pct, contract_net, output_vat, input_vat").eq("project_id", pid).maybeSingle(),
        supabase.from("project_costs").select("id, cost_type, description, amount, cost_date, supplier, tax_treatment").eq("project_id", pid).order("cost_date", { ascending: false }),
        supabase.from("v_supplier_bills").select("bill_id, supplier_name, bill_number, bill_date, amount, paid, remaining").eq("project_id", pid).order("bill_date", { ascending: false }),
        supabase.from("v_purchase_orders").select("po_id, po_number, supplier_name, order_date, amount, status, billed, paid").eq("project_id", pid).order("order_date", { ascending: false }),
        supabase.from("payments").select("id, amount, payment_date, method").eq("project_id", pid).order("payment_date", { ascending: false }),
      ]);
      const p = must(proj); if (!p) return json({ error: "المشروع غير موجود" }, 404);
      return json({ ok: true, project: p, costs: must(costs) || [], bills: must(bills) || [], orders: must(orders) || [], payments: must(pays) || [] });
    }
    if (action === "staff-profit") {
      const rows = must(await supabase.from("v_project_profit").select("contract_net, contract_gross, cost_net, cost_gross, actual_profit, collected, remaining, is_completed").limit(5000)) as any[];
      const sum = (f: (r: any) => number, rs = rows) => r2(rs.reduce((t, r) => t + (Number(f(r)) || 0), 0));
      const net = sum((r) => r.contract_net), profit = sum((r) => r.actual_profit);
      const done = rows.filter((r) => r.is_completed);
      const doneNet = sum((r) => r.contract_net, done), doneProfit = sum((r) => r.actual_profit, done);
      return json({
        ok: true, projects: rows.length, completed: done.length,
        all: { revenue_net: net, cost_net: sum((r) => r.cost_net), profit, margin_pct: net ? r2((profit / net) * 100) : null },
        completed_only: { revenue_net: doneNet, profit: doneProfit, margin_pct: doneNet ? r2((doneProfit / doneNet) * 100) : null },
        collected: sum((r) => r.collected), remaining: sum((r) => r.remaining),
      });
    }
    if (action === "staff-suppliers") {
      const list = must(await supabase.from("v_supplier_balances").select("supplier_id, name, phone, active, total_bills, total_paid, balance, advance_open").order("name")) as any[];
      return json({ ok: true, suppliers: list, totals: { payable: r2(list.reduce((t, x) => t + Math.max(0, Number(x.balance) || 0), 0)), advances: r2(list.reduce((t, x) => t + (Number(x.advance_open) || 0), 0)) } });
    }
    if (action === "staff-supplier-statement") {
      const sid = idOf(body.supplierId, "المورد");
      const [sup, stmt] = await Promise.all([
        supabase.from("v_supplier_balances").select("supplier_id, name, phone, total_bills, total_paid, balance, advance_open").eq("supplier_id", sid).maybeSingle(),
        supabase.from("v_supplier_statement").select("doc_date, ord, doc_kind, doc_id, ref, notes, project_number, po_number, account_name, amount, effect, running_balance").eq("supplier_id", sid).order("doc_date", { ascending: true }).order("ord", { ascending: true }).order("doc_id", { ascending: true }),
      ]);
      const s = must(sup); if (!s) return json({ error: "المورد غير موجود" }, 404);
      return json({ ok: true, supplier: s, statement: must(stmt) || [] });
    }
    if (action === "staff-customers") {
      const rows = must(await supabase.from("v_project_profit").select(CUSTOMER_COLS).limit(5000)) as any[];
      const by = new Map<number, any>();
      for (const r of rows) {
        const k = Number(r.customer_id), c = by.get(k) || { customer_id: k, name: r.customer_name, projects: 0, contract: 0, collected: 0, remaining: 0 };
        c.projects += 1; c.contract += Number(r.contract_gross) || 0; c.collected += Number(r.collected) || 0; c.remaining += Number(r.remaining) || 0; by.set(k, c);
      }
      const customers = [...by.values()].map((c) => ({ ...c, contract: r2(c.contract), collected: r2(c.collected), remaining: r2(c.remaining) })).sort((a, b) => b.remaining - a.remaining);
      return json({ ok: true, customers });
    }
    if (action === "staff-customer-statement") {
      const cid = idOf(body.customerId, "العميل");
      const projects = must(await supabase.from("v_project_profit").select(CUSTOMER_COLS).eq("customer_id", cid).order("project_id", { ascending: false })) as any[];
      if (!projects.length) return json({ error: "العميل غير موجود أو ليس له مشاريع" }, 404);
      const pays = must(await supabase.from("payments").select("id, project_id, amount, payment_date, method").in("project_id", projects.map((p) => p.project_id)).order("payment_date", { ascending: false })) as any[];
      const num: Record<string, string> = Object.fromEntries(projects.map((p) => [String(p.project_id), p.project_number]));
      return json({ ok: true, customer: { customer_id: cid, name: projects[0].customer_name }, projects, payments: pays.map((x) => ({ ...x, project_number: num[String(x.project_id)] || null })) });
    }
    if (action === "staff-treasury") {
      const accounts = must(await supabase.from("v_account_balances").select("account_id, name, kind, holder, active, opening_balance, total_in, total_out, balance").order("account_id")) as any[];
      let q = supabase.from("v_treasury_ledger").select("id, entry_date, account_name, direction, amount, kind, method, reference, notes, project_number, customer_name, supplier_name, running_balance").order("entry_date", { ascending: false }).order("id", { ascending: false }).limit(300);
      if (body.accountId) q = q.eq("account_id", idOf(body.accountId, "الحساب"));
      const from = dateOrNull(body.from, "من تاريخ"), to = dateOrNull(body.to, "إلى تاريخ");
      if (from) q = q.gte("entry_date", from);
      if (to) q = q.lte("entry_date", to);
      return json({ ok: true, accounts, ledger: must(await q) || [], totalBalance: r2(accounts.filter((a) => a.active).reduce((t, a) => t + (Number(a.balance) || 0), 0)) });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
