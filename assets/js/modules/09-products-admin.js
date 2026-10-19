/* =========================================================
   الأصناف والضمان — واجهة الأدمن لـ Edge Function: products-admin
   - قواعد الضمان على مستوى (الفئة + الماركة)
   - قائمة الأصناف (الرمز الدائم + الضمان الفعلي) وتعديل الاستثناءات
   - إعداد: ربط فئات الكتالوج الجديدة بعائلة (بادئة الرمز) + مزامنة
   يعتمد على: SUPABASE_URL, SUPABASE_ANON_KEY, adminTokenMem, currentAdminSubSection
   ========================================================= */
let prodAdmState = { tab: 'rules', data: null, q: '', family: '', status: '', editId: null, loading: false, error: '', msg: '' };

function pxEsc(x){
  return String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const PX_SRC = { product: 'خاص بالصنف', rule: 'قاعدة الماركة', class: 'افتراضي الفئة', none: 'غير محدد' };

async function pxCall(action, payload){
  const res = await fetch(SUPABASE_URL + '/functions/v1/products-admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify(Object.assign({ action, adminToken: adminTokenMem }, payload || {})),
  });
  let data;
  try { data = await res.json(); } catch (e) { throw new Error('استجابة غير صالحة من الخادم'); }
  if (!res.ok) throw new Error(data.error || 'خطأ في الخادم');
  return data;
}
function pxYears(v){ return v == null ? '—' : (Number(v) === 0 ? 'بدون ضمان' : v + ' سنة'); }
function pxGroups(d){
  const m = new Map();
  d.products.forEach(p => {
    if (!p.brand) return;
    const k = p.catalog_category + '||' + p.brand;
    if (!m.has(k)) m.set(k, { cat: p.catalog_category, brand: p.brand, n: 0, cls: p.warranty_class });
    m.get(k).n++;
  });
  return [...m.values()].sort((a, b) => a.cat.localeCompare(b.cat, 'ar') || a.brand.localeCompare(b.brand));
}

async function prodAdmLoad(){
  if (prodAdmState.loading) return;
  prodAdmState.loading = true; prodAdmState.error = '';
  pxRender();
  try { prodAdmState.data = await pxCall('overview'); }
  catch (e) { prodAdmState.error = e.message; }
  prodAdmState.loading = false;
  pxRender();
}
function prodAdmMount(){
  const root = document.getElementById('prodadm-root');
  if (!root) return;
  const onTab = (typeof currentAdminSubSection === 'undefined') || currentAdminSubSection.products === 'items';
  if (onTab && !prodAdmState.data && !prodAdmState.loading && !prodAdmState.error) prodAdmLoad();
  else pxRender();
}

function pxRulesHtml(d){
  const groups = pxGroups(d);
  const ruleMap = new Map(d.rules.map(r => [r.catalog_category + '||' + r.brand, r]));
  const std = d.standardWarranties || {};
  const noBrand = d.products.filter(p => !p.brand).length;
  const rows = groups.map((g, i) => {
    const r = ruleMap.get(g.cat + '||' + g.brand) || {};
    const sd = g.cls ? std[g.cls] : null;
    const ph = sd && sd.defectYears != null ? 'افتراضي ' + sd.defectYears : 'افتراضي —';
    const phP = sd && sd.performanceYears != null ? 'افتراضي ' + sd.performanceYears : 'اختياري';
    return '<tr><td>' + pxEsc(g.cat) + (g.cls ? '' : ' <span style="color:#b00020">⚠ غير مربوطة بفئة ضمان</span>') + '</td>'
      + '<td>' + pxEsc(g.brand) + '</td><td class="num">' + g.n + '</td>'
      + '<td><input type="number" min="0" max="100" step="0.5" data-px-y="' + i + '" value="' + (r.warranty_years == null ? '' : r.warranty_years) + '" placeholder="' + ph + '" style="width:120px"></td>'
      + '<td><input type="number" min="0" max="100" step="0.5" data-px-p="' + i + '" value="' + (r.performance_warranty_years == null ? '' : r.performance_warranty_years) + '" placeholder="' + phP + '" style="width:120px"></td></tr>';
  }).join('');
  return '<div class="note">حدد الضمان لكل <b>ماركة داخل الفئة</b>. الخانة الفاضية = يتبع الافتراضي، و<b>0</b> = بدون ضمان. الاستثناء لصنف بعينه من تبويب "الأصناف". التغيير يسري على <b>الفواتير الجديدة</b> فقط.</div>'
    + (noBrand ? '<div class="note" style="color:#8a5a00">' + noBrand + ' صنف بدون ماركة في الكتالوج، ولا يمكن تطبيق قاعدة ماركة عليهم.</div>' : '')
    + '<div style="overflow-x:auto;margin-top:8px"><table class="tbl" style="width:100%"><thead><tr><th>الفئة</th><th>الماركة</th><th>عدد الأصناف</th><th>مدة الضمان (سنة)</th><th>ضمان الأداء (سنة)</th></tr></thead><tbody>' + rows + '</tbody></table></div>'
    + '<div style="margin-top:10px"><button class="btn" id="px-save-rules">💾 حفظ قواعد الضمان</button></div>';
}

function pxFilteredProducts(d){
  const q = prodAdmState.q.trim().toLowerCase();
  return d.products.filter(p =>
    (!prodAdmState.family || p.family === prodAdmState.family) &&
    (!prodAdmState.status || p.status === prodAdmState.status) &&
    (!q || [p.product_code, p.name_ar, p.brand, p.catalog_name, p.part_number].some(x => String(x || '').toLowerCase().includes(q))));
}
function pxProductsHtml(d){
  const list = pxFilteredProducts(d);
  const famOpts = '<option value="">كل العائلات</option>' + d.families.map(f => '<option value="' + pxEsc(f.prefix) + '"' + (prodAdmState.family === f.prefix ? ' selected' : '') + '>' + pxEsc(f.prefix) + ' — ' + pxEsc(f.name_ar) + '</option>').join('');
  const stOpts = [['', 'كل الحالات'], ['active', 'نشط'], ['inactive', 'غير متاح']].map(o => '<option value="' + o[0] + '"' + (prodAdmState.status === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('');
  const edit = d.products.find(p => p.id === prodAdmState.editId);
  const editHtml = edit ? (
    '<div class="card" style="margin:10px 0;border:1px solid var(--line)"><b>' + pxEsc(edit.product_code) + ' — ' + pxEsc(edit.name_ar) + '</b>'
    + '<div class="note">الخانة الفاضية = يتبع قاعدة الماركة ثم افتراضي الفئة. القيم هنا استثناء لهذا الصنف فقط.</div>'
    + '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-top:8px">'
    + '<div><label>ضمان الصنف (سنة)</label><input type="number" min="0" max="100" step="0.5" id="px-e-y" value="' + (edit.warranty_years == null ? '' : edit.warranty_years) + '"></div>'
    + '<div><label>ضمان الأداء (سنة)</label><input type="number" min="0" max="100" step="0.5" id="px-e-p" value="' + (edit.performance_warranty_years == null ? '' : edit.performance_warranty_years) + '"></div>'
    + '<div><label>خصم المستورد الخاص (%) — داخلي</label><input type="number" min="0" max="100" step="0.1" id="px-e-d" value="' + (edit.supplier_discount_pct == null ? '' : edit.supplier_discount_pct) + '"></div>'
    + '<div><label>Part Number</label><input id="px-e-pn" value="' + pxEsc(edit.part_number || '') + '"></div>'
    + '<div><label>يحتاج رقم تسلسلي</label><select id="px-e-s"><option value="1"' + (edit.requires_serial ? ' selected' : '') + '>نعم</option><option value="0"' + (!edit.requires_serial ? ' selected' : '') + '>لا</option></select></div>'
    + '</div><div style="display:flex;gap:10px;margin-top:10px"><button class="btn" id="px-e-save">💾 حفظ</button><button class="btn ghost" id="px-e-cancel">إلغاء</button></div></div>') : '';
  const rows = list.map(p => {
    const e = p.effective || {};
    return '<tr' + (p.status === 'inactive' ? ' style="opacity:.65"' : '') + '><td><b>' + pxEsc(p.product_code) + '</b></td><td>' + pxEsc(p.name_ar) + (p.in_catalog ? '' : ' <span style="color:#b00020" title="الصنف غير موجود الآن في الكتالوج">⚠ خارج الكتالوج</span>') + '</td>'
      + '<td>' + pxEsc(p.brand || '—') + '</td><td>' + pxEsc(p.family) + ' / ' + pxEsc(p.category || '') + '</td><td>' + (p.status === 'active' ? 'نشط' : 'غير متاح') + '</td>'
      + '<td>' + pxYears(e.years) + (e.performance != null ? ' / أداء ' + e.performance : '') + '<br><span class="note">' + pxEsc(PX_SRC[e.years_source] || '') + '</span></td>'
      + '<td>' + (p.requires_serial ? 'نعم' : 'لا') + '</td>'
      + '<td><button class="btn ghost small" data-px-edit="' + p.id + '">تعديل</button></td></tr>';
  }).join('');
  return '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">'
    + '<input id="px-q" placeholder="بحث بالرمز أو الاسم أو الماركة" value="' + pxEsc(prodAdmState.q) + '" style="min-width:220px">'
    + '<select id="px-f">' + famOpts + '</select><select id="px-st">' + stOpts + '</select>'
    + '<span class="note">' + list.length + ' من ' + d.products.length + ' صنف</span></div>'
    + editHtml
    + '<div style="overflow-x:auto"><table class="tbl" style="width:100%"><thead><tr><th>الرمز</th><th>الاسم</th><th>الماركة</th><th>العائلة / التصنيف</th><th>الحالة</th><th>الضمان الفعلي</th><th>سيريال</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}
function pxSetupHtml(d){
  const famOpts = d.families.map(f => '<option value="' + pxEsc(f.prefix) + '">' + pxEsc(f.prefix) + ' — ' + pxEsc(f.name_ar) + '</option>').join('');
  const unm = d.unmappedCategories.length
    ? d.unmappedCategories.map((u, i) =>
      '<div style="display:grid;grid-template-columns:2fr 1.5fr 1fr 1fr auto;gap:8px;align-items:end;margin-top:8px" data-px-unm="' + i + '">'
      + '<div><label>فئة كتالوج جديدة (' + u.rows + ' صنف)</label><input value="' + pxEsc(u.catalog_category) + '" disabled></div>'
      + '<div><label>العائلة (بادئة الرمز)</label><select data-px-fam>' + famOpts + '</select></div>'
      + '<div><label>تصنيف فرعي</label><input data-px-sub placeholder="مثال: monitoring"></div>'
      + '<div><label>سيريال</label><select data-px-ser><option value="0">لا</option><option value="1">نعم</option></select></div>'
      + '<button class="btn" data-px-map="' + i + '">ربط</button></div>').join('')
    : '<div class="note" style="color:#0a7a3d">✓ كل فئات الكتالوج مربوطة بعائلة، وأي صنف جديد بيتولّد له رمز تلقائيًا.</div>';
  const mapped = d.categoryMap.map(m => '<tr><td>' + pxEsc(m.catalog_category) + '</td><td>' + pxEsc(m.family) + '</td><td>' + pxEsc(m.sub_category || '') + '</td><td>' + (m.requires_serial ? 'نعم' : 'لا') + '</td></tr>').join('');
  return '<h4>فئات جديدة تحتاج ربط</h4>' + unm
    + '<h4 style="margin-top:16px">عائلة جديدة (بادئة 3 حروف)</h4>'
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end"><div><label>البادئة</label><input id="px-nf-prefix" maxlength="3" placeholder="MON" style="width:90px;text-transform:uppercase"></div>'
    + '<div><label>الاسم بالعربي</label><input id="px-nf-ar" placeholder="أنظمة مراقبة"></div><div><label>الاسم بالإنجليزي</label><input id="px-nf-en"></div>'
    + '<button class="btn" id="px-nf-save">إضافة العائلة</button></div>'
    + '<h4 style="margin-top:16px">الفئات المربوطة</h4><div style="overflow-x:auto"><table class="tbl" style="width:100%"><thead><tr><th>فئة الكتالوج</th><th>العائلة</th><th>التصنيف الفرعي</th><th>سيريال</th></tr></thead><tbody>' + mapped + '</tbody></table></div>'
    + '<div style="margin-top:12px"><button class="btn ghost" id="px-sync">🔄 مزامنة الأصناف مع الكتالوج الآن</button></div>';
}

function pxRender(){
  const root = document.getElementById('prodadm-root');
  if (!root) return;
  const s = prodAdmState, d = s.data;
  const tabs = [['rules', 'قواعد الضمان'], ['products', 'الأصناف'], ['setup', 'إعداد الفئات']]
    .map(t => '<button class="btn ' + (s.tab === t[0] ? '' : 'ghost') + ' small" data-px-tab="' + t[0] + '" type="button">' + t[1] + '</button>').join(' ');
  let body;
  if (s.loading && !d) body = '<div class="note">جارِ التحميل...</div>';
  else if (s.error && !d) body = '<div class="note" style="color:#b00020">تعذر التحميل: ' + pxEsc(s.error) + '</div><button class="btn" id="px-retry">إعادة المحاولة</button>';
  else if (!d) body = '<div class="note">...</div>';
  else body = s.tab === 'rules' ? pxRulesHtml(d) : s.tab === 'products' ? pxProductsHtml(d) : pxSetupHtml(d);
  root.innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">' + tabs
    + ' <button class="btn ghost small" id="px-reload" type="button">⟳ تحديث</button></div>'
    + (s.msg ? '<div class="note" style="margin-bottom:8px">' + pxEsc(s.msg) + '</div>' : '')
    + (s.error && d ? '<div class="note" style="color:#b00020;margin-bottom:8px">' + pxEsc(s.error) + '</div>' : '')
    + body;
  pxWire(root);
}

async function pxAction(fn){
  prodAdmState.error = ''; prodAdmState.msg = '';
  try { await fn(); } catch (e) { prodAdmState.error = e.message; }
  pxRender();
}
function pxNum(id){ const el = document.getElementById(id); return el && el.value !== '' ? Number(el.value) : null; }

function pxWire(root){
  const s = prodAdmState, d = s.data;
  root.querySelectorAll('[data-px-tab]').forEach(b => b.onclick = () => { s.tab = b.dataset.pxTab; s.editId = null; s.msg = ''; pxRender(); });
  const reload = root.querySelector('#px-reload'); if (reload) reload.onclick = () => prodAdmLoad();
  const retry = root.querySelector('#px-retry'); if (retry) retry.onclick = () => prodAdmLoad();
  if (!d) return;

  const saveRules = root.querySelector('#px-save-rules');
  if (saveRules) saveRules.onclick = () => pxAction(async () => {
    const groups = pxGroups(d);
    const ruleMap = new Map(d.rules.map(r => [r.catalog_category + '||' + r.brand, r]));
    const val = v => v === '' ? null : Number(v);
    const changed = [];
    groups.forEach((g, i) => {
      const y = val(root.querySelector('[data-px-y="' + i + '"]').value);
      const p = val(root.querySelector('[data-px-p="' + i + '"]').value);
      const old = ruleMap.get(g.cat + '||' + g.brand) || {};
      const oy = old.warranty_years == null ? null : Number(old.warranty_years);
      const op = old.performance_warranty_years == null ? null : Number(old.performance_warranty_years);
      if (y !== oy || p !== op) changed.push({ catalog_category: g.cat, brand: g.brand, warranty_years: y, performance_warranty_years: p });
    });
    if (!changed.length) { s.msg = 'مفيش تغييرات للحفظ.'; return; }
    const r = await pxCall('save-rules', { rules: changed });
    s.msg = 'تم الحفظ: ' + r.saved + ' قاعدة، وإزالة ' + r.removed + '. تسري على الفواتير الجديدة.';
    s.data = await pxCall('overview');
  });

  const q = root.querySelector('#px-q');
  if (q) { q.oninput = () => { s.q = q.value; const pos = q.selectionStart; pxRender(); const n = document.getElementById('px-q'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} } }; }
  const f = root.querySelector('#px-f'); if (f) f.onchange = () => { s.family = f.value; pxRender(); };
  const st = root.querySelector('#px-st'); if (st) st.onchange = () => { s.status = st.value; pxRender(); };
  root.querySelectorAll('[data-px-edit]').forEach(b => b.onclick = () => { s.editId = Number(b.dataset.pxEdit); pxRender(); });
  const ec = root.querySelector('#px-e-cancel'); if (ec) ec.onclick = () => { s.editId = null; pxRender(); };
  const es = root.querySelector('#px-e-save');
  if (es) es.onclick = () => pxAction(async () => {
    const pn = document.getElementById('px-e-pn').value.trim();
    await pxCall('set-product', { id: s.editId, fields: {
      warranty_years: pxNum('px-e-y'), performance_warranty_years: pxNum('px-e-p'), supplier_discount_pct: pxNum('px-e-d'),
      part_number: pn || null, requires_serial: document.getElementById('px-e-s').value === '1' } });
    s.editId = null; s.msg = 'تم حفظ الصنف.';
    s.data = await pxCall('overview');
  });

  root.querySelectorAll('[data-px-map]').forEach(b => b.onclick = () => pxAction(async () => {
    const i = Number(b.dataset.pxMap), box = root.querySelector('[data-px-unm="' + i + '"]');
    const u = d.unmappedCategories[i];
    const r = await pxCall('map-category', { catalog_category: u.catalog_category, family: box.querySelector('[data-px-fam]').value,
      sub_category: box.querySelector('[data-px-sub]').value.trim() || null, requires_serial: box.querySelector('[data-px-ser]').value === '1' });
    s.msg = 'تم الربط وإنشاء ' + r.created + ' صنف برموز تلقائية.';
    s.data = await pxCall('overview');
  }));
  const nf = root.querySelector('#px-nf-save');
  if (nf) nf.onclick = () => pxAction(async () => {
    await pxCall('create-family', { prefix: document.getElementById('px-nf-prefix').value, name_ar: document.getElementById('px-nf-ar').value.trim(), name_en: document.getElementById('px-nf-en').value.trim() });
    s.msg = 'تمت إضافة العائلة.'; s.data = await pxCall('overview');
  });
  const sy = root.querySelector('#px-sync');
  if (sy) sy.onclick = () => pxAction(async () => { const r = await pxCall('sync'); s.msg = 'تمت المزامنة، أصناف جديدة: ' + r.created; s.data = await pxCall('overview'); });
}
