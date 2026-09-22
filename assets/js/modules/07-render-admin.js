/* =======================================================================
   7) RENDER — ADMIN VIEW
   ======================================================================= */
/* ---- unified customers view — backed by the `customers` table in Supabase
   (any rep, any device, always current). Replaces the old localStorage-only
   leads cache as the primary source; the Google Sheet webhook below stays
   available purely as an optional external export. ---- */
let cachedCustomers = null, customersLoading = false, customersError = null;
let customerDetail = null, customerDetailLoading = false, customerSearchQuery = '';
let overviewStats = null, overviewStatsLoading = false, overviewStatsError = false;

async function loadOverviewStats(force){
  if(overviewStatsLoading || (overviewStats && !force) || (overviewStatsError && !force)) return;
  overviewStatsLoading = true; overviewStatsError = false;
  try{
    overviewStats = await callEngine('admin-overview-stats', { adminToken: adminTokenMem });
  }catch(e){ overviewStats = null; overviewStatsError = true; }
  overviewStatsLoading = false;
  render();
}

async function loadCustomers(force){
  if(customersLoading || (cachedCustomers && !force) || (customersError && !force)) return;
  customersLoading = true; customersError = null;
  try{
    const data = await callEngine('admin-list-customers', { adminToken: adminTokenMem });
    cachedCustomers = data.customers || [];
  }catch(e){
    customersError = e.message || 'تعذر تحميل قائمة العملاء';
  }
  customersLoading = false;
  render();
}

async function openCustomerDetail(id){
  customerDetail = null; customerDetailLoading = true; render();
  try{
    const data = await callEngine('admin-customer-detail', { adminToken: adminTokenMem, customerId: id });
    customerDetail = data;
  }catch(e){
    customerDetail = { error: e.message || 'تعذر تحميل بيانات العميل' };
  }
  customerDetailLoading = false;
  render();
}

function renderCustomersSection(){
  if(customerDetailLoading || customerDetail){
    if(customerDetailLoading) return `<div class="card"><div class="note">جارِ التحميل...</div></div>`;
    if(customerDetail.error) return `<div class="card"><div class="note" style="color:#B0432C">${customerDetail.error}</div><button class="btn ghost small" id="custBackBtn" style="margin-top:8px">◀ رجوع لقائمة العملاء</button></div>`;
    const c = customerDetail.customer, qs = customerDetail.quotes || [];
    return `
    <div class="card">
      <button class="btn ghost small no-print" id="custBackBtn">◀ رجوع لقائمة العملاء</button>
      <h3 style="margin-top:10px">${c.name || '(بدون اسم)'} <span class="tag">${c.phone}</span></h3>
      <div class="stats" style="margin:12px 0">
        <div class="stat"><div class="v">${c.quotes_count}</div><div class="l">إجمالي عروض الأسعار</div></div>
        <div class="stat"><div class="v" style="font-size:14px">${c.rep_username||'-'}</div><div class="l">آخر مندوب تواصل</div></div>
        <div class="stat"><div class="v" style="font-size:13px">${c.first_quote_at?new Date(c.first_quote_at).toLocaleDateString('en-GB'):'-'}</div><div class="l">أول تواصل</div></div>
        <div class="stat"><div class="v" style="font-size:13px">${c.last_quote_at?new Date(c.last_quote_at).toLocaleDateString('en-GB'):'-'}</div><div class="l">آخر تواصل</div></div>
      </div>
      <table class="admtable">
        <thead><tr><th>التاريخ</th><th>المندوب</th><th>القدرة HP</th><th>الإجمالي</th></tr></thead>
        <tbody>${qs.length ? qs.map(q=>`<tr><td>${new Date(q.created_at).toLocaleString('en-GB')}</td><td>${q.rep_display_name||'-'}</td><td class="num">${q.hp||'-'}</td><td class="num">${fmt(+q.final_total||0)} ﷼</td></tr>`).join('') : '<tr><td colspan="4" style="color:var(--muted);padding:10px">لا توجد عروض بعد</td></tr>'}</tbody>
      </table>
    </div>`;
  }
  const list = (cachedCustomers || []).filter(c=>{
    if(!customerSearchQuery) return true;
    const q = customerSearchQuery.toLowerCase();
    return (c.name||'').toLowerCase().includes(q) || (c.phone||'').includes(q);
  });
  return `
  <div class="card">
    <h3>قاعدة بيانات العملاء <span class="tag">${cachedCustomers?cachedCustomers.length:'…'} عميل مسجّل — مركزية، من أي مندوب وأي جهاز</span></h3>
    <input type="text" id="customerSearch" placeholder="ابحث بالاسم أو الهاتف..." value="${customerSearchQuery}">
    ${customersLoading ? `<div class="note" style="margin-top:8px">جارِ التحميل...</div>` :
      customersError ? `<div class="note" style="color:#B0432C;margin-top:8px">${customersError}</div><button class="btn ghost small" id="customersRetryBtn" style="margin-top:6px">إعادة المحاولة</button>` :
      `<table class="admtable" style="margin-top:10px">
        <thead><tr><th>الاسم</th><th>الهاتف</th><th>عدد العروض</th><th>آخر مندوب</th><th>آخر تواصل</th><th></th></tr></thead>
        <tbody>${list.length ? list.map(c=>`
          <tr class="customer-row" data-custid="${c.id}" style="cursor:pointer">
            <td>${c.name||'(بدون اسم)'}</td><td class="num">${c.phone}</td><td class="num">${c.quotes_count}</td>
            <td>${c.rep_username||'-'}</td><td>${c.last_quote_at?new Date(c.last_quote_at).toLocaleDateString('en-GB'):'-'}</td>
            <td class="op"><button class="btn ghost small" data-custid-open="${c.id}">عرض التفاصيل</button></td>
          </tr>`).join('') : '<tr><td colspan="6" style="color:var(--muted);padding:10px">لا يوجد عملاء بعد</td></tr>'}</tbody>
      </table>`}
  </div>
  <div class="card">
    <h3>تصدير خارجي (اختياري) <span class="tag">${adminConfig.leadsWebhookUrl?'مفعّل — Google Sheet':'غير مفعّل'}</span></h3>
    <label>رابط المزامنة السحابية (Google Apps Script Web App URL)</label>
    <input type="text" id="a_webhook" value="${adminConfig.leadsWebhookUrl}" placeholder="https://script.google.com/macros/s/xxxxx/exec">
    <div class="note" style="margin-top:6px">قاعدة العملاء أعلاه هي المصدر الرئيسي الآن (تشتغل من أي جهاز تلقائيًا). الرابط ده اختياري بس، لو حابب نسخة إضافية على Google Sheet.</div>
  </div>`;
}

let productsNav = 'categories'; // 'categories' | 'category' | 'detail'
let selectedCategoryIdx = null;
let selectedProduct = null; // {catIdx, rowIdx} when viewing a single product's detail page
let productsGlobalSearch = ''; // search box on the level-1 "all categories" landing page
let hideUnavailableProducts = false; // toggle on the level-2 category page
let cachedPortfolio = null; // fetched lazily when the portfolio tab opens
let portfolioLoading = false;
let portfolioError = null;

async function loadPortfolio(){
  portfolioLoading = true;
  portfolioError = null;
  try{
    const data = await callEngine('get-portfolio', {});
    cachedPortfolio = data.portfolio || null;
  }catch(e){
    portfolioError = e.message || 'تعذر الاتصال بالخادم';
  }
  portfolioLoading = false;
  render();
}

function renderPortfolio(){
  if(!cachedPortfolio && !portfolioLoading && !portfolioError){
    loadPortfolio();
  }
  if(portfolioLoading && !cachedPortfolio){
    return `<div class="card" style="max-width:420px;margin:60px auto;text-align:center"><h3>جارِ التحميل...</h3></div>`;
  }
  if(portfolioError){
    return `<div class="card" style="max-width:420px;margin:60px auto;text-align:center">
      <h3 style="color:#B0432C">تعذر تحميل البورتفوليو</h3>
      <div class="note">${portfolioError}</div>
      <button class="btn small" id="retryPortfolioBtn" style="margin-top:12px">إعادة المحاولة</button>
    </div>`;
  }
  const pf = cachedPortfolio || {};
  const hero = pf.hero || {};
  const kpis = pf.kpis || [];
  const timeline = pf.timeline || [];
  const capabilitySteps = pf.capabilitySteps || [];
  const projects = pf.projects || [];
  const businessCases = pf.businessCases || [];
  const roiCases = pf.roiCases || [];
  const partners = pf.partners || [];
  return `
  <section class="portfolio-view">
    <div class="portfolio-eyebrow">هندسة، توريد، تنفيذ، تشغيل — EPC متكامل</div>
    <nav class="portfolio-subnav no-print">
      <a href="#pf-capabilities">⚙️ قدراتنا</a>
      <a href="#pf-projects">🏗️ مشاريعنا</a>
      ${(businessCases.length || roiCases.length) ? `<a href="#pf-roi">📈 عائد الاستثمار</a>` : ''}
      ${partners.length ? `<a href="#pf-partners">🤝 شركاؤنا</a>` : ''}
    </nav>
    <div class="portfolio-hero">
      <div class="visual">
        <img src="${hero.image||''}" alt="Holoul Energy solar irrigation project" loading="eager">
        <div class="caption">
          <h2>${hero.title||''}</h2>
          <p>${hero.description||''}</p>
        </div>
      </div>
      <div class="panel">
        <h3>${pf.panelTitle||''}</h3>
        <div class="note">${pf.panelNote||''}</div>
        <div class="portfolio-kpis">
          ${kpis.map(k=>`<div class="portfolio-kpi"><div class="v">${k.v}</div><div class="l">${k.l}</div></div>`).join('')}
        </div>
      </div>
    </div>

    <div class="portfolio-band">
      <div class="card">
        <h3>رحلتنا الهندسية</h3>
        <div class="timeline">
          ${timeline.map(t=>`<div class="timeline-item">${t.image ? `<img class="timeline-thumb" src="${t.image}" alt="${t.title||''}" loading="lazy">` : `<strong>${t.label||''}</strong>`}<div><b>${t.title||''}</b><p>${t.desc||''}</p></div></div>`).join('')}
        </div>
      </div>
      <div class="card" id="pf-capabilities">
        <h3>قدرات التنفيذ</h3>
        <div class="stats">
          ${capabilitySteps.map(s=>`<div class="stat"><div class="v">${s.v}</div><div class="l">${s.l}</div></div>`).join('')}
        </div>
      </div>
    </div>

    <div class="card" id="pf-projects">
      <h3>${pf.projectsTitle||''} <span class="tag">${pf.projectsTag||''}</span></h3>
      <div class="portfolio-projects">
        ${projects.map(p=>`
          <article class="project-card">
            <div class="imgwrap">
              <img src="${p.img}" alt="${p.hp} ${p.title}" loading="lazy">
              <div class="hp-badge">${p.hp}</div>
            </div>
            <div class="body">
              <h3>${p.title}</h3>
              <p>${p.place}<br>${p.desc}</p>
              <div class="meta">${(p.tags||[]).map(t=>`<span>${t}</span>`).join('')}</div>
            </div>
          </article>
        `).join('')}
      </div>
    </div>

    ${businessCases.length ? `
    <div class="card" id="pf-roi">
      <h3>حالات عائد استثماري فعلية <span class="tag">مشاريع منفذة ومُشغّلة</span></h3>
      <div class="bc-grid">
        ${businessCases.map(b=>`
          <div class="bc-card">
            <div class="bc-head">
              <div>
                <h4>${b.title||'منظومة ري زراعي بالطاقة الشمسية'}</h4>
                <div class="bc-place">${b.place||''}</div>
              </div>
              <div class="bc-hp">${b.hp}</div>
            </div>
            <div class="bc-stats">
              <div class="bc-stat"><div class="v">${b.investment||''}</div><div class="l">تكلفة المنظومة</div></div>
              <div class="bc-stat"><div class="v">${b.diesel||''}</div><div class="l">تكلفة الديزل الشهرية سابقًا</div></div>
              <div class="bc-stat"><div class="v">${b.payback||''}</div><div class="l">فترة الاسترداد التقديرية</div></div>
              <div class="bc-stat"><div class="v">${b.hp}</div><div class="l">قدرة المضخة</div></div>
            </div>
            <ul class="bc-results">
              ${(b.results||[]).map(r=>`<li>${r}</li>`).join('')}
            </ul>
          </div>
        `).join('')}
      </div>
    </div>` : ''}

    <div class="portfolio-band"${businessCases.length ? '' : ' id="pf-roi"'}>
      <div class="card">
        <h3>${businessCases.length ? 'مؤشرات إضافية' : 'حالات عائد الاستثمار'}</h3>
        <div class="stats">
          ${roiCases.map(r=>`<div class="stat"><div class="v">${r.v}</div><div class="l">${r.l}</div></div>`).join('')}
        </div>
      </div>
      <div class="card" id="pf-partners">
        <h3>شركاء وتقنيات</h3>
        <div class="partner-grid">
          ${partners.map(p=>`<div class="partner-logo"><img src="${p.img}" alt="${p.name}" loading="lazy"></div>`).join('')}
        </div>
      </div>
    </div>

    <div class="card quote-banner">
      <div class="hero-summary">
        <div>
          <h3>هل لديك مشروع ري زراعي؟</h3>
          <div class="note">نقدر نبدأ بدراسة أولية للقدرة المطلوبة، تكلفة التشغيل الحالية، وفترة الاسترداد المتوقعة.</div>
        </div>
        <div class="compact-actions">
          <a class="btn" href="https://wa.me/966561274344" target="_blank" rel="noopener">تواصل واتساب</a>
          <button class="btn ghost" type="button" onclick="document.querySelector('[data-view=&quot;calc&quot;]').click()">افتح الحاسبة</button>
        </div>
      </div>
    </div>
  </section>`;
}

let productViewMode = localStorage.getItem('holoul_product_view') || 'cards'; // 'cards' | 'list' — remembered across visits
let categoriesViewMode = localStorage.getItem('holoul_categories_view') || 'cards'; // products landing page (level 1)
let readyViewMode = localStorage.getItem('holoul_ready_view') || 'cards'; // منظومات جاهزة

// ---- Level-2 category page: filter/sort/paginate state (screenshot-style catalog) ----
let categorySearchQuery = '';       // text search scoped to the open category
let productBrandFilter = new Set(); // selected brand facet values
let productSpecFilter = new Set();  // selected secondary spec facet values
let productSort = 'default';        // 'default' | 'price_asc' | 'price_desc' | 'name_asc'
let productsPerPage = 12;           // 12 | 24 | 48 | Infinity
let productsCurrentPage = 1;

function resetCategoryFilters(){
  categorySearchQuery = '';
  productBrandFilter = new Set();
  productSpecFilter = new Set();
  productSort = 'default';
  productsCurrentPage = 1;
}

// ---- Product cart: pick items across categories, then send one consolidated
// quote request instead of one WhatsApp message per product. ----
let productCart = [];     // [{catIdx, ri, name, category, price, qty}]
let cartPanelOpen = false;
let cartQuoteView = false;
let cartClientName = '';
let cartClientPhone = '';
const CART_VAT_RATE = 0.15;
function cartKey(catIdx, ri){ return `${catIdx}:${ri}`; }
function cartHas(catIdx, ri){ return productCart.some(c=>c.catIdx===catIdx && c.ri===ri); }
function cartToggle(cat, catIdx, ri){
  if(cartHas(catIdx, ri)){
    productCart = productCart.filter(c=>!(c.catIdx===catIdx && c.ri===ri));
  } else {
    const row = cat.rows[ri];
    const nCols = cat.columns.length;
    const price = nCols>=2 ? row[nCols-2] : row[nCols-1];
    productCart.push({ catIdx, ri, name: row[0], category: cat.category, price, qty: 1 });
  }
}
function cartSetQty(idx, qty){
  qty = Math.max(1, Math.round(+qty) || 1);
  if(productCart[idx]) productCart[idx].qty = qty;
}
function cartTotals(){
  const subtotal = productCart.reduce((s,c)=>s + (parseFloat(c.price)||0) * (c.qty||1), 0);
  const vat = subtotal * CART_VAT_RATE;
  const total = subtotal + vat;
  return { subtotal, vat, total };
}

// Known multi-word brand names checked before falling back to "first word",
// so e.g. "JA Solar 625W" groups under "JA Solar" not just "JA".
const KNOWN_PRODUCT_BRANDS = ['JA Solar','Canadian Solar','Jinko Solar','JinkoSolar','Astronergy','LONGi','AIKO','Jinko','Risen','Trina Solar','Trina','VEICHI','Huawei','Growatt','Deye','Solis','Sungrow','GoodWe'];
function extractProductBrand(cat, ri){
  const detail = (cat.productDetails && cat.productDetails[ri]) || {};
  if(detail.brand) return detail.brand;
  const name = (cat.rows[ri] && cat.rows[ri][0]) || '';
  // Only ever label something as a "brand" when it's a real manufacturer name
  // we recognize — otherwise the first word of a product name (e.g. "MCCB",
  // "FUSE", "Holder") gets mistaken for a brand, which is wrong.
  const hit = KNOWN_PRODUCT_BRANDS.find(b => name.toUpperCase().startsWith(b.toUpperCase()));
  return hit || '';
}

// Builds the two facets shown in the sidebar for the open category: brand
// (derived above) and a secondary spec facet based on the category's own
// first spec column (e.g. wattage for panels, current rating for batteries).
function computeCategoryFacets(cat){
  const brandCounts = {};
  const specCounts = {};
  const specLabel = cat.columns[1] || 'المواصفة';
  cat.rows.forEach((row, ri)=>{
    const b = extractProductBrand(cat, ri);
    if(b) brandCounts[b] = (brandCounts[b]||0) + 1;
    const v = row[1];
    if(v!=null && v!=='') specCounts[v] = (specCounts[v]||0) + 1;
  });
  return { brandCounts, specLabel, specCounts };
}

function getFilteredCategoryRowIdxs(cat){
  const q = categorySearchQuery.trim().toLowerCase();
  let idxs = cat.rows.map((_,ri)=>ri).filter(ri=>{
    if(hideUnavailableProducts && !isProductAvailable(cat, ri)) return false;
    if(productBrandFilter.size && !productBrandFilter.has(extractProductBrand(cat, ri))) return false;
    if(productSpecFilter.size && !productSpecFilter.has(String(cat.rows[ri][1]))) return false;
    if(q && !cat.rows[ri].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
  const nCols = cat.columns.length;
  const priceOf = ri => parseFloat(cat.rows[ri][nCols-2]) || 0;
  if(productSort==='price_asc') idxs = idxs.sort((a,b)=>priceOf(a)-priceOf(b));
  else if(productSort==='price_desc') idxs = idxs.sort((a,b)=>priceOf(b)-priceOf(a));
  else if(productSort==='name_asc') idxs = idxs.sort((a,b)=>String(cat.rows[a][0]).localeCompare(String(cat.rows[b][0]),'ar'));
  return idxs;
}

// Sticky cart bar (bottom) + expandable panel — lets someone pick several
// products across categories, then send ONE consolidated WhatsApp quote
// request instead of one message per product.
function renderProductCartBar(){
  if(!productCart.length) return '';
  const { subtotal, vat, total } = cartTotals();
  return `
  <div class="cart-panel-wrap no-print">
    ${cartPanelOpen ? `
    <div class="cart-panel">
      <div class="cart-panel-head">
        <div class="cart-panel-title">🛒 سلة المنتجات (${productCart.length})</div>
        <button class="cart-panel-close" id="cartPanelCloseBtn" type="button">✕</button>
      </div>
      <div class="cart-panel-list">
        ${productCart.map((c,idx)=>`
        <div class="cart-panel-row">
          <div class="info">
            <div class="name">${c.name}</div>
            <div class="cat">${c.category}</div>
          </div>
          <div class="cart-qty-stepper">
            <button type="button" class="cart-qty-btn" data-cartqtydec="${idx}" ${c.qty<=1?'disabled':''}>−</button>
            <input type="number" class="cart-qty-input" min="1" step="1" value="${c.qty}" data-cartqtyinput="${idx}">
            <button type="button" class="cart-qty-btn" data-cartqtyinc="${idx}">+</button>
          </div>
          <div class="price">${(c.price*c.qty).toLocaleString('en-US')} ﷼</div>
          <button class="rm" data-cartremove="${idx}" title="إزالة">✕</button>
        </div>`).join('')}
      </div>
      <div class="cart-panel-totals">
        <div class="cart-panel-total-row"><span>الإجمالي بدون ضريبة</span><span>${subtotal.toLocaleString('en-US',{maximumFractionDigits:2})} ﷼</span></div>
        <div class="cart-panel-total-row"><span>ضريبة القيمة المضافة (15%)</span><span>${vat.toLocaleString('en-US',{maximumFractionDigits:2})} ﷼</span></div>
        <div class="cart-panel-total-row grand"><span>الإجمالي شامل الضريبة</span><span>${total.toLocaleString('en-US',{maximumFractionDigits:2})} ﷼</span></div>
      </div>
      <div class="cart-panel-actions">
        <button class="btn ghost small" id="cartClearBtn" type="button">🗑 إفراغ السلة</button>
        ${repAuthed ? `<button class="btn small" id="cartPrepareQuoteBtn" type="button">🧾 تجهيز عرض سعر</button>` : ''}
        <button class="btn small pcard2-quote" id="cartRequestQuoteBtn" type="button">🗨️ طلب عرض سعر للسلة</button>
      </div>
      ${!repAuthed ? `<div class="note" style="margin-top:6px;font-size:11px;text-align:center">🧾 تجهيز عرض سعر رسمي (PDF) متاح للمناديب المسجّلين دخولهم فقط</div>` : ''}
    </div>` : ''}
    <button class="cart-bar" id="cartBarToggleBtn" type="button">
      <span class="cart-bar-ic">🛒</span>
      <span class="cart-bar-txt">السلة: ${productCart.length} منتج — ${total.toLocaleString('en-US',{maximumFractionDigits:2})} ﷼ (شامل الضريبة)</span>
      <span class="cart-bar-chevron">${cartPanelOpen ? '▾' : '▴'}</span>
    </button>
  </div>`;
}

// One product card in the screenshot-style grid.
function renderProductCardV2(cat, catIdx, ri){
  const row = cat.rows[ri];
  const detail = (cat.productDetails && cat.productDetails[ri]) || {};
  const available = isProductAvailable(cat, ri);
  const thumb = detail.image || cat.categoryImage || '';
  const brand = extractProductBrand(cat, ri);
  const nCols = cat.columns.length;
  const priceVal = nCols>=2 ? row[nCols-2] : row[nCols-1];
  const specEntries = Object.entries(detail.specs||{}).slice(0,4);
  const fallbackSpecs = cat.columns.slice(1, Math.max(1,nCols-2)).map((c,i)=>[c, row[1+i]]);
  const chips = (specEntries.length ? specEntries : fallbackSpecs).slice(0,4);
  return `<div class="pcard2${available?'':' unavailable-row'}" data-search="${row.join(' ').toLowerCase()}">
    ${!available ? `<span class="pcard2-badge unavail">غير متاح</span>` : ''}
    <label class="pcard2-cartcheck" title="أضف للسلة">
      <input type="checkbox" data-carttoggle="${catIdx}:${ri}" ${cartHas(catIdx,ri)?'checked':''}>
      <span>🛒 أضف للسلة</span>
    </label>
    <div class="pcard2-photo">${thumb ? `<img src="${thumb}" alt="${row[0]}" loading="lazy">` : `<div class="noimg">📦</div>`}</div>
    <div class="pcard2-body">
      ${brand ? `<div class="pcard2-brand">${brand}</div>` : ''}
      <div class="pcard2-name">${row[0]}</div>
      <div class="pcard2-specs">
        ${chips.map(([k,v])=>`<div class="pcard2-spec"><span class="k">${k}:</span> <span class="v">${v}</span></div>`).join('')}
      </div>
      <div class="pcard2-price">${!available ? `<span class="price-tbd">سوف يتوفر في اقرب وقت</span>` : (priceVal!=null && priceVal!=='') ? `${priceVal} ﷼ <small>بدون ضريبة</small>` : `<span class="price-tbd">السعر عند الطلب</span>`}</div>
    </div>
    <div class="pcard2-actions">
      <button class="btn ghost small" data-viewproduct="${catIdx}:${ri}">التفاصيل</button>
      <button class="btn small pcard2-quote" data-requestquote="${catIdx}:${ri}">🗨️ طلب عرض سعر</button>
    </div>
  </div>`;
}

function isProductAvailable(cat, ri){
  const detail = (cat.productDetails && cat.productDetails[ri]) || {};
  if(detail.available === false) return false;
  const row = cat.rows[ri];
  const nCols = cat.columns.length;
  const price = row ? row[nCols-2] : null;
  if(price === '' || price === null || price === undefined) return false;
  const n = parseFloat(price);
  if(isNaN(n) || n <= 0) return false;
  return true;
}

// Small heuristic so the icon spec-strip (temperature/weight/protection/etc.)
// works generically across every category's differently-named spec keys,
// without hand-mapping icons per product.
function specIcon(key){
  const k = String(key);
  if(/وزن/.test(k)) return '⚖️';
  if(/حماية|IP\d/i.test(k)) return '🛡️';
  if(/جهد|فولت|V\b/i.test(k)) return '⚡';
  if(/سعة|Ah\b/i.test(k)) return '🔋';
  if(/ضمان/.test(k)) return '📜';
  if(/حرارة|تشغيل|°/.test(k)) return '🌡️';
  if(/دورات|عمر/.test(k)) return '🔄';
  if(/كفاءة|%/.test(k)) return '📈';
  if(/أبعاد|مقاس|مم|mm/i.test(k)) return '📐';
  return '📌';
}
let detailTab = 'description'; // 'description' | 'specs' — product detail page tabs

// Panels live in D.panels (used by the calculator engine), not D.productCatalog
// — but reps want to browse them like any other product, with a real price
// (total panel price, excl. VAT, same convention as every other category).
// Building a synthetic category here reuses 100% of the existing catalog
// browsing/search/grid-list-toggle/detail-page code for free.
function buildCatalogWithPanels(realCatalog){
  if(!cachedPanelsPublic) ensurePanelsPublicLoaded();
  const panels = cachedPanelsPublic || [];
  if(!panels.length) return realCatalog;
  const panelsCat = {
    category: 'الألواح الشمسية',
    // Matches the "last two columns = price pair" convention every other
    // category uses (so the existing card/detail renderers work unchanged);
    // panels only have one real price (excl. VAT), so it's duplicated here —
    // the detail-page table dedupes identical column names automatically.
    columns: ['الموديل', 'القدرة', 'السعر', 'السعر'],
    rows: panels.map(p => [`${p.brand} ${p.power}W`, `${p.power} واط`, p.priceExclVat ?? '', p.priceExclVat ?? '']),
    categoryImage: panels.find(p=>p.image)?.image || '',
    categoryInfo: '',
    productDetails: Object.fromEntries(panels.map((p,i) => [i, {
      image: p.image, description: p.description, specs: p.specs, datasheetUrl: p.datasheetUrl, brand: p.brand,
    }])),
  };
  return [panelsCat, ...realCatalog];
}

// "Similar products" rail on the detail page — other models from the same
// category, reusing the ready-card visual language for consistency.
function renderSimilarProducts(catalog, catIdx, excludeRowIdx){
  const cat = catalog[catIdx];
  if(!cat) return '';
  const others = cat.rows.map((r,i)=>({r,i})).filter(({i})=>i!==excludeRowIdx).slice(0,8);
  if(!others.length) return '';
  const nCols = cat.columns.length;
  return `
  <div class="card">
    <h3>منتجات مشابهة</h3>
    <div class="similar-rail">
      ${others.map(({r,i})=>{
        const d = (cat.productDetails && cat.productDetails[i]) || {};
        const img = d.image || cat.categoryImage;
        const price = r[nCols-2];
        return `<div class="ready-card" data-similar="${catIdx}:${i}">
          <div class="visual">${img ? `<img src="${img}" alt="${r[0]}">` : `<div class="noimg">📦</div>`}</div>
          <div class="body">
            <h3 class="name">${r[0]}</h3>
            <div class="price" style="color:var(--teal-dark)">${price} ﷼</div>
            <button class="btn ghost small full" data-similar="${catIdx}:${i}" style="margin-top:6px">‹ عرض التفاصيل</button>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

/* =======================================================================
   Product-cart quote document — lets a logged-in rep (or guest) turn the
   product cart into a proper client-facing price quote: same banner/
   itemized-table/VAT/print/PDF/WhatsApp pipeline as the main system quote
   (reuses #quotePrintArea + downloadQuotePdf as-is), saved centrally via
   save-quote so it shows up in the customer database and the rep's history.
   ======================================================================= */
function validateCartClient(){
  if(!cartClientName.trim() || !cartClientPhone.trim()){
    alert('من فضلك أدخل اسم العميل ورقم الهاتف أولًا');
    return false;
  }
  return true;
}
function saveCartQuote(){
  const { subtotal, vat, total } = cartTotals();
  const snapshot = { type: 'product-cart', items: productCart.map(c=>({name:c.name, category:c.category, price:c.price, qty:c.qty})) };
  const sheetLead = {name:cartClientName, phone:cartClientPhone, hp:null, total:Math.round(total), date:new Date().toISOString()};
  logLead(sheetLead);
  if(repUsername && repTokenMem){
    callEngine('save-quote', {
      token: repTokenMem,
      clientName: cartClientName, clientPhone: cartClientPhone,
      hp: null, finalTotal: Math.round(total), snapshot
    }).catch(()=>{});
  } else if(guestMode){
    callEngine('save-quote', {
      guest: true,
      clientName: cartClientName, clientPhone: cartClientPhone,
      hp: null, finalTotal: Math.round(total), snapshot
    }).catch(()=>{});
  }
}
function handleCartPrint(){
  if(!validateCartClient()) return;
  saveCartQuote();
  const originalTitle = document.title;
  document.title = ('عرض-سعر-منتجات-'+cartClientName).replace(/[\/\\?%*:|"<>]/g,'-');
  window.print();
  setTimeout(()=>{ document.title = originalTitle; }, 1000);
}
async function sendCartQuoteToClientWhatsapp(){
  if(!validateCartClient()) return;
  saveCartQuote();
  const phone = normalizePhone(cartClientPhone);
  if(phone.length<11){ alert('رقم هاتف العميل غير صحيح — تأكد إنه بالصيغة الصحيحة (05xxxxxxxx)'); return; }
  const { total } = cartTotals();
  const filename = ('عرض-سعر-منتجات-'+cartClientName).replace(/[^A-Za-z0-9\u0600-\u06FF\-]/g,'') + '.pdf';
  const ok = await downloadQuotePdf(filename);
  const msg = ok
    ? `حلول الطاقة المتجددة والمقاولات — HoloulEnergy\n\nمرفق لكم عرض السعر (PDF) — تم تنزيله على هذا الجهاز باسم "${filename}"، الرجاء إرفاقه في هذه المحادثة 📎\n\nملخص العرض:\nالعميل: ${cartClientName}\nعدد الأصناف: ${productCart.length}\nالسعر النهائي شامل ضريبة القيمة المضافة: ${fmt(total)} ﷼\n\nللتواصل: 966561274344+`
    : `حلول الطاقة المتجددة والمقاولات — HoloulEnergy\n\nعرض سعر منتجات\nالعميل: ${cartClientName}\nعدد الأصناف: ${productCart.length}\nالسعر النهائي شامل ضريبة القيمة المضافة: ${fmt(total)} ﷼\n\nللتواصل: 966561274344+`;
  setTimeout(()=>window.open('https://wa.me/'+phone+'?text='+encodeURIComponent(msg), '_blank'), ok?600:0);
}

function renderCartQuoteDocument(){
  const { subtotal, vat, total } = cartTotals();
  return `
  <div class="catalog-main" style="max-width:820px;margin:0 auto">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px" class="no-print">
      <button class="btn ghost small" id="cartQuoteBackBtn" type="button">→ رجوع للسلة</button>
    </div>
    <div id="quotePrintArea" class="quote-shell">
      <div class="card quote-banner" style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:14px;align-items:center;padding-top:16px;padding-bottom:16px">
        <div style="display:flex;align-items:center;gap:10px">
          <img src="${LOGO_SRC}" alt="HoloulEnergy" style="width:46px;height:46px;object-fit:contain">
          <div>
            <div style="font-family:'Cairo',sans-serif;font-weight:800;font-size:16px">حلول الطاقة المتجددة والمقاولات</div>
            <div style="font-size:10px;color:var(--muted);margin-top:2px">الرقم الوطني الموحد: 7037810988 · السجل التجاري: 1010970687 · الرقم الضريبي: 311386341200003</div>
            <div style="font-size:11px;color:var(--muted);margin-top:1px">HoloulEnergy · 966561274344+</div>
          </div>
        </div>
        <div>
          <div style="font-size:11px;color:var(--muted);letter-spacing:.02em">عرض سعر مُقدَّم إلى</div>
          <div style="font-family:'Cairo',sans-serif;font-weight:800;font-size:18px;margin-top:1px">${cartClientName || '—'}</div>
          <div class="num" style="font-size:12.5px;color:var(--muted);margin-top:1px">${cartClientPhone || '—'}</div>
        </div>
        <div style="text-align:left">
          <div style="font-size:11px;color:var(--muted);letter-spacing:.02em">تاريخ العرض</div>
          <div class="num" style="font-size:14px;font-weight:700;margin-top:1px">${new Date().toLocaleDateString('en-GB')}</div>
        </div>
      </div>

      <div class="card no-print">
        <h3 style="margin-bottom:8px">بيانات العميل</h3>
        <div class="field-group g2" style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div><label style="font-size:12px;color:var(--muted)">اسم العميل</label><input type="text" id="cartQuoteClientName" value="${cartClientName}" placeholder="اسم العميل"></div>
          <div><label style="font-size:12px;color:var(--muted)">رقم الجوال</label><input type="text" id="cartQuoteClientPhone" value="${cartClientPhone}" placeholder="05xxxxxxxx"></div>
        </div>
      </div>

      <div class="card">
        <h3 style="margin-bottom:2px">العرض المالي</h3>
        <div style="font-size:13px;margin:8px 0 4px">تحية طيبة وبعد،</div>
        <div style="font-size:13px;color:var(--ink);line-height:1.8">نتشرف بتقديم عرض السعر التالي للمنتجات المطلوبة.</div>
        <div class="note" style="margin-top:8px">
          ${repAuthed && repDisplayName ? `📋 قدّم هذا العرض: <b>${repDisplayName}</b>` : `🖥️ تم إصدار هذا العرض مباشرة عبر الحاسبة الإلكترونية`}
        </div>
      </div>

      <div class="card">
        <h3>تفصيل عرض السعر</h3>
        <table class="bom">
          <thead><tr><th>#</th><th>المنتج</th><th>الفئة</th><th>الكمية</th><th>سعر الوحدة</th><th>الإجمالي</th></tr></thead>
          <tbody>
            ${productCart.map((c,i)=>`
              <tr>
                <td>${i+1}</td>
                <td class="bom-label">${c.name}</td>
                <td style="font-size:11.5px;color:var(--muted)">${c.category}</td>
                <td style="font-size:11.5px">${c.qty}</td>
                <td style="font-size:11.5px" class="num">${(+c.price).toLocaleString('en-US')} ﷼</td>
                <td style="font-size:11.5px;font-weight:700" class="num">${(c.price*c.qty).toLocaleString('en-US')} ﷼</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <div class="note" style="margin-top:10px">
          <div style="display:flex;justify-content:space-between;padding:3px 0"><span>الإجمالي بدون ضريبة</span><span class="num" style="color:var(--ink)">${fmt(subtotal)} ﷼</span></div>
          <div style="display:flex;justify-content:space-between;padding:3px 0"><span>ضريبة القيمة المضافة (15%)</span><span class="num" style="color:var(--ink)">${fmt(vat)} ﷼</span></div>
        </div>
        <div class="totalbar" style="justify-content:center">
          <div class="line">
            <div class="lbl">السعر النهائي شامل الضريبة</div>
            <div class="big num">${fmt(total)} ﷼</div>
          </div>
        </div>

        <div class="legal-note" style="margin-top:12px;font-size:11px;color:#B0432C;line-height:1.9">
          الارتباط بهذا السعر لمدة ثلاثة أيام فقط من تاريخ العرض (${new Date().toLocaleDateString('en-GB')}).
        </div>
        <div class="contact-note" style="margin-top:12px;text-align:center;font-size:11px;color:var(--muted);line-height:1.9">
          <b style="color:var(--ink)">للتواصل</b><br>
          info@HoloulEnergy.com · Sales@HoloulEnergy.com<br>
          Website - LinkedIn - Youtube - FB - Tiktok : HoloulEnergy<br>
          <span class="num">966561274344+</span>
        </div>

        <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap" class="no-print">
          <button class="btn" onclick="handleCartPrint()">🖨️ طباعة / حفظ PDF</button>
          <button class="btn" style="background:#25D366;color:#fff" onclick="sendCartQuoteToClientWhatsapp()">📤 إرسال العرض للعميل (واتساب)</button>
        </div>
      </div>
    </div>
  </div>`;
}

function renderProducts(){
  if(cartQuoteView && !repAuthed){ cartQuoteView = false; }
  if(cartQuoteView) return renderCartQuoteDocument();
  if(!cachedProductCatalog && !productCatalogLoading && !productCatalogError){
    loadProductCatalog();
  }
  if(productCatalogLoading && !cachedProductCatalog){
    return `<div class="card" style="max-width:420px;margin:60px auto;text-align:center"><h3>جارِ التحميل...</h3></div>`;
  }
  if(productCatalogError){
    return `<div class="card" style="max-width:420px;margin:60px auto;text-align:center">
      <h3 style="color:#B0432C">تعذر تحميل قائمة المنتجات</h3>
      <div class="note">${productCatalogError}</div>
      <button class="btn small" id="retryProductsBtn" style="margin-top:12px">إعادة المحاولة</button>
    </div>`;
  }
  const catalog = buildCatalogWithPanels(cachedProductCatalog || []);
  let innerHtml = '';

  // ---- Level 3: single product detail page ----
  if(productsNav==='detail' && selectedProduct){
    const cat = catalog[selectedProduct.catIdx];
    const row = cat && cat.rows[selectedProduct.rowIdx];
    if(!cat || !row){ productsNav='category'; selectedProduct=null; }
    else {
      const detail = (cat.productDetails && cat.productDetails[selectedProduct.rowIdx]) || {};
      const img = detail.image || cat.categoryImage;
      const available = isProductAvailable(cat, selectedProduct.rowIdx);
      // price = second-to-last column, same convention used everywhere else (excl. VAT)
      const priceVal = row[cat.columns.length-2];
      const specEntries = Object.entries(detail.specs||{});
      const otherCols = cat.columns.map((c,i)=>({c,i})).filter(({c,i},idx,arr)=>i!==0 && !c.includes('شامل الضريبة') && arr.findIndex(x=>x.c===c)===idx && arr.findIndex(x=>x.c===c)!==arr.length-1);
      innerHtml = `
      <div class="card no-print">
        <div class="crumbs">
          <button id="crumbAllCats">كل الفئات</button>
          <span class="sep">/</span>
          <button id="backToCategoryBtn">${cat.category}</button>
          <span class="sep">/</span>
          <span class="current">${row[0]}</span>
        </div>
      </div>
      <div class="card">
        <div class="detail-split">
          <div class="photo">${img ? `<img src="${img}" alt="${row[0]}">` : `<div class="noimg">📦</div>`}</div>
          <div>
            <span class="detail-cat-badge">${cat.category}</span>
            <div style="display:flex;align-items:center;gap:var(--sp-1);flex-wrap:wrap;margin-top:var(--sp-1)">
              <h2 style="margin:0">${row[0]}</h2>
              ${!available ? `<span class="unavail-chip">غير متاح حاليًا</span>` : `<span class="tag">✓ متوفر</span>`}
            </div>
            <div class="detail-price-block">
              ${available
                ? `<div class="big-price">${priceVal} ﷼</div><div class="note" style="display:inline-block;margin-top:4px">* السعر بدون ضريبة القيمة المضافة</div>`
                : `<div class="big-price" style="font-size:20px;color:var(--muted)">سوف يتوفر في اقرب وقت</div>`}
            </div>
            ${detail.datasheetUrl ? `<a href="${detail.datasheetUrl}" target="_blank" rel="noopener" class="btn ghost full" style="margin-bottom:var(--sp-2)">📄 تحميل الداتا شيت</a>` : ''}
            <div class="detail-actions-row no-print">
              <label class="pcard2-cartcheck detail-cartcheck" title="أضف للسلة">
                <input type="checkbox" data-carttoggle="${selectedProduct.catIdx}:${selectedProduct.rowIdx}" ${cartHas(selectedProduct.catIdx,selectedProduct.rowIdx)?'checked':''}>
                <span>🛒 ${cartHas(selectedProduct.catIdx,selectedProduct.rowIdx)?'في السلة':'أضف للسلة'}</span>
              </label>
              <button type="button" class="btn small pcard2-quote" data-requestquote="${selectedProduct.catIdx}:${selectedProduct.rowIdx}">🗨️ طلب عرض سعر</button>
            </div>
            <button type="button" class="btn ghost full no-print" id="shareProductLinkBtn" data-shareproduct="${selectedProduct.catIdx}:${selectedProduct.rowIdx}" style="margin-bottom:var(--sp-2)">🔗 نسخ رابط المنتج</button>
            <div class="detail-meta-line">رقم المنتج: ${row[0]} &nbsp;|&nbsp; التصنيف: ${cat.category}</div>
          </div>
        </div>
      </div>
      ${specEntries.length ? `
      <div class="card">
        <div class="spec-strip-wrap"><div class="spec-strip">
          ${specEntries.map(([k,v])=>`<div class="spec-item"><div class="ico">${specIcon(k)}</div><div class="val">${v}</div><div class="lbl">${k}</div></div>`).join('')}
        </div></div>
      </div>` : ''}
      <div class="card">
        <div class="detail-tabs-nav no-print">
          <button class="${detailTab==='description'?'active':''}" data-detailtab="description">الوصف</button>
          <button class="${detailTab==='specs'?'active':''}" data-detailtab="specs">المواصفات</button>
        </div>
        ${detailTab==='description' ? `
          ${detail.description ? `<div class="note" style="font-size:13px">${detail.description}</div>` : `<div class="note">لا يوجد وصف مفصّل لهذا المنتج بعد.</div>`}
        ` : `
          <table class="admtable">
            <tbody>
              ${otherCols.map(({c,i})=>`<tr><td style="font-weight:600;width:150px">${c}</td><td class="num">${row[i]}</td></tr>`).join('')}
            </tbody>
          </table>
          ${!otherCols.length ? `<div class="note">راجع شريط المواصفات بالأعلى — كل التفاصيل معروضة هناك.</div>` : ''}
        `}
      </div>
      ${renderSimilarProducts(catalog, selectedProduct.catIdx, selectedProduct.rowIdx)}`;
    }
  }

  // ---- Level 2: filterable product grid within one category (screenshot-style) ----
  let categoryFacetsHtml = '';
  if(productsNav==='category' && selectedCategoryIdx!=null){
    const cat = catalog[selectedCategoryIdx];
    if(!cat){ productsNav='categories'; }
    else {
      const facets = computeCategoryFacets(cat);
      const allIdxs = getFilteredCategoryRowIdxs(cat);
      const total = allIdxs.length;
      const perPage = productsPerPage===Infinity ? total || 1 : productsPerPage;
      const totalPages = Math.max(1, Math.ceil(total / perPage));
      if(productsCurrentPage > totalPages) productsCurrentPage = totalPages;
      const start = (productsCurrentPage-1) * perPage;
      const pageIdxs = allIdxs.slice(start, start + perPage);

      const activeChips = [];
      if(categorySearchQuery) activeChips.push({label:`"${categorySearchQuery}"`, kind:'search'});
      productBrandFilter.forEach(b=>activeChips.push({label:b, kind:'brand', value:b}));
      productSpecFilter.forEach(v=>activeChips.push({label:v, kind:'spec', value:v}));

      // Facet panel rendered inside the persistent sidebar (below the category nav).
      categoryFacetsHtml = `
      <div class="facet-panel">
        <div class="facet-panel-title">تصفية المنتجات</div>
        ${Object.keys(facets.brandCounts).length>1 ? `
        <div class="facet-group">
          <div class="facet-group-title">العلامة التجارية</div>
          ${Object.entries(facets.brandCounts).sort((a,b)=>b[1]-a[1]).map(([b,n])=>`
            <label class="facet-check">
              <input type="checkbox" data-brandfacet="${b}" ${productBrandFilter.has(b)?'checked':''}>
              <span class="lbl">${b}</span><span class="cnt">(${n})</span>
            </label>`).join('')}
        </div>` : ''}
        ${(Object.keys(facets.specCounts).length>1 && !/وصف/.test(facets.specLabel)) ? `
        <div class="facet-group">
          <div class="facet-group-title">${facets.specLabel}</div>
          ${Object.entries(facets.specCounts).map(([v,n])=>`
            <label class="facet-check">
              <input type="checkbox" data-specfacet="${v}" ${productSpecFilter.has(v)?'checked':''}>
              <span class="lbl">${v}</span><span class="cnt">(${n})</span>
            </label>`).join('')}
        </div>` : ''}
        <label class="facet-check">
          <input type="checkbox" id="hideUnavailableToggle" ${hideUnavailableProducts?'checked':''}>
          <span class="lbl">إخفاء غير المتاح</span>
        </label>
        ${(productBrandFilter.size||productSpecFilter.size||categorySearchQuery||hideUnavailableProducts) ? `<button class="btn ghost small full" id="clearCategoryFiltersBtn" style="margin-top:8px">🔄 مسح كل الفلاتر</button>` : ''}
      </div>`;

      innerHtml = `
      <div class="card no-print">
        <div class="crumbs" style="margin-bottom:var(--sp-2)">
          <button id="backToCategoriesBtn">كل الفئات</button>
          <span class="sep">/</span>
          <span class="current">${cat.category}</span>
        </div>
        <div class="note" style="color:var(--bad);font-weight:600;margin-bottom:10px">⚠️ الأسعار بدون ضريبة القيمة المضافة (15%)</div>
        <div class="catalog-toolbar">
          <input type="text" id="productSearch" placeholder="ابحث عن منتج..." value="${categorySearchQuery}">
          <select id="productSortSelect">
            <option value="default" ${productSort==='default'?'selected':''}>ترتيب حسب: الأكثر مبيعًا</option>
            <option value="price_asc" ${productSort==='price_asc'?'selected':''}>الأقل سعرًا</option>
            <option value="price_desc" ${productSort==='price_desc'?'selected':''}>الأعلى سعرًا</option>
            <option value="name_asc" ${productSort==='name_asc'?'selected':''}>الاسم (أ-ي)</option>
          </select>
          <select id="productsPerPageSelect">
            <option value="12" ${productsPerPage===12?'selected':''}>عرض 12</option>
            <option value="24" ${productsPerPage===24?'selected':''}>عرض 24</option>
            <option value="48" ${productsPerPage===48?'selected':''}>عرض 48</option>
            <option value="all" ${productsPerPage===Infinity?'selected':''}>عرض الكل</option>
          </select>
          <div class="viewmode-toggle" role="group" aria-label="طريقة العرض" style="margin-top:0">
            <button class="${productViewMode==='cards'?'active':''}" data-viewmode="cards">▦ كروت</button>
            <button class="${productViewMode==='list'?'active':''}" data-viewmode="list">☰ ليستة</button>
          </div>
        </div>
        ${activeChips.length ? `
        <div class="filter-chips">
          ${activeChips.map(c=>`<span class="filter-chip" data-clearchip="${c.kind}" data-chipvalue="${c.value||''}">${c.label} <span class="x">✕</span></span>`).join('')}
          <button class="filter-chip clearall" id="clearCategoryFiltersBtn2">مسح الكل 🗑</button>
        </div>` : ''}
        <div class="note" style="margin-top:8px">عرض ${total ? (start+1) : 0}–${Math.min(start+perPage,total)} من ${total} منتج</div>
      </div>
      <div class="pcard2-grid view-${productViewMode}">
        ${pageIdxs.map(ri=>renderProductCardV2(cat, selectedCategoryIdx, ri)).join('')}
        ${!pageIdxs.length ? `<div class="card" style="grid-column:1/-1"><div class="note" style="text-align:center;padding:20px">لا توجد منتجات مطابقة لهذه الفلاتر.</div></div>` : ''}
      </div>
      ${totalPages>1 ? `
      <div class="pagination">
        <button class="pg-btn" id="pgPrevBtn" ${productsCurrentPage<=1?'disabled':''}>‹</button>
        ${Array.from({length:totalPages},(_,i)=>i+1).map(p=>`<button class="pg-btn ${p===productsCurrentPage?'active':''}" data-pgpage="${p}">${p}</button>`).join('')}
        <button class="pg-btn" id="pgNextBtn" ${productsCurrentPage>=totalPages?'disabled':''}>›</button>
      </div>` : ''}`;
    }
  }

  // ---- Level 1: main categories landing page ----
  if(!innerHtml){
    const gq = (productsGlobalSearch||'').trim().toLowerCase();
    let globalMatches = [];
    if(gq){
      catalog.forEach((cat,ci)=>{
        cat.rows.forEach((row,ri)=>{
          if(row.join(' ').toLowerCase().includes(gq)) globalMatches.push({cat, ci, row, ri});
        });
      });
    }
    innerHtml = `
    <div class="card no-print">
      <h3>قائمة المنتجات</h3>
      <div class="note">اختر نوع المنتج لعرض الموديلات المتاحة، أو تصفح المنظومات الجاهزة أدناه</div>
      <div class="note" style="color:var(--bad);font-weight:600;margin-top:4px">⚠️ جميع الأسعار المعروضة بدون ضريبة القيمة المضافة (15%)</div>
      <input type="text" id="productGlobalSearch" placeholder="ابحث في كل المنتجات..." value="${productsGlobalSearch||''}" style="margin-top:10px">
      ${!gq ? `<div class="viewmode-toggle" role="group" aria-label="طريقة العرض" data-catview-toggle>
        <button class="${categoriesViewMode==='cards'?'active':''}" data-catviewmode="cards">▦ شبكة</button>
        <button class="${categoriesViewMode==='list'?'active':''}" data-catviewmode="list">☰ ليستة</button>
      </div>` : ''}
    </div>
    ${gq ? `
    <div class="card">
      <div class="note">${globalMatches.length} نتيجة عن "${productsGlobalSearch}"</div>
      <div class="model-list view-cards" style="margin-top:8px">
        ${globalMatches.map(({cat,ci,row,ri})=>{
          const available = isProductAvailable(cat, ri);
          const detail = (cat.productDetails && cat.productDetails[ri]) || {};
          const thumb = detail.image || '';
          const nCols = cat.columns.length;
          const priceVal = nCols>=2 ? row[nCols-2] : row[nCols-1];
          return `<div class="model-card${available?'':' unavailable-row'}">
            ${thumb ? `<img class="thumb" src="${thumb}" alt="${row[0]}">` : `<div class="thumb-noimg">📦</div>`}
            <div class="body">
              <div class="name">${row[0]}${!available?' <span class="unavail-chip">غير متاح</span>':''}</div>
              <div class="specs"><span>${cat.category}</span></div>
            </div>
            <div class="side">
              <div class="price">${available ? `${priceVal} ﷼<small>بدون ضريبة</small>` : `<span class="price-tbd">سوف يتوفر في اقرب وقت</span>`}</div>
              <button class="btn ghost small" data-viewproduct="${ci}:${ri}">التفاصيل</button>
            </div>
          </div>`;
        }).join('')}
        ${!globalMatches.length ? `<div class="note" style="padding:10px">لا توجد نتائج مطابقة.</div>` : ''}
      </div>
    </div>` : `
    <div class="category-grid view-${categoriesViewMode}">
      <div class="category-card" onclick="window.goToView('ready')" style="cursor:pointer">
        <div class="noimg">🗂️</div>
        <div class="overlay">
          <h3>منظومات جاهزة (عروض جاهزة)</h3>
          <div class="count">تصفّح المنظومات المجهزة مسبقًا بسعر ثابت</div>
        </div>
      </div>
      <div class="category-card" onclick="window.goToView('irrigation-quick')" style="cursor:pointer">
        <div class="noimg">🚜</div>
        <div class="overlay">
          <h3>مواتير الري بالطاقة الشمسية</h3>
          <div class="count">اختر قدرة الموتور/الغاطس واحصل على السعر فورًا</div>
        </div>
      </div>
      ${catalog.map((cat,ci)=>`
        <div class="category-card" data-opencat="${ci}">
          ${cat.categoryImage ? `<img src="${cat.categoryImage}" alt="${cat.category}">` : `<div class="noimg">📦</div>`}
          <div class="overlay">
            <h3>${cat.category}</h3>
            <div class="count">${cat.rows.length} موديل</div>
          </div>
        </div>`).join('')}
    </div>
    ${!catalog.length ? `<div class="card"><div class="note">لا توجد منتجات مسجّلة بعد.</div></div>` : ''}
    `}
    `;
  }

  // ---- Persistent category sidebar (hybrid: sidebar + cards) ----
  const sidebarHtml = `
  <aside class="catalog-sidebar no-print">
    <div class="catalog-sidebar-head">
      <div class="catalog-sidebar-title">تصفّح المنتجات</div>
      <div class="catalog-sidebar-sub">${catalog.reduce((s,c)=>s+c.rows.length,0)} موديل في ${catalog.length} فئة</div>
    </div>
    <nav class="catalog-nav">
      <button class="catalog-nav-btn ${productsNav==='categories'?'active':''}" id="sidebarAllCatsBtn" type="button">
        <span class="ic">🗂️</span><span class="lbl">كل الفئات</span>
      </button>
      ${catalog.map((cat,ci)=>`
        <button class="catalog-nav-btn ${(productsNav==='category'||productsNav==='detail')&&selectedCategoryIdx===ci?'active':''}" data-opencat="${ci}" type="button">
          <span class="ic">📦</span><span class="lbl">${cat.category}</span><span class="cnt">${cat.rows.length}</span>
        </button>`).join('')}
      <button class="catalog-nav-btn" onclick="window.goToView('ready')" type="button">
        <span class="ic">🧰</span><span class="lbl">منظومات جاهزة</span>
      </button>
      <button class="catalog-nav-btn ${currentView==='irrigation-quick'?'active':''}" onclick="window.goToView('irrigation-quick')" type="button">
        <span class="ic">🚜</span><span class="lbl">مواتير الري بالطاقة الشمسية</span>
      </button>
    </nav>
    ${categoryFacetsHtml}
  </aside>`;

  return `<div class="catalog-shell">${sidebarHtml}<div class="catalog-main">${innerHtml}</div></div>${renderProductCartBar()}`;
}


async function loadProductCatalog(){
  productCatalogLoading = true;
  productCatalogError = null;
  try{
    const data = await callEngine('get-product-catalog', {});
    cachedProductCatalog = data.productCatalog || [];
  }catch(e){
    productCatalogError = e.message || 'تعذر الاتصال بالخادم';
  }
  productCatalogLoading = false;
  render();
}

// ---------------------------------------------------------------------------
// Ready-made off-grid packages — display-only browsing (no sizing calculation).
// A rep/client picks one of these fixed named systems instead of running the
// dynamic off-grid calculator. Data comes straight from D.readyOffgridSystems.
// ---------------------------------------------------------------------------
async function loadReadySystems(){
  readySystemsLoading = true;
  readySystemsError = null;
  try{
    const data = await callEngine('get-ready-offgrid-systems', {});
    cachedReadySystems = data.systems || [];
  }catch(e){
    readySystemsError = e.message || 'تعذر الاتصال بالخادم';
  }
  readySystemsLoading = false;
  render();
}

function openAddProductModal(catIdx){
  const cat = adminConfig.productCatalog[catIdx];
  document.getElementById('apm_categoryName').textContent = `الفئة: ${cat.category}`;
  const fieldsEl = document.getElementById('apm_fields');
  fieldsEl.innerHTML = cat.columns.map((col,i)=>{
    const isPrice = /سعر/.test(col);
    return `<div class="modal-field">
      <label>${col}${isPrice?' (رقم)':''}</label>
      <input data-apmfield="${i}" type="${isPrice?'number':'text'}" placeholder="${col}">
      <div class="modal-error" data-apmerr="${i}"></div>
    </div>`;
  }).join('');
  document.getElementById('apm_error').style.display = 'none';
  document.getElementById('addProductModalOverlay').dataset.cat = catIdx;
  document.getElementById('addProductModalOverlay').style.display = 'flex';
}

function getReadyInverterModelOptions(cfg){
  const cat = (cfg.productCatalog||[]).find(c=>(c.category||'').includes('انفرتر'));
  if(!cat) return [];
  return cat.rows.map(r=>r[0]).filter(m=>/(\d+(\.\d+)?)\s*KW/i.test(m) && !/^VLT|^VHT|Rack/i.test(m));
}
function getReadyBatteryModelOptions(cfg){
  const cat = (cfg.productCatalog||[]).find(c=>(c.category||'').includes('بطاريات ليثيوم'));
  if(!cat) return [];
  return cat.rows.map(r=>r[0]);
}

function readySystemCoolingLine(s){
  if(s.acType === 'لا يوجد' || (!s.acCountDay && !s.acCountNight)) return `<span class="chip chip-muted">❄️ بدون تبريد</span>`;
  const parts = [];
  if(s.acCountDay) parts.push(`${s.acCountDay}× ${s.acPowerDayW}W نهارًا ${s.acHoursDay}س`);
  if(s.acCountNight) parts.push(`${s.acCountNight}× ${s.acPowerNightW}W ليلاً ${s.acHoursNight}س`);
  return `<span class="chip">❄️ ${s.acType} — ${parts.join(' + ')}</span>`;
}

function renderReadySystems(){
  if(!cachedReadySystems && !readySystemsLoading && !readySystemsError){
    loadReadySystems();
  }
  if(readySystemsLoading && !cachedReadySystems){
    return `<div class="card" style="max-width:420px;margin:60px auto;text-align:center"><h3>جارِ التحميل...</h3></div>`;
  }
  if(readySystemsError){
    return `<div class="card" style="max-width:420px;margin:60px auto;text-align:center">
      <h3 style="color:#B0432C">تعذر تحميل المنظومات الجاهزة</h3>
      <div class="note">${readySystemsError}</div>
      <button class="btn small" id="retryReadyBtn" style="margin-top:12px">إعادة المحاولة</button>
    </div>`;
  }
  const systems = (cachedReadySystems || []).filter(s=>s.status !== 'اخفاء من العروض');
  return `
  <div class="card no-print">
    <div class="crumbs" style="margin-bottom:var(--sp-2)">
      <button id="backToProductsFromReadyBtn">قائمة المنتجات</button>
      <span class="sep">/</span>
      <span class="current">منظومات أوف-جريد جاهزة</span>
    </div>
    <h3>منظومات أوف-جريد جاهزة</h3>
    <div class="note">اضغط على أي منظومة لمعرفة تفاصيل ومواصفات المكونات المستخدمة فيها.</div>
    <div class="viewmode-toggle" role="group" aria-label="طريقة العرض">
      <button class="${readyViewMode==='cards'?'active':''}" data-readyviewmode="cards">▦ شبكة</button>
      <button class="${readyViewMode==='list'?'active':''}" data-readyviewmode="list">☰ ليستة</button>
    </div>
  </div>
  <div class="pcard2-grid view-${readyViewMode}">
    ${systems.map(s=>`
      <div class="pcard2">
        <span class="pcard2-badge ${s.status==='متوفر'?'avail':'unavail'}">${s.status}</span>
        <div class="pcard2-photo">${s.image ? `<img src="${s.image}" alt="${s.name}">` : `<div class="noimg">🗂️</div>`}</div>
        <div class="pcard2-body">
          <div class="pcard2-name">${s.name}</div>
          <div class="pcard2-specs">
            <div class="pcard2-spec">${readySystemCoolingLine(s)}</div>
            <div class="pcard2-spec">${s.fridgeCount ? `🧊 ثلاجة ${s.fridgeHours}س` : '🧊 بدون ثلاجة'}</div>
            ${s.lampCount ? `<div class="pcard2-spec">💡 ${s.lampCount}× ${s.lampPowerW}W — ${s.lampHours}س</div>` : ''}
            ${s.otherDevices ? `<div class="pcard2-spec">${s.otherDevices}</div>` : ''}
          </div>
          <div class="pcard2-price">${fmt(s.priceSar)} ﷼</div>
        </div>
        <div class="pcard2-actions">
          <button class="btn ghost small" data-readydetail="${s.id}">التفاصيل</button>
          <button class="btn small pcard2-quote" data-readyquote="${s.id}">🗨️ طلب عرض سعر</button>
        </div>
      </div>`).join('')}
  </div>
  ${!systems.length ? `<div class="card"><div class="note">لا توجد منظومات جاهزة متاحة حاليًا.</div></div>` : ''}
  `;
}

function openReadySystemDetail(id){
  const url = new URL(window.location.href);
  url.search = '?readysystem=' + id;
  window.open(url.toString(), '_blank');
}

function findCatalogEntryByModel(catalog, categoryNameIncludes, model){
  if(!model) return null;
  const catIdx = (catalog||[]).findIndex(c=>(c.category||'').includes(categoryNameIncludes));
  if(catIdx===-1) return null;
  const cat = catalog[catIdx];
  const rowIdx = cat.rows.findIndex(r=>r[0]===model);
  if(rowIdx===-1) return null;
  const details = (cat.productDetails && cat.productDetails[String(rowIdx)]) || {};
  return { catIdx, rowIdx, row: cat.rows[rowIdx], columns: cat.columns, image: details.image || cat.categoryImage, specs: details.specs || {}, description: details.description || '' };
}

function renderReadySystemDetail(id){
  if((!cachedReadySystems || !cachedProductCatalog) && !readySystemsLoading && !readySystemsError && !productCatalogLoading && !productCatalogError){
    if(!cachedReadySystems) loadReadySystems();
    if(!cachedProductCatalog) loadProductCatalog();
  }
  if((readySystemsLoading || productCatalogLoading) && (!cachedReadySystems || !cachedProductCatalog)){
    return `<div class="card" style="max-width:420px;margin:60px auto;text-align:center"><h3>جارِ التحميل...</h3></div>`;
  }
  if(readySystemsError || productCatalogError){
    return `<div class="card" style="max-width:420px;margin:60px auto;text-align:center">
      <h3 style="color:#B0432C">تعذر التحميل</h3>
      <div class="note">${readySystemsError || productCatalogError}</div>
    </div>`;
  }
  const s = (cachedReadySystems||[]).find(sys=>sys.id===id);
  if(!s){
    return `<div class="card" style="max-width:420px;margin:60px auto;text-align:center"><h3>المنظومة غير موجودة</h3></div>`;
  }
  const invEntry = findCatalogEntryByModel(cachedProductCatalog, 'انفرتر', s.inverterModel);
  const batEntry = findCatalogEntryByModel(cachedProductCatalog, 'بطاريات ليثيوم', s.batteryModel);

  // Compact facts only — count/power/voltage/capacity, no images, specs or
  // descriptions. Inverter kW isn't a stored field; it's parsed from the
  // model name (matches the same convention the pricing engine itself uses).
  const invKw = s.inverterModel ? (String(s.inverterModel).match(/([\d.]+)\s*KW/i)||[])[1] : null;
  const invVoltage = (()=>{
    if(!invEntry) return null;
    const specText = (invEntry.specs && (invEntry.specs['جهد البطارية الاسمي'] || invEntry.specs['الجهد الاسمي'])) || '';
    const nums = Array.from(new Set((specText.match(/\d+(\.\d+)?/g)||[]).map(Number).filter(n=>n===12||n===24||n===48)));
    if(nums.length) return nums.join('/')+'V';
    const fromName = String(s.inverterModel||'').match(/\b(12|24|48)V\b/i);
    return fromName ? fromName[1]+'V' : null;
  })();
  const batVoltage = batEntry ? batEntry.row[2] : null;
  const batAh = batEntry ? batEntry.row[1] : null;

  const facts = [
    { ico:'☀️', label:'الألواح الشمسية', value:`${s.panelCount}× ${s.panelPowerW||'-'}W` },
    { ico:'🔌', label:'الإنفرتر', value: s.inverterModel ? `1×${invKw?` ${invKw}KW`:''}${invVoltage?` — جهد التشغيل ${invVoltage}`:''}` : 'بدون إنفرتر — منظم شحن فقط' },
    { ico:'🔋', label:'البطاريات', value:`${s.batteryCount}×${batVoltage?` ${batVoltage}V`:''}${batAh?` — ${batAh}Ah`:''}` },
  ];

  return `
  <div class="card">
    <div class="detail-split">
      <div class="photo">${s.image ? `<img src="${s.image}" alt="${s.name}">` : `<div class="noimg">🗂️</div>`}</div>
      <div>
        <span class="detail-cat-badge">منظومة أوف-جريد جاهزة</span>
        <div style="display:flex;align-items:center;gap:var(--sp-1);flex-wrap:wrap;margin-top:var(--sp-1)">
          <h2 style="margin:0">${s.name}</h2>
          <span class="${s.status==='متوفر'?'tag':'unavail-chip'}">${s.status}</span>
        </div>
        <div class="detail-price-block">
          <div class="big-price">${fmt(s.priceSar)} ﷼</div>
          <div class="note" style="display:inline-block;margin-top:4px">* توريد المعدات فقط — بدون تركيب أو شاسيه</div>
        </div>
        ${renderReadySystemAppliancesBlock(s)}
      </div>
    </div>
  </div>
  <div class="card">
    <h3>المكوّنات</h3>
    <div style="display:flex;flex-direction:column;gap:var(--sp-1)">
      ${facts.map((f,i)=>`
        <div style="display:flex;align-items:center;gap:var(--sp-2);padding:var(--sp-1) 0;${i<facts.length-1?'border-bottom:1px solid var(--line)':''}">
          <span style="font-size:20px">${f.ico}</span>
          <div>
            <div style="font-weight:700;font-size:13.5px">${f.label}</div>
            <div class="note" style="margin-top:2px">${f.value}</div>
          </div>
        </div>`).join('')}
    </div>
  </div>
  `;
}

// The admin already records, per ready off-grid package, roughly what
// devices it's sized to run (AC type/count, fridge, lighting, other
// devices) — this is the single thing customers care about most when
// comparing packages, so it sits right inside the hero, immediately under
// the price, before any component detail.
function renderReadySystemAppliancesBlock(s){
  const rows = [];
  if(s.acType && s.acType!=='لا يوجد'){
    const dayPart = s.acCountDay ? `نهارًا: ${s.acCountDay}× ${s.acPowerDayW||0}W لمدة ${s.acHoursDay||0} ساعة` : '';
    const nightPart = s.acCountNight ? `ليلاً: ${s.acCountNight}× ${s.acPowerNightW||0}W لمدة ${s.acHoursNight||0} ساعة` : '';
    rows.push({icon:'❄️', label:'التبريد/التكييف', value:`${s.acType}${dayPart?' — '+dayPart:''}${nightPart?' — '+nightPart:''}`});
  }
  if(s.fridgeCount) rows.push({icon:'🧊', label:'الثلاجة', value:`تشغيل حتى ${s.fridgeHours||0} ساعة يوميًا`});
  if(s.lampCount) rows.push({icon:'💡', label:'الإضاءة', value:`${s.lampCount}× ${s.lampPowerW||0}W لمدة ${s.lampHours||0} ساعة يوميًا`});
  if(s.otherDevices) rows.push({icon:'🔌', label:'أجهزة أخرى', value:s.otherDevices});
  if(!rows.length) return '';
  return `
  <div style="background:var(--teal-tint);border-radius:10px;padding:var(--sp-2);margin:var(--sp-2) 0">
    <div style="font-weight:800;font-size:13px;color:var(--teal-dark);margin-bottom:var(--sp-1)">الأجهزة التي تقدر المنظومة تشغّلها</div>
    <div style="display:flex;flex-direction:column;gap:6px">
      ${rows.map(r=>`
        <div style="display:flex;align-items:baseline;gap:8px;font-size:12.5px">
          <span>${r.icon}</span>
          <span style="font-weight:700">${r.label}:</span>
          <span style="color:var(--muted)">${r.value}</span>
        </div>`).join('')}
    </div>
  </div>`;
}

// Generic recurring BOM line items that aren't tied to one specific catalog
// model (unlike panels/inverters/batteries, which already carry real photos
// automatically) — the admin can attach a representative photo to each.
const BOM_GENERIC_ITEM_KEYS = [
  ['inverter', 'الانفرتر (الحاسبة المخصصة)'],
  ['ip65', 'لوحة الحماية IP65'],
  ['combiner', 'صندوق التجميع (Combiner Box)'],
  ['cables', 'الكابلات - DC'],
  ['mc4', 'وصلات MC4'],
  ['structure', 'الشاسيه/الحوامل'],
  ['concrete', 'الخرسانة'],
  ['earth', 'التأريض'],
  ['reactor', 'الريأكتور'],
  ['install_mech', 'الأعمال الميدانية وتثبيت الألواح'],
  ['install_elec', 'التركيبات والتوصيلات الكهربائية'],
  ['transport', 'النقل'],
  ['cabling', 'الكابلات ولوحة الحماية (أوف-جريد/أون-جريد)'],
  ['install', 'التركيب والتشغيل (أوف-جريد/أون-جريد)'],
  ['netmetering', 'رسوم صافي القياس'],
];

function renderAdmin(){
  const admSectionTitles = {'overview':'نظرة عامة','discounts':'الخصومات','pricing':'الأسعار والهوامش','calcs':'حاسبات الأنظمة','products':'المنتجات والكتالوج','portfolio':'البورتفوليو','leads':'قاعدة العملاء','reps':'إدارة المناديب','security':'الحماية والنظام'};
  return `
  <div class="admin-shell">
  <aside class="admin-sidebar no-print">
    <div class="admin-sidebar-head">
      <div class="admin-sidebar-title">لوحة التحكم</div>
      <div class="admin-sidebar-sub">HoloulEnergy</div>
    </div>
    <nav class="admin-nav">
      <button class="admin-nav-btn ${currentAdminSection==='overview'?'active':''}" data-admsec="overview" type="button"><span class="ic">📊</span><span class="lbl">نظرة عامة</span></button>
      <button class="admin-nav-btn ${currentAdminSection==='discounts'?'active':''}" data-admsec="discounts" type="button"><span class="ic">🏷️</span><span class="lbl">الخصومات</span></button>
      <button class="admin-nav-btn ${currentAdminSection==='calcs'?'active':''}" data-admsec="calcs" type="button"><span class="ic">🧮</span><span class="lbl">حاسبات الأنظمة</span></button>
      <button class="admin-nav-btn ${currentAdminSection==='products'?'active':''}" data-admsec="products" type="button"><span class="ic">📦</span><span class="lbl">المنتجات والكتالوج</span></button>
      <button class="admin-nav-btn ${currentAdminSection==='portfolio'?'active':''}" data-admsec="portfolio" type="button"><span class="ic">🖼️</span><span class="lbl">البورتفوليو</span></button>
      <button class="admin-nav-btn ${currentAdminSection==='leads'?'active':''}" data-admsec="leads" type="button"><span class="ic">📋</span><span class="lbl">قاعدة العملاء</span></button>
      <button class="admin-nav-btn ${currentAdminSection==='reps'?'active':''}" data-admsec="reps" type="button"><span class="ic">👥</span><span class="lbl">إدارة المناديب</span></button>
      <button class="admin-nav-btn ${currentAdminSection==='security'?'active':''}" data-admsec="security" type="button"><span class="ic">🔒</span><span class="lbl">الحماية والنظام</span></button>
    </nav>
    <button class="btn ghost small full" id="adm_logout_side" style="margin-top:14px">🚪 تسجيل الخروج</button>
  </aside>
  <div class="admin-main">
    <div class="admin-topbar">
      <div class="admin-topbar-title" id="admTopbarTitle">نظرة عامة</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn small" id="admSaveTop">💾 حفظ التعديلات</button>
      </div>
    </div>
    <section class="admsec ${currentAdminSection==='overview'?'active':''}" data-admsec="overview">
  <div class="stats" style="margin-bottom:16px">
    <div class="stat stat-click" data-admsec-jump="products"><div class="v">${adminConfig.productCatalog.length}</div><div class="l">فئات المنتجات</div></div>
    <div class="stat stat-click" data-admsec-jump="products"><div class="v">${adminConfig.productCatalog.reduce((s,c)=>s+(c.rows?.length||0),0)}</div><div class="l">إجمالي المنتجات</div></div>
    <div class="stat stat-click" data-admsec-jump="products"><div class="v">${adminConfig.panels.length}</div><div class="l">أنواع الألواح</div></div>
    <div class="stat stat-click" data-admsec-jump="products"><div class="v">${adminConfig.readyOffgridSystems.length}</div><div class="l">منظومات جاهزة</div></div>
    <div class="stat stat-click" data-admsec-jump="reps"><div class="v">${adminReps.filter(r=>r.active).length}/${adminReps.length}</div><div class="l">مناديب نشطون</div></div>
    <div class="stat stat-click" data-admsec-jump="leads"><div class="v" id="ovLeadsCount">${overviewStats ? overviewStats.totalCustomers : '…'}</div><div class="l">عملاء مسجّلون</div></div>
    <div class="stat stat-click" data-admsec-jump="discounts"><div class="v">${adminConfig.discountTiers.length}</div><div class="l">فئات الخصم</div></div>
  </div>
  <div class="stats" style="margin-bottom:16px">
    <div class="stat stat-click" data-admsec-jump="leads"><div class="v">${overviewStats ? overviewStats.quotesThisMonth : '…'}</div><div class="l">عروض أسعار هذا الشهر</div></div>
    <div class="stat stat-click" data-admsec-jump="leads"><div class="v">${overviewStats ? fmt(overviewStats.avgQuoteValue)+' ﷼' : '…'}</div><div class="l">متوسط قيمة العرض (الشهر)</div></div>
    <div class="stat stat-click" data-admsec-jump="reps"><div class="v" style="font-size:14px">${overviewStats ? overviewStats.mostActiveRep : '…'}</div><div class="l">الأكثر نشاطًا هذا الشهر (${overviewStats?overviewStats.mostActiveRepCount:0} عرض)</div></div>
  </div>
</section>

<section class="admsec ${currentAdminSection==='discounts'?'active':''}" data-admsec="discounts">
${(function(){
  const brandOptions = getCatalogBrandOptions(adminConfig);
  const categories = Object.keys(brandOptions);
  const selCategory = discountFormState.category || categories[0] || '';
  const brandsForSel = brandOptions[selCategory] || [];
  const selBrand = brandsForSel.includes(discountFormState.brand) ? discountFormState.brand : (brandsForSel[0] || '');
  const catOptsHtml = categories.map(c=>`<option value="${escAttr(c)}" ${c===selCategory?'selected':''}>${esc(c)}</option>`).join('') || '<option value="">لا توجد فئات</option>';
  const brandOptsHtml = brandsForSel.map(b=>`<option value="${escAttr(b)}" ${b===selBrand?'selected':''}>${esc(b)}</option>`).join('') || '<option value="">لا توجد ماركات</option>';
  const rows = (adminConfig.discounts||[]);
  const rowsHtml = rows.length ? rows.map((d,i)=>`
    <tr>
      <td>${esc(d.category)}</td>
      <td>${esc(d.brand)}</td>
      <td>${(Number(d.supplierDiscountPct)||0)}%</td>
      <td>${(Number(d.sellDiscountPct)||0)}%</td>
      <td>${d.promoActive ? `${(Number(d.promoDiscountPct)||0)}% (شغّال) <button class="btn ghost small" data-disc-clearpromo="${i}" type="button">حذف الترويجي</button>` : `${(Number(d.promoDiscountPct)||0)}% (متوقف)`}</td>
      <td style="white-space:nowrap">
        <button class="btn ghost small" data-disc-edit="${i}" type="button">تعديل</button>
        <button class="btn ghost small" data-disc-del="${i}" type="button">حذف</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="6" style="text-align:center;color:var(--muted)">لا توجد خصومات مسجّلة بعد</td></tr>`;
  return `
  <div class="card" style="margin-bottom:16px">
    <h3 style="margin-top:0">🏷️ الخصومات</h3>
    <p style="color:var(--muted);font-size:14px;line-height:1.9;margin-bottom:16px">
      الخصم مسجّل على مستوى (الفئة + الماركة) — يعني يغطي كل موديلات نفس الماركة تلقائيًا، من غير ما تحتاج تسجّل كل موديل لوحده.
      يتحسب على سعر البيع المعروض على الموقع، ويُستخدم بس داخليًا لحساب هامش الربح في عروض أسعار المناديب — مش ظاهر للعميل ولا المندوب أبدًا.
    </p>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px">
      <div style="flex:1;min-width:180px">
        <label>الفئة</label>
        <select id="disc_category">${catOptsHtml}</select>
      </div>
      <div style="flex:1;min-width:180px">
        <label>الماركة</label>
        <select id="disc_brand">${brandOptsHtml}</select>
      </div>
      <div style="flex:1;min-width:160px">
        <label>خصم المورد % (تكلفة الشركة)</label>
        <input type="number" id="disc_supplier" value="${discountFormState.supplierDiscountPct}" step="0.1">
      </div>
      <div style="flex:1;min-width:160px">
        <label>خصم البيع % (للعميل)</label>
        <input type="number" id="disc_sell" value="${discountFormState.sellDiscountPct}" step="0.1">
      </div>
    </div>
    <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:end;margin-bottom:14px">
      <div style="flex:1;min-width:200px">
        <label>خصم ترويجي % (صفحة المنتجات فقط)</label>
        <input type="number" id="disc_promo" value="${discountFormState.promoDiscountPct}" step="0.1">
      </div>
      <div style="flex:1;min-width:160px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:8px">
          <input type="checkbox" id="disc_promo_active" ${discountFormState.promoActive?'checked':''}> الترويجي شغّال
        </label>
      </div>
    </div>
    <div style="display:flex;gap:10px;align-items:center">
      <button class="btn" id="disc_save_btn" type="button">💾 حفظ الخصومات</button>
      ${discountFormState.editKey ? '<button class="btn ghost" id="disc_cancel_edit" type="button">إلغاء التعديل</button>' : ''}
    </div>
    <p style="color:var(--muted);font-size:13px;margin-top:14px;line-height:1.9">
      خصم البيع لازم يكون أقل من أو يساوي خصم المورد دايمًا (عشان الشركة نفسها متبقاش بتخسر) — القاعدة نفسها بترفض أي قيمة مخالفة.
      الخصم الترويجي مستقل تمامًا ويؤثر بس على السعر الظاهر في صفحة المنتجات لنفس الفئة والماركة المختارة فوق — مبيلمسش خصم المورد ولا سعر عروض أسعار المناديب.
    </p>
  </div>

  <div class="card">
    <h3 style="margin-top:0">الخصومات المسجّلة حاليًا</h3>
    <table class="admtable">
      <thead><tr><th>الفئة</th><th>الماركة</th><th>خصم المورد</th><th>خصم البيع</th><th>خصم ترويجي</th><th></th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>
  `;
})()}

  <div class="card">
    <h3>فئات الخصم</h3>
    <table class="admtable">
      <thead><tr><th>الاسم</th><th>نسبة من الهامش</th></tr></thead>
      <tbody>
        ${adminConfig.discountTiers.map((d,i)=>`
          <tr><td><input data-d="${i}" data-f="label" value="${d.label}"></td>
              <td><input data-d="${i}" data-f="factor" type="number" step="0.05" value="${d.factor}"></td></tr>`).join('')}
      </tbody>
    </table>
    <label>فئة الخصم المطبّقة تلقائيًا على كل العروض (غير ظاهرة للعميل)</label>
    <select id="a_defdisc">
      ${adminConfig.discountTiers.map((d,i)=>`<option value="${i}" ${i==(adminConfig.defaultDiscountIdx??1)?'selected':''}>${d.label}</option>`).join('')}
    </select>
  </div>
</section>

<section class="admsec ${currentAdminSection==='calcs'?'active':''}" data-admsec="calcs">
<div class="admsub-shell">
  <aside class="admsub-sidebar no-print">
    <button class="admsub-nav-btn ${currentAdminSubSection.calcs==='pump'?'active':''}" data-admsubparent="calcs" data-admsub="pump" type="button"><span class="ic">🚜</span><span class="lbl">أنظمة البامب</span></button>
    <button class="admsub-nav-btn ${currentAdminSubSection.calcs==='offgrid'?'active':''}" data-admsubparent="calcs" data-admsub="offgrid" type="button"><span class="ic">🔋</span><span class="lbl">حاسبة الأوف-جريد</span></button>
    <button class="admsub-nav-btn ${currentAdminSubSection.calcs==='ongrid'?'active':''}" data-admsubparent="calcs" data-admsub="ongrid" type="button"><span class="ic">🔌</span><span class="lbl">حاسبة الأون-جريد</span></button>
  </aside>
  <div class="admsub-main">

  <div class="admsubsec ${currentAdminSubSection.calcs==='pump'?'active':''}" data-admsub="pump">
  <div class="card">
    <h3>معاملات عامة</h3>
    <div class="assump">
      <div><label>نسبة السعة للحصان <span style="color:var(--muted)">(معامل تحجيم عدد السلاسل بالنسبة للحصان)</span></label><input type="number" id="a_hpratio" step="0.01" value="${adminConfig.hpCapacityRatio}"></div>
      <div><label>ضريبة القيمة المضافة</label><input type="number" id="a_vat" step="0.01" value="${adminConfig.vat}"></div>
    </div>
  </div>

  <div class="card">
    <h3>الشاسيه والخرسانة والتركيب الميداني</h3>
    <div class="assump">
      <div><label>الشاسيه الثابت (﷼/سلسلة)</label><input type="number" id="a_stfix" value="${adminConfig.structurePriceFixed}"></div>
      <div><label>الشاسيه المتحرك (﷼/سلسلة)</label><input type="number" id="a_strot" value="${adminConfig.structurePriceRotational}"></div>
      <div><label>الخرسانة (﷼/وحدة)</label><input type="number" id="a_conc" value="${adminConfig.concretePerUnit}"></div>
      <div><label>التأريض / بئر أرضي (﷼/وحدة)</label><input type="number" id="a_earth" value="${adminConfig.earthingPerUnit}"></div>
      <div><label>لوحة الحماية IP65 (﷼/حصان)</label><input type="number" id="a_steel" step="0.001" value="${adminConfig.steelPanelPerHP}"></div>
      <div><label>الأعمال الميدانية وتثبيت الألواح (﷼/لوح)</label><input type="number" id="a_mechinst" value="${adminConfig.mechInstallPerPanel}"></div>
    </div>
  </div>

  <div class="card">
    <h3>التركيب الكهربائي والنقل</h3>
    <div class="assump">
      <div><label>التركيبات والتوصيلات الكهربائية (﷼/لوح)</label><input type="number" id="a_elecinst" value="${adminConfig.elecInstallPerPanel}"></div>
      <div><label>النقل (﷼/رحلة)</label><input type="number" id="a_trans" value="${adminConfig.transportPerTrip}"></div>
      <div><label>الحد الأدنى لتكلفة النقل (﷼)</label><input type="number" id="a_transmin" value="${adminConfig.transportMinimum}"></div>
    </div>
  </div>

  <div class="card">
    <h3>صناديق التجميع</h3>
    <div class="assump">
      <div><label>هامش أمان صندوق التجميع <span style="color:var(--muted)">(نسبة زيادة % فوق عدد المجموعات)</span></label><input type="number" id="a_combheadroom" step="0.01" value="${adminConfig.combinerHeadroom}"></div>
      <div><label>حد أدنى خطوط إضافية بصندوق التجميع</label><input type="number" id="a_combspare" step="1" value="${adminConfig.combinerMinSpareStrings}"></div>
    </div>
  </div>

  <div class="card">
    <h3>الكابلات والوصلات</h3>
    <div class="assump">
      <div><label>معامل طول الكابل (قدرة ≥100 كيلوواط، متر/مجموعة)</label><input type="number" id="a_cablehigh" value="${adminConfig.cableHighMultiplier}"></div>
      <div><label>معامل طول الكابل (قدرة أقل من 100 كيلوواط، متر/مجموعة)</label><input type="number" id="a_cablelow" value="${adminConfig.cableLowMultiplier}"></div>
      <div><label>هامش بيع الكابلات الأساسي (معامل ضرب، قبل خصم البيع)</label><input type="number" id="a_cablemarkup" step="0.01" value="${adminConfig.cableMarkup}"></div>
      <div><label>الأنابيب المرنة (﷼/وحدة)</label><input type="number" id="a_flex" value="${adminConfig.flexTubePerUnit}"></div>
    </div>
    <div class="note" style="margin-top:8px">سعر الكابل الأساسي (﷼/متر)، MC4 والريأكتور نفسهم بقوا يُسحبوا من صفحة "قائمة المنتجات" (فئة الكابلات والوصلات، وفئة الريأكتور). سعر البيع في عروض حاسبة الأنظمة = (السعر المرجعي × الهامش الأساسي هنا) ثم يتطبّق عليه خصم البيع المسجّل لنفس الفئة/الماركة من صفحة "الخصومات". أما التكلفة الداخلية (الربح) فبتتحدد بخصم المورد بس.</div>
  </div>
  </div>

  <div class="admsubsec ${currentAdminSubSection.calcs==='offgrid'?'active':''}" data-admsub="offgrid">
  <div class="card">
    <h3>حاسبة الأوف-جريد <span class="tag">أسعار حقيقية من الكتالوج + هامش قابل للتعديل</span></h3>
    <div class="assump">
      <div><label>ساعات الشمس القصوى اليومية</label><input type="number" id="a_og_sun" step="0.1" value="${adminConfig.offgrid.sunHours}"></div>
      <div><label>كفاءة المنظومة الإجمالية</label><input type="number" id="a_og_eff" step="0.01" value="${adminConfig.offgrid.systemEfficiency}"></div>
      <div><label>عمق تفريغ البطارية القابل للاستخدام (DoD)</label><input type="number" id="a_og_dod" step="0.01" value="${adminConfig.offgrid.batteryDoD}"></div>
      <div><label>أيام الاستقلالية الافتراضية</label><input type="number" id="a_og_autonomy" step="1" value="${adminConfig.offgrid.defaultAutonomyDays}"></div>
      <div><label>هامش/خصم البطاريات % <span style="color:var(--muted)">(فوق سعر الكتالوج)</span></label><input type="number" id="a_og_batmarkup" step="1" value="${adminConfig.offgrid.batteryMarkupPct}"></div>
      <div><label>هامش/خصم الانفرتر % <span style="color:var(--muted)">(فوق سعر الكتالوج)</span></label><input type="number" id="a_og_invmarkup" step="1" value="${adminConfig.offgrid.inverterMarkupPct}"></div>
      <div><label>الشاسيه (﷼/لوح) - تكلفة</label><input type="number" id="a_og_strcost" value="${adminConfig.offgrid.structurePerPanelCost}"></div>
      <div><label>الشاسيه (﷼/لوح) - بيع</label><input type="number" id="a_og_strsell" value="${adminConfig.offgrid.structurePerPanelSell}"></div>
      <div><label>الكابلات ولوحة الحماية (﷼) - تكلفة</label><input type="number" id="a_og_cabcost" value="${adminConfig.offgrid.cablingFixedCost}"></div>
      <div><label>الكابلات ولوحة الحماية (﷼) - بيع</label><input type="number" id="a_og_cabsell" value="${adminConfig.offgrid.cablingFixedSell}"></div>
      <div><label>التركيب (﷼/KW) - تكلفة</label><input type="number" id="a_og_instcost" value="${adminConfig.offgrid.installPerKwCost}"></div>
      <div><label>التركيب (﷼/KW) - بيع</label><input type="number" id="a_og_instsell" value="${adminConfig.offgrid.installPerKwSell}"></div>
    </div>
  </div>

  <div class="card">
    <h3>جدول الأحمال — قائمة الأجهزة الافتراضية <span class="tag">قائمة "+ إضافة من القائمة" في حاسبة الأوف-جريد</span></h3>
    <div class="note" style="margin-bottom:10px">التعديل هنا بيغيّر الأجهزة الجاهزة اللي تظهر للمناديب والعملاء وهما بيبنوا ملف الأحمال. الـ Surge (تيار البدء) بيستخدمه السيرفر لحساب هل الانفرتر المختار كافي وقت تشغيل الجهاز أول مرة (موتورات/كمبروسورات عادةً محتاجة ×3 لـ×7 وقت البدء، أجهزة كهربائية عادية ×1).</div>
    <table class="admtable" id="applPresetTable">
      <thead><tr><th>الجهاز</th><th>واط</th><th>نهار (س)</th><th>ليل (س)</th><th>Surge ×</th><th></th></tr></thead>
      <tbody>
        ${(adminConfig.offgrid.appliancePresets && adminConfig.offgrid.appliancePresets.length ? adminConfig.offgrid.appliancePresets : OFFGRID_APPLIANCE_PRESETS).map((p,i)=>`
          <tr>
            <td><input data-oga="${i}" data-af="name" value="${p.name}" style="width:100%"></td>
            <td><input data-oga="${i}" data-af="watts" type="number" value="${p.watts}" style="width:70px"></td>
            <td><input data-oga="${i}" data-af="dayHours" type="number" value="${p.dayHours ?? 0}" min="0" max="24" step="0.25" style="width:65px"></td>
            <td><input data-oga="${i}" data-af="nightHours" type="number" value="${p.nightHours ?? 0}" min="0" max="24" step="0.25" style="width:65px"></td>
            <td><input data-oga="${i}" data-af="surgeMultiplier" type="number" value="${p.surgeMultiplier ?? 1}" min="1" step="1" style="width:55px"></td>
            <td><button type="button" class="btn ghost small" data-deloga="${i}">✕</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
    <button type="button" class="btn ghost small" id="addApplPresetBtn" style="margin-top:8px">+ إضافة جهاز للقائمة</button>
  </div>
  </div>

  <div class="admsubsec ${currentAdminSubSection.calcs==='ongrid'?'active':''}" data-admsub="ongrid">
  <div class="card">
    <h3>حاسبة الأون-جريد <span class="tag">أسعار حقيقية من الكتالوج + هامش قابل للتعديل</span></h3>
    <div class="assump">
      <div><label>ساعات الشمس القصوى اليومية</label><input type="number" id="a_ng_sun" step="0.1" value="${adminConfig.ongrid.sunHours}"></div>
      <div><label>معامل الأداء (Performance Ratio)</label><input type="number" id="a_ng_pr" step="0.01" value="${adminConfig.ongrid.performanceRatio}"></div>
      <div><label>سعر تعرفة الكهرباء (﷼/كيلوواط ساعة) <span style="color:var(--muted)">(لتحويل الفاتورة لاستهلاك)</span></label><input type="number" id="a_ng_tariff" step="0.01" value="${adminConfig.ongrid.tariffRate}"></div>
      <div><label>هامش/خصم الانفرتر % <span style="color:var(--muted)">(فوق سعر الكتالوج)</span></label><input type="number" id="a_ng_invmarkup" step="1" value="${adminConfig.ongrid.inverterMarkupPct}"></div>
      <div><label>الشاسيه (﷼/لوح) - تكلفة</label><input type="number" id="a_ng_strcost" value="${adminConfig.ongrid.structurePerPanelCost}"></div>
      <div><label>الشاسيه (﷼/لوح) - بيع</label><input type="number" id="a_ng_strsell" value="${adminConfig.ongrid.structurePerPanelSell}"></div>
      <div><label>الكابلات ولوحة الحماية (﷼) - تكلفة</label><input type="number" id="a_ng_cabcost" value="${adminConfig.ongrid.cablingFixedCost}"></div>
      <div><label>الكابلات ولوحة الحماية (﷼) - بيع</label><input type="number" id="a_ng_cabsell" value="${adminConfig.ongrid.cablingFixedSell}"></div>
      <div><label>صافي القياس (﷼) - تكلفة</label><input type="number" id="a_ng_netcost" value="${adminConfig.ongrid.netMeteringFeeCost}"></div>
      <div><label>صافي القياس (﷼) - بيع</label><input type="number" id="a_ng_netsell" value="${adminConfig.ongrid.netMeteringFeeSell}"></div>
      <div><label>التركيب (﷼/KW) - تكلفة</label><input type="number" id="a_ng_instcost" value="${adminConfig.ongrid.installPerKwCost}"></div>
      <div><label>التركيب (﷼/KW) - بيع</label><input type="number" id="a_ng_instsell" value="${adminConfig.ongrid.installPerKwSell}"></div>
    </div>
  </div>
  </div>

  </div>
</div>
</section>

<section class="admsec ${currentAdminSection==='products'?'active':''}" data-admsec="products">
<div class="admsub-shell">
  <aside class="admsub-sidebar no-print">
    <button class="admsub-nav-btn ${currentAdminSubSection.products==='catalog'?'active':''}" data-admsubparent="products" data-admsub="catalog" type="button"><span class="ic">📋</span><span class="lbl">قائمة المنتجات</span></button>
    <button class="admsub-nav-btn ${currentAdminSubSection.products==='panels'?'active':''}" data-admsubparent="products" data-admsub="panels" type="button"><span class="ic">☀️</span><span class="lbl">الألواح الشمسية</span></button>
    <button class="admsub-nav-btn ${currentAdminSubSection.products==='bomimages'?'active':''}" data-admsubparent="products" data-admsub="bomimages" type="button"><span class="ic">🖼️</span><span class="lbl">صور عناصر العرض</span></button>
    <button class="admsub-nav-btn ${currentAdminSubSection.products==='ready'?'active':''}" data-admsubparent="products" data-admsub="ready" type="button"><span class="ic">🧰</span><span class="lbl">منظومات جاهزة</span></button>
  </aside>
  <div class="admsub-main">
  <div class="admsubsec ${currentAdminSubSection.products==='panels'?'active':''}" data-admsub="panels">
  <div class="card">
    <h3>الألواح الشمسية</h3>
    <table class="admtable">
      <thead><tr><th>افتراضي</th><th>البراند</th><th>القدرة W</th><th>Vimp</th><th>Voc</th><th>Iimp</th><th>Isc</th><th>السعر $/W (بدون ضريبة)</th><th>ظاهر للعميل</th><th></th></tr></thead>
      <tbody id="adm_panels">
        ${adminConfig.panels.map((p,i)=>`
          <tr>
            <td style="text-align:center"><input type="radio" name="defaultPanel" data-defpanel="${i}" ${(`${p.brand}|${p.power}`===(adminConfig.defaultPanelKey||''))?'checked':''}></td>
            <td><input data-p="${i}" data-f="brand" value="${p.brand}"></td>
            <td><input data-p="${i}" data-f="power" type="number" value="${p.power}"></td>
            <td><input data-p="${i}" data-f="vimp" type="number" step="0.01" value="${p.vimp}"></td>
            <td><input data-p="${i}" data-f="voc" type="number" step="0.01" value="${p.voc}"></td>
            <td><input data-p="${i}" data-f="iimp" type="number" step="0.01" value="${p.iimp}"></td>
            <td><input data-p="${i}" data-f="isc" type="number" step="0.01" value="${p.isc}"></td>
            <td><input data-p="${i}" data-f="priceW" type="number" step="0.001" value="${p.priceW}"></td>
            <td style="text-align:center"><input type="checkbox" data-pvis="${i}" ${p.visible!==false?'checked':''}></td>
            <td class="op"><button class="btn danger small" data-delpanel="${i}">✕</button></td>
          </tr>`).join('')}
      </tbody>
    </table>
    <button class="btn ghost small" id="addPanel">+ إضافة لوح</button>
    <div class="note" style="margin-top:8px">اللوح يظهر للعميل فقط لو كان "ظاهر للعميل" مفعّل ومعاه سعر أكبر من صفر. عطّل التكة لإخفاء لوح مؤقتًا بدون حذفه.<br>اختَر لوح "افتراضي" ليكون هو المُحدَّد تلقائيًا للعميل عند فتح أي حاسبة (حتى لو أُضيفت ألواح جديدة بعد كده).</div>
  </div>
  </div>
  <div class="admsubsec ${currentAdminSubSection.products==='catalog'?'active':''}" data-admsub="catalog">
  <div class="card no-print">
    <h3>قائمة المنتجات</h3>
    ${(adminConfig.productCatalog||[]).map((cat,ci)=>`
      <div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">
          <input data-pcat="${ci}" style="max-width:280px;font-weight:600" value="${cat.category}" placeholder="اسم الفئة">
          <button class="btn danger small" data-delcat="${ci}">🗑 حذف هذه الفئة</button>
        </div>
        <label>معلومة عامة تخص كل منتجات الفئة دي (تظهر أعلى صفحة الفئة)</label>
        <textarea data-pinfo="${ci}" rows="2" placeholder="مثال: عائلة انفرترات VEICHI الهجينة لأنظمة التخزين المنزلية...">${cat.categoryInfo||''}</textarea>
        <div style="display:flex;align-items:center;gap:10px;margin-top:6px">
          ${cat.categoryImage ? `<img src="${cat.categoryImage}" style="width:60px;height:60px;object-fit:cover;border-radius:8px;border:1px solid var(--line)">` : ''}
          <label class="btn ghost small" style="cursor:pointer">📷 ${cat.categoryImage?'تغيير صورة الفئة':'رفع صورة الفئة'}<input type="file" accept="image/*" data-catimg="${ci}" style="display:none"></label>
        </div>
        <table class="admtable" style="margin-top:10px">
          <thead><tr>
            ${cat.columns.map((col,coli)=>`<th><input data-pcol="${ci}:${coli}" value="${col}" style="font-weight:600"></th>`).join('')}
            <th style="text-align:center">متاح</th>
            <th></th>
          </tr></thead>
          <tbody>
            ${cat.rows.map((row,ri)=>{
              const detail = (cat.productDetails && cat.productDetails[ri]) || {};
              return `<tr>
              ${row.map((cell,coli)=>`<td><input data-pcell="${ci}:${ri}:${coli}" value="${cell}"></td>`).join('')}
              <td style="text-align:center"><input type="checkbox" data-pavail="${ci}:${ri}" ${detail.available!==false?'checked':''} title="المنتج متاح حاليًا"></td>
              <td class="op" style="white-space:nowrap">
                <button class="btn ghost small" data-editdetail="${ci}:${ri}">${detail.image||detail.description?'✏️ تعديل التفاصيل':'+ تفاصيل'}</button>
                <button class="btn danger small" data-delrow="${ci}:${ri}">✕</button>
              </td>
            </tr>`;}).join('')}
          </tbody>
        </table>
        <div style="display:flex;gap:8px;margin-top:6px">
          <button class="btn ghost small" data-addrow="${ci}">+ إضافة صف</button>
          <button class="btn ghost small" data-addcol="${ci}">+ إضافة عمود</button>
        </div>
      </div>`).join('')}
    <button class="btn ghost small" id="addProductCategory">+ إضافة فئة منتجات جديدة</button>
    <div class="note" style="margin-top:8px">دي أسعار بيع مرجعية بدون خصم (منفصلة تمامًا عن أسعار محرك التسعير الداخلي للمحطات). هتظهر للمناديب في تبويب "قائمة المنتجات". أي خصم أو زيادة على هذه الأسعار يتم تسجيله من صفحة "الخصومات" فقط.</div>
    ${(adminConfig.productCatalog||[]).some(c=>c.category.includes('إكسسوارات')) ? `
    <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
      <button class="btn ghost small" id="splitAccessoriesBtn">🔀 تقسيم فئة "إكسسوارات VEICHI" لفئات منفصلة (ريأكتور / صناديق تجميع / كابلات ووصلات / قواطع وفيوزات)</button>
    </div>` : ''}
  </div>

  <div id="addProductModalOverlay" class="modal-overlay" style="display:none">
    <div class="modal-box">
      <h3>إضافة منتج جديد</h3>
      <div class="note" id="apm_categoryName" style="margin-bottom:10px"></div>
      <div id="apm_fields"></div>
      <div class="note" id="apm_error" style="color:#B0432C;display:none;margin-bottom:10px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
        <button class="btn ghost small" id="apm_cancel">إلغاء</button>
        <button class="btn small" id="apm_save">حفظ المنتج</button>
      </div>
    </div>
  </div>

  <div class="card no-print" id="productDetailEditor" style="display:none">
    <h3>تفاصيل المنتج</h3>
    <input type="hidden" id="pde_target">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <img id="pde_imgpreview" src="" style="width:80px;height:80px;object-fit:cover;border-radius:8px;border:1px solid var(--line);display:none">
      <label class="btn ghost small" style="cursor:pointer">📷 رفع صورة المنتج<input type="file" accept="image/*" id="pde_imgfile" style="display:none"></label>
      <button class="btn ghost small" id="pde_useForOthers" type="button">استخدم نفس الصورة لموديلات تانية</button>
    </div>
    <label style="display:flex;align-items:center;gap:8px;margin:8px 0">
      <input type="checkbox" id="pde_available" checked style="width:auto">
      <span>المنتج متاح حاليًا</span>
    </label>
    <label>الماركة <span style="color:var(--muted);font-weight:400">(تُستخدم في ربط المنتج بصفحة الخصومات)</span></label>
    <input type="text" id="pde_brand" placeholder="مثال: VEICHI">
    <label>أقصى قدرة ألواح مسموحة (KW) <span style="color:var(--muted);font-weight:400">(اختياري، لموديلات الانفرتر فقط — من الداتا شيت الرسمي، عمود Max solar power input)</span></label>
    <input type="number" id="pde_maxsolarkw" step="0.01" placeholder="اتركه فاضي لو غير معروف">
    <label>وصف المنتج</label>
    <textarea id="pde_description" rows="3"></textarea>
    <label>مواصفات إضافية <span style="color:var(--muted);font-weight:400">(سطر لكل مواصفة، بصيغة: الاسم: القيمة)</span></label>
    <textarea id="pde_specs" rows="4" placeholder="الكفاءة: 98.2%&#10;زمن التبديل: أقل من 10ms"></textarea>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn small" id="pde_apply">تطبيق</button>
      <button class="btn ghost small" id="pde_cancel">إلغاء</button>
    </div>
    <div class="note" style="margin-top:8px">التعديلات هنا بتتطبق فورًا على النموذج، وتتحفظ نهائيًا لما تدوس "💾 حفظ التعديلات" تحت.</div>
  </div>

  <div class="card no-print" id="sharedImagePicker" style="display:none">
    <h3>اختر الموديلات اللي هتاخد نفس الصورة</h3>
    <div id="sharedImagePickerList"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn small" id="sip_apply">تطبيق على المحدد</button>
      <button class="btn ghost small" id="sip_cancel">إلغاء</button>
    </div>
  </div>
  </div>

  <div class="admsubsec ${currentAdminSubSection.products==='bomimages'?'active':''}" data-admsub="bomimages">
  <div class="card">
    <h3>صور عناصر عروض الأسعار <span class="tag">تظهر في جدول تفصيل العرض</span></h3>
    <div class="note">صورة تمثيلية لكل بند متكرر (كابلات، شاسيه، صندوق تجميع...) تظهر في جدول تفصيل العرض بكل الحاسبات. الألواح والبطاريات وبعض الإنفرترات لها صور حقيقية تلقائيًا من قائمة المنتجات — هذا القسم للبنود العامة اللي مالهاش موديل محدد.</div>
    <div class="grid2" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:var(--sp-2);margin-top:var(--sp-2)">
      ${BOM_GENERIC_ITEM_KEYS.map(([key,label])=>`
        <div style="display:flex;align-items:center;gap:10px;border:1px solid var(--line);border-radius:var(--radius);padding:var(--sp-1) var(--sp-2)">
          <div class="bom-thumb" style="width:44px;height:44px;flex:0 0 44px">
            ${adminConfig.bomItemImages && adminConfig.bomItemImages[key] ? `<img src="${adminConfig.bomItemImages[key]}">` : `<div class="noimg" style="font-size:16px">📦</div>`}
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:600">${label}</div>
            <label class="btn ghost small" style="cursor:pointer;font-size:11px;margin-top:4px;display:inline-block">📷 رفع صورة<input type="file" accept="image/*" data-bomimg="${key}" style="display:none"></label>
          </div>
        </div>`).join('')}
    </div>
  </div>
  </div>

  <div class="admsubsec ${currentAdminSubSection.products==='ready'?'active':''}" data-admsub="ready">
  <div class="card">
    <h3>منظومات أوف-جريد جاهزة <span class="tag">مراجعة كاملة + تغيير المعدات من قائمة المنتجات</span></h3>
    <div class="note">لكل منظومة: عدّل الاسم/السعر/الحالة، وغيّر موديل الإنفرتر أو البطارية من نفس قائمة المنتجات الحقيقية، واضغط "🔄 إعادة حساب السعر" لتحديث السعر بناءً على أسعار الكتالوج الحالية وهوامش الربح في إعدادات الأوف-جريد بالأعلى. السعر المحسوب هو توريد خامات فقط (بدون تركيب أو شاسيه).</div>
    ${adminConfig.readyOffgridSystems.map((s,i)=>{
      const invOptions = getReadyInverterModelOptions(adminConfig);
      const batOptions = getReadyBatteryModelOptions(adminConfig);
      return `
      <details style="margin-top:12px;border:1px solid var(--line);border-radius:10px;padding:10px 14px">
        <summary style="cursor:pointer;font-weight:700;display:flex;justify-content:space-between;align-items:center">
          <span>${s.name} — <span class="num">${fmt(s.priceSar)} ﷼</span></span>
          <span class="${s.status==='متوفر'?'tag':'unavail-chip'}">${s.status}</span>
        </summary>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:12px">
          <div><label>الاسم</label><input data-readysys="${i}" data-rf="name" value="${s.name}"></div>
          <div><label>الحالة</label>
            <select data-readysys="${i}" data-rf="status">
              <option value="متوفر" ${s.status==='متوفر'?'selected':''}>متوفر</option>
              <option value="غير متوفر" ${s.status==='غير متوفر'?'selected':''}>غير متوفر</option>
              <option value="اخفاء من العروض" ${s.status==='اخفاء من العروض'?'selected':''}>اخفاء من العروض</option>
            </select>
          </div>
          <div><label>عدد الألواح (${s.panelPowerW||'-'}W ${s.panelBrand||''})</label><input data-readysys="${i}" data-rf="panelCount" type="number" value="${s.panelCount}"></div>
          <div><label>موديل الإنفرتر</label>
            <select data-readysys="${i}" data-rf="inverterModel">
              <option value="" ${!s.inverterModel?'selected':''}>بدون إنفرتر (منظم شحن فقط)</option>
              ${invOptions.map(m=>`<option value="${m}" ${s.inverterModel===m?'selected':''}>${m}</option>`).join('')}
            </select>
          </div>
          <div><label>موديل البطارية</label>
            <select data-readysys="${i}" data-rf="batteryModel">
              ${batOptions.map(m=>`<option value="${m}" ${s.batteryModel===m?'selected':''}>${m}</option>`).join('')}
            </select>
          </div>
          <div><label>عدد البطاريات</label><input data-readysys="${i}" data-rf="batteryCount" type="number" min="1" value="${s.batteryCount}"></div>
          <div><label>السعر (﷼)</label><input data-readysys="${i}" data-rf="priceSar" type="number" value="${s.priceSar}"></div>
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:10px">
          ${s.image ? `<img src="${s.image}" style="width:60px;height:60px;object-fit:cover;border-radius:8px;border:1px solid var(--line)">` : ''}
          <label class="btn ghost small" style="cursor:pointer">📷 ${s.image?'تغيير صورة المنظومة':'رفع صورة المنظومة (اختياري)'}<input type="file" accept="image/*" data-readysysimg="${i}" style="display:none"></label>
        </div>
        <div style="display:flex;gap:10px;align-items:center;margin-top:10px">
          <button class="btn ghost small" data-recompute-readysys="${i}">🔄 إعادة حساب السعر من الكتالوج</button>
          <span class="note" id="readysys-recompute-note-${i}"></span>
        </div>
        <div style="margin-top:10px">
          <label>الأجهزة اللي بتشغّلها (مرجعي، للعرض فقط)</label>
          <div class="note">
            ${s.acType && s.acType!=='لا يوجد' ? `تبريد: ${s.acType} — نهارًا ${s.acCountDay||0}×${s.acPowerDayW||0}W/${s.acHoursDay||0}س، ليلاً ${s.acCountNight||0}×${s.acPowerNightW||0}W/${s.acHoursNight||0}س<br>` : 'بدون تبريد<br>'}
            ${s.fridgeCount ? `ثلاجة ${s.fridgeHours||0}س<br>` : ''}
            ${s.lampCount ? `إضاءة ${s.lampCount}×${s.lampPowerW||0}W لمدة ${s.lampHours||0}س<br>` : ''}
            ${s.otherDevices ? `${s.otherDevices}<br>` : ''}
            كابلات: ${s.cables || '-'}
          </div>
        </div>
        ${s.notes ? `<div class="note" style="margin-top:6px">${s.notes}</div>` : ''}
      </details>`;
    }).join('')}
    <div class="note" style="margin-top:8px">التعديلات هنا بتتحفظ مع باقي إعدادات الأدمن — لازم تضغط "💾 حفظ التعديلات" بالأسفل عشان تتفعّل فعليًا.</div>
  </div>
  </div>
  </div>
</div>
</section>

<section class="admsec ${currentAdminSection==='portfolio'?'active':''}" data-admsec="portfolio">
  <div class="card no-print">
    <h3>البورتفوليو</h3>
    <div class="note">المحتوى هنا بيظهر في تبويب "البورتفوليو" العام (بدون تسجيل دخول). عدّل زي ما تحب، وادّي "💾 حفظ التعديلات" تحت عشان ينزل على الموقع.</div>

    <div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:10px">
      <h4 style="margin:0 0 8px">الواجهة الرئيسية</h4>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        ${adminConfig.portfolio?.hero?.image ? `<img src="${adminConfig.portfolio.hero.image}" style="width:90px;height:56px;object-fit:cover;border-radius:8px;border:1px solid var(--line)">` : ''}
        <label class="btn ghost small" style="cursor:pointer">📷 ${adminConfig.portfolio?.hero?.image?'تغيير صورة الواجهة':'رفع صورة الواجهة'}<input type="file" accept="image/*" id="pf_heroimg_file" style="display:none"></label>
      </div>
      <label>العنوان</label>
      <input id="pf_hero_title" value="${adminConfig.portfolio?.hero?.title||''}">
      <label>الوصف</label>
      <textarea id="pf_hero_desc" rows="2">${adminConfig.portfolio?.hero?.description||''}</textarea>
      <label>عنوان اللوحة الجانبية</label>
      <input id="pf_panel_title" value="${adminConfig.portfolio?.panelTitle||''}">
      <label>ملاحظة اللوحة الجانبية</label>
      <textarea id="pf_panel_note" rows="2">${adminConfig.portfolio?.panelNote||''}</textarea>
    </div>

    <div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:10px">
      <h4 style="margin:0 0 8px">الأرقام السريعة (KPIs)</h4>
      <table class="admtable">
        <thead><tr><th>القيمة</th><th>الوصف</th><th></th></tr></thead>
        <tbody>
          ${(adminConfig.portfolio?.kpis||[]).map((k,i)=>`<tr>
            <td><input data-pfkpi="${i}" data-f="v" value="${k.v||''}"></td>
            <td><input data-pfkpi="${i}" data-f="l" value="${k.l||''}"></td>
            <td class="op"><button class="btn danger small" data-delpfkpi="${i}">✕</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
      <button class="btn ghost small" data-addpfkpi>+ إضافة رقم</button>
    </div>

    <div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:10px">
      <h4 style="margin:0 0 8px">رحلتنا الهندسية</h4>
      ${(adminConfig.portfolio?.timeline||[]).map((t,i)=>`
        <div style="border:1px solid var(--line);border-radius:8px;padding:8px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
            <input data-pftl="${i}" data-f="label" value="${t.label||''}" placeholder="تسمية قصيرة (تظهر لو مفيش صورة)" style="max-width:200px">
            <button class="btn danger small" data-delpftl="${i}">🗑 حذف المرحلة</button>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            ${t.image?`<img src="${t.image}" style="width:50px;height:50px;object-fit:cover;border-radius:8px;border:1px solid var(--line)">`:''}
            <label class="btn ghost small" style="cursor:pointer">📷 ${t.image?'تغيير الصورة':'رفع صورة (اختياري)'}<input type="file" accept="image/*" data-pftlimg="${i}" style="display:none"></label>
            ${t.image?`<button class="btn ghost small" data-delpftlimg="${i}" type="button">✕ إزالة الصورة</button>`:''}
          </div>
          <input data-pftl="${i}" data-f="title" value="${t.title||''}" placeholder="العنوان" style="margin-bottom:6px">
          <textarea data-pftl="${i}" data-f="desc" rows="2" placeholder="الوصف">${t.desc||''}</textarea>
        </div>`).join('')}
      <button class="btn ghost small" data-addpftl>+ إضافة مرحلة</button>
    </div>

    <div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:10px">
      <h4 style="margin:0 0 8px">قدرات التنفيذ (خطوات)</h4>
      <table class="admtable">
        <thead><tr><th>الرقم</th><th>الوصف</th><th></th></tr></thead>
        <tbody>
          ${(adminConfig.portfolio?.capabilitySteps||[]).map((s,i)=>`<tr>
            <td><input data-pfcap="${i}" data-f="v" value="${s.v||''}"></td>
            <td><input data-pfcap="${i}" data-f="l" value="${s.l||''}"></td>
            <td class="op"><button class="btn danger small" data-delpfcap="${i}">✕</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
      <button class="btn ghost small" data-addpfcap>+ إضافة خطوة</button>
    </div>

    <div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:10px">
      <h4 style="margin:0 0 8px">المشاريع المنفذة</h4>
      <label>عنوان القسم</label>
      <input id="pf_proj_title" value="${adminConfig.portfolio?.projectsTitle||''}">
      <label>وسم/تاريخ (يظهر جنب العنوان)</label>
      <input id="pf_proj_tag" value="${adminConfig.portfolio?.projectsTag||''}">
      ${(adminConfig.portfolio?.projects||[]).map((p,i)=>`
        <div style="border:1px solid var(--line);border-radius:8px;padding:8px;margin:10px 0">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <b>مشروع ${i+1}</b>
            <button class="btn danger small" data-delpfproj="${i}">🗑 حذف المشروع</button>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            ${p.img?`<img src="${p.img}" style="width:70px;height:70px;object-fit:cover;border-radius:8px;border:1px solid var(--line)">`:''}
            <label class="btn ghost small" style="cursor:pointer">📷 ${p.img?'تغيير الصورة':'رفع صورة المشروع'}<input type="file" accept="image/*" data-pfprojimg="${i}" style="display:none"></label>
          </div>
          <div class="row2">
            <div><label>القدرة (مثال: 60 HP)</label><input data-pfproj="${i}" data-f="hp" value="${p.hp||''}"></div>
            <div><label>المكان/التاريخ</label><input data-pfproj="${i}" data-f="place" value="${p.place||''}"></div>
          </div>
          <label>العنوان</label>
          <input data-pfproj="${i}" data-f="title" value="${p.title||''}">
          <label>الوصف</label>
          <textarea data-pfproj="${i}" data-f="desc" rows="2">${p.desc||''}</textarea>
          <label>وسوم (افصل بينها بفاصلة ,)</label>
          <input data-pfproj="${i}" data-f="tags" value="${(p.tags||[]).join(', ')}">
        </div>`).join('')}
      <button class="btn ghost small" data-addpfproj>+ إضافة مشروع</button>
    </div>

    <div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:10px">
      <h4 style="margin:0 0 8px">حالات عائد الاستثمار</h4>
      <table class="admtable">
        <thead><tr><th>القيمة</th><th>الوصف</th><th></th></tr></thead>
        <tbody>
          ${(adminConfig.portfolio?.roiCases||[]).map((r,i)=>`<tr>
            <td><input data-pfroi="${i}" data-f="v" value="${r.v||''}"></td>
            <td><input data-pfroi="${i}" data-f="l" value="${r.l||''}"></td>
            <td class="op"><button class="btn danger small" data-delpfroi="${i}">✕</button></td>
          </tr>`).join('')}
        </tbody>
      </table>
      <button class="btn ghost small" data-addpfroi>+ إضافة حالة</button>
    </div>

    <div style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:10px">
      <h4 style="margin:0 0 8px">شركاء وتقنيات</h4>
      ${(adminConfig.portfolio?.partners||[]).map((p,i)=>`
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          ${p.img?`<img src="${p.img}" style="width:44px;height:44px;object-fit:contain;border-radius:8px;border:1px solid var(--line);background:#fff">`:''}
          <label class="btn ghost small" style="cursor:pointer">📷<input type="file" accept="image/*" data-pfpartnerimg="${i}" style="display:none"></label>
          <input data-pfpartner="${i}" data-f="name" value="${p.name||''}" placeholder="اسم الشريك" style="max-width:200px">
          <button class="btn danger small" data-delpfpartner="${i}">✕</button>
        </div>`).join('')}
      <button class="btn ghost small" data-addpfpartner>+ إضافة شريك</button>
    </div>
  </div>
</section>

<section class="admsec ${currentAdminSection==='leads'?'active':''}" data-admsec="leads">
  ${renderCustomersSection()}
</section>

<section class="admsec ${currentAdminSection==='reps'?'active':''}" data-admsec="reps">
  <div class="card no-print">
    <h3>إدارة المناديب</h3>
    <table class="admtable">
      <thead><tr><th>اسم المستخدم</th><th>الاسم الظاهر</th><th>كلمة مرور جديدة</th><th>مفعّل</th><th>الأسعار<br><small style="font-weight:400">⚠️ بيانات تكلفة</small></th><th>الحاسبات</th><th>المنتجات</th><th>البورتفوليو</th><th></th></tr></thead>
      <tbody>
        ${adminReps.map(r=>{const p=r.permissions||{};return `
          <tr>
            <td><input data-repid="${r.id}" data-rf="username" value="${r.username}"></td>
            <td><input data-repid="${r.id}" data-rf="displayName" value="${r.display_name}"></td>
            <td><input data-repid="${r.id}" data-rf="password" type="password" placeholder="اتركه فارغًا لعدم التغيير"></td>
            <td style="text-align:center"><input type="checkbox" data-repid="${r.id}" data-rf="active" ${r.active?'checked':''}></td>
            <td style="text-align:center"><input type="checkbox" data-repid="${r.id}" data-rf="perm_pricing" ${p.pricing?'checked':''}></td>
            <td style="text-align:center"><input type="checkbox" data-repid="${r.id}" data-rf="perm_calcs" ${p.calcs?'checked':''}></td>
            <td style="text-align:center"><input type="checkbox" data-repid="${r.id}" data-rf="perm_products" ${p.products?'checked':''}></td>
            <td style="text-align:center"><input type="checkbox" data-repid="${r.id}" data-rf="perm_portfolio" ${p.portfolio?'checked':''}></td>
            <td class="op"><button class="btn danger small" data-delrep="${r.id}">✕</button></td>
          </tr>`;}).join('')}
        <tr>
          <td><input id="newrep_username" placeholder="اسم مستخدم جديد"></td>
          <td><input id="newrep_displayname" placeholder="اسم المندوب"></td>
          <td><input id="newrep_password" type="password" placeholder="كلمة مرور"></td>
          <td></td><td></td><td></td><td></td><td></td>
          <td class="op"><button class="btn small" id="addRepBtn">+ إضافة</button></td>
        </tr>
      </tbody>
    </table>
    <button class="btn ghost small" id="saveRepsBtn" style="margin-top:8px">💾 حفظ تعديلات المناديب</button>
    <div class="note" style="margin-top:8px">كل مندوب يسجّل دخوله بحسابه الخاص من شاشة الحاسبة الرئيسية. تعطيل "مفعّل" يمنعه من الدخول فورًا بدون حذف بياناته. الأعمدة الأربعة الأخيرة صلاحيات اختيارية لتعديل أقسام محددة من لوحة التحكم — بدون أي منها المندوب يقدر يعمل عروض أسعار فقط، زي أي مندوب عادي.</div>
  </div>
</section>

<section class="admsec ${currentAdminSection==='security'?'active':''}" data-admsec="security">
  <div class="card no-print">
    <h3>الحماية</h3>
    <label>كلمة مرور جديدة</label>
    <input type="password" id="adm_newpass" placeholder="6 خانات على الأقل">
    <button class="btn ghost small" id="adm_changecred" style="margin-top:10px">تحديث كلمة المرور</button>
    <button class="btn ghost small" id="adm_logout" style="margin-top:10px">🚪 تسجيل الخروج</button>
  </div>

  <div class="card no-print">
    <div style="display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn" id="admSave">💾 حفظ التعديلات</button>
      <button class="btn ghost" id="admExport">⬇️ تصدير JSON</button>
      <button class="btn ghost" id="admImportBtn">⬆️ استيراد JSON</button>
      <input type="file" id="admImport" accept=".json" style="display:none">
    </div>
    <div class="note" style="margin-top:12px">"حفظ التعديلات" يرفع الأسعار مباشرة للخادم — تنعكس فورًا على كل من يستخدم الأداة. "تصدير/استيراد JSON" لعمل نسخة احتياطية أو نقل الإعدادات.</div>
</section>
  </div>
</div>
  `;
}

