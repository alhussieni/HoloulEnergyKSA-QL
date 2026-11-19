// Cart "معلومات إضافية" card: figures reconcile (cost + profit + VAT = total) and unknown/extras are zero-margin.
const fs=require('fs'),vm=require('vm'),path=require('path'),a=require('assert');
const read=f=>fs.readFileSync(path.join(__dirname,'..','..','assets','js','modules',f),'utf8');
const grab=(src,name)=>{const i=src.indexOf('function '+name+'(');if(i<0)throw new Error('missing '+name);let j=src.indexOf('\n}\n',i);return src.slice(i,j+3);};
const s05=read('05-render-calculator.js'), s07=read('07-render-admin.js');
const code=['buildFinancialsDonut'].map(n=>grab(s05,n)).join('\n')+'\n'+grab(s07,'renderCartAdminFinancials')+'\nthis.api={renderCartAdminFinancials};';
const sb={fmt:n=>String(Math.round(n*100)/100),esc:s=>String(s),CART_VAT_RATE:0.15};vm.createContext(sb);vm.runInContext(code,sb);
const R=sb.api.renderCartAdminFinancials;
const val=(html,label)=>{const m=new RegExp(label+'</span><span class="v">([\\-0-9.]+) ﷼').exec(html);a.ok(m,'missing '+label);return +m[1];};

// 2 known items (cost 782 vs sell 821.10 each) + 1 unknown (500) + extras 300; discount 20 → net = 1642.2+500+300-20 = 2422.2
const net=2422.2, vat=net*0.15, fin={items:[
 {label:'A',qty:2,unitSell:821.1,curUnitSell:821.1,costBasis:1564,sell:1642.2},
 {label:'X',qty:1,unitSell:500,curUnitSell:null,costBasis:null,sell:500}],
 totalCost:1564,sellTotal:2142.2,extrasTotal:300,manualDiscountAmt:20,netAfterManual:net,vat,finalTotal:net+vat,unknownCostItems:1};
let h=R({fin,limits:{maxDiscount:78.2}});
const sell=val(h,'إجمالي سعر البيع'), cost=val(h,'إجمالي التكلفة الفعلية'), profit=val(h,'صافي الربح المتوقع');
a.strictEqual(sell,2422.2);
a.strictEqual(cost,1564+500+300);          // unknown item and extras are counted at zero margin
a.ok(Math.abs(cost+profit-sell)<0.02);      // reconciles exactly
a.strictEqual(profit,58.2);                 // = items net 2122.2 - items cost 1564 - 500 (unknown) ... only A's margin survives (1642.2-20-1564)
a.ok(h.includes('بدون تكلفة معروفة') && h.includes('collapseAdminInfo') && h.includes('lockAdminInfo'));
a.ok(h.includes('أقصى خصم مسموح'));
// price drift vs catalog is flagged
h=R({fin:{...fin,items:[{...fin.items[0],curUnitSell:830}]},limits:{maxDiscount:0}}); a.ok(h.includes('مختلف عن سعر الكتالوج'));
// error state still offers lock/collapse and never throws
h=R({__error:true}); a.ok(h.includes('تعذّر تحميل') && h.includes('lockAdminInfo'));
h=R(null); a.ok(h.includes('تعذّر تحميل'));
// negative profit never breaks the donut
h=R({fin:{...fin,netAfterManual:100,vat:15,finalTotal:115},limits:{maxDiscount:0}}); a.ok(h.includes('fin-groups'));
console.log('cart-admin-info tests passed');
