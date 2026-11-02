// HoloulEnergy — finance-attachments Edge Function (ADMIN ONLY)
// مرفقات المالية (صور / PDF) في bucket خاص: فواتير الموردين + حركات الخزنة (قبض عميل / دفع مورد / تحويل بين الحسابات / ...).
// نفس توثيق باقي دوال المالية (توكن أدمن HMAC + session_version).
// actions: attach-upload | attach-counts | attach-list | attach-url | attach-delete | attach-supplier / attach-customer (كل مستندات مورد أو عميل بروابط عرض مؤقتة — لطباعة كشف الحساب مع المرفقات)
// body.target: "bill" (الافتراضي — متوافق مع النسخة الأولى) أو "entry" (حركة خزنة).
// الفاتورة الموزّعة على أكتر من مشروع (bill_group) والتحويل/الدفعة الموزّعة بيشاركوا نفس المستندات: المالك = أصغر id في المجموعة.

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
async function groupOwner(table: "treasury_entries" | "supplier_bills", col: "transfer_group" | "payment_group" | "bill_group", val: string): Promise<number> {
  const rows = must(await supabase.from(table).select("id").eq(col, val).order("id").limit(1)) as { id: number }[];
  if (!rows.length) bad(table === "supplier_bills" ? "الفاتورة غير موجودة" : "الحركة غير موجودة");
  return rows[0].id;
}
async function resolveOwner(t: Target, body: any, mustExist: boolean): Promise<number> {
  if (t === TARGETS.bill) {
    if (body.billGroup) {
      const g = String(body.billGroup);
      if (!UUID_RE.test(g)) bad("معرّف الفاتورة الموزّعة غير صالح");
      return await groupOwner("supplier_bills", "bill_group", g);
    }
    const id = idOf(body.billId ?? body.ownerId, "رقم الفاتورة غير صالح");
    const bill = must(await supabase.from("supplier_bills").select("id, bill_group").eq("id", id).maybeSingle()) as any;
    if (!bill) { if (mustExist) bad("الفاتورة غير موجودة"); return id; }
    if (bill.bill_group) return await groupOwner("supplier_bills", "bill_group", bill.bill_group);
    return id;
  }
  if (body.transferGroup) {
    const g = String(body.transferGroup);
    if (!UUID_RE.test(g)) bad("معرّف التحويل غير صالح");
    return await groupOwner("treasury_entries", "transfer_group", g);
  }
  if (body.paymentGroup) {
    const g = String(body.paymentGroup);
    if (!UUID_RE.test(g)) bad("معرّف الدفعة غير صالح");
    return await groupOwner("treasury_entries", "payment_group", g);
  }
  const id = idOf(body.entryId ?? body.ownerId, "رقم الحركة غير صالح");
  const e = must(await supabase.from("treasury_entries").select("id, transfer_group, payment_group").eq("id", id).maybeSingle()) as any;
  if (!e) bad("الحركة غير موجودة");
  if (e.transfer_group) return await groupOwner("treasury_entries", "transfer_group", e.transfer_group);
  if (e.payment_group) return await groupOwner("treasury_entries", "payment_group", e.payment_group);
  return id;
}

// أصغر id في كل مجموعة (تحويل / دفعة موزّعة / فاتورة موزّعة) = مالك المستندات. بترجّع خريطة: id الصف → id المالك.
async function ownersOfRows(src: "supplier_bills" | "treasury_entries", gcols: string[], rows: any[]): Promise<Record<string, number>> {
  const minBy: Record<string, number> = {};
  for (const gc of gcols) {
    const gs = [...new Set(rows.map((r) => r[gc]).filter(Boolean))];
    if (!gs.length) continue;
    for (const x of must(await supabase.from(src).select(`id, ${gc}`).in(gc, gs)) as any[]) {
      const k = `${gc}:${x[gc]}`;
      if (minBy[k] === undefined || x.id < minBy[k]) minBy[k] = x.id;
    }
  }
  const owner: Record<string, number> = {};
  for (const r of rows) {
    let o = r.id;
    for (const gc of gcols) if (r[gc]) { o = minBy[`${gc}:${r[gc]}`] ?? r.id; break; }
    owner[String(r.id)] = o;
  }
  return owner;
}
// ملفات المالكين بروابط عرض مؤقتة: id المالك → [{ id, file_name, mime_type, url }]
async function filesByOwner(tg: Target, ownerIds: number[], ttl: number): Promise<Record<string, any[]>> {
  const byOwner: Record<string, any[]> = {};
  if (!ownerIds.length) return byOwner;
  const files = must(await supabase.from(tg.table).select(`id, ${tg.col}, storage_path, file_name, mime_type`).in(tg.col, ownerIds).order("id")) as any[];
  if (!files.length) return byOwner;
  const signed = await supabase.storage.from(BUCKET).createSignedUrls(files.map((f) => f.storage_path), ttl);
  if (signed.error) throw signed.error;
  const urlOf: Record<string, string> = {};
  for (const x of signed.data || []) if (x.path && x.signedUrl) urlOf[x.path] = x.signedUrl;
  for (const f of files) {
    const url = urlOf[f.storage_path];
    if (!url) continue;
    (byOwner[String(f[tg.col])] ||= []).push({ id: f.id, file_name: f.file_name, mime_type: f.mime_type, url });
  }
  return byOwner;
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

    // عدد المرفقات لكل فاتورة / حركة (لعمود 📎 في القوائم). أعضاء نفس المجموعة (تحويل / دفعة موزّعة / فاتورة موزّعة) بياخدوا نفس العدد.
    if (action === "attach-counts") {
      const rows = must(await supabase.from(t.table).select(t.col).limit(5000)) as any[];
      const owned: Record<string, number> = {};
      for (const r of rows) owned[String(r[t.col])] = (owned[String(r[t.col])] || 0) + 1;
      const counts: Record<string, number> = { ...owned };
      if (rows.length) {
        const src = t === TARGETS.entry ? "treasury_entries" : "supplier_bills";
        const gcols = t === TARGETS.entry ? ["transfer_group", "payment_group"] : ["bill_group"];
        const own = must(await supabase.from(src).select(["id", ...gcols].join(", ")).in("id", Object.keys(owned).map(Number))) as any[];
        for (const gc of gcols) {
          const byGroup: Record<string, number> = {};
          for (const o of own) if (o[gc]) byGroup[o[gc]] = owned[String(o.id)];
          const gs = Object.keys(byGroup);
          if (!gs.length) continue;
          for (const x of must(await supabase.from(src).select(`id, ${gc}`).in(gc, gs)) as any[]) counts[String(x.id)] = byGroup[x[gc]];
        }
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

    // كل مستندات مورد (فواتير أصلية + تحويلات/دفعات) بروابط عرض مؤقتة ساعة — لطباعة كشف الحساب مع المرفقات.
    // النتيجة بتتفهرس بـ id الفاتورة / الحركة (وأعضاء نفس المجموعة بياخدوا مستندات مالك المجموعة).
    if (action === "attach-supplier") {
      const sid = idOf(body.supplierId, "رقم المورد غير صالح");
      const out: Record<string, Record<string, unknown[]>> = { bills: {}, entries: {} };
      for (const [key, src, gcols, tg] of [
        ["bills", "supplier_bills", ["bill_group"], TARGETS.bill],
        ["entries", "treasury_entries", ["transfer_group", "payment_group"], TARGETS.entry],
      ] as const) {
        const rows = must(await supabase.from(src).select(["id", ...gcols].join(", ")).eq("supplier_id", sid).limit(5000)) as any[];
        const owner = await ownersOfRows(src, [...gcols], rows);
        const byOwner = await filesByOwner(tg, [...new Set(Object.values(owner))], 3600);
        for (const [rid, o] of Object.entries(owner)) if (byOwner[String(o)]) out[key][rid] = byOwner[String(o)];
      }
      return json({ ok: true, bills: out.bills, entries: out.entries });
    }

    // مستندات كشف حساب عميل (أو مشروع): إيصالات/تحويلات العميل (مفهرسة بـ payment_id) + فواتير الموردين اللي على مشاريعه.
    // الفاتورة الموزّعة بترجع كاملة (ملفها مرة واحدة) مع كل أجزائها ومشاريعها وقيمة كل جزء، حتى لو بعض الأجزاء على مشاريع عملاء تانيين (own=false).
    if (action === "attach-customer") {
      const sel = supabase.from("projects").select("id, project_number, customer_id");
      const projects = (body.customerId
        ? must(await sel.eq("customer_id", idOf(body.customerId, "رقم العميل غير صالح")))
        : must(await sel.eq("id", idOf(body.projectId, "رقم المشروع غير صالح")))) as any[];
      const pids: number[] = projects.map((p) => p.id);
      if (!pids.length) return json({ ok: true, receipts: {}, invoices: [] });

      const ents = must(await supabase.from("treasury_entries").select("id, payment_id, transfer_group, payment_group")
        .eq("kind", "customer_receipt").in("project_id", pids).limit(5000)) as any[];
      const eowner = await ownersOfRows("treasury_entries", ["transfer_group", "payment_group"], ents);
      const ef = await filesByOwner(TARGETS.entry, [...new Set(Object.values(eowner))], 3600);
      const receipts: Record<string, unknown[]> = {};
      for (const e of ents) { const fl = ef[String(eowner[String(e.id)])]; if (fl && e.payment_id) receipts[String(e.payment_id)] = fl; }

      const BILL_COLS = "id, bill_group, project_id, amount, bill_number, bill_date, doc_type, supplier_id";
      const bills = must(await supabase.from("supplier_bills").select(BILL_COLS).in("project_id", pids).limit(5000)) as any[];
      const bowner = await ownersOfRows("supplier_bills", ["bill_group"], bills);
      const ownerIds = [...new Set(Object.values(bowner))];
      const bf = await filesByOwner(TARGETS.bill, ownerIds, 3600);
      const withFiles = ownerIds.filter((o) => bf[String(o)]);
      const invoices: unknown[] = [];
      if (withFiles.length) {
        const owners = must(await supabase.from("supplier_bills").select(BILL_COLS).in("id", withFiles)) as any[];
        const groups = [...new Set(owners.map((o) => o.bill_group).filter(Boolean))];
        const members = groups.length ? must(await supabase.from("supplier_bills").select(BILL_COLS).in("bill_group", groups)) as any[] : [];
        const projIds = [...new Set([...owners, ...members].map((m) => m.project_id).filter(Boolean))];
        const supIds = [...new Set(owners.map((o) => o.supplier_id).filter(Boolean))];
        const pinfo: Record<string, any> = {};
        if (projIds.length) for (const x of must(await supabase.from("projects").select("id, project_number").in("id", projIds)) as any[]) pinfo[String(x.id)] = x;
        const sname: Record<string, string> = {};
        if (supIds.length) for (const x of must(await supabase.from("suppliers").select("id, name").in("id", supIds)) as any[]) sname[String(x.id)] = x.name;
        owners.sort((a, b) => String(a.bill_date).localeCompare(String(b.bill_date)) || a.id - b.id);
        for (const o of owners) {
          const parts = o.bill_group ? members.filter((m) => m.bill_group === o.bill_group) : [o];
          invoices.push({
            owner_id: o.id, bill_number: o.bill_number, bill_date: o.bill_date, doc_type: o.doc_type, supplier_name: sname[String(o.supplier_id)] || "",
            parts: parts.map((m) => ({ project_id: m.project_id, project_number: m.project_id ? (pinfo[String(m.project_id)]?.project_number || null) : null, own: pids.includes(m.project_id), amount: Number(m.amount) })),
            files: bf[String(o.id)],
          });
        }
      }
      return json({ ok: true, receipts, invoices });
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
