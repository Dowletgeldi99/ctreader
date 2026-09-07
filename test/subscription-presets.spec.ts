import { describe, expect, it } from "vitest";
import { PLAN_PRESETS } from "../src/subscriptions/subscription-presets";

describe("subscription plan presets", () => {
  it("keeps trial demo-only and limited to one account", () => {
    expect(PLAN_PRESETS.TRIAL.liveTradingEnabled).toBe(false);
    expect(PLAN_PRESETS.TRIAL.maxAccounts).toBe(1);
  });

  it("does not expose MULTI or NEWS_REVERSAL on Basic", () => {
    expect(PLAN_PRESETS.BASIC.multiEnabled).toBe(false);
    expect(PLAN_PRESETS.BASIC.newsReversalEnabled).toBe(false);
  });

  it("enables every execution mode on Pro", () => {
    expect(PLAN_PRESETS.PRO).toMatchObject({
      marketEnabled: true,
      ocoEnabled: true,
      multiEnabled: true,
      newsReversalEnabled: true,
      liveTradingEnabled: true,
      maxAccounts: 3,
    });
  });
});
