/* =======================================================================
   site-header.js — الهيدر الموحّد لكل صفحات حلول الطاقة (مع assets/css/header.css)

   الترتيب (من اليمين لليسار):
     اللوجو + اسم الشركة (رابط للرئيسية)  ·  الحاسبات ▾  ·  قائمة المنتجات  ·  البورتفوليو  ·  لوحة التحكم (للأدمن)
     ...........  📞 💬  ·  قايمة المستخدم ▾ (CRM / بوابة الموظف / PD / خروج)

   الاستخدام:
     <header class="top hl-header" data-hl-header data-title="سطر صغير تحت اسم الشركة"></header>
     <script src="assets/js/holoul-auth.js"></script>     (قبل ده)
     <script src="assets/js/site-header.js"></script>     (بعد الهيدر مباشرة — لازم قبل أي سكريبت بيدوّر على عناصره)

   خيارات اختيارية على الـ <header>:
     data-title="..."        : السطر الصغير تحت اسم الشركة (نص)
     data-sub-html="..."     : نفس السطر لكن HTML ثابت من الصفحة نفسها (مثلًا span بـ id)
     data-user-id="..."      : id لزرار اسم المستخدم (الصفحة هي اللي بتكتب اسمه — index و crm)
     data-logout-id="..."    : id لزرار الخروج (الصفحة هي اللي بتربطه بالـ handler بتاعها)
     data-user-hidden        : زرار المستخدم يبدأ مخفي (الصفحة بتظهره)
     عناصر جوّه الهيدر بـ data-hl-slot="start" (قبل اللوجو) أو "actions" (قبل أيقونات التواصل) بتتنقل للمكان ده.

   الروابط في مكان واحد (NAV تحت). روابط index.html بتستخدم hash (#Calc=SolarPump ...) وبتتقرأ بدون حساسية لحالة الحروف.
   الصلاحيات الفعلية بتتنفّذ في السيرفر دايمًا — الهيدر بيخفي/يعرض بس.
   ======================================================================= */
(function (w, d) {
  'use strict';

  // جذر المشروع من مكان السكريبت نفسه (assets/js/site-header.js) — بيشتغل من أي مجلد فرعي زي PD/
  var BASE = (function () {
    try {
      var s = d.currentScript || d.querySelector('script[src*="site-header.js"]');
      return new URL('../../', s.src).href;
    } catch (e) { return ''; }
  })();

  var COMPANY = 'حلول الطاقة المتجددة والمقاولات';
  var PHONE = '966561274344';

  // ---------- الروابط (مكان واحد للتعديل) ----------
  var NAV = {
    home: 'home.html',
    calcs: [
      { key: 'calc:solarpump', icon: '☀️', label: 'حاسبة أنظمة الري الزراعي من خلال الطاقة الشمسية', desc: 'عروض أسعار منظومات الطاقة الشمسية لتشغيل المواتير الغاطسة', url: 'index.html#Calc=SolarPump' },
      { key: 'calc:offgrid', icon: '🔋', label: 'حاسبة الأوف-جريد', url: 'index.html#Calc=OffGrid' },
      { key: 'calc:ongrid', icon: '🔌', label: 'حاسبة الأون-جريد', url: 'index.html#Calc=OnGrid' },
      { key: 'pump', icon: '🚜', label: 'حاسبة الضخ الزراعي', desc: 'حساب احتياج المزرعة من المياه', url: 'pump-calculator.html' },
      { key: 'feas', icon: '📊', label: 'دراسة الجدوى', url: 'index.html#Feasibility' }
    ],
    products: { key: 'products', label: 'قائمة المنتجات', url: 'index.html#Products' },
    portfolio: { key: 'portfolio', label: 'البورتفوليو', url: 'index.html#Portfolio' },
    admin: { key: 'admin', label: 'لوحة التحكم', url: 'index.html#admin' },
    login: 'login.html'
  };
  // عناصر قايمة المستخدم (بتظهر حسب modules اللي السيرفر رجّعها في الجلسة)
  var USER_ITEMS = [
    { mod: 'crm', icon: '👥', label: 'متابعة العملاء (CRM)', url: 'crm.html' },
    { mod: 'staff', icon: '📊', label: 'بوابة الموظف', url: 'crm.html?portal=staff' },
    { mod: '@admin', icon: '📄', label: 'مستندات المشاريع (PD)', url: 'PD/index.html' }
  ];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function abs(u) { try { return new URL(u, BASE).href; } catch (e) { return u; } }
  function session() {
    try { return (w.HoloulAuth && w.HoloulAuth.read && w.HoloulAuth.read()) || null; } catch (e) { return null; }
  }
  function hasAdmin() { var s = session(); return !!(s && s.tokens && s.tokens.admin); }
  function hasModule(key) {
    var s = session(); if (!s) return false;
    return (s.modules || []).some(function (m) { return m.key === key; });
  }

  // ---------- أي عنصر في القايمة هو الحالي ----------
  function keyFromHash() {
    var h = String(w.location.hash || '').replace(/^#/, '').toLowerCase();
    if (h === 'calc=solarpump') return 'calc:solarpump';
    if (h === 'calc=offgrid') return 'calc:offgrid';
    if (h === 'calc=ongrid') return 'calc:ongrid';
    if (h === 'feasibility') return 'feas';
    if (h === 'products') return 'products';
    if (h === 'portfolio') return 'portfolio';
    if (h === 'admin') return 'admin';
    return null;
  }
  function initialKey() {
    var p = w.location.pathname;
    if (/pump-calculator\.html$/.test(p)) return 'pump';
    if (/(\/|index\.html)$/.test(p) && !/\/PD\/$/.test(p)) return keyFromHash() || 'calc:solarpump';
    return null;
  }
  function setActive(key) {
    [].slice.call(d.querySelectorAll('header.hl-header [data-key]')).forEach(function (el) {
      var on = !!key && el.getAttribute('data-key') === key;
      el.classList.toggle('active', on);
      if (on) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
    });
    var inCalcs = !!key && (key.indexOf('calc:') === 0 || key === 'pump' || key === 'feas');
    [].slice.call(d.querySelectorAll('header.hl-header .hl-dd-calcs > button')).forEach(function (b) {
      b.classList.toggle('active', inCalcs);
    });
  }

  // ---------- الماركب ----------
  function ddItem(it) {
    return '<a class="hl-mi" role="menuitem" data-key="' + esc(it.key) + '" href="' + esc(abs(it.url)) + '">' +
      '<span class="hl-ic" aria-hidden="true">' + esc(it.icon || '•') + '</span>' +
      '<span class="hl-mt"><span class="hl-ml">' + esc(it.label) + '</span>' +
      (it.desc ? '<span class="hl-md">' + esc(it.desc) + '</span>' : '') + '</span></a>';
  }
  function navLink(it) {
    return '<a class="hl-link" data-key="' + esc(it.key) + '" href="' + esc(abs(it.url)) + '">' + esc(it.label) + '</a>';
  }

  function render(h) {
    var title = h.getAttribute('data-title') || '';
    var subHtml = h.getAttribute('data-sub-html') || '';
    var userId = h.getAttribute('data-user-id');
    var logoutId = h.getAttribute('data-logout-id');
    var userHidden = h.hasAttribute('data-user-hidden');
    var slots = {};
    [].slice.call(h.querySelectorAll('[data-hl-slot]')).forEach(function (n) {
      var k = n.getAttribute('data-hl-slot'); (slots[k] = slots[k] || []).push(n);
    });

    h.classList.add('top', 'hl-header');
    h.setAttribute('role', 'banner');
    h.__managed = !!userId;

    h.innerHTML =
      '<div class="brandrow">' +
      '<span class="hl-start" data-hl-start></span>' +
      '<a class="brand" href="' + esc(abs(NAV.home)) + '" title="الرئيسية">' +
      '<div class="mark"><img src="' + esc(BASE + 'assets/logo.png') + '" alt="Holoul Energy" width="44" height="44" ' +
      'onerror="this.parentNode.classList.add(\'fallback\');this.replaceWith(\'☀️\')"></div>' +
      '<div><div class="name">' + esc(COMPANY) + '</div>' +
      (subHtml ? '<div class="sub">' + subHtml + '</div>' : (title ? '<div class="sub">' + esc(title) + '</div>' : '')) + '</div>' +
      '</a>' +

      '<nav class="hl-main no-print" aria-label="التنقل الرئيسي">' +
      '<div class="hl-dd hl-dd-calcs">' +
      '<button type="button" class="hl-link" aria-haspopup="true" aria-expanded="false">الحاسبات</button>' +
      '<div class="hl-menu" role="menu">' + NAV.calcs.map(ddItem).join('') + '</div>' +
      '</div>' +
      navLink(NAV.products) + navLink(NAV.portfolio) +
      '<a class="hl-link" data-key="admin" data-hl-admin href="' + esc(abs(NAV.admin.url)) + '" hidden>' + esc(NAV.admin.label) + '</a>' +
      // على الشاشات الصغيرة أيقونتا الاتصال/الواتساب بتنتقل لهنا عشان اسم الشركة ياخد مساحته
      '<div class="hl-mob-only"><a class="hl-link" href="tel:+' + PHONE + '">📞 اتصال</a>' +
      '<a class="hl-link" href="https://wa.me/' + PHONE + '" target="_blank" rel="noopener">💬 واتساب</a></div>' +
      '</nav>' +

      '<div class="hl-actions">' +
      '<span class="hl-slot-actions" data-hl-slot-actions></span>' +
      '<a class="hl-icon" href="tel:+' + PHONE + '" title="اتصال" aria-label="اتصال">📞</a>' +
      '<a class="hl-icon wa" href="https://wa.me/' + PHONE + '" target="_blank" rel="noopener" title="واتساب" aria-label="واتساب">💬</a>' +
      '<a class="hl-btn ghost no-print" data-hl-login href="' + esc(abs(NAV.login)) + '" hidden>دخول</a>' +
      '<div class="hl-dd hl-um no-print" data-hl-um>' +
      '<button type="button" class="hl-btn ghost hl-um-btn"' + (userId ? ' id="' + esc(userId) + '"' : '') +
      (userHidden || !userId ? ' style="display:none"' : '') + ' aria-haspopup="true" aria-expanded="false"></button>' +
      '<div class="hl-menu" role="menu">' +
      '<span data-hl-um-items></span>' +
      '<button type="button" class="hl-mi hl-mi-out"' + (logoutId ? ' id="' + esc(logoutId) + '"' : '') +
      (userHidden || !logoutId ? ' style="display:none"' : '') + ' data-hl-logout><span class="hl-ic" aria-hidden="true">🚪</span><span class="hl-mt"><span class="hl-ml">خروج</span></span></button>' +
      '</div></div>' +
      '<button type="button" class="hl-btn hl-burger no-print" aria-expanded="false" aria-label="الأقسام">الأقسام</button>' +
      '</div></div>';

    var start = h.querySelector('[data-hl-start]'), act = h.querySelector('[data-hl-slot-actions]');
    (slots.start || []).forEach(function (n) { start.appendChild(n); });
    if (!(slots.start || []).length) start.remove();
    (slots.actions || []).forEach(function (n) { act.appendChild(n); });
    if (!(slots.actions || []).length) act.remove();

    wire(h);
  }

  // ---------- السلوك ----------
  function closeAll(except) {
    [].slice.call(d.querySelectorAll('.hl-dd.open')).forEach(function (dd) {
      if (dd !== except) { dd.classList.remove('open'); var b = dd.querySelector(':scope > button'); if (b) b.setAttribute('aria-expanded', 'false'); }
    });
  }
  function wire(h) {
    [].slice.call(h.querySelectorAll('.hl-dd > button')).forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var dd = btn.parentNode, open = !dd.classList.contains('open');
        closeAll(dd);
        dd.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    });
    var burger = h.querySelector('.hl-burger');
    if (burger) burger.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = !h.classList.contains('hl-open');
      h.classList.toggle('hl-open', open);
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    // أي ضغطة على لينك جوه القايمة بتقفلها (مهم لما اللينك بيغيّر الـ hash في نفس الصفحة)
    h.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a.hl-mi, a.hl-link');
      if (!a) return;
      closeAll(); h.classList.remove('hl-open');
      // الماوس لسه واقف على القايمة → الـ :hover كان هيفضّلها مفتوحة: نقفلها لحد ما الماوس يخرج
      var dd = a.closest('.hl-dd');
      if (dd) { dd.classList.add('hl-shut'); dd.addEventListener('mouseleave', function once() { dd.classList.remove('hl-shut'); dd.removeEventListener('mouseleave', once); }); }
    });
  }
  d.addEventListener('click', function (e) {
    if (!e.target.closest || !e.target.closest('.hl-dd')) closeAll();
  });
  d.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });

  // ---------- المحتوى الديناميكي (حسب الجلسة) ----------
  function logout() {
    try { if (w.HoloulAuth && w.HoloulAuth.clear) w.HoloulAuth.clear(); } catch (e) {}
    w.location.replace(BASE + 'login.html');
  }
  function update(h) {
    var s = session();
    var admin = h.querySelector('[data-hl-admin]'); if (admin) admin.hidden = !hasAdmin();

    var items = USER_ITEMS.filter(function (it) { return it.mod === '@admin' ? hasAdmin() : hasModule(it.mod); });
    var slot = h.querySelector('[data-hl-um-items]');
    if (slot) slot.innerHTML = items.map(function (it) {
      return '<a class="hl-mi" role="menuitem" href="' + esc(abs(it.url)) + '"><span class="hl-ic" aria-hidden="true">' + esc(it.icon) + '</span>' +
        '<span class="hl-mt"><span class="hl-ml">' + esc(it.label) + '</span></span></a>';
    }).join('');

    var login = h.querySelector('[data-hl-login]');
    if (login) {
      login.hidden = !!s;
      if (!s) {
        var seg = (w.location.pathname.split('/').pop() || 'index.html') + (w.location.search || '') + (w.location.hash || '');
        if (/^[A-Za-z0-9._-]+\.html([?#][^\s]*)?$/.test(seg)) login.href = abs(NAV.login) + '?next=' + encodeURIComponent(seg);
      }
    }

    var um = h.querySelector('[data-hl-um]');
    if (!h.__managed) {            // الصفحة اللي مش بتتحكم في اسم المستخدم: الهيدر بيعمل ده بنفسه
      var btn = h.querySelector('.hl-um-btn'), out = h.querySelector('[data-hl-logout]');
      if (s && s.user && s.user.displayName) {
        btn.style.display = ''; btn.innerHTML = '👤 ' + esc(s.user.displayName);
        out.style.display = '';
      } else { btn.style.display = 'none'; out.style.display = 'none'; }
      if (um) um.hidden = !s;
      if (!out.__hlBound) { out.__hlBound = true; out.addEventListener('click', logout); }
    }
  }

  // ---------- هوية المؤسسة (white-label): الاسم المختصر + اللوجو + أرقام التواصل من company_profile ----------
  var CO_KEY = 'hl_company_v1';
  var CO_URL = 'https://xhgwvszdatqlvlgqiikj.supabase.co/functions/v1/invoice-api';
  var CO_KEY_PUB = 'sb_publishable_4qWmgl6fWMpoU6F_o__ykg_Z0Xy_aJY';
  var CO = null;

  function applyCompany(c) {
    if (!c || !c.name) return;
    CO = c;
    var short = c.shortName || c.name, brand = c.nameEn || short;
    var digits = String(c.phone || '').replace(/\D/g, ''), wa = String(c.whatsapp || '').replace(/\D/g, '');
    [].slice.call(d.querySelectorAll('header.hl-header')).forEach(function (h) {
      var nm = h.querySelector('.brand .name'); if (nm) nm.textContent = short;
      var img = h.querySelector('.brand .mark img');
      if (img) { if (c.logoUrl) img.src = c.logoUrl; img.alt = brand; }
      if (digits) [].slice.call(h.querySelectorAll('a[href^="tel:"]')).forEach(function (a) { a.href = 'tel:+' + digits; });
      if (wa) [].slice.call(h.querySelectorAll('a[href*="wa.me"]')).forEach(function (a) { a.href = 'https://wa.me/' + wa; });
    });
  }
  function loadCompany() {
    try { var cached = JSON.parse(w.sessionStorage.getItem(CO_KEY) || 'null'); if (cached) applyCompany(cached); } catch (e) {}
    if (!w.fetch) return;
    w.fetch(CO_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CO_KEY_PUB, 'apikey': CO_KEY_PUB },
      body: JSON.stringify({ action: 'company-public' })
    }).then(function (r) { return r.json(); }).then(function (j) {
      var c = j && j.ok && j.company; if (!c || !c.name) return;
      try { w.sessionStorage.setItem(CO_KEY, JSON.stringify(c)); } catch (e) {}
      applyCompany(c);
    }).catch(function () {});
  }

  // ---------- تشغيل ----------
  function headers() { return [].slice.call(d.querySelectorAll('header[data-hl-header], header.hl-header')); }
  function mount(h) {
    if (h.hasAttribute('data-hl-header') && !h.__hlRendered) { h.__hlRendered = true; render(h); }
    if (h.__hlRendered) update(h);
  }
  function mountAll() {
    headers().forEach(mount);
    var k = initialKey(); if (k && !d.querySelector('header.hl-header .active')) setActive(k);
    if (CO) applyCompany(CO);
  }

  w.HLHeader = { mount: mount, refresh: mountAll, setActive: setActive, base: BASE };

  // الرسم لازم يتم فورًا (قبل سكريبتات الصفحة اللي بتدوّر على عناصر الهيدر)؛ والتحديث بيتكرر بعد تحميل DOM.
  mountAll();
  loadCompany();
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', mountAll);
})(window, document);
