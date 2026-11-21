// HoloulEnergy — upload-datasheet Edge Function (ADMIN ONLY)
// رفع ملف PDF (داتا شيت لوح شمسي) إلى حاوية product-images/datasheets وإرجاع الرابط العام.
// نفس توثيق باقي دوال الأدمن (توكن HMAC + session_version). verify_jwt = true (الواجهة بتبعت anon key).
// الطلب: { adminToken, pdfBase64, filename }  ->  { ok: true, url }

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

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!(await checkAdminToken(body.adminToken))) {
    return json({ error: "الجلسة منتهية أو غير مصرّح، الرجاء تسجيل الدخول كأدمن" }, 401);
  }
  if (!body.pdfBase64 || !body.filename) return json({ error: "pdfBase64 و filename مطلوبين" }, 400);
  try {
    const bytes = Uint8Array.from(atob(String(body.pdfBase64).split(",").pop()!), (c) => c.charCodeAt(0));
    if (bytes.length > MAX_BYTES) return json({ error: "حجم الملف أكبر من 10MB" }, 413);
    // لازم يكون PDF فعلًا (بداية الملف %PDF) بغض النظر عن الامتداد
    if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
      return json({ error: "الملف مش PDF صالح" }, 400);
    }
    const path = `datasheets/${crypto.randomUUID()}.pdf`;
    const { error: upErr } = await supabase.storage.from("product-images").upload(path, bytes, { contentType: "application/pdf", upsert: false });
    if (upErr) return json({ error: upErr.message }, 500);
    const { data: pub } = supabase.storage.from("product-images").getPublicUrl(path);
    return json({ ok: true, url: pub.publicUrl });
  } catch (e) {
    return json({ error: (e as Error).message || "upload failed" }, 500);
  }
});
