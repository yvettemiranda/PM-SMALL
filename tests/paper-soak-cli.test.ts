import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("paper soak CLI", () => {
  const servers: Server[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails on a returned LIVE status even when validation times out", async () => {
    const { baseUrl, server } = await listen((request, response) => {
      if (request.url?.startsWith("/api/status")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(makeLiveStatus()));
      }
      // Deliberately leave validation open until the CLI aborts it.
    });
    servers.push(server);
    const output = createOutputPath();

    const result = await runCli(baseUrl, output, [
      "--duration-seconds",
      "0.3",
      "--interval-seconds",
      "0.05",
      "--request-timeout-seconds",
      "0.1",
    ]);

    expect(result.code).toBe(1);
    const summary = readRecords(output).at(-1);
    expect(summary).toMatchObject({ type: "summary", result: "FAILED" });
    expect(summary?.criticalErrors).toEqual(
      expect.arrayContaining(["Live execution is enabled"]),
    );
  });

  it("retains LIVE when validation returns an HTTP error object", async () => {
    const { baseUrl, server } = await listen((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.startsWith("/api/status")) {
        response.end(JSON.stringify(makeLiveStatus()));
      } else {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "temporarily unavailable" }));
      }
    });
    servers.push(server);
    const output = createOutputPath();

    const result = await runCli(baseUrl, output, [
      "--duration-seconds",
      "0.3",
      "--interval-seconds",
      "0.05",
      "--request-timeout-seconds",
      "0.1",
    ]);

    expect(result.code).toBe(1);
    const records = readRecords(output);
    expect(records[0]).toMatchObject({
      type: "safety_failure",
      criticalErrors: expect.arrayContaining([
        "Live execution is enabled",
        "Validation endpoint returned HTTP 500",
      ]),
    });
    expect(records.at(-1)).toMatchObject({
      type: "summary",
      result: "FAILED",
    });
  });

  it("cannot complete without a valid sample", async () => {
    const { baseUrl, server } = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    servers.push(server);
    const output = createOutputPath();

    const result = await runCli(baseUrl, output, [
      "--duration-seconds",
      "0.12",
      "--interval-seconds",
      "0.1",
      "--request-timeout-seconds",
      "0.05",
      "--max-consecutive-errors",
      "10",
    ]);

    expect(result.code).toBe(1);
    expect(readRecords(output).at(-1)).toMatchObject({
      type: "summary",
      result: "FAILED",
      sampleCount: 0,
      criticalErrors: ["No valid PAPER soak sample was recorded"],
    });
  });

  it("keeps counter maxima when a server restart resets activity counters", async () => {
    let statusCallCount = 0;
    const { baseUrl, server } = await listen((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.startsWith("/api/status")) {
        statusCallCount += 1;
        response.end(JSON.stringify(makeHealthyStatus(statusCallCount)));
      } else {
        response.end(JSON.stringify(makeHealthyValidation()));
      }
    });
    servers.push(server);
    const output = createOutputPath();

    const result = await runCli(baseUrl, output, [
      "--duration-seconds",
      "0.18",
      "--interval-seconds",
      "0.05",
    ]);

    expect(result.code).toBe(0);
    expect(readRecords(output).at(-1)).toMatchObject({
      type: "summary",
      result: "COMPLETED",
      firstConnectionCount: 2,
      lastConnectionCount: 1,
      maxConnectionCount: 2,
      firstFullSnapshotCount: 2,
      lastFullSnapshotCount: 1,
      maxFullSnapshotCount: 2,
      firstUnexpectedDisconnectCount: 1,
      lastUnexpectedDisconnectCount: 0,
      maxUnexpectedDisconnectCount: 1,
      firstRecoveryCount: 1,
      lastRecoveryCount: 0,
      maxRecoveryCount: 1,
      maxFullSnapshotDurationMs: 400,
      maxRecoveryDurationMs: 900,
      maxRuntimeUptimeSeconds: 3_600,
      maxRssBytes: 320_000_000,
      maxHeapTotalBytes: 160_000_000,
      maxHeapUsedBytes: 120_000_000,
      maxExternalBytes: 20_000_000,
      maxEventPageRequestCount: 4,
      maxOrderBookRequestCount: 3,
      maxScanRetryCount: 2,
      maxScanRateLimitCount: 1,
      maxScanTransientErrorCount: 2,
      firstProcessedTradeEvents: 12,
      lastProcessedTradeEvents: 0,
      maxProcessedTradeEvents: 12,
      maxIgnoredTradeEvents: 2,
      firstPaperBuyFillCount: 1,
      lastPaperBuyFillCount: 0,
      maxPaperBuyFillCount: 1,
      firstPaperSellFillCount: 1,
      lastPaperSellFillCount: 0,
      maxPaperSellFillCount: 1,
      firstCreatedPaperSellCount: 1,
      lastCreatedPaperSellCount: 0,
      maxCreatedPaperSellCount: 1,
      firstPlacedBuyCount: 100,
      lastPlacedBuyCount: 0,
      maxPlacedBuyCount: 100,
      firstCancelledStartedBuyCount: 3,
      lastCancelledStartedBuyCount: 0,
      maxCancelledStartedBuyCount: 3,
      firstCancelledProgressedBuyCount: 4,
      lastCancelledProgressedBuyCount: 0,
      maxCancelledProgressedBuyCount: 4,
      firstCheckedMarketCount: 10,
      lastCheckedMarketCount: 0,
      maxCheckedMarketCount: 10,
      firstWaitingMarketCount: 7,
      lastWaitingMarketCount: 0,
      maxWaitingMarketCount: 7,
      firstSettledMarketCount: 3,
      lastSettledMarketCount: 0,
      maxSettledMarketCount: 3,
      firstValidationCount: 5,
      lastValidationCount: 1,
      maxValidationCount: 5,
      firstFailedValidationCount: 0,
      lastFailedValidationCount: 0,
      maxFailedValidationCount: 0,
    });
  });

  function createOutputPath(): string {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-soak-cli-"));
    directories.push(directory);
    return join(directory, "evidence.jsonl");
  }
});

async function listen(
  handler: RequestListener,
): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not expose a TCP port");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

function runCli(
  baseUrl: string,
  output: string,
  extraArguments: string[],
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "src/cli/paper-soak.ts",
        "--base-url",
        baseUrl,
        "--output",
        output,
        ...extraArguments,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

function readRecords(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function makeLiveStatus() {
  return {
    executionMode: "LIVE",
    liveExecutionEnabled: true,
    strategy: { mode: "PAPER", status: "RUNNING" },
    paperAutomation: { running: true },
    paperSettlement: { running: true },
    marketStream: { running: true },
    paperValidation: {
      running: true,
      failedValidationCount: 0,
      lastError: null,
      lastResult: {
        passed: true,
        errors: [],
        sqliteIntegrity: "ok",
      },
    },
  };
}

function makeHealthyStatus(callCount: number) {
  const beforeRestart = callCount === 1;
  return {
    version: "0.4.0",
    executionMode: "PAPER",
    liveExecutionEnabled: false,
    strategy: {
      mode: "PAPER",
      status: "RUNNING",
      initialCapitalMicros: 100_000_000,
      availableCashMicros: 99_000_000,
      reservedCashMicros: 1_000_000,
      realizedPnlMicros: 0,
      positionCostMicros: 0,
    },
    configuration: { maxMarketDurationDays: 30 },
    runtime: beforeRestart
      ? {
          uptimeSeconds: 3_600,
          rssBytes: 320_000_000,
          heapTotalBytes: 160_000_000,
          heapUsedBytes: 120_000_000,
          externalBytes: 20_000_000,
        }
      : {
          uptimeSeconds: 10,
          rssBytes: 280_000_000,
          heapTotalBytes: 150_000_000,
          heapUsedBytes: 110_000_000,
          externalBytes: 18_000_000,
        },
    marketScan: {
      candidateCount: 2,
      lastScanAt: "2026-08-04T00:00:00.000Z",
      lastError: null,
      scanning: false,
      diagnostics: {
        phase: "COMPLETE",
        startedAt: "2026-08-03T23:59:59.000Z",
        completedAt: "2026-08-04T00:00:00.000Z",
        durationMs: 1_000,
        eventPageCount: 2,
        eventPageRequestCount: beforeRestart ? 4 : 2,
        eventCount: 100,
        eligibleTokenCount: 20,
        orderBookBatchCount: 1,
        orderBookRequestCount: beforeRestart ? 3 : 1,
        orderBookCount: 20,
        candidateCount: 2,
        retryCount: beforeRestart ? 2 : 0,
        rateLimitCount: beforeRestart ? 1 : 0,
        transientErrorCount: beforeRestart ? 2 : 0,
      },
    },
    marketStream: {
      running: true,
      connected: true,
      subscribedTokenCount: 2,
      dataCompleteTokenCount: 2,
      lastEventAt: "2026-08-04T00:00:00.000Z",
      processedTradeEvents: beforeRestart ? 12 : 0,
      ignoredTradeEvents: beforeRestart ? 2 : 0,
      paperBuyFillCount: beforeRestart ? 1 : 0,
      paperSellFillCount: beforeRestart ? 1 : 0,
      createdPaperSellCount: beforeRestart ? 1 : 0,
      connectionCount: beforeRestart ? 2 : 1,
      fullSnapshotCount: beforeRestart ? 2 : 1,
      unexpectedDisconnectCount: beforeRestart ? 1 : 0,
      recoveryCount: beforeRestart ? 1 : 0,
      lastFullSnapshotDurationMs: beforeRestart ? 400 : 300,
      lastRecoveryDurationMs: beforeRestart ? 900 : null,
      lastError: null,
    },
    paperAutomation: {
      running: true,
      lastRunAt: "2026-08-04T00:00:00.000Z",
      lastError: null,
      placedBuyCount: beforeRestart ? 100 : 0,
      cancelledStartedBuyCount: beforeRestart ? 3 : 0,
      cancelledProgressedBuyCount: beforeRestart ? 4 : 0,
    },
    paperSettlement: {
      running: true,
      lastRunAt: "2026-08-04T00:00:00.000Z",
      lastError: null,
      checkedMarketCount: beforeRestart ? 10 : 0,
      waitingMarketCount: beforeRestart ? 7 : 0,
      settledMarketCount: beforeRestart ? 3 : 0,
    },
    paperValidation: {
      running: true,
      validationCount: beforeRestart ? 5 : 1,
      failedValidationCount: 0,
      lastRunAt: "2026-08-04T00:00:00.000Z",
      lastError: null,
      lastResult: makeHealthyValidation().validation,
    },
  };
}

function makeHealthyValidation() {
  return {
    validation: {
      passed: true,
      errors: [],
      sqliteIntegrity: "ok",
      activeOrderCount: 1,
      openPositionCount: 0,
      pendingSettlementCount: 0,
      checkedAt: "2026-08-04T00:00:00.000Z",
    },
  };
}
