import type { AppConfig } from "../config.js";
import { arbitrateEvent } from "../domain/event-arbitration.js";
import type { ImmediateBuyIntent } from "../domain/execution.js";
import {
  bestAskLevel,
  bestBidLevel,
  calculateFixedSellPriceMicros,
  type TargetSellPriceSettings,
} from "../domain/price.js";
import {
  staticMarketEligibilityRejectionReason,
  type MarketEligibilitySettings,
} from "../domain/market-eligibility.js";
import type { CandidateSortDirection, FakBuyPreview } from "../domain/trading-strategy.js";
import type { TokenOrderBook, TradeCandidate } from "../domain/types.js";
import type {
  PaperDatabase,
  PaperEventLock,
} from "../infrastructure/db/database.js";
import type { CandidateService } from "./candidate-service.js";
import type { PaperMarketRuntime } from "./market-stream-service.js";

export interface EventOpportunitySelection {
  isCandidateEnabled?(candidate: TradeCandidate, now?: Date): boolean;
  candidateMatchesStaticFilters?(candidate: TradeCandidate, now?: Date): boolean;
  getMaxBuyPriceMicros?(): number;
  getOrderBudgetMicros?(): number;
  getTargetSellPriceSettings?(): TargetSellPriceSettings;
  getEligibilitySettings?(): MarketEligibilitySettings;
  getCandidateSortDirection?(): CandidateSortDirection;
  getStateVersion?(): string;
}

export type EventOpportunity = {
  candidate: TradeCandidate;
  book: TokenOrderBook;
  preview: FakBuyPreview;
  eventStateVersion: string;
  bookRevision: number | null;
  intent: ImmediateBuyIntent;
};

export type EventOpportunityStatus =
  | "READY"
  | "INCOMPLETE"
  | "NO_WINNER"
  | "LEGACY_CONFLICT";

export type EventOpportunityEvaluation = {
  eventId: string;
  status: EventOpportunityStatus;
  locked: boolean;
  lock: PaperEventLock | null;
  participantCount: number;
  eligibleOpportunityCount: number;
  incompleteTokenIds: string[];
  opportunities: EventOpportunity[];
  winner: EventOpportunity | null;
  arbitrationPerformed: boolean;
  snapshotVersion: string;
  maxResultCount: number;
};

export class EventOpportunityService {
  public constructor(
    private readonly candidates: CandidateService,
    private readonly database: PaperDatabase,
    private readonly marketStream: PaperMarketRuntime,
    private readonly config: AppConfig,
    private readonly selection?: EventOpportunitySelection,
  ) {}

  public evaluateEvent(
    eventId: string,
    now: Date = new Date(),
  ): EventOpportunityEvaluation {
    const eventCandidates = this.candidates.getCandidatesByEventId(eventId);
    const lock = this.database.getPaperEventLock(eventId);
    const maxResultCount = eventCandidates.reduce(
      (maximum, candidate) => Math.max(maximum, candidate.resultCount ?? 0),
      0,
    );
    const base = {
      eventId,
      locked: lock !== null,
      lock,
      incompleteTokenIds: [] as string[],
      opportunities: [] as EventOpportunity[],
      winner: null,
      arbitrationPerformed: false,
      maxResultCount,
    };
    if (lock?.state === "LEGACY_CONFLICT") {
      return {
        ...base,
        status: "LEGACY_CONFLICT",
        participantCount: 0,
        eligibleOpportunityCount: 0,
        snapshotVersion: this.snapshotVersion(lock, [], []),
      };
    }

    const eligibility = this.selection?.getEligibilitySettings?.() ??
      this.defaultEligibilitySettings();
    const staticCandidates = eventCandidates.filter(
      (candidate) =>
        candidateIsCurrent(candidate, now) &&
        (this.selection?.candidateMatchesStaticFilters?.(candidate, now) ??
          staticMarketEligibilityRejectionReason(candidate, eligibility, now) ===
            null),
    );
    const participants =
      lock?.state === "ACTIVE"
        ? staticCandidates.filter(
            (candidate) => candidate.tokenId === lock.activeTokenId,
          )
        : staticCandidates;
    if (participants.length === 0) {
      return {
        ...base,
        status: "NO_WINNER",
        participantCount: 0,
        eligibleOpportunityCount: 0,
        snapshotVersion: this.snapshotVersion(lock, [], []),
      };
    }

    const books = new Map<string, TokenOrderBook>();
    const incompleteTokenIds: string[] = [];
    for (const candidate of participants) {
      if (!this.marketStream.isTokenReady(candidate.tokenId)) {
        incompleteTokenIds.push(candidate.tokenId);
        continue;
      }
      const book = this.marketStream.getOrderBook?.(candidate) ?? null;
      if (book === null) {
        incompleteTokenIds.push(candidate.tokenId);
        continue;
      }
      books.set(candidate.tokenId, book);
    }
    if (incompleteTokenIds.length > 0) {
      return {
        ...base,
        status: "INCOMPLETE",
        participantCount: participants.length,
        eligibleOpportunityCount: 0,
        incompleteTokenIds: incompleteTokenIds.sort((left, right) =>
          left.localeCompare(right),
        ),
        snapshotVersion: this.snapshotVersion(lock, participants, []),
      };
    }

    const maxPriceMicros =
      this.selection?.getMaxBuyPriceMicros?.() ?? this.config.maxBuyPriceMicros;
    const orderBudgetMicros =
      this.selection?.getOrderBudgetMicros?.() ?? this.config.orderBudgetMicros;
    const targetSellPriceSettings =
      this.selection?.getTargetSellPriceSettings?.() ?? {
        increaseMicros: this.config.targetSellPriceIncreaseMicros,
        multiplierMicros: this.config.targetSellPriceMultiplierMicros,
      };
    const opportunities: EventOpportunity[] = [];
    for (const candidate of participants) {
      const book = books.get(candidate.tokenId);
      if (book === undefined) continue;
      const currentBestAskMicros = bestAskLevel(book.asks)?.priceMicros ?? null;
      const currentCandidate: TradeCandidate = {
        ...candidate,
        bookReady: true,
        bestBidMicros: bestBidLevel(book.bids)?.priceMicros ?? null,
        bestAskMicros: currentBestAskMicros,
        executableBuyPriceMicros: currentBestAskMicros ?? 0,
        makerBuyPriceMicros: currentBestAskMicros ?? 0,
        fixedSellPriceMicros:
          currentBestAskMicros === null
            ? 0
            : calculateFixedSellPriceMicros(
                currentBestAskMicros,
                book.tickSizeMicros,
                targetSellPriceSettings,
              ),
        minOrderSizeMicros: book.minOrderSizeMicros,
        tickSizeMicros: book.tickSizeMicros,
      };
      if (this.selection?.isCandidateEnabled?.(currentCandidate, now) === false) {
        continue;
      }
      const intent: ImmediateBuyIntent = {
        candidate: currentCandidate,
        book,
        maxPriceMicros,
        orderBudgetMicros,
        feeRateMicros: candidate.feeRateMicros,
        feeExponent: candidate.feeExponent,
        targetSellPriceSettings,
        eligibility,
      };
      const preview = this.database.previewTestFakBuy(intent);
      if (preview.outcome !== "READY" || preview.preview === null) {
        continue;
      }
      opportunities.push({
        candidate: currentCandidate,
        book,
        preview: preview.preview,
        eventStateVersion: preview.eventStateVersion,
        bookRevision:
          this.marketStream.getOrderBookRevision?.(candidate.tokenId) ?? null,
        intent,
      });
    }

    let winner: EventOpportunity | null = null;
    let arbitrationPerformed = false;
    if (lock?.state === "ACTIVE") {
      winner = opportunities.find(
        (opportunity) => opportunity.candidate.tokenId === lock.activeTokenId,
      ) ?? null;
    } else {
      arbitrationPerformed = opportunities.length > 0;
      const arbitration = arbitrateEvent(
        opportunities,
        this.selection?.getCandidateSortDirection?.() ?? "ASC",
      );
      winner = arbitration === null
        ? null
        : opportunities.find(
            (opportunity) =>
              opportunity.candidate.tokenId === arbitration.winnerTokenId,
          ) ?? null;
    }
    return {
      ...base,
      status: winner === null ? "NO_WINNER" : "READY",
      participantCount: participants.length,
      eligibleOpportunityCount: opportunities.length,
      opportunities,
      winner,
      arbitrationPerformed,
      snapshotVersion: this.snapshotVersion(lock, participants, opportunities),
    };
  }

  private snapshotVersion(
    lock: PaperEventLock | null,
    participants: readonly TradeCandidate[],
    opportunities: readonly EventOpportunity[],
  ): string {
    const opportunityByToken = new Map(
      opportunities.map((opportunity) => [
        opportunity.candidate.tokenId,
        opportunity,
      ]),
    );
    return JSON.stringify({
      selection:
        this.selection?.getStateVersion?.() ??
        this.defaultEligibilitySettings(),
      lock,
      participants: [...participants]
        .sort((left, right) => left.tokenId.localeCompare(right.tokenId))
        .map((candidate) => {
          const opportunity = opportunityByToken.get(candidate.tokenId);
          return {
            tokenId: candidate.tokenId,
            bookRevision:
              this.marketStream.getOrderBookRevision?.(candidate.tokenId) ?? null,
            bookVersion: opportunity?.book.bookVersion ?? null,
            eventStateVersion: opportunity?.eventStateVersion ?? null,
          };
        }),
    });
  }

  private defaultEligibilitySettings(): MarketEligibilitySettings {
    return {
      marketTypes: ["BINARY", "TERNARY"],
      allCategories: true,
      selectedCategoryIds: [],
      minBuyPriceMicros: this.config.minBuyPriceMicros,
      maxBuyPriceMicros: this.config.maxBuyPriceMicros,
      minBidAskRatioPercent: this.config.minBidAskRatioPercent,
      minMarketDurationDays: this.config.minMarketDurationDays,
      maxMarketDurationDays: this.config.maxMarketDurationDays,
      maxMarketProgressPercent: this.config.maxMarketProgressPercent,
      orderBudgetMicros: this.config.orderBudgetMicros,
    };
  }
}

function candidateIsCurrent(candidate: TradeCandidate, now: Date): boolean {
  const openedAt = Date.parse(candidate.openedAt);
  const endsAt = Date.parse(candidate.endsAt);
  const gameStartsAt =
    candidate.gameStartsAt === null ? null : Date.parse(candidate.gameStartsAt);
  return (
    Number.isFinite(openedAt) &&
    Number.isFinite(endsAt) &&
    now.getTime() >= openedAt &&
    now.getTime() < endsAt &&
    (gameStartsAt === null ||
      (Number.isFinite(gameStartsAt) && now.getTime() < gameStartsAt))
  );
}
