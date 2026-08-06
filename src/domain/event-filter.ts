import type { Event, Market } from "@polymarket/client";
import type { AppConfig } from "../config.js";
import type { EligibleEvent, MarketToken } from "./types.js";

const DAY_MS = 86_400_000;

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function normalizeEventResultCount(event: Event): 2 | 3 | null {
  if (event.markets.length === 1) {
    return 2;
  }

  if (
    event.trading.negRisk === true &&
    event.trading.negRiskAugmented !== true &&
    (event.markets.length === 2 || event.markets.length === 3)
  ) {
    return event.markets.length;
  }

  return null;
}

function resolveMarketSchedule(
  event: Event,
  market: Market,
): { openedAt: number; endsAt: number } | null {
  const openedAt =
    parseTimestamp(market.state.startDate) ??
    parseTimestamp(event.schedule.startDate);
  const endsAt =
    parseTimestamp(market.state.endDate) ?? parseTimestamp(event.schedule.endDate);
  if (openedAt === null || endsAt === null || endsAt <= openedAt) {
    return null;
  }
  return { openedAt, endsAt };
}

export function filterEligibleEvent(
  event: Event,
): EligibleEvent | null {
  if (
    event.state.active !== true ||
    event.state.closed === true ||
    event.state.archived === true
  ) {
    return null;
  }

  const resultCount = normalizeEventResultCount(event);
  if (resultCount === null) {
    return null;
  }

  return {
    eventId: String(event.id),
    eventSlug:
      typeof (event as Event & { slug?: unknown }).slug === "string"
        ? (event as Event & { slug: string }).slug
        : null,
    title: event.title ?? "Untitled event",
    category: event.category ?? "Other",
    resultCount,
    isNegativeRisk: event.trading.negRisk === true,
  };
}

function marketIsOpen(market: Market): boolean {
  return (
    market.state.active === true &&
    market.state.closed !== true &&
    market.state.archived !== true &&
    market.state.acceptingOrders === true &&
    market.state.enableOrderBook === true
  );
}

function marketFeeParameters(
  market: Market,
): { feesEnabled: boolean; feeRateMicros: number; feeExponent: number } | null {
  if (market.trading.feesEnabled !== true) {
    return { feesEnabled: false, feeRateMicros: 0, feeExponent: 1 };
  }
  const rate = Number(market.trading.feeSchedule?.rate);
  const exponent = Number(market.trading.feeSchedule?.exponent);
  if (
    !Number.isFinite(rate) ||
    rate < 0 ||
    !Number.isSafeInteger(exponent) ||
    exponent < 0
  ) {
    return null;
  }
  return {
    feesEnabled: true,
    feeRateMicros: Math.round(rate * 1_000_000),
    feeExponent: exponent,
  };
}

export function extractEligibleTokens(
  event: Event,
  eligibleEvent: EligibleEvent,
  config: AppConfig,
  now: Date,
): MarketToken[] {
  const tokens: MarketToken[] = [];

  for (const market of event.markets) {
    if (!marketIsOpen(market) || market.conditionId === null) {
      continue;
    }
    const schedule = resolveMarketSchedule(event, market);
    if (schedule === null) {
      continue;
    }
    const durationMs = schedule.endsAt - schedule.openedAt;
    const durationDays = durationMs / DAY_MS;
    const nowMs = now.getTime();
    if (
      nowMs < schedule.openedAt ||
      nowMs >= schedule.endsAt ||
      durationMs < DAY_MS ||
      durationDays > config.maxMarketDurationDays
    ) {
      continue;
    }
    const progressPercent =
      ((nowMs - schedule.openedAt) / durationMs) * 100;
    const feeParameters = marketFeeParameters(market);
    if (feeParameters === null) {
      continue;
    }

    const gameStartsAt = market.sports.gameStartTime ?? event.schedule.startTime ?? null;
    const gameStartMs = parseTimestamp(gameStartsAt);
    if (gameStartMs !== null && now.getTime() >= gameStartMs) {
      continue;
    }

    const base = {
      eventId: eligibleEvent.eventId,
      eventSlug: eligibleEvent.eventSlug,
      eventTitle: eligibleEvent.title,
      category: eligibleEvent.category,
      resultCount: eligibleEvent.resultCount,
      isNegativeRisk: eligibleEvent.isNegativeRisk,
      marketId: String(market.id),
      conditionId: String(market.conditionId),
      marketQuestion: market.question ?? "Untitled market",
      openedAt: new Date(schedule.openedAt).toISOString(),
      endsAt: new Date(schedule.endsAt).toISOString(),
      durationDays,
      progressPercent,
      gameStartsAt,
      ...feeParameters,
    } as const;

    if (market.outcomes.yes.tokenId !== null) {
      tokens.push({
        ...base,
        direction: "YES",
        tokenId: String(market.outcomes.yes.tokenId),
      });
    }

    if (market.outcomes.no.tokenId !== null) {
      tokens.push({
        ...base,
        direction: "NO",
        tokenId: String(market.outcomes.no.tokenId),
      });
    }
  }

  return tokens;
}
