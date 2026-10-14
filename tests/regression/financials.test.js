const fs=require('fs'),vm=require('vm'),ts=(()=>{try{return require('typescript')}catch(e){return require('/home/claude/.npm-global/lib/node_modules/typescript')}})();
const src=fs.readFileSync(require('path').join(__dirname,'..','..','supabase','functions','compute-quote','index.ts'),'utf8');
const grab=(name)=>{const i=src.indexOf('function '+name+'(');return src.slice(i,src.indexOf('\n}\n',i)+3);};
const names=['adminView','financialsFromQuote','rowBrand','findDiscount','resolveCatalogPricing','cartFinancials','computeFinancialsFromSnapshot'];
let code=names.map(grab).join('\n');
code+=`
function resolveInput(D,r){return {...r}}; function resolveOffgridOngridInput(D,r){return {...r}};
function computeQuote(D,i){return fakeQ(i.hp)}; function computeOffgridQuote(D,i){return fakeQ(5)}; function computeOngridQuote(D,i){return fakeQ(7)};
function fakeQ(k){const items=[{key:'panel',label:'لوح',on:true,sell:1000*k,costBasis:800*k,discount:0,net:1000*k,qty:'#4#'},{key:'inverter',label:'انفرتر',on:true,sell:500,costBasis:400,discount:20,net:480,qty:'1'},{key:'x',label:'مطفي',on:false,sell:0,costBasis:0,discount:0,net:0}];return {items,sellTotal:1000*k+500,discountTotal:20,manualDiscountAmt:100,netAfterManual:1000*k+380,vat:(1000*k+380)*.15,finalTotal:(1000*k+380)*1.15}}
this.api={computeFinancialsFromSnapshot,cartFinancials};`;
const js=ts.transpileModule(code,{compilerOptions:{target:'es2022'}}).outputText;
const sb={console};vm.createContext(sb);vm.runInContext(js,sb);
const a=require('assert');
const D={productCatalog:[{category:'كابلات',rows:[['كابل 4mm','x','10','11.5']],productDetails:{0:{brand:'BR'}}}],discounts:[{category:'كابلات',brand:'BR',supplierDiscountPct:20,sellDiscountPct:5,promoActive:true,promoDiscountPct:10}]};
let f=sb.api.computeFinancialsFromSnapshot(D,{hp:10,panelIdx:0});
a.strictEqual(f.kind,'pump');a.strictEqual(f.items.length,2);a.strictEqual(f.totalCost,800*10+400);a.ok(Math.abs(f.profit-(f.netAfterManual-f.totalCost))<1e-9);a.strictEqual(f.items[1].margin,80);
f=sb.api.computeFinancialsFromSnapshot(D,{type:'offgrid',engineInput:{}});a.strictEqual(f.kind,'offgrid');
a.strictEqual(sb.api.computeFinancialsFromSnapshot(D,{type:'offgrid'}),null);
try{sb.api.cartFinancials(D,{items:[{name:'كابل 4mm',category:'كابلات',price:10,qty:3}]})}catch(e){console.log('ERR',e.message)}
f=sb.api.computeFinancialsFromSnapshot(D,{type:'product-cart',items:[{name:'كابل 4mm',category:'كابلات',price:10,qty:3},{name:'مجهول',category:'x',price:5,qty:1}],extras:[{amount:100}],subtotal:135,vat:20.25,total:155.25});
a.strictEqual(f.items[0].costBasis,8*3);a.strictEqual(f.items[0].curUnitSell,9);a.strictEqual(f.items[1].costBasis,null);a.strictEqual(f.unknownCostItems,1);a.strictEqual(f.totalCost,24);a.strictEqual(f.profit,35-24);
console.log('financials tests passed');
