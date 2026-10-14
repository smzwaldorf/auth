import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { userFiltersScript } from "./views.js";

function setup() {
  const search = new EventTarget(), select = new EventTarget();
  const form = Object.assign(new EventTarget(), {
    querySelector: () => search,
    querySelectorAll: () => [select],
    requestSubmit: vi.fn(),
  });
  runInNewContext(userFiltersScript, { document: { getElementById: () => form }, setTimeout, clearTimeout });
  return { search, select, form };
}
describe("user filters", () => {
  it("debounces typing and immediately applies selections without a duplicate request", () => {
    vi.useFakeTimers();
    try {
      const { search, select, form } = setup();
      search.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(200);
      search.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(349);
      expect(form.requestSubmit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(form.requestSubmit).toHaveBeenCalledTimes(1);
      search.dispatchEvent(new Event("input"));
      select.dispatchEvent(new Event("change"));
      expect(form.requestSubmit).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(500);
      expect(form.requestSubmit).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
  it("waits until Chinese input composition finishes", () => {
    vi.useFakeTimers();
    try {
      const { search, form } = setup();
      search.dispatchEvent(new Event("compositionstart"));
      search.dispatchEvent(new Event("input"));
      vi.advanceTimersByTime(1000);
      expect(form.requestSubmit).not.toHaveBeenCalled();
      search.dispatchEvent(new Event("compositionend"));
      vi.advanceTimersByTime(350);
      expect(form.requestSubmit).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
