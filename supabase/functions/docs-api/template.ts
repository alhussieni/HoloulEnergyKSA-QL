// template.ts — قالب عقد توريد وتركيب وتشغيل نظام طاقة شمسية (الإصدار contract-v1)
// يُصيِّر HTML للطباعة (RTL) من لقطة مجمّدة (Snap). لا يقرأ قاعدة البيانات ولا يتصل بالشبكة.
//
// مهم: هذا الملف يحوي نص العقد وشروطه. لا تضعه في مستودع GitHub العام؛ مكانه الوحيد
// مجلد الدالة المنشورة في Supabase.

export const TEMPLATE_KEY = "contract";
export const TEMPLATE_VERSION = "contract-v1";

export interface Terms {
  graceDays: number; terminateDays: number; handoverNoticeDays: number; punchDays: number;
  objectionDays: number; claimDays: number; contactYears: number; defectNoticeDays: number;
  substitutionNoticeDays: number; fmNoticeDays: number; cancelPct: number; cureDays: number;
  refundDays: number; amicableDays: number;
}
export const DEFAULT_TERMS: Terms = {
  graceDays: 6, terminateDays: 15, handoverNoticeDays: 3, punchDays: 10, objectionDays: 5,
  claimDays: 5, contactYears: 5, defectNoticeDays: 7, substitutionNoticeDays: 3, fmNoticeDays: 5,
  cancelPct: 10, cureDays: 15, refundDays: 30, amicableDays: 30,
};

export type Opt3 = "included" | "optional" | "waived";

export interface Snap {
  docNo: string;
  templateVersion: string;
  issuedAt: string;                  // ISO
  place: string;
  company: { name: string; cr: string; unified: string; vat: string; address: string; phone: string; email: string;
             repName: string; repTitle: string; repAuthority: string; formerName?: string };
  customer: { name: string; isCompany: boolean; idType?: string; idNumber?: string; crNo?: string; vatNo?: string;
              unifiedNo?: string; address: string; phone: string; email: string;
              repName?: string; repTitle?: string; repAuthority?: string };
  site: { lat?: number | null; lng?: number | null; mapsLink?: string; address?: string };
  quote: { refCode: string; hp?: number | string | null; calcKW: number; invKW: number | null; totalPanels: number;
           panelLabel: string; panelWatt: number | null; invBrand: string; structureType: string;
           toggles: Record<string, boolean>; items: Array<{ label: string; qty: string }> };
  commercial: { exVat: number; vat: number; total: number; vatPct: number };
  payments: Array<{ title: string; pct: number; trigger: string; amount: number }>;
  bank: { holder: string; bank: string; iban: string };
  inputs: {
    earthingStatus: Opt3; earthingPrice?: number; reactorStatus: Opt3; reactorPrice?: number;
    earthingDeadline: string;
    guard: "company" | "client" | "paid"; guardPrice?: number;
    photoConsent: boolean;
    disputeType: "court" | "arbitration"; courtName?: string; courtCity?: string;
    arbitrationCenter?: string; arbitrationSeat?: string;
    cableLengthText?: string; cablePricePerM?: number; concreteDims?: string;
    warranty: { panels: string; structure: string; inverter: string; cables: string; combiner: string };
  };
  terms: Terms;
}

const E = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n: number): string =>
  Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function dates(iso: string) {
  const d = new Date(iso);
  const g = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Riyadh" }).format(d);
  let h = "";
  try {
    h = new Intl.DateTimeFormat("ar-SA-u-ca-islamic-umalqura-nu-latn", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "Asia/Riyadh" })
      .format(d).replace(/\s*هـ\s*$/, "");
  } catch { h = ""; }
  const wd = new Intl.DateTimeFormat("ar-SA", { weekday: "long", timeZone: "Asia/Riyadh" }).format(d);
  return { g, h, wd };
}

const ID_LABEL: Record<string, string> = { national_id: "الهوية الوطنية", iqama: "الإقامة", gcc_id: "الهوية الخليجية", passport: "جواز السفر" };

type Ctx = { i: Snap["inputs"]; t: Terms; guard: string; photo: string; dispute: string };

const ARTICLES: Array<[string, (c: Ctx) => string]> = [
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `تمهيد`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `حيث إن الطرف الأول يعمل في توريد وتركيب وتشغيل أنظمة الطاقة الشمسية، وحيث رغب الطرف الثاني في تنفيذ نظام طاقة شمسية وفق المواصفات الواردة في الملحق (أ)، فقد اتفق الطرفان، وهما بكامل أهليتهما النظامية، على ما يلي:`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (1): التمهيد والملاحق وأولوية المستندات`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `1-1  يُعد التمهيد والملحقان (أ) و(ب) جزءاً لا يتجزأ من هذا العقد ومكملاً لبنوده.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `1-2  عند التعارض بين المستندات يُقدَّم متن العقد، ثم الملحق (ب)، ثم الملحق (أ).`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `1-3  المرجع الوحيد للأسعار والدفعات هو الملحق (ب)، والمرجع الوحيد للمواصفات والمكونات والاستثناءات الفنية هو الملحق (أ).`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (2): التعريفات`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `<b>الأعمال:</b> كل ما يلتزم به الطرف الأول بموجب هذا العقد والملحق (أ).`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `<b>الموقع:</b> المكان المحدد بالإحداثيات في صدر العقد.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `<b>يوم العمل:</b> أيام العمل الرسمية من الأحد إلى الخميس، عدا الإجازات الرسمية.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `<b>محضر استلام الموقع:</b> المحضر الذي يوقعه الطرفان لإثبات جاهزية الموقع وفق المادة (8).`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `<b>محضر التشغيل والتسليم:</b> المحضر الذي يوقعه الطرفان بعد اختبارات التشغيل وفق المادة (10).`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `<b>قيمة العقد:</b> إجمالي القيمة دون ضريبة القيمة المضافة الواردة في الملحق (ب) وقت التعاقد، مضافاً إليها قيمة الأوامر التغييرية الموقعة.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `<b>الأضرار غير المباشرة:</b> فوات الأرباح والكسب، وخسارة المحاصيل أو الإنتاج، وانقطاع المياه أو الطاقة، وتوقف النشاط، وأي ضرر لاحق لا ينتج مباشرة عن الإخلال.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (3): نطاق الأعمال`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `3-1  يلتزم الطرف الأول بتوريد ونقل وتركيب واختبار وتشغيل وتسليم نظام الطاقة الشمسية وفق الملحق (أ)، ويشمل ذلك الأعمال الخرسانية اللازمة لقواعد التثبيت: توريد الخرسانة والمعدات والهياكل (القوالب) التي تُصب داخلها.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `3-2  يستثنى من الأعمال كل ما نص الملحق (أ) على استثنائه، وكل ما لم يُذكر فيه صراحة.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `3-3  يحسم الطرف الثاني كتابياً قبل ${E(i.earthingDeadline)} اختياره بشأن التأريض (البئر الأرضي) والـ REACTOR وفق الملحق (أ)، وما يُطلب بعد ذلك يُعامل كأمر تغييري وفق المادة (13). وإذا اختار عدم تنفيذ أيٍّ منهما فيكون ذلك بإقرار كتابي مستقل يوقعه، ويتحمل ما قد ينتج عن عدم تنفيذه من أضرار، ولا تشملها الضمانات.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (4): قيمة العقد`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `4-1  تحدد قيمة العقد وفق الملحق (ب)، وتُضاف إليها ضريبة القيمة المضافة بالنسبة النظامية السارية وقت إصدار الفاتورة.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `4-2  الكميات المقدّرة في الملحق (أ)، ومنها أطوال الكابلات، مبنية على المعاينة الموقعة، وما زاد عنها يُسعَّر بسعر الوحدة المذكور في الملحق (أ).`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (5): السداد والتأخر فيه`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `5-1  يسدد الطرف الثاني الدفعات في مواعيدها وفق الملحق (ب) بالتحويل البنكي إلى الحساب المسمى باسم الطرف الأول في الملحق (ب) حصراً. ولا يُعتد بأي سداد إلى حساب آخر أو نقداً لأي شخص ما لم يصدر به سند استلام موقّع من الطرف الأول.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `5-2  يصدر الطرف الأول فاتورة ضريبية عن كل دفعة وفق الأنظمة.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `5-3  إذا تأخر الطرف الثاني عن سداد أي دفعة ولم يسددها خلال ${t.graceDays} أيام عمل من تاريخ الاستحقاق بعد إخطاره كتابياً، حق للطرف الأول:`; }],
  ["S", (c) => { const { i, t, guard, photo, dispute } = c; return `(أ) إيقاف الأعمال؛`; }],
  ["S", (c) => { const { i, t, guard, photo, dispute } = c; return `(ب) إعادة تسعير البنود غير المورّدة بأسعار موثقة إذا لزم الأمر؛`; }],
  ["S", (c) => { const { i, t, guard, photo, dispute } = c; return `(ج) تمديد مدة التنفيذ بمقدار مدة التوقف وما يلزم لإعادة تعبئة العمالة والمعدات.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `ويبقى الطرف الثاني ملزماً بالسداد.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `5-4  إذا استمر التأخر ${t.terminateDays} يوم عمل من تاريخ الإخطار الكتابي، حق للطرف الأول فسخ العقد وفق المادة (16).`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `5-5  لا تُحتسب فوائد على التأخر في السداد، ولا يخل ذلك بحق الطرف الأول في المستحقات المنصوص عليها في المادة (16).`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (6): مدة التنفيذ`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `6-1  مدة التنفيذ (70) يوم عمل، تبدأ من <b>آخر</b> تاريخ يتحقق فيه الشرطان معاً: (أ) استلام الطرف الأول الدفعة المقدمة، (ب) توقيع محضر استلام الموقع جاهزاً.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `6-2  يخطر الطرف الثاني الطرف الأول بجاهزية الموقع قبل بدء الأعمال بمدة لا تقل عن (10) أيام عمل، وتسبق هذه المدة بدء احتساب مدة التنفيذ ولا تدخل فيها.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `6-3  تُمدَّد مدة التنفيذ بمقدار ما يتأخر بسبب: تأخر السداد، أو عدم جاهزية الموقع أو تعذر الوصول إليه، أو ظروف التربة والتضاريس المخالفة للمعاينة، أو التغييرات والأعمال الإضافية، أو تأخر الطرف الثاني في اختياراته أو موافقاته أو التصاريح الواقعة عليه، أو القوة القاهرة.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `6-4  علاج التأخر عن المدة بعد تمديدها محصور في التمديد، ولا تُستحق غرامة تأخير. فإذا تجاوز التأخر (60) يوماً بعد انتهاء المدة لأسباب راجعة للطرف الأول، حق للطرف الثاني فسخ العقد وفق المادة (16). ولا يسري هذا الحصر على الغش والخطأ الجسيم.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (7): التزامات الطرف الأول`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `7-1  تنفيذ الأعمال وفق الأصول الفنية والاشتراطات النظامية المعمول بها.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `7-2  توريد مكونات مطابقة للملحق (أ) أو بديلة وفق المادة (14).`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `7-3  إجراء اختبارات التشغيل والتسليم.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `7-4  أن تكون العمالة المنفذة نظامية ومرخصة، وتحمّل مسؤوليتها، والتزام قواعد السلامة في الموقع.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `7-5  تسليم الطرف الثاني عند التشغيل: دليل التشغيل، وشهادات الضمان، وقائمة الأرقام التسلسلية للألواح والإنفرتر.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (8): التزامات الطرف الثاني وتسليم الموقع`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `8-1  الموقع مسؤولية الطرف الثاني، ويلتزم بتسليمه جاهزاً وخالياً مما يمنع إنجاز الأعمال، ويشمل ذلك التسوية والتمهيد وإزالة الصخور والتلال والعوائق، وتمهيد طرق وصول الشاحنات والمعدات.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `8-2  يقر الطرف الثاني بأنه مالك الموقع أو صاحب حق الانتفاع به وإجراء الأعمال فيه، وبأنه حصل على التصاريح والموافقات اللازمة من الجهات ومن المالك أو المؤجر، وبأنه أبلغ الطرف الأول بأي مرافق أو أنابيب أو كابلات مدفونة في الموقع.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `8-3  يُثبت استلام الموقع بمحضر يوقعه الطرفان يتضمن قائمة فحص (الوصول، التسوية، العوائق)، وصوراً وإحداثيات وتاريخاً وساعة. وإذا امتنع الطرف الثاني عن التوقيع دون سبب مقبول كفى إخطاره كتابياً مع صور موثقة وشاهد.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `8-4  أي ظرف في التربة أو التضاريس يخالف ما ثبتت معاينته (صخور، منسوب مياه، ميول ونحوها) يُعد أمراً تغييرياً بسعر ومدة إضافيين وفق المادة (13).`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `8-5  يلتزم الطرف الثاني بمواعيد السداد، وبتزويد الطرف الأول ببيانات اتصال صحيحة وتحديثها.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (9): الحراسة والمخاطر والملكية`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `9-1  حراسة المواد والمعدات داخل الموقع حتى محضر التشغيل والتسليم: ${guard}.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `9-2  يتحمل من تقع عليه الحراسة وفق البند (9-1) مخاطر الفقد والتلف حتى التسليم، وبعده يتحملها الطرف الثاني في كل الأحوال.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `9-3  تبقى ملكية المنظومة ومكوناتها للطرف الأول إلى حين سداد كامل قيمة العقد، ولا يجوز للطرف الثاني رهنها أو بيعها أو نقلها أو التصرف فيها خلال ذلك، وللطرف الأول حق معاينتها. ولا يجوز سحب أي مكونات إلا بموافقة كتابية من الطرف الثاني أو بحكم أو أمر من الجهة المختصة. وتنتقل الملكية إلى الطرف الثاني بمجرد السداد الكامل.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (10): التشغيل والتسليم والقبول`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `10-1  يخطر الطرف الأول الطرف الثاني بموعد التشغيل والتسليم عبر الرسائل النصية أو واتساب أو البريد الإلكتروني على البيانات المدونة في صدر العقد، بإخطار أول قبل الموعد بـ ${t.handoverNoticeDays} أيام عمل على الأقل، ثم بتذكير يومي حتى الموعد.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `10-2  يحضر الطرف الثاني أو من ينوب عنه ويوقع محضر التشغيل والتسليم المتضمن نتائج الاختبارات وقائمة الأرقام التسلسلية وأي ملاحظات.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `10-3  يعالج الطرف الأول الملاحظات الواردة في المحضر خلال ${t.punchDays} أيام عمل.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `10-4  ينقضي حق الطرف الثاني في الاعتراض على العيوب الظاهرة بمرور ${t.objectionDays} أيام عمل من محضر التشغيل أو من بدء الاستخدام الفعلي أيهما أسبق، دون إخلال بالضمان عن العيوب غير الظاهرة.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `10-5  إذا لم يحضر الطرف الثاني أو من ينوب عنه في الموعد المحدد لمدة (5) أيام عمل دون عذر قاهر، تُعتبر الأعمال مسلَّمة حكماً وتنتقل المخاطر والحراسة إليه، ويتحمل (1000) ريال سعودي عن كل يوم تأخير خلال هذه الأيام الخمسة مقابل الحراسة، تقديراً اتفاقياً لتكلفتها، ثم تُسحب الحراسة. ولا يخل التسليم الحكمي بالضمان المنصوص عليه في المادة (11).`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (11): الضمان والصيانة`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `<b>11-1  ضمان الأعمال:</b> يضمن الطرف الأول أعمال التركيب والأعمال الخرسانية لمدة سنة واحدة من محضر التشغيل والتسليم. وعند ظهور عيب أو خطأ في التركيب يصلحه مجاناً ويراجع الجزء المتأثر وما يتصل به فنياً، ويوسّع المراجعة لتشمل كامل المنظومة إذا ثبت أن السبب منهجي. ولا تُحتسب زيارات إصلاح عيوب التركيب من الزيارات الواردة في البند (11-3).`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `<b>11-2  ضمان المصنّع:</b> المصنّع هو الضامن لعيوب الصناعة في المكونات وفق شروطه ومدده الواردة في الملحق (أ). ويتولى الطرف الأول التواصل مع المصنّع أو الموزع وتفعيل الضمان خلال ${t.claimDays} أيام عمل من إخطار الطرف الثاني له بالعيب، ويكون الإصلاح أو الاستبدال بمكوّن مماثل أو أعلى مواصفات، فإن تعذّر فبأقرب بديل معتمد دون زيادة في السعر. ولا يضمن الطرف الأول قبول المصنّع للمطالبة أو سرعة استجابته. ويلتزم الطرف الأول بالتواصل طوال مدة ضمان المصنّع بحد أقصى ${t.contactYears} سنة. وخلال سنة ضمان الأعمال يتحمل الطرف الأول تكلفة فك المكون المعيب وشحنه وإعادة تركيبه، وبعدها يكون ذلك بمقابل يُتفق عليه. ويحيل الطرف الأول إلى الطرف الثاني حقوقه في ضمان المصنّع، ويسجل الضمان باسمه حيث تسمح الشركة المصنّعة.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `<b>11-3  الزيارات والصيانة:</b> للطرف الثاني ثلاث زيارات مجانية خلال السنة الأولى من محضر التشغيل للصيانة والفحص، تشمل زيارتي الصيانة نصف السنوية (عند 6 أشهر و12 شهراً) وزيارة ثالثة عند الطلب، وتُحتسب كل زيارة عند تنفيذها أياً كان موعدها، ويُنهي استنفادها الالتزام بالصيانة الدورية المجانية. وأي زيارة إضافية تكون بمقابل يحدده الطرف الأول بحسب الوقت والمكان ويبلغه للطرف الثاني كتابياً عند طلب الزيارة، وتُنفّذ بعد موافقته الصريحة.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `<b>11-4  الاستثناءات:</b> لا يشمل الضمان ما يلي:`; }],
  ["S", (c) => { const { i, t, guard, photo, dispute } = c; return `(أ) الحوادث، وسوء الاستخدام أو الإهمال من الطرف الثاني أو عماله أو أي شخص يعمل في الموقع بإذنه؛`; }],
  ["S", (c) => { const { i, t, guard, photo, dispute } = c; return `(ب) فتح المكونات أو تفكيكها أو تعديلها أو إعادة برمجتها أو إجراء أي أعمال فنية عليها من جهة غير الطرف الأول دون موافقته الكتابية. ولا يُعد فحصاً مبطلاً للضمان القياس أو القراءة أو المعاينة غير المتلفة؛`; }],
  ["S", (c) => { const { i, t, guard, photo, dispute } = c; return `(ج) الكوارث الطبيعية والقوة القاهرة، والسرقة والتخريب؛`; }],
  ["S", (c) => { const { i, t, guard, photo, dispute } = c; return `(د) خلل الشبكة أو الجهد أو التيار من خارج المنظومة؛`; }],
  ["S", (c) => { const { i, t, guard, photo, dispute } = c; return `(هـ) الأضرار الناتجة عن عدم تنفيذ التأريض أو الـ REACTOR بناءً على اختيار الطرف الثاني؛`; }],
  ["S", (c) => { const { i, t, guard, photo, dispute } = c; return `(و) نقل المنظومة من موقعها، أو عدم الالتزام بدليل التشغيل والتنظيف والصيانة الدورية.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `ويسقط الضمان بالقدر الذي نتج فيه العطل عن السبب المستثنى فقط.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `11-5  يخطر الطرف الثاني الطرف الأول كتابياً بأي عيب خلال ${t.defectNoticeDays} أيام من اكتشافه، ويحتفظ بشهادات الضمان. ولا يؤدي الإصلاح أو الاستبدال إلى تمديد فترة الضمان الأصلية.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (12): حدود المسؤولية`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `12-1  تقتصر مسؤولية الطرف الأول على أعمال التركيب والأعمال الخرسانية والمكونات التي ركّبها، وفق المادة (11).`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `12-2  لا يُسأل الطرف الأول عن الأضرار غير المباشرة، ولا عن أي مكونات أو منشآت خارج المنظومة (كالمضخات والمحركات والآبار وشبكات الري والمباني)، إلا ما نتج عنه ضرر مباشر بسبب خطأ تركيبه، فيكون في حدود السقف الوارد في البند (12-3).`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `12-3  إجمالي مسؤولية الطرف الأول عن أي مطالبة أو مجموعها لا يتجاوز قيمة العقد.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `12-4  لا يسري السقف ولا الاستثناءات الواردة في هذه المادة على الغش والخطأ الجسيم والإصابات الجسدية والوفاة.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `12-5  لا يضمن الطرف الأول مقدار إنتاج الطاقة ولا الوفورات الفعلية في التكاليف؛ وما ورد في عروضه أو حاسباته من تقديرات استرشادي، ويتغير بالإشعاع الشمسي والحرارة وحمل التشغيل.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (13): الأعمال الإضافية والتغييرات`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `13-1  أي عمل خارج نطاق العقد أو تغيير فيه يُسعَّر ويُنفَّذ بعد موافقة كتابية من الطرفين، تحدد السعر وأثر التغيير على مدة التنفيذ.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `13-2  لا يلتزم الطرف الأول بتنفيذ أي عمل إضافي قبل الموافقة الكتابية وسداد قيمته أو الدفعة المتفق عليها منه.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (14): استبدال المكونات`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `14-1  يحق للطرف الأول عند تعذر توريد المكونات المحددة (كالألواح) استبدالها بمكونات بديلة بشرط: (1) ألا تقل القدرة الإجمالية عن المتعاقد عليها ولا تزيد عليها بأكثر من 3%؛ (2) أن تكون من مصنّع بالفئة نفسها وبضمان لا يقل عن ضمان الأصلي؛ (3) أن تتوافق مع الإنفرتر ومع الهياكل، وأن يتحمل الطرف الأول تعديل الهياكل والكابلات اللازم؛ (4) أن يُخطر الطرف الثاني كتابياً مع المواصفات الفنية قبل التركيب بـ ${t.substitutionNoticeDays} أيام عمل؛ (5) دون أي زيادة في السعر.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `14-2  إذا لم تتحقق هذه الشروط فللطرف الثاني رفض البديل.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (15): القوة القاهرة`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `15-1  القوة القاهرة حدث خارج عن إرادة الطرفين لا يمكن توقعه أو دفعه، كالزلازل والأعاصير والفيضانات والحرائق الكبرى والحروب والأعمال العدائية والقرارات السيادية والأوبئة.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `15-2  لا يُعد قوة قاهرة: ارتفاع الأسعار، أو تأخر الموردين أو الشحن أو التخليص الجمركي ما لم ينتج مباشرة عن قرار حكومي، أو نقص التمويل.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `15-3  يخطر الطرف المتمسك بها الطرف الآخر كتابياً خلال ${t.fmNoticeDays} أيام من علمه بها، ويبذل ما في وسعه للتخفيف من أثرها.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `15-4  تُمدَّد مدة التنفيذ بمقدار أثرها، ولا تعفي من سداد المستحقات عن أعمال أُنجزت أو مواد وُرِّدت أو طُلبت.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `15-5  إذا استمرت القوة القاهرة (60) يوماً متصلة حق لأي من الطرفين فسخ العقد وفق البند (16-4).`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (16): الإلغاء والفسخ`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `<b>16-1  إلغاء الطرف الثاني للعقد بإرادته دون إخلال من الطرف الأول:</b>`; }],
  ["S", (c) => { const { i, t, guard, photo, dispute } = c; return `(أ) قبل طلب المواد: ${t.cancelPct}% من قيمة العقد؛`; }],
  ["S", (c) => { const { i, t, guard, photo, dispute } = c; return `(ب) بعد طلب المواد وقبل بدء التنفيذ في الموقع: تكلفة المواد المطلوبة التي لا يمكن إرجاعها ورسوم الإرجاع الفعلية، وبما لا يقل عن النسبة المذكورة في (أ)؛`; }],
  ["S", (c) => { const { i, t, guard, photo, dispute } = c; return `(ج) بعد بدء التنفيذ: قيمة الأعمال المنفذة والمواد الموردة والمطلوبة والتكاليف الموثقة، وبما لا يقل عن النسبة المذكورة في (أ).`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `<b>16-2  فسخ الطرف الأول:</b> عند عدم السداد وفق البند (5-4) أو عند إخلال الطرف الثاني بأي التزام جوهري واستمراره ${t.cureDays} يوم عمل بعد إخطاره كتابياً، يستحق الطرف الأول قيمة ما نُفذ وما وُرّد وما طُلب من مواد، وما تكبده من خسائر مباشرة موثقة، بما لا يجاوز قيمة العقد.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `<b>16-3  فسخ الطرف الثاني:</b> وفق البند (6-4)، أو عند إخلال الطرف الأول بأي التزام جوهري واستمراره ${t.cureDays} يوم عمل بعد إخطاره كتابياً، يسترد الطرف الثاني ما دفعه مخصوماً منه قيمة الأعمال المنفذة والمواد الموردة والمطلوبة التي لا يمكن إرجاعها، وذلك خلال ${t.refundDays} يوماً من الفسخ.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `<b>16-4  فسخ القوة القاهرة:</b> تُسوَّى المستحقات على أساس ما نُفذ ووُرّد وطُلب من مواد.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `16-5  يقع الفسخ بإخطار كتابي بعد انقضاء المهل المذكورة، دون حاجة إلى حكم قضائي، ولا يخل بالحقوق المستحقة قبله.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (17): الإخطارات والمراسلات`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `17-1  تعتبر العناوين وأرقام الجوال والبريد الإلكتروني المدونة في صدر العقد محلاً للمراسلات الرسمية، وأي تغيير فيها يجب إخطار الطرف الآخر به كتابياً.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `17-2  يصح الإخطار بالرسائل النصية أو واتساب أو البريد الإلكتروني على تلك البيانات وينتج أثره، ويُعتبر مستلَماً بتأكيد التسليم أو بعد (48) ساعة من إرساله. ويحتفظ الطرف الأول بسجل الإخطارات.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (18): البيانات الشخصية والتصوير`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `18-1  تُستخدم بيانات الطرف الثاني (الهوية والموقع والاتصال) لتنفيذ العقد والضمان والالتزامات النظامية فقط، ولا تُفصح لغير المختصين إلا وفق الأنظمة أو لمقدمي الخدمة المرتبطين بالتنفيذ، وبما يتفق مع نظام حماية البيانات الشخصية.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `18-2  تصوير المشروع وعرضه في معرض أعمال الطرف الأول دون ذكر بيانات شخصية: ${photo}.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (19): التنازل والتعاقد من الباطن`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `لا يجوز للطرف الثاني التنازل عن العقد أو حقوقه فيه دون موافقة كتابية. وللطرف الأول التعاقد من الباطن على جزء من الأعمال، ويبقى مسؤولاً عنها تجاه الطرف الثاني.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (20): النظام الواجب التطبيق وتسوية المنازعات`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `20-1  يخضع هذا العقد وملحقاه لأنظمة المملكة العربية السعودية.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `20-2  يسعى الطرفان إلى حل أي نزاع ودياً خلال ${t.amicableDays} يوماً من إخطار أحدهما الآخر كتابياً بالنزاع.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `20-3 عند تعذر الحل الودي يُحال النزاع إلى: ${dispute}.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (21): أحكام عامة`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `21-1  يمثل هذا العقد وملحقاه الاتفاق الكامل بين الطرفين، ويحل محل أي عروض أو مراسلات سابقة، ولا يُعدَّل إلا بمحرر مكتوب موقع من الطرفين.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `21-2  بطلان أي بند لا يبطل بقية البنود.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `21-3  تسامح أي طرف في استعمال حق لا يُعد تنازلاً عنه.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `21-4  النص العربي هو المرجع عند أي اختلاف مع أي ترجمة.`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `21-5  يجوز توقيع هذا العقد وملحقيه إلكترونياً بوسيلة معتمدة، ويكون للتوقيع الإلكتروني الأثر النظامي نفسه.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `المادة (22): نسخ العقد`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `حُرر هذا العقد من نسختين بيد كل طرف نسخة للعمل بموجبها.`; }],
  ["Art", (c) => { const { i, t, guard, photo, dispute } = c; return `إقرار الطرف الثاني`; }],
  ["C", (c) => { const { i, t, guard, photo, dispute } = c; return `يقر الطرف الثاني بأنه اطلع على هذا العقد وملحقيه (المواصفات والضمان والاستثناءات وحدود المسؤولية) وفهمها ووافق عليها، وبأنه تسلّم نسخة منها.`; }],
];

function partiesHtml(s: Snap): string {
  const c = s.company, u = s.customer;
  const former = c.formerName ? ` (سابقاً: ${E(c.formerName)})` : "";
  const coords = s.site.lat != null && s.site.lng != null
    ? `${s.site.lat}, ${s.site.lng}` : (s.site.mapsLink || "");
  const p1 = `<p><b>أولاً: ${E(c.name)}</b>${former}، سجل تجاري رقم ${E(c.cr)}، الرقم الضريبي ${E(c.vat)}، الرقم الوطني الموحد ${E(c.unified)}، العنوان: ${E(c.address)}، جوال: ${E(c.phone)}، بريد إلكتروني: ${E(c.email)}، ويمثلها: ${E(c.repName)} بصفته ${E(c.repTitle)} بموجب ${E(c.repAuthority)}. ويُشار إليها فيما بعد بـ (الطرف الأول).</p>`;
  const idPart = u.isCompany
    ? `سجل تجاري رقم ${E(u.crNo)}${u.vatNo ? `، الرقم الضريبي ${E(u.vatNo)}` : ""}${u.unifiedNo ? `، الرقم الوطني الموحد ${E(u.unifiedNo)}` : ""}`
    : `${E(ID_LABEL[u.idType || ""] || "الهوية")} رقم ${E(u.idNumber)}`;
  const rep = u.isCompany && u.repName ? `، ويمثله: ${E(u.repName)} بصفته ${E(u.repTitle)} بموجب ${E(u.repAuthority)}` : "";
  const p2 = `<p><b>ثانياً:</b> ${u.isCompany ? "شركة / مؤسسة" : "السيد"}: ${E(u.name)}، ${idPart}، العنوان الوطني أو البريدي: ${E(u.address)}، إحداثيات موقع المشروع: ${E(coords)}${s.site.address ? `، (${E(s.site.address)})` : ""}، جوال: ${E(u.phone)}، بريد إلكتروني: ${E(u.email)}${rep}. ويُشار إليه فيما بعد بـ (الطرف الثاني).</p>`;
  return p1 + p2;
}

function contractBody(s: Snap): string {
  const d = dates(s.issuedAt);
  const i = s.inputs;
  const guard = i.guard === "company" ? "على الطرف الأول ضمن السعر"
    : i.guard === "client" ? "على الطرف الثاني"
    : `على الطرف الأول بمقابل إضافي قدره ${money(i.guardPrice || 0)} ريال سعودي`;
  const photo = i.photoConsent ? "يوافق الطرف الثاني" : "لا يوافق الطرف الثاني";
  const dispute = i.disputeType === "court"
    ? `المحكمة المختصة: ${E(i.courtName)} بمدينة ${E(i.courtCity)}`
    : `التحكيم لدى ${E(i.arbitrationCenter)} ومقره ${E(i.arbitrationSeat)} ولغته العربية`;
  const ctx: Ctx = { i, t: s.terms, guard: E(guard), photo, dispute };

  let html = `<h1>عقد توريد وتركيب وتشغيل نظام طاقة شمسية</h1>
<p class="center">عقد رقم: <b>${E(s.docNo)}</b> &nbsp;&nbsp; تاريخ التحرير: ${d.g} م الموافق ${E(d.h)} هـ &nbsp;&nbsp; مكان التحرير: ${E(s.place)}</p>
<p>إنه في يوم ${E(d.wd)} الموافق ${d.g} تم الاتفاق بين كل من:</p>`;
  html += partiesHtml(s);
  html += `<h2>تمهيد</h2>`;
  let first = true;
  for (const [k, f] of ARTICLES) {
    let text = f(ctx);
    // لا يُذكر نطاق الخرسانة في 3-1 إذا لم يكن مشمولاً في عرض السعر المعتمد.
    if (k === "C" && text.startsWith("3-1") && !s.quote.toggles?.concrete) {
      text = text.replace(/،\s*ويشمل ذلك الأعمال الخرسانية.*$/, ".");
    }
    if (k === "Art") {
      if (first && text.startsWith("تمهيد")) { first = false; continue; }  // تمهيد أُضيف أعلاه
      html += `<h2>${text}</h2>`;
    } else if (k === "S") html += `<p class="sub">${text}</p>`;
    else html += `<p>${text}</p>`;
  }
  html += signHtml();
  return html;
}

function signHtml(): string {
  const col = (t: string) => `<td class="sig"><b>${t}</b><br>الاسم: ..............................<br>الصفة: ..............................<br>التوقيع: ............................<br>الختم: ..............................<br>التاريخ: .............................</td>`;
  return `<table class="signt"><tr>${col("الطرف الأول")}${col("الطرف الثاني")}</tr></table>`;
}

const STATUS_LABEL = { yes: "مشمول", no: "غير مشمول" };

function appendixA(s: Snap): string {
  const q = s.quote, tg = q.toggles || {}, w = s.inputs.warranty, i = s.inputs;
  const item = (label: string) => q.items.find((x) => x.label.includes(label));
  const rows: Array<[string, string, string, string]> = [];   // [بند، حالة، مواصفات/كمية، ضمان]
  const inc = (b: boolean) => (b ? STATUS_LABEL.yes : STATUS_LABEL.no);

  const totalW = q.panelWatt ? q.totalPanels * q.panelWatt : Math.round(q.calcKW * 1000);
  rows.push(["الألواح الشمسية", inc(!!tg.panel),
    `${E(q.panelLabel)} أو ما يعادلها وفق المادة (14)<br>${q.totalPanels} لوح${q.panelWatt ? ` × ${q.panelWatt} واط` : ""} = ${totalW} واط (${q.calcKW} كيلوواط) ±3%`,
    E(w.panels)]);
  rows.push(["هياكل التثبيت", inc(!!tg.structure),
    tg.structure ? (q.structureType === "FIXED" ? "حديد مجلفن ثابت، تثبيت بالمسامير، أقصى تحمل لسرعة الرياح 120 كم/ساعة" : E(q.structureType)) : "—",
    tg.structure ? E(w.structure) : "—"]);
  rows.push(["الإنفرتر", inc(!!tg.inverter),
    tg.inverter ? `${E(q.invBrand)} ${q.invKW ?? ""} كيلوواط` : "—", tg.inverter ? E(w.inverter) : "—"]);
  const cab = item("الكابلات");
  rows.push(["الكابلات", inc(!!tg.cables),
    tg.cables ? `${E(i.cableLengthText || cab?.qty || "")}${i.cablePricePerM ? `<br>سعر المتر الزائد: ${money(i.cablePricePerM)} ريال` : ""}` : "—",
    tg.cables ? E(w.cables) : "—"]);
  rows.push(["Combiner Box", inc(!!tg.combiner), tg.combiner ? E(item("Combiner")?.label || "Combiner Box") : "—", tg.combiner ? E(w.combiner) : "—"]);
  rows.push(["وصلات MC4", inc(!!tg.mc4), tg.mc4 ? E(item("MC4")?.qty || "") : "—", tg.mc4 ? "سنة واحدة" : "—"]);
  rows.push(["لوحة حماية IP65", inc(!!tg.ip65), tg.ip65 ? "حسب المخطط المعتمد" : "—", tg.ip65 ? "سنة واحدة" : "—"]);
  const o3 = (st: Opt3, price?: number) =>
    st === "included" ? [STATUS_LABEL.yes, "ضمن النطاق"] :
    st === "optional" ? ["اختياري", `بسعر ${money(price || 0)} ريال، يُحسم وفق المادة (3-3)`] :
    [STATUS_LABEL.no, "بإقرار رفض كتابي مستقل وفق المادة (3-3)"];
  const e = o3(i.earthingStatus, i.earthingPrice), r = o3(i.reactorStatus, i.reactorPrice);
  rows.push(["التأريض (البئر الأرضي)", e[0], e[1], "ضمن ضمان الأعمال إن شُمل"]);
  rows.push(["REACTOR", r[0], r[1], "ضمان المصنّع إن شُمل"]);
  rows.push(["الأعمال الخرسانية", inc(!!tg.concrete),
    tg.concrete ? `حفر قواعد التثبيت بالأبعاد المعتمدة فقط، وتوريد الخرسانة والمعدات والقوالب. ${E(i.concreteDims || "")}` : "—",
    tg.concrete ? "ضمان الأعمال: سنة" : "—"]);
  rows.push(["الأعمال الكهربائية", inc(!!tg.elecworks), tg.elecworks ? "حسب النطاق المتفق عليه" : "—", tg.elecworks ? "ضمان الأعمال: سنة" : "—"]);
  rows.push(["الأعمال المدنية", inc(!!tg.civilworks), tg.civilworks ? "حسب النطاق المتفق عليه" : "—", tg.civilworks ? "ضمان الأعمال: سنة" : "—"]);
  rows.push(["التوريد والنقل والتركيب", inc(!!tg.supply), tg.supply ? "التوريد والنقل والتنزيل والتركيب والعمالة" : "—", "ضمان الأعمال: سنة"]);
  rows.push(["الصيانة", STATUS_LABEL.yes, "ثلاث زيارات مجانية في السنة الأولى وفق المادة (11-3)", "سنة من محضر التشغيل"]);

  const tr = rows.map((r, n) => `<tr><td>${n + 1}</td><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join("");
  const notIncluded = rows.filter((r) => r[1] === STATUS_LABEL.no).map((r) => r[0]);
  return `<h1>ملحق (أ): المواصفات الفنية والضمان</h1>
<p class="center">عقد رقم: <b>${E(s.docNo)}</b> &nbsp;&nbsp; عرض السعر المرجعي: ${E(q.refCode)}</p>
<h2>أولاً: المكونات والأعمال</h2>
<table class="grid"><thead><tr><th>#</th><th>البند</th><th>الحالة</th><th>المواصفات / الكمية</th><th>الضمان</th></tr></thead><tbody>${tr}</tbody></table>
<h2>ثانياً: غير مشمول في العقد</h2>
${notIncluded.length ? `<p>1- بنود غير مشمولة في عرض السعر المعتمد: ${notIncluded.map(E).join("، ")}.</p>` : ""}
<p>${notIncluded.length ? 2 : 1}- تسوية الأرض وتمهيدها وإزالة الصخور والتلال والعوائق، وتمهيد طرق وصول الشاحنات والمعدات، وأي حفر عام غير قواعد التثبيت.</p>
<p>${notIncluded.length ? 3 : 2}- توريد أو تركيب الغطاسات والمحركات والمضخات وما يتصل بها، وحفر الآبار وأعمال المياه.</p>
<p>${notIncluded.length ? 4 : 3}- التصاريح والموافقات من الجهات والمالك، وأي أعمال ربط بالشبكة الكهربائية.</p>
<p>${notIncluded.length ? 5 : 4}- أجور الحراسة بعد التسليم، وأثناء التنفيذ إلا إذا نُص على غير ذلك في المادة (9-1).</p>
<p>${notIncluded.length ? 6 : 5}- أي أعمال أو مكونات لم تُذكر صراحة في هذا الملحق؛ وتُعامل عند طلبها كأوامر تغييرية وفق المادة (13).</p>
<h2>ثالثاً: ملاحظات</h2>
<p>1- لا تُدرج الأسعار في هذا الملحق. المرجع الوحيد للأسعار والدفعات هو الملحق (ب).</p>
<p>2- ظروف التربة والتضاريس المخالفة للمعاينة تُعامل كأمر تغييري وفق المادة (8-4).</p>
<p>3- ضمان المصنّع للمكونات تتولى الشركة تفعيله وفق المادة (11-2)، ولا تضمن قبول المصنّع للمطالبة.</p>
${signHtml()}`;
}

function appendixB(s: Snap): string {
  const c = s.commercial;
  const pay = s.payments.map((p) => `<tr><td>${E(p.title)}</td><td>${p.pct}%</td><td>${E(p.trigger)}</td><td>${money(p.amount)}</td></tr>`).join("");
  return `<h1>ملحق (ب): القيمة والدفعات</h1>
<p class="center">عقد رقم: <b>${E(s.docNo)}</b></p>
<h2>أولاً: القيمة</h2>
<table class="grid kv"><tr><th>حجم النظام</th><td>${s.quote.calcKW} كيلوواط</td></tr>
<tr><th>الإجمالي دون ضريبة القيمة المضافة</th><td>${money(c.exVat)} ريال سعودي</td></tr>
<tr><th>ضريبة القيمة المضافة (${c.vatPct}%)</th><td>${money(c.vat)} ريال سعودي</td></tr>
<tr><th>الإجمالي شاملاً الضريبة</th><td><b>${money(c.total)} ريال سعودي</b></td></tr></table>
<p>يشمل هذا الاتفاق ما هو مشمول في الملحق (أ)، ولا يشمل البنود الواردة في الفقرة (ثانياً) من الملحق (أ).</p>
<h2>ثانياً: جدول الدفعات</h2>
<table class="grid"><thead><tr><th>الدفعة</th><th>النسبة</th><th>الاستحقاق</th><th>القيمة شاملة الضريبة (ريال)</th></tr></thead><tbody>${pay}</tbody></table>
<p>1- تسري على التأخر في السداد أحكام المادة (5)، وعلى مدة التنفيذ أحكام المادة (6) من العقد.</p>
<p>2- يتم السداد بالتحويل البنكي حصراً إلى الحساب التالي، ولا يُعتد بأي سداد لحساب آخر أو نقداً ما لم يصدر به سند استلام موقّع من الطرف الأول:</p>
<table class="grid kv"><tr><th>اسم صاحب الحساب</th><td>${E(s.bank.holder)}</td></tr>
<tr><th>البنك</th><td>${E(s.bank.bank)}</td></tr>
<tr><th>رقم الآيبان (IBAN)</th><td dir="ltr" style="text-align:right">${E(s.bank.iban)}</td></tr></table>
${signHtml()}`;
}

const CSS = `
@page{size:A4;margin:16mm 14mm 16mm}
@page{@bottom-center{content:counter(page) " / " counter(pages);font:9pt Arial}}
*{box-sizing:border-box}
body{font-family:"Noto Naskh Arabic","Segoe UI",Tahoma,Arial,sans-serif;font-size:11.5pt;line-height:1.75;color:#111;direction:rtl}
.lh{text-align:center;border-bottom:2px solid #c55a11;padding-bottom:6px;margin-bottom:10px}
.lh b{display:block;color:#c55a11;font-size:17pt}
.lh span{font-size:8.5pt;color:#555}
h1{font-size:17pt;text-align:center;margin:8px 0 10px}
h2{font-size:12.5pt;color:#1f3864;margin:14px 0 4px;break-after:avoid}
p{margin:0 0 6px;text-align:justify}
p.sub{margin-right:22px}
p.center{text-align:center}
table.grid{width:100%;border-collapse:collapse;margin:6px 0 10px;font-size:10pt}
table.grid th,table.grid td{border:1px solid #777;padding:5px 7px;vertical-align:top;text-align:right}
table.grid th{background:#d9e2f3}
table.kv th{width:38%;background:#f2f2f2}
table.grid tr{break-inside:avoid}
table.signt{width:100%;margin-top:22px;break-inside:avoid}
td.sig{width:50%;vertical-align:top;line-height:2.1}
.pb{break-before:page}
@media screen{body{max-width:820px;margin:0 auto;padding:18px;background:#fff}}
`;

export function renderDocument(s: Snap): string {
  const c = s.company;
  const head = `<div class="lh"><b>${E(c.name)}</b><span>س.ت: ${E(c.cr)} | الرقم الضريبي: ${E(c.vat)} | الرقم الوطني الموحد: ${E(c.unified)} | جوال: ${E(c.phone)}</span></div>`;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${E(s.docNo)}</title><style>${CSS}</style></head><body>
${head}${contractBody(s)}
<div class="pb">${head}${appendixA(s)}</div>
<div class="pb">${head}${appendixB(s)}</div>
</body></html>`;
}
