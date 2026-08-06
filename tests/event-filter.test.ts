import { describe, expect, it } from "vitest";
import {
  extractEligibleTokens,
  filterEligibleEvent,
  normalizeEventResultCount,
} from "../src/domain/event-filter.js";
import { makeEvent, makeMarket, testConfig } from "./helpers.js";

describe("event filtering", () => {
  const now = new Date("2026-01-02T00:00:00.000Z");

  it("treats a single binary market as two results", () => {
    expect(normalizeEventResultCount(makeEvent())).toBe(2);
  });

  it("accepts a non-augmented three-result negative-risk event", () => {
    const event = makeEvent({
      trading: { negRisk: true, negRiskAugmented: false },
      markets: [
        makeMarket({ id: "m1" }),
        makeMarket({ id: "m2" }),
        makeMarket({ id: "m3" }),
      ],
    });
    expect(normalizeEventResultCount(event)).toBe(3);
  });

  it("rejects augmented and larger events", () => {
    const augmented = makeEvent({
      trading: { negRisk: true, negRiskAugmented: true },
      markets: [makeMarket({ id: "m1" }), makeMarket({ id: "m2" })],
    });
    expect(normalizeEventResultCount(augmented)).toBeNull();
  });

  it("calculates duration and progress", () => {
    const eligible = filterEligibleEvent(makeEvent(), testConfig, now);
    expect(eligible?.durationDays).toBe(10);
    expect(eligible?.progressPercent).toBe(10);
  });

  it("uses the configured maximum duration as a filter", () => {
    const eligible = filterEligibleEvent(
      makeEvent(),
      { ...testConfig, maxMarketDurationDays: 5 },
      now,
    );
    expect(eligible).toBeNull();
  });

  it("uses lifecycle progress only for display and ordering", () => {
    const almostFinished = makeEvent({
      schedule: {
        startDate: "2025-12-23T00:00:00.000Z",
        endDate: "2026-01-02T01:00:00.000Z",
      },
    });

    expect(
      filterEligibleEvent(
        almostFinished,
        { ...testConfig, maxMarketProgressPercent: 20 },
        now,
      ),
    ).toMatchObject({ progressPercent: expect.any(Number) });
  });

  it("requires a total duration from one day through the selected maximum", () => {
    const filterConfig = {
      ...testConfig,
      maxMarketDurationDays: 1,
      maxMarketProgressPercent: 100,
    };
    const halfwayThrough = new Date("2026-01-01T12:00:00.000Z");
    const shorterThanOneDay = makeEvent({
      schedule: {
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-01T23:59:59.999Z",
      },
    });
    const exactlyOneDay = makeEvent({
      schedule: {
        startDate: "2026-01-01T00:00:00.000Z",
        endDate: "2026-01-02T00:00:00.000Z",
      },
    });

    expect(filterEligibleEvent(shorterThanOneDay, filterConfig, halfwayThrough)).toBeNull();
    expect(
      filterEligibleEvent(exactlyOneDay, filterConfig, halfwayThrough),
    ).toMatchObject({ durationDays: 1, progressPercent: 50 });
  });

  it("does not return sports tokens after game start", () => {
    const event = makeEvent({
      markets: [
        makeMarket({ sports: { gameStartTime: "2026-01-01T12:00:00.000Z" } }),
      ],
    });
    const eligible = filterEligibleEvent(event, testConfig, now);
    expect(eligible).not.toBeNull();
    expect(extractEligibleTokens(event, eligible!, now)).toEqual([]);
  });

  it("requires every market to be open and orderable", () => {
    const states = [
      {
        active: false,
        closed: false,
        acceptingOrders: true,
        enableOrderBook: true,
      },
      {
        active: true,
        closed: true,
        acceptingOrders: true,
        enableOrderBook: true,
      },
      {
        active: true,
        closed: false,
        archived: true,
        acceptingOrders: true,
        enableOrderBook: true,
      },
      {
        active: true,
        closed: false,
        acceptingOrders: false,
        enableOrderBook: true,
      },
      {
        active: true,
        closed: false,
        acceptingOrders: true,
        enableOrderBook: false,
      },
    ];

    for (const state of states) {
      const event = makeEvent({ markets: [makeMarket({ state })] });
      const eligible = filterEligibleEvent(event, testConfig, now);
      expect(eligible).not.toBeNull();
      expect(extractEligibleTokens(event, eligible!, now)).toEqual([]);
    }
  });

  it("carries the market fee schedule into every executable token", () => {
    const event = makeEvent({
      markets: [
        makeMarket({
          trading: {
            feesEnabled: true,
            feeSchedule: {
              rate: "0.04",
              exponent: 1,
              takerOnly: true,
              rebateRate: "0.25",
            },
          },
        }),
      ],
    });
    const eligible = filterEligibleEvent(event, testConfig, now);

    expect(extractEligibleTokens(event, eligible!, now)).toEqual([
      expect.objectContaining({
        tokenId: "yes-token",
        feesEnabled: true,
        feeRateMicros: 40_000,
        feeExponent: 1,
      }),
      expect.objectContaining({
        tokenId: "no-token",
        feesEnabled: true,
        feeRateMicros: 40_000,
        feeExponent: 1,
      }),
    ]);
  });

  it("fails closed when a fee-enabled market has no valid fee schedule", () => {
    const invalidSchedules = [
      { feesEnabled: true },
      { feesEnabled: true, feeSchedule: { rate: "invalid", exponent: 1 } },
      { feesEnabled: true, feeSchedule: { rate: "0.04", exponent: -1 } },
    ];

    for (const trading of invalidSchedules) {
      const event = makeEvent({ markets: [makeMarket({ trading })] });
      const eligible = filterEligibleEvent(event, testConfig, now);
      expect(extractEligibleTokens(event, eligible!, now)).toEqual([]);
    }
  });
});
