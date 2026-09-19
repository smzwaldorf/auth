import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { label, t, tn, withLocale } from "./i18n.js";
import { zhHant } from "./i18n.zh-hant.js";

const dir = dirname(fileURLToPath(import.meta.url));
/** Every literal key passed to t()/tn() in the admin source, plus the keys looked up dynamically. */
function sourceKeys() {
  const keys = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts") || file.startsWith("i18n")) continue;
    const source = readFileSync(join(dir, file), "utf8");
    for (const m of source.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) keys.add(m[1]!.replace(/\\"/g, '"'));
    for (const m of source.matchAll(/\btn\(\s*[^,]+,\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/g)) { keys.add(m[1]!); keys.add(m[2]!); }
  }
  for (const k of ["Father", "Mother", "Guardian", "Child", "Student", "Teacher", "Parent", "Admin", "pending", "activated", "expired", "revoked",
    "Directory", "Integrations", "Overview", "Users", "Students", "Families", "Classes", "Applications",
    "Add student", "Associate to class", "Choose family", "Parents and guardians", "Family graph", "Confirm creation",
    "Add family", "Create family", "New family", "Family details", "Create student", "New student", "Student details", "Add class", "Create class", "New class", "Class details",
    "Active", "Scheduled", "Ended", "Inactive", "{n} person", "{n} people", "{n} family", "{n} families", "{n} class", "{n} classes", "{n} student", "{n} students"]) keys.add(k);
  return keys;
}
describe("admin i18n", () => {
  it("has a Traditional Chinese translation for every key used in the admin panel", () => {
    const missing = [...sourceKeys()].filter(k => !(k in zhHant)).sort();
    expect(missing).toEqual([]);
  });
  it("keeps placeholders intact in translations", () => {
    const broken = Object.entries(zhHant).filter(([k, v]) => { const want = [...k.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort(); const got = [...v.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort(); return JSON.stringify(want) !== JSON.stringify(got); });
    expect(broken.map(([k]) => k)).toEqual([]);
  });
  it("falls back to English outside a request and switches per request", async () => {
    expect(t("Users")).toBe("Users");
    expect(tn(1, "{n} student", "{n} students")).toBe("1 student");
    expect(tn(2, "{n} student", "{n} students")).toBe("2 students");
    await withLocale("zh-Hant", "/admin", () => {
      expect(t("Users")).toBe("用戶");
      expect(t("Page {page} of {pages}", { page: 2, pages: 5 })).toBe("第 2 頁，共 5 頁");
      expect(tn(1, "{n} student", "{n} students")).toBe("1 位學生");
      expect(label("guardian")).toBe("監護人");
      expect(t("Not translated yet {x}", { x: 1 })).toBe("Not translated yet 1");
    });
    await withLocale("en", "/admin", () => expect(label("guardian")).toBe("Guardian"));
  });
});
