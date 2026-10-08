import { describe, expect, it } from "vitest";
import { contactPhoneInput, formatPhone, normalizePhone } from "./phone.js";
import { displayValue, field, sameValue, values } from "./views.js";

describe("profile phone numbers", () => {
  it.each([
    ["0912345678", "0912345678", "0912-345-678"],
    ["(0912) 345-678", "0912345678", "0912-345-678"],
    ["(02) 1234-5678", "0212345678", "02-1234-5678"],
    ["04-23456789", "0423456789", "04-2345-6789"],
    ["03-1234567", "031234567", "03-123-4567"],
    ["037-123456", "037123456", "037-123-456"],
    ["+886 (912) 345-678", "+886912345678", "+886 912-345-678"],
    ["(02) 1234-5678 #123", "0212345678#123", "02-1234-5678 分機 123"],
    ["0212345678分機123", "0212345678分機123", "02-1234-5678 分機 123"],
    ["", "", ""],
  ])("accepts %s and separates editing from display", (input, plain, display) => {
    expect(contactPhoneInput.parse(input)).toBe(plain);
    expect(formatPhone(input)).toBe(display);
    expect(formatPhone(plain)).toBe(display);
    expect(normalizePhone(plain)).toBe(plain);
  });
  it("preserves international numbers and extensions without guessing their grouping", () => {
    expect(contactPhoneInput.parse("+1 (212) 555-0123 #45")).toBe("+12125550123#45");
    expect(formatPhone("+12125550123#45")).toBe("+12125550123#45");
    expect(formatPhone("082612345")).toBe("082612345");
  });
  it.each(["call me", "---", "()", "123<script>", "1".repeat(41)])("rejects invalid input %s", input => {
    expect(contactPhoneInput.safeParse(input).success).toBe(false);
  });
  it("renders plain editable values and formatted approved, history and comparison values", () => {
    expect(field("contactPhone", "(0912) 345-678", "person")).toContain('value="0912345678"');
    expect(values({contactPhone: "0212345678"}, "family")).toContain("02-1234-5678");
    expect(displayValue("contactPhone", "0912345678")).toBe("0912-345-678");
    expect(sameValue("contactPhone", "(02) 1234-5678", "0212345678")).toBe(true);
    expect(sameValue("contactPhone", "0212345678#1", "0212345678#2")).toBe(false);
    expect(displayValue("contactEmail", "me@example.test")).toBe("me@example.test");
  });
});
