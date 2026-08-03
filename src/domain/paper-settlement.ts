export type PaperResolutionOutcome = {
  tokenId: string | null;
  label: string;
  priceMicros: number | null;
};

export type PaperMarketResolution = {
  marketId: string;
  conditionId: string | null;
  closed: boolean;
  resolutionStatus: string | null;
  outcomes: PaperResolutionOutcome[];
};

export type PaperSettlementPayout = {
  tokenId: string;
  priceMicros: number;
};

export type PaperSettlementDecision =
  | {
      kind: "READY";
      resolutionStatus: string;
      winningTokenId: string | null;
      winningOutcome: string;
      payouts?: PaperSettlementPayout[];
    }
  | {
      kind: "WAITING";
      reason: string;
      resolutionStatus: string | null;
    };

export class PaperResolutionValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PaperResolutionValidationError";
  }
}

const FINAL_RESOLUTION_STATUSES = new Set(["resolved", "settled"]);
const ONE_TOKEN_PRICE_MICROS = 1_000_000;

export function classifyPaperMarketResolution(
  snapshot: PaperMarketResolution,
  expectedConditionId: string,
  expectedMarketId?: string,
): PaperSettlementDecision {
  if (expectedMarketId !== undefined && snapshot.marketId !== expectedMarketId) {
    throw new PaperResolutionValidationError(
      `Market resolution identity does not match the paper position: market=${expectedMarketId}, condition=${expectedConditionId}`,
    );
  }

  if (snapshot.conditionId === null || snapshot.conditionId.trim().length === 0) {
    return {
      kind: "WAITING",
      reason: "CONDITION_ID_MISSING",
      resolutionStatus: normalizeResolutionStatus(snapshot.resolutionStatus),
    };
  }

  if (
    snapshot.conditionId !== expectedConditionId
  ) {
    throw new PaperResolutionValidationError(
      `Market resolution identity does not match the paper position: market=${snapshot.marketId}, condition=${expectedConditionId}`,
    );
  }

  const resolutionStatus = normalizeResolutionStatus(snapshot.resolutionStatus);
  if (!snapshot.closed) {
    return {
      kind: "WAITING",
      reason: "MARKET_NOT_CLOSED",
      resolutionStatus,
    };
  }

  if (resolutionStatus === null || !FINAL_RESOLUTION_STATUSES.has(resolutionStatus)) {
    return {
      kind: "WAITING",
      reason: "RESOLUTION_NOT_FINAL",
      resolutionStatus,
    };
  }

  if (snapshot.outcomes.length !== 2) {
    return {
      kind: "WAITING",
      reason: "UNSUPPORTED_OUTCOME_COUNT",
      resolutionStatus,
    };
  }

  const winning = snapshot.outcomes.filter(
    (outcome) => outcome.priceMicros === ONE_TOKEN_PRICE_MICROS,
  );
  const losing = snapshot.outcomes.filter((outcome) => outcome.priceMicros === 0);

  if (
    snapshot.outcomes.every((outcome) => outcome.priceMicros === 500_000) &&
    snapshot.outcomes.every(
      (outcome) => outcome.tokenId !== null && outcome.tokenId.trim().length > 0,
    )
  ) {
    return {
      kind: "READY",
      resolutionStatus,
      winningTokenId: null,
      winningOutcome: "50/50",
      payouts: snapshot.outcomes.map((outcome) => ({
        tokenId: outcome.tokenId as string,
        priceMicros: 500_000,
      })),
    };
  }

  if (
    winning.length !== 1 ||
    losing.length !== 1 ||
    winning[0]?.tokenId === null ||
    losing[0]?.tokenId === null ||
    winning[0]?.tokenId === losing[0]?.tokenId
  ) {
    return {
      kind: "WAITING",
      reason: "OUTCOME_PRICES_NOT_FINAL",
      resolutionStatus,
    };
  }

  const winningOutcome = winning[0];
  if (winningOutcome?.tokenId === null || winningOutcome?.tokenId === undefined) {
    return {
      kind: "WAITING",
      reason: "WINNING_TOKEN_MISSING",
      resolutionStatus,
    };
  }

  return {
    kind: "READY",
    resolutionStatus,
    winningTokenId: winningOutcome.tokenId,
    winningOutcome: winningOutcome.label,
  };
}

function normalizeResolutionStatus(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length === 0 ? null : normalized;
}
