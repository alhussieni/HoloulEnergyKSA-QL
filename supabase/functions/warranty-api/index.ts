// HoloulEnergy — warranty-api Edge Function (deploy as Supabase function "warranty-api", entrypoint index.ts)
//
// Warranty certificates are issued ONLY from an invoice that is paid + approved + not cancelled
// (all rules live in the Postgres function issue_warranty_certificates(); this function is a thin,
// authenticated wrapper). A certificate is a frozen snapshot: it is issued once per invoice line,
// can be printed any number of times (printing is optional and only logged), and never changes.
//
// Actions: crm-warranty-config, crm-warranty-list, crm-customer-warranties, crm-issue-warranties,
//          crm-print-warranty, crm-void-warranty (admin only)
// Auth: same signed session tokens as crm-api / invoice-api (SESSION_SECRET).
// A rep can only touch the invoices that rep created; the admin can touch all of them.

import { createClient } from "npm:@supabase/supabase-js@2";

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

async function checkRepToken(token: string | undefined): Promise<{ username: string; displayName: string } | null> {
  const payload = await readToken(token);
  if (!payload || !payload.sub.startsWith("rep:")) return null;
  const username = payload.sub.slice(4);
  const { data, error } = await supabase.from("reps")
    .select("username, display_name, active, session_version").eq("username", username).single();
  if (error || !data || !data.active) return null;
  if (payload.ver !== data.session_version) return null;
  return { username: data.username, displayName: data.display_name };
}

type Auth = { isAdmin: boolean; rep: { username: string; displayName: string } | null };
async function authenticate(body: any): Promise<Auth | null> {
  if (body.adminToken) {
    const ok = await checkAdminToken(body.adminToken);
    if (ok) return { isAdmin: true, rep: null };
  }
  if (body.token) {
    const rep = await checkRepToken(body.token);
    if (rep) return { isAdmin: false, rep };
  }
  return null;
}

// Database error text (English) -> short Arabic message for the CRM user.
function arMsg(m: unknown): string {
  const t = String((m as any)?.message || m || "");
  if (t.includes("Invoice is not paid")) return "الفاتورة غير مسددة";
  if (t.includes("not approved")) return "الفاتورة لسه غير معتمدة من الأدمن";
  if (t.includes("credit note")) return "الفاتورة ملغاة بإشعار دائن";
  if (t.includes("in the future")) return "تاريخ الاستلام لا يمكن أن يكون في المستقبل";
  if (t.includes("before the invoice supply date")) return "تاريخ الاستلام لا يمكن أن يسبق تاريخ توريد الفاتورة";
  if (t.includes("No warranty-eligible")) return "الفاتورة مفيهاش بنود مؤهلة لشهادة ضمان";
  if (t.includes("serial number is required")) return "بند بدون رقم تسلسلي — مينفعش تتصدر له شهادة";
  if (t.includes("Void reason")) return "سبب الإلغاء مطلوب";
  if (t.includes("Active certificate not found")) return "الشهادة غير موجودة أو ملغاة بالفعل";
  return t;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Loads an invoice and checks the caller is allowed to act on it.
async function loadInvoice(auth: Auth, invoiceId: unknown) {
  const id = Number(invoiceId);
  if (!id) return { err: json({ error: "invoiceId required" }, 400) };
  const { data, error } = await supabase.from("invoices")
    .select("id, invoice_number, document_type, status, approval_status, supply_date, issued_at, rep_username, customer_name, items")
    .eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return { err: json({ error: "الفاتورة غير موجودة" }, 404) };
  if (!auth.isAdmin && auth.rep && data.rep_username !== auth.rep.username) {
    return { err: json({ error: "مش مسموح — الفاتورة دي مش بتاعتك" }, 403) };
  }
  return { inv: data };
}

async function certificatesOf(invoiceId: number) {
  const { data, error } = await supabase.from("warranty_certificates")
    .select("id, certificate_number, line_index, revision, status, warranty_start, warranty_end, issued_by, issued_at, voided_at, void_reason")
    .eq("invoice_id", invoiceId).order("line_index").order("revision");
  if (error) throw error;
  const certs = data || [];
  const counts: Record<number, number> = {};
  if (certs.length) {
    const { data: logs, error: lerr } = await supabase.from("warranty_print_log")
      .select("certificate_id").in("certificate_id", certs.map((c: any) => c.id));
    if (lerr) throw lerr;
    for (const l of logs || []) counts[l.certificate_id] = (counts[l.certificate_id] || 0) + 1;
  }
  return certs.map((c: any) => ({ ...c, print_count: counts[c.id] || 0 }));
}

async function listPayload(inv: any) {
  const items: any[] = Array.isArray(inv.items) ? inv.items : [];
  const lines = items
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => it && it.warranty_class)
    .map(({ it, i }) => ({
      line_index: i, name: it.name, model: it.model || null, brand: it.brand || null, serial: it.serial || null,
      qty: it.qty, warranty_class: it.warranty_class, warranty_years: it.warranty_years || null,
      serial_required: it.serial_required !== false,
    }));
  const { data: cn } = await supabase.from("invoices").select("id")
    .eq("related_invoice_id", inv.id).eq("document_type", "credit_note").maybeSingle();
  const canIssue = inv.document_type === "invoice" && inv.status === "paid" &&
    inv.approval_status === "approved" && !!inv.issued_at && !cn;
  return {
    ok: true,
    invoice: { id: inv.id, invoice_number: inv.invoice_number, supply_date: inv.supply_date, status: inv.status, approval_status: inv.approval_status, canIssue },
    lines,
    certificates: await certificatesOf(inv.id),
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }

  const auth = await authenticate(body);
  if (!auth) return json({ error: "الجلسة منتهية، الرجاء تسجيل الدخول مجددًا" }, 401);
  const actor = auth.isAdmin ? "admin" : (auth.rep ? auth.rep.username : "unknown");
  const actorRole = auth.isAdmin ? "admin" : "rep";

  try {
    const action = body.action;

    // Which catalog categories carry a warranty (and whether a serial number is mandatory).
    // Empty list = warranty-certificate rules are not active yet.
    if (action === "crm-warranty-config") {
      const { data, error } = await supabase.from("warranty_category_map").select("category, warranty_class, requires_serial");
      if (error) throw error;
      return json({ ok: true, map: data || [] });
    }

    if (action === "crm-warranty-list") {
      const r = await loadInvoice(auth, body.invoiceId);
      if (r.err) return r.err;
      return json(await listPayload(r.inv));
    }

    // Customer file: every invoice of this customer that has warranty-eligible lines, with the state of each line
    // (not issued yet / active certificate / voided). A rep only sees the invoices that rep created.
    if (action === "crm-customer-warranties") {
      const cid = Number(body.customerId);
      if (!cid) return json({ error: "customerId required" }, 400);
      const { data: cu } = await supabase.from("customers").select("phone").eq("id", cid).maybeSingle();
      let q = supabase.from("invoices")
        .select("id, invoice_number, document_type, status, approval_status, supply_date, issued_at, rep_username, customer_name, items")
        .eq("document_type", "invoice")
        .order("issued_at", { ascending: false, nullsFirst: false });
      const phone = cu && cu.phone ? String(cu.phone).replace(/[^0-9+]/g, "") : "";
      q = phone ? q.or(`customer_id.eq.${cid},customer_phone.eq.${phone}`) : q.eq("customer_id", cid);
      if (!auth.isAdmin && auth.rep) q = q.eq("rep_username", auth.rep.username);
      const { data: invs, error } = await q;
      if (error) throw error;
      const withLines = (invs || []).filter((i: any) => Array.isArray(i.items) && i.items.some((it: any) => it && it.warranty_class));
      const out: any[] = [];
      let pending = 0, issued = 0;
      for (const inv of withLines) {
        const p = await listPayload(inv);
        const active = new Set(p.certificates.filter((c: any) => c.status === "active").map((c: any) => c.line_index));
        const n = p.lines.filter((l: any) => !active.has(l.line_index)).length;
        if (p.invoice.canIssue) pending += n;
        issued += active.size;
        out.push(p);
      }
      return json({ ok: true, invoices: out, pending_lines: pending, issued_lines: issued });
    }

    if (action === "crm-issue-warranties") {
      const r = await loadInvoice(auth, body.invoiceId);
      if (r.err) return r.err;
      let receipt: string | null = null;
      if (body.receiptDate) {
        receipt = String(body.receiptDate).trim();
        if (!DATE_RE.test(receipt) || isNaN(Date.parse(receipt + "T00:00:00Z"))) {
          return json({ error: "تاريخ الاستلام غير صحيح" }, 400);
        }
      }
      const { error } = await supabase.rpc("issue_warranty_certificates", {
        p_invoice_id: r.inv.id, p_receipt_date: receipt, p_actor: actor, p_actor_role: actorRole,
      });
      if (error) return json({ error: arMsg(error) }, 400);
      return json(await listPayload(r.inv));
    }

    // Printing is optional and never changes the certificate: we only log it and hand back the frozen snapshot.
    if (action === "crm-print-warranty") {
      const cid = Number(body.certificateId);
      if (!cid) return json({ error: "certificateId required" }, 400);
      const { data: cert, error } = await supabase.from("warranty_certificates")
        .select("id, invoice_id, certificate_number, status, snapshot, warranty_start, warranty_end").eq("id", cid).maybeSingle();
      if (error) throw error;
      if (!cert) return json({ error: "الشهادة غير موجودة" }, 404);
      const r = await loadInvoice(auth, cert.invoice_id);
      if (r.err) return r.err;
      if (cert.status !== "active") return json({ error: "الشهادة ملغاة — مينفعش تتطبع" }, 400);
      const { error: logErr } = await supabase.from("warranty_print_log").insert({ certificate_id: cert.id, printed_by: actor });
      if (logErr) throw logErr;
      const { count } = await supabase.from("warranty_print_log").select("id", { count: "exact", head: true }).eq("certificate_id", cert.id);
      return json({ ok: true, certificate: cert, print_count: count || 1 });
    }

    if (action === "crm-void-warranty") {
      if (!auth.isAdmin) return json({ error: "إلغاء الشهادات متاح للأدمن بس" }, 403);
      const cid = Number(body.certificateId);
      if (!cid) return json({ error: "certificateId required" }, 400);
      const { data: cert } = await supabase.from("warranty_certificates").select("invoice_id").eq("id", cid).maybeSingle();
      if (!cert) return json({ error: "الشهادة غير موجودة" }, 404);
      const { error } = await supabase.rpc("void_warranty_certificate", {
        p_cert_id: cid, p_reason: String(body.reason || ""), p_actor: actor,
      });
      if (error) return json({ error: arMsg(error) }, 400);
      const r = await loadInvoice(auth, cert.invoice_id);
      if (r.err) return r.err;
      return json(await listPayload(r.inv));
    }

    return json({ error: "unknown_action" }, 400);
  } catch (err) {
    return json({ error: String((err as any)?.message || err) }, 500);
  }
});
