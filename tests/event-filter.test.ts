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
    const event = makeEvent();
    const eligible = filterEligibleEvent(event);
    expect(extractEligibleTokens(event, eligible!, testConfig, now)[0]).toMatchObject({
      durationDays: 10,
      progressPercent: 10,
    });
  });

  it("uses the configured maximum duration as a filter", () => {
    const event = makeEvent();
    const eligible = filterEligibleEvent(event);
    expect(
      extractEligibleTokens(
        event,
        eligible!,
        { ...testConfig, maxMarketDurationDays: 5 },
        now,
      ),
    ).toEqual([]);
  });

  it("uses lifecycle progress only for display and ordering", () => {
    const almostFinished = makeEvent({
      schedule: {
        startDate: "2025-12-23T00:00:00.000Z",
        endDate: "2026-01-02T01:00:00.000Z",
      },
    });

    const eligible = filterEligibleEvent(almostFinished);
    expect(
      extractEligibleTokens(
        almostFinished,
        eligible!,
        testConfig,
        now,
      )[0],
    ).toMatchObject({ progressPercent: expect.any(Number) });
  });

  it("requires a total duration from one day through the selected maximum", () => {
    const filterConfig = {
      ...testConfig,
      maxMarketDurationDays: 1,
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

    expect(
      extractEligibleTokens(
        shorterThanOneDay,
        filterEligibleEvent(shorterThanOneDay)!,
        filterConfig,
        halfwayThrough,
      ),
    ).toEqual([]);
    expect(
      extractEligibleTokens(
        exactlyOneDay,
        filterEligibleEvent(exactlyOneDay)!,
        filterConfig,
        halfwayThrough,
      )[0],
    ).toMatchObject({ durationDays: 1, progressPercent: 50 });
  });

  it("uses each market's own schedule for the one-to-maximum-day rule", () => {
    const event = makeEvent({
      schedule: {
        startDate: "2025-12-01T00:00:00.000Z",
        endDate: "2026-02-01T00:00:00.000Z",
      },
      markets: [
        makeMarket({
          state: {
            active: true,
            closed: false,
            acceptingOrders: true,
            enableOrderBook: true,
            startDate: "2026-01-01T00:00:00.000Z",
            endDate: "2026-01-11T00:00:00.000Z",
          },
        }),
      ],
    });

    const eligible = filterEligibleEvent(event);

    expect(eligible).not.toBeNull();
    expect(extractEligibleTokens(event, eligible!, testConfig, now)).toEqual([
      expect.objectContaining({
        tokenId: "yes-token",
        openedAt: "2026-01-01T00:00:00.000Z",
        endsAt: "2026-01-11T00:00:00.000Z",
        durationDays: 10,
        progressPercent: 10,
      }),
      expect.objectContaining({
        tokenId: "no-token",
        durationDays: 10,
      }),
    ]);
  });

  it("rejects a child market whose own total duration is under one day", () => {
    const event = makeEvent({
      markets: [
        makeMarket({
          state: {
            active: true,
            closed: false,
            acceptingOrders: true,
            enableOrderBook: true,
            startDate: "2026-01-01T18:00:00.000Z",
            endDate: "2026-01-02T06:00:00.000Z",
          },
        }),
      ],
    });
    const eligible = filterEligibleEvent(event);

    expect(eligible).not.toBeNull();
    expect(extractEligibleTokens(event, eligible!, testConfig, now)).toEqual([]);
  });

  it("does not return sports tokens after game start", () => {
    const event = makeEvent({
      markets: [
        makeMarket({ sports: { gameStartTime: "2026-01-01T12:00:00.000Z" } }),
      ],
    });
    const eligible = filterEligibleEvent(event);
    expect(eligible).not.toBeNull();
    expect(extractEligibleTokens(event, eligible!, testConfig, now)).toEqual([]);
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
      const eligible = filterEligibleEvent(event);
      expect(eligible).not.toBeNull();
      expect(extractEligibleTokens(event, eligible!, testConfig, now)).toEqual([]);
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
    const eligible = filterEligibleEvent(event);

    expect(extractEligibleTokens(event, eligible!, testConfig, now)).toEqual([
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
      const eligible = filterEligibleEvent(event);
      expect(extractEligibleTokens(event, eligible!, testConfig, now)).toEqual([]);
    }
  });
});
