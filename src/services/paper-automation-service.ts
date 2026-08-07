import type { AppConfig } from "../config.js";
import type { TradingExecutionAdapter } from "../domain/execution.js";
import type { TradeCandidate } from "../domain/types.js";
import type { MarketEligibilitySettings } from "../domain/market-eligibility.js";
import type {
  PaperDatabase,
  PaperRecoveryResult,
} from "../infrastructure/db/database.js";
import type { CandidateService } from "./candidate-service.js";
import type { PaperMarketRuntime } from "./market-stream-service.js";
import { TestExecutor } from "../infrastructure/execution/test-executor.js";

export type PaperAutomationStatus = {
  running: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  placedBuyCount: number;
  cancelledFilterBuyCount: number;
  cancelledStartedBuyCount: number;
  cancelledProgressedBuyCount: number;
  recovery: PaperRecoveryResult | null;
};

export interface PaperAutomationRuntime {
  getStatus(): PaperAutomationStatus;
  requestRun(): void;
}

export interface PaperCandidateSelection {
  isCandidateEnabled(candidate: TradeCandidate, now?: Date): boolean;
  reconcileActiveBuys?(now?: Date): number;
  getMaxBuyPriceMicros?(): number;
  getOrderBudgetMicros?(): number;
  getEligibilitySettings?(): MarketEligibilitySettings;
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
  private readonly pendingTokenIds = new Set<string>();
  private runLoop: Promise<void> | null = null;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private placedBuyCount = 0;
  private cancelledFilterBuyCount = 0;
  private cancelledStartedBuyCount = 0;
  private cancelledProgressedBuyCount = 0;
  private recovery: PaperRecoveryResult | null = null;
  private readonly attemptedBuyIntentByToken = new Map<string, string>();

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
    this.pendingTokenIds.add(tokenId);
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
      recovery: this.recovery,
    };
  }

  private async drainRuns(): Promise<void> {
    while (this.hasPendingRun() && this.started) {
      const runAll = this.fullRunRequested;
      const tokenIds = runAll ? null : new Set(this.pendingTokenIds);
      this.fullRunRequested = false;
      this.pendingTokenIds.clear();
      this.runOnce(tokenIds);
      await Promise.resolve();
    }
  }

  private hasPendingRun(): boolean {
    return this.fullRunRequested || this.pendingTokenIds.size > 0;
  }

  private runOnce(tokenIds: ReadonlySet<string> | null): void {
    const now = new Date();
    try {
      const cancelledFiltered =
        tokenIds === null
          ? (this.candidateSelection?.reconcileActiveBuys?.(now) ?? 0)
          : 0;
      this.cancelledFilterBuyCount += cancelledFiltered;
      const cancelled =
        tokenIds === null ? this.database.cancelStartedGameBuys(now) : 0;
      this.cancelledStartedBuyCount += cancelled;
      // Filter reconciliation applies the saved lifecycle threshold to any
      // legacy active buy orders before new FAK executions are considered.
      const cancelledProgressed = 0;
      this.cancelledProgressedBuyCount += cancelledProgressed;
      let placedThisRun = 0;

      if (this.database.getStrategyState().status === "RUNNING") {
        const snapshotCandidates =
          tokenIds === null
            ? this.candidates.getSnapshot().candidates
            : this.candidates.getCandidatesByTokenIds(tokenIds);
        const orderedCandidates =
          this.candidateSelection?.getOrderedCandidates?.(
            snapshotCandidates,
            now,
          ) ?? snapshotCandidates;
        for (const candidate of orderedCandidates) {
          if (
            (tokenIds !== null && !tokenIds.has(candidate.tokenId)) ||
            this.candidateSelection?.isCandidateEnabled(candidate, now) === false ||
            !candidateIsCurrent(candidate, now) ||
            !this.marketStream.isTokenReady(candidate.tokenId)
          ) {
            continue;
          }
          const book = this.marketStream.getOrderBook?.(candidate) ?? null;
          if (book === null) {
            continue;
          }
          const bookRevision =
            this.marketStream.getOrderBookRevision?.(candidate.tokenId) ?? null;
          const maxPriceMicros =
            this.candidateSelection?.getMaxBuyPriceMicros?.() ??
            this.config.maxBuyPriceMicros;
          const orderBudgetMicros =
            this.candidateSelection?.getOrderBudgetMicros?.() ??
            this.config.orderBudgetMicros;
          const strategyBeforeAttempt = this.database.getStrategyState();
          const buyIntentKey =
            bookRevision === null
              ? null
              : `${bookRevision}:${maxPriceMicros}:${orderBudgetMicros}:${strategyBeforeAttempt.availableCashMicros}:${strategyBeforeAttempt.updatedAt}`;
          if (
            buyIntentKey !== null &&
            this.attemptedBuyIntentByToken.get(candidate.tokenId) === buyIntentKey
          ) {
            continue;
          }
          if (buyIntentKey !== null) {
            this.attemptedBuyIntentByToken.set(candidate.tokenId, buyIntentKey);
          }
          try {
            const execution = this.executor.executeBuy({
              candidate,
              book,
              maxPriceMicros,
              orderBudgetMicros,
              feeRateMicros: candidate.feeRateMicros,
              feeExponent: candidate.feeExponent,
              eligibility:
                this.candidateSelection?.getEligibilitySettings?.() ?? {
                  resultCounts: [2, 3],
                  allCategories: true,
                  selectedCategoryIds: [],
                  minBuyPriceMicros: this.config.minBuyPriceMicros,
                  maxBuyPriceMicros: maxPriceMicros,
                  minBidAskRatioPercent: this.config.minBidAskRatioPercent,
                  minMarketDurationDays: this.config.minMarketDurationDays,
                  maxMarketDurationDays: this.config.maxMarketDurationDays,
                  maxMarketProgressPercent:
                    this.config.maxMarketProgressPercent,
                  orderBudgetMicros,
                },
            });
            if (execution.order !== null) {
              this.marketStream.consumeTestBuyLiquidity?.(
                candidate.tokenId,
                execution.consumedAsks,
              );
              // The same book may already satisfy the newly created exit
              // target. Recheck it now instead of waiting for another tick.
              this.marketStream.executeTargetSells?.(candidate.tokenId);
              this.placedBuyCount += 1;
              placedThisRun += 1;
            }
          } catch (error) {
            if (!isExpectedPlacementRejection(error)) {
              this.attemptedBuyIntentByToken.delete(candidate.tokenId);
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
}

function candidateIsCurrent(
  candidate: TradeCandidate,
  now: Date,
): boolean {
  const openedAt = Date.parse(candidate.openedAt);
  const endsAt = Date.parse(candidate.endsAt);
  const gameStartsAt =
    candidate.gameStartsAt === null ? null : Date.parse(candidate.gameStartsAt);
  if (
    !Number.isFinite(openedAt) ||
    !Number.isFinite(endsAt) ||
    now.getTime() < openedAt ||
    now.getTime() >= endsAt ||
    (gameStartsAt !== null && now.getTime() >= gameStartsAt)
  ) {
    return false;
  }

  return true;
}

function isExpectedPlacementRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /active paper buy|first sell|budget would be exceeded|Insufficient paper cash|game has started/.test(
    message,
  );
}
