/* =======================================================================
   HoloulOffline — العمل بدون شبكة (نقدية + استلام/تسليم بضاعة) — مسودة للمراجعة
   - كل عملية مسموحة تُحفظ في طابور محلي (IndexedDB) بمعرّف فريد (client_op_id) ثم تُرسل إلى sync-api.
     المسار واحد أونلاين وأوفلاين، فإرسال نفس العملية مرتين (انقطاع أثناء الإرسال) لا يكرّر القيد.
   - عقد صلاحية 24 ساعة يصدره السيرفر (موقّع ECDSA). بعد انتهائه: تبقى النقدية/البضاعة مفتوحة
     بعلامة «متأخر» ومراجعة أدمن إلزامية (قرار ب). التحقق الفعلي على السيرفر؛ هذا الملف يمنع الاستخدام العادي فقط.
   - غير مفعّل افتراضيًا: لو LEASE_PUBKEY_JWK فاضي، التطبيق يشتغل بالضبط كما هو اليوم.
   ======================================================================= */
(function (w) {
  'use strict';

  var SYNC_FN = 'https://xhgwvszdatqlvlgqiikj.supabase.co/functions/v1/sync-api';
  var ANON = 'sb_publishable_4qWmgl6fWMpoU6F_o__ykg_Z0Xy_aJY';
  // المفتاح العام لتوقيع العقود (يقابله المفتاح الخاص في جدول offline_keys على Supabase).
  // لتعطيل الوحدة كلها فورًا (بما فيها Service Worker): اجعله null وارفع الملف.
  var LEASE_PUBKEY_JWK = {"kty":"EC","crv":"P-256","x":"7qoaytxtbe-jE-OSovht7OgkT_BsG0a-bCeArmrksas","y":"dJkGH5VKUP9AQtFPb31e_N6ZbBILOeLNkSvsoiQIOwA","ext":true,"key_ops":["verify"]};

  var DB_NAME = 'holoul_offline_v1';
  var WARN_MS = 4 * 3600 * 1000;          // تحذير قبل الانتهاء بـ 4 ساعات
  var RENEW_BELOW_MS = 20 * 3600 * 1000;  // تجديد العقد لو الباقي أقل من 20 ساعة
  var CLOCK_SLACK_MS = 2 * 60 * 1000;     // سماحية فرق الساعة
  var KINDS = ['admin', 'rep', 'staff'];

  // action → نوع العملية (null = ليست ضمن المسموح). يطابق ROUTES في sync-api.
  var OFFLINE_OPS = {
    'treasury-record-entry': function (p) {
      return p && p.kind === 'customer_receipt' ? 'cash_receipt'
        : (p && (p.kind === 'supplier_payment' || p.kind === 'expense')) ? 'cash_payment' : null;
    },
    'supply-add-serials': function () { return 'goods_receipt'; },
    'supply-record-qty': function () { return 'goods_receipt'; },
    'supply-set-status': function () { return 'goods_delivery'; }
  };
  // قراءات تلزم لملء النماذج أوفلاين (آخر نسخة ناجحة). تُمسح عند الخروج.
  var READ_CACHE = { 'treasury-lookups': 1, 'supply-project': 1, 'supply-customer-projects': 1, 'supply-catalog': 1 };

  var REASONS = {
    bad_lease: 'عقد الجهاز غير صالح — اتصل بالنت وأعد المحاولة',
    seq_replay: 'ترقيم الجهاز مكرر — تواصل مع الأدمن',
    device_blocked: 'هذا الجهاز محجوب',
    forbidden: 'غير مصرّح لك بهذه العملية',
    unsupported_type: 'نوع عملية غير مدعوم',
    action_not_allowed: 'إجراء غير مسموح أوفلاين',
    params_not_allowed: 'بيانات غير مسموحة أوفلاين',
    bad_request: 'طلب غير صالح',
    admin_rejected: 'رفضها الأدمن عند المراجعة'
  };
  function reasonText(r) { return REASONS[r] || r || 'تعذّر تنفيذ العملية'; }

  /* ---------------- دوال نقية (قابلة للاختبار) ---------------- */
  // حالة العقد. nowEff = max(الساعة الحالية، أعلى وقت سبق رؤيته) فلا يمكن تمديد العقد بإرجاع الساعة.
  function computeState(parsed, nowEff, tampered) {
    if (!parsed) return { state: 'NO_LEASE', remainingMs: 0, tampered: !!tampered };
    var rem = Date.parse(parsed.expires_at) - nowEff;
    var st = rem <= 0 ? 'EXPIRED' : rem <= WARN_MS ? 'WARN' : 'OK';
    return { state: st, remainingMs: rem, tampered: !!tampered };
  }

  /* ---------------- IndexedDB ---------------- */
  var dbp = null;
  function idb() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var r = w.indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () {
        var d = r.result;
        d.createObjectStore('outbox', { keyPath: 'client_op_id' });
        d.createObjectStore('meta');
        d.createObjectStore('rcache');
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
    return dbp;
  }
  function reqP(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  function tx(stores, mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(stores, mode), out;
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error || new Error('abort')); };
        out = fn(t);
      });
    });
  }
  function metaGet(k) { return tx(['meta'], 'readonly', function (t) { return reqP(t.objectStore('meta').get(k)); }); }
  function metaPut(k, v) { return tx(['meta'], 'readwrite', function (t) { t.objectStore('meta').put(v, k); }); }
  function getOp(id) { return tx(['outbox'], 'readonly', function (t) { return reqP(t.objectStore('outbox').get(id)); }); }
  function putOp(op) { return tx(['outbox'], 'readwrite', function (t) { t.objectStore('outbox').put(op); }); }
  function delOp(id) { return tx(['outbox'], 'readwrite', function (t) { t.objectStore('outbox').delete(id); }); }
  function allOps() {
    return tx(['outbox'], 'readonly', function (t) { return reqP(t.objectStore('outbox').getAll()); })
      .then(function (a) { return (a || []).sort(function (x, y) { return x.device_seq - y.device_seq; }); });
  }

  /* ---------------- الوقت (أعلى وقت سبق رؤيته) ---------------- */
  var hw = 0, hwSaved = 0;
  function now() { var t = Date.now(); if (t > hw) hw = t; return Math.max(t, hw); }
  function clockTampered() { return hw > 0 && Date.now() < hw - CLOCK_SLACK_MS; }
  function persistHw() { if (hw - hwSaved > 60000) { hwSaved = hw; metaPut('hw', hw).catch(function () {}); } }

  /* ---------------- الجهاز والعقود ---------------- */
  var deviceId = null, inited = null;
  var leaseCache = {};
  function uuid() {
    if (w.crypto && w.crypto.randomUUID) return w.crypto.randomUUID();
    var s = ''; var r = w.crypto.getRandomValues(new Uint8Array(16)); r[6] = (r[6] & 15) | 64; r[8] = (r[8] & 63) | 128;
    for (var i = 0; i < 16; i++) { s += (r[i] + 256).toString(16).slice(1); if (i === 3 || i === 5 || i === 7 || i === 9) s += '-'; }
    return s;
  }
  function enabled() { return !!(LEASE_PUBKEY_JWK && w.indexedDB && w.crypto && w.crypto.subtle); }
  function init() {
    if (inited) return inited;
    inited = Promise.all([metaGet('device_id'), metaGet('hw')]).then(function (v) {
      hw = Number(v[1]) || 0; hwSaved = hw; now();
      if (v[0]) { deviceId = v[0]; return; }
      deviceId = uuid(); // عمدًا داخل IndexedDB فقط: لو اتمسحت، الجهاز يُعتبر جديدًا ويأخذ عقدًا جديدًا
      return metaPut('device_id', deviceId);
    }).then(purgeOld);
    return inited;
  }
  function purgeOld() {
    return allOps().then(function (ops) {
      var cut = Date.now() - 24 * 3600 * 1000;
      return Promise.all(ops.filter(function (o) { return o.status === 'applied' && o.local_created < cut; })
        .map(function (o) { return delOp(o.client_op_id); }));
    });
  }
  function b64uToBytes(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
    var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u;
  }
  function verifyLease(rec) {
    if (!enabled() || !rec || !rec.lease_json || !rec.sig) return Promise.resolve(null);
    return w.crypto.subtle.importKey('jwk', LEASE_PUBKEY_JWK, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
      .then(function (k) { return w.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, b64uToBytes(rec.sig), new TextEncoder().encode(rec.lease_json)); })
      .then(function (ok) {
        if (!ok) return null;
        var p = JSON.parse(rec.lease_json);
        return p.device_id === deviceId ? p : null;
      }).catch(function () { return null; });
  }
  function getLease(kind) {
    if (leaseCache[kind] !== undefined) return Promise.resolve(leaseCache[kind]);
    return metaGet('lease_' + kind).then(verifyLease).then(function (p) { leaseCache[kind] = p; return p; });
  }
  function saveLease(kind, rec) {
    return verifyLease(rec).then(function (p) {
      if (!p) return null;
      leaseCache[kind] = p;
      return metaPut('lease_' + kind, { lease_json: rec.lease_json, sig: rec.sig }).then(function () { return p; });
    });
  }

  /* ---------------- الشبكة ---------------- */
  function authToken(kind) { try { return w.HoloulAuth ? w.HoloulAuth.token(kind) : null; } catch (e) { return null; } }
  function online() { return w.navigator.onLine !== false; }
  function post(body, timeoutMs) {
    var ctl = new AbortController(), t = setTimeout(function () { ctl.abort(); }, timeoutMs || 20000);
    return fetch(SYNC_FN, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ANON, 'apikey': ANON },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (x) { clearTimeout(t); return x; }, function (e) { clearTimeout(t); throw e; });
  }
  function fetchLease(kind, token) {
    return post({ action: 'lease', token: token, device_id: deviceId }, 15000).then(function (res) {
      if (!res.data || !res.data.ok) return null;
      return saveLease(kind, res.data);
    }).catch(function () { return null; });
  }
  function ensureLease(kind) {
    return getLease(kind).then(function (l) {
      if (l) return l;
      var tok = authToken(kind);
      if (!online() || !tok) return null;
      return fetchLease(kind, tok);
    });
  }

  /* ---------------- الطابور ---------------- */
  function enqueue(kind, opType, action, params, lease) {
    var op = {
      client_op_id: uuid(), kind: kind, lease_id: lease.id, op_type: opType,
      payload: { action: action, params: params },
      client_created_at: new Date(now()).toISOString(), // لا يسبق أعلى وقت سبق رؤيته → لا تأريخ رجعي
      status: 'queued', local_created: Date.now()
    };
    persistHw();
    return tx(['meta', 'outbox'], 'readwrite', function (t) {
      var m = t.objectStore('meta');
      return reqP(m.get('seq')).then(function (cur) {
        var seq = (Number(cur) || 0) + 1;
        m.put(seq, 'seq');
        op.device_seq = seq;
        op.ref = 'OFF-' + deviceId.slice(0, 4).toUpperCase() + '-' + seq;
        t.objectStore('outbox').put(op);
        return op;
      });
    });
  }
  function strip(o) {
    return { client_op_id: o.client_op_id, device_seq: o.device_seq, lease_id: o.lease_id, op_type: o.op_type,
      payload: o.payload, client_created_at: o.client_created_at };
  }
  function applyResult(r) {
    return getOp(r.client_op_id).then(function (op) {
      if (!op) return null;
      if (r.status === 'applied') { op.status = 'applied'; op.result = r.result || { ok: true }; }
      else if (r.status === 'pending_review' || r.status === 'accepted') { op.status = 'review'; op.flags = r.flags || []; }
      else { op.status = 'failed'; op.reason = reasonText(r.reject_reason || r.error); }
      return putOp(op);
    });
  }

  var syncing = null, needLogin = {};
  function syncNow(opts) {
    if (syncing) return syncing;
    syncing = doSync(opts || {}).then(function (x) { syncing = null; updateBanner(); return x; }, function (e) { syncing = null; updateBanner(); throw e; });
    return syncing;
  }
  function doSync(opts) {
    if (!enabled()) return Promise.resolve({ skipped: 'disabled' });
    if (!online()) return Promise.resolve({ skipped: 'offline' });
    return init().then(allOps).then(function (ops) {
      var queued = ops.filter(function (o) { return o.status === 'queued'; });
      var chain = Promise.resolve();
      KINDS.forEach(function (k) {
        var mine = queued.filter(function (o) { return o.kind === k; }), tok = authToken(k);
        if (!mine.length) return;
        if (!tok) { needLogin[k] = true; return; }
        needLogin[k] = false;
        chain = chain.then(function () { return pushBatch(k, tok, mine, opts); });
      });
      return chain.then(function () {
        // تجديد العقد حتى بدون عمليات
        var c2 = Promise.resolve();
        KINDS.forEach(function (k) {
          var tok = authToken(k); if (!tok) return;
          c2 = c2.then(function () { return getLease(k); }).then(function (l) {
            var rem = l ? Date.parse(l.expires_at) - now() : -1;
            if (!l || rem < RENEW_BELOW_MS) return fetchLease(k, tok);
          });
        });
        return c2;
      });
    });
  }
  function pushBatch(kind, token, ops, opts) {
    var chunk = ops.slice(0, 100);
    return post({ action: 'push', token: token, device_id: deviceId, ops: chunk.map(strip) }, opts.timeoutMs || 30000).then(function (res) {
      if (res.status === 401) { needLogin[kind] = true; return; }
      if (!res.data || !res.data.ok) return;     // خطأ سيرفر: تبقى في الطابور وتُعاد لاحقًا (آمن بفضل client_op_id)
      var chain = Promise.resolve();
      (res.data.results || []).forEach(function (r) { chain = chain.then(function () { return applyResult(r); }); });
      if (res.data.lease_json) chain = chain.then(function () { return saveLease(kind, res.data); });
      return chain;
    }).catch(function () { /* لا اتصال فعلي: تبقى في الطابور */ });
  }

  /* ---------------- تنفيذ عملية (نفس المسار أونلاين/أوفلاين) ---------------- */
  function queuedResult(op, review) {
    return { ok: true, queued: true, review: !!review, ref: op.ref, result: { added: 0, queued: true } };
  }
  function outcome(op) {
    if (op.status === 'applied') return Promise.resolve(op.result || { ok: true });
    if (op.status === 'failed') return delOp(op.client_op_id).then(function () { throw new Error(op.reason || 'تعذّر تنفيذ العملية'); });
    return Promise.resolve(queuedResult(op, op.status === 'review'));
  }
  function submit(opType, action, params, kind, orig) {
    return init().then(function () { return ensureLease(kind); }).then(function (lease) {
      if (!lease) {
        if (online()) return orig(action, params);   // الجهاز غير مفعّل والنت موجود: المسار القديم بدون تغيير
        throw new Error('هذا الجهاز لم يُفعَّل للعمل أوفلاين بعد — افتح التطبيق مرة واحدة مع اتصال بالنت');
      }
      return enqueue(kind, opType, action, params, lease).then(function (op) {
        if (!online()) { updateBanner(); return queuedResult(op); }
        return syncNow({ timeoutMs: 15000 }).then(function () { return getOp(op.client_op_id); }).then(function (cur) {
          if (cur.status === 'queued' && online()) return syncNow({ timeoutMs: 15000 }).then(function () { return getOp(op.client_op_id); });
          return cur;
        }).then(outcome);
      });
    });
  }

  /* ---------------- كاش القراءة ---------------- */
  function stable(o) { try { return JSON.stringify(o, Object.keys(o || {}).sort()); } catch (e) { return ''; } }
  function isNetErr(e) { return e instanceof TypeError || (e && e.name === 'AbortError') || !online(); }
  function cachedRead(action, payload, orig) {
    var key = action + ':' + stable(payload);
    var live = orig(action, payload).then(function (d) {
      tx(['rcache'], 'readwrite', function (t) { t.objectStore('rcache').put({ t: Date.now(), d: d }, key); }).catch(function () {});
      return d;
    });
    var fromCache = function () { return tx(['rcache'], 'readonly', function (t) { return reqP(t.objectStore('rcache').get(key)); }); };
    if (!online()) return live.catch(function (e) { return fromCache().then(function (rec) { if (rec) return rec.d; throw e; }); });
    // اتصال ضعيف: لو السيرفر تأخر 10 ثواني وعندنا نسخة قديمة نستخدمها
    return Promise.race([live, new Promise(function (res) { setTimeout(function () { res(fromCache().then(function (rec) { return rec ? rec.d : live; })); }, 10000); })])
      .catch(function (e) { if (!isNetErr(e)) throw e; return fromCache().then(function (rec) { if (rec) return rec.d; throw e; }); });
  }
  function wipeReadCache() { return tx(['rcache'], 'readwrite', function (t) { t.objectStore('rcache').clear(); }).catch(function () {}); }

  /* ---------------- ربط crmApi ---------------- */
  function wrapCrmApi(orig, getRole) {
    if (!enabled()) return orig;
    return function (action, payload) {
      payload = payload || {};
      var typeFn = OFFLINE_OPS[action];
      if (typeFn) {
        var t = typeFn(payload), kind = getRole && getRole();
        if (t && kind) return submit(t, action, payload, kind, orig);
      }
      if (READ_CACHE[action]) return cachedRead(action, payload, orig);
      return orig(action, payload);
    };
  }

  /* ---------------- الشريط والقائمة ---------------- */
  var bar = null, panel = null;
  function counts(ops) {
    var c = { queued: 0, review: 0, failed: 0 };
    ops.forEach(function (o) { if (c[o.status] !== undefined) c[o.status]++; });
    return c;
  }
  function fmtRem(ms) { var h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000); return h + 'س ' + m + 'د'; }
  function mkBar() {
    if (bar || !w.document || !w.document.body) return;
    bar = w.document.createElement('div');
    bar.setAttribute('dir', 'rtl');
    bar.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:99999;display:none;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap;padding:8px 12px;font:600 13px Cairo,system-ui,sans-serif;color:#fff;background:#155E85;';
    w.document.body.appendChild(bar);
  }
  function updateBanner() {
    if (!enabled() || !w.document) return Promise.resolve();
    return init().then(allOps).then(function (ops) {
      var kind = KINDS.filter(function (k) { return authToken(k); })[0];
      if (!kind) { if (bar) bar.style.display = 'none'; return; }
      return getLease(kind).then(function (l) {
        var st = computeState(l, now(), clockTampered()), c = counts(ops);
        persistHw();
        var parts = [], bg = '#155E85', show = false;
        if (!online()) { parts.push('📴 أوفلاين'); show = true; }
        if (st.state === 'NO_LEASE') { parts.push('الجهاز غير مفعّل للأوفلاين — اتصل بالنت مرة'); bg = '#B0432C'; show = show || !online(); }
        else if (st.state === 'EXPIRED') { parts.push('انتهى عقد الـ24 ساعة — النقدية والبضاعة تُسجَّل «متأخرة» وتحتاج مراجعة الأدمن'); bg = '#B0432C'; show = true; }
        else if (st.state === 'WARN') { parts.push('⏳ يتبقى ' + fmtRem(st.remainingMs) + ' — اتصل بالنت للمزامنة'); bg = '#B8860B'; show = true; }
        if (st.tampered) { parts.push('⚠ ساعة الجهاز أقدم من آخر استخدام'); bg = '#B0432C'; show = true; }
        if (c.queued) { parts.push(c.queued + ' عملية بانتظار المزامنة'); show = true; }
        if (c.review) { parts.push(c.review + ' بانتظار مراجعة الأدمن'); show = true; }
        if (c.failed) { parts.push(c.failed + ' فشلت'); bg = '#B0432C'; show = true; }
        Object.keys(needLogin).forEach(function (k) { if (needLogin[k] && c.queued) parts.push('سجّل الدخول (' + k + ') للمزامنة'); });
        mkBar(); if (!bar) return;
        bar.style.background = bg; bar.style.display = show ? 'flex' : 'none';
        bar.innerHTML = '<span></span><button type="button" data-a="sync" style="border:0;border-radius:6px;padding:4px 10px;cursor:pointer">مزامنة</button><button type="button" data-a="list" style="border:0;border-radius:6px;padding:4px 10px;cursor:pointer">تفاصيل</button>';
        bar.firstChild.textContent = parts.join(' · ');
        bar.querySelector('[data-a=sync]').onclick = function () { syncNow({}).catch(function () {}); };
        bar.querySelector('[data-a=list]').onclick = showList;
      });
    }).catch(function () {});
  }
  var STATUS_AR = { queued: 'بانتظار المزامنة', review: 'بانتظار مراجعة الأدمن', applied: 'تمت', failed: 'فشلت' };
  var TYPE_AR = { cash_receipt: 'استلام نقدية', cash_payment: 'دفع نقدي', goods_receipt: 'استلام بضاعة', goods_delivery: 'تسليم بضاعة' };
  function showList() {
    allOps().then(function (ops) {
      if (panel) panel.remove();
      panel = w.document.createElement('div');
      panel.setAttribute('dir', 'rtl');
      panel.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px;font-family:Cairo,system-ui,sans-serif';
      var box = w.document.createElement('div');
      box.style.cssText = 'background:#fff;color:#122436;border-radius:12px;max-width:560px;width:100%;max-height:80vh;overflow:auto;padding:16px';
      var h = w.document.createElement('h3'); h.textContent = 'عمليات الأوفلاين'; box.appendChild(h);
      if (!ops.length) { var e = w.document.createElement('p'); e.textContent = 'لا توجد عمليات.'; box.appendChild(e); }
      ops.slice().reverse().forEach(function (o) {
        var row = w.document.createElement('div');
        row.style.cssText = 'border-bottom:1px solid #DEE7E4;padding:8px 0;font-size:13px';
        row.textContent = (o.ref || '') + ' — ' + (TYPE_AR[o.op_type] || o.op_type) + ' — ' + (STATUS_AR[o.status] || o.status) +
          (o.reason ? ' (' + o.reason + ')' : '') + ' — ' + new Date(o.client_created_at).toLocaleString('ar-EG');
        if (o.status === 'failed' || o.status === 'applied') {
          var b = w.document.createElement('button'); b.textContent = 'إخفاء'; b.style.marginInlineStart = '8px';
          b.onclick = function () { delOp(o.client_op_id).then(function () { showList(); updateBanner(); }); };
          row.appendChild(b);
        }
        box.appendChild(row);
      });
      var close = w.document.createElement('button'); close.textContent = 'إغلاق'; close.style.marginTop = '10px';
      close.onclick = function () { panel.remove(); panel = null; };
      box.appendChild(close); panel.appendChild(box); w.document.body.appendChild(panel);
    });
  }

  /* ---------------- تشغيل ---------------- */
  function start() {
    if (!enabled()) return;
    if (w.navigator && w.navigator.serviceWorker) w.navigator.serviceWorker.register('sw.js').catch(function () {});
    init().then(function () { return updateBanner(); }).then(function () { return syncNow({}); }).catch(function () {});
    w.addEventListener('online', function () { syncNow({}).catch(function () {}); });
    w.addEventListener('offline', function () { updateBanner(); });
    setInterval(function () { updateBanner(); if (online()) syncNow({}).catch(function () {}); }, 60000);
  }
  if (w.document) {
    if (w.document.readyState === 'loading') w.document.addEventListener('DOMContentLoaded', start); else start();
  }

  w.HoloulOffline = {
    enabled: enabled, init: init, wrapCrmApi: wrapCrmApi, syncNow: syncNow, wipeReadCache: wipeReadCache,
    list: allOps, _pure: { computeState: computeState, reasonText: reasonText }
  };
})(typeof window !== 'undefined' ? window : globalThis);
