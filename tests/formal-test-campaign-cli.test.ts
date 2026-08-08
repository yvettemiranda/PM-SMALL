import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";

describe("formal TEST campaign CLI", () => {
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

  it("starts once, accepts a completed segment, and pauses at the target", async () => {
    let strategyStatus: "PAUSED" | "RUNNING" = "PAUSED";
    let startCount = 0;
    let pauseCount = 0;
    const { baseUrl, server } = await listen((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && request.url?.startsWith("/api/status")) {
        response.end(JSON.stringify(makeStatus(strategyStatus)));
        return;
      }
      if (request.method === "GET" && request.url === "/api/test/validation") {
        response.end(JSON.stringify(makeValidation()));
        return;
      }
      if (request.method === "GET" && request.url === "/api/test/preferences") {
        response.end(JSON.stringify(makePreferences()));
        return;
      }
      if (request.method === "POST" && request.url === "/api/test/start") {
        startCount += 1;
        strategyStatus = "RUNNING";
        response.end(JSON.stringify({ strategy: { status: "RUNNING" } }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/test/pause") {
        pauseCount += 1;
        strategyStatus = "PAUSED";
        response.end(JSON.stringify({ strategy: { status: "PAUSED" } }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    servers.push(server);
    const runDirectory = createRunDirectory();

    const running = spawnCli([
      "run",
      "--base-url",
      baseUrl,
      "--run-dir",
      runDirectory,
      "--target-seconds",
      "0.1",
      "--checkpoint-seconds",
      "0.1",
      "--max-wall-seconds",
      "2",
      "--interval-seconds",
      "0.03",
      "--request-timeout-seconds",
      "0.2",
      "--confirm",
      "START-TEST-72H",
    ]);

    await waitFor(
      () =>
        readCampaign(runDirectory).segments.some(
          (segment: { id: string }) => segment.id === "segment-0001",
        ),
      5_000,
    );
    const decision = await runCli([
      "decide",
      "--run-dir",
      runDirectory,
      "--segment-id",
      "segment-0001",
      "--decision",
      "include",
    ]);
    expect(decision.code).toBe(0);

    const result = await running;
    expect(result.code).toBe(0);
    expect(startCount).toBe(1);
    expect(pauseCount).toBe(1);
    expect(strategyStatus).toBe("PAUSED");
    expect(readCampaign(runDirectory)).toMatchObject({
      status: "TARGET_REACHED",
      targetAcceptedSeconds: 0.1,
      acceptedSeconds: expect.closeTo(0.1, 3),
    });
    expect(readCampaign(runDirectory).segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "segment-0001",
          decision: "INCLUDED",
          eligibility: "ELIGIBLE",
        }),
      ]),
    );
    expect(readFileSync(join(runDirectory, "REPORT.md"), "utf8")).toContain(
      "累计时长已达标，等待最终审计",
    );
  });

  it("never starts over an existing campaign directory", async () => {
    let startCount = 0;
    const { baseUrl, server } = await listen((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "POST" && request.url === "/api/test/start") {
        startCount += 1;
      }
      response.statusCode = 500;
      response.end(JSON.stringify({ error: "must not be called" }));
    });
    servers.push(server);
    const runDirectory = createRunDirectory();
    writeFileSync(
      join(runDirectory, "campaign.json"),
      JSON.stringify({ status: "STOPPED" }),
    );

    const result = await runCli([
      "run",
      "--base-url",
      baseUrl,
      "--run-dir",
      runDirectory,
      "--max-wall-seconds",
      "0.1",
      "--interval-seconds",
      "0.03",
      "--request-timeout-seconds",
      "0.2",
      "--confirm",
      "START-TEST-72H",
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already contains a formal TEST campaign");
    expect(startCount).toBe(0);
  });

  it("fails and pauses immediately when available status exposes a safety failure", async () => {
    let strategyStatus: "PAUSED" | "RUNNING" = "PAUSED";
    let startCount = 0;
    let pauseCount = 0;
    const { baseUrl, server } = await listen((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.method === "GET" && request.url?.startsWith("/api/status")) {
        response.end(
          JSON.stringify(
            makeStatus(strategyStatus, strategyStatus === "RUNNING"),
          ),
        );
        return;
      }
      if (request.method === "GET" && request.url === "/api/test/validation") {
        response.end(JSON.stringify(makeValidation()));
        return;
      }
      if (request.method === "GET" && request.url === "/api/test/preferences") {
        if (strategyStatus === "RUNNING") {
          request.socket.destroy();
        } else {
          response.end(JSON.stringify(makePreferences()));
        }
        return;
      }
      if (request.method === "POST" && request.url === "/api/test/start") {
        startCount += 1;
        strategyStatus = "RUNNING";
        response.end(JSON.stringify({ strategy: { status: "RUNNING" } }));
        return;
      }
      if (request.method === "POST" && request.url === "/api/test/pause") {
        pauseCount += 1;
        strategyStatus = "PAUSED";
        response.end(JSON.stringify({ strategy: { status: "PAUSED" } }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "not found" }));
    });
    servers.push(server);
    const runDirectory = createRunDirectory();

    const result = await runCli([
      "run",
      "--base-url",
      baseUrl,
      "--run-dir",
      runDirectory,
      "--target-seconds",
      "10",
      "--checkpoint-seconds",
      "1",
      "--max-wall-seconds",
      "0.2",
      "--interval-seconds",
      "0.03",
      "--request-timeout-seconds",
      "0.2",
      "--max-consecutive-errors",
      "100",
      "--pause-retry-seconds",
      "0.2",
      "--confirm",
      "START-TEST-72H",
    ]);

    expect(result.code).toBe(1);
    expect(startCount).toBe(1);
    expect(pauseCount).toBeGreaterThanOrEqual(1);
    expect(readCampaign(runDirectory).status).toBe("FAILED");
  });

  function createRunDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-formal-test-"));
    directories.push(directory);
    return directory;
  }
});

function spawnCli(arguments_: string[]): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "src/cli/formal-test-campaign.ts",
        ...arguments_,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function runCli(arguments_: string[]) {
  return spawnCli(arguments_);
}

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for formal TEST campaign state");
}

function readCampaign(runDirectory: string) {
  const path = join(runDirectory, "campaign.json");
  if (!existsSync(path)) {
    return {
      status: "MISSING",
      targetAcceptedSeconds: 0,
      acceptedSeconds: 0,
      segments: [],
    };
  }
  return JSON.parse(readFileSync(path, "utf8")) as {
    status: string;
    targetAcceptedSeconds: number;
    acceptedSeconds: number;
    segments: Array<{ id: string; decision: string; eligibility: string }>;
  };
}

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

function makeStatus(status: "PAUSED" | "RUNNING", liveEnabled = false) {
  return {
    version: "0.5.0",
    executionMode: "TEST",
    liveExecutionEnabled: liveEnabled,
    strategy: {
      mode: "TEST",
      status,
      initialCapitalMicros: 100_000_000,
      availableCashMicros: 100_000_000,
      reservedCashMicros: 0,
      realizedPnlMicros: 0,
      positionCostMicros: 0,
    },
    configuration: {
      minMarketDurationDays: 1,
      maxMarketDurationDays: 30,
    },
    runtime: {
      uptimeSeconds: 60,
      rssBytes: 300_000_000,
      heapTotalBytes: 150_000_000,
      heapUsedBytes: 100_000_000,
      externalBytes: 20_000_000,
    },
    marketScan: {
      candidateCount: 2,
      lastScanAt: "2026-08-08T00:00:00.000Z",
      lastError: null,
      scanning: false,
      diagnostics: {
        phase: "COMPLETE",
        startedAt: "2026-08-07T23:59:59.000Z",
        completedAt: "2026-08-08T00:00:00.000Z",
        durationMs: 1_000,
        eventPageCount: 2,
        eventPageRequestCount: 2,
        eventCount: 100,
        eligibleTokenCount: 20,
        orderBookBatchCount: 1,
        orderBookRequestCount: 1,
        orderBookCount: 20,
        candidateCount: 2,
        retryCount: 0,
        rateLimitCount: 0,
        transientErrorCount: 0,
      },
    },
    marketStream: {
      running: true,
      connected: true,
      subscribedTokenCount: 2,
      dataCompleteTokenCount: 2,
      lastEventAt: "2026-08-08T00:00:00.000Z",
      processedTradeEvents: 0,
      ignoredTradeEvents: 0,
      paperBuyFillCount: 0,
      paperSellFillCount: 0,
      createdPaperSellCount: 0,
      connectionCount: 1,
      fullSnapshotCount: 1,
      unexpectedDisconnectCount: 0,
      recoveryCount: 0,
      lastFullSnapshotDurationMs: 100,
      lastRecoveryDurationMs: null,
      lastError: null,
    },
    paperAutomation: {
      running: true,
      lastRunAt: "2026-08-08T00:00:00.000Z",
      lastError: null,
      placedBuyCount: 0,
      cancelledStartedBuyCount: 0,
      cancelledProgressedBuyCount: 0,
    },
    paperSettlement: {
      running: true,
      lastRunAt: "2026-08-08T00:00:00.000Z",
      lastError: null,
      checkedMarketCount: 0,
      waitingMarketCount: 0,
      settledMarketCount: 0,
    },
    paperValidation: {
      running: true,
      validationCount: 1,
      failedValidationCount: 0,
      lastRunAt: "2026-08-08T00:00:00.000Z",
      lastError: null,
      lastResult: makeValidation().validation,
    },
  };
}

function makeValidation() {
  return {
    validation: {
      passed: true,
      errors: [],
      sqliteIntegrity: "ok",
      activeOrderCount: 0,
      openPositionCount: 0,
      pendingSettlementCount: 0,
      checkedAt: "2026-08-08T00:00:00.000Z",
    },
  };
}

function makePreferences() {
  return {
    preferences: {
      marketTypes: ["BINARY", "TERNARY"],
      allCategories: true,
      selectedCategoryIds: [],
      candidateSortDirection: "ASC",
      minMarketDurationDays: 1,
      maxMarketDurationDays: 30,
      updatedAt: "2026-08-08T00:00:00.000Z",
      maxBuyPrice: "0.03",
      maxBuyPriceCents: 3,
      minBidAskRatioPercent: 50,
      maxMarketProgressPercent: 20,
      orderAmount: "1",
    },
    capitalEditable: true,
  };
}
