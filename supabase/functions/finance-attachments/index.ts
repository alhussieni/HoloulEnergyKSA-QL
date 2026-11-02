// HoloulEnergy — finance-attachments Edge Function (ADMIN ONLY)
// مرفقات المالية (صور / PDF) في bucket خاص: فواتير الموردين + حركات الخزنة (قبض عميل / دفع مورد / تحويل بين الحسابات / ...).
// نفس توثيق باقي دوال المالية (توكن أدمن HMAC + session_version).
// actions: attach-upload | attach-counts | attach-list | attach-url | attach-delete
// body.target: "bill" (الافتراضي — متوافق مع النسخة الأولى) أو "entry" (حركة خزنة).

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

const BUCKET = "supplier-bill-files";
const MAX_BYTES = 8 * 1024 * 1024;   // 8MB بعد فك الـ base64
const MAX_FILES_PER_OWNER = 10;
const SIGNED_URL_SECONDS = 300;
const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "application/pdf": "pdf" };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Target = { table: string; col: string; prefix: string; entityType: string };
const TARGETS: Record<"bill" | "entry", Target> = {
  bill: { table: "supplier_bill_files", col: "bill_id", prefix: "", entityType: "supplier_bill" },
  entry: { table: "treasury_entry_files", col: "entry_id", prefix: "entry-", entityType: "treasury_entry" },
};
const targetOf = (body: any): Target => (body.target === "entry" ? TARGETS.entry : TARGETS.bill);

// نتأكد إن محتوى الملف فعلًا من النوع المعلن (مش بس الامتداد/الـ mime اللي جاي من المتصفح)
function sniffMime(b: Uint8Array): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  if (b.length > 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  return null;
}
function cleanName(n: unknown, ext: string): string {
  const base = String(n || "invoice").replace(/[\u0000-\u001f\\/]/g, "_").replace(/\.[A-Za-z0-9]{1,5}$/, "").trim().slice(0, 80) || "invoice";
  return `${base}.${ext}`;
}
function decodeBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const idOf = (v: unknown, msg: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) bad(msg);
  return n;
};

// مالك المرفقات: للفاتورة هو رقمها. لحركة خزنة: لو الحركة جزء من تحويل بين حسابات (transfer_group) أو دفعة موزّعة (payment_group)
// فالمجموعة كلها بتشارك نفس المستندات، والمالك هو أصغر id فيها (ده بيخلّي طرفي التحويل يشوفوا نفس الإيصال).
async function groupOwner(col: "transfer_group" | "payment_group", val: string): Promise<number> {
  const rows = must(await supabase.from("treasury_entries").select("id").eq(col, val).order("id").limit(1)) as { id: number }[];
  if (!rows.length) bad("الحركة غير موجودة");
  return rows[0].id;
}
async function resolveOwner(t: Target, body: any, mustExist: boolean): Promise<number> {
  if (t === TARGETS.bill) {
    const id = idOf(body.billId ?? body.ownerId, "رقم الفاتورة غير صالح");
    if (mustExist) {
      const bill = must(await supabase.from("supplier_bills").select("id").eq("id", id).maybeSingle());
      if (!bill) bad("الفاتورة غير موجودة");
    }
    return id;
  }
  if (body.transferGroup) {
    const g = String(body.transferGroup);
    if (!UUID_RE.test(g)) bad("معرّف التحويل غير صالح");
    return await groupOwner("transfer_group", g);
  }
  if (body.paymentGroup) {
    const g = String(body.paymentGroup);
    if (!UUID_RE.test(g)) bad("معرّف الدفعة غير صالح");
    return await groupOwner("payment_group", g);
  }
  const id = idOf(body.entryId ?? body.ownerId, "رقم الحركة غير صالح");
  const e = must(await supabase.from("treasury_entries").select("id, transfer_group, payment_group").eq("id", id).maybeSingle()) as any;
  if (!e) bad("الحركة غير موجودة");
  if (e.transfer_group) return await groupOwner("transfer_group", e.transfer_group);
  if (e.payment_group) return await groupOwner("payment_group", e.payment_group);
  return id;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!(await checkAdminToken(body.adminToken))) {
    return json({ error: "الجلسة منتهية أو غير مصرّح، الرجاء تسجيل الدخول كأدمن" }, 401);
  }
  const action = body.action;
  const t = targetOf(body);

  try {
    // رفع ملف واحد (بيتكرر من الواجهة لكل ملف)
    if (action === "attach-upload") {
      const owner = await resolveOwner(t, body, true);
      const { count } = await supabase.from(t.table).select("id", { count: "exact", head: true }).eq(t.col, owner);
      if ((count ?? 0) >= MAX_FILES_PER_OWNER) bad(`الحد الأقصى ${MAX_FILES_PER_OWNER} مرفقات`);

      const raw = String(body.dataBase64 || "");
      if (!raw) bad("الملف فاضي");
      if (raw.length > Math.ceil(MAX_BYTES * 4 / 3) + 8) bad("الملف أكبر من 8 ميجا");
      let bytes: Uint8Array;
      try { bytes = decodeBase64(raw); } catch { return bad("الملف غير صالح"); }
      if (!bytes.length || bytes.length > MAX_BYTES) bad("الملف أكبر من 8 ميجا");
      const mime = sniffMime(bytes);
      if (!mime) bad("نوع الملف غير مدعوم — المسموح: صورة (JPG / PNG / WEBP) أو PDF");
      const ext = EXT[mime!];

      const path = `${t.prefix}${owner}/${crypto.randomUUID()}.${ext}`;
      const up = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType: mime!, upsert: false });
      if (up.error) throw up.error;
      const name = cleanName(body.fileName, ext);
      const ins = await supabase.from(t.table)
        .insert({ [t.col]: owner, storage_path: path, file_name: name, mime_type: mime, size_bytes: bytes.length })
        .select(`id, ${t.col}, file_name, mime_type, size_bytes, created_at`).single();
      if (ins.error) {
        await supabase.storage.from(BUCKET).remove([path]); // مانسيبش ملف يتيم لو تسجيل الصف فشل
        throw ins.error;
      }
      await logAudit(t === TARGETS.bill ? "add_bill_file" : "add_entry_file", t.entityType, owner, name, null, { size: bytes.length, mime });
      return json({ ok: true, file: ins.data, ownerId: owner });
    }

    // عدد المرفقات لكل فاتورة / حركة (لعمود 📎 في القوائم). في الحركات: كل أعضاء المجموعة (تحويل / دفعة موزّعة) بياخدوا نفس العدد.
    if (action === "attach-counts") {
      const rows = must(await supabase.from(t.table).select(t.col).limit(5000)) as any[];
      const owned: Record<string, number> = {};
      for (const r of rows) owned[String(r[t.col])] = (owned[String(r[t.col])] || 0) + 1;
      const counts: Record<string, number> = { ...owned };
      if (t === TARGETS.entry && rows.length) {
        const own = must(await supabase.from("treasury_entries").select("id, transfer_group, payment_group")
          .in("id", Object.keys(owned).map(Number))) as any[];
        const byGroup: Record<string, number> = {};
        for (const o of own) { const g = o.transfer_group || o.payment_group; if (g) byGroup[g] = owned[String(o.id)]; }
        const tg = own.map((o) => o.transfer_group).filter(Boolean), pg = own.map((o) => o.payment_group).filter(Boolean);
        const sibs: { id: number; g: string }[] = [];
        if (tg.length) for (const x of must(await supabase.from("treasury_entries").select("id, transfer_group").in("transfer_group", tg)) as any[]) sibs.push({ id: x.id, g: x.transfer_group });
        if (pg.length) for (const x of must(await supabase.from("treasury_entries").select("id, payment_group").in("payment_group", pg)) as any[]) sibs.push({ id: x.id, g: x.payment_group });
        for (const s of sibs) if (byGroup[s.g]) counts[String(s.id)] = byGroup[s.g];
      }
      return json({ ok: true, counts });
    }

    // مرفقات فاتورة / حركة معينة
    if (action === "attach-list") {
      const owner = await resolveOwner(t, body, false);
      const files = must(await supabase.from(t.table)
        .select(`id, ${t.col}, file_name, mime_type, size_bytes, created_at`).eq(t.col, owner).order("id"));
      return json({ ok: true, files, ownerId: owner });
    }

    // رابط عرض مؤقت (٥ دقايق) — الملف نفسه خاص ومالوش رابط عام
    if (action === "attach-url") {
      const id = idOf(body.fileId, "رقم المرفق غير صالح");
      const f = must(await supabase.from(t.table).select("storage_path, file_name, mime_type").eq("id", id).maybeSingle()) as any;
      if (!f) bad("المرفق غير موجود");
      const s = await supabase.storage.from(BUCKET).createSignedUrl(f.storage_path, SIGNED_URL_SECONDS);
      if (s.error || !s.data) throw s.error || new Error("تعذر إنشاء رابط العرض");
      return json({ ok: true, url: s.data.signedUrl, fileName: f.file_name, mimeType: f.mime_type });
    }

    if (action === "attach-delete") {
      const id = idOf(body.fileId, "رقم المرفق غير صالح");
      const f = must(await supabase.from(t.table).select(`id, ${t.col}, storage_path, file_name`).eq("id", id).maybeSingle()) as any;
      if (!f) bad("المرفق غير موجود");
      const rm = await supabase.storage.from(BUCKET).remove([f.storage_path]);
      if (rm.error) throw rm.error;
      must(await supabase.from(t.table).delete().eq("id", id));
      await logAudit(t === TARGETS.bill ? "delete_bill_file" : "delete_entry_file", t.entityType, f[t.col], f.file_name, { file_name: f.file_name }, null);
      return json({ ok: true });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
