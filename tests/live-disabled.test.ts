import { describe, expect, it } from "vitest";
import type { TradingExecutionAdapter } from "../src/domain/execution.js";
import { PaperDatabase } from "../src/infrastructure/db/database.js";
import {
  LiveExecutionDisabledError,
  LiveExecutorDisabled,
} from "../src/infrastructure/execution/live-executor-disabled.js";
import { TestExecutor } from "../src/infrastructure/execution/test-executor.js";
import { CandidateService } from "../src/services/candidate-service.js";
import type { PaperMarketRuntime } from "../src/services/market-stream-service.js";
import { PaperAutomationService } from "../src/services/paper-automation-service.js";
import { PaperMarketProcessor } from "../src/services/paper-market-processor.js";
import { testConfig } from "./helpers.js";

describe("LiveExecutorDisabled", () => {
  it("cannot submit a live order", async () => {
    const executor = new LiveExecutorDisabled();
    expect(executor.enabled).toBe(false);
    expect(executor.mode).toBe("LIVE");
    expect(() => executor.executeBuy({} as never)).toThrow(
      LiveExecutionDisabledError,
    );
    expect(() => executor.executeTargetSells({} as never)).toThrow(
      LiveExecutionDisabledError,
    );
    await expect(executor.placeOrder()).rejects.toBeInstanceOf(
      LiveExecutionDisabledError,
    );
  });

  it("keeps orchestration reusable for a future enabled LIVE adapter", () => {
    const database = new PaperDatabase(":memory:", 100_000_000);
    try {
      const testExecutor = new TestExecutor(database);
      const enabledLiveAdapter: TradingExecutionAdapter = {
        mode: "LIVE",
        enabled: true,
        executeBuy: (intent) => testExecutor.executeBuy(intent),
        executeTargetSells: (intent) =>
          testExecutor.executeTargetSells(intent),
      };
      const candidates = new CandidateService({ scan: async () => [] }, 15_000);

      expect(
        () => new PaperMarketProcessor(database, enabledLiveAdapter),
      ).not.toThrow();
      expect(
        () =>
          new PaperAutomationService(
            candidates,
            database,
            {} as PaperMarketRuntime,
            testConfig,
            undefined,
            enabledLiveAdapter,
          ),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });
});
