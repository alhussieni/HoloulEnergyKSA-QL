// HoloulEnergy — costs-api Edge Function (READ-ONLY)
//
// Lets a rep who was explicitly granted `reps.can_view_costs = true` VIEW
// costs: project costs, suppliers (balances / statements / bills) and the
// treasury (account balances + ledger). Admin tokens are accepted too.
//
// Hard rules enforced here (never in the browser):
//   * Valid signed session token (HMAC, SESSION_SECRET) + matching
//     session_version + rep is active + can_view_costs === true.
//   * Every action is a SELECT. There is no insert/update/delete/rpc anywhere
//     in this file — keep it that way.
//   * Profit / margin / partner data is deliberately NOT exposed:
//     v_project_profit is read through an explicit column allow-list that
//     leaves out actual_profit and margin_pct, and partner tables are never
//     touched.
//   * Same token scheme as crm-api / finance-* (rep tokens: sub = "rep:<user>").

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
async function readToken(token: unknown): Promise<{ sub: string; ver: number; exp: number } | null> {
  if (typeof token !== "string" || token.split(".").length !== 2) return null;
  const [payloadB64, sig] = token.split(".");
  if ((await hmacSign(sessionSecret(), payloadB64)) !== sig) return null;
  try {
    const payload = JSON.parse(b64urlToString(payloadB64));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof payload.sub !== "string") return null;
    return payload;
  } catch { return null; }
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

type Who = { kind: "admin" } | { kind: "rep"; username: string; allowed: boolean };

async function authenticate(body: any): Promise<Who | null> {
  if (body.adminToken) {
    const p = await readToken(body.adminToken);
    if (p && p.sub === "admin") {
      const { data, error } = await supabase.from("admin_secret").select("session_version").eq("id", 1).single();
      if (!error && data && p.ver === data.session_version) return { kind: "admin" };
    }
  }
  if (body.token) {
    const p = await readToken(body.token);
    if (p && p.sub.startsWith("rep:")) {
      const username = p.sub.slice(4);
      const { data, error } = await supabase.from("reps")
        .select("username, active, session_version, can_view_costs").eq("username", username).single();
      if (!error && data && data.active && p.ver === data.session_version) {
        return { kind: "rep", username: data.username, allowed: data.can_view_costs === true };
      }
    }
  }
  return null;
}

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

// Columns of v_project_profit a cost-viewer may see. NO actual_profit, NO margin_pct.
const PROJECT_COLS = "project_id, project_number, customer_name, status, is_completed, completion_date, contract_gross, cost_gross, cost_net, collected, remaining";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  const who = await authenticate(body);
  if (!who) return json({ error: "الجلسة منتهية، الرجاء تسجيل الدخول مجددًا" }, 401);

  const action = body.action;

  // Lets the UI decide whether to show the tab. Never an error for a valid
  // session: a rep without the grant simply gets allowed:false.
  if (action === "costs-access") {
    return json({ ok: true, allowed: who.kind === "admin" || who.allowed });
  }

  if (who.kind === "rep" && !who.allowed) {
    return json({ error: "ليس لديك صلاحية عرض التكاليف" }, 403);
  }

  try {
    // ------------------------------------------------------------ projects
    if (action === "costs-projects") {
      const rows = must(await supabase.from("v_project_profit").select(PROJECT_COLS).order("project_id", { ascending: false }).limit(1000));
      return json({ ok: true, projects: rows || [] });
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

    // ----------------------------------------------------------- suppliers
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

    // ------------------------------------------------------------ treasury
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
