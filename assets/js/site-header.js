/* =======================================================================
   site-header.js — الهيدر الموحّد لكل صفحات حلول الطاقة (مع assets/css/header.css)

   طريقتين للاستخدام:
   1) رسم كامل (home / PD / pump):
        <header class="top hl-header" data-hl-header data-title="الرئيسية" data-actions="nav,user,logout"></header>
        <script src="assets/js/holoul-auth.js"></script>
        <script src="assets/js/site-header.js"></script>
      data-title    : اسم الصفحة (السطر الصغير تحت اسم الشركة)
      data-actions  : قايمة مفصولة بفواصل من: contact (اتصال+واتساب) · nav (قايمة الأقسام) · user · logout
      data-brand-href: رابط الشعار (الافتراضي home.html)
      عناصر جوّه الهيدر بـ data-hl-slot="mid" أو "actions" بتتنقل للمكان المناسب (مثلًا: البحث العام / أزرار خاصة بالصفحة).

   2) تحسين ماركب موجود (index / crm): الماركب بيفضل زي ما هو بنفس الـ IDs، والسكريبت بيملا بس العناصر دي:
        [data-hl-nav]    قايمة الأقسام (بتختفي لو مفيش جلسة دخول — يعني الزائر العادي ما يشوفهاش)
        [data-hl-user]   اسم المستخدم
        [data-hl-logout] زرار خروج (لو ما كانش ليه handler خاص)

   قايمة الأقسام بتتبني من الصلاحيات اللي السيرفر رجّعها في الجلسة (HoloulAuth.read().modules)،
   فكل مستخدم يشوف اللي مسموحله بس. (الصلاحيات الفعلية بتتنفّذ في السيرفر دايمًا.)
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

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function session() {
    try { return (w.HoloulAuth && w.HoloulAuth.read && w.HoloulAuth.read()) || null; } catch (e) { return null; }
  }

  // ---------- عناصر قايمة الأقسام ----------
  function navItems() {
    var s = session();
    if (!s) return [];
    var list = [{ label: 'الرئيسية', icon: '🏠', url: 'home.html' }];
    (s.modules || []).forEach(function (m) { list.push({ label: m.label, icon: m.icon, url: m.url }); });
    // PD بيشتغل بتوكن الأدمن (مش ضمن modules اللي بيرجّعها السيرفر)
    if (s.tokens && s.tokens.admin) list.push({ label: 'مستندات المشاريع (PD)', icon: '📄', url: 'PD/index.html' });
    return list;
  }
  function isCurrent(url) {
    try {
      var u = new URL(url, BASE);
      if (u.pathname !== w.location.pathname) return false;
      if (u.hash) return u.hash === w.location.hash;
      if (u.search) return w.location.search.indexOf(u.search) >= 0;
      return w.location.hash !== '#admin' && w.location.search.indexOf('portal=staff') < 0;
    } catch (e) { return false; }
  }

  function fillNav(el) {
    var items = navItems();
    if (!items.length) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    el.classList.add('hl-nav', 'no-print');
    var id = 'hlMenu' + Math.random().toString(36).slice(2, 7);
    el.innerHTML =
      '<button type="button" class="hl-btn" aria-haspopup="true" aria-expanded="false" aria-controls="' + id + '">🧭 الأقسام</button>' +
      '<div class="hl-menu" id="' + id + '" role="menu" hidden>' +
      items.map(function (it) {
        var cur = isCurrent(it.url);
        return '<a role="menuitem" href="' + esc(new URL(it.url, BASE).href) + '"' + (cur ? ' aria-current="page"' : '') + '>' +
          '<span class="hl-ic" aria-hidden="true">' + esc(it.icon || '•') + '</span>' + esc(it.label) + '</a>';
      }).join('') +
      '</div>';
    var btn = el.querySelector('button'), menu = el.querySelector('.hl-menu');
    function close() { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    d.addEventListener('click', function (e) { if (!el.contains(e.target)) close(); });
    d.addEventListener('keydown', function (e) { if (e.key === 'Escape') { close(); btn.focus(); } });
  }

  function fillUser(el) {
    var s = session();
    if (s && s.user && s.user.displayName) { el.hidden = false; el.innerHTML = '👤 <b>' + esc(s.user.displayName) + '</b>'; }
    else { el.hidden = true; el.textContent = ''; }
  }

  function logout() {
    try { if (w.HoloulAuth && w.HoloulAuth.clear) w.HoloulAuth.clear(); } catch (e) {}
    w.location.replace(BASE + 'login.html');
  }
  function fillLogout(el) {
    var s = session();
    el.hidden = !s;
    if (!el.__hlBound) { el.__hlBound = true; el.addEventListener('click', logout); }
  }

  // ---------- رسم كامل ----------
  function render(h) {
    var title = h.getAttribute('data-title') || '';
    var actions = (h.getAttribute('data-actions') || 'nav,user,logout').split(',').map(function (x) { return x.trim(); });
    var brandHref = h.getAttribute('data-brand-href') || (BASE + 'home.html');
    var slots = {};
    [].slice.call(h.querySelectorAll('[data-hl-slot]')).forEach(function (n) {
      (slots[n.getAttribute('data-hl-slot')] = slots[n.getAttribute('data-hl-slot')] || []).push(n);
    });

    h.classList.add('top', 'hl-header');
    h.setAttribute('role', 'banner');
    h.innerHTML =
      '<div class="brandrow">' +
      '<a class="brand" href="' + esc(brandHref) + '">' +
      '<div class="mark"><img src="' + esc(BASE + 'assets/logo.png') + '" alt="Holoul Energy" width="44" height="44" ' +
      'onerror="this.parentNode.classList.add(\'fallback\');this.replaceWith(\'☀️\')"></div>' +
      '<div><div class="name">' + esc(COMPANY) + '</div>' + (title ? '<div class="sub">' + esc(title) + '</div>' : '') + '</div>' +
      '</a>' +
      '<div class="hl-mid" data-hl-mid></div>' +
      '<div class="hl-actions" data-hl-actions></div>' +
      '</div>';

    var mid = h.querySelector('[data-hl-mid]'), act = h.querySelector('[data-hl-actions]');
    (slots.mid || []).forEach(function (n) { mid.appendChild(n); });
    if (!(slots.mid || []).length) mid.remove();
    (slots.actions || []).forEach(function (n) { act.appendChild(n); });

    if (actions.indexOf('contact') >= 0) {
      act.insertAdjacentHTML('beforeend',
        '<a class="hl-btn opt" href="tel:+' + PHONE + '">📞 اتصال</a>' +
        '<a class="hl-btn wa opt" href="https://wa.me/' + PHONE + '" target="_blank" rel="noopener">💬 واتساب</a>');
    }
    if (actions.indexOf('nav') >= 0) act.insertAdjacentHTML('beforeend', '<div data-hl-nav hidden></div>');
    if (actions.indexOf('user') >= 0) act.insertAdjacentHTML('beforeend', '<span class="hl-user no-print" data-hl-user hidden></span>');
    if (actions.indexOf('logout') >= 0) act.insertAdjacentHTML('beforeend', '<button type="button" class="hl-btn ghost no-print" data-hl-logout hidden>خروج</button>');
  }


  // ---------- هوية المؤسسة (white-label): الاسم المختصر + اللوجو + أرقام التواصل من جدول company_profile ----------
  // بنخزّنها مؤقتًا في sessionStorage عشان الهيدر ما يرجعش للاسم الافتراضي بين الصفحات.
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
  function fillAll(root) {
    [].slice.call(root.querySelectorAll('[data-hl-nav]')).forEach(fillNav);
    [].slice.call(root.querySelectorAll('[data-hl-user]')).forEach(fillUser);
    [].slice.call(root.querySelectorAll('[data-hl-logout]')).forEach(fillLogout);
  }
  function mount(h) {
    if (h.hasAttribute('data-hl-header') && !h.__hlRendered) { h.__hlRendered = true; render(h); }
    fillAll(h);
  }
  function mountAll() {
    [].slice.call(d.querySelectorAll('header.hl-header, header[data-hl-header]')).forEach(mount);
  }

  w.HLHeader = { mount: mount, refresh: mountAll, base: BASE };

  // الرسم الكامل لازم يتم فورًا (قبل سكريبتات الصفحة)؛ التعبئة بتتكرر بعد تحميل DOM كمان.
  mountAll();
  loadCompany();
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', function () { mountAll(); if (CO) applyCompany(CO); });
})(window, document);
