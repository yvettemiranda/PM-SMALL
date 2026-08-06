import type { AppConfig } from "../config.js";
import type { TradeCandidate } from "../domain/types.js";
import type {
  PaperDatabase,
  PaperRecoveryResult,
} from "../infrastructure/db/database.js";
import type { CandidateService } from "./candidate-service.js";
import type { PaperMarketRuntime } from "./market-stream-service.js";

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
}

export class PaperAutomationService implements PaperAutomationRuntime {
  private started = false;
  private candidateUnsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private runRequested = false;
  private runLoop: Promise<void> | null = null;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private placedBuyCount = 0;
  private cancelledFilterBuyCount = 0;
  private cancelledStartedBuyCount = 0;
  private cancelledProgressedBuyCount = 0;
  private recovery: PaperRecoveryResult | null = null;

  public constructor(
    private readonly candidates: CandidateService,
    private readonly database: PaperDatabase,
    private readonly marketStream: PaperMarketRuntime,
    private readonly config: AppConfig,
    private readonly candidateSelection?: PaperCandidateSelection,
  ) {}

  public start(): void {
    if (this.started) {
      return;
    }
    this.recovery = this.database.recoverPaperState();
    this.started = true;
    this.candidateUnsubscribe = this.candidates.subscribe(() =>
      this.requestRun(),
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
    this.runRequested = true;
    if (this.runLoop !== null) {
      return;
    }
    this.runLoop = this.drainRuns().finally(() => {
      this.runLoop = null;
      if (this.runRequested && this.started) {
        this.requestRun();
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
    while (this.runRequested && this.started) {
      this.runRequested = false;
      this.runOnce();
      await Promise.resolve();
    }
  }

  private runOnce(): void {
    const now = new Date();
    try {
      const cancelledFiltered =
        this.candidateSelection?.reconcileActiveBuys?.(now) ?? 0;
      this.cancelledFilterBuyCount += cancelledFiltered;
      const cancelled = this.database.cancelStartedGameBuys(now);
      this.cancelledStartedBuyCount += cancelled;
      const cancelledProgressed = this.database.cancelProgressedMarketBuys(
        this.config.stopBuyProgressPercent,
        now,
      );
      this.cancelledProgressedBuyCount += cancelledProgressed;
      let placedThisRun = 0;

      if (this.database.getStrategyState().status === "RUNNING") {
        for (const candidate of this.candidates.getSnapshot().candidates) {
          if (
            this.candidateSelection?.isCandidateEnabled(candidate, now) === false ||
            !candidateIsCurrent(candidate, now, this.config) ||
            !this.marketStream.isTokenReady(candidate.tokenId)
          ) {
            continue;
          }
          try {
            this.database.placePaperBuy(
              candidate,
              this.config.totalBudgetMicros,
            );
            this.placedBuyCount += 1;
            placedThisRun += 1;
          } catch (error) {
            if (!isExpectedPlacementRejection(error)) {
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
  config: AppConfig,
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

  const progressPercent =
    ((now.getTime() - openedAt) / (endsAt - openedAt)) * 100;
  // The user-selected progress filter is enforced by candidateSelection.
  // Keep this independent hard cut-off here so a buy at the boundary is not
  // cancelled and immediately recreated during the same automation pass.
  return progressPercent < config.stopBuyProgressPercent;
}

function isExpectedPlacementRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /active paper buy|first sell|budget would be exceeded|Insufficient paper cash|game has started/.test(
    message,
  );
}
