/* =======================================================================
   8) WIRING
   ======================================================================= */
const app = document.getElementById('app');
// "دراسة الجدوى" and "منظومات جاهزة" no longer have their own top-level nav
// buttons — they're reached from inside "الحاسبة" and "قائمة المنتجات"
// respectively. This helper switches the view the same way clicking a
// nav.tabs button used to, for use by those nested links.
window.goToView = function(view){
  currentView = view;
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  render();
  window.scrollTo({top:0, behavior:'smooth'});
};
let currentView = 'calc';
let deepLinkReadySystemId = null;
{
  const p = new URLSearchParams(window.location.search).get('readysystem');
  if(p && /^\d+$/.test(p)){ deepLinkReadySystemId = +p; currentView = 'ready-detail'; }
}
{
  const pp = new URLSearchParams(window.location.search).get('product');
  if(pp && /^\d+:\d+$/.test(pp)){
    const [ci,ri] = pp.split(':').map(Number);
    selectedProduct = {catIdx:ci, rowIdx:ri};
    productsNav = 'detail';
    currentView = 'products';
  }
}

/* ---- rep login gate — every rep has their own username/password, verified
   server-side. Session is kept in sessionStorage (gone once the tab closes)
   unless "remember me" was checked, in which case it's kept in localStorage
   with a 14-day expiry so it survives closing the browser entirely. ---- */
const REP_REMEMBER_KEY = 'holoul_rep_remember_v1';
const ADMIN_REMEMBER_KEY = 'holoul_admin_remember_v1';
let repAuthed = false, repUsername = null, repTokenMem = null, repDisplayName = null, repPermissions = {};
try{
  const remembered = JSON.parse(localStorage.getItem(REP_REMEMBER_KEY)||'null');
  if(remembered && remembered.expiresAt > Date.now() && remembered.username && remembered.token){
    repUsername = remembered.username; repTokenMem = remembered.token; repDisplayName = remembered.displayName;
    repPermissions = remembered.permissions || {}; repAuthed = true;
  } else {
    if(remembered) localStorage.removeItem(REP_REMEMBER_KEY);
    const savedRep = JSON.parse(sessionStorage.getItem('holoul_rep_session')||'null');
    if(savedRep && savedRep.username && savedRep.token){
      repUsername = savedRep.username; repTokenMem = savedRep.token; repDisplayName = savedRep.displayName;
      repPermissions = savedRep.permissions || {}; repAuthed = true;
    }
  }
}catch(e){}

let guestMode = false, guestRegistered = false;

function renderRepLogin(){
  return `<div class="card" style="max-width:360px;margin:60px auto">
    <h3>تسجيل دخول المندوب</h3>
    <label>اسم المستخدم</label>
    <input type="text" id="rep_user" autocomplete="username">
    <label>كلمة المرور</label>
    <input type="password" id="rep_pass" autocomplete="current-password">
    <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:13px;cursor:pointer">
      <input type="checkbox" id="rep_remember"> تذكرني على هذا الجهاز لمدة أسبوعين
    </label>
    <button class="btn" id="rep_login_btn" style="margin-top:14px;width:100%">دخول</button>
    <div id="rep_login_err" class="note" style="margin-top:10px;color:#B0432C;display:none"></div>
    <div style="text-align:center;margin-top:16px;padding-top:14px;border-top:1px solid var(--line)">
      <button class="btn ghost small" id="guestModeBtn" type="button">أنا عميل — التسعير مباشرة بدون مندوب</button>
    </div>
  </div>`;
}

function renderGuestRegister(){
  return `<div class="card" style="max-width:360px;margin:60px auto">
    <h3>بيانات التواصل</h3>
    <div class="note" style="margin-bottom:10px">من فضلك سجّل اسمك ورقم جوالك عشان نقدر نتواصل معك بخصوص العرض.</div>
    <label>الاسم *</label>
    <input type="text" id="guest_name">
    <label>رقم الجوال / واتساب *</label>
    <input type="text" id="guest_phone" placeholder="05xxxxxxxx">
    <button class="btn" id="guest_register_btn" style="margin-top:14px;width:100%">متابعة للتسعير</button>
  </div>`;
}

/* ---- admin login gate — password verified server-side (see adminPasswordGate) ---- */
let adminAuthed = false;

function renderAdminLogin(){
  return `<div class="card" style="max-width:360px;margin:40px auto">
    <h3>دخول لوحة التحكم</h3>
    <label>كلمة المرور</label>
    <input type="password" id="adm_pass">
    <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:13px;cursor:pointer">
      <input type="checkbox" id="adm_remember"> تذكرني على هذا الجهاز لمدة أسبوعين
    </label>
    <button class="btn" id="adm_login_btn" style="margin-top:14px;width:100%">دخول</button>
  </div>`;
}

function render(){
  if(!repAuthed && !guestMode && currentView!=='admin' && currentView!=='products' && currentView!=='portfolio' && currentView!=='ready' && currentView!=='ready-detail' && currentView!=='irrigation-quick'){ app.innerHTML = renderRepLogin(); wire(); return; }
  if(guestMode && !guestRegistered && currentView!=='admin' && currentView!=='products' && currentView!=='portfolio' && currentView!=='ready' && currentView!=='ready-detail' && currentView!=='irrigation-quick'){ app.innerHTML = renderGuestRegister(); wire(); return; }
  if(currentView==='calc') app.innerHTML = renderCalc();
  else if(currentView==='feas') app.innerHTML = renderFeas();
  else if(currentView==='ready') app.innerHTML = renderReadySystems();
  else if(currentView==='ready-detail') app.innerHTML = renderReadySystemDetail(deepLinkReadySystemId);
  else if(currentView==='products') app.innerHTML = renderProducts();
  else if(currentView==='irrigation-quick') app.innerHTML = renderIrrigationQuick();
  else if(currentView==='portfolio') app.innerHTML = renderPortfolio();
  else if(currentView==='admin' && !adminAuthed) app.innerHTML = renderAdminLogin();
  else app.innerHTML = renderAdmin();
  wire();
}

function wire(){
  if(!repAuthed && !guestMode && currentView!=='admin' && currentView!=='products' && currentView!=='portfolio' && currentView!=='ready' && currentView!=='ready-detail' && currentView!=='irrigation-quick'){
    document.getElementById('rep_login_btn').onclick = async ()=>{
      const username = document.getElementById('rep_user').value.trim();
      const password = document.getElementById('rep_pass').value;
      const remember = document.getElementById('rep_remember').checked;
      const errBox = document.getElementById('rep_login_err');
      try{
        const data = await callEngine('rep-login', { username, password, rememberMe: remember });
        repUsername = username; repTokenMem = data.token; repDisplayName = data.displayName; repAuthed = true;
        repPermissions = data.permissions || {};
        if(remember){
          localStorage.setItem(REP_REMEMBER_KEY, JSON.stringify({username, token:data.token, displayName:data.displayName, permissions:repPermissions, expiresAt: Date.now() + 14*24*3600*1000}));
          sessionStorage.removeItem('holoul_rep_session');
        } else {
          sessionStorage.setItem('holoul_rep_session', JSON.stringify({username, token:data.token, displayName:data.displayName, permissions:repPermissions}));
          localStorage.removeItem(REP_REMEMBER_KEY);
        }
        showRepBadge();
        refresh();
      }catch(e){
        errBox.textContent = e.message || 'بيانات الدخول غير صحيحة';
        errBox.style.display = 'block';
      }
    };
    document.getElementById('guestModeBtn').onclick = ()=>{
      guestMode = true;
      render();
    };
    return;
  }
  if(guestMode && !guestRegistered && currentView!=='admin' && currentView!=='products' && currentView!=='portfolio' && currentView!=='ready' && currentView!=='ready-detail' && currentView!=='irrigation-quick'){
    document.getElementById('guest_register_btn').onclick = ()=>{
      const name = document.getElementById('guest_name').value.trim();
      const phone = document.getElementById('guest_phone').value.trim();
      if(!name || !phone){ alert('من فضلك اكتب اسمك ورقم جوالك'); return; }
      state.client = name; state.clientPhone = phone;
      guestRegistered = true;
      showRepBadge();
      refresh();
    };
    return;
  }
  if(currentView==='admin' && !adminAuthed){
    document.getElementById('adm_login_btn').onclick = async ()=>{
      const p=document.getElementById('adm_pass').value;
      const remember = document.getElementById('adm_remember').checked;
      try{
        const loginData = await callEngine('admin-login', { adminPassword: p, rememberMe: remember });
        adminTokenMem = loginData.token;
        const data = await callEngine('admin-config', { adminToken: adminTokenMem });
        adminConfig = normalizeAdminConfig(data.config); adminAuthed = true;
        try{
          const repsData = await callEngine('admin-list-reps', { adminToken: adminTokenMem });
          adminReps = repsData.reps || [];
        }catch(e){ adminReps = []; }
        if(remember){
          localStorage.setItem(ADMIN_REMEMBER_KEY, JSON.stringify({token: adminTokenMem, expiresAt: Date.now() + 14*24*3600*1000}));
        } else {
          localStorage.removeItem(ADMIN_REMEMBER_KEY);
        }
        render();
      }catch(e){ adminTokenMem = null; alert('كلمة المرور غير صحيحة'); }
    };
    return;
  }
  if(currentView==='ready'){
    const retryBtn = document.getElementById('retryReadyBtn');
    if(retryBtn) retryBtn.onclick = ()=>{ readySystemsError=null; render(); };
    document.querySelectorAll('[data-readyviewmode]').forEach(b=>b.onclick=()=>{
      readyViewMode = b.dataset.readyviewmode;
      try{ localStorage.setItem('holoul_ready_view', readyViewMode); }catch(e){}
      render();
    });
    const backToProductsBtn = document.getElementById('backToProductsFromReadyBtn');
    if(backToProductsBtn) backToProductsBtn.onclick = ()=>{ window.goToView('products'); };
    document.querySelectorAll('[data-readydetail]').forEach(b=>b.onclick=()=>{
      openReadySystemDetail(+b.dataset.readydetail);
    });
    document.querySelectorAll('[data-readyquote]').forEach(b=>b.onclick=()=>{
      const id = +b.dataset.readyquote;
      const s = (cachedReadySystems||[]).find(x=>x.id===id);
      if(!s) return;
      const msg = `مرحبًا، أرغب في طلب عرض سعر للمنظومة التالية:\n${s.name} — ${fmt(s.priceSar)} ﷼\n\nHoloulEnergy — حلول الطاقة المتجددة والمقاولات`;
      window.open('https://wa.me/966561274344?text='+encodeURIComponent(msg), '_blank');
    });
    return;
  }
  if(currentView==='irrigation-quick'){
    const backBtn = document.getElementById('iqBackToProductsBtn');
    if(backBtn) backBtn.onclick = ()=>{ window.goToView('products'); };
    const hpSel = document.getElementById('iqHpSelect');
    if(hpSel) hpSel.onchange = e=>{ iqHp = +e.target.value; iqQuote=null; refreshIrrigationQuick(); };
    const retryBtn = document.getElementById('iqRetryBtn');
    if(retryBtn) retryBtn.onclick = ()=>{ iqError=null; refreshIrrigationQuick(); };
    const waBtn = document.getElementById('iqWhatsappBtn');
    if(waBtn) waBtn.onclick = ()=>{
      if(!iqQuote) return;
      const msg = `مرحبًا، أرغب في عرض سعر لمحطة تشغيل موتور/غاطس ري بالطاقة الشمسية:\nقدرة الموتور/الغاطس: ${iqHp} حصان\nنوع العرض: توريد خامات فقط\nالسعر التقديري: ${fmt(iqQuote.supplyOnlyTotal)} ﷼ (شامل الضريبة)\n\nHoloulEnergy — حلول الطاقة المتجددة والمقاولات`;
      window.open('https://wa.me/966561274344?text='+encodeURIComponent(msg), '_blank');
    };
    return;
  }
  if(currentView==='products'){
    const retryBtn = document.getElementById('retryProductsBtn');
    if(retryBtn) retryBtn.onclick = ()=>{ productCatalogError=null; render(); };
    document.querySelectorAll('[data-opencat]').forEach(el=>el.onclick=()=>{
      selectedCategoryIdx = +el.dataset.opencat;
      productsNav = 'category';
      resetCategoryFilters();
      render();
    });
    const sidebarAllCatsBtn = document.getElementById('sidebarAllCatsBtn');
    if(sidebarAllCatsBtn) sidebarAllCatsBtn.onclick = ()=>{ productsNav='categories'; selectedCategoryIdx=null; selectedProduct=null; resetCategoryFilters(); render(); };
    const backCatsBtn = document.getElementById('backToCategoriesBtn');
    if(backCatsBtn) backCatsBtn.onclick = ()=>{ productsNav='categories'; selectedCategoryIdx=null; resetCategoryFilters(); render(); };
    document.querySelectorAll('[data-viewmode]').forEach(b=>b.onclick=()=>{
      productViewMode = b.dataset.viewmode;
      try{ localStorage.setItem('holoul_product_view', productViewMode); }catch(e){}
      render();
    });
    document.querySelectorAll('[data-catviewmode]').forEach(b=>b.onclick=()=>{
      categoriesViewMode = b.dataset.catviewmode;
      try{ localStorage.setItem('holoul_categories_view', categoriesViewMode); }catch(e){}
      render();
    });
    const backCatBtn = document.getElementById('backToCategoryBtn');
    if(backCatBtn) backCatBtn.onclick = ()=>{ productsNav='category'; selectedProduct=null; render(); };
    const crumbAllCats = document.getElementById('crumbAllCats');
    if(crumbAllCats) crumbAllCats.onclick = ()=>{ productsNav='categories'; selectedCategoryIdx=null; selectedProduct=null; render(); };
    document.querySelectorAll('[data-viewproduct]').forEach(b=>b.onclick=()=>{
      const [ci,ri] = b.dataset.viewproduct.split(':').map(Number);
      selectedProduct = {catIdx:ci, rowIdx:ri};
      productsNav = 'detail';
      detailTab = 'description';
      render();
    });
    document.querySelectorAll('[data-detailtab]').forEach(b=>b.onclick=()=>{
      detailTab = b.dataset.detailtab;
      render();
    });
    document.querySelectorAll('[data-similar]').forEach(b=>b.onclick=()=>{
      const [ci,ri] = b.dataset.similar.split(':').map(Number);
      selectedProduct = {catIdx:ci, rowIdx:ri};
      detailTab = 'description';
      render();
      window.scrollTo({top:0, behavior:'smooth'});
    });
    const searchInput = document.getElementById('productSearch');
    if(searchInput){
      searchInput.oninput = e=>{
        categorySearchQuery = e.target.value;
        productsCurrentPage = 1;
        render();
      };
      searchInput.focus();
      const slen = searchInput.value.length;
      searchInput.setSelectionRange(slen, slen);
    }
    const sortSelect = document.getElementById('productSortSelect');
    if(sortSelect) sortSelect.onchange = e=>{ productSort = e.target.value; productsCurrentPage = 1; render(); };
    const perPageSelect = document.getElementById('productsPerPageSelect');
    if(perPageSelect) perPageSelect.onchange = e=>{
      productsPerPage = e.target.value==='all' ? Infinity : +e.target.value;
      productsCurrentPage = 1;
      render();
    };
    document.querySelectorAll('[data-brandfacet]').forEach(cb=>cb.onchange=e=>{
      const v = cb.dataset.brandfacet;
      if(e.target.checked) productBrandFilter.add(v); else productBrandFilter.delete(v);
      productsCurrentPage = 1;
      render();
    });
    document.querySelectorAll('[data-specfacet]').forEach(cb=>cb.onchange=e=>{
      const v = cb.dataset.specfacet;
      if(e.target.checked) productSpecFilter.add(v); else productSpecFilter.delete(v);
      productsCurrentPage = 1;
      render();
    });
    document.querySelectorAll('[data-clearchip]').forEach(chip=>chip.onclick=()=>{
      const kind = chip.dataset.clearchip, val = chip.dataset.chipvalue;
      if(kind==='search') categorySearchQuery = '';
      else if(kind==='brand') productBrandFilter.delete(val);
      else if(kind==='spec') productSpecFilter.delete(val);
      productsCurrentPage = 1;
      render();
    });
    ['clearCategoryFiltersBtn','clearCategoryFiltersBtn2'].forEach(id=>{
      const el = document.getElementById(id);
      if(el) el.onclick = ()=>{ resetCategoryFilters(); hideUnavailableProducts=false; render(); };
    });
    document.querySelectorAll('[data-pgpage]').forEach(b=>b.onclick=()=>{
      productsCurrentPage = +b.dataset.pgpage;
      render();
      window.scrollTo({top:0, behavior:'smooth'});
    });
    const pgPrevBtn = document.getElementById('pgPrevBtn');
    if(pgPrevBtn) pgPrevBtn.onclick = ()=>{ productsCurrentPage = Math.max(1, productsCurrentPage-1); render(); window.scrollTo({top:0, behavior:'smooth'}); };
    const pgNextBtn = document.getElementById('pgNextBtn');
    if(pgNextBtn) pgNextBtn.onclick = ()=>{ productsCurrentPage = productsCurrentPage+1; render(); window.scrollTo({top:0, behavior:'smooth'}); };
    document.querySelectorAll('[data-requestquote]').forEach(b=>b.onclick=()=>{
      const [ci,ri] = b.dataset.requestquote.split(':').map(Number);
      const cat = buildCatalogWithPanels(cachedProductCatalog || [])[ci];
      const row = cat && cat.rows[ri];
      if(!row) return;
      const msg = `مرحبًا، أرغب في طلب عرض سعر للمنتج التالي:\n${row[0]} (${cat.category})\n\nHoloulEnergy — حلول الطاقة المتجددة والمقاولات`;
      window.open('https://wa.me/966561274344?text='+encodeURIComponent(msg), '_blank');
    });
    document.querySelectorAll('[data-carttoggle]').forEach(cb=>cb.onchange=()=>{
      const [ci,ri] = cb.dataset.carttoggle.split(':').map(Number);
      const cat = buildCatalogWithPanels(cachedProductCatalog || [])[ci];
      if(!cat) return;
      cartToggle(cat, ci, ri);
      render();
    });
    const cartBarToggleBtn = document.getElementById('cartBarToggleBtn');
    if(cartBarToggleBtn) cartBarToggleBtn.onclick = ()=>{ cartPanelOpen = !cartPanelOpen; render(); };
    const cartPanelCloseBtn = document.getElementById('cartPanelCloseBtn');
    if(cartPanelCloseBtn) cartPanelCloseBtn.onclick = ()=>{ cartPanelOpen = false; render(); };
    document.querySelectorAll('[data-cartremove]').forEach(b=>b.onclick=()=>{
      productCart.splice(+b.dataset.cartremove, 1);
      if(!productCart.length) cartPanelOpen = false;
      render();
    });
    document.querySelectorAll('[data-cartqtyinc]').forEach(b=>b.onclick=()=>{
      const idx = +b.dataset.cartqtyinc;
      if(productCart[idx]) cartSetQty(idx, (productCart[idx].qty||1) + 1);
      render();
    });
    document.querySelectorAll('[data-cartqtydec]').forEach(b=>b.onclick=()=>{
      const idx = +b.dataset.cartqtydec;
      if(productCart[idx]) cartSetQty(idx, (productCart[idx].qty||1) - 1);
      render();
    });
    document.querySelectorAll('[data-cartqtyinput]').forEach(inp=>inp.onchange=()=>{
      const idx = +inp.dataset.cartqtyinput;
      cartSetQty(idx, inp.value);
      render();
    });
    const cartClearBtn = document.getElementById('cartClearBtn');
    if(cartClearBtn) cartClearBtn.onclick = ()=>{ productCart = []; cartPanelOpen = false; render(); };
    const cartPrepareQuoteBtn = document.getElementById('cartPrepareQuoteBtn');
    if(cartPrepareQuoteBtn) cartPrepareQuoteBtn.onclick = ()=>{
      if(!repAuthed){ alert('تجهيز عرض سعر رسمي متاح للمناديب المسجّلين دخولهم فقط.'); return; }
      cartQuoteView = true; cartPanelOpen = false;
      render();
      window.scrollTo({top:0, behavior:'smooth'});
    };
    const cartQuoteBackBtn = document.getElementById('cartQuoteBackBtn');
    if(cartQuoteBackBtn) cartQuoteBackBtn.onclick = ()=>{ cartQuoteView = false; render(); };
    const cartQuoteClientName = document.getElementById('cartQuoteClientName');
    if(cartQuoteClientName) cartQuoteClientName.oninput = e=>{ cartClientName = e.target.value; };
    const cartQuoteClientPhone = document.getElementById('cartQuoteClientPhone');
    if(cartQuoteClientPhone) cartQuoteClientPhone.oninput = e=>{ cartClientPhone = e.target.value; };
    const cartRequestQuoteBtn = document.getElementById('cartRequestQuoteBtn');
    if(cartRequestQuoteBtn) cartRequestQuoteBtn.onclick = ()=>{
      const { subtotal, vat, total } = cartTotals();
      const lines = productCart.map((c,i)=>`${i+1}. ${c.name} (${c.category}) — الكمية: ${c.qty} × ${c.price} ﷼ = ${(c.price*c.qty).toLocaleString('en-US')} ﷼`).join('\n');
      const msg = `مرحبًا، أرغب في طلب عرض سعر للمنتجات التالية:\n\n${lines}\n\nالإجمالي بدون ضريبة: ${subtotal.toLocaleString('en-US',{maximumFractionDigits:2})} ﷼\nضريبة القيمة المضافة (15%): ${vat.toLocaleString('en-US',{maximumFractionDigits:2})} ﷼\nالإجمالي شامل الضريبة: ${total.toLocaleString('en-US',{maximumFractionDigits:2})} ﷼\n\nHoloulEnergy — حلول الطاقة المتجددة والمقاولات`;
      window.open('https://wa.me/966561274344?text='+encodeURIComponent(msg), '_blank');
    };
    const globalSearchInput = document.getElementById('productGlobalSearch');
    if(globalSearchInput){
      globalSearchInput.oninput = e=>{ productsGlobalSearch = e.target.value; render(); };
      globalSearchInput.focus();
      const len = globalSearchInput.value.length;
      globalSearchInput.setSelectionRange(len, len);
    }
    const hideUnavailToggle = document.getElementById('hideUnavailableToggle');
    if(hideUnavailToggle) hideUnavailToggle.onchange = e=>{ hideUnavailableProducts = e.target.checked; render(); };
    const shareBtn = document.getElementById('shareProductLinkBtn');
    if(shareBtn) shareBtn.onclick = async ()=>{
      const url = `${window.location.origin}${window.location.pathname}?product=${shareBtn.dataset.shareproduct}`;
      try{
        await navigator.clipboard.writeText(url);
        shareBtn.textContent = '✓ تم نسخ الرابط';
      }catch(e){
        shareBtn.textContent = url;
      }
      setTimeout(()=>{ shareBtn.textContent = '🔗 نسخ رابط المنتج'; }, 2000);
    };
    return;
  }
  if(currentView==='portfolio'){
    const retryPfBtn = document.getElementById('retryPortfolioBtn');
    if(retryPfBtn) retryPfBtn.onclick = ()=>{ portfolioError=null; render(); };
    return;
  }
  if(currentView==='calc'){
    document.querySelectorAll('[data-calcsys]').forEach(b=>b.onclick=()=>{
      state.calcSystem = b.dataset.calcsys;
      if(state.calcSystem==='offgrid' && !cachedOffgridQuote && !offgridLoading) refreshOffgrid();
      if(state.calcSystem==='ongrid' && !cachedOngridQuote && !ongridLoading) refreshOngrid();
      render();
    });
  }
  if(currentView==='calc' && state.calcSystem==='offgrid'){
    wireOffgridCalc();
    return;
  }
  if(currentView==='calc' && state.calcSystem==='ongrid'){
    wireOngridCalc();
    return;
  }
  if(currentView==='calc' && !currentQuote()){
    const retryBtn = document.getElementById('retryLoad');
    if(retryBtn) retryBtn.onclick = ()=>refresh();
    return;
  }
  if(currentView==='calc'){
    document.getElementById('in_client').oninput = e=>{state.client=e.target.value; document.getElementById('bannerName').textContent=state.client||'—'; debouncedUpdatePrevLeadBox();};
    document.getElementById('in_phone').oninput = e=>{state.clientPhone=e.target.value; document.getElementById('bannerPhone').textContent=state.clientPhone||'—'; debouncedUpdatePrevLeadBox();};
    updatePrevLeadBox();
    const confirmHp = ()=>{ state.hp = +document.getElementById('in_hp').value || 1; scheduleRefresh(); };
    document.getElementById('hp_confirm').onclick = confirmHp;
    document.getElementById('in_hp').onkeydown = e=>{ if(e.key==='Enter') confirmHp(); };
    document.getElementById('in_panel').onchange = e=>{state.panelIdx=+e.target.value; scheduleRefresh();};
    const confirmAdv = ()=>{
      state.panelsPerStringAdjust = +document.getElementById('in_pps').value || 0;
      state.stringsAdjust = +document.getElementById('in_str').value || 0;
      state.inverterPowerIncrease = +document.getElementById('in_invinc').value || 0;
      scheduleRefresh();
    };
    document.getElementById('adv_confirm').onclick = confirmAdv;
    ['in_pps','in_str','in_invinc'].forEach(id=>{
      document.getElementById(id).onkeydown = e=>{ if(e.key==='Enter') confirmAdv(); };
    });
    const discSel = document.getElementById('in_discount');
    if(discSel) discSel.onchange = e=>{ state.discountOverrideIdx=+e.target.value; scheduleRefresh(); };
    const confirmSpecialDiscount = ()=>{
      const el = document.getElementById('in_specialdiscount');
      if(!el) return;
      state.specialDiscountAmt = +el.value || 0;
      scheduleRefresh();
    };
    const specBtn = document.getElementById('specialdiscount_confirm');
    if(specBtn) specBtn.onclick = confirmSpecialDiscount;
    const specInput = document.getElementById('in_specialdiscount');
    if(specInput) specInput.onkeydown = e=>{ if(e.key==='Enter') confirmSpecialDiscount(); };
    const unlockBtn = document.getElementById('unlockDiscount');
    if(unlockBtn) unlockBtn.onclick = ()=>adminPasswordGate(()=>{ discountUnlocked=true; scheduleRefresh(); });
    document.querySelectorAll('[data-tgl]').forEach(c=>c.onchange=()=>{state.toggles[c.dataset.tgl]=c.checked; scheduleRefresh();});
    document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{
      if(b.dataset.preset==='materials'){
        state.toggles = {panel:true, inverter:true, ip65:false, combiner:true, cables:true, mc4:true,
                          structure:false, concrete:false, earth:false, reactor:false, civilworks:false, elecworks:false, supply:false};
      } else {
        state.toggles = {panel:true, inverter:true, ip65:true, combiner:true, cables:true, mc4:true,
                          structure:true, concrete:true, earth:false, reactor:false, civilworks:true, elecworks:true, supply:true};
      }
      scheduleRefresh();
    });
    const unlockInfoBtn = document.getElementById('adminInfoTrigger');
    if(unlockInfoBtn && !adminInfoUnlocked) unlockInfoBtn.onclick = ()=>adminPasswordGate(()=>{ adminInfoUnlocked=true; scheduleRefresh(); });
    const lockInfoBtn = document.getElementById('lockAdminInfo');
    if(lockInfoBtn) lockInfoBtn.onclick = ()=>{ adminInfoUnlocked=false; render(); };
  }
  if(currentView==='feas'){
    const map = {f_psh:'psh',f_deg:'panelDegradationPct',f_gridp:'gridPrice',f_gride:'gridEscalationPct',
                 f_dp:'dieselPrice',f_dc:'dieselConsumptionPerKWh',f_de:'dieselEscalationPct',f_om:'solarOMPctOfCapex'};
    Object.keys(map).forEach(id=>{
      const el=document.getElementById(id);
      if(el) el.oninput = ()=>{ feasOverrides[map[id]] = +el.value; render(); };
    });
  }
  if(currentView==='admin'){
    const admSectionTitles = {overview:'نظرة عامة',discounts:'الخصومات',pricing:'الأسعار والهوامش',calcs:'حاسبات الأنظمة',products:'المنتجات والكتالوج',portfolio:'البورتفوليو',leads:'قاعدة العملاء',reps:'إدارة المناديب',security:'الحماية والنظام'};
    function goToAdminSection(id){
      if(id === 'leads'){ window.location.href = 'crm.html'; return; }
      currentAdminSection = id;
      document.querySelectorAll('.admin-nav-btn').forEach(b=>b.classList.toggle('active', b.dataset.admsec===id));
      document.querySelectorAll('.admsec').forEach(s=>s.classList.toggle('active', s.dataset.admsec===id));
      const t = document.getElementById('admTopbarTitle'); if(t) t.textContent = admSectionTitles[id] || id;
      const main = document.querySelector('.admin-main'); if(main) main.scrollIntoView({behavior:'smooth', block:'start'});
    }
    document.querySelectorAll('.admin-nav-btn').forEach(b=>{ b.onclick = ()=>goToAdminSection(b.dataset.admsec); });
    document.querySelectorAll('[data-admsec-jump]').forEach(b=>{ b.onclick = ()=>goToAdminSection(b.dataset.admsecJump); });
    document.querySelectorAll('.admsub-nav-btn').forEach(b=>{
      b.onclick = ()=>{
        const parent = b.dataset.admsubparent, sub = b.dataset.admsub;
        currentAdminSubSection[parent] = sub;
        const shell = b.closest('.admsub-shell');
        if(shell){
          shell.querySelectorAll('.admsub-nav-btn').forEach(x=>x.classList.toggle('active', x.dataset.admsub===sub));
          shell.querySelectorAll('.admsubsec').forEach(x=>x.classList.toggle('active', x.dataset.admsub===sub));
        }
      };
    });
    const admLogoutSide = document.getElementById('adm_logout_side');
    if(admLogoutSide) admLogoutSide.onclick = ()=>document.getElementById('adm_logout').click();
    const admSaveTop = document.getElementById('admSaveTop');
    if(admSaveTop) admSaveTop.onclick = ()=>document.getElementById('admSave').click();

    // --- الخصومات (discounts) section ---
    const discCategoryEl = document.getElementById('disc_category');
    if(discCategoryEl){
      discCategoryEl.onchange = ()=>{
        discountFormState.category = discCategoryEl.value;
        discountFormState.brand = '';
        discountFormState.editKey = null;
        render();
      };
      document.getElementById('disc_brand').onchange = (e)=>{ discountFormState.brand = e.target.value; };
      const cancelBtn = document.getElementById('disc_cancel_edit');
      if(cancelBtn) cancelBtn.onclick = ()=>{
        discountFormState = { category: discCategoryEl.value, brand:'', supplierDiscountPct:0, sellDiscountPct:0, promoDiscountPct:0, promoActive:false, editKey:null };
        render();
      };
      document.getElementById('disc_save_btn').onclick = ()=>{
        const category = document.getElementById('disc_category').value;
        const brand = document.getElementById('disc_brand').value;
        const supplierDiscountPct = +document.getElementById('disc_supplier').value || 0;
        const sellDiscountPct = +document.getElementById('disc_sell').value || 0;
        const promoDiscountPct = +document.getElementById('disc_promo').value || 0;
        const promoActive = document.getElementById('disc_promo_active').checked;
        if(!category || !brand){ alert('اختار الفئة والماركة أولًا'); return; }
        if(sellDiscountPct > supplierDiscountPct){
          alert('خصم البيع لازم يكون أقل من أو يساوي خصم المورد (عشان الشركة متبيعش بخسارة)'); return;
        }
        adminConfig.discounts = adminConfig.discounts || [];
        const existingIdx = adminConfig.discounts.findIndex(d=>d.category===category && d.brand===brand);
        const row = { category, brand, supplierDiscountPct, sellDiscountPct, promoDiscountPct, promoActive };
        if(existingIdx > -1) adminConfig.discounts[existingIdx] = row; else adminConfig.discounts.push(row);
        discountFormState = { category, brand:'', supplierDiscountPct:0, sellDiscountPct:0, promoDiscountPct:0, promoActive:false, editKey:null };
        callEngine('update-config', { adminToken: adminTokenMem, config: adminConfig }).then(()=>{
          alert('تم حفظ الخصم ✔'); render();
        }).catch(err=>alert('تعذر الحفظ: '+err.message));
      };
      document.querySelectorAll('[data-disc-edit]').forEach(b=>b.onclick=()=>{
        const d = adminConfig.discounts[+b.dataset.discEdit];
        if(!d) return;
        discountFormState = { category: d.category, brand: d.brand, supplierDiscountPct: d.supplierDiscountPct||0, sellDiscountPct: d.sellDiscountPct||0, promoDiscountPct: d.promoDiscountPct||0, promoActive: !!d.promoActive, editKey: d.category+'|'+d.brand };
        render();
      });
      document.querySelectorAll('[data-disc-del]').forEach(b=>b.onclick=()=>{
        const idx = +b.dataset.discDel;
        const d = adminConfig.discounts[idx]; if(!d) return;
        if(!confirm(`متأكد من حذف خصم (${d.category} / ${d.brand})؟`)) return;
        adminConfig.discounts.splice(idx,1);
        callEngine('update-config', { adminToken: adminTokenMem, config: adminConfig }).then(()=>{ render(); }).catch(err=>alert('تعذر الحذف: '+err.message));
      });
      document.querySelectorAll('[data-disc-clearpromo]').forEach(b=>b.onclick=()=>{
        const idx = +b.dataset.discClearpromo;
        const d = adminConfig.discounts[idx]; if(!d) return;
        d.promoActive = false;
        callEngine('update-config', { adminToken: adminTokenMem, config: adminConfig }).then(()=>{ render(); }).catch(err=>alert('تعذر الحفظ: '+err.message));
      });
    }

    document.getElementById('addRepBtn').onclick = async ()=>{
      const username = document.getElementById('newrep_username').value.trim();
      const displayName = document.getElementById('newrep_displayname').value.trim();
      const password = document.getElementById('newrep_password').value;
      if(!username || !displayName || !password){ alert('من فضلك أدخل اسم المستخدم والاسم الظاهر وكلمة المرور'); return; }
      try{
        await callEngine('admin-save-rep', { adminToken: adminTokenMem, username, displayName, password, active:true });
        const repsData = await callEngine('admin-list-reps', { adminToken: adminTokenMem });
        adminReps = repsData.reps || [];
        render();
      }catch(e){ alert('تعذرت الإضافة: '+e.message); }
    };
    document.getElementById('saveRepsBtn').onclick = async ()=>{
      const rows = {};
      const checkboxFields = ['active','perm_pricing','perm_calcs','perm_products','perm_portfolio'];
      document.querySelectorAll('[data-repid]').forEach(inp=>{
        const id = inp.dataset.repid, f = inp.dataset.rf;
        rows[id] = rows[id] || {};
        rows[id][f] = checkboxFields.includes(f) ? inp.checked : inp.value;
      });
      try{
        for(const id of Object.keys(rows)){
          const r = rows[id];
          const permissions = { pricing:!!r.perm_pricing, calcs:!!r.perm_calcs, products:!!r.perm_products, portfolio:!!r.perm_portfolio };
          const payload = { adminToken: adminTokenMem, id:+id, username:r.username, displayName:r.displayName, active:r.active, permissions };
          if(r.password) payload.password = r.password;
          await callEngine('admin-save-rep', payload);
        }
        const repsData = await callEngine('admin-list-reps', { adminToken: adminTokenMem });
        adminReps = repsData.reps || [];
        alert('تم حفظ تعديلات المناديب ✔');
        render();
      }catch(e){ alert('تعذر الحفظ: '+e.message); }
    };
    document.querySelectorAll('[data-delrep]').forEach(b=>b.onclick=async ()=>{
      if(!confirm('حذف هذا المندوب نهائيًا؟')) return;
      try{
        await callEngine('admin-delete-rep', { adminToken: adminTokenMem, id:+b.dataset.delrep });
        const repsData = await callEngine('admin-list-reps', { adminToken: adminTokenMem });
        adminReps = repsData.reps || [];
        render();
      }catch(e){ alert('تعذر الحذف: '+e.message); }
    });
    function harvestAdminInputs(){
      document.querySelectorAll('[data-p]').forEach(inp=>{
        const i=+inp.dataset.p, f=inp.dataset.f;
        adminConfig.panels[i][f] = (f==='brand') ? inp.value : +inp.value;
      });
      document.querySelectorAll('[data-pvis]').forEach(inp=>{
        adminConfig.panels[+inp.dataset.pvis].visible = inp.checked;
      });
      const defPanelRadio = document.querySelector('[data-defpanel]:checked');
      if(defPanelRadio){
        const p = adminConfig.panels[+defPanelRadio.dataset.defpanel];
        if(p) adminConfig.defaultPanelKey = `${p.brand}|${p.power}`;
      }
      delete adminConfig.inverters;
      delete adminConfig.inverterBrands;
      delete adminConfig.defaultInverterBrand;
      document.querySelectorAll('[data-pcat]').forEach(inp=>{
        adminConfig.productCatalog[+inp.dataset.pcat].category = inp.value;
      });
      document.querySelectorAll('[data-pinfo]').forEach(inp=>{
        adminConfig.productCatalog[+inp.dataset.pinfo].categoryInfo = inp.value;
      });
      document.querySelectorAll('[data-pcol]').forEach(inp=>{
        const [ci,coli] = inp.dataset.pcol.split(':').map(Number);
        adminConfig.productCatalog[ci].columns[coli] = inp.value;
      });
      document.querySelectorAll('[data-pcell]').forEach(inp=>{
        const [ci,ri,coli] = inp.dataset.pcell.split(':').map(Number);
        adminConfig.productCatalog[ci].rows[ri][coli] = inp.value;
      });
      document.querySelectorAll('[data-pavail]').forEach(inp=>{
        const [ci,ri] = inp.dataset.pavail.split(':').map(Number);
        const cat = adminConfig.productCatalog[ci];
        cat.productDetails = cat.productDetails || {};
        cat.productDetails[ri] = { ...(cat.productDetails[ri]||{}), available: inp.checked };
      });
      document.querySelectorAll('[data-d]').forEach(inp=>{
        const i=+inp.dataset.d, f=inp.dataset.f;
        adminConfig.discountTiers[i][f] = (f==='label') ? inp.value : +inp.value;
      });
      if(adminConfig.portfolio){
        const pf = adminConfig.portfolio;
        const heroTitleEl = document.getElementById('pf_hero_title');
        if(heroTitleEl){
          pf.hero = pf.hero || {};
          pf.hero.title = heroTitleEl.value;
          pf.hero.description = document.getElementById('pf_hero_desc').value;
          pf.panelTitle = document.getElementById('pf_panel_title').value;
          pf.panelNote = document.getElementById('pf_panel_note').value;
          pf.projectsTitle = document.getElementById('pf_proj_title').value;
          pf.projectsTag = document.getElementById('pf_proj_tag').value;
        }
        document.querySelectorAll('[data-pfkpi]').forEach(inp=>{
          const i=+inp.dataset.pfkpi; pf.kpis[i][inp.dataset.f] = inp.value;
        });
        document.querySelectorAll('[data-pftl]').forEach(inp=>{
          const i=+inp.dataset.pftl; pf.timeline[i][inp.dataset.f] = inp.value;
        });
        document.querySelectorAll('[data-pfcap]').forEach(inp=>{
          const i=+inp.dataset.pfcap; pf.capabilitySteps[i][inp.dataset.f] = inp.value;
        });
        document.querySelectorAll('[data-pfproj]').forEach(inp=>{
          const i=+inp.dataset.pfproj, f=inp.dataset.f;
          pf.projects[i][f] = (f==='tags') ? inp.value.split(',').map(s=>s.trim()).filter(Boolean) : inp.value;
        });
        document.querySelectorAll('[data-pfroi]').forEach(inp=>{
          const i=+inp.dataset.pfroi; pf.roiCases[i][inp.dataset.f] = inp.value;
        });
        document.querySelectorAll('[data-pfpartner]').forEach(inp=>{
          const i=+inp.dataset.pfpartner; pf.partners[i][inp.dataset.f] = inp.value;
        });
      }
      const num = id => { const el=document.getElementById(id); return el ? +el.value : undefined; };
      const setIfNum = (key,id) => { const v=num(id); if(v!==undefined && !isNaN(v)) adminConfig[key]=v; };
      setIfNum('hpCapacityRatio','a_hpratio');
      setIfNum('vat','a_vat');
      setIfNum('panelMarginPerWatt','a_panelmargin');
      setIfNum('cableHighMultiplier','a_cablehigh');
      setIfNum('cableLowMultiplier','a_cablelow');
      setIfNum('cableMarkup','a_cablemarkup');
      setIfNum('flexTubePerUnit','a_flex');
      setIfNum('combinerHeadroom','a_combheadroom');
      setIfNum('combinerMinSpareStrings','a_combspare');
      setIfNum('structurePriceFixed','a_stfix');
      setIfNum('structurePriceRotational','a_strot');
      setIfNum('concretePerUnit','a_conc');
      setIfNum('earthingPerUnit','a_earth');
      setIfNum('steelPanelPerHP','a_steel');
      setIfNum('mechInstallPerPanel','a_mechinst');
      setIfNum('elecInstallPerPanel','a_elecinst');
      setIfNum('transportPerTrip','a_trans');
      setIfNum('transportMinimum','a_transmin');
      setIfNum('defaultDiscountIdx','a_defdisc');
      const numOG = id => { const el=document.getElementById(id); return el ? +el.value : undefined; };
      const setOG = (key,id) => { const v=numOG(id); if(v!==undefined && !isNaN(v)) adminConfig.offgrid[key]=v; };
      setOG('sunHours','a_og_sun'); setOG('systemEfficiency','a_og_eff'); setOG('batteryDoD','a_og_dod');
      setOG('defaultAutonomyDays','a_og_autonomy'); setOG('batteryMarkupPct','a_og_batmarkup'); setOG('inverterMarkupPct','a_og_invmarkup');
      setOG('structurePerPanelCost','a_og_strcost'); setOG('structurePerPanelSell','a_og_strsell');
      setOG('cablingFixedCost','a_og_cabcost'); setOG('cablingFixedSell','a_og_cabsell');
      setOG('installPerKwCost','a_og_instcost'); setOG('installPerKwSell','a_og_instsell');
      if(!adminConfig.offgrid.appliancePresets || !adminConfig.offgrid.appliancePresets.length){
        adminConfig.offgrid.appliancePresets = OFFGRID_APPLIANCE_PRESETS.map(p=>({...p}));
      }
      document.querySelectorAll('[data-oga]').forEach(inp=>{
        const i=+inp.dataset.oga, f=inp.dataset.af;
        adminConfig.offgrid.appliancePresets[i][f] = (f==='name') ? inp.value : (+inp.value||0);
      });
      const setNG = (key,id) => { const v=numOG(id); if(v!==undefined && !isNaN(v)) adminConfig.ongrid[key]=v; };
      setNG('sunHours','a_ng_sun'); setNG('performanceRatio','a_ng_pr'); setNG('tariffRate','a_ng_tariff');
      setNG('inverterMarkupPct','a_ng_invmarkup');
      setNG('structurePerPanelCost','a_ng_strcost'); setNG('structurePerPanelSell','a_ng_strsell');
      setNG('cablingFixedCost','a_ng_cabcost'); setNG('cablingFixedSell','a_ng_cabsell');
      setNG('netMeteringFeeCost','a_ng_netcost'); setNG('netMeteringFeeSell','a_ng_netsell');
      setNG('installPerKwCost','a_ng_instcost'); setNG('installPerKwSell','a_ng_instsell');
      document.querySelectorAll('[data-readysys]').forEach(inp=>{
        const i=+inp.dataset.readysys, f=inp.dataset.rf;
        const sys = adminConfig.readyOffgridSystems[i];
        if(!sys) return;
        if(f==='priceSar' || f==='panelCount' || f==='batteryCount') sys[f] = +inp.value || 0;
        else if(f==='inverterModel') sys[f] = inp.value || null;
        else sys[f] = inp.value;
      });
      const webhookEl = document.getElementById('a_webhook');
      if(webhookEl) adminConfig.leadsWebhookUrl = webhookEl.value.trim();
    }

    document.querySelectorAll('[data-recompute-readysys]').forEach(btn=>{
      btn.onclick = async ()=>{
        const i = +btn.dataset.recomputeReadysys;
        harvestAdminInputs();
        const sys = adminConfig.readyOffgridSystems[i];
        const noteEl = document.getElementById(`readysys-recompute-note-${i}`);
        btn.disabled = true; if(noteEl) noteEl.textContent = 'جارِ الحساب...';
        try{
          const res = await callEngine('recompute-ready-system-price', {
            adminToken: adminTokenMem,
            input: { panelCount: sys.panelCount, inverterModel: sys.inverterModel, batteryModel: sys.batteryModel, batteryCount: sys.batteryCount },
          });
          if(res.error){ if(noteEl) noteEl.textContent = 'خطأ: '+res.error; }
          else{
            sys.priceSar = res.priceSar;
            const priceInput = document.querySelector(`input[data-readysys="${i}"][data-rf="priceSar"]`);
            if(priceInput) priceInput.value = res.priceSar;
            if(noteEl) noteEl.textContent = `تم — السعر الجديد ${fmt(res.priceSar)} ﷼ (لسه لازم تضغط "حفظ التعديلات" عشان يتفعّل)`;
          }
        }catch(e){ if(noteEl) noteEl.textContent = 'تعذر الاتصال بالخادم'; }
        btn.disabled = false;
      };
    });

    document.querySelectorAll('[data-deloga]').forEach(b=>b.onclick=()=>{
      harvestAdminInputs();
      adminConfig.offgrid.appliancePresets.splice(+b.dataset.deloga,1);
      render();
    });
    const addApplPresetBtn = document.getElementById('addApplPresetBtn');
    if(addApplPresetBtn) addApplPresetBtn.onclick = ()=>{
      harvestAdminInputs();
      adminConfig.offgrid.appliancePresets.push({name:'جهاز جديد', watts:100, dayHours:2, nightHours:2, surgeMultiplier:1});
      render();
    };

    document.getElementById('admSave').onclick = async ()=>{
      harvestAdminInputs();
      try{
        await callEngine('update-config', { adminToken: adminTokenMem, config: adminConfig });
        alert('تم حفظ التعديلات ✔');
        await refreshQuote();
      }catch(e){ alert('تعذر الحفظ: '+e.message); }
      render();
    };
    if(currentAdminSection==='leads' && !cachedCustomers && !customersLoading && !customersError) loadCustomers();
    const custSearch = document.getElementById('customerSearch');
    if(custSearch) custSearch.oninput = e=>{ customerSearchQuery = e.target.value; render(); };
    const custRetry = document.getElementById('customersRetryBtn');
    if(custRetry) custRetry.onclick = ()=>loadCustomers(true);
    const custBack = document.getElementById('custBackBtn');
    if(custBack) custBack.onclick = ()=>{ customerDetail=null; render(); };
    document.querySelectorAll('[data-custid-open]').forEach(b=>b.onclick=(e)=>{ e.stopPropagation(); openCustomerDetail(+b.dataset.custidOpen); });
    document.querySelectorAll('.customer-row').forEach(row=>row.onclick=()=>openCustomerDetail(+row.dataset.custid));
    if(!overviewStats && !overviewStatsLoading && !overviewStatsError) loadOverviewStats();
    document.getElementById('adm_changecred').onclick = async ()=>{
      const np=document.getElementById('adm_newpass').value;
      if(!np){ alert('اكتب كلمة مرور جديدة أولاً'); return; }
      try{
        const data = await callEngine('change-admin-password', { adminToken: adminTokenMem, newPassword: np });
        adminTokenMem = data.token; // server rotates the session; old tokens elsewhere are now invalid
        if(localStorage.getItem(ADMIN_REMEMBER_KEY)) localStorage.setItem(ADMIN_REMEMBER_KEY, JSON.stringify({token: adminTokenMem, expiresAt: Date.now() + 14*24*3600*1000}));
        alert('تم تحديث كلمة المرور ✔');
      }catch(e){ alert('تعذر التحديث: '+e.message); }
      render();
    };
    document.getElementById('adm_logout').onclick = ()=>{
      adminAuthed = false; adminTokenMem = null; adminConfig = null; currentView='calc';
      localStorage.removeItem(ADMIN_REMEMBER_KEY);
      document.querySelectorAll('nav.tabs button').forEach(b=>b.classList.remove('active'));
      document.querySelector('[data-view="calc"]').classList.add('active');
      render();
    };
    document.getElementById('addPanel').onclick = ()=>{
      harvestAdminInputs();
      adminConfig.panels.push({brand:'جديد',power:600,vimp:40,voc:48,iimp:15,isc:16,priceW:0.5,visible:true});
      render();
    };
    document.querySelectorAll('[data-delpanel]').forEach(b=>b.onclick=()=>{
      harvestAdminInputs();
      adminConfig.panels.splice(+b.dataset.delpanel,1); render();
    });
    const splitBtn = document.getElementById('splitAccessoriesBtn');
    if(splitBtn) splitBtn.onclick = ()=>{
      harvestAdminInputs();
      const idx = adminConfig.productCatalog.findIndex(c=>c.category.includes('إكسسوارات'));
      if(idx<0) return;
      const src = adminConfig.productCatalog[idx];
      const groups = [
        { name:'الريأكتور (Reactor)', test: n => /reactor/i.test(n) },
        { name:'صناديق التجميع (Combiner Box)', test: n => /combiner/i.test(n) },
        { name:'الكابلات والوصلات (MC4)', test: n => /mc4/i.test(n) },
        { name:'قواطع وفيوزات DC', test: n => /mccb|fuse|holder/i.test(n) },
      ];
      const newCats = groups.map(g => ({ category: g.name, categoryInfo:'', categoryImage:'', columns:[...src.columns], rows:[], productDetails:{} }));
      const leftoverRows = [];
      src.rows.forEach((row,ri)=>{
        const detail = (src.productDetails||{})[ri];
        const gi = groups.findIndex(g=>g.test(row[0]));
        if(gi>=0){
          const target = newCats[gi];
          target.rows.push(row);
          if(detail) target.productDetails[target.rows.length-1] = detail;
        } else {
          leftoverRows.push({row, detail});
        }
      });
      adminConfig.productCatalog.splice(idx, 1, ...newCats.filter(c=>c.rows.length));
      if(leftoverRows.length){
        const leftoverCat = { category: src.category, categoryInfo: src.categoryInfo||'', categoryImage: src.categoryImage||'', columns:[...src.columns], rows:[], productDetails:{} };
        leftoverRows.forEach(({row,detail})=>{
          leftoverCat.rows.push(row);
          if(detail) leftoverCat.productDetails[leftoverCat.rows.length-1] = detail;
        });
        adminConfig.productCatalog.push(leftoverCat);
      }
      render();
      alert('تم التقسيم — راجع الفئات الجديدة واضغط "حفظ التعديلات" لتثبيتها.');
    };
    document.getElementById('addProductCategory').onclick = ()=>{
      harvestAdminInputs();
      adminConfig.productCatalog.push({category:'فئة جديدة', columns:['الصنف','السعر'], rows:[]});
      render();
    };
    document.querySelectorAll('[data-delcat]').forEach(b=>b.onclick=()=>{
      harvestAdminInputs();
      adminConfig.productCatalog.splice(+b.dataset.delcat,1); render();
    });
    document.querySelectorAll('[data-addrow]').forEach(b=>b.onclick=()=>{
      harvestAdminInputs();
      openAddProductModal(+b.dataset.addrow);
    });
    document.querySelectorAll('[data-addcol]').forEach(b=>b.onclick=()=>{
      harvestAdminInputs();
      const cat = adminConfig.productCatalog[+b.dataset.addcol];
      cat.columns.push('عمود جديد');
      cat.rows.forEach(r=>r.push(''));
      render();
    });
    document.querySelectorAll('[data-delrow]').forEach(b=>b.onclick=()=>{
      harvestAdminInputs();
      const [ci,ri] = b.dataset.delrow.split(':').map(Number);
      adminConfig.productCatalog[ci].rows.splice(ri,1);
      render();
    });

    // ---- portfolio: add/delete rows for each editable list ----
    if(adminConfig.portfolio){
      const pf = adminConfig.portfolio;
      const addPfBtn = document.querySelector('[data-addpfkpi]');
      if(addPfBtn) addPfBtn.onclick = ()=>{ harvestAdminInputs(); pf.kpis.push({v:'',l:''}); render(); };
      document.querySelectorAll('[data-delpfkpi]').forEach(b=>b.onclick=()=>{ harvestAdminInputs(); pf.kpis.splice(+b.dataset.delpfkpi,1); render(); });

      const addTlBtn = document.querySelector('[data-addpftl]');
      if(addTlBtn) addTlBtn.onclick = ()=>{ harvestAdminInputs(); pf.timeline.push({label:'',title:'',desc:'',image:null}); render(); };
      document.querySelectorAll('[data-delpftl]').forEach(b=>b.onclick=()=>{ harvestAdminInputs(); pf.timeline.splice(+b.dataset.delpftl,1); render(); });
      document.querySelectorAll('[data-delpftlimg]').forEach(b=>b.onclick=()=>{ harvestAdminInputs(); pf.timeline[+b.dataset.delpftlimg].image = null; render(); });

      const addCapBtn = document.querySelector('[data-addpfcap]');
      if(addCapBtn) addCapBtn.onclick = ()=>{ harvestAdminInputs(); pf.capabilitySteps.push({v:'',l:''}); render(); };
      document.querySelectorAll('[data-delpfcap]').forEach(b=>b.onclick=()=>{ harvestAdminInputs(); pf.capabilitySteps.splice(+b.dataset.delpfcap,1); render(); });

      const addProjBtn = document.querySelector('[data-addpfproj]');
      if(addProjBtn) addProjBtn.onclick = ()=>{ harvestAdminInputs(); pf.projects.push({hp:'',img:'',title:'',place:'',desc:'',tags:[]}); render(); };
      document.querySelectorAll('[data-delpfproj]').forEach(b=>b.onclick=()=>{ harvestAdminInputs(); pf.projects.splice(+b.dataset.delpfproj,1); render(); });

      const addRoiBtn = document.querySelector('[data-addpfroi]');
      if(addRoiBtn) addRoiBtn.onclick = ()=>{ harvestAdminInputs(); pf.roiCases.push({v:'',l:''}); render(); };
      document.querySelectorAll('[data-delpfroi]').forEach(b=>b.onclick=()=>{ harvestAdminInputs(); pf.roiCases.splice(+b.dataset.delpfroi,1); render(); });

      const addPartnerBtn = document.querySelector('[data-addpfpartner]');
      if(addPartnerBtn) addPartnerBtn.onclick = ()=>{ harvestAdminInputs(); pf.partners.push({name:'',img:''}); render(); };
      document.querySelectorAll('[data-delpfpartner]').forEach(b=>b.onclick=()=>{ harvestAdminInputs(); pf.partners.splice(+b.dataset.delpfpartner,1); render(); });
    }

    function readFileAsBase64(file){
      return new Promise((resolve,reject)=>{
        const reader = new FileReader();
        reader.onload = ()=>resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }
    async function uploadImage(file){
      const imageBase64 = await readFileAsBase64(file);
      const data = await callEngine('upload-product-image', { adminToken: adminTokenMem, imageBase64, filename: file.name });
      return data.url;
    }
    document.querySelectorAll('[data-catimg]').forEach(inp=>inp.onchange = async ()=>{
      const file = inp.files[0]; if(!file) return;
      harvestAdminInputs();
      try{
        const url = await uploadImage(file);
        adminConfig.productCatalog[+inp.dataset.catimg].categoryImage = url;
        render();
      }catch(e){ alert('تعذر رفع الصورة: '+e.message); }
    });
    document.querySelectorAll('[data-readysysimg]').forEach(inp=>inp.onchange = async ()=>{
      const file = inp.files[0]; if(!file) return;
      harvestAdminInputs();
      try{
        const url = await uploadImage(file);
        adminConfig.readyOffgridSystems[+inp.dataset.readysysimg].image = url;
        render();
      }catch(e){ alert('تعذر رفع الصورة: '+e.message); }
    });
    document.querySelectorAll('[data-bomimg]').forEach(inp=>inp.onchange = async ()=>{
      const file = inp.files[0]; if(!file) return;
      harvestAdminInputs();
      try{
        const url = await uploadImage(file);
        adminConfig.bomItemImages = adminConfig.bomItemImages || {};
        adminConfig.bomItemImages[inp.dataset.bomimg] = url;
        render();
      }catch(e){ alert('تعذر رفع الصورة: '+e.message); }
    });

    // ---- portfolio image uploads (hero / timeline / project / partner logo) ----
    const pfHeroImgInp = document.getElementById('pf_heroimg_file');
    if(pfHeroImgInp) pfHeroImgInp.onchange = async ()=>{
      const file = pfHeroImgInp.files[0]; if(!file) return;
      harvestAdminInputs();
      try{
        const url = await uploadImage(file);
        adminConfig.portfolio.hero = adminConfig.portfolio.hero || {};
        adminConfig.portfolio.hero.image = url;
        render();
      }catch(e){ alert('تعذر رفع الصورة: '+e.message); }
    };
    document.querySelectorAll('[data-pftlimg]').forEach(inp=>inp.onchange = async ()=>{
      const file = inp.files[0]; if(!file) return;
      harvestAdminInputs();
      try{
        const url = await uploadImage(file);
        adminConfig.portfolio.timeline[+inp.dataset.pftlimg].image = url;
        render();
      }catch(e){ alert('تعذر رفع الصورة: '+e.message); }
    });
    document.querySelectorAll('[data-pfprojimg]').forEach(inp=>inp.onchange = async ()=>{
      const file = inp.files[0]; if(!file) return;
      harvestAdminInputs();
      try{
        const url = await uploadImage(file);
        adminConfig.portfolio.projects[+inp.dataset.pfprojimg].img = url;
        render();
      }catch(e){ alert('تعذر رفع الصورة: '+e.message); }
    });
    document.querySelectorAll('[data-pfpartnerimg]').forEach(inp=>inp.onchange = async ()=>{
      const file = inp.files[0]; if(!file) return;
      harvestAdminInputs();
      try{
        const url = await uploadImage(file);
        adminConfig.portfolio.partners[+inp.dataset.pfpartnerimg].img = url;
        render();
      }catch(e){ alert('تعذر رفع الصورة: '+e.message); }
    });

    document.querySelectorAll('[data-editdetail]').forEach(b=>b.onclick=()=>{
      const [ci,ri] = b.dataset.editdetail.split(':').map(Number);
      const cat = adminConfig.productCatalog[ci];
      const detail = (cat.productDetails && cat.productDetails[ri]) || {};
      document.getElementById('pde_target').value = `${ci}:${ri}`;
      document.getElementById('pde_description').value = detail.description || '';
      document.getElementById('pde_specs').value = Object.entries(detail.specs||{}).map(([k,v])=>`${k}: ${v}`).join('\n');
      document.getElementById('pde_available').checked = detail.available !== false;
      document.getElementById('pde_brand').value = detail.brand || '';
      document.getElementById('pde_maxsolarkw').value = (detail.maxSolarKw != null && detail.maxSolarKw !== '') ? detail.maxSolarKw : '';
      const preview = document.getElementById('pde_imgpreview');
      delete preview.dataset.uploadedUrl;
      if(detail.image){ preview.src = detail.image; preview.style.display='inline-block'; } else { preview.style.display='none'; preview.src=''; }
      document.getElementById('productDetailEditor').style.display = 'block';
      const editorEl = document.getElementById('productDetailEditor');
      if(editorEl.scrollIntoView){ try{ editorEl.scrollIntoView({behavior:'smooth', block:'center'}); }catch(e){} }
    });
    document.getElementById('pde_imgfile').onchange = async (e)=>{
      const file = e.target.files[0]; if(!file) return;
      try{
        const url = await uploadImage(file);
        const preview = document.getElementById('pde_imgpreview');
        preview.src = url; preview.style.display='inline-block';
        preview.dataset.uploadedUrl = url;
      }catch(err){ alert('تعذر رفع الصورة: '+err.message); }
    };
    document.getElementById('pde_apply').onclick = ()=>{
      harvestAdminInputs();
      const [ci,ri] = document.getElementById('pde_target').value.split(':').map(Number);
      const cat = adminConfig.productCatalog[ci];
      cat.productDetails = cat.productDetails || {};
      const specs = {};
      document.getElementById('pde_specs').value.split('\n').forEach(line=>{
        const idx = line.indexOf(':');
        if(idx>0){ specs[line.slice(0,idx).trim()] = line.slice(idx+1).trim(); }
      });
      const preview = document.getElementById('pde_imgpreview');
      const maxSolarKwRaw = document.getElementById('pde_maxsolarkw').value;
      cat.productDetails[ri] = {
        image: preview.dataset.uploadedUrl || (preview.style.display!=='none' ? preview.src : (cat.productDetails[ri]||{}).image) || '',
        description: document.getElementById('pde_description').value,
        available: document.getElementById('pde_available').checked,
        brand: document.getElementById('pde_brand').value.trim(),
        maxSolarKw: maxSolarKwRaw === '' ? null : (+maxSolarKwRaw || 0),
        specs
      };
      document.getElementById('productDetailEditor').style.display = 'none';
      render();
    };
    document.getElementById('pde_cancel').onclick = ()=>{
      document.getElementById('productDetailEditor').style.display = 'none';
    };

    const apmOverlay = document.getElementById('addProductModalOverlay');
    if(apmOverlay){
      document.getElementById('apm_cancel').onclick = ()=>{ apmOverlay.style.display='none'; };
      document.getElementById('apm_save').onclick = ()=>{
        const catIdx = +apmOverlay.dataset.cat;
        const cat = adminConfig.productCatalog[catIdx];
        let hasError = false;
        const values = cat.columns.map((col,i)=>{
          const input = document.querySelector(`[data-apmfield="${i}"]`);
          const errEl = document.querySelector(`[data-apmerr="${i}"]`);
          errEl.style.display = 'none';
          const val = input.value.trim();
          if(i===0 && !val){ errEl.textContent = 'هذا الحقل مطلوب'; errEl.style.display = 'block'; hasError = true; }
          if(/سعر/.test(col) && val && isNaN(+val)){ errEl.textContent = 'لازم يكون رقم'; errEl.style.display = 'block'; hasError = true; }
          return val;
        });
        if(hasError){
          document.getElementById('apm_error').textContent = 'راجع الحقول المظلّلة بالأحمر';
          document.getElementById('apm_error').style.display = 'block';
          return;
        }
        cat.rows.push(values);
        apmOverlay.style.display = 'none';
        render();
      };
    }
    document.getElementById('pde_useForOthers').onclick = ()=>{
      const preview = document.getElementById('pde_imgpreview');
      const imgUrl = preview.dataset.uploadedUrl || (preview.style.display!=='none' ? preview.src : '');
      if(!imgUrl){ alert('ارفع صورة أولاً قبل ما تشاركها مع موديلات تانية'); return; }
      const [ci,ri] = document.getElementById('pde_target').value.split(':').map(Number);
      const cat = adminConfig.productCatalog[ci];
      const list = document.getElementById('sharedImagePickerList');
      list.innerHTML = cat.rows.map((row,i)=>i===ri?'':`
        <label style="display:flex;align-items:center;gap:8px;padding:4px 0">
          <input type="checkbox" data-sip-row="${i}" style="width:auto">
          <span>${row[0]}</span>
        </label>`).join('');
      document.getElementById('sharedImagePicker').dataset.cat = ci;
      document.getElementById('sharedImagePicker').dataset.img = imgUrl;
      document.getElementById('sharedImagePicker').dataset.sourceRow = ri;
      document.getElementById('sharedImagePicker').style.display = 'block';
    };
    document.getElementById('sip_apply').onclick = ()=>{
      const picker = document.getElementById('sharedImagePicker');
      const ci = +picker.dataset.cat;
      const imgUrl = picker.dataset.img;
      const sourceRow = +picker.dataset.sourceRow;
      const cat = adminConfig.productCatalog[ci];
      cat.productDetails = cat.productDetails || {};
      // the model you started from always gets the image too
      cat.productDetails[sourceRow] = { ...(cat.productDetails[sourceRow]||{}), image: imgUrl };
      let count = 1;
      picker.querySelectorAll('[data-sip-row]:checked').forEach(cb=>{
        const ri = +cb.dataset.sipRow;
        cat.productDetails[ri] = { ...(cat.productDetails[ri]||{}), image: imgUrl };
        count++;
      });
      picker.style.display = 'none';
      document.getElementById('productDetailEditor').style.display = 'none';
      alert(`تم تطبيق الصورة على ${count} موديل. اضغط "حفظ التعديلات" لتثبيتها.`);
      render();
    };
    document.getElementById('sip_cancel').onclick = ()=>{
      document.getElementById('sharedImagePicker').style.display = 'none';
    };
    document.getElementById('admExport').onclick = ()=>{
      const blob = new Blob([JSON.stringify(adminConfig,null,2)],{type:'application/json'});
      const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='holoul-pricing-data.json'; a.click();
    };
    document.getElementById('admImportBtn').onclick = ()=>document.getElementById('admImport').click();
    document.getElementById('admImport').onchange = e=>{
      const file=e.target.files[0]; if(!file) return;
      const reader=new FileReader();
      reader.onload = ()=>{
        try{ adminConfig = normalizeAdminConfig(JSON.parse(reader.result)); render(); alert('تم الاستيراد — اضغط "حفظ التعديلات" لتثبيته على الخادم ✔'); }
        catch(err){ alert('ملف غير صالح'); }
      };
      reader.readAsText(file);
    };
  }
}

function wireOffgridCalc(){
  const retryBtn = document.getElementById('retryLoadOffgrid');
  if(retryBtn){ retryBtn.onclick = ()=>refreshOffgrid(); return; }
  const o = state.offgrid;
  const clientEl = document.getElementById('og_client');
  if(clientEl) clientEl.oninput = e=>{ state.client=e.target.value; const b=document.getElementById('bannerName'); if(b) b.textContent=state.client||'—'; };
  const phoneEl = document.getElementById('og_phone');
  if(phoneEl) phoneEl.oninput = e=>{ state.clientPhone=e.target.value; const b=document.getElementById('bannerPhone'); if(b) b.textContent=state.clientPhone||'—'; };
  // Load profile (method, appliances, direct kWh) editing never calls the
  // pricing engine directly anymore — every edit here only mutates local
  // state and marks offgridLoadsConfirmed=false. The engine (which re-sizes
  // the inverter/battery/panels and rebuilds the BOM+price) only runs when
  // the person presses "تأكيد ملف الأحمال", via markLoadsDirty()/local
  // helpers below. This avoids re-running the whole quote on every keystroke.
  function markLoadsDirty(){
    offgridLoadsConfirmed = false;
    const banner = document.getElementById('og_loads_dirty_banner');
    if(banner) banner.style.display = '';
  }
  function updateLiveTotal(){
    const totalEl = document.getElementById('og_live_total');
    if(totalEl) totalEl.innerHTML = `إجمالي الاستهلاك اليومي (حسب المُدخل الآن): <b>${fmt1(computeLocalDailyKwh(o.appliances))}</b> كيلوواط/ساعة`;
  }
  document.querySelectorAll('[data-ogmethod]').forEach(b=>b.onclick=()=>{ o.method=b.dataset.ogmethod; markLoadsDirty(); render(); });
  const dailyEl = document.getElementById('og_dailykwh');
  if(dailyEl) dailyEl.oninput = e=>{ o.dailyKwh = +e.target.value || 0; markLoadsDirty(); };
  const autoEl = document.getElementById('og_autonomy');
  const confirmAutonomy = ()=>{
    const v = autoEl.value.trim();
    o.autonomyDays = v === '' ? 0 : Math.max(0, +v || 0);
    autoEl.value = o.autonomyDays;
    scheduleRefreshOffgrid(0);
  };
  if(autoEl){
    autoEl.onkeydown = e=>{ if(e.key === 'Enter'){ e.preventDefault(); confirmAutonomy(); } };
  }
  const autoConfirmBtn = document.getElementById('ogAutonomyConfirm');
  if(autoConfirmBtn) autoConfirmBtn.onclick = confirmAutonomy;
  const confirmLoadsBtn = document.getElementById('ogConfirmLoads');
  if(confirmLoadsBtn) confirmLoadsBtn.onclick = ()=>{ scheduleRefreshOffgrid(0); };
  const panelEl = document.getElementById('og_panel');
  if(panelEl) panelEl.onchange = e=>{ o.panelIdx = +e.target.value; scheduleRefreshOffgrid(); };
  const invBrandEl = document.getElementById('og_inverter_brand');
  if(invBrandEl) invBrandEl.onchange = e=>{
    o.inverterBrand = e.target.value || '';
    // a brand filter change can orphan the currently-picked exact inverter model
    if(o.inverterModel && !cachedInverterModelOptions.some(m=>m.model===o.inverterModel && (!o.inverterBrand || m.brand===o.inverterBrand))){
      o.inverterModel = null;
    }
    scheduleRefreshOffgrid(0);
  };
  const invModelEl = document.getElementById('og_inverter_model');
  if(invModelEl) invModelEl.onchange = e=>{ o.inverterModel = e.target.value || null; scheduleRefreshOffgrid(0); };
  const battVoltEl = document.getElementById('og_battery_voltage');
  if(battVoltEl) battVoltEl.onchange = e=>{
    o.batteryVoltage = +e.target.value;
    // the previously-picked exact size(Ah) model may not exist at the new voltage class — drop back to "auto" rather than silently keep an invalid/mismatched model selected
    if(o.batteryModel && !cachedBatteryModelOptions.some(m=>m.model===o.batteryModel && m.stdVoltage==o.batteryVoltage && (!o.batteryBrand || m.brand===o.batteryBrand))){
      o.batteryModel = null;
    }
    scheduleRefreshOffgrid(0);
  };
  const battBrandEl = document.getElementById('og_battery_brand');
  if(battBrandEl) battBrandEl.onchange = e=>{
    o.batteryBrand = e.target.value || '';
    // same idea — a brand filter change can orphan the currently-picked exact model
    if(o.batteryModel && !cachedBatteryModelOptions.some(m=>m.model===o.batteryModel && m.stdVoltage==o.batteryVoltage && (!o.batteryBrand || m.brand===o.batteryBrand))){
      o.batteryModel = null;
    }
    scheduleRefreshOffgrid(0);
  };
  const battModelEl = document.getElementById('og_battery_model');
  if(battModelEl) battModelEl.onchange = e=>{ o.batteryModel = e.target.value || null; scheduleRefreshOffgrid(0); };
  document.querySelectorAll('[data-ogapp]').forEach(inp=>{
    inp.oninput = ()=>{
      const i = +inp.dataset.ogapp, f = inp.dataset.af;
      o.appliances[i][f] = (f==='name') ? inp.value : (+inp.value||0);
      markLoadsDirty();
      updateLiveTotal();
    };
  });
  document.querySelectorAll('[data-ogdelapp]').forEach(b=>b.onclick=()=>{
    o.appliances.splice(+b.dataset.ogdelapp,1); markLoadsDirty(); render();
  });
  const addBtn = document.getElementById('ogAddAppliance');
  if(addBtn) addBtn.onclick = ()=>{ o.appliances.push({name:'جهاز جديد',watts:100,dayHours:2,nightHours:2,qty:1}); markLoadsDirty(); render(); };
  const addPresetBtn = document.getElementById('ogAddPresetAppliance');
  if(addPresetBtn) addPresetBtn.onclick = ()=>{
    const sel = document.getElementById('ogAppliancePreset');
    const preset = activeAppliancePresets()[+sel.value];
    if(!preset) return;
    o.appliances.push({name:preset.name, watts:preset.watts, dayHours:preset.dayHours, nightHours:preset.nightHours, qty:1, surgeMultiplier:preset.surgeMultiplier});
    markLoadsDirty(); render();
  };
  const unlockInfoBtn = document.getElementById('adminInfoTrigger');
  if(unlockInfoBtn && !adminInfoUnlocked) unlockInfoBtn.onclick = ()=>adminPasswordGate(()=>{ adminInfoUnlocked=true; scheduleRefreshOffgrid(0); });
  // Manual BOM-quantity overrides (panel/inverter/battery/structure) — lets
  // the rep/engineer raise or lower a calculated quantity based on their
  // technical read of the site, without touching the underlying inputs.
  if(!o.qtyOverrides) o.qtyOverrides = { panel:null, inverter:null, battery:null, structure:null };
  document.querySelectorAll('[data-qtyoverride]').forEach(inp=>{
    inp.onchange = ()=>{
      const key = inp.dataset.qtyoverride;
      const val = +inp.value;
      o.qtyOverrides[key] = (inp.value !== '' && isFinite(val) && val > 0) ? Math.round(val) : null;
      scheduleRefreshOffgrid(0);
    };
  });
  document.querySelectorAll('[data-qtyreset]').forEach(b=>{
    b.onclick = ()=>{
      o.qtyOverrides[b.dataset.qtyreset] = null;
      scheduleRefreshOffgrid(0);
    };
  });
  // Supply-only vs supply+install, and per-item on/off toggles for the off-grid BOM
  if(!o.toggles) o.toggles = { panel:true, inverter:true, battery:true, structure:true, cabling:true, install:true };
  document.querySelectorAll('[data-ogtgl]').forEach(c=>{
    c.onchange = ()=>{ o.toggles[c.dataset.ogtgl] = c.checked; scheduleRefreshOffgrid(0); };
  });
  document.querySelectorAll('[data-ogpreset]').forEach(b=>{
    b.onclick = ()=>{
      o.toggles = (b.dataset.ogpreset === 'materials')
        ? { panel:true, inverter:true, battery:true, structure:false, cabling:false, install:false }
        : { panel:true, inverter:true, battery:true, structure:true, cabling:true, install:true };
      scheduleRefreshOffgrid(0);
    };
  });
}

function wireOngridCalc(){
  const retryBtn = document.getElementById('retryLoadOngrid');
  if(retryBtn){ retryBtn.onclick = ()=>refreshOngrid(); return; }
  const n = state.ongrid;
  const clientEl = document.getElementById('ng_client');
  if(clientEl) clientEl.oninput = e=>{ state.client=e.target.value; const b=document.getElementById('bannerName'); if(b) b.textContent=state.client||'—'; };
  const phoneEl = document.getElementById('ng_phone');
  if(phoneEl) phoneEl.oninput = e=>{ state.clientPhone=e.target.value; const b=document.getElementById('bannerPhone'); if(b) b.textContent=state.clientPhone||'—'; };
  document.querySelectorAll('[data-ngmethod]').forEach(b=>b.onclick=()=>{ n.method=b.dataset.ngmethod; scheduleRefreshOngrid(0); });
  const billEl = document.getElementById('ng_bill');
  if(billEl) billEl.oninput = e=>{ n.billSar = +e.target.value || 0; scheduleRefreshOngrid(); };
  const kwhEl = document.getElementById('ng_kwh');
  if(kwhEl) kwhEl.oninput = e=>{ n.monthlyKwh = +e.target.value || 0; scheduleRefreshOngrid(); };
  const kwEl = document.getElementById('ng_kw');
  if(kwEl) kwEl.oninput = e=>{ n.systemKw = +e.target.value || 0; scheduleRefreshOngrid(); };
  const panelEl = document.getElementById('ng_panel');
  if(panelEl) panelEl.onchange = e=>{ n.panelIdx = +e.target.value; scheduleRefreshOngrid(); };
  const unlockInfoBtn = document.getElementById('adminInfoTrigger');
  if(unlockInfoBtn && !adminInfoUnlocked) unlockInfoBtn.onclick = ()=>adminPasswordGate(()=>{ adminInfoUnlocked=true; scheduleRefreshOngrid(0); });
}

document.querySelectorAll('nav.tabs button').forEach(btn=>{
  btn.onclick = ()=>{
    document.querySelectorAll('nav.tabs button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    currentView = btn.dataset.view;
    if(currentView==='ready'){ cachedReadySystems = null; readySystemsError = null; }
    if(currentView==='products'){ cachedProductCatalog = null; productCatalogError = null; selectedProduct = null; productsNav = 'categories'; selectedCategoryIdx = null; }
    if(currentView==='portfolio'){ cachedPortfolio = null; portfolioError = null; }
    render();
  };
});

function showRepBadge(){
  const badge = document.getElementById('repNameBadge');
  const logoutBtn = document.getElementById('repLogoutBtn');
  const productsBtn = document.getElementById('productsNavBtn');
  // products tab is public — visible to everyone regardless of login state
  if(repAuthed && repDisplayName){
    badge.textContent = '👤 ' + repDisplayName;
    badge.style.display = 'inline';
    logoutBtn.style.display = 'inline-block';
  } else if(guestMode){
    badge.textContent = '🖥️ تسعير مباشر (بدون مندوب)';
    badge.style.display = 'inline';
    logoutBtn.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
    logoutBtn.style.display = 'none';
  }
}
document.getElementById('repLogoutBtn').onclick = ()=>{
  repAuthed = false; repUsername = null; repTokenMem = null; repDisplayName = null; repPermissions = {};
  guestMode = false; guestRegistered = false;
  sessionStorage.removeItem('holoul_rep_session');
  localStorage.removeItem(REP_REMEMBER_KEY);
  state.client = ''; state.clientPhone = '';
  showRepBadge();
  render();
};
showRepBadge();

async function refresh(){
  quoteLoading = true;
  render();
  await refreshQuote();
  quoteLoading = false;
  render();
}
let refreshTimer = null;
function scheduleRefresh(delay = 220){
  if(refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(()=>{
    refreshTimer = null;
    refresh();
  }, delay);
}

async function refreshOffgrid(){
  offgridLoading = true;
  render();
  await refreshOffgridQuote();
  offgridLoading = false;
  render();
}
let refreshOffgridTimer = null;
function scheduleRefreshOffgrid(delay = 220){
  if(refreshOffgridTimer) clearTimeout(refreshOffgridTimer);
  refreshOffgridTimer = setTimeout(()=>{ refreshOffgridTimer = null; refreshOffgrid(); }, delay);
}

async function refreshOngrid(){
  ongridLoading = true;
  render();
  await refreshOngridQuote();
  ongridLoading = false;
  render();
}
let refreshOngridTimer = null;
function scheduleRefreshOngrid(delay = 220){
  if(refreshOngridTimer) clearTimeout(refreshOngridTimer);
  refreshOngridTimer = setTimeout(()=>{ refreshOngridTimer = null; refreshOngrid(); }, delay);
}

refresh();

// If the admin previously checked "remember me", silently restore that
// session in the background (needs a round-trip to re-fetch adminConfig,
// so it can't happen synchronously like the rep restore above does).
(async function restoreRememberedAdminSession(){
  let saved;
  try{ saved = JSON.parse(localStorage.getItem(ADMIN_REMEMBER_KEY)||'null'); }catch(e){ saved = null; }
  if(!saved || !saved.token || saved.expiresAt <= Date.now()){
    if(saved) localStorage.removeItem(ADMIN_REMEMBER_KEY);
    return;
  }
  try{
    adminTokenMem = saved.token;
    const data = await callEngine('admin-config', { adminToken: adminTokenMem });
    adminConfig = normalizeAdminConfig(data.config); adminAuthed = true;
    try{
      const repsData = await callEngine('admin-list-reps', { adminToken: adminTokenMem });
      adminReps = repsData.reps || [];
    }catch(e){ adminReps = []; }
    render();
  }catch(e){
    adminTokenMem = null; adminAuthed = false;
    localStorage.removeItem(ADMIN_REMEMBER_KEY); // token expired/invalidated server-side — stop retrying
  }
})();

