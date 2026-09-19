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
    dailyKwh: 10,
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
function buildQLCode(q){
  const d = new Date();
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dateStr = String(d.getDate()).padStart(2,'0')+months[d.getMonth()]+d.getFullYear();
  const panel = cachedPanelOptions.find(p=>p.idx===state.panelIdx) || {brand:'',power:''};
  return `QL-${dateStr}-P-${state.hp} HP-${q.invBrandName||'VEICHI'} ${q.invKW} KW-${panel.brand}${panel.power}-${state.structureType}-`;
}
const fmt1 = n => n.toLocaleString('en-US', {maximumFractionDigits:1});
const fmt2 = n => n.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});

/* ---- lead capture: central log (any rep, any device) + optional Google Sheet export ---- */
const LEADS_KEY = 'holoul_leads_v1'; // local convenience cache only, not the source of truth anymore
function saveLead(q){
  const snapshot = {
    hp: state.hp, panelIdx: state.panelIdx,
    structureType: state.structureType, toggles: {...state.toggles}, specialDiscountAmt: state.specialDiscountAmt,
    discountOverrideIdx: state.discountOverrideIdx
  };
  const sheetLead = {name:state.client, phone:state.clientPhone, hp:state.hp, total:Math.round(q.finalTotal), date:new Date().toISOString()};
  const leads = JSON.parse(localStorage.getItem(LEADS_KEY)||'[]');
  leads.unshift({...sheetLead, snapshot});
  localStorage.setItem(LEADS_KEY, JSON.stringify(leads.slice(0,500)));
  logLead(sheetLead);
  if(repUsername && repTokenMem){
    callEngine('save-quote', {
      token: repTokenMem,
      clientName: state.client, clientPhone: state.clientPhone,
      hp: state.hp, finalTotal: Math.round(q.finalTotal), snapshot
    }).catch(()=>{});
  } else if(guestMode){
    callEngine('save-quote', {
      guest: true,
      clientName: state.client, clientPhone: state.clientPhone,
      hp: state.hp, finalTotal: Math.round(q.finalTotal), snapshot
    }).catch(()=>{});
  }
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
  const matches = (data.matches||[]).filter(m=>m.snapshot);
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
  state.hp = s.hp;
  state.panelIdx = s.panelIdx;
  state.structureType = s.structureType || 'FIXED';
  state.toggles = {...s.toggles};
  state.specialDiscountAmt = s.specialDiscountAmt || 0;
  if(discountUnlocked) state.discountOverrideIdx = s.discountOverrideIdx ?? null;
  refresh();
}
function validateClient(){
  if(!state.client.trim() || !state.clientPhone.trim()){
    alert('من فضلك أدخل اسم العميل ورقم الهاتف أولًا');
    return false;
  }
  return true;
}
function handlePrint(){
  if(!validateClient()) return;
  const q = currentQuote();
  saveLead(q);
  const originalTitle = document.title;
  document.title = buildQLCode(q).replace(/[\/\\?%*:|"<>]/g,'-');
  window.print();
  setTimeout(()=>{ document.title = originalTitle; }, 1000);
}
function sendLeadWhatsapp(){
  if(!validateClient()) return;
  const q = currentQuote();
  saveLead(q);
  const msg = `طلب عرض سعر جديد\nالعميل: ${state.client}\nالهاتف: ${state.clientPhone}\nالقدرة: ${state.hp} حصان (${fmt1(q.calcKW)} KW)\nالسعر النهائي: ${fmt(q.finalTotal)} ﷼`;
  window.open('https://wa.me/966561274344?text='+encodeURIComponent(msg), '_blank');
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
  saveLead(q);
  const phone = normalizePhone(state.clientPhone);
  if(phone.length<11){ alert('رقم هاتف العميل غير صحيح — تأكد إنه بالصيغة الصحيحة (05xxxxxxxx)'); return; }
  const filename = buildQLCode(q).replace(/[^A-Za-z0-9\-]/g,'') + '.pdf';
  const ok = await downloadQuotePdf(filename);
  const msg = ok
    ? `حلول الطاقة المتجددة والمقاولات — HoloulEnergy\n\nمرفق لكم عرض السعر (PDF) — تم تنزيله على هذا الجهاز باسم "${filename}"، الرجاء إرفاقه في هذه المحادثة 📎\n\nملخص العرض:\nالعميل: ${state.client}\nالقدرة: ${state.hp} حصان (${fmt1(q.calcKW)} KW)\nالسعر النهائي شامل ضريبة القيمة المضافة: ${fmt(q.finalTotal)} ﷼\n\nللتواصل: 966561274344+`
    : `حلول الطاقة المتجددة والمقاولات — HoloulEnergy\n\nعرض سعر منظومة طاقة شمسية\nالعميل: ${state.client}\nالقدرة: ${state.hp} حصان (${fmt1(q.calcKW)} KW)\nالسعر النهائي شامل ضريبة القيمة المضافة: ${fmt(q.finalTotal)} ﷼\n\nللتواصل: 966561274344+`;
  setTimeout(()=>window.open('https://wa.me/'+phone+'?text='+encodeURIComponent(msg), '_blank'), ok?600:0);
}


