// Regression: rep-prepared product-cart quote — dedupe, R1/R2 revisions, display modes.
// Extracts the real functions from the module files and runs them against stubs
// (no browser / Supabase needed).
"use strict";
const assert = require("assert");
const sameJSON = (a, b) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
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

const fnNames = ["cartNotesOnly", "cartTotals", "refreshCartRefLines", "saveCartQuote", "cartFindCatalogPos", "cartLoadPrev",
  "renderCartPrevBox", "renderCartQuoteDocument", "validateCartClient", "renderCartExtrasCard", "renderCartAdjustCard"];
// extractFunctionSource matches "function name(" only, so re-add "async" for the async ones
const ASYNC = new Set(["saveCartQuote"]);
const fns = fnNames.map((n) => (ASYNC.has(n) ? "async " : "") + extractFunctionSource(src07, n)).join("\n\n");
const phoneTail = extractFunctionSource(src04, "phoneTail") + "\nlet quoteItemNotes = {};\n" +
  ["noteEsc", "noteOf", "cleanNotes", "anyNoteFor", "noteTh", "noteTd", "setQuoteNotes"].map((n) => extractFunctionSource(src04, n)).join("\n");

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
  COMPANY: {}, SUPABASE_URL: "https://x.supabase.co", discountUnlocked: true, __nextCfg: null,
  renderPriceAdjustLine: (a) => `<div class="adj">${a < 0 ? "زيادة" : "الخصم"} ${Math.abs(a)}</div>`,
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
  "if (o.name != null) cartClientName = o.name; if (o.phone != null) cartClientPhone = o.phone; " +
  "if (o.cfg !== undefined) cartExtrasCfg = o.cfg; if (o.sel) cartExtrasSel = o.sel; if (o.special != null) cartSpecialAmt = o.special; }, " +
  "cartExtraLines, cartPanelStats, renderCartExtrasCard, renderCartAdjustCard, cartResetQuoteMeta, cartBlankExtrasSel, setQuoteNotes, cleanNotes };" +
  "\nasync function loadCartExtras(silent){ if (typeof __nextCfg !== 'undefined' && __nextCfg) cartExtrasCfg = __nextCfg; }", sandbox);
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

  // ================= installation / transport / discount-increase =================
  const CFG = () => ({
    civil: { key: "civil", label: "أعمال التركيب المدني", mode: "variable", unit: "panel", price: 40, repEdit: false },
    elec: { key: "elec", label: "أعمال التركيب الكهربائي", mode: "variable", unit: "panel", price: 30, repEdit: false },
    transport: { key: "transport", label: "النقل", mode: "variable", unit: "trip", price: 200, minimum: 2000, kwPerTrip: 20, repEdit: false },
  });
  const panelCart = () => [
    { catIdx: 0, ri: 0, name: "JA Solar 625W", category: "الألواح الشمسية", price: 400, qty: 16 }, // 10 kW
    { catIdx: 1, ri: 0, name: "Battery X", category: "Bat", price: 5000, qty: 1 },
  ];
  api.cartResetQuoteMeta(); calls.length = 0;
  api.set({ items: panelCart(), name: "Omar", phone: "0555555555", cfg: CFG(), special: 0, mode: "detailed" });
  api.set({ sel: { civil: { on: true, qty: null, price: 1 }, elec: { on: true, qty: null, price: null }, transport: { on: true, qty: null, price: null } } });
  let st = api.cartPanelStats();
  assert.strictEqual(st.panels, 16); assert.strictEqual(st.kw, 10);
  let lines = api.cartExtraLines();
  // civil 16x40 (client's price=1 ignored: locked), elec 16x30, transport 1 trip=200 -> admin minimum 2000
  sameJSON(lines.map((l) => [l.key, l.qty, l.unitPrice, l.amount]),
    [["civil", 16, 40, 640], ["elec", 16, 30, 480], ["transport", 1, 200, 2000]]);
  let T = api.cartTotals();
  assert.strictEqual(T.itemsSubtotal, 11400); assert.strictEqual(T.extrasSubtotal, 3120);
  assert.strictEqual(T.gross, 14520); assert.strictEqual(T.subtotal, 14520);
  assert.ok(Math.abs(T.total - 14520 * 1.15) < 1e-9);

  // discount 500 then increase -250 (before VAT); discount can never exceed the gross
  api.set({ special: 500 });
  T = api.cartTotals();
  assert.strictEqual(T.adj, 500); assert.strictEqual(T.subtotal, 14020);
  api.set({ special: -250 });
  T = api.cartTotals(); assert.strictEqual(T.subtotal, 14770);
  api.set({ special: 999999 });
  T = api.cartTotals(); assert.strictEqual(T.adj, 14520); assert.strictEqual(T.subtotal, 0);
  api.set({ special: 500 });

  // repEdit open => rep's price is used; fixed mode counts once regardless of qty
  const cfg2 = CFG(); cfg2.civil.repEdit = true; cfg2.elec.mode = "fixed"; cfg2.elec.price = 1500;
  api.set({ cfg: cfg2, sel: { civil: { on: true, qty: 20, price: 55 }, elec: { on: true, qty: 99, price: 1 }, transport: { on: false } } });
  lines = api.cartExtraLines();
  sameJSON(lines.map((l) => [l.key, l.qty, l.unitPrice, l.amount]), [["civil", 20, 55, 1100], ["elec", 1, 1500, 1500]]);
  api.set({ cfg: CFG(), sel: { civil: { on: true, qty: null, price: null }, elec: { on: true, qty: null, price: null }, transport: { on: true, qty: null, price: null } } });

  // save: snapshot carries extras + signed adjustment; same doc not saved twice; toggling an extra = revision
  calls.length = 0;
  let sr = await api.saveCartQuote();
  assert.strictEqual(calls.length, 1);
  const sn = calls[0].body.snapshot;
  assert.strictEqual(sn.specialDiscountAmt, 500);
  sameJSON(sn.extras.map((e) => e.key), ["civil", "elec", "transport"]);
  assert.strictEqual(sn.extrasSubtotal, 3120); assert.strictEqual(sn.subtotal, 14020);
  assert.strictEqual(calls[0].body.finalTotal, Math.round(14020 * 1.15));
  await api.saveCartQuote(); assert.strictEqual(calls.length, 1);
  api.get().cartExtrasSel; // (state read only)
  api.set({ sel: { civil: { on: true, qty: null, price: null }, elec: { on: false, qty: null, price: null }, transport: { on: true, qty: null, price: null } } });
  await api.saveCartQuote();
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[1].body.snapshot.revisionOf, "changing the extras after a save is a revision");

  // admin changed the prices while the document was open -> re-render, alert, NO save
  const callsBefore = calls.length;
  const newCfg = CFG(); newCfg.civil.price = 45;
  sandbox.__nextCfg = newCfg;
  api.set({ sel: { civil: { on: true, qty: null, price: null }, elec: { on: true, qty: null, price: null }, transport: { on: false, qty: null, price: null } } });
  const stale = await api.saveCartQuote();
  assert.strictEqual(stale, "stale"); assert.strictEqual(calls.length, callsBefore);
  sandbox.__nextCfg = null;
  api.set({ cfg: CFG() });

  // rendering: summary hides every price (items AND extras) but keeps labels, adjustment line, totals
  api.set({ cfg: CFG(), special: 500, mode: "summary", sel: { civil: { on: true, qty: null, price: null }, elec: { on: true, qty: null, price: null }, transport: { on: true, qty: null, price: null } } });
  let h = api.renderCartQuoteDocument();
  assert.ok(h.includes("أعمال التركيب المدني") && h.includes("النقل"));
  // the PDF drops every .no-print card (rep-only controls), so only the document table matters here
  const tbl = (html) => (html.match(/<table class="bom">[\s\S]*?<\/table>/) || [""])[0];
  assert.ok(tbl(h).includes("أعمال التركيب المدني"));
  assert.ok(!tbl(h).includes("سعر الوحدة") && !tbl(h).includes("2,000") && !tbl(h).includes("640") && !tbl(h).includes("﷼"), "summary table must not leak any price");
  assert.ok(h.includes("الخصم") && h.includes("إجمالي البنود") && h.includes("السعر النهائي شامل الضريبة"));
  api.set({ mode: "detailed" });
  h = api.renderCartQuoteDocument();
  assert.ok(tbl(h).includes("سعر الوحدة") && tbl(h).includes("640 ﷼") && tbl(h).includes("2,000 ﷼"));
  // control panel: locked prices are shown read-only, open ones are inputs
  const cfg3 = CFG(); cfg3.transport.repEdit = true; api.set({ cfg: cfg3 });
  const card = api.renderCartExtrasCard();
  assert.ok(card.includes('data-cxprice="transport"') && !card.includes('data-cxprice="civil"'));
  assert.ok(api.renderCartAdjustCard().includes("cartSpecialAmtInput"));

  // no rep session -> guests never get extras or a discount in the totals
  api.set({ special: 700 }); sandbox.repAuthed = false;
  api.set({ sel: api.cartBlankExtrasSel() });
  T = api.cartTotals(); assert.strictEqual(T.adj, 0); assert.strictEqual(T.subtotal, T.itemsSubtotal);
  sandbox.repAuthed = true;

  // ---- item notes column: hidden entirely without notes, shown (and saved) with notes ----
  api.cartResetQuoteMeta(); api.setQuoteNotes({});
  api.set({ items: [
    { catIdx: 0, ri: 0, name: "Inverter A", category: "Inv", price: 1000, qty: 2 },
    { catIdx: 0, ri: 1, name: "Cable <B>", category: "Cab", price: 50.5, qty: 10 },
  ], name: "Ali", phone: "0501234567", mode: "detailed", special: 0 });
  let notesHtml = api.renderCartQuoteDocument();
  assert.ok(!notesHtml.includes("has-notes"), "no notes -> table must not carry has-notes");
  const nBefore = calls.length;
  await api.saveCartQuote();
  assert.ok(!("itemNotes" in calls[calls.length - 1].body.snapshot), "no notes -> snapshot has no itemNotes");
  assert.strictEqual(calls.length, nBefore + 1);

  api.setQuoteNotes({ "p:Inverter A": "ضمان خاص <b>", "p:Gone": "stale" });
  notesHtml = api.renderCartQuoteDocument();
  assert.ok(notesHtml.includes('class="bom has-notes"'), "a note -> table gets has-notes");
  assert.ok(notesHtml.includes("ضمان خاص &lt;b&gt;"), "note text is HTML-escaped");
  assert.ok(notesHtml.includes("<th class=\"notecol\">ملاحظات</th>"));
  api.set({ mode: "summary" });
  assert.ok(api.renderCartQuoteDocument().includes('class="bom has-notes"'), "summary mode shows it too");
  api.set({ mode: "detailed" });
  await api.saveCartQuote();
  assert.strictEqual(calls.length, nBefore + 2, "changed notes -> a new save (revision), not deduped");
  sameJSON(calls[calls.length - 1].body.snapshot.itemNotes, { "p:Gone": "stale", "p:Inverter A": "ضمان خاص <b>" });
  await api.saveCartQuote();
  assert.strictEqual(calls.length, nBefore + 2, "same notes again -> deduped");

  api.cartResetQuoteMeta();
  sameJSON(api.cleanNotes(), {}, "cart reset clears cart notes");

  console.log("cart-quote.test.js: all assertions passed");
})().catch((e) => { console.error(e); process.exit(1); });
