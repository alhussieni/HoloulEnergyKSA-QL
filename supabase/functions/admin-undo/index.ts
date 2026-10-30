// HoloulEnergy — admin-undo Edge Function (ADMIN ONLY)
// الرجوع عن آخر 6 عمليات (إضافة/تعديل/حذف) من سجل التغييرات change_journal (migration 0043).
// نفس توثيق باقي دوال الأدمن (توكن HMAC + session_version). actions: admin-undo-list, admin-undo-apply.

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
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
async function readToken(token: string | undefined): Promise<{ sub: string; ver: number; exp: number } | null> {
  if (!token || token.split(".").length !== 2) return null;
  const [payloadB64, sig] = token.split(".");
  if (!safeEqual(await hmacSign(sessionSecret(), payloadB64), sig)) return null;
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
async function logAudit(actionType: string, label: string | null, newValue: unknown) {
  try {
    await supabase.from("audit_log").insert({
      actor: "admin", actor_role: "admin", action_type: actionType, entity_type: "change_journal",
      entity_id: null, entity_label: label, old_value: null, new_value: newValue ?? null,
    });
  } catch { /* logging must never break the action */ }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!(await checkAdminToken(body.adminToken))) {
    return json({ error: "الجلسة منتهية أو غير مصرّح، الرجاء تسجيل الدخول كأدمن" }, 401);
  }

  try {
    if (body.action === "admin-undo-list") {
      const { data, error } = await supabase.rpc("journal_recent_operations", { p_limit: 6 });
      if (error) throw error;
      return json({ ok: true, operations: data || [] });
    }

    if (body.action === "admin-undo-apply") {
      const txid = Number(body.txid);
      if (!Number.isFinite(txid) || txid <= 0) return json({ error: "txid مطلوب" }, 400);
      const { data, error } = await supabase.rpc("journal_undo_last", { p_expected_txid: txid });
      if (error) {
        // الأخطاء المقصودة (raise exception) بترجع رسالة عربية واضحة؛ والعملية كلها اتلغت (transaction واحدة)
        const c = String(error.code || "");
        if (c === "P0001" || c.startsWith("23")) return json({ error: error.message }, 409);
        throw error;
      }
      if (!data?.ok) return json({ error: data?.error || "تعذر الرجوع" }, 409);
      await logAudit("undo_operation", `tx ${data.undone_txid}`, { rows: data.rows, tables: data.tables });
      return json({ ok: true, undone_txid: data.undone_txid, rows: data.rows, tables: data.tables });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
