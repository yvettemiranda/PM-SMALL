import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  evaluateAvailablePaperSoakSafety,
  evaluatePaperSoakSample,
  type PaperSoakSample,
} from "../services/paper-soak-evaluator.js";

type RunResult = "COMPLETED" | "FAILED" | "INTERRUPTED";

type TransportErrorRecord = {
  type: "transport_error";
  sampledAt: string;
  error: string;
  consecutiveErrorCount: number;
  criticalErrors: string[];
};

type SafetyFailureRecord = {
  type: "safety_failure";
  sampledAt: string;
  requestDurationMs: number;
  error: string;
  criticalErrors: string[];
};

type RunStatistics = {
  sampleCount: number;
  warningSampleCount: number;
  transportErrorCount: number;
  maxConsecutiveTransportErrors: number;
  maxRequestDurationMs: number;
  maxCandidateCount: number;
  maxEventPageCount: number;
  maxEventCount: number;
  maxOrderBookBatchCount: number;
  maxScanDurationMs: number;
  maxSubscribedTokenCount: number;
  firstValidationCount: number | null;
  lastValidationCount: number | null;
  firstConnectionCount: number | null;
  lastConnectionCount: number | null;
  maxConnectionCount: number;
  firstFullSnapshotCount: number | null;
  lastFullSnapshotCount: number | null;
  maxFullSnapshotCount: number;
  firstUnexpectedDisconnectCount: number | null;
  lastUnexpectedDisconnectCount: number | null;
  maxUnexpectedDisconnectCount: number;
  firstRecoveryCount: number | null;
  lastRecoveryCount: number | null;
  maxRecoveryCount: number;
  maxFullSnapshotDurationMs: number;
  maxRecoveryDurationMs: number;
  firstProcessedTradeEvents: number | null;
  lastProcessedTradeEvents: number | null;
  maxProcessedTradeEvents: number;
  firstIgnoredTradeEvents: number | null;
  lastIgnoredTradeEvents: number | null;
  maxIgnoredTradeEvents: number;
  firstPaperBuyFillCount: number | null;
  lastPaperBuyFillCount: number | null;
  maxPaperBuyFillCount: number;
  firstPaperSellFillCount: number | null;
  lastPaperSellFillCount: number | null;
  maxPaperSellFillCount: number;
  firstCreatedPaperSellCount: number | null;
  lastCreatedPaperSellCount: number | null;
  maxCreatedPaperSellCount: number;
  firstPlacedBuyCount: number | null;
  lastPlacedBuyCount: number | null;
  maxPlacedBuyCount: number;
  criticalErrors: string[];
};

const { values } = parseArgs({
  options: {
    "base-url": { type: "string", default: "http://127.0.0.1:3000" },
    "duration-seconds": { type: "string", default: "86400" },
    "interval-seconds": { type: "string", default: "60" },
    output: { type: "string" },
    "allow-not-running": { type: "boolean", default: false },
    "max-consecutive-errors": { type: "string", default: "3" },
    "request-timeout-seconds": { type: "string", default: "15" },
  },
  strict: true,
  allowPositionals: false,
});

const durationSeconds = positiveNumber(
  values["duration-seconds"],
  "duration-seconds",
);
const intervalSeconds = positiveNumber(
  values["interval-seconds"],
  "interval-seconds",
);
const maxConsecutiveErrors = positiveInteger(
  values["max-consecutive-errors"],
  "max-consecutive-errors",
);
const requestTimeoutSeconds = positiveNumber(
  values["request-timeout-seconds"],
  "request-timeout-seconds",
);
const baseUrl = (values["base-url"] as string).replace(/\/+$/, "");
const requireRunning = values["allow-not-running"] !== true;
const outputPath = resolve(
  values.output ??
    `data/validation/paper-soak-${fileTimestamp(new Date())}.jsonl`,
);

await run();

async function run(): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const startedAtDate = new Date();
  const startedAt = startedAtDate.toISOString();
  const deadlineMs = startedAtDate.getTime() + durationSeconds * 1_000;
  const stopController = new AbortController();
  let interrupted = false;
  const requestStop = () => {
    interrupted = true;
    stopController.abort();
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  const statistics: RunStatistics = {
    sampleCount: 0,
    warningSampleCount: 0,
    transportErrorCount: 0,
    maxConsecutiveTransportErrors: 0,
    maxRequestDurationMs: 0,
    maxCandidateCount: 0,
    maxEventPageCount: 0,
    maxEventCount: 0,
    maxOrderBookBatchCount: 0,
    maxScanDurationMs: 0,
    maxSubscribedTokenCount: 0,
    firstValidationCount: null,
    lastValidationCount: null,
    firstConnectionCount: null,
    lastConnectionCount: null,
    maxConnectionCount: 0,
    firstFullSnapshotCount: null,
    lastFullSnapshotCount: null,
    maxFullSnapshotCount: 0,
    firstUnexpectedDisconnectCount: null,
    lastUnexpectedDisconnectCount: null,
    maxUnexpectedDisconnectCount: 0,
    firstRecoveryCount: null,
    lastRecoveryCount: null,
    maxRecoveryCount: 0,
    maxFullSnapshotDurationMs: 0,
    maxRecoveryDurationMs: 0,
    firstProcessedTradeEvents: null,
    lastProcessedTradeEvents: null,
    maxProcessedTradeEvents: 0,
    firstIgnoredTradeEvents: null,
    lastIgnoredTradeEvents: null,
    maxIgnoredTradeEvents: 0,
    firstPaperBuyFillCount: null,
    lastPaperBuyFillCount: null,
    maxPaperBuyFillCount: 0,
    firstPaperSellFillCount: null,
    lastPaperSellFillCount: null,
    maxPaperSellFillCount: 0,
    firstCreatedPaperSellCount: null,
    lastCreatedPaperSellCount: null,
    maxCreatedPaperSellCount: 0,
    firstPlacedBuyCount: null,
    lastPlacedBuyCount: null,
    maxPlacedBuyCount: 0,
    criticalErrors: [],
  };
  let consecutiveTransportErrors = 0;
  let result: RunResult = "COMPLETED";

  console.log(`PAPER soak monitor: ${baseUrl}`);
  console.log(`Evidence file: ${outputPath}`);
  console.log(
    `Duration: ${durationSeconds}s; interval: ${intervalSeconds}s; require RUNNING: ${requireRunning}`,
  );

  try {
    while (!interrupted) {
      if (Date.now() >= deadlineMs) {
        break;
      }
      const sampledAt = new Date().toISOString();
      const requestStartedAtMs = Date.now();
      try {
        const requestSignal = AbortSignal.any([
          stopController.signal,
          AbortSignal.timeout(requestTimeoutSeconds * 1_000),
        ]);
        const [statusResult, validationResult] = await Promise.allSettled([
          fetchJson(`${baseUrl}/api/status?compact=true`, requestSignal),
          fetchJson(`${baseUrl}/api/paper/validation`, requestSignal),
        ]);
        const availableCriticalErrors = evaluateAvailablePaperSoakSafety({
          ...(statusResult.status === "fulfilled"
            ? {
                status: {
                  httpStatus: statusResult.value.status,
                  payload: statusResult.value.payload,
                },
              }
            : {}),
          ...(validationResult.status === "fulfilled"
            ? {
                validation: {
                  httpStatus: validationResult.value.status,
                  payload: validationResult.value.payload,
                },
              }
            : {}),
          requireRunning,
        });
        if (
          statusResult.status === "rejected" ||
          validationResult.status === "rejected"
        ) {
          const requestErrors = [statusResult, validationResult]
            .filter(
              (result): result is PromiseRejectedResult =>
                result.status === "rejected",
            )
            .map((result) => errorMessage(result.reason));
          consecutiveTransportErrors += 1;
          statistics.transportErrorCount += 1;
          statistics.maxConsecutiveTransportErrors = Math.max(
            statistics.maxConsecutiveTransportErrors,
            consecutiveTransportErrors,
          );
          const record: TransportErrorRecord = {
            type: "transport_error",
            sampledAt,
            error: requestErrors.join("; "),
            consecutiveErrorCount: consecutiveTransportErrors,
            criticalErrors: availableCriticalErrors,
          };
          await appendRecord(record);
          console.error(`[${sampledAt}] ${record.error}`);
          if (availableCriticalErrors.length > 0) {
            statistics.criticalErrors = availableCriticalErrors;
            result = "FAILED";
            break;
          }
          if (consecutiveTransportErrors >= maxConsecutiveErrors) {
            statistics.criticalErrors = [
              `Local status sampling failed ${consecutiveTransportErrors} consecutive times`,
            ];
            result = "FAILED";
            break;
          }
        } else {
          const statusResponse = statusResult.value;
          const validationResponse = validationResult.value;
          let sample: PaperSoakSample;
          try {
            sample = evaluatePaperSoakSample({
              sampledAt,
              requestDurationMs: Date.now() - requestStartedAtMs,
              statusHttpStatus: statusResponse.status,
              validationHttpStatus: validationResponse.status,
              statusPayload: statusResponse.payload,
              validationPayload: validationResponse.payload,
              requireRunning,
            });
          } catch (error) {
            if (availableCriticalErrors.length === 0) {
              throw error;
            }
            const record: SafetyFailureRecord = {
              type: "safety_failure",
              sampledAt,
              requestDurationMs: Date.now() - requestStartedAtMs,
              error: errorMessage(error),
              criticalErrors: availableCriticalErrors,
            };
            await appendRecord(record);
            statistics.criticalErrors = availableCriticalErrors;
            result = "FAILED";
            break;
          }
          consecutiveTransportErrors = 0;
          updateStatistics(statistics, sample);
          await appendRecord(sample);
          console.log(
            `[${sample.sampledAt}] candidates=${sample.scan.candidateCount} subscribed=${sample.marketStream.subscribedTokenCount} warnings=${sample.warnings.length} critical=${sample.criticalErrors.length}`,
          );
          if (sample.criticalErrors.length > 0) {
            statistics.criticalErrors = [...sample.criticalErrors];
            result = "FAILED";
            break;
          }
        }
      } catch (error) {
        if (interrupted) {
          break;
        }
        consecutiveTransportErrors += 1;
        statistics.transportErrorCount += 1;
        statistics.maxConsecutiveTransportErrors = Math.max(
          statistics.maxConsecutiveTransportErrors,
          consecutiveTransportErrors,
        );
        const record: TransportErrorRecord = {
          type: "transport_error",
          sampledAt,
          error: errorMessage(error),
          consecutiveErrorCount: consecutiveTransportErrors,
          criticalErrors: [],
        };
        await appendRecord(record);
        console.error(`[${sampledAt}] ${record.error}`);
        if (consecutiveTransportErrors >= maxConsecutiveErrors) {
          statistics.criticalErrors = [
            `Local status sampling failed ${consecutiveTransportErrors} consecutive times`,
          ];
          result = "FAILED";
          break;
        }
      }

      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      try {
        await delay(
          Math.min(intervalSeconds * 1_000, remainingMs),
          undefined,
          { signal: stopController.signal },
        );
      } catch (error) {
        if (!interrupted) {
          throw error;
        }
      }
    }
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
  }

  if (interrupted && result !== "FAILED") {
    result = "INTERRUPTED";
  }
  if (result === "COMPLETED" && statistics.sampleCount === 0) {
    result = "FAILED";
    statistics.criticalErrors = ["No valid PAPER soak sample was recorded"];
  }
  const finishedAtDate = new Date();
  const summary = {
    type: "summary" as const,
    result,
    startedAt,
    finishedAt: finishedAtDate.toISOString(),
    requestedDurationSeconds: durationSeconds,
    elapsedSeconds: Number(
      ((finishedAtDate.getTime() - startedAtDate.getTime()) / 1_000).toFixed(3),
    ),
    intervalSeconds,
    requireRunning,
    baseUrl,
    ...statistics,
  };
  await appendRecord(summary);
  console.log(JSON.stringify(summary));

  if (result === "FAILED") {
    process.exitCode = 1;
  } else if (result === "INTERRUPTED") {
    process.exitCode = 130;
  }
}

async function fetchJson(
  url: string,
  signal: AbortSignal,
): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(url, {
    signal,
    headers: { accept: "application/json" },
  });
  return { status: response.status, payload: await response.json() };
}

function updateStatistics(
  statistics: RunStatistics,
  sample: PaperSoakSample,
): void {
  statistics.sampleCount += 1;
  if (sample.warnings.length > 0) {
    statistics.warningSampleCount += 1;
  }
  statistics.maxRequestDurationMs = Math.max(
    statistics.maxRequestDurationMs,
    sample.http.requestDurationMs,
  );
  statistics.maxCandidateCount = Math.max(
    statistics.maxCandidateCount,
    sample.scan.candidateCount,
  );
  statistics.maxEventCount = Math.max(
    statistics.maxEventCount,
    sample.scan.diagnostics?.eventCount ?? 0,
  );
  statistics.maxEventPageCount = Math.max(
    statistics.maxEventPageCount,
    sample.scan.diagnostics?.eventPageCount ?? 0,
  );
  statistics.maxOrderBookBatchCount = Math.max(
    statistics.maxOrderBookBatchCount,
    sample.scan.diagnostics?.orderBookBatchCount ?? 0,
  );
  statistics.maxScanDurationMs = Math.max(
    statistics.maxScanDurationMs,
    sample.scan.diagnostics?.durationMs ?? 0,
  );
  statistics.maxSubscribedTokenCount = Math.max(
    statistics.maxSubscribedTokenCount,
    sample.marketStream.subscribedTokenCount,
  );
  statistics.firstValidationCount ??=
    sample.periodicValidation.validationCount;
  statistics.lastValidationCount = sample.periodicValidation.validationCount;
  statistics.firstConnectionCount ??= sample.marketStream.connectionCount;
  statistics.lastConnectionCount = sample.marketStream.connectionCount;
  statistics.maxConnectionCount = Math.max(
    statistics.maxConnectionCount,
    sample.marketStream.connectionCount,
  );
  statistics.firstFullSnapshotCount ??=
    sample.marketStream.fullSnapshotCount;
  statistics.lastFullSnapshotCount = sample.marketStream.fullSnapshotCount;
  statistics.maxFullSnapshotCount = Math.max(
    statistics.maxFullSnapshotCount,
    sample.marketStream.fullSnapshotCount,
  );
  statistics.firstUnexpectedDisconnectCount ??=
    sample.marketStream.unexpectedDisconnectCount;
  statistics.lastUnexpectedDisconnectCount =
    sample.marketStream.unexpectedDisconnectCount;
  statistics.maxUnexpectedDisconnectCount = Math.max(
    statistics.maxUnexpectedDisconnectCount,
    sample.marketStream.unexpectedDisconnectCount,
  );
  statistics.firstRecoveryCount ??= sample.marketStream.recoveryCount;
  statistics.lastRecoveryCount = sample.marketStream.recoveryCount;
  statistics.maxRecoveryCount = Math.max(
    statistics.maxRecoveryCount,
    sample.marketStream.recoveryCount,
  );
  statistics.maxFullSnapshotDurationMs = Math.max(
    statistics.maxFullSnapshotDurationMs,
    sample.marketStream.lastFullSnapshotDurationMs ?? 0,
  );
  statistics.maxRecoveryDurationMs = Math.max(
    statistics.maxRecoveryDurationMs,
    sample.marketStream.lastRecoveryDurationMs ?? 0,
  );
  statistics.firstProcessedTradeEvents ??=
    sample.marketStream.processedTradeEvents;
  statistics.lastProcessedTradeEvents =
    sample.marketStream.processedTradeEvents;
  statistics.maxProcessedTradeEvents = Math.max(
    statistics.maxProcessedTradeEvents,
    sample.marketStream.processedTradeEvents,
  );
  statistics.firstIgnoredTradeEvents ??=
    sample.marketStream.ignoredTradeEvents;
  statistics.lastIgnoredTradeEvents = sample.marketStream.ignoredTradeEvents;
  statistics.maxIgnoredTradeEvents = Math.max(
    statistics.maxIgnoredTradeEvents,
    sample.marketStream.ignoredTradeEvents,
  );
  statistics.firstPaperBuyFillCount ??=
    sample.marketStream.paperBuyFillCount;
  statistics.lastPaperBuyFillCount = sample.marketStream.paperBuyFillCount;
  statistics.maxPaperBuyFillCount = Math.max(
    statistics.maxPaperBuyFillCount,
    sample.marketStream.paperBuyFillCount,
  );
  statistics.firstPaperSellFillCount ??=
    sample.marketStream.paperSellFillCount;
  statistics.lastPaperSellFillCount = sample.marketStream.paperSellFillCount;
  statistics.maxPaperSellFillCount = Math.max(
    statistics.maxPaperSellFillCount,
    sample.marketStream.paperSellFillCount,
  );
  statistics.firstCreatedPaperSellCount ??=
    sample.marketStream.createdPaperSellCount;
  statistics.lastCreatedPaperSellCount =
    sample.marketStream.createdPaperSellCount;
  statistics.maxCreatedPaperSellCount = Math.max(
    statistics.maxCreatedPaperSellCount,
    sample.marketStream.createdPaperSellCount,
  );
  statistics.firstPlacedBuyCount ??= sample.paperAutomation.placedBuyCount;
  statistics.lastPlacedBuyCount = sample.paperAutomation.placedBuyCount;
  statistics.maxPlacedBuyCount = Math.max(
    statistics.maxPlacedBuyCount,
    sample.paperAutomation.placedBuyCount,
  );
}

async function appendRecord(record: unknown): Promise<void> {
  await appendFile(outputPath, `${JSON.stringify(record)}\n`, "utf8");
}

function positiveNumber(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive number`);
  }
  return parsed;
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = positiveNumber(value, name);
  if (!Number.isInteger(parsed)) {
    throw new Error(`--${name} must be an integer`);
  }
  return parsed;
}

function fileTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
