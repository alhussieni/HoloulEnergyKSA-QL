// HoloulEnergy — costs-api Edge Function (READ-ONLY)
//
// Serves read-only accounts (table `viewers`, type `viewer` = partner or
// `accountant`) and the admin. Rep tokens are NOT accepted here. What each type
// may call is enforced server-side (ACCESS below), read from the DB per request.
//
//   * viewer-login  : username + password -> signed token (sub = "viewer:<user>").
//                     That token type is rejected by crm-api, compute-quote and
//                     every finance-* function (they accept only "rep:" / "admin").
//   * costs-*       : projects, suppliers, treasury — SELECT only.
//
// Hard rules:
//   * This file never writes to the database: no insert/update/delete/
//     upsert/rpc anywhere — keep it that way.
//   * Profit / margin / partner data is NOT exposed: v_project_profit is read
//     through an explicit column allow-list (no actual_profit, no margin_pct).

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
async function issueToken(sub: string, ver: number, ttlSeconds: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payloadB64 = b64urlFromBytes(new TextEncoder().encode(JSON.stringify({ sub, ver, exp })));
  return `${payloadB64}.${await hmacSign(sessionSecret(), payloadB64)}`;
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
    if (typeof payload.sub !== "string") return null;
    return payload;
  } catch { return null; }
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

type Role = "admin" | "viewer" | "accountant";

async function authenticate(body: any): Promise<Role | null> {
  if (body.adminToken) {
    const p = await readToken(body.adminToken);
    if (p && p.sub === "admin") {
      const { data, error } = await supabase.from("admin_secret").select("session_version").eq("id", 1).single();
      if (!error && data && p.ver === data.session_version) return "admin";
    }
  }
  if (body.token) {
    const p = await readToken(body.token);
    if (p && p.sub.startsWith("viewer:")) {
      const { data, error } = await supabase.from("viewers")
        .select("active, session_version, role").eq("username", p.sub.slice(7)).single();
      if (!error && data && data.active && p.ver === data.session_version) {
        return data.role === "accountant" ? "accountant" : "viewer";
      }
    }
  }
  return null;
}

// Which actions each account type may call.
const ACCESS: Record<Role, string[] | "all"> = {
  admin: "all",
  viewer: ["costs-projects", "costs-project-detail", "costs-suppliers", "costs-supplier-statement", "costs-treasury"],
  accountant: ["costs-suppliers", "costs-supplier-statement", "costs-treasury", "costs-customers", "costs-customer-statement"],
};

class BadRequest extends Error {}
const bad = (m: string): never => { throw new BadRequest(m); };
const must = <T>(r: { data: T; error: any }): T => { if (r.error) throw r.error; return r.data; };
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

// Columns of v_project_profit a viewer may see. NO actual_profit, NO margin_pct.
// Accountant sees contract / collected / remaining per customer — no cost, no profit.
const CUSTOMER_COLS = "project_id, project_number, customer_id, customer_name, status, contract_gross, collected, remaining";
const PROJECT_COLS = "project_id, project_number, customer_name, status, is_completed, completion_date, contract_gross, cost_gross, cost_net, collected, remaining";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  const action = body.action;

  // ---- login (the only unauthenticated action; reads `viewers`, writes nothing) ----
  if (action === "viewer-login") {
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!username || !password) return json({ error: "بيانات الدخول غير صحيحة" }, 401);
    const { data } = await supabase.from("viewers")
      .select("username, password_hash, display_name, active, session_version, role").eq("username", username).maybeSingle();
    const ok = data && data.active && safeEq(await sha256Hex(password), data.password_hash);
    if (!ok) return json({ error: "بيانات الدخول غير صحيحة" }, 401);
    const token = await issueToken(`viewer:${data!.username}`, data!.session_version, 12 * 3600);
    return json({ ok: true, token, displayName: data!.display_name, role: data!.role === "accountant" ? "accountant" : "viewer" });
  }

  const role = await authenticate(body);
  if (!role) return json({ error: "الجلسة منتهية، الرجاء تسجيل الدخول مجددًا" }, 401);
  const allowed = ACCESS[role];
  if (allowed !== "all" && !allowed.includes(action)) return json({ error: "ليس لديك صلاحية على هذه الشاشة" }, 403);

  try {
    if (action === "costs-projects") {
      const rows = must(await supabase.from("v_project_profit").select(PROJECT_COLS).order("project_id", { ascending: false }).limit(1000));
      const st = await supabase.from("crm_settings").select("data->projectStatuses").eq("id", 1).maybeSingle();
      return json({ ok: true, projects: rows || [], statuses: (st.data as any)?.projectStatuses || [] });
    }

    if (action === "costs-project-detail") {
      const pid = idOf(body.projectId, "projectId");
      const [proj, costs, bills, orders] = await Promise.all([
        supabase.from("v_project_profit").select(PROJECT_COLS).eq("project_id", pid).maybeSingle(),
        supabase.from("project_costs").select("id, cost_type, description, amount, cost_date, supplier, tax_treatment, created_at").eq("project_id", pid).order("created_at", { ascending: false }),
        supabase.from("v_supplier_bills").select("bill_id, supplier_id, supplier_name, bill_number, bill_date, description, amount, tax_treatment, paid, remaining").eq("project_id", pid).order("bill_date", { ascending: false }),
        supabase.from("v_purchase_orders").select("po_id, po_number, supplier_name, order_date, description, amount, status, billed, paid, remaining_to_bill, remaining_to_pay").eq("project_id", pid).order("order_date", { ascending: false }),
      ]);
      const p = must(proj);
      if (!p) return json({ error: "المشروع غير موجود" }, 404);
      return json({ ok: true, project: p, costs: must(costs) || [], bills: must(bills) || [], orders: must(orders) || [] });
    }

    if (action === "costs-suppliers") {
      const rows = must(await supabase.from("v_supplier_balances")
        .select("supplier_id, name, phone, active, total_bills, total_paid, balance, advance_open").order("name"));
      const list = (rows || []) as any[];
      return json({
        ok: true, suppliers: list,
        totals: {
          payable: r2(list.reduce((t, x) => t + Math.max(0, Number(x.balance) || 0), 0)),
          advances: r2(list.reduce((t, x) => t + (Number(x.advance_open) || 0), 0)),
        },
      });
    }

    if (action === "costs-supplier-statement") {
      const sid = idOf(body.supplierId, "supplierId");
      const [sup, bills, stmt, projs] = await Promise.all([
        supabase.from("v_supplier_balances").select("supplier_id, name, phone, total_bills, total_paid, balance, advance_open").eq("supplier_id", sid).maybeSingle(),
        supabase.from("v_supplier_bills").select("bill_id, project_number, bill_number, bill_date, description, amount, tax_treatment, paid, remaining").eq("supplier_id", sid).order("bill_date", { ascending: false }),
        supabase.from("v_supplier_statement").select("doc_date, ord, doc_kind, doc_id, ref, notes, project_number, po_number, account_name, amount, effect, running_balance")
          .eq("supplier_id", sid).order("doc_date", { ascending: true }).order("ord", { ascending: true }).order("doc_id", { ascending: true }),
        supabase.from("v_supplier_project_summary").select("project_number, invoiced, paid, balance").eq("supplier_id", sid).order("project_number", { ascending: true, nullsFirst: false }),
      ]);
      const s = must(sup);
      if (!s) return json({ error: "المورد غير موجود" }, 404);
      return json({ ok: true, supplier: s, bills: must(bills) || [], statement: must(stmt) || [], projects: must(projs) || [] });
    }

    if (action === "costs-customers") {
      const rows = (must(await supabase.from("v_project_profit").select(CUSTOMER_COLS).limit(5000)) || []) as any[];
      const by = new Map<number, any>();
      for (const r of rows) {
        const k = Number(r.customer_id);
        const c = by.get(k) || { customer_id: k, name: r.customer_name, projects: 0, contract: 0, collected: 0, remaining: 0 };
        c.projects += 1; c.contract += Number(r.contract_gross) || 0; c.collected += Number(r.collected) || 0; c.remaining += Number(r.remaining) || 0;
        by.set(k, c);
      }
      const customers = [...by.values()].map((c) => ({ ...c, contract: r2(c.contract), collected: r2(c.collected), remaining: r2(c.remaining) }))
        .sort((a, b) => b.remaining - a.remaining);
      return json({
        ok: true, customers,
        totals: {
          contract: r2(customers.reduce((t, c) => t + c.contract, 0)),
          collected: r2(customers.reduce((t, c) => t + c.collected, 0)),
          remaining: r2(customers.reduce((t, c) => t + c.remaining, 0)),
        },
      });
    }

    if (action === "costs-customer-statement") {
      const cid = idOf(body.customerId, "customerId");
      const projects = (must(await supabase.from("v_project_profit").select(CUSTOMER_COLS).eq("customer_id", cid).order("project_id", { ascending: false })) || []) as any[];
      if (!projects.length) return json({ error: "العميل غير موجود أو ليس له مشاريع" }, 404);
      const ids = projects.map((p) => p.project_id);
      const pays = (must(await supabase.from("payments").select("id, project_id, amount, payment_date, method, notes").in("project_id", ids).order("payment_date", { ascending: false })) || []) as any[];
      const num: Record<string, string> = Object.fromEntries(projects.map((p) => [String(p.project_id), p.project_number]));
      return json({
        ok: true,
        customer: {
          customer_id: cid, name: projects[0].customer_name,
          contract: r2(projects.reduce((t, p) => t + (Number(p.contract_gross) || 0), 0)),
          collected: r2(projects.reduce((t, p) => t + (Number(p.collected) || 0), 0)),
          remaining: r2(projects.reduce((t, p) => t + (Number(p.remaining) || 0), 0)),
        },
        projects, payments: pays.map((x) => ({ ...x, project_number: num[String(x.project_id)] || null })),
      });
    }

    if (action === "costs-treasury") {
      const accounts = must(await supabase.from("v_account_balances")
        .select("account_id, name, kind, holder, active, opening_balance, total_in, total_out, balance").order("account_id")) as any[];
      let q = supabase.from("v_treasury_ledger")
        .select("id, entry_date, account_id, account_name, direction, amount, kind, method, reference, notes, project_number, customer_name, supplier_name, running_balance")
        .order("entry_date", { ascending: false }).order("id", { ascending: false }).limit(500);
      if (body.accountId) q = q.eq("account_id", idOf(body.accountId, "accountId"));
      if (body.supplierId) q = q.eq("supplier_id", idOf(body.supplierId, "supplierId"));
      if (body.projectId) q = q.eq("project_id", idOf(body.projectId, "projectId"));
      const from = dateOrNull(body.from, "من تاريخ"), to = dateOrNull(body.to, "إلى تاريخ");
      if (from) q = q.gte("entry_date", from);
      if (to) q = q.lte("entry_date", to);
      const ledger = must(await q) || [];
      return json({
        ok: true, accounts, ledger,
        totalBalance: r2(accounts.filter((a) => a.active).reduce((t, a) => t + (Number(a.balance) || 0), 0)),
      });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
