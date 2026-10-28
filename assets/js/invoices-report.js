/* =======================================================================
   حصر الفواتير الصادرة لفترة (الإقرار الضريبي ربع السنوي / المراجعة)
   منطق نقي (من غير DOM) علشان يتختبر بـ node:
     - حساب الأرباع والفترات
     - تلخيص الأرقام (بالهللة عشان الكسور ما تتراكمش)
     - نموذج التقرير (صفوف + ملخص + فجوات ICV)
     - كاتب ملف Excel (.xlsx) بدون أي مكتبة خارجية
     - HTML التقرير للطباعة / حفظ PDF
   بيتحمّل في crm.html كـ window.InvReport.
   ======================================================================= */
(function (root) {
  'use strict';

  const pad2 = (n) => String(n).padStart(2, '0');
  const Q_NAMES = ['الربع الأول', 'الربع الثاني', 'الربع الثالث', 'الربع الرابع'];
  const Q_MONTHS = ['يناير – مارس', 'أبريل – يونيو', 'يوليو – سبتمبر', 'أكتوبر – ديسمبر'];

  // ---------- فترات ----------
  function lastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m = 1..12
  function quarterRange(year, q) {
    const m1 = (q - 1) * 3 + 1, m3 = m1 + 2;
    return { from: `${year}-${pad2(m1)}-01`, to: `${year}-${pad2(m3)}-${pad2(lastDay(year, m3))}` };
  }
  function riyadhDate(d) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' }).format(d || new Date()); }
  function quarterOf(dateStr) {
    const [y, m] = String(dateStr).split('-').map(Number);
    return { year: y, q: Math.floor((m - 1) / 3) + 1 };
  }
  function periodLabel(from, to) {
    const y = Number(String(from).slice(0, 4));
    for (let q = 1; q <= 4; q++) {
      const r = quarterRange(y, q);
      if (r.from === from && r.to === to) return `${Q_NAMES[q - 1]} ${y} (${Q_MONTHS[q - 1]})`;
    }
    if (from === `${y}-01-01` && to === `${y}-12-31`) return `سنة ${y} كاملة`;
    return `من ${from} إلى ${to}`;
  }
  function validPeriod(from, to) {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    return re.test(from || '') && re.test(to || '') && from <= to;
  }

  // ---------- أرقام (بالهللة) ----------
  const toH = (v) => Math.round((Number(v) || 0) * 100);
  const fromH = (h) => h / 100;
  const isCredit = (r) => r.document_type === 'credit_note';

  function docDate(r) {
    if (r.invoice_date) return String(r.invoice_date).slice(0, 10);
    return r.issued_at ? riyadhDate(new Date(r.issued_at)) : '';
  }
  function docTypeLabel(r) {
    if (isCredit(r)) return 'إشعار دائن';
    return r.invoice_type === 'standard' ? 'فاتورة ضريبية' : 'فاتورة ضريبية مبسطة';
  }
  function statusLabel(r) {
    if (isCredit(r)) return 'إشعار دائن';
    return r.status === 'cancelled' ? 'ملغاة بإشعار دائن' : 'صادرة';
  }

  // rows = المستندات الصادرة المعتمدة (فواتير + إشعارات دائنة)
  function summarize(rows) {
    const z = () => ({ count: 0, subtotal: 0, vat: 0, total: 0 });
    const inv = z(), cn = z(), simplified = z(), standard = z(), byPay = {};
    rows.forEach((r) => {
      const b = isCredit(r) ? cn : inv;
      b.count++; b.subtotal += toH(r.subtotal); b.vat += toH(r.vat_amount); b.total += toH(r.total);
      if (!isCredit(r)) {
        const t = r.invoice_type === 'standard' ? standard : simplified;
        t.count++; t.subtotal += toH(r.subtotal); t.vat += toH(r.vat_amount); t.total += toH(r.total);
      }
      const k = r.payment_method || 'other';
      const sign = isCredit(r) ? -1 : 1;
      const p = byPay[k] || (byPay[k] = { count: 0, total: 0 });
      p.count += isCredit(r) ? 0 : 1; p.total += sign * toH(r.total);
    });
    const net = { subtotal: inv.subtotal - cn.subtotal, vat: inv.vat - cn.vat, total: inv.total - cn.total };
    const out = (o) => Object.assign({}, o, { subtotal: fromH(o.subtotal), vat: fromH(o.vat), total: fromH(o.total) });
    const byPayOut = {};
    Object.keys(byPay).forEach((k) => { byPayOut[k] = { count: byPay[k].count, total: fromH(byPay[k].total) }; });
    return { invoices: out(inv), credits: out(cn), simplified: out(simplified), standard: out(standard), net: out(net), byPay: byPayOut };
  }

  // أرقام ICV اللي مش ظاهرة بين أول وآخر مستند في الفترة (ممكن تكون بانتظار الاعتماد أو محذوفة في الوضع التجريبي)
  function icvGaps(rows) {
    const ids = Array.from(new Set(rows.map((r) => Number(r.icv)).filter((n) => Number.isFinite(n) && n > 0))).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < ids.length && gaps.length < 50; i++) {
      for (let n = ids[i - 1] + 1; n < ids[i] && gaps.length < 50; n++) gaps.push(n);
    }
    return gaps;
  }

  // صف الجدول: إشعار الدائن بيتعرض بالسالب علشان مجموع العمود = الصافي
  function tableRows(rows, payLabels) {
    const byId = {};
    rows.forEach((r) => { byId[r.id] = r; });
    payLabels = payLabels || {};
    return rows.map((r, i) => {
      const sign = isCredit(r) ? -1 : 1;
      const rel = isCredit(r) && r.related_invoice_id ? (byId[r.related_invoice_id] ? byId[r.related_invoice_id].invoice_number : '') : '';
      return {
        no: i + 1, id: r.id, number: r.invoice_number || '', date: docDate(r),
        credit: isCredit(r), typeLabel: docTypeLabel(r), statusLabel: statusLabel(r),
        customer: r.customer_name || '', customerVat: r.customer_vat_number || '',
        subtotal: sign * fromH(toH(r.subtotal)), vat: sign * fromH(toH(r.vat_amount)), total: sign * fromH(toH(r.total)),
        vatPercent: r.vat_percent == null ? '' : Number(r.vat_percent),
        pay: payLabels[r.payment_method] || r.payment_method || '',
        related: rel, reason: r.reason || '', icv: r.icv == null ? '' : Number(r.icv), raw: r,
      };
    });
  }

  function buildModel(opts) {
    const rep = opts.report || {};
    const rows = Array.isArray(rep.invoices) ? rep.invoices : [];
    const seller = opts.seller || {};
    return {
      from: rep.from, to: rep.to, periodText: periodLabel(rep.from, rep.to),
      seller: { name: seller.name || '', vat: seller.vat || seller.vatNumber || '', nameEn: seller.nameEn || '', cr: seller.cr || seller.crNumber || '', crNo: seller.crNo || seller.commercialReg || '', phone: seller.phone || '', email: seller.email || '', logoUrl: seller.logoUrl || '' },
      rows: tableRows(rows, opts.payLabels), summary: summarize(rows),
      pendingCount: Number(rep.pendingCount) || 0, gaps: icvGaps(rows),
      trial: !!rep.trialMode || !!opts.trial, generatedAt: opts.generatedAt || riyadhDate(new Date()),
    };
  }

  // ---------- تنسيق ----------
  const money = (v) => Number(v || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------- HTML للطباعة / PDF ----------
  function logoSrc(m) {
    const l = (m.seller && m.seller.logoUrl) || 'assets/logo.png';
    if (/^(https?:|data:)/.test(l) || typeof location === 'undefined') return l;
    return location.href.replace(/[^\/]*$/, '') + l;
  }
  function reportHtml(m) {
    const s = m.summary;
    const head = ['#', 'رقم المستند', 'التاريخ', 'النوع', 'العميل', 'الرقم الضريبي للعميل', 'قبل الضريبة', 'الضريبة', 'الإجمالي', 'السداد'];
    const body = m.rows.map((r) => `<tr class="${r.credit ? 'cn' : ''}">
      <td>${r.no}</td><td dir="ltr">${esc(r.number)}</td><td dir="ltr">${esc(r.date)}</td>
      <td>${esc(r.typeLabel)}${r.related ? `<div class="sub">على ${esc(r.related)}</div>` : ''}${r.statusLabel === 'ملغاة بإشعار دائن' ? '<div class="sub">ملغاة بإشعار دائن</div>' : ''}</td>
      <td>${esc(r.customer) || '—'}</td><td dir="ltr">${esc(r.customerVat) || '—'}</td>
      <td class="n">${money(r.subtotal)}</td><td class="n">${money(r.vat)}</td><td class="n">${money(r.total)}</td><td>${esc(r.pay)}</td></tr>`).join('');
    const kpi = (l, v, sub) => `<div class="k"><div class="v">${v}</div><div class="l">${l}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`;
    const notes = [];
    if (m.trial) notes.push('⚠️ النظام في الوضع التجريبي للفوترة الإلكترونية — الفواتير دي تجريبية ومش للإقرار الفعلي.');
    if (m.pendingCount) notes.push(`⏳ يوجد ${m.pendingCount} فاتورة بانتظار الاعتماد — غير محسوبة في الأرقام أعلاه.`);
    if (m.gaps.length) notes.push(`ℹ️ أرقام ICV غير ظاهرة في الفترة: ${m.gaps.join('، ')} (قد تكون بانتظار الاعتماد أو محذوفة في الوضع التجريبي).`);
    return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>حصر الفواتير ${esc(m.from)} إلى ${esc(m.to)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
@page{size:A4 landscape;margin:12mm}
:root{--ink:#122436;--night:#0D3452;--teal-dark:#0B7A66;--muted:#63736F;--sand:#F6F8F7;--line:#DEE7E4}
.topBar{height:8px;background:var(--teal-dark);border-radius:3px;margin-bottom:10px;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.head2{display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:6px}
.coName{font-weight:800;font-size:15px}.coMeta{font-size:10px;color:var(--muted);margin-top:4px;line-height:1.7}
.logoBlock img{width:56px;height:56px;object-fit:contain}
*{box-sizing:border-box}
body{font-family:'Cairo',Tahoma,Arial,sans-serif;color:var(--ink);font-size:11px;-webkit-print-color-adjust:exact;print-color-adjust:exact;margin:0;${m.trial ? 'background:linear-gradient(transparent,transparent);' : ''}}
h1{font-size:20px;margin:6px 0 2px;text-align:center;color:var(--teal-dark);font-weight:800}
.meta{color:#444;margin-bottom:8px;line-height:1.7}
.trial{border:2px dashed #c0392b;color:#c0392b;font-weight:800;text-align:center;padding:5px;margin:6px 0}
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:8px 0 10px}
.k{border:1px solid var(--line);background:var(--sand);border-radius:10px;padding:6px 10px}
.k .v{font-size:15px;font-weight:800}
.k .l{color:#444}
.sub{font-size:9.5px;color:#666}
table{width:100%;border-collapse:collapse}
thead{display:table-header-group}
th{background:var(--night);color:#fff;padding:5px 4px;font-size:10.5px;text-align:center;border:1px solid var(--night)}
td{padding:4px;border:1px solid #bbb;vertical-align:top}
td.n{text-align:left;direction:ltr;font-variant-numeric:tabular-nums}
tr{page-break-inside:avoid}
tr.cn td{color:#b00020}
tfoot td{font-weight:800;background:#f1f1f1}
.notes{margin-top:8px;line-height:1.9}
.foot{margin-top:10px;color:#666;font-size:9.5px}
</style></head><body>
<div class="topBar"></div>
<div class="head2"><div><div class="coName">${esc(m.seller.name)}</div><div class="coMeta">${[m.seller.nameEn, m.seller.cr ? 'الرقم الوطني الموحد: ' + m.seller.cr : '', m.seller.crNo ? 'السجل التجاري: ' + m.seller.crNo : '', m.seller.vat ? 'الرقم الضريبي: ' + m.seller.vat : ''].filter(Boolean).map(esc).join(' · ')}</div></div><div class="logoBlock"><img src="${esc(logoSrc(m))}" alt="logo" onerror="this.style.display='none'"></div></div>
<h1>حصر الفواتير الصادرة — ${esc(m.periodText)}</h1>
<div class="meta" style="text-align:center">
الفترة: <span dir="ltr">${esc(m.from)}</span> إلى <span dir="ltr">${esc(m.to)}</span> · تاريخ إعداد التقرير: <span dir="ltr">${esc(m.generatedAt)}</span></div>
${m.trial ? '<div class="trial">نسخة تجريبية — غير صالحة للإقرار الضريبي</div>' : ''}
<div class="kpis">
${kpi('عدد الفواتير الصادرة', s.invoices.count, `مبسطة ${s.simplified.count} · ضريبية ${s.standard.count}`)}
${kpi('المبيعات قبل الضريبة', money(s.invoices.subtotal) + ' ﷼')}
${kpi('ضريبة القيمة المضافة', money(s.invoices.vat) + ' ﷼')}
${kpi('الإجمالي شامل الضريبة', money(s.invoices.total) + ' ﷼')}
${kpi('إشعارات دائنة', s.credits.count, '- ' + money(s.credits.total) + ' ﷼ شامل الضريبة')}
${kpi('صافي المبيعات قبل الضريبة', money(s.net.subtotal) + ' ﷼')}
${kpi('صافي الضريبة', money(s.net.vat) + ' ﷼')}
${kpi('الصافي شامل الضريبة', money(s.net.total) + ' ﷼')}
</div>
<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead>
<tbody>${body || '<tr><td colspan="10" style="text-align:center;padding:14px">لا توجد مستندات صادرة في هذه الفترة</td></tr>'}</tbody>
<tfoot><tr><td colspan="6">الإجمالي (الصافي بعد الإشعارات الدائنة)</td><td class="n">${money(s.net.subtotal)}</td><td class="n">${money(s.net.vat)}</td><td class="n">${money(s.net.total)}</td><td></td></tr></tfoot></table>
<div class="notes">${notes.map((n) => `<div>${esc(n)}</div>`).join('')}</div>
<div class="foot">إشعارات الدائن معروضة بالسالب. الأرقام بالريال السعودي. الأساس: تاريخ الفاتورة.</div>
</body></html>`;
  }

  // ======================================================================
  //  كاتب XLSX (zip بدون ضغط) — بدون مكتبات
  // ======================================================================
  let CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  const utf8 = (s) => new TextEncoder().encode(s);

  function zipStore(files) { // files: [{name, data:Uint8Array}]
    const parts = [], central = [];
    let offset = 0;
    const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1, dosTime = 0;
    files.forEach((f) => {
      const name = utf8(f.name), crc = crc32(f.data), size = f.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + size;
    });
    const cdSize = central.reduce((a, p) => a + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    const all = parts.concat(central, [new Uint8Array(end.buffer)]);
    const total = all.reduce((a, p) => a + p.length, 0), out = new Uint8Array(total);
    let o = 0; all.forEach((p) => { out.set(p, o); o += p.length; });
    return out;
  }

  const xmlEsc = (s) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function colName(i) { let s = '', n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  function excelDate(str) { const [y, m, d] = String(str).split('-').map(Number); return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000; }

  // أنماط الخلايا (فهرس cellXfs)
  const ST = { def: 0, hdr: 1, txt: 2, money: 3, totLabel: 4, totMoney: 5, title: 6, date: 7, int: 8, note: 9, warn: 10, label: 11 };

  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00;[Red]\\-#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd"/></numFmts>
<fonts count="6">
<font><sz val="10"/><name val="Arial"/></font>
<font><b/><sz val="10"/><name val="Arial"/></font>
<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>
<font><b/><sz val="14"/><name val="Arial"/></font>
<font><i/><sz val="9"/><color rgb="FF595959"/><name val="Arial"/></font>
<font><b/><sz val="10"/><color rgb="FFC00000"/><name val="Arial"/></font>
</fonts>
<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E5F"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFBFBFBF"/></left><right style="thin"><color rgb="FFBFBFBF"/></right><top style="thin"><color rgb="FFBFBFBF"/></top><bottom style="thin"><color rgb="FFBFBFBF"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="12">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="164" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  // خلية: {v, s, t:'s'|'n'|'d', f?}  — أو قيمة بسيطة (نص/رقم)
  function cellXml(cell, r, c) {
    if (cell == null || cell === '') return '';
    if (typeof cell !== 'object') cell = { v: cell };
    const ref = colName(c) + (r + 1);
    const t = cell.t || (typeof cell.v === 'number' ? 'n' : 's');
    const s = ST[cell.s] != null ? ST[cell.s] : (cell.s || 0);
    if (t === 's') return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(cell.v)}</t></is></c>`;
    const v = t === 'd' ? excelDate(cell.v) : Number(cell.v);
    if (cell.f) return `<c r="${ref}" s="${s}"><f>${xmlEsc(cell.f)}</f><v>${v}</v></c>`;
    return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
  }
  function sheetXml(sh, idx) {
    const rows = sh.rows;
    let maxC = 1;
    rows.forEach((r) => { maxC = Math.max(maxC, r.length); });
    let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
    x += '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>';
    x += `<dimension ref="A1:${colName(maxC - 1)}${Math.max(rows.length, 1)}"/>`;
    x += `<sheetViews><sheetView ${sh.rtl ? 'rightToLeft="1" ' : ''}${idx === 0 ? 'tabSelected="1" ' : ''}workbookViewId="0">`;
    if (sh.freezeRow) x += `<pane ySplit="${sh.freezeRow}" topLeftCell="A${sh.freezeRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${sh.freezeRow + 1}" sqref="A${sh.freezeRow + 1}"/>`;
    x += '</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>';
    if (sh.widths) x += '<cols>' + sh.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>';
    x += '<sheetData>';
    rows.forEach((row, r) => {
      const ht = sh.rowHeights && sh.rowHeights[r] ? ` ht="${sh.rowHeights[r]}" customHeight="1"` : '';
      x += `<row r="${r + 1}"${ht}>` + row.map((cell, c) => cellXml(cell, r, c)).join('') + '</row>';
    });
    x += '</sheetData>';
    if (sh.autoFilter) x += `<autoFilter ref="${sh.autoFilter}"/>`;
    if (sh.merges && sh.merges.length) x += `<mergeCells count="${sh.merges.length}">` + sh.merges.map((m) => `<mergeCell ref="${m}"/>`).join('') + '</mergeCells>';
    x += '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>';
    x += '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>';
    return x;
  }
  const safeSheetName = (n, i) => (String(n || 'Sheet' + (i + 1)).replace(/[\[\]:*?\/\\]/g, ' ').slice(0, 31)) || 'Sheet' + (i + 1);

  function buildXlsx(sheets) {
    const files = [];
    files.push({ name: '[Content_Types].xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>') });
    files.push({ name: '_rels/.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') });
    files.push({ name: 'xl/workbook.xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews><sheets>' + sheets.map((s, i) => `<sheet name="${xmlEsc(safeSheetName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>') });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) });
    files.push({ name: 'xl/styles.xml', data: utf8(STYLES_XML) });
    sheets.forEach((s, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(sheetXml(s, i)) }));
    return zipStore(files);
  }

  // ورقتين: "الفواتير" (جدول الحصر + صف إجماليات SUBTOTAL) و"الملخص"
  function buildReportWorkbook(m) {
    const s = m.summary;
    const HEAD_ROW = 4; // رقم الصف (1-based) اللي فيه العناوين
    const heads = ['#', 'رقم المستند', 'التاريخ', 'النوع', 'العميل', 'الرقم الضريبي للعميل', 'قبل الضريبة', 'الضريبة', 'الإجمالي شامل الضريبة', 'نسبة الضريبة %', 'طريقة السداد', 'الحالة', 'مرتبط بفاتورة', 'ICV'];
    const rows = [];
    rows.push([{ v: `حصر الفواتير الصادرة — ${m.periodText}`, s: 'title' }]);
    rows.push([{ v: `${m.seller.name}${m.seller.vat ? ' — الرقم الضريبي: ' + m.seller.vat : ''} — من ${m.from} إلى ${m.to}` + (m.trial ? ' — نسخة تجريبية غير صالحة للإقرار' : ''), s: m.trial ? 'warn' : 'note' }]);
    rows.push([{ v: 'إشعارات الدائن بالسالب. الأرقام بالريال السعودي.', s: 'note' }]);
    rows.push(heads.map((h) => ({ v: h, s: 'hdr' })));
    m.rows.forEach((r, i) => {
      rows.push([
        { v: i + 1, s: 'int' }, { v: r.number, s: 'txt' }, r.date ? { v: r.date, t: 'd', s: 'date' } : { v: '', s: 'txt' },
        { v: r.typeLabel, s: 'txt' }, { v: r.customer, s: 'txt' }, { v: r.customerVat, s: 'txt' },
        { v: r.subtotal, s: 'money' }, { v: r.vat, s: 'money' }, { v: r.total, s: 'money' },
        r.vatPercent === '' ? { v: '', s: 'txt' } : { v: r.vatPercent, s: 'int' },
        { v: r.pay, s: 'txt' }, { v: r.statusLabel, s: 'txt' }, { v: r.related || r.reason, s: 'txt' }, r.icv === '' ? { v: '', s: 'txt' } : { v: r.icv, s: 'int' },
      ]);
    });
    const first = HEAD_ROW + 1, last = HEAD_ROW + m.rows.length;
    const sum = (k) => m.rows.reduce((a, r) => a + Math.round(r[k] * 100), 0) / 100;
    const f = (col, k) => (m.rows.length ? { v: sum(k), s: 'totMoney', f: `SUBTOTAL(109,${col}${first}:${col}${last})` } : { v: 0, s: 'totMoney' });
    rows.push([{ v: '', s: 'totLabel' }, { v: 'الإجمالي (الصافي بعد الإشعارات الدائنة)', s: 'totLabel' }, { v: '', s: 'totLabel' }, { v: '', s: 'totLabel' }, { v: '', s: 'totLabel' }, { v: '', s: 'totLabel' },
      f('G', 'subtotal'), f('H', 'vat'), f('I', 'total'), { v: '', s: 'totLabel' }, { v: '', s: 'totLabel' }, { v: '', s: 'totLabel' }, { v: '', s: 'totLabel' }, { v: '', s: 'totLabel' }]);
    if (m.pendingCount) rows.push([{ v: `⏳ ${m.pendingCount} فاتورة بانتظار الاعتماد غير محسوبة في الأرقام.`, s: 'warn' }]);
    if (m.gaps.length) rows.push([{ v: `أرقام ICV غير ظاهرة في الفترة: ${m.gaps.join(', ')}`, s: 'note' }]);
    const sheet1 = {
      name: 'الفواتير', rows, rtl: true, freezeRow: HEAD_ROW, rowHeights: { 3: 30 },
      widths: [5, 26, 12, 22, 26, 20, 14, 12, 16, 10, 14, 16, 24, 7],
      autoFilter: `A${HEAD_ROW}:N${last}`, merges: ['A1:H1', 'A2:N2'],
    };
    // الملخص
    const sr = [];
    sr.push([{ v: `ملخص الفترة — ${m.periodText}`, s: 'title' }]);
    sr.push([{ v: 'البند', s: 'hdr' }, { v: 'العدد', s: 'hdr' }, { v: 'قبل الضريبة', s: 'hdr' }, { v: 'الضريبة', s: 'hdr' }, { v: 'الإجمالي', s: 'hdr' }]);
    const line = (label, o, st) => sr.push([{ v: label, s: st || 'txt' }, { v: o.count == null ? '' : o.count, s: o.count == null ? 'txt' : 'int' }, { v: o.subtotal, s: st === 'totLabel' ? 'totMoney' : 'money' }, { v: o.vat, s: st === 'totLabel' ? 'totMoney' : 'money' }, { v: o.total, s: st === 'totLabel' ? 'totMoney' : 'money' }]);
    line('فواتير ضريبية مبسطة', s.simplified);
    line('فواتير ضريبية (لمنشآت)', s.standard);
    line('إجمالي الفواتير الصادرة', s.invoices);
    line('إشعارات دائنة (تُخصم)', s.credits);
    line('الصافي للإقرار', Object.assign({ count: null }, s.net), 'totLabel');
    sr.push([]);
    sr.push([{ v: 'حسب طريقة السداد (صافي)', s: 'label' }]);
    Object.keys(s.byPay).forEach((k) => sr.push([{ v: m.payLabelOf ? m.payLabelOf(k) : k, s: 'txt' }, { v: s.byPay[k].count, s: 'int' }, { v: '', s: 'txt' }, { v: '', s: 'txt' }, { v: s.byPay[k].total, s: 'money' }]));
    sr.push([]);
    sr.push([{ v: `بانتظار الاعتماد (غير محسوبة): ${m.pendingCount}`, s: m.pendingCount ? 'warn' : 'note' }]);
    if (m.trial) sr.push([{ v: 'النظام في الوضع التجريبي — الفواتير تجريبية.', s: 'warn' }]);
    const sheet2 = { name: 'الملخص', rows: sr, rtl: true, widths: [34, 10, 16, 14, 18], merges: ['A1:E1'] };
    return buildXlsx([sheet1, sheet2]);
  }

  const api = {
    Q_NAMES, Q_MONTHS, quarterRange, quarterOf, riyadhDate, periodLabel, validPeriod,
    summarize, icvGaps, tableRows, buildModel, docTypeLabel, statusLabel, docDate,
    money, reportHtml, crc32, buildXlsx, buildReportWorkbook,
  };
  root.InvReport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
