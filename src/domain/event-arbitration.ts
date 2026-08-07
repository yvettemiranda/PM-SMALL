import type { CandidateSortDirection, FakBuyPreview } from "./trading-strategy.js";
import type { TradeCandidate } from "./types.js";

export type EventArbitrationCandidate = {
  candidate: TradeCandidate;
  preview: FakBuyPreview;
};

export type EventArbitrationResult = {
  eventId: string;
  winnerTokenId: string;
  winner: EventArbitrationCandidate;
};

export function arbitrateEvent(
  opportunities: readonly EventArbitrationCandidate[],
  lifecycleDirection: CandidateSortDirection,
): EventArbitrationResult | null {
  const executable = opportunities.filter(
    ({ preview }) =>
      preview.plan.spentMicros > 0 &&
      preview.plan.netFillSizeMicros > 0 &&
      preview.cycleBudgetMicros > 0,
  );
  if (executable.length === 0) {
    return null;
  }
  const eventId = executable[0]?.candidate.eventId;
  if (
    eventId === undefined ||
    executable.some(({ candidate }) => candidate.eventId !== eventId)
  ) {
    throw new Error("Event arbitration candidates must belong to the same event");
  }

  const winner = [...executable].sort((left, right) =>
    compareOpportunity(left, right, lifecycleDirection),
  )[0];
  if (winner === undefined) {
    return null;
  }
  return {
    eventId,
    winnerTokenId: winner.candidate.tokenId,
    winner,
  };
}

function compareOpportunity(
  left: EventArbitrationCandidate,
  right: EventArbitrationCandidate,
  lifecycleDirection: CandidateSortDirection,
): number {
  const tiers = [
    compareRatioDescending(
      left.preview.bestBidMicros,
      left.preview.terminalTargetPriceMicros,
      right.preview.bestBidMicros,
      right.preview.terminalTargetPriceMicros,
    ),
    compareRatioDescending(
      left.preview.exitBidCoverageSizeMicros,
      left.preview.exitBidCoveragePositionSizeMicros,
      right.preview.exitBidCoverageSizeMicros,
      right.preview.exitBidCoveragePositionSizeMicros,
    ),
    compareRatioDescending(
      left.preview.plan.spentMicros,
      left.preview.cycleBudgetMicros,
      right.preview.plan.spentMicros,
      right.preview.cycleBudgetMicros,
    ),
    compareRatioDescending(
      left.preview.bestBidMicros,
      left.preview.bestAskMicros,
      right.preview.bestBidMicros,
      right.preview.bestAskMicros,
    ),
    compareRatioDescending(
      left.preview.targetNetProfitMicros,
      left.preview.plan.spentMicros,
      right.preview.targetNetProfitMicros,
      right.preview.plan.spentMicros,
    ),
  ];
  for (const comparison of tiers) {
    if (comparison !== 0) return comparison;
  }

  const progress =
    lifecycleDirection === "ASC"
      ? left.candidate.progressPercent - right.candidate.progressPercent
      : right.candidate.progressPercent - left.candidate.progressPercent;
  if (progress !== 0) return progress;

  return (
    left.candidate.marketId.localeCompare(right.candidate.marketId) ||
    left.candidate.direction.localeCompare(right.candidate.direction) ||
    left.candidate.tokenId.localeCompare(right.candidate.tokenId)
  );
}

function compareRatioDescending(
  leftNumerator: number,
  leftDenominator: number,
  rightNumerator: number,
  rightDenominator: number,
): number {
  if (leftDenominator <= 0 || rightDenominator <= 0) {
    throw new Error("Event arbitration ratio denominator must be positive");
  }
  const left = BigInt(leftNumerator) * BigInt(rightDenominator);
  const right = BigInt(rightNumerator) * BigInt(leftDenominator);
  return left === right ? 0 : left > right ? -1 : 1;
}
