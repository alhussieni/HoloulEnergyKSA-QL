// HoloulEnergy — auth-api Edge Function
// دخول موحّد: اسم مستخدم + كلمة مرور فقط. السيرفر هو اللي يحدد الحساب ده أدمن ولا موظف ولا مندوب —
// المستخدم مش بيختار نوع الدخول. الدالة بتصدر نفس التوكنز (HMAC) اللي compute-quote / staff-api / crm-api فاهمينها،
// فمفيش أي دالة تانية اتغيّرت.
//   actions: login | session-check
//
// التوكن: { sub, ver, exp } — sub = "admin" | "rep:<username>" | "staff:<username>"، و ver = session_version بتاع الحساب
// (تغيير كلمة المرور أو تعطيل الحساب بيبطّل التوكنز القديمة فورًا).

import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

// ---------- crypto helpers (نفس المستخدمة في باقي الدوال) ----------
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
async function issueToken(sub: string, ver: number, ttlSeconds: number): Promise<{ token: string; exp: number }> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payloadB64 = b64urlFromBytes(new TextEncoder().encode(JSON.stringify({ sub, ver, exp })));
  return { token: `${payloadB64}.${await hmacSign(sessionSecret(), payloadB64)}`, exp };
}
async function readToken(token: unknown): Promise<{ sub: string; ver: number; exp: number } | null> {
  if (typeof token !== "string" || token.split(".").length !== 2) return null;
  const [payloadB64, sig] = token.split(".");
  if (!safeEq(await hmacSign(sessionSecret(), payloadB64), sig)) return null;
  try {
    const payload = JSON.parse(b64urlToString(payloadB64));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const hex = (u: Uint8Array) => Array.from(u).map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256Hex(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}
const PBKDF2_ITER = 100000;
async function pbkdf2(password: string, saltHex: string, iter: number): Promise<string> {
  const salt = new Uint8Array(saltHex.match(/../g)!.map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, key, 256)));
}
async function hashPassword(password: string): Promise<string> {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2$${PBKDF2_ITER}$${salt}$${await pbkdf2(password, salt, PBKDF2_ITER)}`;
}
// حسابات الموظفين: PBKDF2 أو sha256 قديم (بيتحدّث تلقائيًا أول دخول — نفس سلوك staff-api)
async function verifyStaffPassword(password: string, stored: string): Promise<{ ok: boolean; upgrade: boolean }> {
  if (stored.startsWith("pbkdf2$")) {
    const [, it, salt, h] = stored.split("$");
    return { ok: safeEq(await pbkdf2(password, salt, Number(it)), h), upgrade: false };
  }
  return { ok: safeEq(await sha256Hex(password), stored), upgrade: true };
}

const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// ---------- identities ----------
type AdminId = { kind: "admin"; ver: number };
type StaffId = { kind: "staff"; username: string; displayName: string; ver: number; roles: string[] };
type RepId = { kind: "rep"; username: string; displayName: string; ver: number; permissions: Record<string, boolean> };
type Ident = AdminId | StaffId | RepId;

const escLike = (s: string) => s.replace(/[\\%_]/g, (m) => "\\" + m);

async function permsOfRoles(roles: string[]): Promise<string[]> {
  if (!roles.length) return [];
  const { data } = await supabase.from("app_roles").select("key, permissions").in("key", roles);
  const s = new Set<string>();
  for (const r of (data || []) as any[]) for (const p of (r.permissions || [])) s.add(p);
  return [...s];
}

// الأدمن: السيرفر بيحفظ بصمة "اسم_المستخدم:كلمة_المرور" (أو كلمة المرور لوحدها لو اسم المستخدم لسه ما اتحددش — الوضع القديم).
// الوضع القديم بيتقبل فقط لو اسم المستخدم المكتوب = admin، عشان أي اسم + كلمة سر الأدمن ما يبقاش أدمن.
async function tryAdmin(usernameLower: string, password: string): Promise<AdminId | null> {
  const { data } = await supabase.from("admin_secret").select("password_hash, session_version").eq("id", 1).maybeSingle();
  if (!data || !data.password_hash) return null;
  const cands = [await sha256Hex(`${usernameLower}:${password}`)];
  if (usernameLower === "admin") cands.push(await sha256Hex(password));
  return cands.some((c) => safeEq(c, data.password_hash)) ? { kind: "admin", ver: data.session_version } : null;
}
async function tryStaff(username: string, password: string): Promise<StaffId[]> {
  const { data } = await supabase.from("staff_accounts").select("id, username, password_hash, display_name, active, session_version, roles").ilike("username", escLike(username));
  const out: StaffId[] = [];
  for (const r of (data || []) as any[]) {
    if (!r.active) continue;
    const v = await verifyStaffPassword(password, r.password_hash);
    if (!v.ok) continue;
    if (v.upgrade) await supabase.from("staff_accounts").update({ password_hash: await hashPassword(password) }).eq("id", r.id);
    out.push({ kind: "staff", username: r.username, displayName: r.display_name, ver: r.session_version, roles: r.roles || [] });
  }
  return out;
}
async function tryRep(username: string, password: string): Promise<RepId[]> {
  const { data } = await supabase.from("reps").select("username, password_hash, display_name, active, session_version, permissions").ilike("username", escLike(username));
  const out: RepId[] = [];
  const h = await sha256Hex(password);
  for (const r of (data || []) as any[]) {
    if (!r.active || !safeEq(h, r.password_hash)) continue;
    out.push({ kind: "rep", username: r.username, displayName: r.display_name, ver: r.session_version, permissions: r.permissions || {} });
  }
  return out;
}

// ---------- modules: السياسة (مين يشوف إيه) في مكان واحد بس ----------
type Mod = { key: string; label: string; desc: string; icon: string; url: string; kinds: string[] };
const MODULES: Mod[] = [
  { key: "calculator", label: "حاسبة عروض الأسعار", desc: "تسعير المحطات والمنتجات والمنظومات الجاهزة", icon: "🧮", url: "index.html", kinds: ["admin", "rep"] },
  { key: "pump", label: "حاسبة الضخ الزراعي", desc: "تسعير منظومات ضخ المياه بالطاقة الشمسية", icon: "🚜", url: "pump-calculator.html", kinds: ["admin", "rep"] },
  { key: "crm", label: "متابعة العملاء (CRM)", desc: "العملاء والعروض والمتابعة والمشاريع", icon: "👥", url: "crm.html", kinds: ["admin", "rep"] },
  { key: "admin", label: "لوحة التحكم", desc: "الأسعار والمنتجات والمندوبين والصلاحيات", icon: "⚙️", url: "index.html#admin", kinds: ["admin"] },
  { key: "staff", label: "بوابة الموظف", desc: "المشاريع والمالية والخزنة حسب صلاحياتك", icon: "📊", url: "crm.html?portal=staff", kinds: ["staff"] },
];

async function describe(idents: Ident[]) {
  const kinds = idents.map((i) => i.kind);
  const staff = idents.find((i) => i.kind === "staff") as StaffId | undefined;
  const rep = idents.find((i) => i.kind === "rep") as RepId | undefined;
  const displayName = staff?.displayName || rep?.displayName || "الأدمن";
  const username = staff?.username || rep?.username || "admin";
  return {
    user: { username, displayName, kinds },
    permissions: {
      admin: kinds.includes("admin"),
      rep: rep ? rep.permissions : null,
      staff: staff ? await permsOfRoles(staff.roles) : [],
      roles: staff ? staff.roles : [],
    },
    modules: MODULES.filter((m) => m.kinds.some((k) => kinds.includes(k as any))).map(({ kinds: _k, ...m }) => m),
  };
}

// ---------- throttling ----------
const BAD = "اسم المستخدم أو كلمة المرور غير صحيحة";
const WINDOW_MS = 10 * 60 * 1000, MAX_PER_USER_IP = 6, MAX_PER_IP = 30;
async function throttled(ip: string, ul: string): Promise<boolean> {
  try {
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const [a, b] = await Promise.all([
      supabase.from("auth_login_attempts").select("id", { count: "exact", head: true }).eq("username", ul).eq("ip", ip).eq("success", false).gte("at", since),
      supabase.from("auth_login_attempts").select("id", { count: "exact", head: true }).eq("ip", ip).eq("success", false).gte("at", since),
    ]);
    return (a.count || 0) >= MAX_PER_USER_IP || (b.count || 0) >= MAX_PER_IP;
  } catch { return false; } // لو الجدول مش متاح مانقفلش الدخول على الكل
}
async function noteFailure(ip: string, ul: string) {
  try {
    await supabase.from("auth_login_attempts").insert({ ip, username: ul, success: false });
    if (Math.random() < 0.05) await supabase.from("auth_login_attempts").delete().lt("at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  } catch { /* logging must never break login */ }
}
async function clearFailures(ip: string, ul: string) {
  try { await supabase.from("auth_login_attempts").delete().eq("ip", ip).eq("username", ul); } catch { /* ignore */ }
}

// ---------- session-check: إعادة التحقق من توكنز موجودة (من غير إصدار جديد) ----------
async function checkTokens(tokens: any): Promise<Ident[]> {
  const out: Ident[] = [];
  const t = tokens && typeof tokens === "object" ? tokens : {};
  const a = await readToken(t.admin);
  if (a && a.sub === "admin") {
    const { data } = await supabase.from("admin_secret").select("session_version").eq("id", 1).maybeSingle();
    if (data && data.session_version === a.ver) out.push({ kind: "admin", ver: a.ver });
  }
  const s = await readToken(t.staff);
  if (s && typeof s.sub === "string" && s.sub.startsWith("staff:")) {
    const { data } = await supabase.from("staff_accounts").select("username, display_name, active, session_version, roles").eq("username", s.sub.slice(6)).maybeSingle();
    if (data && data.active && data.session_version === s.ver) out.push({ kind: "staff", username: data.username, displayName: data.display_name, ver: s.ver, roles: data.roles || [] });
  }
  const r = await readToken(t.rep);
  if (r && typeof r.sub === "string" && r.sub.startsWith("rep:")) {
    const { data } = await supabase.from("reps").select("username, display_name, active, session_version, permissions").eq("username", r.sub.slice(4)).maybeSingle();
    if (data && data.active && data.session_version === r.ver) out.push({ kind: "rep", username: data.username, displayName: data.display_name, ver: r.ver, permissions: data.permissions || {} });
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  try {
    if (body.action === "login") {
      const username = String(body.username ?? "").trim().slice(0, 60);
      const password = String(body.password ?? "").slice(0, 200);
      if (!username || !password) return json({ error: BAD }, 401);
      const ul = username.toLowerCase();
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";

      if (await throttled(ip, ul)) return json({ error: "محاولات دخول كثيرة. حاول مرة أخرى بعد 10 دقائق" }, 429);

      const idents: Ident[] = [];
      const admin = await tryAdmin(ul, password);
      if (admin) idents.push(admin);
      idents.push(...await tryStaff(username, password));
      idents.push(...await tryRep(username, password));

      if (!idents.length) { await noteFailure(ip, ul); return json({ error: BAD }, 401); }
      await clearFailures(ip, ul);

      // مدد التوكن: نفس القيم القديمة (أدمن 4س / مندوب 12س / موظف 12س) أو 14 يوم مع "تذكرني"
      const remember = !!body.rememberMe;
      const tokens: Record<string, string> = {}, exp: Record<string, number> = {};
      const put = async (kind: string, sub: string, ver: number, shortH: number) => {
        const { token, exp: e } = await issueToken(sub, ver, remember ? 14 * 24 * 3600 : shortH * 3600);
        tokens[kind] = token; exp[kind] = e;
      };
      for (const i of idents) {
        if (i.kind === "admin") await put("admin", "admin", i.ver, 4);
        else if (i.kind === "staff") await put("staff", `staff:${i.username}`, i.ver, 12);
        else await put("rep", `rep:${i.username}`, i.ver, 12);
      }
      return json({ ok: true, tokens, exp, remember, ...(await describe(idents)) });
    }

    if (body.action === "session-check") {
      const idents = await checkTokens(body.tokens);
      if (!idents.length) return json({ error: "الجلسة منتهية، الرجاء تسجيل الدخول مجددًا" }, 401);
      return json({ ok: true, valid: idents.map((i) => i.kind), ...(await describe(idents)) });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
