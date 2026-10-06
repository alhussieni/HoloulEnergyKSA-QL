/* Forces Western digits (0-9) everywhere on the page.
 * - Rewrites Arabic-Indic / Persian digits and separators in any text that reaches the DOM
 *   (database text, server messages, locale-formatted values).
 * - Turns <input type="number"> into a text input with a decimal keypad, because browsers with an
 *   Arabic locale draw number inputs with Arabic-Indic digits and the page cannot override that.
 * - Normalizes digits typed by the user (e.g. from an Arabic keyboard) before app handlers run. */
(function () {
  'use strict';
  var MAP = {};
  '٠١٢٣٤٥٦٧٨٩'.split('').forEach(function (c, i) { MAP[c] = String(i); });
  '۰۱۲۳۴۵۶۷۸۹'.split('').forEach(function (c, i) { MAP[c] = String(i); });
  MAP['٫'] = '.'; MAP['٬'] = ','; MAP['٪'] = '%';
  var RE = /[٠-٩۰-۹٫٬٪]/g;
  var TEST = /[٠-٩۰-۹٫٬٪]/;
  function fix(s) { return TEST.test(s) ? s.replace(RE, function (c) { return MAP[c]; }) : s; }

  function fixAttrs(el) {
    ['placeholder', 'title', 'aria-label', 'alt'].forEach(function (a) {
      var v = el.getAttribute && el.getAttribute(a);
      if (v && TEST.test(v)) el.setAttribute(a, fix(v));
    });
  }
  function fixInput(el) {
    if (el.tagName !== 'INPUT' || el.__lfDone) return;
    if (el.type === 'number') {
      var min = el.getAttribute('min');
      el.__lfNumeric = true;
      el.__lfAllowNeg = min === null || parseFloat(min) < 0;
      try { el.type = 'text'; } catch (e) {}
      el.setAttribute('inputmode', 'decimal');
      el.setAttribute('autocomplete', 'off');
    }
    el.__lfDone = true;
    if (el.value && TEST.test(el.value)) el.value = fix(el.value);
  }
  function walk(node) {
    if (!node) return;
    if (node.nodeType === 3) {
      var p = node.parentNode && node.parentNode.nodeName;
      if (p === 'SCRIPT' || p === 'STYLE' || p === 'TEXTAREA') return;
      if (TEST.test(node.nodeValue)) node.nodeValue = fix(node.nodeValue);
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.nodeName === 'SCRIPT' || node.nodeName === 'STYLE') return;
    fixAttrs(node);
    if (node.nodeName === 'INPUT') fixInput(node);
    for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
  }

  // Typed input: normalize before the app's own oninput handlers read e.target.value.
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'INPUT') return;
    var v = el.value, nv = fix(v);
    if (el.__lfNumeric) {
      nv = nv.replace(/,/g, '.').replace(el.__lfAllowNeg ? /[^0-9.\-]/g : /[^0-9.]/g, '');
      var neg = el.__lfAllowNeg && nv.charAt(0) === '-';
      nv = nv.replace(/-/g, '');
      var parts = nv.split('.');
      nv = parts.shift() + (parts.length ? '.' + parts.join('') : '');
      if (neg) nv = '-' + nv;
    }
    if (nv !== v) {
      var pos = el.selectionStart;
      el.value = nv;
      try { if (pos != null) el.setSelectionRange(pos, pos); } catch (err) {}
    }
  }, true);

  function start() {
    walk(document.documentElement);
    document.title = fix(document.title);
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'characterData') walk(m.target);
        else for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
