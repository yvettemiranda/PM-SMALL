import { describe, expect, it } from "vitest";
import {
  arbitrateEvent,
  type EventArbitrationCandidate,
} from "../src/domain/event-arbitration.js";
import { previewFakBuy } from "../src/domain/trading-strategy.js";
import { makeCandidate } from "./helpers.js";

function opportunity(input: {
  tokenId: string;
  direction?: "YES" | "NO";
  marketId?: string;
  ask?: number;
  bid?: number;
  askSize?: number;
  bidSize?: number;
  cycleBudget?: number;
  feeRateMicros?: number;
  progressPercent?: number;
}): EventArbitrationCandidate {
  const ask = input.ask ?? 20_000;
  const bid = input.bid ?? 20_000;
  const preview = previewFakBuy({
    asks: [{ priceMicros: ask, sizeMicros: input.askSize ?? 50_000_000 }],
    bids: [{ priceMicros: bid, sizeMicros: input.bidSize ?? 50_000_000 }],
    maxPriceMicros: 30_000,
    maxSpendMicros: input.cycleBudget ?? 1_000_000,
    cycleBudgetMicros: input.cycleBudget ?? 1_000_000,
    minOrderSizeMicros: 1,
    tickSizeMicros: 10_000,
    feeRateMicros: input.feeRateMicros ?? 0,
    feeExponent: 1,
  });
  if (preview === null) throw new Error("test preview unexpectedly had no fill");
  return {
    candidate: makeCandidate({
      candidateId: `${input.tokenId}:${ask}`,
      eventId: "event-arbitration",
      marketId: input.marketId ?? `market-${input.tokenId}`,
      conditionId: `condition-${input.tokenId}`,
      tokenId: input.tokenId,
      direction: input.direction ?? "YES",
      bestAskMicros: ask,
      bestBidMicros: bid,
      progressPercent: input.progressPercent ?? 10,
    }),
    preview,
  };
}

describe("event arbitration", () => {
  it("returns no winner without an executable preview and otherwise one unique winner", () => {
    expect(arbitrateEvent([], "ASC")).toBeNull();
    const only = opportunity({ tokenId: "only" });
    expect(arbitrateEvent([only], "ASC")?.winnerTokenId).toBe("only");

    const noFill = opportunity({ tokenId: "no-fill" });
    noFill.preview.plan.spentMicros = 0;
    expect(arbitrateEvent([noFill], "ASC")).toBeNull();
    expect(arbitrateEvent([noFill, only], "ASC")?.winnerTokenId).toBe("only");
  });

  it("prefers exit readiness, so the cheapest token need not win", () => {
    const cheaper = opportunity({ tokenId: "cheap", ask: 10_000, bid: 10_000 });
    const nearerExit = opportunity({ tokenId: "near", ask: 20_000, bid: 30_000 });

    expect(arbitrateEvent([cheaper, nearerExit], "ASC")?.winnerTokenId).toBe(
      "near",
    );
  });

  it("uses target-bound bid coverage after exit readiness ties", () => {
    const shallow = opportunity({
      tokenId: "shallow",
      bid: 30_000,
      bidSize: 5_000_000,
    });
    const deep = opportunity({
      tokenId: "deep",
      bid: 30_000,
      bidSize: 50_000_000,
    });

    expect(arbitrateEvent([shallow, deep], "ASC")?.winnerTokenId).toBe("deep");
  });

  it("uses fill ratio, bid/ask, fee-adjusted return, lifecycle, then identity", () => {
    const partial = opportunity({ tokenId: "partial", askSize: 10_000_000 });
    const full = opportunity({ tokenId: "full", askSize: 50_000_000 });
    expect(arbitrateEvent([partial, full], "ASC")?.winnerTokenId).toBe("full");

    const wider = opportunity({ tokenId: "wider", ask: 30_000, bid: 30_000 });
    const tighter = opportunity({ tokenId: "tighter", ask: 20_000, bid: 20_000 });
    expect(arbitrateEvent([wider, tighter], "ASC")?.winnerTokenId).toBe("tighter");

    const feeHeavy = opportunity({ tokenId: "fee", feeRateMicros: 100_000 });
    const feeFree = opportunity({ tokenId: "free" });
    expect(arbitrateEvent([feeHeavy, feeFree], "ASC")?.winnerTokenId).toBe("free");

    const early = opportunity({ tokenId: "early", progressPercent: 5 });
    const late = opportunity({ tokenId: "late", progressPercent: 15 });
    expect(arbitrateEvent([late, early], "ASC")?.winnerTokenId).toBe("early");
    expect(arbitrateEvent([early, late], "DESC")?.winnerTokenId).toBe("late");

    const yes = opportunity({ tokenId: "z-token", marketId: "market-a" });
    const no = opportunity({
      tokenId: "a-token",
      marketId: "market-a",
      direction: "NO",
    });
    expect(arbitrateEvent([yes, no], "ASC")?.winnerTokenId).toBe("a-token");
  });

  it("rejects candidates from different events", () => {
    const first = opportunity({ tokenId: "first" });
    const second = opportunity({ tokenId: "second" });
    second.candidate.eventId = "another-event";

    expect(() => arbitrateEvent([first, second], "ASC")).toThrow(
      /same event/i,
    );
  });
});
