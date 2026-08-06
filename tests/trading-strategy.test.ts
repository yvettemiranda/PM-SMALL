import { describe, expect, it } from "vitest";
import {
  calculateTakerFeeMicros,
  planFakBuy,
  planFakSell,
  sortTradeCandidates,
} from "../src/domain/trading-strategy.js";
import { makeCandidate } from "./helpers.js";

describe("shared trading strategy", () => {
  it("plans a price-capped FAK buy across executable ask levels", () => {
    const plan = planFakBuy({
      asks: [
        { priceMicros: 40_000, sizeMicros: 100_000_000 },
        { priceMicros: 30_000, sizeMicros: 20_000_000 },
        { priceMicros: 20_000, sizeMicros: 20_000_000 },
      ],
      maxPriceMicros: 30_000,
      maxSpendMicros: 1_000_000,
      minOrderSizeMicros: 5_000_000,
      feeRateMicros: 0,
      feeExponent: 1,
    });

    expect(plan).toMatchObject({
      grossFillSizeMicros: 40_000_000,
      netFillSizeMicros: 40_000_000,
      spentMicros: 1_000_000,
      feeMicros: 0,
      fullySpent: true,
    });
    expect(plan?.fills.map((fill) => fill.priceMicros)).toEqual([
      20_000,
      30_000,
    ]);
  });

  it("keeps a FAK partial fill and cancels the unfilled cash remainder", () => {
    const plan = planFakBuy({
      asks: [{ priceMicros: 20_000, sizeMicros: 10_000_000 }],
      maxPriceMicros: 30_000,
      maxSpendMicros: 1_000_000,
      minOrderSizeMicros: 5_000_000,
      feeRateMicros: 0,
      feeExponent: 1,
    });

    expect(plan).toMatchObject({
      grossFillSizeMicros: 10_000_000,
      spentMicros: 200_000,
      fullySpent: false,
    });
  });

  it("deducts the dynamic taker fee from bought shares", () => {
    const feeMicros = calculateTakerFeeMicros({
      sizeMicros: 100_000_000,
      priceMicros: 500_000,
      feeRateMicros: 40_000,
      feeExponent: 1,
    });
    expect(feeMicros).toBe(1_000_000);

    const plan = planFakBuy({
      asks: [{ priceMicros: 500_000, sizeMicros: 100_000_000 }],
      maxPriceMicros: 500_000,
      maxSpendMicros: 50_000_000,
      minOrderSizeMicros: 5_000_000,
      feeRateMicros: 40_000,
      feeExponent: 1,
    });
    expect(plan).toMatchObject({
      grossFillSizeMicros: 100_000_000,
      netFillSizeMicros: 98_000_000,
      spentMicros: 50_000_000,
      feeMicros: 1_000_000,
    });
  });

  it("plans a target-protected FAK sell and subtracts fees from proceeds", () => {
    const plan = planFakSell({
      bids: [
        { priceMicros: 35_000, sizeMicros: 10_000_000 },
        { priceMicros: 40_000, sizeMicros: 10_000_000 },
        { priceMicros: 25_000, sizeMicros: 100_000_000 },
      ],
      minPriceMicros: 30_000,
      availableSizeMicros: 30_000_000,
      minOrderSizeMicros: 5_000_000,
      feeRateMicros: 0,
      feeExponent: 1,
    });

    expect(plan).toMatchObject({
      filledSizeMicros: 20_000_000,
      grossProceedsMicros: 750_000,
      netProceedsMicros: 750_000,
      fullyFilled: false,
    });
    expect(plan?.fills.map((fill) => fill.priceMicros)).toEqual([
      40_000,
      35_000,
    ]);
  });

  it("uses one deterministic order for both UI and execution", () => {
    const candidates = [
      makeCandidate({ tokenId: "b", progressPercent: 10, eventId: "2" }),
      makeCandidate({ tokenId: "c", progressPercent: 20, eventId: "3" }),
      makeCandidate({ tokenId: "a", progressPercent: 10, eventId: "1" }),
    ];

    expect(sortTradeCandidates(candidates, "ASC").map((item) => item.tokenId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(sortTradeCandidates(candidates, "DESC").map((item) => item.tokenId)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });
});
