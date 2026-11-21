// ---------------------------------------------------------------------
// نطاق المندوب: المندوب يشوف عملاءه (customers.assigned_to = username) وكل اللي مرتبط بيهم فقط.
// الأدمن مش بيمرّ من هنا. أي مرجع (عميل / موقع / فرصة / مشروع / أصل ...) لازم يتبع عميل من عملاء المندوب.
// ---------------------------------------------------------------------
const DIRECT_KEYS: Array<[string, string]> = [
  ["siteId", "sites"], ["assetId", "assets"], ["opportunityId", "opportunities"], ["projectId", "projects"],
  ["contactId", "contacts"], ["quotationId", "quotations"], ["invoiceId", "invoices"],
  ["ticketId", "service_tickets"], ["contractId", "maintenance_contracts"],
];
const PROJECT_CHILD_KEYS: Array<[string, string]> = [["milestoneId", "payment_milestones"], ["paymentId", "payments"], ["costId", "project_costs"]];
const FIELD_REF_KEYS: Array<[string, string]> = [["site_id", "sites"], ["contact_id", "contacts"], ["opportunity_id", "opportunities"]];
const SCOPE_DENIED = "غير مصرّح — العميل ده مش مرتبط بحسابك";

async function repScopeCheck(username: string, body: any): Promise<string | null> {
  const custIds = new Set<number>();
  const add = (v: any) => { const n = Number(v); custIds.add(Number.isInteger(n) && n > 0 ? n : NaN); };
  if (body.customerId != null && body.customerId !== "") add(body.customerId);
  for (const [key, table] of DIRECT_KEYS) {
    const v = body[key]; if (v == null || v === "") continue;
    const { data } = await supabase.from(table).select("customer_id").eq("id", Number(v)).maybeSingle();
    if (!data) return SCOPE_DENIED;
    add(data.customer_id);
  }
  for (const [key, table] of PROJECT_CHILD_KEYS) {
    const v = body[key]; if (v == null || v === "") continue;
    const { data } = await supabase.from(table).select("project_id").eq("id", Number(v)).maybeSingle();
    if (!data) return SCOPE_DENIED;
    const { data: pr } = await supabase.from("projects").select("customer_id").eq("id", data.project_id).maybeSingle();
    if (!pr) return SCOPE_DENIED;
    add(pr.customer_id);
  }
  if (body.fields && typeof body.fields === "object") {
    for (const [key, table] of FIELD_REF_KEYS) {
      const v = body.fields[key]; if (v == null || v === "") continue;
      const { data } = await supabase.from(table).select("customer_id").eq("id", Number(v)).maybeSingle();
      if (!data) return SCOPE_DENIED;
      add(data.customer_id);
    }
  }
  if (Array.isArray(body.assetIds) && body.assetIds.length) {
    const ids = body.assetIds.map(Number);
    const { data } = await supabase.from("assets").select("id, customer_id").in("id", ids);
    if (!data || data.length !== new Set(ids).size) return SCOPE_DENIED;
    for (const a of data) add(a.customer_id);
  }
  if (!custIds.size) return null;
  const ids = [...custIds];
  if (ids.some((n) => Number.isNaN(n))) return SCOPE_DENIED;
  const { data } = await supabase.from("customers").select("id, assigned_to").in("id", ids);
  if (!data || data.length !== ids.length || data.some((c: any) => c.assigned_to !== username)) return SCOPE_DENIED;
  return null;
}
