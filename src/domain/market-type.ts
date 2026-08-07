export const MARKET_TYPES = ["BINARY", "TERNARY", "MULTI"] as const;

export type MarketType = (typeof MARKET_TYPES)[number];

export function marketTypeForResultCount(
  resultCount: number | null | undefined,
): MarketType | null {
  if (
    resultCount === null ||
    resultCount === undefined ||
    !Number.isSafeInteger(resultCount) ||
    resultCount < 2
  ) {
    return null;
  }
  if (resultCount === 2) return "BINARY";
  if (resultCount === 3) return "TERNARY";
  return "MULTI";
}

export function isMarketTypeEnabled(
  resultCount: number | null | undefined,
  enabledMarketTypes: readonly MarketType[],
): boolean {
  const marketType = marketTypeForResultCount(resultCount);
  return marketType !== null && enabledMarketTypes.includes(marketType);
}

export function normalizeMarketTypes(
  marketTypes: readonly MarketType[],
): MarketType[] {
  const selected = new Set(marketTypes);
  return MARKET_TYPES.filter((marketType) => selected.has(marketType));
}
