import { describe, expect, it } from "vitest";
import {
  calculateTakerFeeMicros,
  planFakBuy,
  planFakSell,
  previewFakBuy,
  sortTradeCandidates,
} from "../src/domain/trading-strategy.js";
import { makeCandidate } from "./helpers.js";

describe("shared trading strategy", () => {
  it("previews FAK fills, per-fill targets, target-bound bid coverage, and net return", () => {
    const preview = previewFakBuy({
      asks: [
        { priceMicros: 10_000, sizeMicros: 40_000_000 },
        { priceMicros: 20_000, sizeMicros: 30_000_000 },
      ],
      bids: [
        { priceMicros: 30_000, sizeMicros: 10_000_000 },
        { priceMicros: 20_000, sizeMicros: 50_000_000 },
        { priceMicros: 10_000, sizeMicros: 100_000_000 },
      ],
      maxPriceMicros: 30_000,
      maxSpendMicros: 1_000_000,
      cycleBudgetMicros: 1_000_000,
      minOrderSizeMicros: 5_000_000,
      tickSizeMicros: 10_000,
      feeRateMicros: 0,
      feeExponent: 1,
    });

    expect(preview).toMatchObject({
      bestAskMicros: 10_000,
      bestBidMicros: 30_000,
      terminalTargetPriceMicros: 30_000,
      exitBidCoverageSizeMicros: 50_000_000,
      exitBidCoveragePositionSizeMicros: 70_000_000,
      targetNetProceedsMicros: 1_700_000,
      targetNetProfitMicros: 700_000,
      cycleBudgetMicros: 1_000_000,
      plan: { spentMicros: 1_000_000, netFillSizeMicros: 70_000_000 },
    });
    expect(preview?.fills).toEqual([
      expect.objectContaining({
        priceMicros: 10_000,
        netSizeMicros: 40_000_000,
        targetPriceMicros: 20_000,
        exitableBidDepthMicros: 60_000_000,
      }),
      expect.objectContaining({
        priceMicros: 20_000,
        netSizeMicros: 30_000_000,
        targetPriceMicros: 30_000,
        exitableBidDepthMicros: 10_000_000,
      }),
    ]);
  });

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

  it("rejects a fee exponent outside the supported bounded range", () => {
    expect(() =>
      calculateTakerFeeMicros({
        sizeMicros: 100_000_000,
        priceMicros: 500_000,
        feeRateMicros: 40_000,
        feeExponent: 11,
      }),
    ).toThrow("fee exponent");
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

  it("does not sell into a bid at or above one dollar", () => {
    const plan = planFakSell({
      bids: [{ priceMicros: 2_000_000, sizeMicros: 10_000_000 }],
      minPriceMicros: 30_000,
      availableSizeMicros: 10_000_000,
      minOrderSizeMicros: 5_000_000,
      feeRateMicros: 40_000,
      feeExponent: 1,
    });

    expect(plan).toBeNull();
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
