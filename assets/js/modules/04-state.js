/* =======================================================================
   4) STATE
   ======================================================================= */
const state = {
  hp: 500,
  panelIdx: 0,
  structureType: 'FIXED',
  panelsPerStringAdjust: 0,
  stringsAdjust: 0,
  inverterPowerIncrease: 0,
  discountOverrideIdx: null,
  specialDiscountAmt: 0,
  toggles: {panel:true, inverter:true, ip65:false, combiner:true, cables:true, mc4:true,
            structure:false, concrete:false, earth:false, reactor:false, civilworks:false, elecworks:false, supply:false},
  client: '',
  clientPhone: '',
  calcSystem: 'irrigation', // 'irrigation' | 'offgrid' | 'ongrid'
  offgrid: {
    panelIdx: 0,
    method: 'consumption', // 'consumption' | 'appliances'
    dayKwh: 5,
    nightKwh: 5,
    dailyKwh: 10, // = dayKwh + nightKwh (kept for saved-quote compatibility)
    autonomyDays: 0,
    appliances: [ {name:'ثلاجة', watts:175, dayHours:6, nightHours:18, qty:1, surgeMultiplier:7} ],
    inverterBrand: '', // filter for the inverter model dropdown — '' = all brands
    inverterModel: null, // null = auto-pick smallest inverter that covers the load; otherwise an exact model from inverterModelOptions (engineer override — e.g. size up, or a specific preferred brand)
    batteryVoltage: null, // null = server uses its own default (bus voltage)
    batteryBrand: '', // filter for the size(Ah) dropdown — '' = all brands; also sent to the server so "auto" respects it
    batteryModel: null, // null = auto-pick largest-capacity model at batteryVoltage; otherwise an exact "brand+Ah+voltage" model from batteryModelOptions
    qtyOverrides: { panel: null, inverter: null, battery: null, structure: null }, // null = use the calculated quantity; a number = rep's manual override for that BOM line, based on field judgment
    toggles: { panel:true, inverter:true, battery:true, structure:true, cabling:true, install:true }, // which BOM lines to include — "توريد فقط" preset flips structure/cabling/install off, "توريد وتركيب" turns everything on; the rep can also flip any single item independently
  },
  ongrid: {
    panelIdx: 0,
    method: 'bill', // 'bill' | 'kwh' | 'kw'
    billSar: 500,
    monthlyKwh: 1000,
    systemKw: 10,
  },
};
let discountUnlocked = false;
let adminInfoUnlocked = false;

function currentQuote(){
  return cachedQuote;
}

const fmt = n => Math.round(n).toLocaleString('en-US');
/* نطاق العمل في كود العرض: SUP توريد فقط · SI توريد وتركيب · INS تركيب فقط (نفس منطق جدول الدفعات) */
function qlScopeCode(){
  const t = state.toggles || {};
  const inst = !!(t.civilworks || t.elecworks);
  if(!inst) return 'SUP';
  return t.supply ? 'SI' : 'INS';
}
function buildQLCode(q){
  const d = new Date();
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dateStr = String(d.getDate()).padStart(2,'0')+months[d.getMonth()]+d.getFullYear();
  const panel = cachedPanelOptions.find(p=>p.idx===state.panelIdx) || {brand:'',power:''};
  const digits = (state.clientPhone||'').replace(/\D/g,'');
  const p4 = digits.length>=4 ? '-'+digits.slice(-4) : '';
  return `QL-${dateStr}-P-${state.hp} HP-${q.invBrandName||'VEICHI'} ${q.invKW} KW-${panel.brand}${panel.power}-${state.structureType}-${qlScopeCode()}${p4}`;
}
/* الرمز المرجعي (QL-YYYYMM-NNNN) + الكود الوصفي المحفوظين على السيرفر وقت الحفظ */
let savedQuoteInfo = null; // {key, ref, ql}
/* رمز المراجعة: أي تعديل على عرض محفوظ لنفس العميل بيتحفظ كمراجعة (R1, R2...) بنفس الرمز المرجعي الأساسي */
let revisionParent = null; // {ref, phone, hp, explicit}
/* بصمة مدخلات العرض (بدون بيانات العميل) — بتتقارن مع العرض المحمّل علشان نعرف لو اتغيّر فعلاً */
/* ---- ملاحظات البنود في العروض ----
   كل بند في جدول العرض له خانة ملاحظة اختيارية. عمود "ملاحظات" بيظهر في العرض
   المطبوع / الـ PDF / واتساب / الـ CRM بس لو فيه ملاحظة واحدة على الأقل، ولو مفيش
   ولا ملاحظة العمود بيختفي تمامًا. على الشاشة خانة الكتابة بتفضل موجودة عشان تقدر
   تكتب فيها. المفتاح = it.key في عروض المنظومات، و p:<اسم المنتج> / x:<مفتاح الإضافة> في السلة. */
let quoteItemNotes = {};
function noteEsc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function noteOf(key){ return String(quoteItemNotes[key]==null ? '' : quoteItemNotes[key]).trim(); }
function cleanNotes(){
  const out = {};
  Object.keys(quoteItemNotes).sort().forEach(k=>{ const v = noteOf(k); if(v) out[k] = v.slice(0,300); });
  return out;
}
function anyNoteFor(keys){ return keys.some(k=>!!noteOf(k)); }
function noteTh(){ return '<th class="notecol">ملاحظات</th>'; }
function noteTd(key){
  const v = noteOf(key);
  return `<td class="notecol"><input type="text" class="note-edit no-print" data-itemnote="${noteEsc(key)}" maxlength="300" placeholder="ملاحظة (اختياري)" value="${noteEsc(v)}"><span class="note-print">${noteEsc(v)}</span></td>`;
}
function setQuoteNotes(obj){
  quoteItemNotes = {};
  if(obj && typeof obj === 'object') Object.keys(obj).forEach(k=>{ const v = String(obj[k]==null?'':obj[k]).trim(); if(v) quoteItemNotes[k] = v.slice(0,300); });
}
// الكتابة في خانة الملاحظة بتحدّث الحالة والعمود مباشرة من غير إعادة رسم (عشان المؤشر ما يضيعش)
document.addEventListener('input', e=>{
  const el = e.target;
  if(!el || !el.matches || !el.matches('[data-itemnote]')) return;
  quoteItemNotes[el.dataset.itemnote] = el.value;
  const sp = el.parentElement && el.parentElement.querySelector('.note-print');
  if(sp) sp.textContent = el.value.trim();
  const tbl = el.closest('table');
  if(tbl) tbl.classList.toggle('has-notes', Array.from(tbl.querySelectorAll('[data-itemnote]')).some(i=>i.value.trim()));
});
function inputSig(o){
  const notes = (o === state) ? cleanNotes() : (o && o.itemNotes) || {};
  return JSON.stringify([o.hp, o.panelIdx, o.structureType || 'FIXED', o.toggles || {}, o.specialDiscountAmt || 0, o.discountOverrideIdx == null ? null : o.discountOverrideIdx, notes, o.panelsPerStringAdjust || 0, o.stringsAdjust || 0, o.inverterPowerIncrease || 0]);
}
function phoneTail(v){ return String(v||'').replace(/\D/g,'').slice(-9); }
function currentQuoteKey(q){
  return JSON.stringify([state.hp, state.panelIdx, state.structureType, state.toggles, state.specialDiscountAmt, state.discountOverrideIdx, state.client, state.clientPhone, Math.round(q.finalTotal), cleanNotes(), state.panelsPerStringAdjust || 0, state.stringsAdjust || 0, state.inverterPowerIncrease || 0]);
}
function qlDisplay(q){
  if(savedQuoteInfo && savedQuoteInfo.key === currentQuoteKey(q)){
    return (savedQuoteInfo.ref ? savedQuoteInfo.ref + ' · ' : '') + (savedQuoteInfo.ql || buildQLCode(q));
  }
  return buildQLCode(q);
}
function refreshQlLines(q){
  document.querySelectorAll('.ql-line').forEach(el => { el.textContent = qlDisplay(q); });
}
function qlFileBase(q){
  const info = (savedQuoteInfo && savedQuoteInfo.key === currentQuoteKey(q)) ? savedQuoteInfo : null;
  const code = (info && info.ql) || buildQLCode(q);
  return (info && info.ref ? info.ref + '_' : '') + code;
}
const fmt1 = n => n.toLocaleString('en-US', {maximumFractionDigits:1});
const fmt2 = n => n.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});

/* ---- lead capture: central log (any rep, any device) + optional Google Sheet export ---- */
const LEADS_KEY = 'holoul_leads_v1'; // local convenience cache only, not the source of truth anymore
async function saveLead(q){
  // عرض اتحمّل للتعديل وطُبع/اتبعت من غير أي تغيير → ما نعملش مراجعة جديدة، نرجّع نفس الرمز المرجعي
  if(revisionParent && revisionParent.explicit && revisionParent.sig && revisionParent.phone === phoneTail(state.clientPhone)
     && revisionParent.sig === inputSig(state) && (revisionParent.total == null || revisionParent.total === Math.round(q.finalTotal))){
    savedQuoteInfo = { key: currentQuoteKey(q), ref: revisionParent.ref, ql: revisionParent.ql || null };
    refreshQlLines(q);
    return savedQuoteInfo;
  }
  const snapshot = {
    hp: state.hp, panelIdx: state.panelIdx,
    structureType: state.structureType, toggles: {...state.toggles}, specialDiscountAmt: state.specialDiscountAmt,
    discountOverrideIdx: state.discountOverrideIdx,
    // تعديلات الاسترنج/الانفرتر بتأثر على السعر — لازم تتحفظ عشان إعادة الحساب والتعديل من الـ CRM يطلعوا نفس السعر
    panelsPerStringAdjust: state.panelsPerStringAdjust || 0,
    stringsAdjust: state.stringsAdjust || 0,
    inverterPowerIncrease: state.inverterPowerIncrease || 0
  };
  { const n = cleanNotes(); if(Object.keys(n).length) snapshot.itemNotes = n; }
  if(revisionParent && revisionParent.phone === phoneTail(state.clientPhone) && (revisionParent.explicit || revisionParent.hp === state.hp)){
    snapshot.revisionOf = revisionParent.ref;
  }
  const sheetLead = {name:state.client, phone:state.clientPhone, hp:state.hp, total:Math.round(q.finalTotal), date:new Date().toISOString()};
  const leads = JSON.parse(localStorage.getItem(LEADS_KEY)||'[]');
  leads.unshift({...sheetLead, snapshot});
  localStorage.setItem(LEADS_KEY, JSON.stringify(leads.slice(0,500)));
  logLead(sheetLead);
  // نفس العرض بالظبط (نفس البيانات) ما بيتحفظش مرتين — بنرجّع الرمز المرجعي اللي اتحفظ
  const key = currentQuoteKey(q);
  if(savedQuoteInfo && savedQuoteInfo.key === key) return savedQuoteInfo;
  const res = await postSaveQuote({ clientName: state.client, clientPhone: state.clientPhone, hp: state.hp, finalTotal: Math.round(q.finalTotal), snapshot });
  if(res && res.ok){
    savedQuoteInfo = { key, ref: res.refCode || null, ql: res.qlCode || null };
    notifyParentQuoteSaved(res, state.clientPhone);
    if(res.refCode) revisionParent = { ref: res.refCode, phone: phoneTail(state.clientPhone), hp: state.hp, explicit: false };
    refreshQlLines(q);
    return savedQuoteInfo;
  }
  return null;
}

/* حفظ عرض على السيرفر بحسب اللي فاتح: أدمن (من الـ CRM) / مندوب / عميل مباشر.
   body: clientName, clientPhone, hp, finalTotal, snapshot */
async function postSaveQuote(body){
  try{
    if(typeof embedAdminToken !== 'undefined' && embedAdminToken){
      // أدمن فاتح الحاسبة من الـ CRM: لو السيرفر لسه ما يعرفش adminToken في save-quote نرجع لحفظ كـ guest
      let res = null;
      try{ res = await callEngine('save-quote', { adminToken: embedAdminToken, ...body }); }catch(e){ res = null; }
      if(!(res && res.ok)){
        try{ res = await callEngine('save-quote', { guest: true, ...body }); }catch(e){ res = null; }
      }
      return res;
    }
    if(repUsername && repTokenMem) return await callEngine('save-quote', { token: repTokenMem, ...body });
    if(guestMode) return await callEngine('save-quote', { guest: true, ...body });
  }catch(e){}
  return null;
}
function notifyParentQuoteSaved(res, phone){
  try{ if(window.parent && window.parent !== window) window.parent.postMessage({ type:'holoul-quote-saved', ref: (res && res.refCode) || null, ql: (res && res.qlCode) || null, phone: phone || '' }, location.origin); }catch(e){}
}
/* حفظ عرض أوف-جريد / أون-جريد (قبل كده الطباعة كانت بتحفظ عرض ضخ بالغلط) */
let savedSystemQuoteInfo = null;
function systemQuoteOf(kind){ return kind === 'offgrid' ? cachedOffgridQuote : (kind === 'ongrid' ? cachedOngridQuote : null); }
async function saveSystemQuote(kind){
  const q = systemQuoteOf(kind);
  if(!q || !Array.isArray(q.items)) return null;
  const notes = cleanNotes();
  const key = JSON.stringify([kind, Math.round(q.finalTotal), state.client, state.clientPhone, q.items.map(it=>[it.key||it.label, it.qty, it.on!==false]), notes]);
  if(savedSystemQuoteInfo && savedSystemQuoteInfo.key === key) return savedSystemQuoteInfo;
  const items = q.items.map(it=>({ key: it.key, label: it.label, on: it.on !== false, sell: it.sell == null ? null : it.sell, type: it.type, qty: it.qty, warranty: it.warranty }));
  const snapshot = {
    type: kind,
    frozenAt: new Date().toISOString(),
    frozenTotal: q.finalTotal,
    frozenItems: items.filter(it=>it.on).map(it=>({ label: it.label, sell: it.sell, qty: it.qty })),
    frozenQuote: {
      items, sellTotal: q.sellTotal, discountTotal: q.discountTotal, manualDiscountAmt: q.manualDiscountAmt,
      netAfterManual: q.netAfterManual, vat: q.vat, finalTotal: q.finalTotal,
      supplyOnlyTotal: q.supplyOnlyTotal, supplyPlusInstallTotal: q.supplyPlusInstallTotal,
      hp: null, panelLabel: '', invKW: q.invKW, invBrandName: q.invBrandName, totalPanels: q.totalPanels, calcKW: q.calcKW
    },
    engineInput: JSON.parse(JSON.stringify(kind === 'offgrid' ? buildOffgridInput() : buildOngridInput()))
  };
  if(Object.keys(notes).length) snapshot.itemNotes = notes;
  logLead({ name: state.client, phone: state.clientPhone, hp: null, total: Math.round(q.finalTotal), date: new Date().toISOString() });
  const res = await postSaveQuote({ clientName: state.client, clientPhone: state.clientPhone, hp: null, finalTotal: Math.round(q.finalTotal), snapshot });
  if(res && res.ok){
    savedSystemQuoteInfo = { key, ref: res.refCode || null };
    notifyParentQuoteSaved(res, state.clientPhone);
    return savedSystemQuoteInfo;
  }
  return null;
}

let prevLeadLookupSeq = 0;
let prevLeadLookupTimer = null;
let lastPrevMatches = [];
async function updatePrevLeadBox(){
  const box = document.getElementById('prevLeadBox');
  if(!box) return;
  const phone = (state.clientPhone||'').replace(/\D/g,'');
  if(phone.length<5){ box.style.display='none'; box.innerHTML=''; lastPrevMatches=[]; return; }
  if(!repUsername || !repTokenMem) return;
  const mySeq = ++prevLeadLookupSeq;
  let data;
  try{
    data = await callEngine('find-client', { token: repTokenMem, phone });
  }catch(e){ return; }
  if(mySeq !== prevLeadLookupSeq) return; // a newer keystroke already superseded this lookup
  const matches = (data.matches||[]).filter(m=>m.snapshot && m.snapshot.type!=='product-cart'); // عروض السلة ليها قائمتها الخاصة داخل صفحة عرض السلة
  lastPrevMatches = matches;
  if(!matches.length){ box.style.display='none'; box.innerHTML=''; return; }
  const latest = matches[0];
  const d = new Date(latest.created_at);
  box.style.display = 'block';
  box.style.cssText = 'display:block;margin-top:10px;background:#FFF8E8;border:1px solid #F0DDA6;border-radius:9px;padding:9px 11px;font-size:12px';
  box.innerHTML = `🕓 هذا الرقم مسجّل عليه ${matches.length} عرض${matches.length>1?'وض':''} سابق${matches.length>1?'ة':''} — آخرها بتاريخ ${d.toLocaleDateString('en-GB')} من <b>${latest.rep_display_name||'—'}</b><br>
    <button class="btn small" id="showPrevDetailsBtn" type="button" style="margin-top:6px">عرض التفاصيل الكاملة</button>
    <div id="prevLeadDetails" style="margin-top:8px;display:none"></div>`;
  document.getElementById('showPrevDetailsBtn').onclick = ()=>{
    const detailsBox = document.getElementById('prevLeadDetails');
    const showing = detailsBox.style.display==='block';
    if(showing){ detailsBox.style.display='none'; return; }
    detailsBox.style.display='block';
    detailsBox.innerHTML = lastPrevMatches.map((m,i)=>{
      const dd = new Date(m.created_at);
      return `<div style="border-top:1px solid #F0DDA6;padding-top:8px;margin-top:8px">
        <div><b>عرض بتاريخ ${dd.toLocaleDateString('en-GB')}</b> — المندوب: <b>${m.rep_display_name||'—'}</b></div>
        <div style="margin-top:4px;color:var(--muted)">القدرة: ${m.hp} حصان &nbsp;|&nbsp; اللوح: ${m.panelLabel} &nbsp;|&nbsp; الانفرتر: ${m.invBrandLabel} &nbsp;|&nbsp; الشاسيه: ${m.structureType}</div>
        <div style="margin-top:4px;font-weight:600">الإجمالي: ${fmt(m.final_total)} ﷼</div>
        <button class="btn small" data-loadprev="${i}" type="button" style="margin-top:6px">استخدم هذا السعر</button>
      </div>`;
    }).join('');
    detailsBox.querySelectorAll('[data-loadprev]').forEach(b=>{
      b.onclick = ()=>loadPrevLead(lastPrevMatches[+b.dataset.loadprev]);
    });
  };
}

function debouncedUpdatePrevLeadBox(){
  clearTimeout(prevLeadLookupTimer);
  prevLeadLookupTimer = setTimeout(updatePrevLeadBox, 450);
}

function loadPrevLead(lead){
  const s = lead.snapshot;
  if(!s){ alert('هذا العرض القديم لا يحتوي على بيانات كافية لإعادة استخدامه تلقائيًا.'); return; }
  revisionParent = s.refCode ? { ref: s.refCode, phone: phoneTail(state.clientPhone), hp: s.hp, explicit: true, sig: inputSig(s), ql: s.qlCode || null, total: (lead.final_total != null ? Math.round(Number(lead.final_total)) : null) } : null;
  state.hp = s.hp;
  state.panelIdx = s.panelIdx;
  state.structureType = s.structureType || 'FIXED';
  state.toggles = {...s.toggles};
  state.specialDiscountAmt = s.specialDiscountAmt || 0;
  state.panelsPerStringAdjust = s.panelsPerStringAdjust || 0;
  state.stringsAdjust = s.stringsAdjust || 0;
  state.inverterPowerIncrease = s.inverterPowerIncrease || 0;
  setQuoteNotes(s.itemNotes);
  if(discountUnlocked) state.discountOverrideIdx = s.discountOverrideIdx ?? null;
  refresh();
}
/* تحميل عرض مُمرَّر من الـ CRM (زر "تعديل (مراجعة جديدة)") — خيار إضافي، مسار الحاسبة العادي ما اتغيرش */
const CRM_EDIT_HANDOFF_KEY = 'holoul_crm_edit_handoff_v1';
function applyCrmEditHandoff(){
  let h = null;
  try{
    h = JSON.parse(localStorage.getItem(CRM_EDIT_HANDOFF_KEY)||'null');
    localStorage.removeItem(CRM_EDIT_HANDOFF_KEY); // استخدام مرة واحدة
  }catch(e){ h = null; }
  if(!h || !h.snapshot || !h.ts || Date.now() - h.ts > 2*60*1000) return false;
  const s = h.snapshot;
  if(s.hp == null || s.panelIdx == null || !s.toggles) return false;
  state.client = h.name || '';
  state.clientPhone = h.phone || '';
  state.hp = s.hp;
  state.panelIdx = s.panelIdx;
  state.structureType = s.structureType || 'FIXED';
  state.toggles = {...s.toggles};
  state.specialDiscountAmt = s.specialDiscountAmt || 0;
  state.panelsPerStringAdjust = s.panelsPerStringAdjust || 0;
  state.stringsAdjust = s.stringsAdjust || 0;
  state.inverterPowerIncrease = s.inverterPowerIncrease || 0;
  setQuoteNotes(s.itemNotes);
  if(typeof discountUnlocked !== 'undefined' && discountUnlocked) state.discountOverrideIdx = s.discountOverrideIdx ?? null;
  revisionParent = h.refCode ? { ref: h.refCode, phone: phoneTail(state.clientPhone), hp: s.hp, explicit: true, sig: inputSig(s), ql: h.qlCode || null, total: (h.total != null ? Math.round(Number(h.total)) : null) } : null;
  try{
    history.replaceState(null, '', location.pathname); // نشيل ?editquote=1 من الرابط
    const b = document.createElement('div');
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#0b6b3a;color:#fff;padding:9px 14px;text-align:center;font:600 13.5px Cairo,sans-serif;direction:rtl;cursor:pointer;';
    b.textContent = '✏️ تم تحميل عرض ' + (h.refCode || '') + ' للعميل ' + (h.name || h.phone || '') + ' للتعديل — أي طباعة أو حفظ بعد التعديل هيتسجل كمراجعة جديدة (اضغط لإخفاء)';
    b.onclick = ()=>b.remove();
    document.addEventListener('DOMContentLoaded', ()=>document.body.appendChild(b));
    if(document.body) document.body.appendChild(b);
    setTimeout(()=>b.remove(), 12000);
  }catch(e){}
  return true;
}
// الهاتف إجباري وصحيح (٩ أرقام على الأقل، ومش أصفار)، والاسم اختياري.
function isValidClientPhone(p){
  const d = String(p||'').replace(/\D/g,'');
  return d.length >= 9 && !/^0+$/.test(d);
}
function validateClient(){
  if(!isValidClientPhone(state.clientPhone)){
    alert('من فضلك أدخل رقم هاتف العميل بشكل صحيح (05xxxxxxxx) — الاسم اختياري');
    return false;
  }
  return true;
}
async function handlePrint(){
  if(!validateClient()) return;
  const sys = (currentView === 'calc' && (state.calcSystem === 'offgrid' || state.calcSystem === 'ongrid')) ? state.calcSystem : null;
  const q = sys ? systemQuoteOf(sys) : currentQuote();
  if(!q){ alert('العرض لسه بيتحسب — جرّب بعد ثانية'); return; }
  // ننتظر الحفظ (بحد أقصى 3 ثواني) علشان الرمز المرجعي يظهر على العرض المطبوع
  await Promise.race([sys ? saveSystemQuote(sys) : saveLead(q), new Promise(r=>setTimeout(()=>r(null), 3000))]);
  const originalTitle = document.title;
  document.title = (sys ? ('عرض-سعر-'+(sys==='offgrid'?'اوف-جريد':'اون-جريد')+'-'+(state.client||state.clientPhone)) : qlFileBase(q)).replace(/[\/\\?%*:|"<>]/g,'-');
  window.print();
  setTimeout(()=>{ document.title = originalTitle; }, 1000);
}
function sendLeadWhatsapp(){
  if(!validateClient()) return;
  const q = currentQuote();
  saveLead(q);
  const msg = `طلب عرض سعر جديد${state.client ? '\nالعميل: '+state.client : ''}\nالهاتف: ${state.clientPhone}\nالقدرة: ${state.hp} حصان (${fmt1(q.calcKW)} KW)\nالسعر النهائي: ${fmt(q.finalTotal)} ﷼`;
  window.open('https://wa.me/'+companyWaNumber()+'?text='+encodeURIComponent(msg), '_blank');
}

function normalizePhone(phone){
  let p = phone.replace(/[^\d]/g,'');
  if(p.startsWith('00')) p = p.slice(2);
  if(p.startsWith('0')) p = '966'+p.slice(1);
  else if(p.length===9 && !p.startsWith('966')) p = '966'+p;
  return p;
}

// html2pdf.js clones the element AGAIN internally before rendering it
// (a documented bug in the library). That second, detached clone can fail
// to resolve CSS custom properties (var(--ink), var(--card), var(--line)...)
// which this app uses everywhere for colors — the result would be borders
// showing up while all text/fills come out white/blank. To avoid this
// entirely, and to avoid the internal re-clone breaking Arabic RTL/bidi
// text (fused words, scrambled digits), we bypass html2pdf.js and use
// html2canvas + jsPDF directly on our OWN clone, which stays attached to
// the live document (correct dir="rtl", fonts, styles) the whole time.

// "Flatten" every resolved color onto the clone as a literal inline style
// (e.g. color:rgb(21,42,56)) BEFORE capture, so there is no var() left
// that anything could fail to resolve.
const FLATTEN_PROPS = [
  'color','backgroundColor',
  'borderTopColor','borderRightColor','borderBottomColor','borderLeftColor'
];
function flattenComputedColors(liveRoot, cloneRoot){
  const liveEls = [liveRoot, ...liveRoot.querySelectorAll('*')];
  const cloneEls = [cloneRoot, ...cloneRoot.querySelectorAll('*')];
  liveEls.forEach((liveEl, i)=>{
    const cloneEl = cloneEls[i];
    if(!cloneEl) return;
    const cs = getComputedStyle(liveEl);
    FLATTEN_PROPS.forEach(prop=>{ cloneEl.style[prop] = cs[prop]; });
  });
}

// Picks a safe html2canvas scale per device. Mobile/tablet browsers
// (especially iOS Safari and in-app webviews like WhatsApp) silently
// return a BLANK canvas when the rendered pixel area is too large, so we
// cap the scale more conservatively there than on desktop/laptop.
function getCaptureScale(){
  const ua = navigator.userAgent || '';
  const isTablet = /iPad|Tablet/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const isMobile = /iPhone|iPod|Android/i.test(ua) && !isTablet;
  const dpr = window.devicePixelRatio || 1;
  if(isMobile) return Math.max(1, Math.min(dpr, 1.5));
  if(isTablet) return Math.max(1, Math.min(dpr, 1.75));
  return Math.max(1, Math.min(dpr, 2)) || 2;
}

async function downloadQuotePdf(filename){
  const src = document.getElementById('quotePrintArea');
  if(!src || typeof html2canvas==='undefined') return false;
  const clone = src.cloneNode(true);

  // Flatten colors BEFORE removing .no-print nodes, so the live/clone
  // element lists still line up 1:1 in the same order.
  flattenComputedColors(src, clone);
  clone.querySelectorAll('.no-print').forEach(el=>el.remove());
  // Use the exact same compact layout/typography as the browser's own
  // Print/Save-as-PDF (@media print), so both outputs look identical.
  clone.classList.add('pdf-compact');

  const CAPTURE_WIDTH = 760;
  clone.style.maxWidth = CAPTURE_WIDTH+'px';
  clone.style.width = CAPTURE_WIDTH+'px';
  clone.style.backgroundColor = '#ffffff';
  // Force the correct text direction/language explicitly on the clone
  // itself, since it's what keeps Arabic word-joining and bidi digit
  // order correct.
  clone.setAttribute('dir','rtl');
  clone.setAttribute('lang','ar');

  // IMPORTANT: keep the clone inside the viewport's coordinate space
  // (top:0; left:0) instead of pushing it far off-screen (e.g. left:-9999px).
  // Many mobile/tablet browsers (iOS Safari, Chrome/WhatsApp webviews) skip
  // painting fixed-position content placed outside the visible viewport
  // bounds, which produces a fully white/blank PDF. Using a very low
  // z-index keeps it invisible behind the real page instead.
  const wrapper = document.createElement('div');
  wrapper.setAttribute('dir','rtl');
  wrapper.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'z-index:-9999',
    'pointer-events:none',
    'background:#fff',
    'padding:14px',
    `width:${CAPTURE_WIDTH+28}px`,
    'overflow:visible'
  ].join(';');
  wrapper.appendChild(clone);
  document.body.appendChild(wrapper);

  // Give mobile browsers a couple of frames to actually lay out and paint
  // the clone before html2canvas snapshots it (fixes intermittent blanks
  // on phones/tablets where layout isn't ready on the very next tick).
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));

  try{
    const canvas = await html2canvas(clone, {
      scale: getCaptureScale(),
      useCORS: true,
      backgroundColor: '#ffffff',
      windowWidth: CAPTURE_WIDTH+28,
      windowHeight: Math.max(wrapper.scrollHeight, clone.scrollHeight)
    });

    const JsPdfCtor = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if(!JsPdfCtor) throw new Error('jsPDF not available');

    // Build the PDF ourselves so we can force everything onto ONE A4 page
    // (shrink-to-fit) instead of letting content spill onto a second page.
    const pdf = new JsPdfCtor({unit:'mm', format:'a4', orientation:'portrait'});
    const pageW = 210, pageH = 297, margin = 8;
    const usableW = pageW - margin*2, usableH = pageH - margin*2;
    // PNG (lossless) instead of JPEG: avoids compression artifacts around
    // small text/numbers in the pricing table, which is what matters most
    // here — a client must be able to read every figure without ambiguity.
    const imgData = canvas.toDataURL('image/png');
    const imgRatio = canvas.height / canvas.width;

    let drawW = usableW;
    let drawH = drawW * imgRatio;
    if(drawH > usableH){
      // Content is taller than one page at full width — shrink further so
      // the whole thing still fits within a single A4 page.
      drawH = usableH;
      drawW = drawH / imgRatio;
    }
    const x = margin + (usableW - drawW)/2;
    const y = margin + (usableH - drawH)/2;

    pdf.addImage(imgData, 'PNG', x, y, drawW, drawH);
    pdf.save(filename);
    return true;
  }catch(err){
    console.error('PDF generation failed', err);
    return false;
  }finally{
    document.body.removeChild(wrapper);
  }
}

async function sendQuoteToClientWhatsapp(){
  if(!validateClient()) return;
  const q = currentQuote();
  await Promise.race([saveLead(q), new Promise(r=>setTimeout(()=>r(null), 3000))]);
  const phone = normalizePhone(state.clientPhone);
  if(phone.length<11){ alert('رقم هاتف العميل غير صحيح — تأكد إنه بالصيغة الصحيحة (05xxxxxxxx)'); return; }
  const filename = qlFileBase(q).replace(/[^A-Za-z0-9\-_]/g,'') + '.pdf';
  const ok = await downloadQuotePdf(filename);
  const msg = ok
    ? `${companyShort()} — ${companyBrand()}\n\nمرفق لكم عرض السعر (PDF) — تم تنزيله على هذا الجهاز باسم "${filename}"، الرجاء إرفاقه في هذه المحادثة 📎\n\nملخص العرض:${state.client ? '\nالعميل: '+state.client : ''}\nالقدرة: ${state.hp} حصان (${fmt1(q.calcKW)} KW)\nالسعر النهائي شامل ضريبة القيمة المضافة: ${fmt(q.finalTotal)} ﷼\n\nللتواصل: 966561274344+`
    : `${companyShort()} — ${companyBrand()}\n\nعرض سعر منظومة طاقة شمسية${state.client ? '\nالعميل: '+state.client : ''}\nالقدرة: ${state.hp} حصان (${fmt1(q.calcKW)} KW)\nالسعر النهائي شامل ضريبة القيمة المضافة: ${fmt(q.finalTotal)} ﷼\n\nللتواصل: 966561274344+`;
  setTimeout(()=>window.open('https://wa.me/'+phone+'?text='+encodeURIComponent(msg), '_blank'), ok?600:0);
}


