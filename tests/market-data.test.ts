import { describe, expect, it } from "vitest";
import type { PublicClient } from "@polymarket/client";
import { PolymarketMarketDataSource } from "../src/infrastructure/polymarket/market-data.js";

describe("PolymarketMarketDataSource", () => {
  it("normalizes the official market resolution fields without a wallet", async () => {
    const source = new PolymarketMarketDataSource({
      fetchMarket: async () =>
        ({
          id: "market-1",
          conditionId: "0xcondition",
          state: { closed: true },
          resolution: { umaResolutionStatus: "resolved" },
          outcomes: {
            yes: { label: "Yes", tokenId: "yes-token", price: "1" },
            no: { label: "No", tokenId: "no-token", price: "0" },
          },
        }) as never,
    } as unknown as PublicClient);

    await expect(source.fetchMarketResolution("market-1")).resolves.toEqual({
      marketId: "market-1",
      conditionId: "0xcondition",
      closed: true,
      resolutionStatus: "resolved",
      outcomes: [
        { tokenId: "yes-token", label: "Yes", priceMicros: 1_000_000 },
        { tokenId: "no-token", label: "No", priceMicros: 0 },
      ],
    });
  });

  it("does not round a near-final transient price into a settlement result", async () => {
    const source = new PolymarketMarketDataSource({
      fetchMarket: async () =>
        ({
          id: "market-1",
          conditionId: "0xcondition",
          state: { closed: true },
          resolution: { umaResolutionStatus: "resolved" },
          outcomes: {
            yes: { label: "Yes", tokenId: "yes-token", price: "0.9999996" },
            no: { label: "No", tokenId: "no-token", price: "0" },
          },
        }) as never,
    } as unknown as PublicClient);

    await expect(source.fetchMarketResolution("market-1")).resolves.toMatchObject({
      outcomes: [
        { tokenId: "yes-token", priceMicros: null },
        { tokenId: "no-token", priceMicros: 0 },
      ],
    });
  });
});
