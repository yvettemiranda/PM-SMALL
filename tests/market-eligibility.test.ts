import { describe, expect, it } from "vitest";
import {
  isMarketEligible,
  type MarketEligibilitySettings,
} from "../src/domain/market-eligibility.js";
import { makeCandidate } from "./helpers.js";

const settings: MarketEligibilitySettings = {
  resultCounts: [2, 3],
  allCategories: true,
  selectedCategoryIds: [],
  minBuyPriceMicros: 10_000,
  maxBuyPriceMicros: 30_000,
  minBidAskRatioPercent: 50,
  minMarketDurationDays: 1,
  maxMarketDurationDays: 30,
  maxMarketProgressPercent: 20,
  orderBudgetMicros: 1_000_000,
};

describe("market eligibility", () => {
  it("applies the fixed 1 cent floor, a valid bid, and the configured ratio", () => {
    expect(
      isMarketEligible(makeCandidate({ bestAskMicros: 9_999 }), settings),
    ).toBe(false);
    expect(
      isMarketEligible(makeCandidate({ bestBidMicros: null }), settings),
    ).toBe(false);
    expect(
      isMarketEligible(
        makeCandidate({ bestAskMicros: 30_000, bestBidMicros: 10_000 }),
        settings,
      ),
    ).toBe(false);
    expect(
      isMarketEligible(
        makeCandidate({ bestAskMicros: 20_000, bestBidMicros: 10_000 }),
        settings,
      ),
    ).toBe(true);
  });

  it("treats the configured lifecycle percentage as an inclusive hard limit", () => {
    expect(
      isMarketEligible(makeCandidate({ progressPercent: 20 }), settings),
    ).toBe(true);
    expect(
      isMarketEligible(makeCandidate({ progressPercent: 20.0001 }), settings),
    ).toBe(false);
  });

  it("treats both configured market-duration endpoints as inclusive", () => {
    const durationRange = {
      ...settings,
      minMarketDurationDays: 7,
      maxMarketDurationDays: 30,
    };

    expect(isMarketEligible(makeCandidate({ durationDays: 6.99 }), durationRange)).toBe(false);
    expect(isMarketEligible(makeCandidate({ durationDays: 7 }), durationRange)).toBe(true);
    expect(isMarketEligible(makeCandidate({ durationDays: 30 }), durationRange)).toBe(true);
    expect(isMarketEligible(makeCandidate({ durationDays: 30.01 }), durationRange)).toBe(false);
  });

  it("removes a sports market as soon as its game starts", () => {
    const beforeStart = new Date("2026-01-02T00:00:00.000Z");
    const atStart = new Date("2026-01-02T01:00:00.000Z");
    const candidate = makeCandidate({
      gameStartsAt: "2026-01-02T01:00:00.000Z",
    });

    expect(isMarketEligible(candidate, settings, beforeStart)).toBe(true);
    expect(isMarketEligible(candidate, settings, atStart)).toBe(false);
  });

  it("matches any selected official category id", () => {
    const selected = {
      ...settings,
      allCategories: false,
      selectedCategoryIds: ["tag-politics"],
    };
    expect(
      isMarketEligible(
        makeCandidate({ categoryIds: ["tag-us", "tag-politics"] }),
        selected,
      ),
    ).toBe(true);
    expect(
      isMarketEligible(
        makeCandidate({ categoryIds: ["tag-sports"] }),
        selected,
      ),
    ).toBe(false);
  });

  it("requires a complete book and a configured amount above the minimum size", () => {
    expect(
      isMarketEligible(makeCandidate({ bookReady: false }), settings),
    ).toBe(false);
    expect(
      isMarketEligible(
        makeCandidate({ minOrderSizeMicros: 40_000_000 }),
        settings,
      ),
    ).toBe(false);
    expect(
      isMarketEligible(makeCandidate({ tickSizeMicros: 0 }), settings),
    ).toBe(false);
  });
});
