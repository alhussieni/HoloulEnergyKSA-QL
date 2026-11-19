// Cart guard: server-side unit-price check + "never below cost" discount floor.
const fs=require('fs'),vm=require('vm'),path=require('path');
const ts=(()=>{try{return require('typescript')}catch(e){return require('/home/claude/.npm-global/lib/node_modules/typescript')}})();
const src=fs.readFileSync(path.join(__dirname,'..','..','supabase','functions','compute-quote','index.ts'),'utf8');
const grab=(name)=>{const i=src.indexOf('function '+name+'(');if(i<0)throw new Error('missing '+name);return src.slice(i,src.indexOf('\n}\n',i)+3);};
const names=['rowBrand','findDiscount','resolveCatalogPricing','cartCatalogLine','cartLimits','guardCartSnapshot','cartFinancials'];
let code='function cartRound2(n){return Math.round(n*100)/100}\n'+names.map(grab).join('\n')+'\nthis.api={guardCartSnapshot,cartLimits,cartFinancials};';
const js=ts.transpileModule(code,{compilerOptions:{target:'es2022'}}).outputText;
const sb={console};vm.createContext(sb);vm.runInContext(js,sb);
const a=require('assert');
const mk=(promo=true)=>({productCatalog:[{category:'كابلات',rows:[['كابل 4mm','x','10','11.5']],productDetails:{0:{brand:'BR'}}}],
  discounts:[{category:'كابلات',brand:'BR',supplierDiscountPct:20,sellDiscountPct:5,promoActive:promo,promoDiscountPct:10}]});
const D=mk(), G=sb.api.guardCartSnapshot;
const snap=(o={})=>({items:[{name:'كابل 4mm',category:'كابلات',price:'9',qty:3}],specialDiscountAmt:0,...o});

// ok at server price; floor = (9-8)*3 = 3
let g=G(D,snap(),false); a.ok(g.ok); a.strictEqual(g.maxDiscount,3); a.strictEqual(g.itemsSell,27); a.strictEqual(g.itemsCost,24);
// stale / tampered unit price
g=G(D,snap({items:[{name:'كابل 4mm',category:'كابلات',price:'10',qty:3}]}),false); a.strictEqual(g.code,'prices-changed'); a.strictEqual(g.changed[0].serverPrice,9);
g=G(D,snap({items:[{name:'كابل 4mm',category:'كابلات',price:'1',qty:3}]}),true); a.strictEqual(g.code,'prices-changed');
// discount: locked / at floor / above floor / increase
a.strictEqual(G(D,snap({specialDiscountAmt:1}),false).code,'discount-locked');
a.strictEqual(G(D,snap({specialDiscountAmt:-500}),false).code,'discount-locked');
a.ok(G(D,snap({specialDiscountAmt:3}),true).ok);
g=G(D,snap({specialDiscountAmt:3.02}),true); a.strictEqual(g.code,'discount-below-cost'); a.strictEqual(g.maxDiscount,3);
a.strictEqual(G(D,snap({specialDiscountAmt:1000}),true).code,'discount-below-cost');
a.ok(G(D,snap({specialDiscountAmt:-500}),true).ok);
// unknown item / empty cart
// item outside the catalog: accepted, counted at zero margin (discount can't eat into it)
const mixed=[{name:'كابل 4mm',category:'كابلات',price:'9',qty:3},{name:'مجهول',category:'x',price:'5',qty:1}];
g=G(D,snap({items:mixed}),false); a.ok(g.ok); a.strictEqual(JSON.stringify(g.uncatalogued),JSON.stringify(['مجهول'])); a.strictEqual(g.itemsSell,32); a.strictEqual(g.itemsCost,29); a.strictEqual(g.maxDiscount,3);
a.ok(G(D,snap({items:mixed,specialDiscountAmt:3}),true).ok);
a.strictEqual(G(D,snap({items:mixed,specialDiscountAmt:3.5}),true).code,'discount-below-cost');
const only=[{name:'مجهول',category:'x',price:'500',qty:2}];
a.ok(G(D,snap({items:only}),false).ok);
g=G(D,snap({items:only,specialDiscountAmt:1}),true); a.strictEqual(g.code,'discount-below-cost'); a.strictEqual(g.maxDiscount,0);
a.ok(G(D,snap({items:only,specialDiscountAmt:-100}),true).ok);
a.ok(G(D,snap({items:[{name:'مجهول',category:'x',price:'abc',qty:1}]}),false).ok); // garbage price -> 0, no crash
a.strictEqual(G(D,snap({items:[]}),true).code,'empty-cart');
// no promo: stored price string used as-is; comma tolerated
const D2=mk(false); g=G(D2,snap({items:[{name:'كابل 4mm',category:'كابلات',price:'10.00',qty:1}]}),false); a.ok(g.ok); a.strictEqual(g.maxDiscount,2);
// qty is clamped like the DB trigger (>=1)
g=G(D,snap({items:[{name:'كابل 4mm',category:'كابلات',price:'9',qty:0}]}),false); a.ok(g.ok); a.strictEqual(g.itemsSell,9);
console.log('cart-guard tests passed');
