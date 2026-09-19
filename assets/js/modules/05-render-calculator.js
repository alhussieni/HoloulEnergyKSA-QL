/* =======================================================================
   5) RENDER — CALCULATOR VIEW
   ======================================================================= */
function renderCalc(){
  const SUBTABS = [
    ['irrigation','حاسبة الري الزراعي'],
    ['offgrid','حاسبة الأوف-جريد'],
    ['ongrid','حاسبة الأون-جريد'],
  ];
  const subnav = `<div class="calc-subnav no-print">
    ${SUBTABS.map(([key,label])=>`<button type="button" class="calc-subtab ${state.calcSystem===key?'active':''}" data-calcsys="${key}">${label}</button>`).join('')}
    <button type="button" class="calc-subtab" onclick="window.goToView('feas')" style="margin-inline-start:auto">📊 دراسة الجدوى</button>
  </div>`;
  let body;
  if(state.calcSystem==='offgrid') body = renderOffgridCalc();
  else if(state.calcSystem==='ongrid') body = renderOngridCalc();
  else body = renderIrrigationCalc();
  return subnav + body;
}

function renderIrrigationCalc(){
  const q = currentQuote();
  if(!q){
    return `<div class="card" style="max-width:420px;margin:60px auto;text-align:center">
      ${engineError
        ? `<h3 style="color:#B0432C">تعذر الاتصال بالخادم</h3><div class="note">${engineError}</div><button class="btn small" id="retryLoad" style="margin-top:12px">إعادة المحاولة</button>`
        : `<h3>جارِ التحميل...</h3><div class="note">جارِ حساب السعر من الخادم</div>`}
    </div>`;
  }
  const loadingBadge = quoteLoading ? `<div class="reload-badge no-print"><span class="spin"></span> جارِ تحديث السعر...</div>` : '';
  const TOGGLE_DEFS = [
    ['panel','ألواح شمسية'],['inverter','انفرتر'],['ip65','حماية IP65'],['combiner','لوحة تجميع'],
    ['cables','كابلات DC'],['mc4','وصلات MC4'],['structure','شاسيه/حوامل'],['concrete','خرسانة'],
    ['earth','تأريض'],['reactor','ريأكتور'],['civilworks','أعمال مدنية'],['elecworks','أعمال الكهرباء'],['supply','نقل وتوريد']
  ];

  return `
  ${loadingBadge}
  <div class="grid2">
    <div class="input-rail no-print">
      <div class="card">
        <h3>بيانات العميل</h3>
        <label>اسم العميل *</label>
        <input type="text" id="in_client" value="${state.client}" placeholder="اسم العميل">
        <label>رقم الهاتف / واتساب *</label>
        <input type="text" id="in_phone" value="${state.clientPhone}" placeholder="05xxxxxxxx">
        <div id="prevLeadBox" style="display:none"></div>
      </div>

      <div class="card">
        <h3>بيانات المشروع</h3>
        <label>القدرة المطلوبة (حصان HP)</label>
        <div style="display:flex;gap:8px">
          <input type="number" id="in_hp" value="${state.hp}" min="1" step="1" style="flex:1">
          <button class="btn small" id="hp_confirm" type="button">تأكيد</button>
        </div>

        <label>نوع اللوح الشمسي</label>
        <select id="in_panel">
          ${cachedPanelOptions.map(p=>`<option value="${p.idx}" ${p.idx==state.panelIdx?'selected':''}>${p.brand} ${p.power}W</option>`).join('')}
        </select>

        <details class="adv">
          <summary>إعدادات متقدمة</summary>
          <label>تعديل عدد الألواح/سلسلة</label>
          <input type="number" id="in_pps" value="${state.panelsPerStringAdjust}" step="1">
          <label>تعديل عدد السلاسل (Strings)</label>
          <input type="number" id="in_str" value="${state.stringsAdjust}" step="1">
          <label>هامش زيادة قدرة الانفرتر (KW)</label>
          <input type="number" id="in_invinc" value="${state.inverterPowerIncrease}" step="1">
          <button class="btn small" id="adv_confirm" type="button" style="margin-top:8px;width:100%">✔ تأكيد التعديلات</button>

          ${discountUnlocked ? `
          <label>فئة خصم العميل</label>
          <select id="in_discount">
            ${(adminConfig?.discountTiers||[]).map((d,i)=>`<option value="${i}" ${i==(state.discountOverrideIdx ?? (adminConfig?.defaultDiscountIdx??1))?'selected':''}>${d.label}</option>`).join('')}
          </select>` : '<button class="btn ghost small" id="unlockDiscount" type="button" style="margin-top:6px">فك القفل</button>'}

          ${discountUnlocked ? `
          <label>خصم خاص <span style="color:var(--muted);font-weight:400">(مبلغ صريح بالريال، يُخصم من إجمالي الفاتورة قبل الضريبة — استخدم رقمًا سالبًا مثل ‎-1000 لزيادة السعر بدلاً من خصمه)</span></label>
          <div style="display:flex;gap:8px">
            <input type="number" id="in_specialdiscount" value="${state.specialDiscountAmt}" step="50" style="flex:1">
            <button class="btn small" id="specialdiscount_confirm" type="button">تأكيد</button>
          </div>` : ''}
        </details>
      </div>

      <div class="card">
        <h3>نوع العرض</h3>
        <div class="seg preset-list" style="flex-direction:column;gap:6px;height:auto;border:0">
          <button data-preset="materials" style="padding:10px">توريد خامات فقط (ألواح + انفرتر + لوحة تجميع + MC4 + كابلات)</button>
          <button data-preset="turnkey" style="padding:10px">توريد وتركيب شامل الضمان (كل البنود عدا التأريض والريأكتور)</button>
        </div>
        <div class="note" style="margin-top:10px">اختيار أحد الخيارين يعبّئ البنود تلقائيًا تحت — وتقدر بعدها تعدّل أي بند يدويًا.</div>
      </div>

      <div class="card">
        <h3>البنود المُفعّلة</h3>
        <div class="toggles">
          ${TOGGLE_DEFS.map(([k,l])=>`
            <label class="tgl"><input type="checkbox" data-tgl="${k}" ${state.toggles[k]?'checked':''}> ${l}</label>
          `).join('')}
        </div>
      </div>
    </div>

    <div id="quotePrintArea" class="quote-shell ${quoteLoading?'quote-loading':''}">
      <div class="card quote-banner" style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:14px;align-items:center;padding-top:16px;padding-bottom:16px">
        <div style="display:flex;align-items:center;gap:10px">
          <img src="${LOGO_SRC}" alt="HoloulEnergy" style="width:46px;height:46px;object-fit:contain">
          <div>
            <div id="bannerCompanyName" style="font-family:'Cairo',sans-serif;font-weight:800;font-size:16px">حلول الطاقة المتجددة والمقاولات</div>
            <div style="font-size:10px;color:var(--muted);margin-top:2px">سجل تجاري: 7037810988 · الرقم الضريبي: 311386341200003</div>
            <div style="font-size:11px;color:var(--muted);margin-top:1px">HoloulEnergy · 966561274344+</div>
          </div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);letter-spacing:.02em">عرض سعر مُقدَّم إلى</div>
          <div id="bannerName" style="font-family:'Cairo',sans-serif;font-weight:800;font-size:18px;margin-top:1px">${state.client || '—'}</div>
          <div id="bannerPhone" class="num" style="font-size:12.5px;color:var(--muted);margin-top:1px">${state.clientPhone || '—'}</div>
        </div>
        <div style="text-align:left">
          <div style="font-size:11px;color:var(--muted);letter-spacing:.02em">تاريخ العرض</div>
          <div class="num" style="font-size:14px;font-weight:700;margin-top:1px">${new Date().toLocaleDateString('en-GB')}</div>
        </div>
      </div>
      ${q.inverterOversizeWarning ? `
      <div class="card no-print" style="background:#FEECEA;border-color:#F3B0A3;display:flex;align-items:center;gap:10px;padding:14px 16px">
        <span style="font-size:22px;flex:0 0 auto">⚠️</span>
        <div style="font-weight:700;font-size:13px;color:#8A2E1D;line-height:1.6">${q.inverterOversizeWarning.message}</div>
      </div>` : ''}
      <div class="card summary-card no-print">
        <h3 style="margin-bottom:6px">ملخص المنظومة <span class="tag">${q.invBrandName||'VEICHI'} ${q.invKW} KW</span></h3>
        <div class="stats summary-stats" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-top:10px">
          <div class="stat"><div class="v">${fmt1(q.calcKW)}</div><div class="l">KW</div></div>
          <div class="stat"><div class="v">${q.totalPanels}</div><div class="l">لوح</div></div>
          <div class="stat"><div class="v">${fmt(q.sarPerKW)}</div><div class="l">ريال / KW</div></div>
        </div>
        ${renderSupplyInstallSplit(q)}
      </div>
      <div class="card summary-card no-print">
        <h3>المواصفات الفنية <span class="tag">محسوبة تلقائيًا</span></h3>
        <div class="stats summary-stats">
          <div class="stat"><div class="v">${fmt1(q.calcKW)}</div><div class="l">القدرة الفعلية KW</div></div>
          <div class="stat"><div class="v">${q.totalPanels}</div><div class="l">عدد الألواح</div></div>
          <div class="stat"><div class="v">${q.arrays}</div><div class="l">عدد السلاسل (Strings)</div></div>
          <div class="stat"><div class="v">${q.panelsPerString}</div><div class="l">ألواح/سلسلة</div></div>
          <div class="stat"><div class="v">${fmt1(q.Vimp)}V</div><div class="l">Vimp الكلي</div></div>
          <div class="stat"><div class="v">${fmt1(q.Voc)}V</div><div class="l">Voc الكلي</div></div>
          <div class="stat"><div class="v">${fmt1(q.Iimp)}A</div><div class="l">Iimp الكلي</div></div>
          <div class="stat"><div class="v">${fmt1(q.IscCalc)}A</div><div class="l">Isc (مع أمان 25%)</div></div>
          <div class="stat"><div class="v">${q.invKW} KW</div><div class="l">موديل الانفرتر</div></div>
          ${q.invMaxSolarKw!=null ? `<div class="stat"><div class="v">${fmt1(q.invMaxSolarKw)} KW</div><div class="l">أقصى قدرة ألواح يتحملها الانفرتر</div></div>` : ''}
          <div class="stat"><div class="v">${q.reactorModel}A</div><div class="l">الريأكتور</div></div>
          <div class="stat"><div class="v">${q.cbSize}A</div><div class="l">قاطع الحماية C.B</div></div>
          <div class="stat"><div class="v">×${fmt2(q.efficiencyRatio)}</div><div class="l">نسبة السعة للحصان</div></div>
        </div>
      </div>

      <div class="card">
        <div class="num" style="font-size:11px;color:var(--muted);margin-bottom:8px">${buildQLCode(q)}</div>
        <h3 style="margin-bottom:2px">العرض المالي</h3>
        <div style="font-size:13px;margin:8px 0 4px">تحية طيبة وبعد،</div>
        <div style="font-size:13px;color:var(--ink);line-height:1.8">
          نتشرف بتقديم عرض سعر منظومة توليد الكهرباء من خلال الطاقة الشمسية للتشغيل راس كهرباء /محرك غطاس ${state.hp} حصان
        </div>
        <div class="note" style="margin-top:8px">
          ${repAuthed && repDisplayName ? `📋 قدّم هذا العرض: <b>${repDisplayName}</b>` : `🖥️ تم إصدار هذا العرض مباشرة عبر الحاسبة الإلكترونية`}
        </div>
      </div>

      <div class="card">
        <h3>تفصيل عرض السعر</h3>
        <table class="bom">
          <thead><tr><th>#</th><th>المكونات</th><th>النوع</th><th>العدد</th><th>الضمان</th></tr></thead>
          <tbody>
            ${q.items.map((it,i)=>`
              <tr class="${it.on?'':'off'}">
                <td>${i+1}</td>
                <td class="bom-label">${it.label}${it.key==='panel' ? panelDatasheetLinkForIdx(state.panelIdx) : ''}</td>
                <td style="font-size:11.5px;color:var(--muted)">${it.type}</td>
                <td style="font-size:11.5px">${it.qty}</td>
                <td style="font-size:11.5px">${it.warranty}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        ${((q.discountTotal + q.manualDiscountAmt) > 0) ? `
        <div class="note" style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;padding:3px 0"><span>السعر الأساسي</span><span class="num" style="color:var(--ink)">${fmt(q.sellTotal)} ﷼</span></div>
          ${renderPriceAdjustLine(q.discountTotal + q.manualDiscountAmt)}
          <div style="display:flex;justify-content:space-between;padding:3px 0;font-weight:600"><span>الصافي بعد الخصم (قبل الضريبة)</span><span class="num" style="color:var(--ink)">${fmt(q.netAfterManual)} ﷼</span></div>
          <div style="display:flex;justify-content:space-between;padding:3px 0"><span>ضريبة القيمة المضافة (${q.netAfterManual ? (q.vat/q.netAfterManual*100).toFixed(0) : 15}%)</span><span class="num" style="color:var(--ink)">${fmt(q.vat)} ﷼</span></div>
        </div>` : ''}
        <div class="totalbar" style="justify-content:center">
          <div class="line">
            <div class="lbl">السعر النهائي شامل الضريبة</div>
            <div class="big num">${fmt(q.finalTotal)} ﷼</div>
          </div>
        </div>
        ${(()=>{
          const hasSupply = !!state.toggles.supply;
          const hasInstall = !!(state.toggles.civilworks || state.toggles.elecworks);
          if(hasSupply && hasInstall){
            return `
            <div class="pay3">
              <div><div class="p num">${fmt(q.finalTotal*0.4)} ﷼</div><div class="l">دفعة مقدمة 40%</div></div>
              <div><div class="p num">${fmt(q.finalTotal*0.3)} ﷼</div><div class="l">بعد زيارة الموقع وتحديد المساحات المطلوبة 30%</div></div>
              <div><div class="p num">${fmt(q.finalTotal*0.3)} ﷼</div><div class="l">بعد الأعمال المدنية وقبل توريد باقي المكونات 30%</div></div>
            </div>`;
          } else if(hasInstall){
            return `
            <div class="pay3">
              <div><div class="p num">${fmt(q.finalTotal*0.5)} ﷼</div><div class="l">عند الاتفاق 50%</div></div>
              <div><div class="p num">${fmt(q.finalTotal*0.35)} ﷼</div><div class="l">مع الأعمال 35%</div></div>
              <div><div class="p num">${fmt(q.finalTotal*0.15)} ﷼</div><div class="l">عند الانتهاء 15%</div></div>
            </div>`;
          } else {
            return `
            <div class="pay3" style="grid-template-columns:1fr">
              <div><div class="p num">${fmt(q.finalTotal)} ﷼ (100%)</div><div class="l">${hasSupply?'تُسدَّد كامل القيمة عند التوريد':'تُسدَّد كامل القيمة قبل التوريد'}</div></div>
            </div>`;
          }
        })()}

        <div class="legal-note" style="margin-top:12px;font-size:11px;color:#B0432C;line-height:1.9">
          يقع على عاتق العميل تجهيز الموقع (أعمال الحفر والصب اللازمة) قبل موعد التوريد.<br>
          الارتباط بهذا السعر لمدة ثلاثة أيام فقط من تاريخ العرض (${new Date().toLocaleDateString('en-GB')}).
        </div>
        <div class="support-note" style="margin-top:8px;background:#EAF7F1;border:1px solid #BFE6D6;border-radius:9px;padding:9px 12px;font-size:11.5px;color:#146C4C">
          نلتزم بتوفير الدعم الفني وقطع الغيار للمنظومة حتى 10 سنوات من تاريخ التشغيل.
        </div>
        <div class="contact-note" style="margin-top:12px;text-align:center;font-size:11px;color:var(--muted);line-height:1.9">
          <b style="color:var(--ink)">للتواصل</b><br>
          info@HoloulEnergy.com · Sales@HoloulEnergy.com<br>
          Website - LinkedIn - Youtube - FB - Tiktok : HoloulEnergy<br>
          <span class="num">966561274344+</span>
        </div>

        <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap" class="no-print">
          <button class="btn" onclick="handlePrint()">🖨️ طباعة / حفظ PDF</button>
          <button class="btn" style="background:#25D366;color:#fff" onclick="sendQuoteToClientWhatsapp()">📤 إرسال العرض للعميل (واتساب)</button>
          <button class="btn ghost" style="border-color:#25D366;color:#146C4C" onclick="sendLeadWhatsapp()">💬 إشعار الشركة بالطلب</button>
        </div>
      </div>

      <div class="card no-print">
        <h3 id="adminInfoTrigger" style="cursor:default">معلومات إضافية</h3>
        ${adminInfoUnlocked ? (adminFinancials ? renderAdminFinancials(adminFinancials) : `<div class="note">جارِ التحميل...</div>`) : ``}
      </div>
    </div>
  </div>
  ${renderStickyTotalBar(q.finalTotal)}`;
}

// One combined "discount" line shown between the base price and the net
// price. A negative combined amount means the special-discount field was
// used to RAISE the price rather than lower it, so we flip the label/sign
// instead of showing a confusing "- -1,000 ﷼".
function renderPriceAdjustLine(combinedAmt){
  const isIncrease = combinedAmt < 0;
  return `<div style="display:flex;justify-content:space-between;padding:3px 0;color:${isIncrease?'var(--teal-dark)':'var(--bad)'}"><span>${isIncrease?'زيادة':'الخصم'}</span><span class="num">${isIncrease?'+':'-'} ${fmt(Math.abs(combinedAmt))} ﷼</span></div>`;
}

function renderQuoteHeaderBanner(){
  return `<div class="card quote-banner" style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:14px;align-items:center;padding-top:16px;padding-bottom:16px">
    <div style="display:flex;align-items:center;gap:10px">
      <img src="${LOGO_SRC}" alt="HoloulEnergy" style="width:46px;height:46px;object-fit:contain">
      <div>
        <div id="bannerCompanyName" style="font-family:'Cairo',sans-serif;font-weight:800;font-size:16px">حلول الطاقة المتجددة والمقاولات</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px">سجل تجاري: 7037810988 · الرقم الضريبي: 311386341200003</div>
        <div style="font-size:11px;color:var(--muted);margin-top:1px">HoloulEnergy · 966561274344+</div>
      </div>
    </div>
    <div>
      <div style="font-size:11px;color:var(--muted);letter-spacing:.02em">عرض سعر مُقدَّم إلى</div>
      <div id="bannerName" style="font-family:'Cairo',sans-serif;font-weight:800;font-size:18px;margin-top:1px">${state.client || '—'}</div>
      <div id="bannerPhone" class="num" style="font-size:12.5px;color:var(--muted);margin-top:1px">${state.clientPhone || '—'}</div>
    </div>
    <div style="text-align:left">
      <div style="font-size:11px;color:var(--muted);letter-spacing:.02em">تاريخ العرض</div>
      <div class="num" style="font-size:14px;font-weight:700;margin-top:1px">${new Date().toLocaleDateString('en-GB')}</div>
    </div>
  </div>`;
}

// Supply-only vs supply+install reference prices, shown together in every
// system summary. Both fields are computed server-side (supplyOnlyTotal /
// supplyPlusInstallTotal) — this just displays them.
function renderSupplyInstallSplit(q){
  if(q.supplyOnlyTotal == null || q.supplyPlusInstallTotal == null) return '';
  return `
  <div class="stats summary-stats" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-top:8px;border-top:1px solid var(--line);padding-top:8px">
    <div class="stat"><div class="v">${fmt(q.supplyOnlyTotal)} ﷼</div><div class="l">توريد خامات فقط</div></div>
    <div class="stat"><div class="v">${fmt(q.supplyPlusInstallTotal)} ﷼</div><div class="l">توريد وتركيب شامل الضمان</div></div>
  </div>`;
}

function renderStickyTotalBar(finalTotal){
  return `<div class="sticky-total-bar no-print" onclick="document.querySelector('.totalbar')?.scrollIntoView({behavior:'smooth',block:'center'})">
    <div><div class="stb-lbl">السعر النهائي شامل الضريبة</div><div class="stb-val">${fmt(finalTotal)} ﷼</div></div>
    <div class="stb-cta">التفاصيل ↑</div>
  </div>`;
}

// BOM qty strings come as "#12#" (a short-headline convention) — pull out
// the bare number so an editable quantity field can be pre-filled with it.
function bomQtyNum(qtyStr){
  const m = String(qtyStr==null?'':qtyStr).match(/-?\d+(\.\d+)?/);
  return m ? +m[0] : null;
}
// Editable quantity cell for BOM lines the rep/engineer is allowed to
// override (panel/inverter/battery/structure counts on the off-grid quote):
// a number input pre-filled with the current effective quantity, plus either
// a "تلقائي" (auto) hint or, once overridden, a reset chip showing what the
// calculator originally recommended so the rep can always see and undo it.
function renderEditableQtyCell(key, calcQty, overrideVal, autoQty){
  const isOverridden = overrideVal != null && overrideVal !== '';
  const current = isOverridden ? overrideVal : (calcQty ?? '');
  return `<div class="no-print" style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
    <input type="number" min="1" step="1" data-qtyoverride="${key}" value="${current}" style="width:58px;padding:4px 6px;font-size:12px;text-align:center">
    ${isOverridden
      ? `<button type="button" class="btn ghost small" data-qtyreset="${key}" title="رجوع للكمية المحسوبة تلقائيًا" style="padding:2px 7px;font-size:10.5px;white-space:nowrap">↺ ${autoQty ?? calcQty}</button>`
      : `<span style="font-size:9.5px;color:var(--muted);white-space:nowrap">تلقائي</span>`}
  </div><span class="qty-print-fallback">#${current}#</span>`;
}
function renderQuoteBomAndTotal(q, introText, qtyEdit){
  const editableKeys = (qtyEdit && qtyEdit.keys) || [];
  const overrides = (qtyEdit && qtyEdit.overrides) || {};
  const autoQty = (qtyEdit && qtyEdit.autoQty) || {};
  return `
  <div class="card">
    <div class="note">${introText}</div>
  </div>
  <div class="card">
    <h3>تفصيل عرض السعر</h3>
    ${editableKeys.length ? `<div class="note no-print" style="margin-bottom:10px">✏️ تقدر تعدّل كمية أي بند من البنود المميّزة تحت (زوّد أو قلّل) حسب تقييمك الفني لوضع العميل والموقع — السعر والتحذيرات الفنية هيتحدّثوا تلقائيًا على أساس الكمية اللي تدخلها.</div>` : ''}
    ${q.qtyOverrideNotice ? `<div class="note no-print" style="margin-bottom:10px;border-color:var(--sun-2);background:var(--sun-tint);color:#8a6208">${q.qtyOverrideNotice}</div>` : ''}
    <table class="bom">
      <thead><tr><th>#</th><th>المكونات</th><th>النوع</th><th>العدد</th><th>الضمان</th></tr></thead>
      <tbody>
        ${q.items.map((it,i)=>`
          <tr class="${it.on===false?'off':''}"><td>${i+1}</td><td class="bom-label">${it.label}${it.key==='panel' ? panelDatasheetLinkForIdx(state.offgrid?.panelIdx ?? state.ongrid?.panelIdx) : ''}</td>
            <td style="font-size:11.5px;color:var(--muted)">${it.type}</td>
            <td style="font-size:11.5px">${(it.on!==false && editableKeys.includes(it.key)) ? renderEditableQtyCell(it.key, bomQtyNum(it.qty), overrides[it.key], autoQty[it.key]) : it.qty}</td>
            <td style="font-size:11.5px">${it.warranty}</td></tr>`).join('')}
      </tbody>
    </table>
    ${((q.discountTotal + q.manualDiscountAmt) > 0) ? `
    <div class="note" style="margin-top:10px">
      <div style="display:flex;justify-content:space-between;padding:3px 0"><span>السعر الأساسي</span><span class="num" style="color:var(--ink)">${fmt(q.sellTotal)} ﷼</span></div>
      ${renderPriceAdjustLine(q.discountTotal + q.manualDiscountAmt)}
      <div style="display:flex;justify-content:space-between;padding:3px 0;font-weight:600"><span>الصافي بعد الخصم (قبل الضريبة)</span><span class="num" style="color:var(--ink)">${fmt(q.netAfterManual)} ﷼</span></div>
      <div style="display:flex;justify-content:space-between;padding:3px 0"><span>ضريبة القيمة المضافة</span><span class="num" style="color:var(--ink)">${fmt(q.vat)} ﷼</span></div>
    </div>` : ''}
    <div class="totalbar" style="justify-content:center">
      <div class="line">
        <div class="lbl">السعر النهائي شامل الضريبة</div>
        <div class="big num">${fmt(q.finalTotal)} ﷼</div>
      </div>
    </div>
    ${renderSupplyInstallSplit(q)}
    <div class="legal-note" style="margin-top:12px;font-size:11px;color:#B0432C;line-height:1.9">
      الارتباط بهذا السعر لمدة ثلاثة أيام فقط من تاريخ العرض (${new Date().toLocaleDateString('en-GB')}).
    </div>
    <div class="contact-note" style="margin-top:12px;text-align:center;font-size:11px;color:var(--muted);line-height:1.9">
      <b style="color:var(--ink)">للتواصل</b><br>info@HoloulEnergy.com · Sales@HoloulEnergy.com<br>
      <span class="num">966561274344+</span>
    </div>
    <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap" class="no-print">
      <button class="btn" onclick="handlePrint()">🖨️ طباعة / حفظ PDF</button>
      <button class="btn" style="background:#25D366;color:#fff" onclick="sendGenericQuoteWhatsapp(${q.finalTotal})">📤 إرسال العرض للعميل (واتساب)</button>
    </div>
  </div>
  ${renderStickyTotalBar(q.finalTotal)}`;
}

function sendGenericQuoteWhatsapp(finalTotal){
  if(!state.clientPhone){ alert('من فضلك اكتب رقم هاتف العميل أولاً'); return; }
  const phone = state.clientPhone.replace(/\D/g,'').replace(/^0/,'966');
  const msg = `حلول الطاقة المتجددة والمقاولات — HoloulEnergy\n\nعرض سعر منظومة طاقة شمسية\nالعميل: ${state.client}\nالسعر النهائي شامل ضريبة القيمة المضافة: ${fmt(finalTotal)} ﷼\n\nللتواصل: 966561274344+`;
  window.open('https://wa.me/'+phone+'?text='+encodeURIComponent(msg), '_blank');
}

// Common household/agricultural appliance presets for the off-grid load
// picker — typical power draw (watt), a reasonable average daily runtime
// (hours/day), and a startup-surge multiplier (motors/compressors draw a
// multiple of their running watts for a moment at startup — this feeds the
// inverter peak-sizing check on the server). Purely a UI convenience: the
// customer can still edit every value, or add a fully custom device.
const OFFGRID_APPLIANCE_PRESETS = [
  {name:'لمبة إضاءة LED', watts:10, dayHours:5, nightHours:19, surgeMultiplier:1},
  {name:'DVR / NVR', watts:25, dayHours:5, nightHours:19, surgeMultiplier:1},
  {name:'راوتر / شاحن', watts:15, dayHours:5, nightHours:19, surgeMultiplier:1},
  {name:'كاميرا مراقبة', watts:10, dayHours:5, nightHours:19, surgeMultiplier:1},
  {name:'لابتوب', watts:65, dayHours:8, nightHours:0, surgeMultiplier:1},
  {name:'مروحة', watts:70, dayHours:4, nightHours:6, surgeMultiplier:3},
  {name:'شفاط مطبخ', watts:75, dayHours:2, nightHours:0, surgeMultiplier:3},
  {name:'تلفاز LCD / كاميرات CCTV', watts:60, dayHours:5, nightHours:19, surgeMultiplier:1},
  {name:'تلفاز LCD', watts:80, dayHours:3, nightHours:3, surgeMultiplier:1},
  {name:'ثلاجة', watts:175, dayHours:6, nightHours:18, surgeMultiplier:7},
  {name:'كشاف إنارة', watts:200, dayHours:0, nightHours:12, surgeMultiplier:1},
  {name:'فريزر', watts:300, dayHours:6, nightHours:18, surgeMultiplier:7},
  {name:'موتور 1 حصان', watts:740, dayHours:0.25, nightHours:2, surgeMultiplier:7},
  {name:'ميكروويف', watts:1000, dayHours:1, nightHours:1, surgeMultiplier:1},
  {name:'موتور 1.5 حصان / غاطس', watts:1100, dayHours:2, nightHours:0.5, surgeMultiplier:7},
  {name:'تكييف 1.5 حصان', watts:1100, dayHours:8, nightHours:8, surgeMultiplier:7},
  {name:'غسالة', watts:1500, dayHours:2, nightHours:0, surgeMultiplier:7},
  {name:'تكييف 2.5 حصان', watts:1800, dayHours:8, nightHours:8, surgeMultiplier:7},
  {name:'تكييف 3 حصان', watts:2200, dayHours:8, nightHours:8, surgeMultiplier:7},
  {name:'هيتر مياه', watts:9000, dayHours:2, nightHours:0, surgeMultiplier:1},
];
// The admin-managed list from the server (pricing_config → offgrid.appliancePresets)
// takes over once it arrives; OFFGRID_APPLIANCE_PRESETS above is only the
// built-in fallback for the very first load / if the server has none set yet.
function activeAppliancePresets(){ return cachedOffgridAppliancePresets.length ? cachedOffgridAppliancePresets : OFFGRID_APPLIANCE_PRESETS; }

// Shared day-cycle simulation used by both the SVG day chart and the quick
// technical summary card below, so the two always agree on the same numbers
// (daily production, day/night consumption split, battery excess/deficit).
function computeOffgridDaySim(q, o){
  const sunHours = q.sunHours || 5.5;
  const systemEff = q.systemEfficiency || 0.8;
  const producedDailyKwh = q.actualKw * sunHours * systemEff;
  const batteryCapKwh = q.nameplateBatteryKwh || 0;

  const sunrise = 6, sunset = 18, windowH = sunset - sunrise;

  let dayConsumptionKwh = null, nightConsumptionKwh = null;
  if(o && o.method === 'appliances' && Array.isArray(o.appliances) && o.appliances.length){
    dayConsumptionKwh = o.appliances.reduce((s,a)=> s + ((+a.watts||0)*(+a.dayHours||0)*(+a.qty||1))/1000, 0);
    nightConsumptionKwh = o.appliances.reduce((s,a)=> s + ((+a.watts||0)*(+a.nightHours||0)*(+a.qty||1))/1000, 0);
  }
  const usingRealSplit = dayConsumptionKwh !== null && (dayConsumptionKwh + nightConsumptionKwh) > 0;
  if(!usingRealSplit){ dayConsumptionKwh = q.dailyKwh/2; nightConsumptionKwh = q.dailyKwh/2; }
  const dayKw = usingRealSplit ? dayConsumptionKwh / windowH : (q.dailyKwh/24);
  const nightKw = usingRealSplit ? nightConsumptionKwh / (24-windowH) : (q.dailyKwh/24);

  const N = 48;
  const hours = [], prodKw = [];
  for(let i=0;i<=N;i++){
    const h = i * 24 / N;
    hours.push(h);
    let p = 0;
    if(h>=sunrise && h<=sunset) p = Math.sin(Math.PI * (h - sunrise) / windowH);
    prodKw.push(Math.max(0,p));
  }
  const stepH = 24/N;
  const rawIntegral = prodKw.reduce((s,v)=>s+v,0) * stepH;
  const scale = rawIntegral > 0 ? producedDailyKwh / rawIntegral : 0;
  const prodScaled = prodKw.map(v=>v*scale);
  const consKw = hours.slice(0,N).map(h => (h>=sunrise && h<sunset) ? dayKw : nightKw);

  let soc = batteryCapKwh;
  const socSeries = [soc];
  let excessKwhTotal = 0, deficitKwhTotal = 0;
  for(let i=0;i<N;i++){
    const net = (prodScaled[i] - consKw[i]) * stepH;
    soc += net;
    if(soc > batteryCapKwh){ excessKwhTotal += (soc - batteryCapKwh); soc = batteryCapKwh; }
    if(soc < 0){ deficitKwhTotal += (-soc); soc = 0; }
    socSeries.push(soc);
  }
  const socPct = socSeries.map(v => batteryCapKwh>0 ? (v/batteryCapKwh*100) : 0);
  const maxKw = Math.max(...prodScaled, dayKw, nightKw) * 1.15 || 1;

  return {
    sunrise, sunset, windowH, N, stepH, hours, prodScaled, consKw, socPct, maxKw,
    producedDailyKwh, dayConsumptionKwh, nightConsumptionKwh, usingRealSplit,
    batteryCapKwh, excessKwhTotal, deficitKwhTotal, dayKw, nightKw,
  };
}

// Quick at-a-glance technical summary card — headline numbers + two small
// bar comparisons (production vs consumption, battery capacity vs night
// draw), meant to sit above the detailed hour-by-hour chart so a rep/customer
// can sanity-check the design in a few seconds without reading the graph.
function renderOffgridTechSummary(q, o){
  if(!q || !q.actualKw || !q.dailyKwh) return '';
  const sim = computeOffgridDaySim(q, o);
  const usableCapacityKwh = (q.nightKwh||0) + (q.batteryBufferKwh||0);
  const usagePct = usableCapacityKwh>0 ? (q.nightKwh/usableCapacityKwh*100) : 0;
  const invSufficient = !q.inverterSurgeWarning;
  const stringOk = q.mpptMin!=null ? (q.stringVimp>=q.mpptMin && q.stringVoc<=q.mpptMax) : null;

  const rows = [
    [`إجمالي قدرة الألواح / الإنتاجية اليومية المتوقعة`, `${fmt1(q.actualKw)} kWp — ${fmt1(sim.producedDailyKwh)} kWh/يوم`],
    [`إجمالي الأحمال النهارية / الليلية`, `نهار ${fmt1(sim.dayConsumptionKwh)} kWh — ليل ${fmt1(sim.nightConsumptionKwh)} kWh`],
    [`إجمالي الطاقة المخزنة بالبطاريات (استخدام ~${Math.round(usagePct)}% من السعة الكاملة عند أقصى تفريغ مصمم)`, `${fmt1(usableCapacityKwh)} kWh`],
    [`أقصى قدرة لحظية عند تشغيل كل الأجهزة معًا`, `${fmt1(q.peakKw)} kW — الإنفرتر: ${fmt1(q.invTotalKw)} kW مستمر / ${fmt1(q.invSurgeKw)} kW إقلاع — ${invSufficient?'كافٍ ✓':'غير كافٍ ⚠️'}`],
    [`تكوين مصفوفة الألواح`, `${q.panelsPerString} على التوالي × ${q.arrays} بالتوازي (إجمالي ${q.totalPanels} لوح)`],
    [`تكوين بنك البطاريات`, `${q.batterySeriesCount} على التوالي × ${q.batteryParallelCount} بالتوازي`],
    [`أيام الاستقلالية المصممة عليها`, `${q.autonomyDays} يوم بدون شحن`],
    [`فولت سلسلة الألواح مقابل نطاق MPPT للإنفرتر`, q.mpptMin!=null
      ? `${fmt1(q.stringVimp)}V (النطاق ${fmt1(q.mpptMin)}–${fmt1(q.mpptMax)}V) — ${stringOk?'ضمن النطاق ✓':'خارج النطاق ⚠️'}`
      : `بيانات MPPT غير متوفرة لهذا الموديل في الكتالوج`],
  ];

  const barsBlock = (items, title) => {
    const max = Math.max(...items.map(it=>it.value), 0.001);
    return `<div>
      <div style="font-size:12px;font-weight:700;margin-bottom:12px">${esc(title)}</div>
      <div style="display:flex;align-items:flex-end;gap:10px;height:130px">
        ${items.map(it=>`
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">
            <div style="font-size:11px;font-weight:800;margin-bottom:4px">${fmt1(it.value)}</div>
            <div style="width:100%;max-width:46px;background:${it.color};border-radius:4px 4px 0 0;height:${Math.max(4,(it.value/max)*100)}px"></div>
          </div>`).join('')}
      </div>
      <div style="display:flex;gap:10px;margin-top:6px">
        ${items.map(it=>`<div style="flex:1;text-align:center;font-size:10.5px;color:var(--muted);line-height:1.4">${esc(it.label)}</div>`).join('')}
      </div>
    </div>`;
  };

  return `
  <div class="card no-print">
    <h3 style="margin-bottom:12px">ملخص فني سريع للمنظومة</h3>
    <table class="admtable" style="margin-bottom:18px">
      <tbody>
        ${rows.map(r=>`<tr><td style="width:55%;color:var(--muted);font-size:12.5px">${r[0]}</td><td style="font-weight:700;font-size:12.5px">${r[1]}</td></tr>`).join('')}
      </tbody>
    </table>
    <div class="techsummary-charts">
      ${barsBlock([
        {label:'إنتاج الألواح', value: sim.producedDailyKwh, color:'#E7AC12'},
        {label:'استهلاك نهاري', value: sim.dayConsumptionKwh, color:'#155E85'},
        {label:'استهلاك ليلي', value: sim.nightConsumptionKwh, color:'#8a7530'},
        {label:'الفائض', value: sim.excessKwhTotal, color:'#0FA98D'},
      ], 'إنتاج الألواح اليومي مقابل الاستهلاك (kWh)')}
      ${barsBlock([
        {label:'سعة البطاريات', value: usableCapacityKwh, color:'#E7AC12'},
        {label:'استهلاك ليلي متفق عليه', value: sim.nightConsumptionKwh, color:'#0FA98D'},
        {label:'الفائض', value: Math.max(0, usableCapacityKwh - sim.nightConsumptionKwh), color:'#0FA98D'},
      ], 'سعة البطاريات مقابل الاستهلاك الليلي (kWh)')}
    </div>
    <div class="note" style="margin-top:16px">الأرقام تقديرية بناء على معطيات التصميم (ساعات الشمس القصوى، كفاءة النظام) — للتأكيد النهائي راجع مع المهندس المسؤول قبل التنفيذ.</div>
  </div>`;
}

function renderOffgridDayChart(q, o){
  if(!q || !q.actualKw || !q.dailyKwh) return '';
  const W = 680, H = 260, padL = 40, padR = 40, padT = 16, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  const sim = computeOffgridDaySim(q, o);
  const { sunrise, sunset, N, stepH, hours, prodScaled, consKw, socPct, maxKw,
    usingRealSplit, dayKw, nightKw, excessKwhTotal, deficitKwhTotal } = sim;
  const batteryCapKwh = sim.batteryCapKwh;
  const yForKw = kw => padT + plotH - (kw/maxKw)*plotH;
  const yForPct = pct => padT + plotH - (pct/100)*plotH;
  const xForH = h => padL + (h/24)*plotW;

  const prodPath = prodScaled.map((v,i)=>`${i===0?'M':'L'} ${xForH(hours[i]).toFixed(1)} ${yForKw(v).toFixed(1)}`).join(' ');
  const prodAreaPath = prodPath + ` L ${xForH(24).toFixed(1)} ${yForKw(0).toFixed(1)} L ${xForH(0).toFixed(1)} ${yForKw(0).toFixed(1)} Z`;
  const socPath = socPct.map((v,i)=>`${i===0?'M':'L'} ${xForH(i*stepH).toFixed(1)} ${yForPct(v).toFixed(1)}`).join(' ');
  const consPath = [
    `M ${xForH(0).toFixed(1)} ${yForKw(nightKw).toFixed(1)}`,
    `L ${xForH(sunrise).toFixed(1)} ${yForKw(nightKw).toFixed(1)}`,
    `L ${xForH(sunrise).toFixed(1)} ${yForKw(dayKw).toFixed(1)}`,
    `L ${xForH(sunset).toFixed(1)} ${yForKw(dayKw).toFixed(1)}`,
    `L ${xForH(sunset).toFixed(1)} ${yForKw(nightKw).toFixed(1)}`,
    `L ${xForH(24).toFixed(1)} ${yForKw(nightKw).toFixed(1)}`,
  ].join(' ');
  const xTicks = [0,4,8,12,16,20,24];

  return `
  <div style="overflow-x:auto">
  <svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:720px;height:auto;font-family:'Cairo',sans-serif;display:block" xmlns="http://www.w3.org/2000/svg">
    ${xTicks.map(h=>`<line x1="${xForH(h)}" y1="${padT}" x2="${xForH(h)}" y2="${padT+plotH}" stroke="#eee" stroke-width="1"/>`).join('')}
    <line x1="${padL}" y1="${padT+plotH}" x2="${padL+plotW}" y2="${padT+plotH}" stroke="#ccc" stroke-width="1"/>
    <path d="${prodAreaPath}" fill="#F3CB56" fill-opacity="0.45" stroke="none"/>
    <path d="${prodPath}" fill="none" stroke="#E7AC12" stroke-width="2"/>
    <path d="${consPath}" fill="none" stroke="#155E85" stroke-width="2" stroke-dasharray="5,4"/>
    <path d="${socPath}" fill="none" stroke="#0FA98D" stroke-width="2"/>
    ${xTicks.map(h=>`<text x="${xForH(h)}" y="${H-8}" font-size="10" fill="#63736F" text-anchor="middle">${h}</text>`).join('')}
    <text x="${padL-8}" y="${padT+10}" font-size="10" fill="#63736F" text-anchor="end">${maxKw.toFixed(1)} kW</text>
    <text x="${padL-8}" y="${padT+plotH}" font-size="10" fill="#63736F" text-anchor="end">0</text>
    <text x="${padL+plotW+6}" y="${padT+10}" font-size="10" fill="#0B7A66" text-anchor="start">100%</text>
    <text x="${padL+plotW+6}" y="${padT+plotH}" font-size="10" fill="#0B7A66" text-anchor="start">0%</text>
  </svg>
  </div>
  <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:8px;font-size:11.5px;align-items:center">
    <span style="display:flex;align-items:center;gap:5px"><span style="width:14px;height:3px;background:#E7AC12;display:inline-block"></span> إنتاج الألواح (kW)</span>
    <span style="display:flex;align-items:center;gap:5px"><span style="width:14px;height:2px;background:#155E85;display:inline-block"></span> الاستهلاك (kW)${usingRealSplit?' — نهار/ليل فعلي':' — افتراض ثابت'}</span>
    <span style="display:flex;align-items:center;gap:5px"><span style="width:14px;height:3px;background:#0FA98D;display:inline-block"></span> شحن البطارية (%)</span>
    ${infoIcon((usingRealSplit
      ? `الاستهلاك محسوب فعليًا من ساعات التشغيل النهارية/الليلية اللي أدخلتها لكل جهاز`
      : `بيفترض استهلاك ثابت على مدار الساعة (اختر "قائمة الأجهزة" وحدد ساعات النهار/الليل لكل جهاز عشان دقة أعلى)`)
      + `، ونافذة سطوع شمس افتراضية من 6 صباحًا لـ6 مساءً بشكل جرسي لشكل منحنى الإنتاج — إجمالي الإنتاج اليومي محسوب فعليًا من نفس معادلة التسعير.`, 'الرسم استرشادي')}
  </div>
  <div class="note" style="margin-top:8px">
    ${deficitKwhTotal>0.05
      ? `⚠️ البطارية ممكن توصل لصفر خلال اليوم (نقص تقريبي ${deficitKwhTotal.toFixed(1)} كيلوواط/ساعة) — يُنصح بمراجعة عدد أيام الاستقلالية أو حجم البطارية.`
      : `البطارية بتغطي الاستهلاك الليلي بالكامل، وبيفضل هامش ${(100 - Math.min(...socPct)).toFixed(0)}% تقريبًا في أقل نقطة شحن.`}
    ${excessKwhTotal>0.05 ? ` وفيه حوالي ${excessKwhTotal.toFixed(1)} كيلوواط/ساعة فائض إنتاج يوميًا بعد امتلاء البطارية.` : ''}
  </div>`;
}

function renderOffgridCalc(){
  const q = cachedOffgridQuote;
  const o = state.offgrid;
  const OFFGRID_TOGGLE_DEFS = [
    ['panel','ألواح شمسية'], ['inverter','انفرتر'], ['battery','بنك البطاريات'],
    ['structure','الشاسيه/الحوامل'], ['cabling','الكابلات ولوحة الحماية'], ['install','التركيب والتشغيل'],
  ];
  const inputCard = `
    <div class="card">
      <h3>بيانات العميل</h3>
      <label>اسم العميل *</label>
      <input type="text" id="og_client" value="${state.client}" placeholder="اسم العميل">
      <label>رقم الهاتف / واتساب *</label>
      <input type="text" id="og_phone" value="${state.clientPhone}" placeholder="05xxxxxxxx">
    </div>
    <div class="card">
      <h3>ملف الأحمال — LOAD PROFILE</h3>
      <div class="seg preset-list" style="flex-direction:column;gap:6px;height:auto;border:0">
        <button type="button" data-ogmethod="consumption" class="${o.method==='consumption'?'active':''}" style="padding:10px">أدخل معدل الاستهلاك اليومي مباشرة</button>
        <button type="button" data-ogmethod="appliances" class="${o.method==='appliances'?'active':''}" style="padding:10px">احسب من قائمة الأجهزة</button>
      </div>
      ${o.method==='consumption' ? `
      <label style="margin-top:10px">الاستهلاك اليومي (كيلوواط/ساعة)</label>
      <input type="number" id="og_dailykwh" value="${o.dailyKwh}" min="0.1" step="0.1">
      ` : `
      <label style="margin-top:10px">قائمة الأجهزة</label>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
        <select id="ogAppliancePreset" style="flex:1;min-width:180px">
          ${activeAppliancePresets().map((p,i)=>`<option value="${i}">${p.name} (${p.watts} واط)</option>`).join('')}
        </select>
        <button type="button" class="btn small" id="ogAddPresetAppliance">+ إضافة من القائمة</button>
      </div>
      <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
      <table class="admtable" id="ogApplianceTable">
        <thead><tr><th>الجهاز</th><th>واط</th><th>ساعات نهارية</th><th>ساعات ليلية</th><th>العدد</th><th></th></tr></thead>
        <tbody>
          ${o.appliances.map((a,i)=>`
            <tr>
              <td><input data-ogapp="${i}" data-af="name" value="${a.name}" style="width:120px"></td>
              <td><input data-ogapp="${i}" data-af="watts" type="number" value="${a.watts}" style="width:70px"></td>
              <td><input data-ogapp="${i}" data-af="dayHours" type="number" value="${a.dayHours ?? 0}" min="0" max="12" step="0.25" style="width:60px"></td>
              <td><input data-ogapp="${i}" data-af="nightHours" type="number" value="${a.nightHours ?? 0}" min="0" max="12" step="0.25" style="width:60px"></td>
              <td><input data-ogapp="${i}" data-af="qty" type="number" value="${a.qty}" style="width:55px"></td>
              <td><button type="button" class="btn ghost small" data-ogdelapp="${i}">✕</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
      </div>
      <div style="margin-top:4px">${infoIcon('النهار افتراضيًا من 6ص لـ6م (12 ساعة)، والليل من 6م لـ6ص (12 ساعة) — الفصل ده بيحسّن دقة رسم الإنتاج/الاستهلاك تحت.')} <span style="font-size:11.5px;color:var(--muted)">ملاحظة عن ساعات النهار/الليل</span></div>
      <button type="button" class="btn ghost small" id="ogAddAppliance" style="margin-top:8px">+ إضافة جهاز مخصّص</button>
      <div class="note" style="margin-top:8px" id="og_live_total">إجمالي الاستهلاك اليومي (حسب المُدخل الآن): <b>${fmt1(computeLocalDailyKwh(o.appliances))}</b> كيلوواط/ساعة</div>
      `}
      <div id="og_loads_dirty_banner" style="margin-top:8px;${offgridLoadsConfirmed?'display:none':''}" class="note">⚠️ فيه تعديلات في ملف الأحمال لسه ماتأكدتش — اضغط "تأكيد ملف الأحمال" تحت عشان الحسابات والسعر النهائي يتحدّثوا على أساسها.</div>
      <button type="button" class="btn" id="ogConfirmLoads" style="margin-top:10px;width:100%">✓ تأكيد ملف الأحمال وإعادة الحساب</button>
      <label style="margin-top:14px">أيام الاستقلالية (بدون شمس)</label>
      <div style="display:flex;gap:8px;align-items:center">
        <input type="number" id="og_autonomy" value="${o.autonomyDays}" min="0" step="1" style="flex:1">
        <button type="button" class="btn small" id="ogAutonomyConfirm">تأكيد</button>
      </div>
      <div style="margin-top:4px">${infoIcon('تقدر تدخل 0 لو مش محتاج أيام احتياط بدون شمس — اضغط "تأكيد" بعد كتابة الرقم.')}</div>
    </div>
    <div class="card">
      <h3>نوع اللوح الشمسي</h3>
      <select id="og_panel">
        ${cachedPanelOptions.map(p=>`<option value="${p.idx}" ${p.idx==o.panelIdx?'selected':''}>${p.brand} ${p.power}W</option>`).join('')}
      </select>
    </div>
    <div class="card">
      <h3>الانفرتر</h3>
      <label>ماركة الانفرتر</label>
      <select id="og_inverter_brand">
        <option value="">الكل</option>
        ${[...new Set(cachedInverterModelOptions.map(m=>m.brand).filter(Boolean))].sort().map(b=>`<option value="${b}" ${b===o.inverterBrand?'selected':''}>${b}</option>`).join('')}
      </select>
      <label style="margin-top:10px">موديل الانفرتر</label>
      <select id="og_inverter_model">
        <option value="">تلقائي — أصغر انفرتر كافٍ للحمل المسجّل${q?` (${fmt1(q.peakKw)} كيلوواط)`:''}</option>
        ${cachedInverterModelOptions
          .filter(m=>!o.inverterBrand || m.brand===o.inverterBrand)
          .map(m=>`<option value="${m.model}" ${m.model===o.inverterModel?'selected':''}>${m.model}${m.brand?` — ${m.brand}`:''} (${fmt1(m.kw)} كيلوواط، فولت بطارية مدعوم ${m.voltageClasses.join('/')}V)</option>`).join('')}
      </select>
      <div style="margin-top:6px">${infoIcon(
          (o.inverterModel
          ? `هيتم استخدام موديل "<b>${o.inverterModel}</b>" بالظبط بدل الاختيار التلقائي — مفيد لو المهندس عايز يكبّر الجهاز أو يلتزم بماركة معينة حسب الخبرة الميدانية. لو قدرة الموديل ده أقل من الحمل المسجّل، الحاسبة هتوصّل عدة وحدات منه على التوازي تلقائيًا${q&&q.invCount>1?` (حاليًا: <b>${q.invCount} وحدة</b>)`:''}.`
          : `اختيار "تلقائي" بيخلي الحاسبة تختار أصغر موديل انفرتر كافٍ لتغطية الحمل المسجّل فقط. غيّر الاختيار هنا لو محتاج جهاز أكبر أو ماركة معينة.`)
          + `<br>ملحوظة: اختيار الانفرتر هو اللي بيحدد فولتات البطارية المتاحة تحت — تغيير الموديل هنا هيغيّر تلقائيًا الخيارات المتاحة في كارت البطارية.`
        )}</div>
    </div>
    <div class="card">
      <h3>البطارية</h3>
      ${q && Array.isArray(q.invVoltageClasses) ? `<div style="margin-bottom:6px">${infoIcon(`الانفرتر المستخدم حاليًا لهذا الحمل: <b>${q.invModel}</b> — بيدعم فقط فولت <b>${q.invVoltageClasses.join('/')}V</b>، فالخيارات تحت مقصورة على الفولت ده بس.`)}</div>` : ''}
      <label>نوع البطارية (الماركة)</label>
      <select id="og_battery_brand">
        <option value="">الكل</option>
        ${[...new Set(cachedBatteryModelOptions.filter(m=>m.stdVoltage===o.batteryVoltage).map(m=>m.brand).filter(Boolean))].sort().map(b=>`<option value="${b}" ${b===o.batteryBrand?'selected':''}>${b}</option>`).join('')}
      </select>
      <label style="margin-top:10px">فولت البطارية</label>
      <select id="og_battery_voltage">
        ${cachedBatteryVoltageOptions
          .filter(v=>!q || !Array.isArray(q.invVoltageClasses) || !q.invVoltageClasses.length || q.invVoltageClasses.includes(v))
          .map(v=>`<option value="${v}" ${v==o.batteryVoltage?'selected':''}>${v}V</option>`).join('')}
      </select>
      <div style="margin-top:4px">${infoIcon('القائمة دي بتعرض بس الفولتات المتوافقة كهربائيًا مع الانفرتر المستخدم حاليًا — فولت أعلى من قدرة الانفرتر مش هيظهر أصلًا، وأي ماركة بطارية متاحة بالفولت الأعلى بس مش هتظهر برضه لنفس السبب.')}</div>
      <label style="margin-top:10px">حجم البطارية (Ah)</label>
      <select id="og_battery_model">
        <option value="">تلقائي — أنسب سعة (أقل تكلفة إجمالية تغطي الاحتياج) عند الفولت والماركة المختارين</option>
        ${cachedBatteryModelOptions
          .filter(m=>m.stdVoltage==o.batteryVoltage && (!o.batteryBrand || m.brand===o.batteryBrand))
          .map(m=>`<option value="${m.model}" ${m.model===o.batteryModel?'selected':''}>${m.ah}Ah${m.brand?` — ${m.brand}`:''} (${fmt1(m.kwh)} كيلوواط/ساعة، فولت فعلي ${fmt1(m.voltage)}V)</option>`).join('')}
      </select>
      <div style="margin-top:6px">${infoIcon(
          (o.batteryModel
          ? `هيتم الحساب على أساس موديل "<b>${o.batteryModel}</b>" بالظبط، وتحديد عدد الوحدات على التوازي تلقائيًا حسب السعة المطلوبة.`
          : (q && q.batterySeriesCount>1
              ? `الحاسبة هتوصّل تلقائيًا <b>${q.batterySeriesCount} بطارية على التوالي</b> (= ${fmt1(q.batteryPackVoltage)}V) × <b>${q.batteryParallelCount} على التوازي</b> للوصول للسعة المطلوبة.`
              : `اختيار "تلقائي" بيخلي الحاسبة تجرّب كل الأحجام المتاحة عند الفولت والماركة المحددين، وتختار الحجم اللي هيوصلك للسعة المطلوبة بأقل تكلفة إجمالية — مش بالضرورة أكبر حجم متاح.`))
          + `<br>ملحوظة: فولت بطاريات الليثيوم الفعلي بيتفاوت شوية حتى داخل نفس الفئة (مثلًا 24.5V/25V/25.1V كلهم فئة 24V) — التصنيف هنا بالفئة القياسية (12/24/48) مش بالرقم الفعلي المطبوع على الموديل.`
        )}</div>
    </div>
    <div class="card">
      <h3>نوع العرض</h3>
      <div class="seg preset-list" style="flex-direction:column;gap:6px;height:auto;border:0">
        <button type="button" data-ogpreset="materials" style="padding:10px">توريد خامات فقط (انفرتر + ألواح + بطاريات)</button>
        <button type="button" data-ogpreset="turnkey" style="padding:10px">توريد وتركيب (شامل كل البنود)</button>
      </div>
      <div class="note" style="margin-top:10px">اختيار أحد الخيارين يعبّئ البنود تلقائيًا تحت — وتقدر بعدها تفعّل/تعطّل أي بند يدويًا (مثلاً: انفرتر وألواح بس من غير بطاريات، أو المكونات كاملة والشاسيه من غير تركيب).</div>
    </div>
    <div class="card">
      <h3>البنود المُفعّلة في العرض</h3>
      <div class="toggles">
        ${OFFGRID_TOGGLE_DEFS.map(([k,l])=>`
          <label class="tgl"><input type="checkbox" data-ogtgl="${k}" ${o.toggles[k]?'checked':''}> ${l}</label>
        `).join('')}
      </div>
    </div>`;

  if(!q){
    return `<div class="input-rail">${inputCard}</div>
      <div class="card" style="max-width:420px;margin:60px auto;text-align:center">
        ${offgridEngineError
          ? `<h3 style="color:#B0432C">تعذر الاتصال بالخادم</h3><div class="note">${offgridEngineError}</div><button class="btn small" id="retryLoadOffgrid" style="margin-top:12px">إعادة المحاولة</button>`
          : `<h3>جارِ التحميل...</h3><div class="note">جارِ حساب السعر</div>`}
      </div>`;
  }
  const loadingBadge = offgridLoading ? `<div class="reload-badge no-print"><span class="spin"></span> جارِ تحديث السعر...</div>` : '';
  return `${loadingBadge}
  <div class="grid2">
    <div class="input-rail">${inputCard}</div>
    <div id="quotePrintArea" class="quote-shell ${offgridLoading?'quote-loading':''}">
      ${renderQuoteHeaderBanner()}
      <div class="card no-print">
        <h3 style="margin-bottom:6px">ملخص المنظومة <span class="tag">أوف-جريد — ${q.invKw} KW</span></h3>
        <div class="stats" style="grid-template-columns:repeat(4,minmax(0,1fr));margin-top:10px">
          <div class="stat"><div class="v">${fmt1(q.actualKw)}</div><div class="l">KW ألواح</div></div>
          <div class="stat"><div class="v">${q.totalPanels}</div><div class="l">لوح</div></div>
          <div class="stat"><div class="v">${fmt1(q.nameplateBatteryKwh)}</div><div class="l">KWh بطارية</div></div>
          <div class="stat"><div class="v">${q.autonomyDays}</div><div class="l">يوم استقلالية</div></div>
        </div>
        ${q.batteryCount ? `<div class="note" style="margin-top:10px">تكوين بنك البطاريات: <b>${q.batteryCount}</b> بطارية ${fmt1(q.batteryUnitVoltage)}V${q.batterySeriesCount>1?` (${q.batterySeriesCount} توالي × ${q.batteryParallelCount} توازي = ${fmt1(q.batteryPackVoltage)}V)`:''}</div>` : ''}
      </div>
      ${renderOffgridTechSummary(q, o)}
      <div class="card no-print">
        <h3 style="margin-bottom:6px">الطاقة اليومية: إنتاج مقابل استهلاك ${infoIcon('رسم استرشادي لتوزيع الإنتاج والاستهلاك على مدار اليوم — بافتراض استهلاك شبه ثابت على مدار الساعة، عشان تتأكد إن الألواح والبطارية بيغطوا الاحتياج فعلًا.')}</h3>
        ${renderOffgridDayChart(q, o)}
      </div>
      ${renderQuoteBomAndTotal(q, `عرض سعر منظومة طاقة شمسية أوف-جريد (مستقلة عن الشبكة) بسعة ${fmt1(q.actualKw)} كيلوواط وبنك بطاريات ${fmt1(q.nameplateBatteryKwh)} كيلوواط/ساعة.`, {
        keys: ['panel','inverter','battery','structure'],
        overrides: o.qtyOverrides || {},
        autoQty: q.autoQty || {},
      })}
      <div class="card no-print">
        <h3 id="adminInfoTrigger" style="cursor:default">معلومات إضافية</h3>
        ${adminInfoUnlocked ? (adminFinancialsOffgrid ? renderAdminFinancials(adminFinancialsOffgrid) : `<div class="note">جارِ التحميل...</div>`) : ``}
      </div>
    </div>
  </div>`;
}

function renderOngridCalc(){
  const q = cachedOngridQuote;
  const n = state.ongrid;
  const inputCard = `
    <div class="card">
      <h3>بيانات العميل</h3>
      <label>اسم العميل *</label>
      <input type="text" id="ng_client" value="${state.client}" placeholder="اسم العميل">
      <label>رقم الهاتف / واتساب *</label>
      <input type="text" id="ng_phone" value="${state.clientPhone}" placeholder="05xxxxxxxx">
    </div>
    <div class="card">
      <h3>طريقة تحديد حجم المنظومة</h3>
      <div class="seg preset-list" style="flex-direction:column;gap:6px;height:auto;border:0">
        <button type="button" data-ngmethod="bill" class="${n.method==='bill'?'active':''}" style="padding:10px">من قيمة فاتورة الكهرباء الشهرية</button>
        <button type="button" data-ngmethod="kwh" class="${n.method==='kwh'?'active':''}" style="padding:10px">من الاستهلاك الشهري (كيلوواط/ساعة)</button>
        <button type="button" data-ngmethod="kw" class="${n.method==='kw'?'active':''}" style="padding:10px">تحديد قدرة المنظومة مباشرة (كيلوواط)</button>
      </div>
      ${n.method==='bill' ? `
      <label style="margin-top:10px">قيمة الفاتورة الشهرية (﷼)</label>
      <input type="number" id="ng_bill" value="${n.billSar}" min="1" step="10">
      ` : n.method==='kwh' ? `
      <label style="margin-top:10px">الاستهلاك الشهري (كيلوواط/ساعة)</label>
      <input type="number" id="ng_kwh" value="${n.monthlyKwh}" min="1" step="10">
      ` : `
      <label style="margin-top:10px">قدرة المنظومة المطلوبة (كيلوواط)</label>
      <input type="number" id="ng_kw" value="${n.systemKw}" min="1" step="1">
      `}
    </div>
    <div class="card">
      <h3>نوع اللوح الشمسي</h3>
      <select id="ng_panel">
        ${cachedPanelOptions.map(p=>`<option value="${p.idx}" ${p.idx==n.panelIdx?'selected':''}>${p.brand} ${p.power}W</option>`).join('')}
      </select>
    </div>`;

  if(!q){
    return `<div class="input-rail">${inputCard}</div>
      <div class="card" style="max-width:420px;margin:60px auto;text-align:center">
        ${ongridEngineError
          ? `<h3 style="color:#B0432C">تعذر الاتصال بالخادم</h3><div class="note">${ongridEngineError}</div><button class="btn small" id="retryLoadOngrid" style="margin-top:12px">إعادة المحاولة</button>`
          : `<h3>جارِ التحميل...</h3><div class="note">جارِ حساب السعر</div>`}
      </div>`;
  }
  const loadingBadge = ongridLoading ? `<div class="reload-badge no-print"><span class="spin"></span> جارِ تحديث السعر...</div>` : '';
  return `${loadingBadge}
  <div class="grid2">
    <div class="input-rail">${inputCard}</div>
    <div id="quotePrintArea" class="quote-shell ${ongridLoading?'quote-loading':''}">
      ${renderQuoteHeaderBanner()}
      <div class="card no-print">
        <h3 style="margin-bottom:6px">ملخص المنظومة <span class="tag">أون-جريد — ${q.invKw} KW</span></h3>
        <div class="stats" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-top:10px">
          <div class="stat"><div class="v">${fmt1(q.actualKw)}</div><div class="l">KW</div></div>
          <div class="stat"><div class="v">${q.totalPanels}</div><div class="l">لوح</div></div>
          <div class="stat"><div class="v">${fmt(q.sarPerKW)}</div><div class="l">ريال / KW</div></div>
        </div>
      </div>
      ${renderQuoteBomAndTotal(q, `عرض سعر منظومة طاقة شمسية أون-جريد (مربوطة بالشبكة الكهربائية) بسعة ${fmt1(q.actualKw)} كيلوواط.`)}
      <div class="card no-print">
        <h3 id="adminInfoTrigger" style="cursor:default">معلومات إضافية</h3>
        ${adminInfoUnlocked ? (adminFinancialsOngrid ? renderAdminFinancials(adminFinancialsOngrid) : `<div class="note">جارِ التحميل...</div>`) : ``}
      </div>
    </div>
  </div>`;
}

// Donut chart: cost vs. profit vs. VAT as shares of the final (VAT-incl) total.
function buildFinancialsDonut(cost, profit, vat){
  const total = cost + profit + vat;
  if(total <= 0) return '';
  const r = 54, cx = 70, cy = 70, circ = 2*Math.PI*r;
  const segs = [
    {label:'التكلفة',  value:cost,   color:'#0D3452'},
    {label:'الربح',    value:profit, color:'#0FA98D'},
    {label:'الضريبة',  value:vat,    color:'#E7AC12'},
  ];
  let offset = 0;
  const arcs = segs.map(s=>{
    const frac = s.value/total;
    const len = frac*circ;
    const dasharray = `${len.toFixed(2)} ${(circ-len).toFixed(2)}`;
    const dashoffset = (-offset).toFixed(2);
    offset += len;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="22" stroke-dasharray="${dasharray}" stroke-dashoffset="${dashoffset}" transform="rotate(-90 ${cx} ${cy})"/>`;
  }).join('');
  return `
  <div class="fin-donut-wrap">
    <svg viewBox="0 0 140 140" class="fin-donut">
      ${arcs}
      <text x="70" y="65" text-anchor="middle" class="donut-center-v">${fmt(total)}</text>
      <text x="70" y="82" text-anchor="middle" class="donut-center-l">﷼ الإجمالي شامل الضريبة</text>
    </svg>
    <div class="fin-donut-legend">
      ${segs.map(s=>`<div class="fin-legend-row"><span class="dot" style="background:${s.color}"></span><span class="lbl">${s.label}</span><span class="pct">${(s.value/total*100).toFixed(1)}%</span><span class="val">${fmt(s.value)} ﷼</span></div>`).join('')}
    </div>
  </div>`;
}

function renderAdminFinancials(q){
  const onItems = q.items.filter(it=>it.on);
  const totalCost = onItems.reduce((s,it)=>s+it.costBasis,0);
  // Use netAfterManual (after the special discount/increase, if any) as the
  // real sell base — this is what q.vat and q.finalTotal are actually
  // computed from, so every group below reconciles exactly, including when
  // a special discount (or a negative one, i.e. a price increase) is set.
  const sellBase = q.netAfterManual != null ? q.netAfterManual : q.netAfterDiscount;
  const profit = sellBase - totalCost;
  const profitPct = sellBase ? (profit/sellBase*100) : 0;
  // Derive the effective VAT rate from the real server-computed VAT figure
  // (rather than hardcoding 15%), then split it proportionally across the
  // cost and profit portions — costVat + profitVat always equals q.vat
  // exactly, since totalCost + profit = sellBase by definition.
  const vatRate = sellBase ? (q.vat / sellBase) : 0.15;
  const costVat = totalCost * vatRate;
  const profitVat = profit * vatRate;
  return `
    <table class="admtable">
      <thead><tr><th>البند</th><th>سعر التكلفة</th><th>سعر البيع</th><th>الهامش</th></tr></thead>
      <tbody>
        ${onItems.map(it=>`<tr><td>${it.label}</td><td class="num">${fmt(it.costBasis)}</td><td class="num">${fmt(it.sell)}</td><td class="num">${fmt(it.sell-it.costBasis)}</td></tr>`).join('')}
      </tbody>
    </table>
    ${(q.discountTotal || q.manualDiscountAmt) ? `
    <div class="note" style="margin-bottom:10px">
      إجمالي سعر البيع قبل الخصم: ${fmt(q.sellTotal)} ﷼ ·
      الخصم الممنوح: ${fmt(q.discountTotal)} ﷼${q.manualDiscountAmt ? (q.manualDiscountAmt > 0 ? ` (منها خصم خاص ${fmt(q.manualDiscountAmt)} ﷼)` : ` (بالإضافة إلى زيادة خاصة ${fmt(Math.abs(q.manualDiscountAmt))} ﷼)`) : ''}
    </div>` : ''}

    <div class="fin-groups">
      <div class="fin-group fin-group-sell">
        <div class="fin-group-title">التسعير <span class="tag">البيع</span></div>
        <div class="fin-row"><span class="l">إجمالي سعر البيع</span><span class="v">${fmt(sellBase)} ﷼</span></div>
        <div class="fin-row"><span class="l">الضريبة</span><span class="v">${fmt(q.vat)} ﷼</span></div>
        <div class="fin-row total"><span class="l">السعر شامل الضريبة</span><span class="v">${fmt(q.finalTotal)} ﷼</span></div>
      </div>
      <div class="fin-group fin-group-cost">
        <div class="fin-group-title">التكلفة <span class="tag">Cost</span></div>
        <div class="fin-row"><span class="l">إجمالي التكلفة الفعلية</span><span class="v">${fmt(totalCost)} ﷼</span></div>
        <div class="fin-row"><span class="l">ضريبة التكاليف</span><span class="v">${fmt(costVat)} ﷼</span></div>
        <div class="fin-row total"><span class="l">إجمالي التكلفة شاملة الضريبة</span><span class="v">${fmt(totalCost+costVat)} ﷼</span></div>
      </div>
      <div class="fin-group fin-group-profit">
        <div class="fin-group-title">الربح <span class="tag">${profitPct.toFixed(1)}%</span></div>
        <div class="fin-row"><span class="l">صافي الربح المتوقع</span><span class="v">${fmt(profit)} ﷼</span></div>
        <div class="fin-row"><span class="l">ضريبة الربح</span><span class="v">${fmt(profitVat)} ﷼</span></div>
        <div class="fin-row total"><span class="l">الربح شامل الضريبة</span><span class="v">${fmt(profit+profitVat)} ﷼</span></div>
      </div>
    </div>

    ${buildFinancialsDonut(totalCost, profit, q.vat)}

    <button class="btn ghost small" id="lockAdminInfo" type="button" style="margin-top:14px">إخفاء</button>
  `;
}

