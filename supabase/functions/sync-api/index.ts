// HoloulEnergy — sync-api
// actions:
//   lease          : يصدر عقد صلاحية 24 ساعة موقّعًا (ECDSA P-256)
//   push           : يستقبل عمليات الأوفلاين (أو عمليات أونلاين تمر بنفس المسار لضمان عدم التكرار)
//   review-list    : (أدمن) العمليات المتأخرة/الفاشلة/العالقة
//   review-decide  : (أدمن) approve | reject
//
// المبدأ: لا تُكرَّر قواعد الأعمال هنا. بعد التحقق من الهوية والعقد والترقيم، تُمرَّر العملية
// إلى الدالة الأصلية (finance-treasury / supply-api) بتوكن صاحبها نفسه، فتبقى كل
// القواعد والتدقيق والصلاحيات كما هي.
//
// الأسرار: SESSION_SECRET (موجود). مفتاح توقيع العقود مخزّن في جدول offline_keys (المفتاح العام مضمّن في holoul-offline.js).

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const FN_BASE = Deno.env.get("SUPABASE_URL")! + "/functions/v1/";

const LEASE_TTL_MS = 24 * 3600 * 1000;
const MAX_OPS_PER_PUSH = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_RE = /^[A-Za-z0-9-]{16,64}$/;

// ---------- مساعدات التوكن (نسخة من auth-api) ----------
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
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function hmacSign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64urlFromBytes(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))));
}
async function readToken(token: unknown): Promise<{ sub: string; ver: number; exp: number } | null> {
  if (typeof token !== "string" || token.split(".").length !== 2) return null;
  const secret = Deno.env.get("SESSION_SECRET");
  if (!secret) throw new Error("SESSION_SECRET is not configured");
  const [p, sig] = token.split(".");
  if (!safeEq(await hmacSign(secret, p), sig)) return null;
  try {
    const payload = JSON.parse(b64urlToString(p));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// ---------- هوية المنفّذ (نفس فحص session_version في auth-api) ----------
type Actor = { actor: string; kind: "admin" | "staff" | "rep"; ver: number };
async function verifyActor(token: unknown): Promise<Actor | null> {
  const t = await readToken(token);
  if (!t || typeof t.sub !== "string") return null;
  if (t.sub === "admin") {
    const { data } = await supabase.from("admin_secret").select("session_version").eq("id", 1).maybeSingle();
    return data && data.session_version === t.ver ? { actor: "admin", kind: "admin", ver: t.ver } : null;
  }
  if (t.sub.startsWith("staff:")) {
    const { data } = await supabase.from("staff_accounts").select("active, session_version")
      .eq("username", t.sub.slice(6)).maybeSingle();
    return data?.active && data.session_version === t.ver ? { actor: t.sub, kind: "staff", ver: t.ver } : null;
  }
  if (t.sub.startsWith("rep:")) {
    const { data } = await supabase.from("reps").select("active, session_version")
      .eq("username", t.sub.slice(4)).maybeSingle();
    return data?.active && data.session_version === t.ver ? { actor: t.sub, kind: "rep", ver: t.ver } : null;
  }
  return null;
}

// ---------- الأنواع المسموحة وتوجيهها للدوال الأصلية (مرحلة 1: نقدية + بضاعة فقط) ----------
type Route = { fn: string; actions: string[]; check?: (p: any) => boolean; kinds: Actor["kind"][] };
const ROUTES: Record<string, Route> = {
  // finance-treasury أدمن فقط (مؤكد من الكود)
  cash_receipt:   { fn: "finance-treasury", actions: ["treasury-record-entry"], kinds: ["admin"],
                    check: (p) => p?.kind === "customer_receipt" },
  cash_payment:   { fn: "finance-treasury", actions: ["treasury-record-entry"], kinds: ["admin"],
                    check: (p) => ["supplier_payment", "expense"].includes(p?.kind) },
  // supply-api: أدمن أو مندوب بصلاحية reps.permissions.supply (تفرضها الدالة الأصلية نفسها)
  goods_receipt:  { fn: "supply-api", actions: ["supply-add-serials", "supply-record-qty"], kinds: ["admin", "rep"] },
  goods_delivery: { fn: "supply-api", actions: ["supply-set-status"], kinds: ["admin", "rep"] },
};

function validateOp(a: Actor, o: any): string | null {
  if (!UUID_RE.test(String(o.client_op_id)) || !UUID_RE.test(String(o.lease_id))) return "bad_request";
  if (!Number.isInteger(o.device_seq) || o.device_seq < 1) return "bad_request";
  if (Number.isNaN(Date.parse(o.client_created_at))) return "bad_request";
  const route = ROUTES[o.op_type];
  if (!route) return "unsupported_type";
  if (!o.payload || typeof o.payload !== "object" || typeof o.payload.action !== "string") return "bad_request";
  if (!route.actions.includes(o.payload.action)) return "action_not_allowed";
  if (route.check && !route.check(o.payload.params)) return "params_not_allowed";
  if (!route.kinds.includes(a.kind)) return "forbidden";
  return null;
}

// ---------- التمرير للدالة الأصلية بتوكن صاحب العملية ----------
async function forward(opType: string, payload: { action: string; params?: any }, kind: Actor["kind"], token: string) {
  const route = ROUTES[opType];
  const clean = { ...(payload.params || {}) };
  delete clean.action; delete clean.adminToken; delete clean.token;   // لا يُسمح للعميل بحقن حقول المصادقة
  const authField = kind === "admin" ? { adminToken: token } : { token };
  const res = await fetch(FN_BASE + route.fn, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: Deno.env.get("SUPABASE_ANON_KEY") || "" },
    body: JSON.stringify({ action: payload.action, ...clean, ...authField }),
  });
  let data: any;
  try { data = await res.json(); } catch { throw new Error("رد غير صالح من الدالة الأصلية"); }
  if (!res.ok || data?.error) throw new Error(String(data?.error || "downstream_error"));
  return data;
}

async function applyAndRecord(id: number, opType: string, payload: any, kind: Actor["kind"], token: string) {
  try {
    const result = await forward(opType, payload, kind, token);
    await supabase.from("offline_ops").update({ status: "applied", result }).eq("id", id);
    return { status: "applied", result };
  } catch (e) {
    const msg = String((e as any)?.message || e);
    await supabase.from("offline_ops").update({ status: "failed", reject_reason: msg }).eq("id", id);
    return { status: "failed", reject_reason: msg };
  }
}

// ---------- العقد الموقّع ----------
// مفتاح التوقيع في جدول offline_keys (service_role فقط). تزوير توقيع لا يمنح شيئًا على السيرفر لأن كل عملية
// تُتحقق من lease_id في device_leases؛ التوقيع يحمي فقط قفل الواجهة من العبث العرضي بالعقد المخزّن.
let _signKey: CryptoKey | null = null;
async function signLease(leaseJson: string): Promise<string> {
  if (!_signKey) {
    const { data, error } = await supabase.from("offline_keys").select("private_jwk").eq("id", 1).single();
    if (error || !data) throw new Error("lease signing key missing");
    _signKey = await crypto.subtle.importKey("jwk", data.private_jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  }
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, _signKey, new TextEncoder().encode(leaseJson));
  return b64urlFromBytes(new Uint8Array(sig));
}
async function issueLease(a: Actor, deviceId: string, priceVersion: string | null) {
  const now = new Date();
  const expires = new Date(now.getTime() + LEASE_TTL_MS);
  const { data, error } = await supabase.from("device_leases").insert({
    device_id: deviceId, actor: a.actor, actor_ver: a.ver,
    issued_at: now.toISOString(), expires_at: expires.toISOString(), price_version: priceVersion,
  }).select("id").single();
  if (error) throw new Error("lease_insert_failed: " + error.message);
  // الواجهة تتحقق من التوقيع على هذا النص كما هو (بدون إعادة تسلسل)
  const lease_json = JSON.stringify({
    id: data.id, device_id: deviceId, actor: a.actor,
    server_time: now.toISOString(), expires_at: expires.toISOString(), price_version: priceVersion,
  });
  return { lease_json, sig: await signLease(lease_json) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  try {
    const a = await verifyActor(body.token);
    if (!a) return json({ error: "الجلسة منتهية، الرجاء تسجيل الدخول مجددًا" }, 401);

    // ---- مراجعة الأدمن (لا تحتاج device_id) ----
    if (body.action === "review-list" || body.action === "review-decide") {
      if (a.kind !== "admin") return json({ error: "للأدمن فقط" }, 403);
      if (body.action === "review-list") {
        const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const { data, error } = await supabase.from("offline_ops")
          .select("id, actor, device_id, op_type, payload, client_created_at, received_at, flags, status, reject_reason, result")
          .or(`status.in.(pending_review,failed),and(status.eq.accepted,received_at.lt.${tenMinAgo})`)
          .order("received_at", { ascending: true }).limit(200);
        if (error) throw error;
        return json({ ok: true, ops: data });
      }
      const id = Number(body.id);
      const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
      if (!Number.isInteger(id) || id <= 0) return json({ error: "bad_id" }, 400);
      const { data: op, error } = await supabase.from("offline_ops").select("*").eq("id", id).single();
      if (error || !op) return json({ error: "not_found" }, 404);
      if (!["pending_review", "failed", "accepted"].includes(op.status)) return json({ error: "already_final" }, 409);
      const stamp = { reviewed_by: a.actor, reviewed_at: new Date().toISOString(), review_note: note };
      if (body.decision === "reject") {
        await supabase.from("offline_ops").update({ ...stamp, status: "rejected", reject_reason: "admin_rejected" }).eq("id", id);
        return json({ ok: true, status: "rejected" });
      }
      if (body.decision === "approve") {
        // يُطبَّق بتوكن الأدمن المراجع، فيُسجَّل في الدالة الأصلية كأدمن (يُحفظ صاحب العملية الأصلي في offline_ops.actor)
        await supabase.from("offline_ops").update(stamp).eq("id", id);
        const r = await applyAndRecord(id, op.op_type, op.payload, "admin", body.token);
        return json({ ok: true, ...r });
      }
      return json({ error: "bad_decision" }, 400);
    }

    // ---- بقية الإجراءات تتطلب جهازًا ----
    const deviceId = String(body.device_id ?? "");
    if (!DEVICE_RE.test(deviceId)) return json({ error: "bad_device_id" }, 400);
    const priceVersion = typeof body.price_version === "string" ? body.price_version.slice(0, 64) : null;

    if (body.action === "lease") {
      return json({ ok: true, ...(await issueLease(a, deviceId, priceVersion)) });
    }

    if (body.action === "push") {
      const ops = Array.isArray(body.ops) ? body.ops : [];
      if (ops.length > MAX_OPS_PER_PUSH) return json({ error: "too_many_ops" }, 400);
      ops.sort((x: any, y: any) => Number(x.device_seq) - Number(y.device_seq));

      const results: any[] = [];
      for (const o of ops) {
        const invalid = validateOp(a, o);
        if (invalid) { results.push({ client_op_id: o.client_op_id, status: "rejected", reject_reason: invalid }); continue; }

        const { data, error } = await supabase.rpc("offline_register_op", {
          p_device_id: deviceId, p_actor: a.actor, p_device_seq: o.device_seq,
          p_client_op_id: o.client_op_id, p_lease_id: o.lease_id, p_op_type: o.op_type,
          p_payload: o.payload, p_client_created_at: new Date(o.client_created_at).toISOString(),
        });
        if (error) { results.push({ client_op_id: o.client_op_id, status: "failed", reject_reason: error.message }); continue; }

        let r = data as any;
        if (r.status === "accepted" && !r.duplicate) {
          r = { ...r, ...(await applyAndRecord(r.id, o.op_type, o.payload, a.kind, body.token)) };
        }
        results.push({ client_op_id: o.client_op_id, ...r });
      }
      // المزامنة = تجديد العقد (بعد معالجة العمليات لا قبلها)
      return json({ ok: true, results, ...(await issueLease(a, deviceId, priceVersion)) });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
