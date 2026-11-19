// Pricing engine floor: no discount (tier or manual) may push the net price below the cost of the active items.
const fs=require('fs'),vm=require('vm'),path=require('path');
const ts=(()=>{try{return require('typescript')}catch(e){return require('/home/claude/.npm-global/lib/node_modules/typescript')}})();
const src=fs.readFileSync(path.join(__dirname,'..','..','supabase','functions','compute-quote','index.ts'),'utf8');
const i=src.indexOf('function finalizeQuote(');const fn=src.slice(i,src.indexOf('\n}\n',i)+3);
const js=ts.transpileModule(fn+'\nthis.api={finalizeQuote};',{compilerOptions:{target:'es2022'}}).outputText;
const sb={};vm.createContext(sb);vm.runInContext(js,sb);
const a=require('assert'), F=sb.api.finalizeQuote, D={vat:0.15};
const mk=()=>[{key:'panel',on:true,sell:2000,costBasis:1900},{key:'inverter',on:true,sell:1000,costBasis:900},{key:'off',on:false,sell:500,costBasis:100}];
// tier discount = 0.8 x margin of non-panel items = 80; floor cost counts only ON items = 2800
let r=F(mk(),0.8,D,0); a.strictEqual(r.discountTotal,80); a.strictEqual(r.netAfterManual,2920); a.strictEqual(r.manualDiscountCapped,false);
// manual discount capped at (net - cost) = 120
r=F(mk(),0.8,D,500); a.strictEqual(r.manualDiscountAmt,120); a.strictEqual(r.manualDiscountCapped,true); a.strictEqual(r.netAfterManual,2800);
r=F(mk(),0.8,D,100); a.strictEqual(r.manualDiscountAmt,100); a.strictEqual(r.manualDiscountCapped,false);
// anonymous callers can ask for anything: still never below cost
for (const req of [1e9, 3000, 121, 120.01]) { r=F(mk(),0.8,D,req); a.ok(r.netAfterManual >= 2800 - 1e-6, 'req '+req); }
// absurd tier factor cannot go below cost either
r=F(mk(),50,D,0); a.ok(r.netAfterManual >= 2800 - 1e-6);
// price increase (negative discount) passes through
r=F(mk(),0.8,D,-300); a.strictEqual(r.manualDiscountAmt,-300); a.strictEqual(r.netAfterManual,3220);
// toggled-off items never count as cost
r=F([{key:'x',on:false,sell:0,costBasis:999999},{key:'y',on:true,sell:100,costBasis:60}],0,D,1000); a.strictEqual(r.netAfterManual,60);
console.log('engine-floor tests passed');
