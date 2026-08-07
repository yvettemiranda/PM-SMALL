import { describe, expect, it } from "vitest";
import {
  isMarketTypeEnabled,
  marketTypeForResultCount,
  normalizeMarketTypes,
} from "../src/domain/market-type.js";

describe("market type selection", () => {
  it.each([
    [2, "BINARY"],
    [3, "TERNARY"],
    [4, "MULTI"],
    [10, "MULTI"],
    [Number.MAX_SAFE_INTEGER, "MULTI"],
  ] as const)("classifies resultCount %s as %s", (resultCount, expected) => {
    expect(marketTypeForResultCount(resultCount)).toBe(expected);
  });

  it.each([null, undefined, 1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid resultCount: %s",
    (resultCount) => {
      expect(marketTypeForResultCount(resultCount)).toBeNull();
    },
  );

  it("keeps binary, ternary, and 4+ selection independent", () => {
    expect(isMarketTypeEnabled(2, ["BINARY"])).toBe(true);
    expect(isMarketTypeEnabled(3, ["BINARY"])).toBe(false);
    expect(isMarketTypeEnabled(10, ["MULTI"])).toBe(true);
    expect(isMarketTypeEnabled(3, ["MULTI"])).toBe(false);
  });

  it("normalizes duplicate selections in stable product order", () => {
    expect(
      normalizeMarketTypes(["MULTI", "BINARY", "MULTI", "TERNARY"]),
    ).toEqual(["BINARY", "TERNARY", "MULTI"]);
  });
});
