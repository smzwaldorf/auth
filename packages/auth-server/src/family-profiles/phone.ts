import { z } from "zod";

/** Keep dialing information (country code and extension), remove visual separators. */
export function normalizePhone(value: string): string {
  return value.trim().replace(/[\s().-]/g, "");
}

export const contactPhoneInput = z.string().trim().max(40).refine(
  value => !value || (/\d/.test(value) && /^[+\d() .\-#分機轉]+$/.test(value)),
  "電話格式不正確。",
).transform(normalizePhone);

/** Format recognised Taiwan numbers only; do not guess other numbering plans. */
export function formatPhone(value: string): string {
  const compact = normalizePhone(value);
  const parts = /^(\+?\d+)(?:(?:#|分機|轉)(\d+))?$/.exec(compact);
  if (!parts) return value.trim();
  const number = parts[1]!;
  const international = number.startsWith("+886");
  const local = international ? `0${number.slice(4)}` : number;
  let formatted: string | undefined;
  if (/^09\d{8}$/.test(local)) {
    formatted = `${local.slice(0, 4)}-${local.slice(4, 7)}-${local.slice(7)}`;
  } else if (/^0[24]\d{8}$/.test(local)) {
    formatted = `${local.slice(0, 2)}-${local.slice(2, 6)}-${local.slice(6)}`;
  } else if (/^0(?:37|49|89)\d{6}$/.test(local)) {
    formatted = `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
  } else if (/^0[35678]\d{7}$/.test(local) && !local.startsWith("082") && !local.startsWith("083")) {
    formatted = `${local.slice(0, 2)}-${local.slice(2, 5)}-${local.slice(5)}`;
  }
  if (!formatted) return value.trim();
  if (international) formatted = `+886 ${formatted.slice(1)}`;
  return `${formatted}${parts[2] ? ` 分機 ${parts[2]}` : ""}`;
}
