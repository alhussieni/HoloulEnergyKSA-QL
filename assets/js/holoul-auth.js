/* =======================================================================
   HoloulAuth — جلسة الدخول الموحّدة (مصدر واحد للحقيقة لكل الصفحات)
   - صفحة واحدة للدخول (login.html): اسم مستخدم + كلمة مرور فقط. السيرفر (auth-api) هو اللي يحدد نوع الحساب.
   - بنخزّن الجلسة في مفتاح واحد: holoul_session_v1
       "تذكرني" مفعّلة  → localStorage  (بتفضل بعد قفل المتصفح لحد انتهاء التوكن، 14 يوم)
       "تذكرني" متعطّلة → sessionStorage (بتروح بمجرد قفل التبويب)
   - الجلسة فيها توكن لكل نوع حساب بيطابق نفس بيانات الدخول: { admin?, staff?, rep? }
     وهي نفس التوكنز اللي compute-quote / staff-api / crm-api بيتحققوا منها — الصلاحيات الفعلية بتتنفّذ في السيرفر،
     والواجهة هنا بتخفي/تعرض الصفحات والأزرار بس.
   ======================================================================= */
(function (w) {
  'use strict';
  var FN = 'https://xhgwvszdatqlvlgqiikj.supabase.co/functions/v1/auth-api';
  var ANON = 'sb_publishable_4qWmgl6fWMpoU6F_o__ykg_Z0Xy_aJY';
  var KEY = 'holoul_session_v1';
  var KINDS = ['admin', 'staff', 'rep'];
  // مفاتيح الدخول القديمة (قبل التوحيد) — بنمسحها عشان ما يفضلش جلسات قديمة متضاربة
  var LEGACY_LOCAL = ['holoul_admin_sso_v1', 'holoul_admin_remember_v1', 'holoul_rep_remember_v1'];
  var LEGACY_SESSION = ['holoul_crm_session', 'holoul_rep_session'];

  function nowSec() { return Math.floor(Date.now() / 1000); }
  function parse(raw) { try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
  function decodeExp(token) {
    try {
      var s = String(token).split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      return JSON.parse(atob(s)).exp || 0;
    } catch (e) { return 0; }
  }
  function decodeSub(token) {
    try {
      var s = String(token).split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      return JSON.parse(atob(s)).sub || '';
    } catch (e) { return ''; }
  }

  // ---------- storage ----------
  function raw() {
    var s = parse(w.sessionStorage.getItem(KEY));
    if (s) return { s: s, where: 'session' };
    s = parse(w.localStorage.getItem(KEY));
    if (s) return { s: s, where: 'local' };
    return null;
  }
  function write(s) {
    var json = JSON.stringify(s);
    if (s.remember) { w.localStorage.setItem(KEY, json); w.sessionStorage.removeItem(KEY); }
    else { w.sessionStorage.setItem(KEY, json); w.localStorage.removeItem(KEY); }
  }
  function clearLegacy() {
    try { LEGACY_LOCAL.forEach(function (k) { w.localStorage.removeItem(k); }); } catch (e) {}
    try { LEGACY_SESSION.forEach(function (k) { w.sessionStorage.removeItem(k); }); } catch (e) {}
  }
  function prune(s) { // شيل التوكنز المنتهية
    var t = s.tokens || {}, e = s.exp || {}, any = false;
    KINDS.forEach(function (k) {
      if (t[k] && (e[k] || decodeExp(t[k])) > nowSec()) any = true; else { delete t[k]; delete e[k]; }
    });
    return any ? s : null;
  }

  // ---------- public API ----------
  var Auth = {
    /** الجلسة الحالية (متزامنة) أو null لو مفيش/منتهية */
    read: function () {
      try {
        var r = raw(); if (!r) return null;
        var s = prune(r.s);
        if (!s) { Auth.clear(); return null; }
        return s;
      } catch (e) { return null; }
    },
    /** توكن نوع معيّن ('admin' | 'staff' | 'rep') أو null */
    token: function (kind) { var s = Auth.read(); return (s && s.tokens && s.tokens[kind]) || null; },
    has: function (kind) { return !!Auth.token(kind); },
    /** اسم المستخدم الفعلي لنوع معيّن (من التوكن) — للعرض فقط، السيرفر بيتحقق دايمًا */
    username: function (kind) {
      var t = Auth.token(kind); if (!t) return null;
      var sub = decodeSub(t); var i = sub.indexOf(':');
      return i >= 0 ? sub.slice(i + 1) : sub;
    },
    permissions: function () { var s = Auth.read(); return (s && s.permissions) || {}; },
    /** هل المستخدم عنده الصلاحية دي؟ (للأدمن كل حاجة) — للإخفاء في الواجهة فقط */
    can: function (perm) {
      var p = Auth.permissions();
      return !!(p.admin || (p.staff || []).indexOf(perm) >= 0);
    },

    /** تسجيل الدخول: بيرجّع الجلسة أو بيرمي Error برسالة عربية */
    login: function (username, password, remember) {
      return fetch(FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ANON, 'apikey': ANON },
        body: JSON.stringify({ action: 'login', username: username, password: password, rememberMe: !!remember })
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          if (!res.ok || !d.ok) { var e = new Error(d.error || 'بيانات الدخول غير صحيحة'); e.status = res.status; throw e; }
          var s = {
            user: d.user, tokens: d.tokens, exp: d.exp, permissions: d.permissions, modules: d.modules,
            remember: !!remember, savedAt: Date.now()
          };
          clearLegacy();
          write(s);
          return s;
        });
      });
    },

    /** إعادة التحقق من الجلسة من السيرفر وتحديث الصلاحيات.
     *  بيرجّع الجلسة المحدّثة، أو null لو انتهت (وبيمسحها). لو النت واقع بيرجّع الجلسة المحلية من غير ما يطلّع المستخدم. */
    refresh: function () {
      var s = Auth.read(); if (!s) return Promise.resolve(null);
      return fetch(FN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ANON, 'apikey': ANON },
        body: JSON.stringify({ action: 'session-check', tokens: s.tokens })
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          if (res.status === 401 || (d && d.error && !d.ok)) { Auth.clear(); return null; }
          if (!d.ok) return s; // خطأ سيرفر مؤقت — ما نطلّعش المستخدم
          var keep = {}, keepExp = {};
          (d.valid || []).forEach(function (k) { if (s.tokens[k]) { keep[k] = s.tokens[k]; keepExp[k] = (s.exp && s.exp[k]) || decodeExp(s.tokens[k]); } });
          s.tokens = keep; s.exp = keepExp; s.user = d.user; s.permissions = d.permissions; s.modules = d.modules;
          write(s);
          return s;
        });
      }).catch(function () { return s; }); // offline
    },

    /** تدوير توكن بعد تغيير كلمة مرور الأدمن (نفس الجلسة، توكن جديد) */
    setToken: function (kind, token) {
      var r = raw();
      var s = r ? r.s : { user: { displayName: kind === 'admin' ? 'الأدمن' : '', username: kind, kinds: [kind] }, tokens: {}, exp: {}, permissions: { admin: kind === 'admin' }, modules: [], remember: false };
      s.tokens = s.tokens || {}; s.exp = s.exp || {};
      s.tokens[kind] = token; s.exp[kind] = decodeExp(token);
      write(s);
    },
    /** شيل توكن نوع واحد (لو السيرفر رفضه). لو ما بقاش فيه توكنز → الجلسة كلها بتتمسح */
    dropToken: function (kind) {
      var r = raw(); if (!r) return;
      var s = r.s; if (s.tokens) delete s.tokens[kind]; if (s.exp) delete s.exp[kind];
      if (!prune(s)) { Auth.clear(); return; }
      write(s);
    },

    clear: function () {
      try { w.sessionStorage.removeItem(KEY); w.localStorage.removeItem(KEY); } catch (e) {}
      clearLegacy();
    },
    /** خروج كامل من كل الصفحات */
    logout: function () { Auth.clear(); w.location.replace('login.html'); },

    /** تحويل لصفحة الدخول مع الرجوع للصفحة الحالية بعد الدخول */
    goLogin: function (next) {
      var n = next || (w.location.pathname.split('/').pop() || 'index.html') + (w.location.search || '') + (w.location.hash || '');
      w.location.replace('login.html?next=' + encodeURIComponent(n));
    },
    /** بيسمح بس بصفحات المشروع النسبية (حماية من open-redirect) */
    safeNext: function (next, modules) {
      if (!next || typeof next !== 'string') return null;
      if (!/^[A-Za-z0-9._-]+\.html([?#][^\s]*)?$/.test(next)) return null;
      var base = next.split(/[?#]/)[0];
      var ok = (modules || []).some(function (m) { return String(m.url).split(/[?#]/)[0] === base; });
      return ok ? next : null;
    },
    /** الوجهة بعد الدخول: next لو مسموح، وإلا صفحة واحدة لو ده كل اللي متاح، وإلا الصفحة الرئيسية */
    destination: function (session, next) {
      var n = Auth.safeNext(next, session.modules);
      if (n) return n;
      if (session.modules && session.modules.length === 1) return session.modules[0].url;
      return 'home.html';
    },

    /** جلسة صفحة الـ CRM (crm.html) بنفس الشكل القديم SESSION. preferStaff = فتح بوابة الموظف */
    crmSession: function (preferStaff) {
      var s = Auth.read(); if (!s) return null;
      var t = s.tokens || {}, p = s.permissions || {};
      var staff = t.staff ? { role: 'staff', token: t.staff, displayName: s.user.displayName, permissions: p.staff || [], roles: p.roles || [] } : null;
      var admin = t.admin ? { role: 'admin', token: t.admin, displayName: 'الأدمن' } : null;
      var rep = t.rep ? { role: 'rep', token: t.rep, displayName: s.user.displayName } : null;
      if (preferStaff && staff) return staff;
      return admin || rep || staff;
    }
  };
  w.HoloulAuth = Auth;
})(window);
