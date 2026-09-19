/* =======================================================================
   6) RENDER — FEASIBILITY VIEW
   ======================================================================= */
let feasOverrides = {};
function renderFeas(){
  const q = currentQuote();
  const f = computeFeasibility(q.finalTotal, q.calcKW, feasOverrides);
  const F = {...cachedFeas, ...feasOverrides};

  const chart = buildChart(f.cfGrid, f.cfDiesel);

  return `
  <div class="card quote-banner" style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px;align-items:center">
    <div style="display:flex;align-items:center;gap:8px">
      <img src="${LOGO_SRC}" alt="HoloulEnergy" style="width:38px;height:38px;object-fit:contain">
      <div>
        <div style="font-family:'Cairo',sans-serif;font-weight:800;font-size:13px">حلول الطاقة المتجددة والمقاولات</div>
        <div style="font-size:10px;color:var(--muted)">دراسة جدوى — HoloulEnergy</div>
      </div>
    </div>
    <div>
      <div style="font-size:11px;color:var(--muted)">دراسة جدوى مُقدَّمة إلى</div>
      <div style="font-family:'Cairo',sans-serif;font-weight:700;font-size:14px">${state.client || '—'}</div>
    </div>
    <div style="text-align:left">
      <div style="font-size:11px;color:var(--muted)">التاريخ</div>
      <div class="num" style="font-size:12px">${new Date().toLocaleDateString('en-GB')}</div>
    </div>
  </div>

  <div class="card no-print">
    <h3>افتراضات دراسة الجدوى <span class="tag">القدرة: ${fmt1(q.calcKW)} KW — CAPEX: ${fmt(q.finalTotal)} ﷼</span></h3>
    <div class="assump">
      <div><label>ساعات الذروة الشمسية PSH (ساعة/يوم)</label><input type="number" id="f_psh" value="${F.psh}" step="0.1"></div>
      <div><label>تدهور كفاءة الألواح سنويًا (%)</label><input type="number" id="f_deg" value="${F.panelDegradationPct}" step="0.05"></div>
      <div><label>سعر كهرباء الشبكة (﷼/kWh)</label><input type="number" id="f_gridp" value="${F.gridPrice}" step="0.01"></div>
      <div><label>تصاعد سعر الشبكة سنويًا (%)</label><input type="number" id="f_gride" value="${F.gridEscalationPct}" step="0.5"></div>
      <div><label>سعر الديزل (﷼/لتر)</label><input type="number" id="f_dp" value="${F.dieselPrice}" step="0.01"></div>
      <div><label>استهلاك المولد (لتر/kWh)</label><input type="number" id="f_dc" value="${F.dieselConsumptionPerKWh}" step="0.01"></div>
      <div><label>تصاعد سعر الديزل سنويًا (%)</label><input type="number" id="f_de" value="${F.dieselEscalationPct}" step="0.5"></div>
      <div><label>الصيانة السنوية (% من CAPEX)</label><input type="number" id="f_om" value="${F.solarOMPctOfCapex}" step="0.25"></div>
    </div>
  </div>

  <div class="grid2" style="grid-template-columns:1fr 1fr">
    <div class="card">
      <h3>مقابل شبكة الكهرباء</h3>
      <div class="stats">
        <div class="stat"><div class="v">${f.paybackGrid?f.paybackGrid.toFixed(2):'—'}</div><div class="l">فترة الاسترداد (سنة)</div></div>
        <div class="stat"><div class="v">${f.irrGrid!=null?(f.irrGrid*100).toFixed(1)+'%':'—'}</div><div class="l">IRR الحقيقي (30 سنة)</div></div>
        <div class="stat"><div class="v">${fmt(f.profit30Grid)}</div><div class="l">صافي الربح 30 سنة (﷼)</div></div>
      </div>
    </div>
    <div class="card">
      <h3>مقابل مولد ديزل</h3>
      <div class="stats">
        <div class="stat"><div class="v">${f.paybackDiesel?f.paybackDiesel.toFixed(2):'—'}</div><div class="l">فترة الاسترداد (سنة)</div></div>
        <div class="stat"><div class="v">${f.irrDiesel!=null?(f.irrDiesel*100).toFixed(1)+'%':'—'}</div><div class="l">IRR الحقيقي (30 سنة)</div></div>
        <div class="stat"><div class="v">${fmt(f.profit30Diesel)}</div><div class="l">صافي الربح 30 سنة (﷼)</div></div>
      </div>
    </div>
  </div>

  <div class="card">
    <h3>التدفق النقدي التراكمي — 30 سنة</h3>
    ${chart}
    <div class="note">الخط الكهرماني = مقابل الشبكة · الخط الغامق = مقابل الديزل. النقطة صفر تمثل تكلفة المحطة (CAPEX)، وتقاطع كل خط مع خط الصفر يمثل فترة الاسترداد.</div>
  </div>

  <div class="card">
    <h3>الأثر البيئي (السنة الأولى)</h3>
    <div class="stats">
      <div class="stat"><div class="v">${fmt(f.litersYear1)}</div><div class="l">لتر ديزل موفّر / سنة</div></div>
      <div class="stat"><div class="v">${fmt1(f.co2Year1)}</div><div class="l">طن CO₂ موفّر / سنة</div></div>
    </div>
  </div>

  <div class="no-print" style="margin-top:4px">
    <button class="btn" onclick="window.print()">🖨️ طباعة دراسة الجدوى / حفظ PDF</button>
  </div>`;
}

function buildChart(cfGrid, cfDiesel){
  const cumG=[], cumD=[]; let cg=0, cd=0;
  cfGrid.forEach(v=>{cg+=v; cumG.push(cg);});
  cfDiesel.forEach(v=>{cd+=v; cumD.push(cd);});
  const W=900,H=240,pad=36;
  const allVals=[...cumG,...cumD];
  const maxV=Math.max(...allVals), minV=Math.min(...allVals,0);
  const n=cumG.length;
  const x=i=>pad+(W-2*pad)*i/(n-1);
  const y=v=>H-pad-(H-2*pad)*(v-minV)/(maxV-minV||1);
  const path=arr=>arr.map((v,i)=>`${i===0?'M':'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const zeroY=y(0);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <line x1="${pad}" y1="${zeroY}" x2="${W-pad}" y2="${zeroY}" stroke="#C9C4B4" stroke-width="1" stroke-dasharray="4 4"/>
    <path d="${path(cumD)}" fill="none" stroke="#103959" stroke-width="2.5"/>
    <path d="${path(cumG)}" fill="none" stroke="#EAB515" stroke-width="2.5"/>
  </svg>`;
}

