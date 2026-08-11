import {
  classifyPaperMarketResolution,
  PaperResolutionValidationError,
} from "../domain/paper-settlement.js";
import type {
  MarketResolutionSource,
} from "../infrastructure/polymarket/market-data.js";
import type {
  PaperDatabase,
  PaperSettlementTarget,
} from "../infrastructure/db/database.js";

export type PaperSettlementServiceStatus = {
  running: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  checkedMarketCount: number;
  waitingMarketCount: number;
  settledMarketCount: number;
};

export interface PaperSettlementRuntime {
  getStatus(): PaperSettlementServiceStatus;
  requestRun(): void;
}

type NowFactory = () => Date;

export class PaperSettlementService implements PaperSettlementRuntime {
  private started = false;
  private timer: NodeJS.Timeout | null = null;
  private runRequested = false;
  private runLoop: Promise<void> | null = null;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private checkedMarketCount = 0;
  private waitingMarketCount = 0;
  private settledMarketCount = 0;

  public constructor(
    private readonly source: MarketResolutionSource,
    private readonly database: PaperDatabase,
    private readonly intervalMs: number,
    private readonly onOrdersChanged: () => void = () => undefined,
    private readonly nowFactory: NowFactory = () => new Date(),
  ) {}

  public start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.timer = setInterval(() => this.requestRun(), this.intervalMs);
    this.timer.unref();
    this.requestRun();
  }

  public async stop(): Promise<void> {
    this.started = false;
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

  public getStatus(): PaperSettlementServiceStatus {
    return {
      running: this.started,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      checkedMarketCount: this.checkedMarketCount,
      waitingMarketCount: this.waitingMarketCount,
      settledMarketCount: this.settledMarketCount,
    };
  }

  private async drainRuns(): Promise<void> {
    while (this.runRequested && this.started) {
      this.runRequested = false;
      await this.runOnce();
    }
  }

  private async runOnce(): Promise<void> {
    const now = this.nowFactory();
    const testResetGeneration = this.database.getTestResetGeneration();
    let runError: string | null = null;
    try {
      const targets = this.database.listPaperSettlementTargets(now);
      for (const target of targets) {
        try {
          this.database.ensurePaperSettlement(target, now);
        } catch (error) {
          this.pauseStrategySafely();
          throw error;
        }
      }

      const cancelledBuyCount = this.database.cancelEndedPaperBuys(now);
      if (cancelledBuyCount > 0) {
        this.onOrdersChanged();
      }

      for (const target of targets) {
        this.checkedMarketCount += 1;
        try {
          await this.processTarget(target, now, testResetGeneration);
        } catch (error) {
          if (
            !this.database.isPaperSettlementTargetCurrent(
              target,
              testResetGeneration,
              now,
            )
          ) {
            continue;
          }
          const message = errorMessage(error);
          runError = message;
          this.recordCheckSafely(target, now, "RESOLUTION_CHECK_FAILED", message);
          if (error instanceof PaperResolutionValidationError) {
            this.database.setStrategyStatus("PAUSED");
          }
        }
      }
      if (runError === null) {
        this.lastError = null;
      } else {
        this.lastError = runError;
      }
    } catch (error) {
      runError = errorMessage(error);
      this.lastError = runError;
    } finally {
      this.lastRunAt = now.toISOString();
    }
  }

  private async processTarget(
    target: PaperSettlementTarget,
    now: Date,
    testResetGeneration: number,
  ): Promise<void> {
    const snapshot = await this.source.fetchMarketResolution(target.marketId);
    if (
      !this.database.isPaperSettlementTargetCurrent(
        target,
        testResetGeneration,
        now,
      )
    ) {
      return;
    }
    try {
      const decision = classifyPaperMarketResolution(
        snapshot,
        target.conditionId,
        target.marketId,
      );
      if (decision.kind === "WAITING") {
        this.waitingMarketCount += 1;
        this.database.recordPaperSettlementCheck({
          target,
          resolutionStatus: decision.resolutionStatus,
          reason: decision.reason,
          now,
        });
        return;
      }

      const settlementInput = {
        target,
        closed: snapshot.closed,
        resolutionStatus: decision.resolutionStatus,
        winningTokenId: decision.winningTokenId,
        winningOutcome: decision.winningOutcome,
        now,
      } as const;
      const result = this.database.applyPaperSettlement(
        decision.payouts === undefined
          ? settlementInput
          : { ...settlementInput, payouts: decision.payouts },
      );
      if (!result.duplicate) {
        this.settledMarketCount += 1;
        this.onOrdersChanged();
      }
    } catch (error) {
      // A successful source read followed by an identity/accounting failure is
      // a consistency signal, so stop new paper orders until it is reviewed.
      this.pauseStrategySafely();
      throw error;
    }
  }

  private pauseStrategySafely(): void {
    try {
      this.database.setStrategyStatus("PAUSED");
    } catch {
      // Preserve the original settlement error in the service status.
    }
  }

  private recordCheckSafely(
    target: PaperSettlementTarget,
    now: Date,
    reason: string,
    error: string,
  ): void {
    try {
      const previous = this.database.getPaperSettlement(target.conditionId);
      this.database.recordPaperSettlementCheck({
        target,
        resolutionStatus: previous?.resolutionStatus ?? null,
        reason,
        error,
        now,
      });
    } catch {
      // The original error is more useful to the service status than a secondary audit error.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
