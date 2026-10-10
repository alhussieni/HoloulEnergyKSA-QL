// Regression: rep-prepared product-cart quote — dedupe, R1/R2 revisions, display modes.
// Extracts the real functions from the module files and runs them against stubs
// (no browser / Supabase needed).
"use strict";
const assert = require("assert");
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const { extractFunctionSource } = require("./extract");

const dir = path.join(__dirname, "..", "..", "assets", "js", "modules");
const src07 = fs.readFileSync(path.join(dir, "07-render-admin.js"), "utf8");
const src04 = fs.readFileSync(path.join(dir, "04-state.js"), "utf8");

// state block of the cart (declarations only) copied verbatim from the real file
const stateStart = src07.indexOf("let productCart = [];");
const stateEnd = src07.indexOf("function cartKey(");
const stateBlock = src07.slice(stateStart, stateEnd);
const metaStart = src07.indexOf("// ---- Rep-prepared cart quote");
const metaEnd = src07.indexOf("function refreshCartRefLines(){");
const metaBlock = src07.slice(metaStart, metaEnd);

const fnNames = ["cartTotals", "refreshCartRefLines", "saveCartQuote", "cartFindCatalogPos", "cartLoadPrev",
  "renderCartPrevBox", "renderCartQuoteDocument", "validateCartClient"];
// extractFunctionSource matches "function name(" only, so re-add "async" for the async ones
const ASYNC = new Set(["saveCartQuote"]);
const fns = fnNames.map((n) => (ASYNC.has(n) ? "async " : "") + extractFunctionSource(src07, n)).join("\n\n");
const phoneTail = extractFunctionSource(src04, "phoneTail");

const calls = [];
let refCounter = 0;
const refs = []; // simulate the DB trigger
const sandbox = {
  console, calls,
  repUsername: "rep1", repTokenMem: "tok", guestMode: false, repAuthed: true, repDisplayName: "Rep One",
  cachedProductCatalog: [], buildCatalogWithPanels: (c) => c,
  logLead() {}, cartLookupPrev() {}, alert() {}, confirm: () => true, render() {},
  document: { querySelectorAll: () => [] },
  esc: (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;"),
  fmt: (n) => Math.round(n).toLocaleString("en-US"),
  LOGO_SRC: "", escAttr: (s) => s, companyShort: () => "Co", companyBrand: () => "Brand", companyContactHtml: () => "",
  COMPANY: {},
  callEngine: async (action, body) => {
    calls.push({ action, body });
    // mimic quotes_stamp_codes
    const parent = body.snapshot && body.snapshot.revisionOf;
    let ref;
    if (parent) {
      const base = parent.replace(/-R\d+$/, "");
      const n = refs.filter((r) => r === base || r.startsWith(base + "-R")).length; // 1 + existing revisions
      ref = base + "-R" + n;
    } else { ref = "QL-202610-" + String(++refCounter).padStart(4, "0"); }
    refs.push(ref);
    return { ok: true, refCode: ref };
  },
};
vm.createContext(sandbox);
vm.runInContext(phoneTail + "\n" + stateBlock + "\n" + fns +
  "\nthis.api = { saveCartQuote, cartLoadPrev, renderCartQuoteDocument, cartTotals, " +
  "get: () => ({ productCart, cartDisplayMode, cartSavedInfo, cartRevisionParent }), " +
  "set: (o) => { if (o.items) productCart = o.items; if (o.mode) cartDisplayMode = o.mode; " +
  "if (o.name != null) cartClientName = o.name; if (o.phone != null) cartClientPhone = o.phone; } };", sandbox);
const api = sandbox.api;

(async () => {
  api.set({ items: [
    { catIdx: 0, ri: 0, name: "Inverter A", category: "Inv", price: 1000, qty: 2 },
    { catIdx: 0, ri: 1, name: "Cable <B>", category: "Cab", price: 50.5, qty: 10 },
  ], name: "Ali", phone: "0501234567" });

  // totals: subtotal 2505, vat 15%
  const t = api.cartTotals();
  assert.strictEqual(t.subtotal, 2505);
  assert.ok(Math.abs(t.vat - 375.75) < 1e-9);
  assert.ok(Math.abs(t.total - 2880.75) < 1e-9);

  // 1) first save -> new quote, no revisionOf, snapshot carries mode + totals
  let r = await api.saveCartQuote();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(r.ref, "QL-202610-0001");
  const s1 = calls[0].body.snapshot;
  assert.strictEqual(s1.type, "product-cart");
  assert.strictEqual(s1.displayMode, "detailed");
  assert.strictEqual(s1.subtotal, 2505); assert.strictEqual(s1.vat, 375.75); assert.strictEqual(s1.total, 2880.75);
  assert.ok(!("revisionOf" in s1));

  // 2) print again / WhatsApp with no change -> NO new row
  await api.saveCartQuote(); await api.saveCartQuote();
  assert.strictEqual(calls.length, 1, "identical document must not be saved twice");

  // 3) qty changed -> R1 of the same base
  api.get().productCart[0].qty = 3;
  r = await api.saveCartQuote();
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].body.snapshot.revisionOf, "QL-202610-0001");
  assert.strictEqual(r.ref, "QL-202610-0001-R1");

  // 4) display mode switched -> different document -> R2
  api.set({ mode: "summary" });
  r = await api.saveCartQuote();
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(calls[2].body.snapshot.revisionOf, "QL-202610-0001-R1");
  assert.strictEqual(calls[2].body.snapshot.displayMode, "summary");
  assert.strictEqual(r.ref, "QL-202610-0001-R2");
  // totals identical regardless of mode
  assert.strictEqual(calls[2].body.snapshot.total, calls[1].body.snapshot.total);

  // 5) reopen an old quote from history: unchanged -> same ref, no row; edited -> next R
  const old = { client_name: "Ali", final_total: 2880.75, created_at: new Date().toISOString(), rep_display_name: "x",
    snapshot: { type: "product-cart", refCode: "QL-202610-0001", displayMode: "detailed",
      items: [{ name: "Inverter A", category: "Inv", price: 1000, qty: 2 }, { name: "Cable <B>", category: "Cab", price: 50.5, qty: 10 }] } };
  api.set({ items: [{ catIdx: 9, ri: 9, name: "tmp", category: "t", price: 1, qty: 1 }] }); // current cart gets replaced
  const before = calls.length;
  api.cartLoadPrev(old);
  assert.strictEqual(api.get().productCart.length, 2);
  assert.strictEqual(api.get().productCart[0].price, 1000);
  r = await api.saveCartQuote();
  assert.strictEqual(calls.length, before, "unchanged reopened quote must reuse its ref");
  assert.strictEqual(r.ref, "QL-202610-0001");
  api.get().productCart[1].qty = 11;
  r = await api.saveCartQuote();
  assert.strictEqual(calls[calls.length - 1].body.snapshot.revisionOf, "QL-202610-0001");

  // 6) rendering: summary hides every price column, detailed shows them; totals in both
  api.set({ mode: "summary" });
  let html = api.renderCartQuoteDocument();
  assert.ok(!html.includes("سعر الوحدة"), "summary mode must not show unit price");
  assert.ok(!/1,000 ﷼/.test(html), "summary mode must not leak a line price");
  assert.ok(html.includes("الإجمالي بدون ضريبة") && html.includes("ضريبة القيمة المضافة") && html.includes("السعر النهائي شامل الضريبة"));
  assert.ok(html.includes("Cable &lt;B>"), "names are escaped");
  api.set({ mode: "detailed" });
  html = api.renderCartQuoteDocument();
  assert.ok(html.includes("سعر الوحدة") && html.includes("1,000 ﷼"));
  console.log("cart-quote.test.js: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
