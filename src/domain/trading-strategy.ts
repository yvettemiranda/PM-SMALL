import {
  bestAskLevel,
  bestBidLevel,
  calculateFixedSellPriceMicros,
  calculateOrderCostMicros,
  calculateOrderSizeMicros,
  DECIMAL_SCALE,
} from "./price.js";
import type { BookLevel, TradeCandidate } from "./types.js";

export const MAX_TAKER_FEE_EXPONENT = 10;

export type CandidateSortDirection = "ASC" | "DESC";

export type TakerFeeInput = {
  sizeMicros: number;
  priceMicros: number;
  feeRateMicros: number;
  feeExponent: number;
};

export type FakBuyFill = {
  priceMicros: number;
  grossSizeMicros: number;
  netSizeMicros: number;
  notionalMicros: number;
  feeMicros: number;
};

export type FakBuyPlan = {
  fills: FakBuyFill[];
  grossFillSizeMicros: number;
  netFillSizeMicros: number;
  spentMicros: number;
  feeMicros: number;
  fullySpent: boolean;
};

export type FakBuyPreviewFill = FakBuyFill & {
  targetPriceMicros: number;
  exitableBidDepthMicros: number;
  targetGrossProceedsMicros: number;
  targetFeeMicros: number;
  targetNetProceedsMicros: number;
};

export type FakBuyPreview = {
  plan: FakBuyPlan;
  fills: FakBuyPreviewFill[];
  bestAskMicros: number;
  bestBidMicros: number;
  terminalTargetPriceMicros: number;
  exitBidCoverageSizeMicros: number;
  exitBidCoveragePositionSizeMicros: number;
  targetNetProceedsMicros: number;
  targetNetProfitMicros: number;
  cycleBudgetMicros: number;
};

export type FakSellFill = {
  priceMicros: number;
  sizeMicros: number;
  grossProceedsMicros: number;
  feeMicros: number;
  netProceedsMicros: number;
};

export type FakSellPlan = {
  fills: FakSellFill[];
  filledSizeMicros: number;
  grossProceedsMicros: number;
  feeMicros: number;
  netProceedsMicros: number;
  fullyFilled: boolean;
};

export function calculateTakerFeeMicros(input: TakerFeeInput): number {
  assertNonNegativeInteger(input.sizeMicros, "trade size");
  assertNonNegativeInteger(input.priceMicros, "trade price");
  assertNonNegativeInteger(input.feeRateMicros, "fee rate");
  assertNonNegativeInteger(input.feeExponent, "fee exponent");
  if (input.feeExponent > MAX_TAKER_FEE_EXPONENT) {
    throw new Error(
      `fee exponent must not exceed ${MAX_TAKER_FEE_EXPONENT}`,
    );
  }
  if (
    input.sizeMicros === 0 ||
    input.feeRateMicros === 0 ||
    input.priceMicros === 0 ||
    input.priceMicros >= DECIMAL_SCALE
  ) {
    return 0;
  }

  const price = BigInt(input.priceMicros);
  const scale = BigInt(DECIMAL_SCALE);
  const centeredProbability = (price * (scale - price)) / scale;
  let curve = scale;
  for (let index = 0; index < input.feeExponent; index += 1) {
    curve = (curve * centeredProbability) / scale;
  }

  const numerator =
    BigInt(input.sizeMicros) * BigInt(input.feeRateMicros) * curve;
  return Number(ceilDivide(numerator, scale * scale));
}

export function planFakBuy(input: {
  asks: readonly BookLevel[];
  maxPriceMicros: number;
  maxSpendMicros: number;
  minOrderSizeMicros: number;
  feeRateMicros: number;
  feeExponent: number;
}): FakBuyPlan | null {
  if (input.maxSpendMicros <= 0 || input.maxPriceMicros <= 0) {
    return null;
  }
  const asks = input.asks
    .filter(
      (level) =>
        level.priceMicros > 0 &&
        level.priceMicros <= input.maxPriceMicros &&
        level.sizeMicros > 0,
    )
    .sort((left, right) => left.priceMicros - right.priceMicros);
  const bestAsk = asks[0];
  if (
    bestAsk === undefined ||
    calculateOrderSizeMicros(input.maxSpendMicros, bestAsk.priceMicros) <
      input.minOrderSizeMicros
  ) {
    return null;
  }

  const fills: FakBuyFill[] = [];
  let remainingSpendMicros = input.maxSpendMicros;
  for (const level of asks) {
    const affordableSizeMicros = calculateOrderSizeMicros(
      remainingSpendMicros,
      level.priceMicros,
    );
    const grossSizeMicros = Math.min(
      level.sizeMicros,
      affordableSizeMicros,
    );
    if (grossSizeMicros <= 0) {
      continue;
    }
    const notionalMicros = calculateOrderCostMicros(
      level.priceMicros,
      grossSizeMicros,
    );
    if (notionalMicros <= 0 || notionalMicros > remainingSpendMicros) {
      continue;
    }
    const feeMicros = calculateTakerFeeMicros({
      sizeMicros: grossSizeMicros,
      priceMicros: level.priceMicros,
      feeRateMicros: input.feeRateMicros,
      feeExponent: input.feeExponent,
    });
    const feeSizeMicros =
      feeMicros === 0
        ? 0
        : Number(
            ceilDivide(
              BigInt(feeMicros) * BigInt(DECIMAL_SCALE),
              BigInt(level.priceMicros),
            ),
          );
    const netSizeMicros = Math.max(0, grossSizeMicros - feeSizeMicros);
    if (netSizeMicros === 0) {
      continue;
    }
    fills.push({
      priceMicros: level.priceMicros,
      grossSizeMicros,
      netSizeMicros,
      notionalMicros,
      feeMicros,
    });
    remainingSpendMicros -= notionalMicros;
    if (remainingSpendMicros <= 0) {
      break;
    }
  }

  if (fills.length === 0) {
    return null;
  }
  return {
    fills,
    grossFillSizeMicros: sum(fills, (fill) => fill.grossSizeMicros),
    netFillSizeMicros: sum(fills, (fill) => fill.netSizeMicros),
    spentMicros: sum(fills, (fill) => fill.notionalMicros),
    feeMicros: sum(fills, (fill) => fill.feeMicros),
    fullySpent: remainingSpendMicros === 0,
  };
}

export function previewFakBuy(input: {
  asks: readonly BookLevel[];
  bids: readonly BookLevel[];
  maxPriceMicros: number;
  maxSpendMicros: number;
  cycleBudgetMicros: number;
  minOrderSizeMicros: number;
  tickSizeMicros: number;
  feeRateMicros: number;
  feeExponent: number;
}): FakBuyPreview | null {
  if (!Number.isSafeInteger(input.cycleBudgetMicros) || input.cycleBudgetMicros <= 0) {
    return null;
  }
  const plan = planFakBuy(input);
  const bestAsk = bestAskLevel(input.asks);
  const bestBid = bestBidLevel(input.bids);
  if (plan === null || bestAsk === null || bestBid === null) {
    return null;
  }

  const fills = plan.fills.map((fill): FakBuyPreviewFill => {
    const targetPriceMicros = calculateFixedSellPriceMicros(
      fill.priceMicros,
      input.tickSizeMicros,
    );
    const exitableBidDepthMicros = input.bids
      .filter(
        (level) =>
          Number.isSafeInteger(level.priceMicros) &&
          level.priceMicros >= targetPriceMicros &&
          level.priceMicros < DECIMAL_SCALE &&
          Number.isSafeInteger(level.sizeMicros) &&
          level.sizeMicros > 0,
      )
      .reduce((total, level) => total + level.sizeMicros, 0);
    const targetGrossProceedsMicros = calculateOrderCostMicros(
      targetPriceMicros,
      fill.netSizeMicros,
    );
    const targetFeeMicros = calculateTakerFeeMicros({
      sizeMicros: fill.netSizeMicros,
      priceMicros: targetPriceMicros,
      feeRateMicros: input.feeRateMicros,
      feeExponent: input.feeExponent,
    });
    return {
      ...fill,
      targetPriceMicros,
      exitableBidDepthMicros,
      targetGrossProceedsMicros,
      targetFeeMicros,
      targetNetProceedsMicros: Math.max(
        0,
        targetGrossProceedsMicros - targetFeeMicros,
      ),
    };
  });
  const targetNetProceedsMicros = sum(
    fills,
    (fill) => fill.targetNetProceedsMicros,
  );
  const exitBidCoverageSizeMicros = Math.min(
    plan.netFillSizeMicros,
    sum(fills, (fill) =>
      Math.min(fill.exitableBidDepthMicros, fill.netSizeMicros),
    ),
  );

  return {
    plan,
    fills,
    bestAskMicros: bestAsk.priceMicros,
    bestBidMicros: bestBid.priceMicros,
    terminalTargetPriceMicros: Math.max(
      ...fills.map((fill) => fill.targetPriceMicros),
    ),
    exitBidCoverageSizeMicros,
    exitBidCoveragePositionSizeMicros: plan.netFillSizeMicros,
    targetNetProceedsMicros,
    targetNetProfitMicros: targetNetProceedsMicros - plan.spentMicros,
    cycleBudgetMicros: input.cycleBudgetMicros,
  };
}

export function planFakSell(input: {
  bids: readonly BookLevel[];
  minPriceMicros: number;
  availableSizeMicros: number;
  minOrderSizeMicros: number;
  feeRateMicros: number;
  feeExponent: number;
}): FakSellPlan | null {
  if (
    input.availableSizeMicros < input.minOrderSizeMicros ||
    input.minPriceMicros <= 0
  ) {
    return null;
  }
  const bids = input.bids
    .filter(
      (level) =>
        Number.isSafeInteger(level.priceMicros) &&
        level.priceMicros >= input.minPriceMicros &&
        level.priceMicros < DECIMAL_SCALE &&
        Number.isSafeInteger(level.sizeMicros) &&
        level.sizeMicros > 0,
    )
    .sort((left, right) => right.priceMicros - left.priceMicros);
  const fills: FakSellFill[] = [];
  let remainingSizeMicros = input.availableSizeMicros;
  for (const level of bids) {
    const sizeMicros = Math.min(level.sizeMicros, remainingSizeMicros);
    if (sizeMicros <= 0) {
      continue;
    }
    const grossProceedsMicros = calculateOrderCostMicros(
      level.priceMicros,
      sizeMicros,
    );
    const feeMicros = calculateTakerFeeMicros({
      sizeMicros,
      priceMicros: level.priceMicros,
      feeRateMicros: input.feeRateMicros,
      feeExponent: input.feeExponent,
    });
    fills.push({
      priceMicros: level.priceMicros,
      sizeMicros,
      grossProceedsMicros,
      feeMicros,
      netProceedsMicros: Math.max(0, grossProceedsMicros - feeMicros),
    });
    remainingSizeMicros -= sizeMicros;
    if (remainingSizeMicros === 0) {
      break;
    }
  }

  if (fills.length === 0) {
    return null;
  }
  return {
    fills,
    filledSizeMicros: sum(fills, (fill) => fill.sizeMicros),
    grossProceedsMicros: sum(fills, (fill) => fill.grossProceedsMicros),
    feeMicros: sum(fills, (fill) => fill.feeMicros),
    netProceedsMicros: sum(fills, (fill) => fill.netProceedsMicros),
    fullyFilled: remainingSizeMicros === 0,
  };
}

export function sortTradeCandidates(
  candidates: readonly TradeCandidate[],
  direction: CandidateSortDirection,
): TradeCandidate[] {
  const multiplier = direction === "ASC" ? 1 : -1;
  return [...candidates].sort((left, right) => {
    const progress =
      (left.progressPercent - right.progressPercent) * multiplier;
    if (progress !== 0) {
      return progress;
    }
    return (
      left.eventId.localeCompare(right.eventId) ||
      left.marketId.localeCompare(right.marketId) ||
      left.direction.localeCompare(right.direction) ||
      left.tokenId.localeCompare(right.tokenId)
    );
  });
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function sum<T>(values: readonly T[], select: (value: T) => number): number {
  return values.reduce((total, value) => total + select(value), 0);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}
