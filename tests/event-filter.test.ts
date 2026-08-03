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
});
