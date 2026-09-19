// Regression tests for the pure calculation functions inside
// assets/js/app.js. These are the highest-stakes functions in the whole
// app — they drive the numbers a real customer sees on a real quote — so
// this file exists specifically to catch silent breakage from any future
// refactor (e.g. splitting app.js into modules).
//
// Run with:  node tests/regression/pure-functions.test.js
"use strict";
const assert = require("assert");
const { loadFunctions } = require("./extract");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ok  - ${name}`);
    passed++;
  } catch (err) {
    console.error(`  FAIL - ${name}`);
    console.error(`         ${err.message}`);
    failed++;
  }
}

console.log("normalizePhone");
{
  const { normalizePhone } = loadFunctions(["normalizePhone"]);
  test("local format 05xxxxxxxx -> 9665xxxxxxxx", () => {
    assert.strictEqual(normalizePhone("0512345678"), "966512345678");
  });
  test("bare 9-digit -> prefixed with 966", () => {
    assert.strictEqual(normalizePhone("512345678"), "966512345678");
  });
  test("00-international prefix stripped and normalized", () => {
    assert.strictEqual(normalizePhone("00966512345678"), "966512345678");
  });
  test("already-normalized number passes through", () => {
    assert.strictEqual(normalizePhone("966512345678"), "966512345678");
  });
  test("strips non-digit characters (spaces, dashes)", () => {
    assert.strictEqual(normalizePhone("05 123-45678"), "966512345678");
  });
}

console.log("iqCleanQty");
{
  const { iqCleanQty } = loadFunctions(["iqCleanQty"]);
  test("strips # markers", () => {
    assert.strictEqual(iqCleanQty("5#"), "5");
  });
  test("strips trailing parenthetical note", () => {
    assert.strictEqual(iqCleanQty("10 (تقريبي)"), "10");
  });
  test("handles empty/undefined", () => {
    assert.strictEqual(iqCleanQty(undefined), "");
    assert.strictEqual(iqCleanQty(""), "");
  });
}

console.log("computeLocalDailyKwh");
{
  const { computeLocalDailyKwh } = loadFunctions(["computeLocalDailyKwh"]);
  test("single appliance: watts * total hours * qty / 1000", () => {
    // 175W fridge, 6h day + 18h night = 24h, qty 1 -> 175*24/1000 = 4.2 kWh
    const result = computeLocalDailyKwh([
      { watts: 175, dayHours: 6, nightHours: 18, qty: 1 },
    ]);
    assert.ok(Math.abs(result - 4.2) < 1e-9, `expected 4.2, got ${result}`);
  });
  test("multiple appliances sum correctly", () => {
    const result = computeLocalDailyKwh([
      { watts: 100, dayHours: 5, nightHours: 0, qty: 2 }, // 1.0 kWh
      { watts: 50, dayHours: 0, nightHours: 10, qty: 1 }, // 0.5 kWh
    ]);
    assert.ok(Math.abs(result - 1.5) < 1e-9, `expected 1.5, got ${result}`);
  });
  test("empty/null appliance list returns 0", () => {
    assert.strictEqual(computeLocalDailyKwh([]), 0);
    assert.strictEqual(computeLocalDailyKwh(null), 0);
  });
}

console.log("esc / escAttr (XSS-safety of the quote renderer)");
{
  const { esc, escAttr } = loadFunctions(["esc", "escAttr"]);
  test("esc neutralizes < > &", () => {
    assert.strictEqual(esc("<script>&"), "&lt;script&gt;&amp;");
  });
  test("esc handles null/undefined as empty string", () => {
    assert.strictEqual(esc(null), "");
    assert.strictEqual(esc(undefined), "");
  });
  test("escAttr also neutralizes double quotes", () => {
    assert.strictEqual(escAttr('say "hi"'), "say &quot;hi&quot;");
  });
}

console.log("irr (internal rate of return — feasibility study math)");
{
  const { irr } = loadFunctions(["irr"]);
  test("simple 1-period cashflow: -100 now, +110 in 1 year -> ~10% IRR", () => {
    const result = irr([-100, 110]);
    assert.ok(Math.abs(result - 0.10) < 1e-4, `expected ~0.10, got ${result}`);
  });
  test("all-negative cashflow (never pays back) -> null", () => {
    const result = irr([-100, -10, -10]);
    assert.strictEqual(result, null);
  });
}

console.log("computeFeasibility (payback period + IRR for solar vs grid/diesel)");
{
  const { computeFeasibility } = loadFunctions(["irr", "computeFeasibility"]);
  const baseAssumptions = {
    psh: 5.5, // peak sun hours
    years: 10,
    solarOMPctOfCapex: 1.5,
    panelDegradationPct: 0.5,
    gridPrice: 0.30,
    gridEscalationPct: 3,
    dieselConsumptionPerKWh: 0.3,
    dieselPrice: 2.0,
    dieselEscalationPct: 5,
    co2FactorKgPerLiter: 2.68,
  };

  test("returns arrays of the expected length (one entry per year)", () => {
    const r = computeFeasibility(100000, 50, baseAssumptions);
    assert.strictEqual(r.genArr.length, 10);
    assert.strictEqual(r.gridArr.length, 10);
    assert.strictEqual(r.dieselArr.length, 10);
  });

  test("year-1 generation matches calcKW * psh * 365 (before degradation)", () => {
    const r = computeFeasibility(100000, 50, baseAssumptions);
    const expectedYear1Gen = 50 * 5.5 * 365; // 100375 kWh
    assert.ok(
      Math.abs(r.genArr[0] - expectedYear1Gen) < 1e-6,
      `expected ${expectedYear1Gen}, got ${r.genArr[0]}`
    );
  });

  test("a cheap system with strong sun pays back within the study period against grid", () => {
    const r = computeFeasibility(50000, 50, baseAssumptions);
    assert.notStrictEqual(r.paybackGrid, null, "expected a payback year to be found");
    assert.ok(r.paybackGrid > 0 && r.paybackGrid < 10, `payback out of expected range: ${r.paybackGrid}`);
  });

  test("an absurdly expensive system never pays back in 10 years", () => {
    const r = computeFeasibility(50_000_000, 5, baseAssumptions);
    assert.strictEqual(r.paybackGrid, null);
    assert.strictEqual(r.paybackDiesel, null);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exitCode = 1;
}
