import { describe, expect, it } from "vitest";
import { allocateNewsReversalVolume } from "../src/ctrader/news-reversal-volume";

describe("allocateNewsReversalVolume", () => {
  it("splits total volume and assigns rounding remainder to the last legs", () => {
    expect(allocateNewsReversalVolume(100, 1, "SPLIT_TOTAL")).toEqual({ legs: [33, 33, 34], total: 100 });
  });

  it("uses selected volume for every target in full-each mode", () => {
    expect(allocateNewsReversalVolume(100, 1, "FULL_EACH")).toEqual({ legs: [100, 100, 100], total: 300 });
  });

  it("respects broker volume steps", () => {
    expect(allocateNewsReversalVolume(100, 10, "SPLIT_TOTAL")).toEqual({ legs: [30, 30, 40], total: 100 });
  });

  it("rejects totals that cannot create all three legs", () => {
    expect(() => allocateNewsReversalVolume(20, 10, "SPLIT_TOTAL")).toThrow(/too small/);
  });
});
