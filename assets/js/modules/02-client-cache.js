/* =======================================================================
   2) CLIENT-SIDE CACHE — populated by refreshQuote(); never holds cost/margin
   ======================================================================= */
let cachedQuote = null;       // public quote (sell prices only)
let cachedFeas = null;        // general feasibility-study assumptions (non-sensitive)
let cachedBomItemImages = {}; // admin-managed fallback images for generic BOM line items (by item key)
let cachedPanelOptions = [];  // [{brand,power}] — never priceW
let cachedBatteryVoltageOptions = []; // [12.8, 25.6, 51.2, ...] distinct voltages in the battery catalog
let cachedBatteryModelOptions = []; // [{model,brand,voltage,stdVoltage,ah,kwh}, ...] exact battery models from the catalog
let cachedInverterModelOptions = []; // [{model,brand,kw,voltageClasses}, ...] exact hybrid/off-grid inverter models from the catalog
let cachedOffgridAppliancePresets = []; // admin-editable load picker list from the server — falls back to OFFGRID_APPLIANCE_PRESETS below until it arrives

// Admin-configured defaults (D.defaultPanelKey "brand|power")
// applied once per calculator on first successful load, so a rep's manual
// re-selection afterwards is never silently overridden.
let mainDefaultsApplied = false, offgridDefaultsApplied = false, ongridDefaultsApplied = false;
function resolvePanelIdxByKey(options, key){
  if(!key || !options || !options.length) return null;
  const m = options.find(p => `${p.brand}|${p.power}` === key);
  return m ? m.idx : null;
}
let cachedProductCatalog = null; // fetched lazily when the products tab opens
let productCatalogLoading = false;
let productCatalogError = null;
let cachedPanelsPublic = null; // [{brand,power,datasheetUrl,...}] — fetched once, used to show the datasheet link in quotes/offers
let panelsPublicLoading = false;
async function ensurePanelsPublicLoaded(){
  if(cachedPanelsPublic || panelsPublicLoading) return;
  panelsPublicLoading = true;
  try{
    const data = await callEngine('get-panels-public', {});
    cachedPanelsPublic = data.panels || [];
  }catch(e){ cachedPanelsPublic = []; }
  panelsPublicLoading = false;
  render();
}
// Datasheet link for a given panel brand/power, e.g. for the currently selected
// panel in a quote/offer. Returns '' if no datasheet has been set for it.
// Real product photo for a BOM line item if the server resolved one (panel,
// or a specific catalog-backed inverter/battery in offgrid/ongrid); otherwise
// an admin-managed generic photo for that item type (cables, structure...);
// otherwise blank — left for the admin to add later rather than guessing.
function itemImage(it){
  return it.image || cachedBomItemImages[it.key] || '';
}
function bomRowThumb(it){
  const url = itemImage(it);
  return url ? `<img src="${url}" alt="${it.label}" loading="lazy">` : `<div class="noimg">📦</div>`;
}

function panelDatasheetUrl(brand, power){
  if(!cachedPanelsPublic){ ensurePanelsPublicLoaded(); return ''; }
  const match = cachedPanelsPublic.find(p => p.brand===brand && +p.power===+power);
  return (match && match.datasheetUrl) || '';
}
// Small inline "📄 الداتا شيت" link for a BOM/offer panel row, given brand+power.
function panelDatasheetLink(brand, power){
  const url = panelDatasheetUrl(brand, power);
  return url ? ` <a href="${url}" target="_blank" rel="noopener" class="no-print" style="font-size:11px">📄 الداتا شيت</a>` : '';
}
// Same, but resolves brand/power from a cachedPanelOptions index (as used by
// the custom "calc" flow, which stores state.panelIdx rather than brand/power).
function panelDatasheetLinkForIdx(panelIdx){
  const opt = cachedPanelOptions.find(p => p.idx === panelIdx);
  return opt ? panelDatasheetLink(opt.brand, opt.power) : '';
}

let cachedReadySystems = null; // fetched lazily when the ready-systems tab opens
let readySystemsLoading = false;
let readySystemsError = null;
let adminFinancials = null;   // cost/margin breakdown — only after admin auth
let adminConfig = null;       // full rates object — only after admin auth
let adminReps = [];           // rep accounts — only after admin auth
let adminTokenMem = null;     // short-lived session token; held in memory only, lost on page reload
let currentAdminSection = 'overview'; // which sidebar section is showing inside the admin panel
let discountFormState = { category:'', brand:'', supplierDiscountPct:0, sellDiscountPct:0, promoDiscountPct:0, promoActive:false, editKey:null };
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escAttr(s){ return esc(s).replace(/"/g,'&quot;'); }

// Small "ⓘ" icon that reveals a guidance/tip message in a popover on click,
// instead of showing it as an always-visible .note block. `html` may contain
// markup (it is NOT escaped) — callers pass already-built note content.
let infoIconSeq = 0;
function infoIcon(html, label){
  const id = 'infoicon' + (++infoIconSeq);
  return `<span class="info-icon-wrap" id="${id}">
    <button type="button" class="info-icon-btn" aria-label="${escAttr(label||'معلومة')}" onclick="toggleInfoIcon('${id}', event)">ⓘ</button>
    <span class="info-icon-pop">${html}</span>
  </span>`;
}
function toggleInfoIcon(id, ev){
  if(ev) ev.stopPropagation();
  const el = document.getElementById(id);
  if(!el) return;
  const wasOpen = el.classList.contains('open');
  document.querySelectorAll('.info-icon-wrap.open').forEach(w=>w.classList.remove('open'));
  if(!wasOpen) el.classList.add('open');
}
document.addEventListener('click', (e)=>{
  if(e.target.closest && e.target.closest('.info-icon-wrap')) return;
  document.querySelectorAll('.info-icon-wrap.open').forEach(w=>w.classList.remove('open'));
});

// Every (category, brand) pair that exists in the product catalog right now,
// derived from productDetails[i].brand on each row. Used to populate the
// dropdowns in the "الخصومات" admin section.
function getCatalogBrandOptions(cfg){
  const byCategory = {};
  (cfg.productCatalog||[]).forEach(cat=>{
    const brands = new Set();
    (cat.rows||[]).forEach((r,idx)=>{
      const b = (cat.productDetails && cat.productDetails[String(idx)] && cat.productDetails[String(idx)].brand) || '';
      if(b) brands.add(b);
    });
    if(brands.size) byCategory[cat.category] = Array.from(brands).sort();
  });
  // Solar panels live in cfg.panels (a separate list, not productCatalog),
  // but they go through the same discount registry as every other product
  // — so their brands must show up here too, under a fixed category name
  // that matches exactly what the backend uses (findDiscount / panelPricing).
  const panelBrands = new Set();
  (cfg.panels||[]).forEach(p=>{ if(p.brand) panelBrands.add(p.brand); });
  if(panelBrands.size) byCategory['الألواح الشمسية'] = Array.from(panelBrands).sort();
  return byCategory;
}
let currentAdminSubSection = { products:'catalog', calcs:'pump' }; // secondary in-page sidebar for long sections
let engineError = null;
let quoteLoading = false;

// Off-grid / on-grid calculators — same cache pattern as the irrigation quote above
let cachedOffgridQuote = null, offgridEngineError = null, offgridLoading = false, adminFinancialsOffgrid = null;
let offgridAppliancesSeeded = false; // replaces the 1-item hardcoded default with D.offgrid.applianceDefaults on first successful load
// The load profile (appliances list / direct kWh, method, autonomy days) is
// edited freely without hitting the pricing engine on every keystroke — the
// engine (inverter/battery/panel sizing + BOM + price) only recalculates
// when the person explicitly presses "تأكيد ملف الأحمال". This flag tracks
// whether the currently-displayed calculation still matches what's typed.
let offgridLoadsConfirmed = true;
function computeLocalDailyKwh(appliances){
  return (appliances||[]).reduce((s,a)=>{
    const hrs = (+a.dayHours||0) + (+a.nightHours||0);
    return s + ((+a.watts||0) * hrs * (+a.qty||1))/1000;
  }, 0);
}
let cachedOngridQuote = null, ongridEngineError = null, ongridLoading = false, adminFinancialsOngrid = null;

function buildEngineInput(){
  return {
    panelIdx: state.panelIdx,
    hp: state.hp,
    structureType: 'FIXED',
    discountTierIdx: discountUnlocked ? state.discountOverrideIdx : null,
    specialDiscountAmt: state.specialDiscountAmt,
    panelsPerStringAdjust: state.panelsPerStringAdjust,
    stringsAdjust: state.stringsAdjust,
    inverterPowerIncrease: state.inverterPowerIncrease,
    toggles: state.toggles
  };
}

async function refreshQuote(){
  engineError = null;
  const input = buildEngineInput();
  // Run the public quote and (if needed) the admin financials call in
  // parallel instead of one-after-the-other — halves the wait when the
  // admin panel is open, since both round-trips happen at the same time.
  const quotePromise = callEngine('quote', { input });
  const adminPromise = (adminInfoUnlocked && adminTokenMem)
    ? callEngine('admin-view', { adminToken: adminTokenMem, input }).catch(()=>{ adminInfoUnlocked = false; return null; })
    : Promise.resolve(null);
  try{
    const [data, adminData] = await Promise.all([quotePromise, adminPromise]);
    cachedQuote = data.quote;
    cachedFeas = data.feas;
    cachedPanelOptions = data.panelOptions;
    cachedBomItemImages = data.bomItemImages || cachedBomItemImages;
    adminFinancials = adminData ? adminData.quote : null;
    let needsRetry = false;
    if(!mainDefaultsApplied){
      mainDefaultsApplied = true;
      const defPanelIdx = resolvePanelIdxByKey(cachedPanelOptions, data.defaultPanelKey);
      if(defPanelIdx !== null){ state.panelIdx = defPanelIdx; needsRetry = true; }
    }
    if(!cachedPanelOptions.some(p=>p.idx===state.panelIdx) && cachedPanelOptions.length){
      state.panelIdx = cachedPanelOptions[0].idx; needsRetry = true;
    }
    if(needsRetry){
      const retryData = await callEngine('quote', { input: buildEngineInput() });
      cachedQuote = retryData.quote;
    }
  }catch(e){
    engineError = e.message || 'تعذر الاتصال بالخادم';
  }
}

function buildOffgridInput(){
  const o = state.offgrid;
  return {
    panelIdx: o.panelIdx,
    method: o.method,
    dailyKwh: +o.dailyKwh || 0,
    autonomyDays: +o.autonomyDays || 0,
    appliances: o.appliances,
    inverterModel: o.inverterModel || null,
    batteryVoltage: o.batteryVoltage || null,
    batteryBrand: o.batteryBrand || null,
    batteryModel: o.batteryModel || null,
    qtyOverrides: o.qtyOverrides || {},
    toggles: o.toggles || {},
    discountTierIdx: discountUnlocked ? state.discountOverrideIdx : null,
    specialDiscountAmt: state.specialDiscountAmt,
  };
}
async function refreshOffgridQuote(){
  offgridEngineError = null;
  try{
    const input = buildOffgridInput();
    const quotePromise = callEngine('offgrid-quote', { input });
    const adminPromise = (adminInfoUnlocked && adminTokenMem)
      ? callEngine('offgrid-admin-view', { adminToken: adminTokenMem, input }).catch(()=>null)
      : Promise.resolve(null);
    const [data, adminData] = await Promise.all([quotePromise, adminPromise]);
    cachedOffgridQuote = data.quote;
    offgridLoadsConfirmed = true;
    if(!offgridAppliancesSeeded && Array.isArray(data.applianceDefaults) && data.applianceDefaults.length){
      offgridAppliancesSeeded = true;
      // Only replace the placeholder single-item list, never something the rep already edited.
      if(state.offgrid.appliances.length===1 && state.offgrid.appliances[0].name==='ثلاجة' && state.offgrid.appliances[0].watts===150){
        state.offgrid.appliances = data.applianceDefaults.map(a=>({...a}));
      }
    }
    if(data.panelOptions && data.panelOptions.length && !offgridDefaultsApplied){
      offgridDefaultsApplied = true;
      const defPanelIdx = resolvePanelIdxByKey(data.panelOptions, data.defaultPanelKey);
      if(defPanelIdx !== null) state.offgrid.panelIdx = defPanelIdx;
    }
    if(data.panelOptions && data.panelOptions.length && !data.panelOptions.some(p=>p.idx===state.offgrid.panelIdx)){
      state.offgrid.panelIdx = data.panelOptions[0].idx;
    }
    cachedPanelOptions = data.panelOptions || cachedPanelOptions;
    cachedBomItemImages = data.bomItemImages || cachedBomItemImages;
    cachedInverterModelOptions = data.inverterModelOptions || cachedInverterModelOptions;
    cachedOffgridAppliancePresets = (data.appliancePresets && data.appliancePresets.length) ? data.appliancePresets : cachedOffgridAppliancePresets;
    if(state.offgrid.inverterModel && !cachedInverterModelOptions.some(m=>m.model===state.offgrid.inverterModel)){
      // the previously-picked exact model no longer exists in the catalog (e.g. admin removed/renamed it) — fall back to auto
      state.offgrid.inverterModel = null;
    }
    cachedBatteryVoltageOptions = data.batteryVoltageOptions || cachedBatteryVoltageOptions;
    if(!state.offgrid.batteryVoltage && cachedBatteryVoltageOptions.length){
      // default to the highest voltage (the "full bus" module) so no series-stacking is needed unless the rep changes it
      state.offgrid.batteryVoltage = Math.max(...cachedBatteryVoltageOptions);
    }
    cachedBatteryModelOptions = data.batteryModelOptions || cachedBatteryModelOptions;
    if(state.offgrid.batteryModel && !cachedBatteryModelOptions.some(m=>m.model===state.offgrid.batteryModel)){
      // the previously-picked exact model no longer exists in the catalog (e.g. admin removed/renamed it) — fall back to auto
      state.offgrid.batteryModel = null;
    }
    // The auto-picked inverter (sized to the current registered loads) only
    // supports specific battery voltage classes (see getInverterVoltageClasses
    // server-side) — e.g. a tiny inverter may be 12V-only, a bigger one
    // 24/48V. As loads change, the auto-picked inverter can change too, so
    // a previously-valid battery voltage/brand/model choice can silently
    // become incompatible. Snap back to a compatible choice immediately
    // rather than letting the person pick something the backend would
    // reject or silently override.
    const invVoltClasses = (data.quote && Array.isArray(data.quote.invVoltageClasses)) ? data.quote.invVoltageClasses : null;
    if(invVoltClasses && invVoltClasses.length && !invVoltClasses.includes(state.offgrid.batteryVoltage)){
      state.offgrid.batteryVoltage = invVoltClasses.includes(48) ? 48 : Math.max(...invVoltClasses);
      if(state.offgrid.batteryBrand && !cachedBatteryModelOptions.some(m=>m.stdVoltage===state.offgrid.batteryVoltage && m.brand===state.offgrid.batteryBrand)){
        state.offgrid.batteryBrand = '';
      }
      if(state.offgrid.batteryModel && !cachedBatteryModelOptions.some(m=>m.model===state.offgrid.batteryModel && m.stdVoltage===state.offgrid.batteryVoltage)){
        state.offgrid.batteryModel = null;
      }
    }
    adminFinancialsOffgrid = adminData ? adminData.quote : null;
  }catch(e){
    offgridEngineError = e.message || 'تعذر الاتصال بالخادم';
  }
}

function buildOngridInput(){
  const n = state.ongrid;
  return {
    panelIdx: n.panelIdx,
    method: n.method,
    billSar: +n.billSar || 0,
    monthlyKwh: +n.monthlyKwh || 0,
    systemKw: +n.systemKw || 0,
    discountTierIdx: discountUnlocked ? state.discountOverrideIdx : null,
    specialDiscountAmt: state.specialDiscountAmt,
  };
}
async function refreshOngridQuote(){
  ongridEngineError = null;
  try{
    const input = buildOngridInput();
    const quotePromise = callEngine('ongrid-quote', { input });
    const adminPromise = (adminInfoUnlocked && adminTokenMem)
      ? callEngine('ongrid-admin-view', { adminToken: adminTokenMem, input }).catch(()=>null)
      : Promise.resolve(null);
    const [data, adminData] = await Promise.all([quotePromise, adminPromise]);
    cachedOngridQuote = data.quote;
    if(data.panelOptions && data.panelOptions.length && !ongridDefaultsApplied){
      ongridDefaultsApplied = true;
      const defPanelIdx = resolvePanelIdxByKey(data.panelOptions, data.defaultPanelKey);
      if(defPanelIdx !== null) state.ongrid.panelIdx = defPanelIdx;
    }
    if(data.panelOptions && data.panelOptions.length && !data.panelOptions.some(p=>p.idx===state.ongrid.panelIdx)){
      state.ongrid.panelIdx = data.panelOptions[0].idx;
    }
    cachedPanelOptions = data.panelOptions || cachedPanelOptions;
    cachedBomItemImages = data.bomItemImages || cachedBomItemImages;
    adminFinancialsOngrid = adminData ? adminData.quote : null;
  }catch(e){
    ongridEngineError = e.message || 'تعذر الاتصال بالخادم';
  }
}

// ---- "مواتير الري بالطاقة الشمسية" — quick tab inside قائمة المنتجات.
// Deliberately calls the SAME 'quote' engine action as the main حاسبة (buildEngineInput/refreshQuote
// above), with the toggle preset locked to "توريد خامات فقط" (panel+inverter+combiner+cables+mc4 only,
// matching the existing [data-preset="materials"] button in the main calculator). This guarantees the
// price shown here is always identical to what the main calculator shows for the same HP + "توريد فقط".
const IQ_STD_HP = [10,15,20,25,30,40,50,60,75,100,125,150,175,200,250,300,350,400,450,500,600,700];
let iqHp = 10;
let iqPanelIdx = 0;
let iqDefaultsApplied = false;
let iqQuote = null;
let iqLoading = false;
let iqError = null;
function buildIrrigationQuickInput(){
  return {
    panelIdx: iqPanelIdx,
    hp: iqHp,
    structureType: 'FIXED',
    discountTierIdx: null,
    specialDiscountAmt: 0,
    panelsPerStringAdjust: 0,
    stringsAdjust: 0,
    inverterPowerIncrease: 0,
    toggles: {panel:true, inverter:true, ip65:false, combiner:true, cables:true, mc4:true,
              structure:false, concrete:false, earth:false, reactor:false, civilworks:false, elecworks:false, supply:false}
  };
}
async function refreshIrrigationQuick(){
  iqError = null; iqLoading = true; render();
  try{
    const data = await callEngine('quote', { input: buildIrrigationQuickInput() });
    iqQuote = data.quote;
    let needsRetry = false;
    if(!iqDefaultsApplied){
      iqDefaultsApplied = true;
      const defIdx = resolvePanelIdxByKey(data.panelOptions, data.defaultPanelKey);
      if(defIdx !== null && defIdx !== iqPanelIdx){ iqPanelIdx = defIdx; needsRetry = true; }
    }
    if(data.panelOptions && data.panelOptions.length && !data.panelOptions.some(p=>p.idx===iqPanelIdx)){
      iqPanelIdx = data.panelOptions[0].idx; needsRetry = true;
    }
    if(needsRetry){
      const retryData = await callEngine('quote', { input: buildIrrigationQuickInput() });
      iqQuote = retryData.quote;
    }
  }catch(e){
    iqError = e.message || 'تعذر الاتصال بالخادم';
  }
  iqLoading = false; render();
}
// BOM qty strings come wrapped as "#20#" (a print-layout convention elsewhere
// in the app) or as a longer note like "150 متر (تقريبي...)" for cables —
// strip the markers and keep only the short headline figure for the spec card.
function iqCleanQty(qty){
  return String(qty||'').replace(/#/g,'').split('(')[0].trim();
}
function renderIrrigationQuick(){
  if(!iqQuote && !iqLoading && !iqError) refreshIrrigationQuick();
  const q = iqQuote;
  const items = q ? q.items.filter(it=>it.on) : [];
  return `
  <div class="crumbs" style="margin-bottom:var(--sp-2)">
    <button id="iqBackToProductsBtn">قائمة المنتجات</button>
    <span class="sep">/</span>
    <span class="current">مواتير الري بالطاقة الشمسية</span>
  </div>
  <div class="detail-split">
    <div>
      <div class="card">
        <div class="detail-cat-badge">توريد خامات فقط</div>
        <h3>مواتير الري بالطاقة الشمسية</h3>
        <div class="note">اختر قدرة الموتور أو الغاطس المتاح عندك فقط، وهيظهر لك السعر ومكونات المحطة على طول.</div>
        <label>قدرة الموتور / الغاطس</label>
        <select id="iqHpSelect">
          ${IQ_STD_HP.map(h=>`<option value="${h}" ${h===iqHp?'selected':''}>${h} حصان</option>`).join('')}
        </select>
      </div>
      ${iqError ? `<div class="card"><div class="note" style="color:#B0432C">${esc(iqError)}</div><button class="btn small" id="iqRetryBtn" style="margin-top:var(--sp-2)">إعادة المحاولة</button></div>` : ''}
      ${q && !iqLoading ? `
      <div class="card">
        <div style="font-weight:700;margin-bottom:var(--sp-2)">مكونات المحطة لقدرة ${iqHp} حصان</div>
        <div class="spec-strip-wrap"><div class="spec-strip">
          ${items.map(it=>`<div class="spec-item"><div class="val">${esc(iqCleanQty(it.qty))}</div><div class="lbl">${esc(it.label)}</div></div>`).join('')}
        </div></div>
      </div>` : ''}
    </div>
    <div>
      <div class="card" style="position:sticky;top:88px">
        <div class="detail-cat-badge">السعر التقديري</div>
        ${iqLoading ? `<div class="note" style="text-align:center;padding:var(--sp-4) 0">جارِ حساب السعر...</div>` : ''}
        ${q && !iqLoading ? `
        <div class="detail-price-block"><div class="big-price">${fmt(q.supplyOnlyTotal)} ﷼</div></div>
        <div class="note">* شامل ضريبة القيمة المضافة — توريد الخامات فقط بدون التركيب</div>
        <button class="btn full" id="iqWhatsappBtn" style="margin-top:var(--sp-3);background:#25D366;color:#fff">💬 اطلب عرض سعر عبر واتساب</button>
        ` : ''}
      </div>
    </div>
  </div>
  `;
}

function logLead(lead){
  callEngine('log-lead', { lead }).catch(()=>{});
}

