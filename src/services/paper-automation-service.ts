import type { AppConfig } from "../config.js";
import type { TradingExecutionAdapter } from "../domain/execution.js";
import type { TradeCandidate } from "../domain/types.js";
import type { MarketEligibilitySettings } from "../domain/market-eligibility.js";
import type { CandidateSortDirection } from "../domain/trading-strategy.js";
import type {
  PaperDatabase,
  PaperRecoveryResult,
} from "../infrastructure/db/database.js";
import type { CandidateService } from "./candidate-service.js";
import type { PaperMarketRuntime } from "./market-stream-service.js";
import { TestExecutor } from "../infrastructure/execution/test-executor.js";
import {
  EventOpportunityService,
  type EventOpportunityEvaluation,
  type EventOpportunitySelection,
} from "./event-opportunity-service.js";

export type PaperAutomationStatus = {
  running: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  placedBuyCount: number;
  cancelledFilterBuyCount: number;
  cancelledStartedBuyCount: number;
  cancelledProgressedBuyCount: number;
  eventsEvaluatedCount: number;
  incompleteEventCount: number;
  arbitrationCount: number;
  arbitrationRecomputeCount: number;
  staleArbitrationRejectionCount: number;
  skippedLockedSiblingQuoteCount: number;
  maxObservedResultCount: number;
  recovery: PaperRecoveryResult | null;
};

export interface PaperAutomationRuntime {
  getStatus(): PaperAutomationStatus;
  getEventEvaluations?(): EventOpportunityEvaluation[];
  requestRun(): void;
}

export interface PaperCandidateSelection extends EventOpportunitySelection {
  isCandidateEnabled(candidate: TradeCandidate, now?: Date): boolean;
  reconcileActiveBuys?(now?: Date): number;
  getMaxBuyPriceMicros?(): number;
  getOrderBudgetMicros?(): number;
  getEligibilitySettings?(): MarketEligibilitySettings;
  getCandidateSortDirection?(): CandidateSortDirection;
  getStateVersion?(): string;
  getOrderedCandidates?(
    candidates: readonly TradeCandidate[],
    now?: Date,
  ): TradeCandidate[];
}

export class PaperAutomationService implements PaperAutomationRuntime {
  private started = false;
  private candidateUnsubscribe: (() => void) | null = null;
  private quoteUnsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private fullRunRequested = false;
  private readonly pendingEventIds = new Set<string>();
  private runLoop: Promise<void> | null = null;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private placedBuyCount = 0;
  private cancelledFilterBuyCount = 0;
  private cancelledStartedBuyCount = 0;
  private cancelledProgressedBuyCount = 0;
  private eventsEvaluatedCount = 0;
  private incompleteEventCount = 0;
  private arbitrationCount = 0;
  private arbitrationRecomputeCount = 0;
  private staleArbitrationRejectionCount = 0;
  private skippedLockedSiblingQuoteCount = 0;
  private maxObservedResultCount = 0;
  private recovery: PaperRecoveryResult | null = null;
  private readonly attemptedBuyIntentByEvent = new Map<string, string>();
  private readonly latestEventEvaluationById = new Map<
    string,
    EventOpportunityEvaluation
  >();
  private readonly eventOpportunities: EventOpportunityService;

  public constructor(
    private readonly candidates: CandidateService,
    private readonly database: PaperDatabase,
    private readonly marketStream: PaperMarketRuntime,
    private readonly config: AppConfig,
    private readonly candidateSelection?: PaperCandidateSelection,
    private readonly executor: TradingExecutionAdapter = new TestExecutor(
      database,
    ),
  ) {
    if (!executor.enabled) {
      throw new Error("PaperAutomationService requires an enabled execution adapter");
    }
    this.eventOpportunities = new EventOpportunityService(
      candidates,
      database,
      marketStream,
      config,
      candidateSelection,
    );
  }

  public start(): void {
    if (this.started) {
      return;
    }
    this.recovery = this.database.recoverPaperState();
    this.started = true;
    this.candidateUnsubscribe = this.candidates.subscribe(() =>
      this.requestRun(),
    );
    this.quoteUnsubscribe = this.candidates.subscribeQuotes((tokenId) =>
      this.requestTokenRun(tokenId),
    );
    this.timer = setInterval(
      () => this.requestRun(),
      this.config.paperSchedulerIntervalMs,
    );
    this.timer.unref();
  }

  public async stop(): Promise<void> {
    this.started = false;
    this.candidateUnsubscribe?.();
    this.candidateUnsubscribe = null;
    this.quoteUnsubscribe?.();
    this.quoteUnsubscribe = null;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.runLoop;
  }

  public requestRun(): void {
    if (!this.started) {
      return;
    }
    this.fullRunRequested = true;
    this.scheduleRun();
  }

  private requestTokenRun(tokenId: string): void {
    if (!this.started) {
      return;
    }
    const eventId = this.candidates.getEventIdByTokenId(tokenId);
    if (eventId === null) {
      return;
    }
    const eventLock = this.database.getPaperEventLock(eventId);
    if (
      eventLock?.state === "ACTIVE" &&
      eventLock.activeTokenId !== tokenId
    ) {
      this.skippedLockedSiblingQuoteCount += 1;
      return;
    }
    this.pendingEventIds.add(eventId);
    this.scheduleRun();
  }

  private scheduleRun(): void {
    if (this.runLoop !== null) {
      return;
    }
    this.runLoop = this.drainRuns().finally(() => {
      this.runLoop = null;
      if (this.hasPendingRun() && this.started) {
        this.scheduleRun();
      }
    });
  }

  public getStatus(): PaperAutomationStatus {
    return {
      running: this.started,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      placedBuyCount: this.placedBuyCount,
      cancelledFilterBuyCount: this.cancelledFilterBuyCount,
      cancelledStartedBuyCount: this.cancelledStartedBuyCount,
      cancelledProgressedBuyCount: this.cancelledProgressedBuyCount,
      eventsEvaluatedCount: this.eventsEvaluatedCount,
      incompleteEventCount: this.incompleteEventCount,
      arbitrationCount: this.arbitrationCount,
      arbitrationRecomputeCount: this.arbitrationRecomputeCount,
      staleArbitrationRejectionCount: this.staleArbitrationRejectionCount,
      skippedLockedSiblingQuoteCount: this.skippedLockedSiblingQuoteCount,
      maxObservedResultCount: this.maxObservedResultCount,
      recovery: this.recovery,
    };
  }

  public getEventEvaluations(): EventOpportunityEvaluation[] {
    return [...this.latestEventEvaluationById.values()].sort((left, right) =>
      left.eventId.localeCompare(right.eventId),
    );
  }

  private async drainRuns(): Promise<void> {
    while (this.hasPendingRun() && this.started) {
      const runAll = this.fullRunRequested;
      const eventIds = runAll ? null : new Set(this.pendingEventIds);
      this.fullRunRequested = false;
      this.pendingEventIds.clear();
      this.runOnce(eventIds);
      await Promise.resolve();
    }
  }

  private hasPendingRun(): boolean {
    return this.fullRunRequested || this.pendingEventIds.size > 0;
  }

  private runOnce(eventIds: ReadonlySet<string> | null): void {
    const now = new Date();
    try {
      const cancelledFiltered =
        eventIds === null
          ? (this.candidateSelection?.reconcileActiveBuys?.(now) ?? 0)
          : 0;
      this.cancelledFilterBuyCount += cancelledFiltered;
      const cancelled =
        eventIds === null ? this.database.cancelStartedGameBuys(now) : 0;
      this.cancelledStartedBuyCount += cancelled;
      // Filter reconciliation applies the saved lifecycle threshold to any
      // legacy active buy orders before new FAK executions are considered.
      const cancelledProgressed = 0;
      this.cancelledProgressedBuyCount += cancelledProgressed;
      let placedThisRun = 0;

      const requestedEventIds = eventIds === null
        ? this.candidates.getEventIds()
        : [...eventIds].sort((left, right) => left.localeCompare(right));
      if (eventIds === null) {
        const currentEventIds = new Set(requestedEventIds);
        for (const eventId of this.latestEventEvaluationById.keys()) {
          if (!currentEventIds.has(eventId)) {
            this.latestEventEvaluationById.delete(eventId);
          }
        }
      }
      const evaluations = requestedEventIds.map((eventId) =>
        this.evaluateEvent(eventId, now),
      );
      const direction =
        this.candidateSelection?.getCandidateSortDirection?.() ?? "ASC";
      evaluations.sort((left, right) =>
        compareEventEvaluations(left, right, direction),
      );

      if (this.database.getStrategyState().status === "RUNNING") {
        for (const evaluation of evaluations) {
          if (evaluation.status !== "READY" || evaluation.winner === null) {
            continue;
          }
          const rechecked = this.evaluateEvent(evaluation.eventId, new Date());
          const changed =
            rechecked.snapshotVersion !== evaluation.snapshotVersion ||
            rechecked.winner?.candidate.tokenId !==
              evaluation.winner.candidate.tokenId;
          if (changed) {
            this.staleArbitrationRejectionCount += 1;
            this.arbitrationRecomputeCount += 1;
          }
          const current = rechecked;
          if (current.status !== "READY" || current.winner === null) {
            continue;
          }
          const candidate = current.winner.candidate;
          const buyIntentKey = `${candidate.tokenId}:${current.snapshotVersion}`;
          if (
            this.attemptedBuyIntentByEvent.get(current.eventId) === buyIntentKey
          ) {
            continue;
          }
          this.attemptedBuyIntentByEvent.set(current.eventId, buyIntentKey);
          try {
            const execution = this.executor.executeBuy(current.winner.intent);
            if (execution.order !== null) {
              this.marketStream.consumeTestBuyLiquidity?.(
                candidate.tokenId,
                execution.consumedAsks,
              );
              this.marketStream.executeTargetSells?.(candidate.tokenId);
              this.placedBuyCount += 1;
              placedThisRun += 1;
            }
          } catch (error) {
            if (!isExpectedPlacementRejection(error)) {
              this.attemptedBuyIntentByEvent.delete(current.eventId);
              throw error;
            }
          }
        }
      }

      if (
        cancelledFiltered > 0 ||
        cancelled > 0 ||
        cancelledProgressed > 0 ||
        placedThisRun > 0
      ) {
        this.marketStream.refreshSubscriptions();
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.lastRunAt = new Date().toISOString();
    }
  }

  private evaluateEvent(eventId: string, now: Date): EventOpportunityEvaluation {
    const evaluation = this.eventOpportunities.evaluateEvent(eventId, now);
    this.latestEventEvaluationById.set(eventId, evaluation);
    this.eventsEvaluatedCount += 1;
    if (evaluation.status === "INCOMPLETE") {
      this.incompleteEventCount += 1;
    }
    if (evaluation.arbitrationPerformed) {
      this.arbitrationCount += 1;
    }
    this.maxObservedResultCount = Math.max(
      this.maxObservedResultCount,
      evaluation.maxResultCount,
    );
    return evaluation;
  }
}

function compareEventEvaluations(
  left: EventOpportunityEvaluation,
  right: EventOpportunityEvaluation,
  direction: CandidateSortDirection,
): number {
  const leftProgress = left.winner?.candidate.progressPercent ??
    (direction === "ASC" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
  const rightProgress = right.winner?.candidate.progressPercent ??
    (direction === "ASC" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
  const progressComparison =
    direction === "ASC"
      ? leftProgress - rightProgress
      : rightProgress - leftProgress;
  return progressComparison || left.eventId.localeCompare(right.eventId);
}

function isExpectedPlacementRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /active paper buy|first sell|budget would be exceeded|Insufficient paper cash|game has started|Event is locked|legacy conflicting|unlocked paper position/.test(
    message,
  );
}
