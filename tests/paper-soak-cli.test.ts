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

  it("summarizes stream recovery and PAPER activity counters", async () => {
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
      firstConnectionCount: 1,
      lastConnectionCount: 2,
      maxConnectionCount: 2,
      firstFullSnapshotCount: 1,
      lastFullSnapshotCount: 2,
      maxFullSnapshotCount: 2,
      firstUnexpectedDisconnectCount: 0,
      lastUnexpectedDisconnectCount: 1,
      maxUnexpectedDisconnectCount: 1,
      firstRecoveryCount: 0,
      lastRecoveryCount: 1,
      maxRecoveryCount: 1,
      maxFullSnapshotDurationMs: 400,
      maxRecoveryDurationMs: 900,
      firstProcessedTradeEvents: 10,
      lastProcessedTradeEvents: 12,
      maxProcessedTradeEvents: 12,
      maxIgnoredTradeEvents: 2,
      firstPaperBuyFillCount: 0,
      lastPaperBuyFillCount: 1,
      maxPaperBuyFillCount: 1,
      firstPaperSellFillCount: 0,
      lastPaperSellFillCount: 1,
      maxPaperSellFillCount: 1,
      firstCreatedPaperSellCount: 0,
      lastCreatedPaperSellCount: 1,
      maxCreatedPaperSellCount: 1,
      firstPlacedBuyCount: 1,
      lastPlacedBuyCount: 2,
      maxPlacedBuyCount: 2,
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
  const afterRecovery = callCount > 1;
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
        eventCount: 100,
        eligibleTokenCount: 20,
        orderBookBatchCount: 1,
        orderBookCount: 20,
        candidateCount: 2,
      },
    },
    marketStream: {
      running: true,
      connected: true,
      subscribedTokenCount: 2,
      dataCompleteTokenCount: 2,
      lastEventAt: "2026-08-04T00:00:00.000Z",
      processedTradeEvents: afterRecovery ? 12 : 10,
      ignoredTradeEvents: afterRecovery ? 2 : 1,
      paperBuyFillCount: afterRecovery ? 1 : 0,
      paperSellFillCount: afterRecovery ? 1 : 0,
      createdPaperSellCount: afterRecovery ? 1 : 0,
      connectionCount: afterRecovery ? 2 : 1,
      fullSnapshotCount: afterRecovery ? 2 : 1,
      unexpectedDisconnectCount: afterRecovery ? 1 : 0,
      recoveryCount: afterRecovery ? 1 : 0,
      lastFullSnapshotDurationMs: afterRecovery ? 400 : 300,
      lastRecoveryDurationMs: afterRecovery ? 900 : null,
      lastError: null,
    },
    paperAutomation: {
      running: true,
      lastRunAt: "2026-08-04T00:00:00.000Z",
      lastError: null,
      placedBuyCount: afterRecovery ? 2 : 1,
      cancelledStartedBuyCount: 0,
      cancelledProgressedBuyCount: 0,
    },
    paperSettlement: {
      running: true,
      lastRunAt: "2026-08-04T00:00:00.000Z",
      lastError: null,
      checkedMarketCount: 1,
      waitingMarketCount: 1,
      settledMarketCount: 0,
    },
    paperValidation: {
      running: true,
      validationCount: afterRecovery ? 2 : 1,
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
