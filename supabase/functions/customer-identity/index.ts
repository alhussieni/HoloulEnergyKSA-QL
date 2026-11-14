// HoloulEnergy — customer-identity Edge Function
//
// دالة مرافقة (companion) على نفس نمط crm-api: لا تعدّل أي دالة قائمة، وتتحقق من نفس
// توكنات الجلسة الموقّعة (HMAC-SHA256 / SESSION_SECRET) التي تصدرها compute-quote.
//
// الصلاحيات:
//   identity-get     : أدمن فقط  — الرقم كاملاً (لإصدار العقود والتعديل)
//   identity-set     : أدمن فقط  — إنشاء/تعديل (تطبيع + تحقق + تدقيق بدون الرقم كاملاً)
//   identity-clear   : أدمن فقط  — حذف
//   identity-status  : مندوب/أدمن — هل الهوية مسجّلة؟ (المندوب: نعم/لا فقط، الأدمن: مقنّعة)
//
// لا يُكتب الرقم كاملاً في audit_log ولا في أي استجابة لغير الأدمن.
//
// النشر: ملفان (index.ts + validate.ts)، verify_jwt = false (مثل crm-api) لأن الدالة تتحقق من
// توكنها بنفسها.

import { createClient } from "npm:@supabase/supabase-js@2";
import { ID_TYPES, maskId, normalizeId, validateId } from "./validate.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// ---- نفس منطق التوكن في crm-api (يجب أن يبقى متطابقاً) ----
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
async function readToken(token: string | undefined): Promise<{ sub: string; ver: number; exp: number } | null> {
  if (!token || token.split(".").length !== 2) return null;
  const [payloadB64, sig] = token.split(".");
  const expected = await hmacSign(sessionSecret(), payloadB64);
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(b64urlToString(payloadB64));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

async function checkAdminToken(token: string | undefined): Promise<boolean> {
  const payload = await readToken(token);
  if (!payload || payload.sub !== "admin") return false;
  const { data, error } = await supabase.from("admin_secret").select("session_version").eq("id", 1).single();
  if (error || !data) return false;
  return payload.ver === data.session_version;
}

async function checkRepToken(token: string | undefined): Promise<{ username: string } | null> {
  const payload = await readToken(token);
  if (!payload || !payload.sub.startsWith("rep:")) return null;
  const username = payload.sub.slice(4);
  const { data, error } = await supabase.from("reps")
    .select("username, active, session_version").eq("username", username).single();
  if (error || !data || !data.active) return null;
  if (payload.ver !== data.session_version) return null;
  return { username: data.username };
}

type Auth = { isAdmin: boolean; actor: string };

async function authenticate(body: any): Promise<Auth | null> {
  if (body.adminToken && await checkAdminToken(body.adminToken)) return { isAdmin: true, actor: "admin" };
  if (body.token) {
    const rep = await checkRepToken(body.token);
    if (rep) return { isAdmin: false, actor: rep.username };
  }
  return null;
}

async function logAudit(auth: Auth, actionType: string, customerId: number, label: string | null, oldV: unknown, newV: unknown) {
  try {
    await supabase.from("audit_log").insert({
      actor: auth.actor, actor_role: auth.isAdmin ? "admin" : "rep",
      action_type: actionType, entity_type: "customer_identity",
      entity_id: customerId, entity_label: label, old_value: oldV ?? null, new_value: newV ?? null,
    });
  } catch { /* لا نكسر العملية الأساسية بسبب فشل التسجيل */ }
}

const ADMIN_ONLY = { error: "بيانات الهوية متاحة للأدمن فقط" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  const auth = await authenticate(body);
  if (!auth) return json({ error: "الجلسة منتهية، الرجاء تسجيل الدخول مجددًا" }, 401);

  try {
    const action = body.action;

    if (action === "identity-get") {
      if (!auth.isAdmin) return json(ADMIN_ONLY, 403);
      const customerId = Number(body.customerId);
      if (!customerId) return json({ error: "customerId required" }, 400);
      const { data, error } = await supabase.from("customer_identity")
        .select("id_type, id_number, updated_by, updated_at").eq("customer_id", customerId).maybeSingle();
      if (error) throw error;
      await logAudit(auth, "view", customerId, null, null, { masked: data ? maskId(data.id_number) : null });
      return json({ ok: true, identity: data || null });
    }

    if (action === "identity-set") {
      if (!auth.isAdmin) return json(ADMIN_ONLY, 403);
      const customerId = Number(body.customerId);
      if (!customerId) return json({ error: "customerId required" }, 400);
      const idType = String(body.idType || "");
      if (!ID_TYPES.includes(idType as any)) return json({ error: "نوع الوثيقة غير معروف" }, 400);
      const idNumber = normalizeId(idType, body.idNumber);
      const v = validateId(idType, idNumber);
      if (!v.ok) return json({ error: v.error }, 400);
      if (v.checksumWarning && !body.acceptChecksumMismatch) {
        return json({ ok: false, needsConfirm: true, warning: "الرقم لا يجتاز فحص المجموع الاختباري، راجع الرقم أو أكّد الحفظ" }, 200);
      }

      const { data: cust, error: cErr } = await supabase.from("customers")
        .select("id, name, phone").eq("id", customerId).maybeSingle();
      if (cErr) throw cErr;
      if (!cust) return json({ error: "العميل غير موجود" }, 404);

      const { data: existing } = await supabase.from("customer_identity")
        .select("id_type, id_number").eq("customer_id", customerId).maybeSingle();

      const { error } = await supabase.from("customer_identity").upsert({
        customer_id: customerId, id_type: idType, id_number: idNumber,
        updated_by: auth.actor, updated_at: new Date().toISOString(),
      }, { onConflict: "customer_id" });
      if (error) {
        if ((error as any).code === "23505") return json({ error: "هذا الرقم مسجّل لعميل آخر" }, 409);
        throw error;
      }
      await logAudit(
        auth, existing ? "update" : "create", customerId, cust.name || cust.phone,
        existing ? { id_type: existing.id_type, masked: maskId(existing.id_number) } : null,
        { id_type: idType, masked: maskId(idNumber) },
      );
      return json({ ok: true, identity: { id_type: idType, masked: maskId(idNumber) } });
    }

    if (action === "identity-clear") {
      if (!auth.isAdmin) return json(ADMIN_ONLY, 403);
      const customerId = Number(body.customerId);
      if (!customerId) return json({ error: "customerId required" }, 400);
      const { data: existing } = await supabase.from("customer_identity")
        .select("id_type, id_number").eq("customer_id", customerId).maybeSingle();
      if (!existing) return json({ ok: true });
      const { error } = await supabase.from("customer_identity").delete().eq("customer_id", customerId);
      if (error) throw error;
      await logAudit(auth, "delete", customerId, null, { id_type: existing.id_type, masked: maskId(existing.id_number) }, null);
      return json({ ok: true });
    }

    if (action === "identity-status") {
      const ids: number[] = (Array.isArray(body.customerIds) ? body.customerIds : [body.customerId])
        .map(Number).filter((n: number) => n > 0).slice(0, 500);
      if (!ids.length) return json({ error: "customerIds required" }, 400);
      const { data, error } = await supabase.from("customer_identity")
        .select("customer_id, id_type, id_number").in("customer_id", ids);
      if (error) throw error;
      const byId: Record<string, unknown> = {};
      for (const r of data || []) {
        byId[String(r.customer_id)] = auth.isAdmin
          ? { present: true, id_type: r.id_type, masked: maskId(r.id_number) }
          : { present: true };
      }
      for (const id of ids) if (!(String(id) in byId)) byId[String(id)] = { present: false };
      return json({ ok: true, status: byId });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
