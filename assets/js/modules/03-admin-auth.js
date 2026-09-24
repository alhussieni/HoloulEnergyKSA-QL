/* =======================================================================
   3) ADMIN AUTH — password is verified server-side, never in this file
   ======================================================================= */
function normalizeAdminConfig(cfg){
  if(!Array.isArray(cfg.productCatalog)) cfg.productCatalog = [];
  // Defensive fallback only — the real defaults live in
  // 0013_offgrid_ongrid_ready_systems.sql. This just stops the admin panel
  // from throwing if that migration hasn't been run yet on this DB.
  if(!cfg.offgrid) cfg.offgrid = { sunHours:5.5, systemEfficiency:0.80, batteryDoD:0.90, defaultAutonomyDays:1, peakLoadDivisor:6, batteryMarkupPct:30, inverterMarkupPct:30, structurePerPanelCost:250, structurePerPanelSell:350, cablingFixedCost:800, cablingFixedSell:1200, installPerKwCost:150, installPerKwSell:250 };
  if(!cfg.ongrid) cfg.ongrid = { sunHours:5.5, performanceRatio:0.80, tariffRate:0.18, inverterMarkupPct:30, structurePerPanelCost:250, structurePerPanelSell:350, cablingFixedCost:800, cablingFixedSell:1200, netMeteringFeeCost:0, netMeteringFeeSell:0, installPerKwCost:150, installPerKwSell:250 };
  if(!Array.isArray(cfg.offgrid.appliancePresets) || !cfg.offgrid.appliancePresets.length) cfg.offgrid.appliancePresets = OFFGRID_APPLIANCE_PRESETS.map(p=>({...p}));
  if(!Array.isArray(cfg.readyOffgridSystems)) cfg.readyOffgridSystems = [];
  if(!Array.isArray(cfg.discounts)) cfg.discounts = [];
  return cfg;
}

function adminPasswordGate(cb){
  if(adminTokenMem){ cb(); return; }
  const shared = readSharedAdminSession();
  if(shared){
    adminTokenMem = shared;
    callEngine('admin-config', { adminToken: adminTokenMem }).then(data=>{
      adminConfig = normalizeAdminConfig(data.config);
      cb();
    }).catch(()=>{ adminTokenMem = null; clearSharedAdminSession(); adminPasswordGate(cb); });
    return;
  }
  const p = prompt('كلمة سر الأدمن:');
  if(p==null) return;
  callEngine('admin-login', { adminPassword: p }).then(loginData=>{
    adminTokenMem = loginData.token;
    shareAdminSession(adminTokenMem);
    return callEngine('admin-config', { adminToken: adminTokenMem });
  }).then(data=>{
    adminConfig = normalizeAdminConfig(data.config);
    cb();
  }).catch(()=>{ adminTokenMem = null; alert('كلمة السر غير صحيحة'); });
}

/* IRR via bisection on a cash-flow array where cf[0] is the year-0 outlay */
function irr(cf){
  function npv(r){ return cf.reduce((s,c,i)=>s + c/Math.pow(1+r,i), 0); }
  let lo=-0.9, hi=5, mid;
  if(npv(lo)*npv(hi) > 0) return null;
  for(let i=0;i<100;i++){
    mid=(lo+hi)/2;
    if(npv(lo)*npv(mid) <= 0) hi=mid; else lo=mid;
  }
  return mid;
}

function computeFeasibility(capex, calcKW, opt){
  const f = {...cachedFeas, ...opt};
  const baseGen = calcKW*f.psh*365;
  const years = f.years;
  const genArr=[], gridArr=[], dieselArr=[];
  let cumGrid=-capex, cumDiesel=-capex, paybackGrid=null, paybackDiesel=null;
  const cfGrid=[-capex], cfDiesel=[-capex];
  const omYear = capex*f.solarOMPctOfCapex/100;
  for(let y=1;y<=years;y++){
    const gen = baseGen*Math.pow(1-f.panelDegradationPct/100, y-1);
    const gridVal = gen*f.gridPrice*Math.pow(1+f.gridEscalationPct/100, y-1);
    const dieselVal = gen*f.dieselConsumptionPerKWh*f.dieselPrice*Math.pow(1+f.dieselEscalationPct/100, y-1);
    const om = y===1?0:omYear;
    const netGrid = gridVal-om, netDiesel = dieselVal-om;
    genArr.push(gen); gridArr.push(netGrid); dieselArr.push(netDiesel);
    cfGrid.push(netGrid); cfDiesel.push(netDiesel);
    cumGrid+=netGrid; cumDiesel+=netDiesel;
    if(paybackGrid===null && cumGrid>=0) paybackGrid = y-1 + (netGrid-cumGrid)/netGrid;
    if(paybackDiesel===null && cumDiesel>=0) paybackDiesel = y-1 + (netDiesel-cumDiesel)/netDiesel;
  }
  const litersYear1 = genArr[0]*f.dieselConsumptionPerKWh;
  const co2Year1 = litersYear1*f.co2FactorKgPerLiter/1000;
  return {
    genArr, gridArr, dieselArr,
    paybackGrid, paybackDiesel,
    irrGrid: irr(cfGrid), irrDiesel: irr(cfDiesel),
    profit30Grid: cfGrid.reduce((a,b)=>a+b,0),
    profit30Diesel: cfDiesel.reduce((a,b)=>a+b,0),
    litersYear1, co2Year1, cfGrid, cfDiesel
  };
}

