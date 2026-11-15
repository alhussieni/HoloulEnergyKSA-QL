// HoloulEnergy — customer-identity Edge Function
//
// دالة مرافقة (companion) على نفس نمط crm-api: لا تعدّل أي دالة قائمة، وتتحقق من نفس
// توكنات الجلسة الموقّعة (HMAC-SHA256 / SESSION_SECRET) التي تصدرها compute-quote.
//
// الصلاحيات:
//   identity-get     : أدمن فقط  — الرقم كاملاً (لإصدار العقود والتعديل)
//   identity-set     : مندوب/أدمن — إنشاء/تعديل (تطبيع + تحقق + تدقيق بدون الرقم كاملاً)
//   identity-clear   : أدمن فقط  — حذف
//   identity-status  : مندوب/أدمن — هل الهوية مسجّلة؟ (المندوب: نعم/لا فقط، الأدمن: مقنّعة)
//   identity-doc-upload : مندوب/أدمن — إرفاق/استبدال صورة الهوية (JPG/PNG/WEBP/PDF حتى 4MB، bucket خاص)
//   identity-doc-url    : أدمن فقط — رابط مؤقت (120 ثانية) لعرض الصورة
//   address-set      : مندوب/أدمن — حفظ العنوان الوطني للعميل (اختياري، jsonb مرن)
//
// لا يُكتب الرقم كاملاً في audit_log ولا في أي استجابة لغير الأدمن.
//
// النشر: ملفان (index.ts + validate.ts)، verify_jwt = false (مثل crm-api) لأن الدالة تتحقق من
// توكنها بنفسها.

import { createClient } from "npm:@supabase/supabase-js@2";
import { ID_TYPES, maskId, normalizeDigits, normalizeId, validateId } from "./validate.ts";

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

async function logAudit(auth: Auth, actionType: string, customerId: number, label: string | null, oldV: unknown, newV: unknown, entityType = "customer_identity") {
  try {
    await supabase.from("audit_log").insert({
      actor: auth.actor, actor_role: auth.isAdmin ? "admin" : "rep",
      action_type: actionType, entity_type: entityType,
      entity_id: customerId, entity_label: label, old_value: oldV ?? null, new_value: newV ?? null,
    });
  } catch { /* لا نكسر العملية الأساسية بسبب فشل التسجيل */ }
}

const ADMIN_ONLY = { error: "بيانات الهوية متاحة للأدمن فقط" };

const DOC_BUCKET = "customer-id-docs";
const DOC_MAX = 4 * 1024 * 1024;
const DOC_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
function sniffMime(b: Uint8Array): string | null {
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  return null;
}

// ---- العنوان الوطني: كل الحقول اختيارية. البنية النهائية بانتظار رد المحاسب القانوني. ----
const ADDR_DIGIT_RULES: Record<string, [RegExp, string]> = {
  building_no: [/^[0-9]{4}$/, "رقم المبنى 4 أرقام"],
  postal_code: [/^[0-9]{5}$/, "الرمز البريدي 5 أرقام"],
  additional_no: [/^[0-9]{4}$/, "الرقم الإضافي 4 أرقام"],
};
function normalizeAddress(raw: any): { value: Record<string, string> | null; error?: string } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return { value: null };
  const out: Record<string, string> = {};
  const short = normalizeDigits(raw.short_code).toUpperCase();
  if (short) {
    if (!/^[A-Z]{4}[0-9]{4}$/.test(short)) return { value: null, error: "العنوان المختصر: 4 حروف إنجليزية ثم 4 أرقام (مثال RDMC8001)" };
    out.short_code = short;
  }
  for (const k of Object.keys(ADDR_DIGIT_RULES)) {
    const v = normalizeDigits(raw[k]);
    if (!v) continue;
    if (!ADDR_DIGIT_RULES[k][0].test(v)) return { value: null, error: ADDR_DIGIT_RULES[k][1] };
    out[k] = v;
  }
  for (const k of ["street", "district", "city"]) {
    const v = String(raw[k] ?? "").trim().slice(0, 100);
    if (v) out[k] = v;
  }
  return { value: Object.keys(out).length ? out : null };
}

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
        .select("id_type, id_number, doc_path").eq("customer_id", customerId).maybeSingle();
      if (!existing) return json({ ok: true });
      const { error } = await supabase.from("customer_identity").delete().eq("customer_id", customerId);
      if (error) throw error;
      if (existing.doc_path) await supabase.storage.from(DOC_BUCKET).remove([existing.doc_path]);
      await logAudit(auth, "delete", customerId, null, { id_type: existing.id_type, masked: maskId(existing.id_number) }, null);
      return json({ ok: true });
    }

    if (action === "identity-status") {
      const ids: number[] = (Array.isArray(body.customerIds) ? body.customerIds : [body.customerId])
        .map(Number).filter((n: number) => n > 0).slice(0, 500);
      if (!ids.length) return json({ error: "customerIds required" }, 400);
      const { data, error } = await supabase.from("customer_identity")
        .select("customer_id, id_type, id_number, doc_path, doc_mime").in("customer_id", ids);
      if (error) throw error;
      const byId: Record<string, unknown> = {};
      for (const r of data || []) {
        byId[String(r.customer_id)] = auth.isAdmin
          ? { present: true, id_type: r.id_type, masked: maskId(r.id_number), doc: !!r.doc_path, doc_mime: r.doc_mime }
          : { present: true, doc: !!r.doc_path };
      }
      for (const id of ids) if (!(String(id) in byId)) byId[String(id)] = { present: false };
      return json({ ok: true, status: byId });
    }

    if (action === "identity-doc-upload") {
      const customerId = Number(body.customerId);
      if (!customerId) return json({ error: "customerId required" }, 400);
      const b64 = String(body.dataBase64 || "").replace(/^data:[^;]+;base64,/, "");
      if (!b64) return json({ error: "الملف مفقود" }, 400);
      if (b64.length > Math.ceil(DOC_MAX * 4 / 3) + 16) return json({ error: "الملف أكبر من 4 ميجا" }, 400);
      let bytes: Uint8Array;
      try {
        const bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch { return json({ error: "الملف غير صالح" }, 400); }
      if (bytes.length > DOC_MAX) return json({ error: "الملف أكبر من 4 ميجا" }, 400);
      const mime = sniffMime(bytes);
      if (!mime) return json({ error: "نوع الملف غير مدعوم (JPG أو PNG أو WEBP أو PDF)" }, 400);
      const { data: row, error: rErr } = await supabase.from("customer_identity")
        .select("doc_path").eq("customer_id", customerId).maybeSingle();
      if (rErr) throw rErr;
      if (!row) return json({ error: "سجّل رقم الهوية أولاً ثم أرفق الصورة" }, 400);
      const path = `${customerId}/${crypto.randomUUID()}.${DOC_EXT[mime]}`;
      const { error: upErr } = await supabase.storage.from(DOC_BUCKET).upload(path, bytes, { contentType: mime, upsert: false });
      if (upErr) throw upErr;
      const { error } = await supabase.from("customer_identity").update({
        doc_path: path, doc_mime: mime, doc_size: bytes.length,
        doc_uploaded_by: auth.actor, doc_uploaded_at: new Date().toISOString(),
      }).eq("customer_id", customerId);
      if (error) { await supabase.storage.from(DOC_BUCKET).remove([path]); throw error; }
      if (row.doc_path) await supabase.storage.from(DOC_BUCKET).remove([row.doc_path]);
      await logAudit(auth, row.doc_path ? "update" : "create", customerId, null, null, { mime, size: bytes.length }, "customer_identity_doc");
      return json({ ok: true, doc: { mime, size: bytes.length } });
    }

    if (action === "identity-doc-url") {
      if (!auth.isAdmin) return json(ADMIN_ONLY, 403);
      const customerId = Number(body.customerId);
      if (!customerId) return json({ error: "customerId required" }, 400);
      const { data: row, error } = await supabase.from("customer_identity")
        .select("doc_path, doc_mime").eq("customer_id", customerId).maybeSingle();
      if (error) throw error;
      if (!row?.doc_path) return json({ error: "لا توجد صورة مرفقة" }, 404);
      const { data: signed, error: sErr } = await supabase.storage.from(DOC_BUCKET).createSignedUrl(row.doc_path, 120);
      if (sErr || !signed) throw sErr || new Error("signed url failed");
      await logAudit(auth, "view", customerId, null, null, { doc: true }, "customer_identity_doc");
      return json({ ok: true, url: signed.signedUrl, mime: row.doc_mime });
    }

    if (action === "address-set") {
      const customerId = Number(body.customerId);
      if (!customerId) return json({ error: "customerId required" }, 400);
      const n = normalizeAddress(body.address);
      if (n.error) return json({ error: n.error }, 400);
      const { data: cust, error: cErr } = await supabase.from("customers")
        .select("id, name, phone, national_address").eq("id", customerId).maybeSingle();
      if (cErr) throw cErr;
      if (!cust) return json({ error: "العميل غير موجود" }, 404);
      const { error } = await supabase.from("customers")
        .update({ national_address: n.value, updated_at: new Date().toISOString() }).eq("id", customerId);
      if (error) throw error;
      await logAudit(auth, "update", customerId, cust.name || cust.phone, cust.national_address ?? null, n.value, "customer_address");
      return json({ ok: true, national_address: n.value });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
