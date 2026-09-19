import { AsyncLocalStorage } from "node:async_hooks";
import { zhHant } from "./i18n.zh-hant.js";

export type Locale = "zh-Hant" | "en";
export const locales: Locale[] = ["zh-Hant", "en"];
export const defaultLocale: Locale = "zh-Hant";
export const localeCookie = "smz_admin_lang";
export const localeNames: Record<Locale, string> = { "zh-Hant": "繁體中文", en: "English" };
type Store = { locale: Locale; path: string };
const store = new AsyncLocalStorage<Store>();
/** Runs `fn` with the request's locale and path visible to `t()` and the layout's language switcher. */
export const withLocale = <T>(locale: Locale, path: string, fn: () => T | Promise<T>) => store.run({ locale, path }, fn);
/** Outside a request (tests, CLIs) strings stay in English. */
export const currentLocale = (): Locale => store.getStore()?.locale ?? "en";
export const currentPath = () => store.getStore()?.path ?? "/admin";
export const parseLocale = (value: string | undefined | null): Locale | null => locales.includes(value as Locale) ? value as Locale : null;
type Params = Record<string, string | number>;
const interpolate = (text: string, params?: Params) => params ? text.replace(/\{(\w+)\}/g, (m, key: string) => key in params ? String(params[key]) : m) : text;
/** Translates an English source string. Missing translations fall back to English so a gap is never blank. */
export function t(key: string, params?: Params): string {
  const text = currentLocale() === "zh-Hant" ? zhHant[key] ?? key : key;
  return interpolate(text, params);
}
/** Count-aware variant: English picks singular/plural, Chinese uses the plural form (no grammatical number). */
export function tn(count: number, singular: string, plural: string, params: Params = {}): string {
  const key = currentLocale() === "en" && count === 1 ? singular : plural;
  return t(key, { n: count, ...params });
}
/** Localized display label for relationship, role and status enum values. */
export const label = (value: string) => t(value.charAt(0).toUpperCase() + value.slice(1));
