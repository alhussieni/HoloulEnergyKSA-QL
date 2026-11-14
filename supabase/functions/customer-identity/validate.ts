// validate.ts — دوال نقية (بلا Deno ولا شبكة) لتطبيع أرقام الهوية والتحقق منها وإخفائها.

export type IdType = "national_id" | "iqama" | "gcc_id" | "passport";
export const ID_TYPES: IdType[] = ["national_id", "iqama", "gcc_id", "passport"];

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const EXT_ARABIC_INDIC = "۰۱۲۳۴۵۶۷۸۹";

/** يحوّل الأرقام العربية/الفارسية إلى لاتينية ويزيل المسافات والشرطات والنقاط. */
export function normalizeDigits(raw: unknown): string {
  return String(raw ?? "")
    .replace(/[٠-٩۰-۹]/g, (c) => {
      const i = ARABIC_INDIC.indexOf(c);
      return String(i >= 0 ? i : EXT_ARABIC_INDIC.indexOf(c));
    })
    .replace(/[\s\-_.\u200e\u200f\u202a-\u202e]/g, "")
    .trim();
}

export function normalizeId(idType: string, raw: unknown): string {
  const s = normalizeDigits(raw);
  return idType === "gcc_id" || idType === "passport" ? s.toUpperCase() : s;
}

/** فحص المجموع الاختباري (Luhn) للهوية الوطنية/الإقامة. للتنبيه فقط وليس للمنع. */
export function saudiChecksumOk(id: string): boolean {
  if (!/^[0-9]{10}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let d = Number(id[i]);
    if (i % 2 === 0 && i < 9) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export interface Validation {
  ok: boolean;
  error?: string;
  /** صيغة سليمة لكن المجموع الاختباري لا يطابق — يُطلب تأكيد المستخدم. */
  checksumWarning?: boolean;
}

/** `id` يجب أن تكون ناتجة عن normalizeId. */
export function validateId(idType: string, id: string): Validation {
  switch (idType) {
    case "national_id":
      if (!/^1[0-9]{9}$/.test(id)) return { ok: false, error: "الهوية الوطنية 10 أرقام وتبدأ بـ 1" };
      return { ok: true, checksumWarning: !saudiChecksumOk(id) };
    case "iqama":
      if (!/^2[0-9]{9}$/.test(id)) return { ok: false, error: "رقم الإقامة 10 أرقام ويبدأ بـ 2" };
      return { ok: true, checksumWarning: !saudiChecksumOk(id) };
    case "gcc_id":
    case "passport":
      if (!/^[A-Z0-9]{5,20}$/.test(id)) return { ok: false, error: "من 5 إلى 20 حرفاً أو رقماً بلا رموز" };
      return { ok: true };
    default:
      return { ok: false, error: "نوع الوثيقة غير معروف" };
  }
}

/** إخفاء: يُبقي آخر 4 فقط. */
export function maskId(id: string): string {
  if (!id) return "";
  if (id.length <= 4) return "*".repeat(id.length);
  return "*".repeat(id.length - 4) + id.slice(-4);
}
