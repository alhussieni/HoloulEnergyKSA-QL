/* =======================================================================
   10) مقارنة الألواح — نفس مدخلات المندوب على الشاشة، لكل الألواح المتاحة،
   في حالتين: توريد فقط / توريد وتركيب.
   التكلفة والهامش بتظهر فقط لجلسة الأدمن (السيرفر بيتحقق من التوكن).
   ======================================================================= */
const CMP_TOGGLE_LABELS = { panel:'ألواح شمسية', inverter:'انفرتر', ip65:'حماية IP65', combiner:'لوحة تجميع', cables:'كابلات DC', mc4:'وصلات MC4', structure:'شاسيه/حوامل', concrete:'خرسانة', earth:'تأريض', reactor:'ريأكتور', civilworks:'أعمال مدنية', elecworks:'أعمال الكهرباء', supply:'نقل وتوريد' };
const COMPARE_FN = SUPABASE_URL + '/functions/v1/compare-panels';
let cmpData = null, cmpScope = 'current', cmpLoading = false, cmpError = null, cmpSort = 'price', cmpHideCosts = true, cmpTech = false;   // «تفاصيل فنية» مخفية افتراضيًا (الجدول عريض)
/* أرقام فنية للمقارنة — 30 سنة = ‎100 − تدهور السنة الأولى − (التدهور السنوي × 29)‎ ، وفقد الحرارة عند خلية 65°م = |معامل Pmax| × 40 */
function cmpTechVals(t){
  if(!t) return {};
  const n = x=>(x==null||!isFinite(x))?null:+x;
  const eff=n(t.effPct), coef=n(t.tempCoefPmax), ann=n(t.annualDegPct), first=n(t.firstYearDegPct);
  return { eff, coef, ann, heat: coef==null?null:Math.abs(coef)*40, after30: (ann==null)?null:(100-(first==null?1:first)-ann*29) };
}   // مخفية افتراضيًا؛ زر «معلومات إضافية» يفتحها

/* موظفو الشركة فقط: مندوب مسجّل الدخول أو أدمن. العميل (guest) مفيش عنده توكن → مفيش مقارنة.
   السيرفر بيتحقق من التوكن بنفسه (compare-panels بيرفض أي طلب من غير توكن صالح)، والإخفاء هنا للشكل بس. */
function cmpAuth(){
  const embed = (typeof embedAdminToken !== 'undefined' && embedAdminToken) ? embedAdminToken : null;
  if(adminTokenMem && adminInfoUnlocked) return { adminToken: adminTokenMem, showCosts: true };   // أدمن فاتح «معلومات إضافية»
  if(typeof repTokenMem !== 'undefined' && repTokenMem) return { token: repTokenMem };             // مندوب: أسعار بدون تكلفة
  if(embed) return { adminToken: embed, showCosts: false };                                        // أدمن من داخل الـ CRM
  if(adminTokenMem) return { adminToken: adminTokenMem, showCosts: false };
  return null;
}
function cmpIsStaff(){ return !!cmpAuth(); }

async function cmpFetch(retried){
  const auth = cmpAuth();
  if(!auth) throw new Error('المقارنة متاحة لموظفي الشركة فقط — سجّل الدخول كمندوب أو أدمن.');
  const res = await fetch(COMPARE_FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'apikey': SUPABASE_ANON_KEY },
    body: JSON.stringify({ input: buildEngineInput(), ...auth })
  });
  let d; try{ d = await res.json(); }catch(e){ throw new Error('استجابة غير صالحة من الخادم'); }
  if(res.status === 401){
    // انتهت جلسة الأدمن → نرجع لجلسة المندوب (لو موجودة) من غير تكلفة، مرة واحدة بس
    if(auth.adminToken && adminTokenMem && !retried){ adminInfoUnlocked = false; adminTokenMem = null; return cmpFetch(true); }
    throw new Error(d.error || 'الجلسة منتهية، الرجاء تسجيل الدخول مجددًا');
  }
  if(!res.ok) throw new Error(d.error || 'خطأ في الخادم');
  return d;
}

function cmpClose(){ const o = document.getElementById('cmpOverlay'); if(o) o.remove(); document.body.style.overflow = ''; }

async function openPanelCompare(){
  if(!cmpIsStaff()){ alert('المقارنة متاحة لموظفي الشركة فقط.'); return; }
  cmpClose();
  cmpLoading = true; cmpError = null; cmpData = null;
  cmpDraw();
  try{ cmpData = await cmpFetch(); }catch(e){ cmpError = e.message || 'تعذر تحميل المقارنة'; }
  cmpLoading = false;
  cmpDraw();
}

function cmpDraw(){
  let o = document.getElementById('cmpOverlay');
  if(!o){
    o = document.createElement('div'); o.id = 'cmpOverlay';
    o.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:20px 10px';
    o.addEventListener('click', e=>{ if(e.target === o) cmpClose(); });
    document.body.appendChild(o); document.body.style.overflow = 'hidden';
  }
  /* ستايل table.bom بيثبّت الهيدر sticky بـ top:74px (لهيدر الصفحة) — جوه النافذة ده كان بينزّله على الصفوف، فبنلغيه هنا */
  const cmpCss = `<style>#cmpOverlay table.bom th{position:static !important;top:auto !important;background:#F6F3EA;white-space:nowrap}#cmpOverlay table.bom td,#cmpOverlay table.bom th{vertical-align:middle}</style>`;
  o.innerHTML = cmpCss + `<div class="card" style="width:100%;max-width:1100px;background:#fff;position:relative">${cmpBody()}</div>`;
  const q = s=>o.querySelector(s);
  q('#cmpX').onclick = cmpClose;
  o.querySelectorAll('[data-cmpscope]').forEach(b=>b.onclick = ()=>{ cmpScope = b.dataset.cmpscope; cmpDraw(); });
  const tb = q('#cmpTechBtn'); if(tb) tb.onclick = ()=>{ cmpTech = !cmpTech; cmpDraw(); };
  o.querySelectorAll('[data-cmpsort]').forEach(b=>b.onclick = ()=>{ cmpSort = b.dataset.cmpsort; cmpDraw(); });
  const tgl = q('#cmpToggleCosts'); if(tgl) tgl.onclick = ()=>{ cmpHideCosts = !cmpHideCosts; cmpDraw(); };
  const unlock = q('#cmpUnlock');
  if(unlock) unlock.onclick = ()=>adminPasswordGate(()=>{ adminInfoUnlocked = true; openPanelCompare(); });
  const retry = q('#cmpRetry'); if(retry) retry.onclick = openPanelCompare;
  o.querySelectorAll('[data-cmppick]').forEach(b=>b.onclick = ()=>{ state.panelIdx = +b.dataset.cmppick; cmpClose(); scheduleRefresh(); });
}

function cmpBody(){
  const head = `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:10px">
    <h3 style="margin:0">مقارنة الألواح — ${esc(String(state.hp))} HP</h3>
    <button class="btn ghost small" id="cmpX" type="button">✕ إغلاق</button></div>`;
  if(cmpLoading) return head + `<div class="note" style="padding:30px;text-align:center"><span class="spin"></span> جارِ حساب كل الألواح من الخادم...</div>`;
  if(cmpError) return head + `<div class="note" style="color:#B0432C;padding:20px">${esc(cmpError)}</div><button class="btn small" id="cmpRetry" type="button">إعادة المحاولة</button>`;
  if(!cmpData || !cmpData.panels || !cmpData.panels.length) return head + `<div class="note">لا توجد ألواح متاحة للمقارنة.</div>`;

  const adminData = !!cmpData.admin;
  const admin = adminData && !cmpHideCosts;   // «إخفاء التفاصيل»: يخفي التكلفة والهامش والربح من الشاشة (للعرض أمام العميل)
  // لو الخادم لسه على النسخة القديمة (من غير scope «current») نرجع لـ «توريد فقط» بدل ما تنكسر الشاشة
  const hasCurrent = cmpData.panels.every(p=>p.scopes && p.scopes.current);
  const sc = (cmpScope === 'current' && !hasCurrent) ? 'materials' : cmpScope;
  const enabledKeys = Array.isArray(cmpData.enabled) ? cmpData.enabled : Object.keys(state.toggles||{}).filter(k=>state.toggles[k]);
  const enabledChips = enabledKeys.map(k=>`<span style="display:inline-block;padding:1px 8px;margin:2px;border-radius:10px;font-size:11px;background:#EEF6F0;color:#1B6B3A">${esc(CMP_TOGGLE_LABELS[k]||k)}</span>`).join('');
  const enabledBar = (sc === 'current') ? `<div style="font-size:12px;margin-bottom:8px">البنود المفعّلة في الحاسبة: ${enabledChips || '—'}</div>` : '';
  const rows = cmpData.panels.slice().sort((a,b)=>{
    if(cmpSort === 'profit' && admin) return b.scopes[sc].profit - a.scopes[sc].profit;
    return a.scopes[sc].final - b.scopes[sc].final;
  });
  const finals = rows.map(r=>r.scopes[sc].final);
  const minF = Math.min(...finals), maxF = Math.max(...finals);
  const maxProfit = admin ? Math.max(...rows.map(r=>r.scopes[sc].profit)) : null;
  const tag = (txt, bg, fg)=>`<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;font-weight:700;background:${bg};color:${fg};margin-inline-start:4px">${txt}</span>`;
  const f0 = n=>Math.round(n).toLocaleString('en-US');

  const seg = `<div class="seg" style="margin-bottom:10px">
      ${hasCurrent ? `<button type="button" data-cmpscope="current" class="${sc==='current'?'active':''}">حسب البنود المفعّلة</button>` : ''}
      <button type="button" data-cmpscope="materials" class="${sc==='materials'?'active':''}">توريد فقط</button>
      <button type="button" data-cmpscope="turnkey" class="${sc==='turnkey'?'active':''}">توريد وتركيب</button>
    </div>`;
  const hideBtn = adminData ? `<button type="button" class="btn ghost small" id="cmpToggleCosts" aria-pressed="${cmpHideCosts ? 'false' : 'true'}" style="${cmpHideCosts ? '' : 'font-weight:800'}">ⓘ معلومات إضافية</button>` : '';
  const sortBar = adminData ? `<div style="font-size:12px;margin-bottom:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      ${admin ? `ترتيب حسب:
      <button type="button" class="btn ghost small" data-cmpsort="price" ${cmpSort==='price'?'style="font-weight:800"':''}>الأقل سعراً</button>
      <button type="button" class="btn ghost small" data-cmpsort="profit" ${cmpSort==='profit'?'style="font-weight:800"':''}>الأعلى ربحاً</button>` : ''}
      <span style="flex:1"></span>${hideBtn}</div>` : '';

  const th = t=>`<th style="white-space:nowrap">${t}</th>`;
  const techOn = cmpTech && rows.some(r=>r.tech);
  const tv = rows.map(r=>cmpTechVals(r.tech));
  const best = (key, hi)=>{ const xs = tv.map(t=>t[key]).filter(x=>x!=null); return xs.length ? (hi ? Math.max(...xs) : Math.min(...xs)) : null; };
  const bEff = best('eff',true), bHeat = best('heat',false), bAnn = best('ann',false), b30 = best('after30',true);
  const techCols = techOn ? th('الكفاءة') + th('معامل الحرارة (Pmax)') + th('فقد الحرارة عند 65°م') + th('التدهور السنوي') + th('الإنتاج بعد 30 سنة') : '';
  const techCell = (v, best, txt, hiGood)=>`<td class="num"${(v!=null && best!=null && v===best && rows.length>1) ? ' style="font-weight:800;color:#1B6B3A"' : ''}>${v==null ? '—' : txt}</td>`;
  const techBtn = `<button type="button" class="btn ghost small" id="cmpTechBtn" aria-pressed="${cmpTech?'true':'false'}" style="margin-bottom:10px;${cmpTech?'font-weight:800':''}">🔬 تفاصيل فنية (كفاءة · حرارة · تدهور)</button>`;
  const costCols = admin ? th('التكلفة') + th('الهامش') + th('الهامش %') : '';
  const body = rows.map((r,ri)=>{
    const T = tv[ri];
    const s = r.scopes[sc];
    const isMin = s.final === minF, isMax = s.final === maxF && rows.length > 1;
    const diff = s.final - minF;
    const labels = (isMin ? tag('الأوفر','#DDF3E4','#1B6B3A') : '') + (isMax ? tag('بريميوم','#EEE','#555') : '')
      + (admin && s.profit === maxProfit ? tag('الأعلى ربحاً','#FFF1CC','#8A6100') : '')
      + (r.warning ? tag('⚠ انفرتر','#FEECEA','#8A2E1D') : '');
    const costTds = admin ? `<td class="num">${f0(s.cost)}</td><td class="num" style="font-weight:700;color:${s.profit>=0?'#1B6B3A':'#B0432C'}">${f0(s.profit)}</td><td class="num">${s.profitPct.toFixed(1)}%</td>` : '';
    const sel = (r.idx === state.panelIdx) ? ' (الحالي)' : '';
    return `<tr${isMin?' style="background:#F3FBF6"':''}>
      <td style="white-space:nowrap;font-weight:700">${esc(r.brand)} ${esc(String(r.power))}W${sel}${labels}</td>
      <td class="num">${r.totalPanels}</td>
      <td class="num">${r.calcKW.toFixed(1)}</td>
      <td class="num">${r.panelsPerString}×${r.arrays}</td>
      <td class="num">${f0(r.Voc)}</td>
      <td class="num">${f0(r.Iimp)}</td>
      <td class="num">${r.combinerInputs ?? '—'}</td>
      ${techOn ? techCell(T.eff,bEff,T.eff!=null?T.eff.toFixed(1)+'%':'') + techCell(T.coef,null,T.coef!=null?T.coef.toFixed(2)+'%/°م':'') + techCell(T.heat,bHeat,T.heat!=null?T.heat.toFixed(1)+'%':'') + techCell(T.ann,bAnn,T.ann!=null?T.ann.toFixed(2)+'%':'') + techCell(T.after30,b30,T.after30!=null?T.after30.toFixed(1)+'%':'') : ''}
      ${costTds}
      <td class="num">${f0(s.net)}</td>
      <td class="num" style="font-weight:800">${f0(s.final)}</td>
      <td class="num">${f0(s.perKw)}</td>
      <td class="num">${diff === 0 ? '—' : '+' + f0(diff) + ' (' + (diff / minF * 100).toFixed(1) + '%)'}</td>
      <td><button type="button" class="btn small" data-cmppick="${r.idx}">اختيار</button></td>
    </tr>`;
  }).join('');

  const warns = rows.filter(r=>r.warning).map(r=>`<div class="note" style="color:#8A2E1D">⚠ ${esc(r.brand)} ${esc(String(r.power))}W: ${esc(r.warning)}</div>`).join('');
  const adminHint = adminData
    ? (admin ? `<div class="notice-row" style="margin-top:8px">${infoIcon(`التكلفة = تكلفة البنود المفعّلة قبل الضريبة · الهامش = السعر قبل الضريبة − التكلفة (بعد خصم الفئة والخصم الخاص الحاليين). ظاهرة لجلسة الأدمن فقط.`)}</div>` : '')
    : `<div style="margin-top:8px"><button type="button" class="btn ghost small" id="cmpUnlock">ⓘ معلومات إضافية</button></div>`;

  return head + seg + enabledBar + techBtn + sortBar + `
    <div style="overflow-x:auto"><table class="bom" style="width:100%;font-size:12.5px">
      <thead><tr>${th('اللوح')}${th('العدد')}${th('KW')}${th('ألواح×سلاسل')}${th('Voc (V)')}${th('Imp (A)')}${th('لوحة التجميع')}${techCols}${costCols}${th('قبل الضريبة')}${th('الإجمالي شامل الضريبة')}${th('ريال/KW')}${th('الفرق عن الأوفر')}<th></th></tr></thead>
      <tbody>${body}</tbody></table></div>
    ${warns}
    <div class="notice-row" style="margin-top:8px">${infoIcon(`الأسعار بالريال · الانفرتر ${esc(cmpData.invKW != null ? cmpData.invKW + ' KW' : '')} ثابت لكل الألواح · الحساب بنفس إعدادات الشاشة الحالية (إعدادات متقدمة/خصم).${techOn ? ' · الإنتاج بعد 30 سنة والتدهور حسب ضمان الأداء في الداتا شيت · فقد الحرارة = انخفاض القدرة عند حرارة خلية 65°م مقارنة بـ 25°م · الأخضر = الأفضل.' : ''}`)}</div>
    ${adminHint}`;
}
