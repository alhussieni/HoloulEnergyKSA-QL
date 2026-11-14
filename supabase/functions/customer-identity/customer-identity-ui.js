/*
 * customer-identity-ui.js — بطاقة هوية العميل (وحدة مستقلة، لا تعتمد على كود crm.html)
 *
 * الاستخدام داخل شاشة تفاصيل العميل:
 *   <div id="identity-slot"></div>
 *   <script src="customer-identity-ui.js"></script>
 *   <script>
 *     HoloulIdentity.mount(document.getElementById("identity-slot"), {
 *       apiUrl: "https://<project-ref>.supabase.co/functions/v1/customer-identity",
 *       anonKey: "<anon-key>",                 // اختياري لأن verify_jwt=false
 *       customerId: customer.id,
 *       customerType: customer.customer_type,  // 'individual' | 'فرد' | null | 'institution'...
 *       getAdminToken: () => adminToken,       // ترجع null لغير الأدمن
 *       getRepToken:   () => repToken,
 *     });
 *   </script>
 *
 * يعرض: للأدمن حقل الإدخال والحفظ والحذف. للمندوب: حالة "مسجّلة/غير مسجّلة" فقط.
 * لا يستخدم innerHTML مع أي بيانات قادمة من الخادم (منعاً لـ XSS).
 */
(function (global) {
  "use strict";

  var TYPES = [
    ["national_id", "هوية وطنية"],
    ["iqama", "إقامة"],
    ["gcc_id", "هوية خليجية"],
    ["passport", "جواز سفر"],
  ];
  var AR = "٠١٢٣٤٥٦٧٨٩", FA = "۰۱۲۳۴۵۶۷۸۹";

  function normalize(type, raw) {
    var s = String(raw == null ? "" : raw)
      .replace(/[٠-٩۰-۹]/g, function (c) {
        var i = AR.indexOf(c);
        return String(i >= 0 ? i : FA.indexOf(c));
      })
      .replace(/[\s\-_.\u200e\u200f\u202a-\u202e]/g, "")
      .trim();
    return type === "gcc_id" || type === "passport" ? s.toUpperCase() : s;
  }
  function localCheck(type, v) {
    if (type === "national_id") return /^1[0-9]{9}$/.test(v) ? "" : "الهوية الوطنية 10 أرقام وتبدأ بـ 1";
    if (type === "iqama") return /^2[0-9]{9}$/.test(v) ? "" : "رقم الإقامة 10 أرقام ويبدأ بـ 2";
    return /^[A-Z0-9]{5,20}$/.test(v) ? "" : "من 5 إلى 20 حرفاً أو رقماً بلا رموز";
  }
  function isIndividual(t) {
    return t == null || t === "" || t === "individual" || t === "فرد";
  }

  function el(tag, props, text) {
    var n = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) {
      if (k === "style") n.style.cssText = props[k]; else n[k] = props[k];
    });
    if (text != null) n.textContent = text;
    return n;
  }

  async function call(cfg, action, extra) {
    var admin = cfg.getAdminToken && cfg.getAdminToken();
    var rep = cfg.getRepToken && cfg.getRepToken();
    var body = Object.assign({ action: action, customerId: cfg.customerId }, extra || {});
    if (admin) body.adminToken = admin; else if (rep) body.token = rep;
    var headers = { "Content-Type": "application/json" };
    if (cfg.anonKey) { headers.apikey = cfg.anonKey; headers.Authorization = "Bearer " + cfg.anonKey; }
    var res = await fetch(cfg.apiUrl, { method: "POST", headers: headers, body: JSON.stringify(body) });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok && !data.error) data.error = "تعذّر الاتصال بالخادم (" + res.status + ")";
    return data;
  }

  function mount(root, cfg) {
    root.textContent = "";
    root.setAttribute("dir", "rtl");
    var box = el("div", { style: "border:1px solid #d0d5dd;border-radius:8px;padding:12px;font-family:inherit" });
    box.appendChild(el("div", { style: "font-weight:700;margin-bottom:8px" }, "وثيقة الهوية"));
    root.appendChild(box);

    if (!isIndividual(cfg.customerType)) {
      box.appendChild(el("div", { style: "color:#667085" },
        "هذا العميل منشأة: السجل التجاري والرقم الضريبي في بيانات العميل، ولا حاجة لرقم هوية."));
      return;
    }

    var isAdmin = !!(cfg.getAdminToken && cfg.getAdminToken());
    var statusLine = el("div", { style: "margin-bottom:8px;color:#344054" }, "جارٍ التحميل…");
    var msg = el("div", { style: "margin-top:6px;min-height:1.2em;font-size:13px" });
    box.appendChild(statusLine);

    var typeSel, numInp, saveBtn, clearBtn, editWrap;

    function say(text, bad) {
      msg.textContent = text || "";
      msg.style.color = bad ? "#b42318" : "#067647";
    }

    async function refresh() {
      var r = await call(cfg, "identity-status", { customerIds: [cfg.customerId] });
      if (r.error) { statusLine.textContent = r.error; return; }
      var s = (r.status || {})[String(cfg.customerId)] || { present: false };
      if (!s.present) statusLine.textContent = "غير مسجّلة";
      else if (s.masked) {
        var label = (TYPES.filter(function (t) { return t[0] === s.id_type; })[0] || ["", s.id_type])[1];
        statusLine.textContent = "مسجّلة: " + label + " " + s.masked;
      } else statusLine.textContent = "مسجّلة";
      if (clearBtn) clearBtn.style.display = s.present ? "" : "none";
    }

    if (isAdmin) {
      editWrap = el("div", { style: "display:flex;gap:8px;flex-wrap:wrap;align-items:center" });
      typeSel = el("select");
      TYPES.forEach(function (t) { typeSel.appendChild(el("option", { value: t[0] }, t[1])); });
      numInp = el("input", { type: "text", inputMode: "text", autocomplete: "off", maxLength: 24,
        placeholder: "رقم الوثيقة", style: "direction:ltr;text-align:right;min-width:180px" });
      saveBtn = el("button", { type: "button" }, "حفظ");
      clearBtn = el("button", { type: "button", style: "display:none" }, "حذف");
      editWrap.appendChild(typeSel); editWrap.appendChild(numInp);
      editWrap.appendChild(saveBtn); editWrap.appendChild(clearBtn);
      box.appendChild(editWrap);

      async function doSave(confirmed) {
        var type = typeSel.value;
        var value = normalize(type, numInp.value);
        var err = localCheck(type, value);
        if (err) { say(err, true); return; }
        saveBtn.disabled = true;
        try {
          var r = await call(cfg, "identity-set", { idType: type, idNumber: value, acceptChecksumMismatch: !!confirmed });
          if (r.needsConfirm) {
            if (global.confirm(r.warning + "\nهل تريد الحفظ رغم ذلك؟")) { saveBtn.disabled = false; return doSave(true); }
            say("لم يُحفظ", true);
          } else if (r.error) say(r.error, true);
          else { numInp.value = ""; say("تم الحفظ"); await refresh(); }
        } finally { saveBtn.disabled = false; }
      }
      saveBtn.addEventListener("click", function () { doSave(false); });

      clearBtn.addEventListener("click", async function () {
        if (!global.confirm("حذف رقم الهوية المسجّل لهذا العميل؟")) return;
        var r = await call(cfg, "identity-clear");
        if (r.error) say(r.error, true); else { say("تم الحذف"); await refresh(); }
      });
    }

    box.appendChild(msg);
    refresh();
  }

  global.HoloulIdentity = { mount: mount, normalize: normalize, localCheck: localCheck, isIndividual: isIndividual };
})(typeof window !== "undefined" ? window : globalThis);
