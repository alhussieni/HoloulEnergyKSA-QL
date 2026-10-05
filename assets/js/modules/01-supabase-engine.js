let LOGO_SRC = "assets/logo.png"; // بيتحدّث من هوية المؤسسة (لوجو الأدمن) تلقائيًا
/* =======================================================================
   1) SUPABASE — server-side pricing engine (no rates/costs live in this file)
   ======================================================================= */
const SUPABASE_URL = 'https://xhgwvszdatqlvlgqiikj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_4qWmgl6fWMpoU6F_o__ykg_Z0Xy_aJY';
const EDGE_FN = SUPABASE_URL + '/functions/v1/compute-quote';

/* ---- هوية المؤسسة (white-label) ----
   المصدر الوحيد: جدول company_profile على السيرفر (الأدمن بيعدّله من لوحة التحكم ← بيانات المؤسسة).
   القيم الافتراضية هنا مجرد نسخة احتياطية لحد ما الرد من السيرفر يوصل (وبتتخزّن محليًا للفتح السريع). */
const INVOICE_API_URL = SUPABASE_URL + '/functions/v1/invoice-api';
const COMPANY_CACHE_KEY = 'holoul_company_v1';
const COMPANY_DEFAULT = {
  name: 'مؤسسة حلول الطاقة المتجددة والمقاولات', shortName: 'حلول الطاقة المتجددة والمقاولات', nameEn: 'HoloulEnergy',
  phone: '966561274344+', whatsapp: '966561274344', email: 'info@HoloulEnergy.com', website: '', logoUrl: '',
  vatNumber: '311386341200003', crNumber: '7037810988', commercialReg: '1010970687', nationalAddress: 'RDMC8001',
  address: { buildingNo:'8001', street:'أحمد الكازروني', district:'حي المهدية', city:'الرياض', postalCode:'13752', additionalNo:'2343', country:'المملكة العربية السعودية' }
};
let COMPANY = Object.assign({}, COMPANY_DEFAULT);
try{
  const _c = JSON.parse(localStorage.getItem(COMPANY_CACHE_KEY) || 'null');
  if(_c && _c.name) COMPANY = Object.assign({}, COMPANY_DEFAULT, _c);
}catch(e){}
LOGO_SRC = COMPANY.logoUrl || 'assets/logo.png';
function companyShort(){ return COMPANY.shortName || COMPANY.name || ''; }
function companyBrand(){ return COMPANY.nameEn || COMPANY.shortName || COMPANY.name || ''; }
function companyWaNumber(){ return String(COMPANY.whatsapp || '').replace(/\D/g,'') || '966561274344'; }
/* سطور التواصل في أسفل عرض السعر */
function companyContactHtml(){
  const lines = [];
  if(COMPANY.email) lines.push(esc(COMPANY.email));
  if(COMPANY.website) lines.push(esc(COMPANY.website));
  if(COMPANY.phone) lines.push('<span class="num">' + esc(COMPANY.phone) + '</span>');
  return lines.join('<br>');
}
/* الترويسة الثابتة في index.html (اللوجو/الاسم/زر الاتصال والواتساب/عنوان الصفحة) */
function applyCompanyChrome(){
  const go = ()=>{
    try{
      const q = (sel)=>document.querySelector(sel);
      const img = q('header.top .brand .mark img'); if(img){ img.src = LOGO_SRC; img.alt = companyBrand(); }
      const nm = q('header.top .brand .name'); if(nm) nm.textContent = companyShort();
      const sub = q('header.top .brand .sub'); if(sub) sub.textContent = companyBrand() + ' — حاسبة عروض أسعار محطات الطاقة الشمسية';
      const tel = q('header.top a[href^="tel:"]'); if(tel && COMPANY.phone) tel.href = 'tel:+' + String(COMPANY.phone).replace(/\D/g,'');
      const wa = q('header.top a[href*="wa.me"]'); if(wa) wa.href = 'https://wa.me/' + companyWaNumber();
      document.title = 'حاسبة عروض أسعار محطات الطاقة الشمسية | ' + companyShort() + ' - ' + companyBrand();
      const fab = q('a.fab-wa'); if(fab) fab.href = 'https://wa.me/' + companyWaNumber();
      const foot = q('footer.foot');
      if(foot) foot.textContent = [COMPANY.crNumber ? 'الرقم الوطني الموحد: ' + COMPANY.crNumber : '', COMPANY.commercialReg ? 'السجل التجاري: ' + COMPANY.commercialReg : '',
        COMPANY.vatNumber ? 'الرقم الضريبي: ' + COMPANY.vatNumber : '', COMPANY.phone ? 'للتواصل: ' + COMPANY.phone : ''].filter(Boolean).join(' · ');
    }catch(e){}
  };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
}
function setCompany(c){
  COMPANY = Object.assign({}, COMPANY_DEFAULT, c || {});
  LOGO_SRC = COMPANY.logoUrl || 'assets/logo.png';
  try{ localStorage.setItem(COMPANY_CACHE_KEY, JSON.stringify(COMPANY)); }catch(e){}
  applyCompanyChrome();
}
async function loadCompanyPublic(){
  try{
    const res = await fetch(INVOICE_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY, 'apikey': SUPABASE_ANON_KEY },
      body: JSON.stringify({ action: 'company-public' })
    });
    const d = await res.json();
    if(d && d.ok && d.company && d.company.name){
      const before = JSON.stringify(COMPANY);
      setCompany(d.company);
      if(JSON.stringify(COMPANY) !== before && typeof render === 'function'){ try{ render(); }catch(e){} }
    }
  }catch(e){ /* نكمّل بالنسخة المخزّنة/الاحتياطية */ }
}
applyCompanyChrome();
loadCompanyPublic();

async function callEngine(action, payload){
  const res = await fetch(EDGE_FN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      'apikey': SUPABASE_ANON_KEY
    },
    body: JSON.stringify({ action, ...payload })
  });
  let data;
  try{ data = await res.json(); }catch(e){ throw new Error('استجابة غير صالحة من الخادم'); }
  if(!res.ok) throw new Error(data.error || 'خطأ في الخادم');
  return data;
}

