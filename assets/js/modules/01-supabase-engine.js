const LOGO_SRC = "assets/logo.png";
/* =======================================================================
   1) SUPABASE — server-side pricing engine (no rates/costs live in this file)
   ======================================================================= */
const SUPABASE_URL = 'https://xhgwvszdatqlvlgqiikj.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_4qWmgl6fWMpoU6F_o__ykg_Z0Xy_aJY';
const EDGE_FN = SUPABASE_URL + '/functions/v1/compute-quote';

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

