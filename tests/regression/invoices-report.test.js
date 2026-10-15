const assert = require('assert');
const R = require('../../assets/js/invoices-report.js');
assert.deepStrictEqual(R.quarterRange(2026, 4), { from: '2026-10-01', to: '2026-12-31' });
assert.deepStrictEqual(R.quarterRange(2024, 1), { from: '2024-01-01', to: '2024-03-31' });
const rows = [
  { id: 1, invoice_number: 'A', document_type: 'invoice', subtotal: 14830.43, vat_amount: 2224.57, total: 17055, icv: 5 },
  { id: 2, invoice_number: 'B', document_type: 'invoice', subtotal: 14830.43, vat_amount: 2224.57, total: 17055, icv: 6 },
  { id: 3, invoice_number: 'C', document_type: 'invoice', subtotal: 18260.87, vat_amount: 2739.13, total: 21000, icv: 9 },
  { id: 4, invoice_number: 'CN', document_type: 'credit_note', related_invoice_id: 3, subtotal: 18260.87, vat_amount: 2739.13, total: 21000, icv: 10 },
];
const s = R.summarize(rows);
assert.strictEqual(s.invoices.count, 3);
assert.strictEqual(s.invoices.total, 55110);
assert.strictEqual(s.net.total, 34110);
assert.deepStrictEqual(R.icvGaps(rows), [7, 8]);
const m = R.buildModel({ report: { from: '2026-10-01', to: '2026-12-31', invoices: rows }, seller: {} });
assert.strictEqual(m.rows[3].related, 'C');
const x = R.buildReportWorkbook(m);
assert.strictEqual(x[0], 0x50); assert.strictEqual(x[1], 0x4b);
console.log('invoices-report ok');
