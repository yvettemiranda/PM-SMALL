import type {
  PaperDatabase,
  PaperValidationResult,
} from "../infrastructure/db/database.js";

export type PaperValidationServiceStatus = {
  running: boolean;
  validationCount: number;
  failedValidationCount: number;
  lastRunAt: string | null;
  lastError: string | null;
  lastResult: PaperValidationResult | null;
};

export interface PaperValidationRuntime {
  getStatus(): PaperValidationServiceStatus;
  requestRun(): void;
}

export class PaperValidationService implements PaperValidationRuntime {
  private started = false;
  private timer: NodeJS.Timeout | null = null;
  private runRequested = false;
  private runLoop: Promise<void> | null = null;
  private validationCount = 0;
  private failedValidationCount = 0;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private lastResult: PaperValidationResult | null = null;

  public constructor(
    private readonly database: PaperDatabase,
    private readonly intervalMs: number,
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

  public getStatus(): PaperValidationServiceStatus {
    return {
      running: this.started,
      validationCount: this.validationCount,
      failedValidationCount: this.failedValidationCount,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      lastResult: this.lastResult,
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
    try {
      const result = this.database.validatePaperState();
      this.validationCount += 1;
      this.lastResult = result;
      this.lastRunAt = result.checkedAt;
      if (result.passed) {
        this.lastError = null;
      } else {
        this.failedValidationCount += 1;
        this.lastError = result.errors.join("; ");
        this.pauseStrategySafely(result.errors);
      }
    } catch (error) {
      this.validationCount += 1;
      this.failedValidationCount += 1;
      this.lastRunAt = new Date().toISOString();
      this.lastResult = null;
      this.lastError = errorMessage(error);
      this.pauseStrategySafely([this.lastError]);
    }
  }

  private pauseStrategySafely(errors: readonly string[]): void {
    try {
      this.database.pausePaperStrategyForValidationFailure(errors);
    } catch {
      // The database raises its in-memory buy block before attempting the
      // persistent PAUSED update, so a failed write still fails closed.
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
