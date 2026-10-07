// HoloulEnergy — crm-pipeline Edge Function
//
// Server-side engine for the CRM pipeline screen (board + table views):
// filtering, per-stage paging, sorting, follow-up alerts and bulk updates.
// Like crm-api / invoice-api it does NOT implement its own login — it verifies
// the same signed session tokens issued by compute-quote (HMAC-SHA256 with the
// SESSION_SECRET project secret). Heavy lifting lives in Postgres functions
// (see migration 0025_pipeline_server_side.sql); this file is a thin, auth-gated wrapper.

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
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
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64urlFromBytes(new Uint8Array(sig));
}
function sessionSecret(): string {
  const s = Deno.env.get("SESSION_SECRET");
  if (!s) throw new Error("SESSION_SECRET is not configured for this project");
  return s;
}
async function readToken(token: any): Promise<any> {
  if (!token || typeof token !== "string" || token.split(".").length !== 2) return null;
  const [payloadB64, sig] = token.split(".");
  const expected = await hmacSign(sessionSecret(), payloadB64);
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(b64urlToString(payloadB64));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

const supabase: any = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function checkAdminToken(token: any): Promise<boolean> {
  const payload = await readToken(token);
  if (!payload || payload.sub !== "admin") return false;
  const { data, error } = await supabase.from("admin_secret").select("session_version").eq("id", 1).single();
  if (error || !data) return false;
  return payload.ver === data.session_version;
}

async function checkRepToken(token: any): Promise<{ username: string; displayName: string } | null> {
  const payload = await readToken(token);
  if (!payload || typeof payload.sub !== "string" || !payload.sub.startsWith("rep:")) return null;
  const username = payload.sub.slice(4);
  const { data, error } = await supabase.from("reps")
    .select("username, display_name, active, session_version").eq("username", username).single();
  if (error || !data || !data.active) return null;
  if (payload.ver !== data.session_version) return null;
  return { username: data.username, displayName: data.display_name };
}

async function authenticate(body: any): Promise<any> {
  if (body.adminToken) {
    if (await checkAdminToken(body.adminToken)) return { isAdmin: true, rep: null };
  }
  if (body.token) {
    const rep = await checkRepToken(body.token);
    if (rep) return { isAdmin: false, rep };
  }
  return null;
}

function normName(s: any): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

// Only these filter keys ever reach SQL, and only as plain strings/booleans.
function cleanFilters(f: any): any {
  f = f && typeof f === "object" ? f : {};
  const str = (v: any, max = 120) => (typeof v === "string" ? v.slice(0, max) : "");
  return {
    search: str(f.search, 100),
    rep: normName(str(f.rep)),
    segment: ["small", "medium", "large", "mega"].includes(f.segment) ? f.segment : "",
    type: str(f.type, 60),
    overdue: f.overdue === true,
    stale: f.stale === true,
  };
}
function intIn(v: any, def: number, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

async function logAudit(auth: any, rows: any[]) {
  if (!rows.length) return;
  try {
    await supabase.from("audit_log").insert(rows.map((r) => ({
      actor: auth.isAdmin ? "admin" : (auth.rep ? auth.rep.username : "unknown"),
      actor_role: auth.isAdmin ? "admin" : "rep",
      action_type: r.action_type, entity_type: "opportunity", entity_id: r.id, entity_label: r.label,
      old_value: r.old ?? null, new_value: r.new ?? null,
    })));
  } catch { /* never fail the action over a logging problem */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  const auth = await authenticate(body);
  if (!auth) return json({ error: "الجلسة منتهية، الرجاء تسجيل الدخول مجددًا" }, 401);

  const action = body.action;
  try {
    // ---- board: per-stage totals + first N cards of each open stage (+ any expanded closed stage)
    if (action === "pipeline-board") {
      const perStage = intIn(body.perStage, 12, 1, 50);
      const expand = Array.isArray(body.expand) ? body.expand.filter((s: any) => typeof s === "string").slice(0, 20) : [];
      const { data, error } = await supabase.rpc("pipeline_board", {
        p: cleanFilters(body.filters), p_per_stage: perStage, p_expand: expand,
      });
      if (error) throw error;
      return json({ ok: true, ...data });
    }

    // ---- stage-page: next page of cards for one stage ("show more" / expanding won & lost)
    if (action === "pipeline-stage-page") {
      if (typeof body.stage !== "string" || !body.stage) return json({ error: "stage required" }, 400);
      const { data, error } = await supabase.rpc("pipeline_stage_page", {
        p: cleanFilters(body.filters), p_stage: body.stage,
        p_offset: intIn(body.offset, 0, 0, 100000), p_limit: intIn(body.limit, 12, 1, 200),
      });
      if (error) throw error;
      return json({ ok: true, ...data });
    }

    // ---- table: sortable, paginated flat list
    if (action === "pipeline-table") {
      const { data, error } = await supabase.rpc("pipeline_table", {
        p: cleanFilters(body.filters), p_sort: String(body.sort || ""), p_dir: String(body.dir || "desc"),
        p_offset: intIn(body.offset, 0, 0, 1000000), p_limit: intIn(body.limit, 25, 1, 200),
      });
      if (error) throw error;
      return json({ ok: true, ...data });
    }

    // ---- alerts: overdue / stale / due-today counts (admin = everyone + per-rep, rep = own deals)
    if (action === "pipeline-alerts") {
      const rep = auth.isAdmin ? null : normName(auth.rep.displayName);
      const { data, error } = await supabase.rpc("pipeline_alerts", { p_rep: rep });
      if (error) throw error;
      return json({ ok: true, scope: auth.isAdmin ? "all" : "mine", ...data });
    }

    // ---- reps: active rep names for the bulk "assign to" dropdown (admin only)
    if (action === "pipeline-reps") {
      if (!auth.isAdmin) return json({ error: "متاح للأدمن بس" }, 403);
      const { data, error } = await supabase.from("reps").select("display_name").eq("active", true).order("display_name");
      if (error) throw error;
      return json({ ok: true, reps: (data || []).map((r: any) => normName(r.display_name)).filter(Boolean) });
    }

    // ---- bulk-update: stage / assignee / follow-up date for many opportunities at once
    if (action === "pipeline-bulk-update") {
      const ids = Array.isArray(body.ids)
        ? [...new Set(body.ids.map((x: any) => Number(x)).filter((n: number) => Number.isInteger(n) && n > 0))] as number[]
        : [];
      if (!ids.length) return json({ error: "اختر صفقة واحدة على الأقل" }, 400);
      if (ids.length > 200) return json({ error: "الحد الأقصى 200 صفقة في المرة" }, 400);
      const f = body.fields && typeof body.fields === "object" ? body.fields : {};

      const update: any = {};
      let newStage: string | null = null;
      if (f.stage !== undefined && f.stage !== "") {
        const { data: st } = await supabase.from("crm_settings").select("data").eq("id", 1).maybeSingle();
        const valid = (st?.data?.opportunityStages || []).map((s: any) => s.value);
        if (!valid.includes(f.stage)) return json({ error: "مرحلة غير معروفة" }, 400);
        newStage = f.stage;
        update.stage = newStage;
        update.stage_changed_at = new Date().toISOString();
        if (newStage === "lost") {
          if (!f.lost_reason) return json({ error: "لازم تختار سبب الخسارة عند النقل لمرحلة 'اتفقدت'" }, 400);
          update.lost_reason = String(f.lost_reason).slice(0, 200);
        }
      }
      if (f.sales_person !== undefined && f.sales_person !== "") {
        if (!auth.isAdmin) return json({ error: "تغيير المندوب متاح للأدمن بس" }, 403);
        update.sales_person = normName(f.sales_person).slice(0, 120);
      }
      if (f.next_follow_up_date !== undefined && f.next_follow_up_date !== "") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f.next_follow_up_date))) return json({ error: "تاريخ المتابعة غير صحيح" }, 400);
        update.next_follow_up_date = f.next_follow_up_date;
      }
      if (!Object.keys(update).length) return json({ error: "مفيش تغيير مطلوب" }, 400);
      update.updated_at = new Date().toISOString();

      const { data: rows, error: rErr } = await supabase.from("opportunities")
        .select("id, name, stage, sales_person").in("id", ids);
      if (rErr) throw rErr;
      const me = auth.isAdmin ? null : normName(auth.rep.displayName);
      const allowed = (rows || []).filter((r: any) => auth.isAdmin || normName(r.sales_person) === me);
      const allowedIds = allowed.map((r: any) => r.id);
      if (!allowedIds.length) return json({ error: "مفيش صفقات مسموح لك تعدلها من اللي اخترتها" }, 403);

      const { error: uErr } = await supabase.from("opportunities").update(update).in("id", allowedIds);
      if (uErr) throw uErr;

      await logAudit(auth, allowed
        .filter((r: any) => newStage && r.stage !== newStage)
        .map((r: any) => ({ action_type: "stage_change", id: r.id, label: r.name, old: { stage: r.stage }, new: { stage: newStage, bulk: true } })));

      return json({ ok: true, updated: allowedIds.length, skipped: ids.length - allowedIds.length });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err: any) {
    return json({ error: String(err?.message || err) }, 500);
  }
});
