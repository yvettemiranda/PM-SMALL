import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  createFormalTestCampaign,
  decideFormalTestSegment,
  finishFormalTestCampaign,
  observeFormalTestCampaign,
  renderFormalTestReport,
  type FormalTestCampaign,
  type FormalTestConfiguration,
  type FormalTestSampleMetrics,
} from "../services/formal-test-campaign.js";
import {
  evaluateAvailablePaperSoakSafety,
  evaluatePaperSoakSample,
  type PaperSoakSample,
} from "../services/paper-soak-evaluator.js";

const START_CONFIRMATION = "START-TEST-72H";
const campaignFile = "campaign.json";
const reportFile = "REPORT.md";
const decisionsFile = "decisions.jsonl";
const observationsFile = "observations.jsonl";
const manifestFile = "manifest.json";
const controlFile = "control.jsonl";

const preferencesResponseSchema = z.object({
  preferences: z.object({
    marketTypes: z.array(z.enum(["BINARY", "TERNARY", "MULTI"])).min(1),
    allCategories: z.boolean(),
    selectedCategoryIds: z.array(z.string()),
    candidateSortDirection: z.enum(["ASC", "DESC"]),
    minMarketDurationDays: z.number().int().positive(),
    maxMarketDurationDays: z.number().int().positive(),
    maxBuyPriceCents: z.number().int().min(1).max(3),
    minBidAskRatioPercent: z.number().int().min(1).max(100),
    maxMarketProgressPercent: z.number().int().min(1).max(100),
    orderAmount: z.string(),
    updatedAt: z.string(),
  }),
});

const preflightStatusSchema = z.object({
  executionMode: z.string(),
  liveExecutionEnabled: z.boolean(),
  strategy: z.object({
    status: z.string(),
    initialCapitalMicros: z.number().int().positive(),
  }),
});

const strategyResponseSchema = z.object({
  strategy: z.object({ status: z.string() }),
});

type DecisionRecord = {
  segmentId: string;
  decision: "INCLUDED" | "EXCLUDED";
  decidedAt: string;
};

type ControlRecord = {
  command: "STOP";
  requestedAt: string;
};

class FormalTestSnapshotError extends Error {
  public constructor(
    message: string,
    public readonly criticalErrors: string[],
  ) {
    super(message);
    this.name = "FormalTestSnapshotError";
  }
}

const command = process.argv[2];
if (command === undefined) {
  throw new Error(
    "Formal TEST command is required: run, supervise, status, decide, or stop",
  );
}

if (command === "run") {
  await runCampaign(process.argv.slice(3));
} else if (command === "supervise") {
  await superviseCampaign(process.argv.slice(3));
} else if (command === "status") {
  await showStatus(process.argv.slice(3));
} else if (command === "decide") {
  await recordDecision(process.argv.slice(3));
} else if (command === "stop") {
  await stopCampaign(process.argv.slice(3));
} else {
  throw new Error(`Unknown formal TEST command: ${command}`);
}

async function superviseCampaign(arguments_: string[]): Promise<void> {
  const runDirectory = runDirectoryFromRunArguments(arguments_);
  let stopping = false;
  const markStopping = () => {
    stopping = true;
  };
  process.once("SIGINT", markStopping);
  process.once("SIGTERM", markStopping);
  try {
    if (await campaignFileExists(runDirectory)) {
      await stopCampaign(["--run-dir", runDirectory]);
      console.error(
        "Formal TEST supervisor restarted with existing state; TEST was forced to PAUSED",
      );
    } else {
      await unlink(resolve(runDirectory, "runner.lock")).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
      await runCampaign(arguments_);
    }
  } finally {
    process.off("SIGINT", markStopping);
    process.off("SIGTERM", markStopping);
  }
  if (!stopping) {
    await waitForSupervisorStop();
  }
}

async function runCampaign(arguments_: string[]): Promise<void> {
  const { values } = parseArgs({
    args: arguments_,
    options: {
      "base-url": { type: "string", default: "http://127.0.0.1:3000" },
      "run-dir": { type: "string" },
      "target-seconds": { type: "string", default: String(72 * 60 * 60) },
      "checkpoint-seconds": {
        type: "string",
        default: String(4 * 60 * 60),
      },
      "max-wall-seconds": {
        type: "string",
        default: String(120 * 60 * 60),
      },
      "interval-seconds": { type: "string", default: "60" },
      "request-timeout-seconds": { type: "string", default: "15" },
      "max-consecutive-errors": { type: "string", default: "3" },
      "pause-retry-seconds": { type: "string", default: "300" },
      confirm: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.confirm !== START_CONFIRMATION) {
    throw new Error(
      `Starting formal TEST requires --confirm ${START_CONFIRMATION}`,
    );
  }
  const runDirectory = requiredDirectory(values["run-dir"]);
  const baseUrl = normalizeBaseUrl(values["base-url"] as string);
  const targetSeconds = positiveNumber(values["target-seconds"], "target-seconds");
  const checkpointSeconds = positiveNumber(
    values["checkpoint-seconds"],
    "checkpoint-seconds",
  );
  const maxWallSeconds = positiveNumber(
    values["max-wall-seconds"],
    "max-wall-seconds",
  );
  const intervalSeconds = positiveNumber(
    values["interval-seconds"],
    "interval-seconds",
  );
  const requestTimeoutSeconds = positiveNumber(
    values["request-timeout-seconds"],
    "request-timeout-seconds",
  );
  const maxConsecutiveErrors = positiveInteger(
    values["max-consecutive-errors"],
    "max-consecutive-errors",
  );
  const pauseRetrySeconds = positiveNumber(
    values["pause-retry-seconds"],
    "pause-retry-seconds",
  );
  await mkdir(runDirectory, { recursive: true });
  const lockPath = resolve(runDirectory, "runner.lock");
  const lock = await open(lockPath, "wx");
  let campaign: FormalTestCampaign | null = null;
  let exitCode = 0;
  let lifecycleStarted = false;
  let interrupted = false;
  const stopController = new AbortController();
  const requestStop = () => {
    interrupted = true;
    stopController.abort();
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    await assertNewCampaignDirectory(runDirectory);
    lifecycleStarted = true;
    const preflight = await fetchSnapshot(
      baseUrl,
      requestTimeoutSeconds,
      false,
    );
    const preflightErrors = evaluateAvailablePaperSoakSafety({
      status: {
        httpStatus: preflight.status.status,
        payload: preflight.status.payload,
      },
      validation: {
        httpStatus: preflight.validation.status,
        payload: preflight.validation.payload,
      },
      requireRunning: false,
    });
    const parsedStatus = preflightStatusSchema.parse(preflight.status.payload);
    if (parsedStatus.strategy.status !== "PAUSED") {
      preflightErrors.push(
        `Formal TEST must start from PAUSED, got ${parsedStatus.strategy.status}`,
      );
    }
    if (preflightErrors.length > 0) {
      throw new Error(`Formal TEST preflight failed: ${preflightErrors.join("; ")}`);
    }
    const initialPreferences = parsePreferences(
      preflight.preferences.payload,
      parsedStatus.strategy.initialCapitalMicros,
    );
    const initialConfiguration = initialPreferences.configuration;
    const startedAt = new Date().toISOString();
    const runId = basename(runDirectory) || `formal-${startedAt}`;
    campaign = createFormalTestCampaign({
      runId,
      startedAt,
      targetAcceptedSeconds: targetSeconds,
      checkpointSeconds,
      sampleIntervalSeconds: intervalSeconds,
    });
    await writeJson(resolve(runDirectory, manifestFile), {
      version: 1,
      runId,
      baseUrl,
      startedAt,
      targetAcceptedSeconds: targetSeconds,
      checkpointSeconds,
      maxWallSeconds,
      intervalSeconds,
      requestTimeoutSeconds,
      maxConsecutiveErrors,
      pauseRetrySeconds,
      initialConfiguration,
      preflight: {
        status: preflight.status.payload,
        validation: preflight.validation.payload,
        preferences: preflight.preferences.payload,
      },
    });
    await persistCampaign(runDirectory, campaign);
    const startResponse = await fetchJson(`${baseUrl}/api/test/start`, {
      method: "POST",
      timeoutSeconds: requestTimeoutSeconds,
    });
    const startedStrategy = strategyResponseSchema.parse(startResponse.payload);
    if (startResponse.status !== 200 || startedStrategy.strategy.status !== "RUNNING") {
      throw new Error("Formal TEST start did not return RUNNING");
    }
    await appendRecord(runDirectory, {
      type: "campaign_started",
      startedAt,
      configuration: initialConfiguration,
    });

    const deadlineMs = Date.parse(startedAt) + maxWallSeconds * 1_000;
    let consecutiveErrors = 0;
    let nextSampleAtMs = Date.now();
    while (!interrupted && Date.now() < deadlineMs) {
      const stopRequest = await latestStopRequest(runDirectory);
      if (stopRequest !== null) {
        campaign = await applyRecordedDecisions(runDirectory, campaign);
        campaign = finishFormalTestCampaign(campaign, {
          finishedAt: stopRequest.requestedAt,
          reason: "CAMPAIGN_FINISHED",
        });
        break;
      }
      const sampledAt = new Date().toISOString();
      try {
        const snapshot = await fetchSnapshot(
          baseUrl,
          requestTimeoutSeconds,
          true,
        );
        let sample: PaperSoakSample;
        try {
          sample = evaluatePaperSoakSample({
            sampledAt,
            requestDurationMs: snapshot.requestDurationMs,
            statusHttpStatus: snapshot.status.status,
            validationHttpStatus: snapshot.validation.status,
            statusPayload: snapshot.status.payload,
            validationPayload: snapshot.validation.payload,
            requireRunning: true,
          });
        } catch (error) {
          if (snapshot.availableCriticalErrors.length > 0) {
            throw new FormalTestSnapshotError(
              errorMessage(error),
              snapshot.availableCriticalErrors,
            );
          }
          throw error;
        }
        if (sample.criticalErrors.length > 0) {
          const configuration =
            campaign.currentSegment?.configuration ?? initialConfiguration;
          campaign = observeFormalTestCampaign(campaign, {
            sampledAt,
            configuration,
            warningCount: sample.warnings.length,
            criticalErrors: sample.criticalErrors,
            transportError: false,
            metrics: toFormalTestSampleMetrics(sample),
          });
          await appendRecord(runDirectory, {
            ...sample,
            configuration,
          });
          campaign = finishFormalTestCampaign(campaign, {
            finishedAt: sampledAt,
            reason: "HARD_FAILURE",
          });
          exitCode = 1;
          break;
        }
        const preferences = parsePreferences(
          snapshot.preferences.payload,
          sample.strategy.initialCapitalMicros,
        );
        const configuration = preferences.configuration;
        campaign = observeFormalTestCampaign(campaign, {
          sampledAt,
          configuration,
          configurationUpdatedAt: preferences.updatedAt,
          warningCount: sample.warnings.length,
          criticalErrors: sample.criticalErrors,
          transportError: false,
          metrics: toFormalTestSampleMetrics(sample),
        });
        consecutiveErrors = 0;
        await appendRecord(runDirectory, {
          ...sample,
          configuration,
        });
      } catch (error) {
        consecutiveErrors += 1;
        const criticalErrors =
          error instanceof FormalTestSnapshotError &&
          error.criticalErrors.length > 0
            ? error.criticalErrors
            : consecutiveErrors >= maxConsecutiveErrors
            ? [`Formal TEST sampling failed ${consecutiveErrors} consecutive times`]
            : [];
        const configuration =
          campaign.currentSegment?.configuration ?? initialConfiguration;
        campaign = observeFormalTestCampaign(campaign, {
          sampledAt,
          configuration,
          warningCount: 0,
          criticalErrors,
          transportError: true,
        });
        await appendRecord(runDirectory, {
          type: "transport_error",
          sampledAt,
          error: errorMessage(error),
          consecutiveErrorCount: consecutiveErrors,
          criticalErrors,
        });
        if (criticalErrors.length > 0) {
          campaign = finishFormalTestCampaign(campaign, {
            finishedAt: sampledAt,
            reason: "HARD_FAILURE",
          });
          exitCode = 1;
          break;
        }
      }

      campaign = await applyRecordedDecisions(runDirectory, campaign);
      if (campaign.status === "TARGET_REACHED") {
        campaign = finishFormalTestCampaign(campaign, {
          finishedAt: new Date().toISOString(),
          reason: "CAMPAIGN_FINISHED",
        });
        break;
      }
      await persistCampaign(runDirectory, campaign);
      nextSampleAtMs += intervalSeconds * 1_000;
      if (nextSampleAtMs <= Date.now()) {
        nextSampleAtMs = Date.now() + intervalSeconds * 1_000;
      }
      try {
        await delay(Math.max(0, nextSampleAtMs - Date.now()), undefined, {
          signal: stopController.signal,
        });
      } catch (error) {
        if (!interrupted) throw error;
      }
    }

    campaign = await applyRecordedDecisions(runDirectory, campaign);
    if (campaign.status === "RUNNING" || campaign.status === "TARGET_REACHED") {
      campaign = finishFormalTestCampaign(campaign, {
        finishedAt: new Date().toISOString(),
        reason: "CAMPAIGN_FINISHED",
      });
    }
    const pauseConfirmed = await pauseStrategyWithRetries(
      baseUrl,
      requestTimeoutSeconds,
      pauseRetrySeconds,
    );
    await appendRecord(runDirectory, {
      type: "campaign_finished",
      finishedAt: new Date().toISOString(),
      status: campaign.status,
      pauseConfirmed,
    });
    await persistCampaign(runDirectory, campaign);
    if (!pauseConfirmed) {
      exitCode = 1;
    } else if (interrupted && exitCode === 0) {
      exitCode = 130;
    }
  } catch (error) {
    exitCode = 1;
    if (campaign !== null) {
      campaign = finishFormalTestCampaign(campaign, {
        finishedAt: new Date().toISOString(),
        reason: "HARD_FAILURE",
      });
      await persistCampaign(runDirectory, campaign);
    }
    if (lifecycleStarted) {
      await pauseStrategyWithRetries(
        baseUrl,
        requestTimeoutSeconds,
        pauseRetrySeconds,
      ).catch(() => false);
    }
    console.error(errorMessage(error));
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    await lock.close();
    await unlink(lockPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  process.exitCode = exitCode;
}

async function showStatus(arguments_: string[]): Promise<void> {
  const runDirectory = parseRunDirectory(arguments_);
  const campaign = await applyRecordedDecisions(
    runDirectory,
    await readCampaign(runDirectory),
  );
  process.stdout.write(renderFormalTestReport(campaign));
}

async function recordDecision(arguments_: string[]): Promise<void> {
  const { values } = parseArgs({
    args: arguments_,
    options: {
      "run-dir": { type: "string" },
      "segment-id": { type: "string" },
      decision: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const runDirectory = requiredDirectory(values["run-dir"]);
  const segmentId = requiredString(values["segment-id"], "segment-id");
  const decision = values.decision === "include"
    ? "INCLUDED"
    : values.decision === "exclude"
      ? "EXCLUDED"
      : null;
  if (decision === null) {
    throw new Error("--decision must be include or exclude");
  }
  const record: DecisionRecord = {
    segmentId,
    decision,
    decidedAt: new Date().toISOString(),
  };
  const campaign = decideFormalTestSegment(
    await applyRecordedDecisions(
      runDirectory,
      await readCampaign(runDirectory),
    ),
    {
      segmentId,
      decision,
      decidedAt: record.decidedAt,
    },
  );
  await appendFile(
    resolve(runDirectory, decisionsFile),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
  process.stdout.write(renderFormalTestReport(campaign));
}

async function stopCampaign(arguments_: string[]): Promise<void> {
  const runDirectory = parseRunDirectory(arguments_);
  const manifest = JSON.parse(
    await readFile(resolve(runDirectory, manifestFile), "utf8"),
  ) as {
    baseUrl: string;
    requestTimeoutSeconds: number;
    pauseRetrySeconds?: number;
  };
  const record: ControlRecord = {
    command: "STOP",
    requestedAt: new Date().toISOString(),
  };
  await appendFile(
    resolve(runDirectory, controlFile),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
  if (
    !(await pauseStrategyWithRetries(
      manifest.baseUrl,
      manifest.requestTimeoutSeconds,
      manifest.pauseRetrySeconds ?? 300,
    ))
  ) {
    throw new Error("Formal TEST stop was recorded but PAUSED was not confirmed");
  }
  let campaign = await applyRecordedDecisions(
    runDirectory,
    await readCampaign(runDirectory),
  );
  if (campaign.status === "RUNNING") {
    campaign = finishFormalTestCampaign(campaign, {
      finishedAt: record.requestedAt,
      reason: "CAMPAIGN_FINISHED",
    });
    await persistCampaign(runDirectory, campaign);
  }
}

async function fetchSnapshot(
  baseUrl: string,
  timeoutSeconds: number,
  requireRunning: boolean,
) {
  const startedAt = Date.now();
  const [statusResult, validationResult, preferencesResult] =
    await Promise.allSettled([
      fetchJson(`${baseUrl}/api/status?compact=true`, { timeoutSeconds }),
      fetchJson(`${baseUrl}/api/test/validation`, { timeoutSeconds }),
      fetchJson(`${baseUrl}/api/test/preferences`, { timeoutSeconds }),
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
  const rejected = [statusResult, validationResult, preferencesResult].filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected.length > 0) {
    throw new FormalTestSnapshotError(
      rejected.map((result) => errorMessage(result.reason)).join("; "),
      availableCriticalErrors,
    );
  }
  if (
    statusResult.status !== "fulfilled" ||
    validationResult.status !== "fulfilled" ||
    preferencesResult.status !== "fulfilled"
  ) {
    throw new Error("Formal TEST snapshot result was unavailable");
  }
  return {
    status: statusResult.value,
    validation: validationResult.value,
    preferences: preferencesResult.value,
    requestDurationMs: Date.now() - startedAt,
    availableCriticalErrors,
  };
}

async function fetchJson(
  url: string,
  input: { method?: "GET" | "POST"; timeoutSeconds: number },
): Promise<{ status: number; payload: unknown }> {
  const response = await fetch(url, {
    method: input.method ?? "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(input.timeoutSeconds * 1_000),
  });
  return { status: response.status, payload: await response.json() };
}

async function pauseStrategy(
  baseUrl: string,
  timeoutSeconds: number,
): Promise<boolean> {
  try {
    const response = await fetchJson(`${baseUrl}/api/test/pause`, {
      method: "POST",
      timeoutSeconds,
    });
    const parsed = strategyResponseSchema.safeParse(response.payload);
    return (
      response.status === 200 &&
      parsed.success &&
      parsed.data.strategy.status === "PAUSED"
    );
  } catch {
    return false;
  }
}

async function pauseStrategyWithRetries(
  baseUrl: string,
  timeoutSeconds: number,
  retrySeconds: number,
): Promise<boolean> {
  const deadlineMs = Date.now() + retrySeconds * 1_000;
  do {
    if (await pauseStrategy(baseUrl, timeoutSeconds)) return true;
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) return false;
    await delay(Math.min(2_000, remainingMs));
  } while (Date.now() <= deadlineMs);
  return false;
}

function parsePreferences(
  payload: unknown,
  initialCapitalMicros: number,
): {
  configuration: FormalTestConfiguration;
  updatedAt: string;
} {
  const preferences = preferencesResponseSchema.parse(payload).preferences;
  return {
    configuration: {
      marketTypes: preferences.marketTypes,
      allCategories: preferences.allCategories,
      selectedCategoryIds: preferences.selectedCategoryIds,
      candidateSortDirection: preferences.candidateSortDirection,
      minMarketDurationDays: preferences.minMarketDurationDays,
      maxMarketDurationDays: preferences.maxMarketDurationDays,
      maxBuyPriceCents: preferences.maxBuyPriceCents,
      minBidAskRatioPercent: preferences.minBidAskRatioPercent,
      maxMarketProgressPercent: preferences.maxMarketProgressPercent,
      orderAmount: preferences.orderAmount,
      initialCapitalMicros,
    },
    updatedAt: preferences.updatedAt,
  };
}

function toFormalTestSampleMetrics(
  sample: PaperSoakSample,
): FormalTestSampleMetrics {
  const diagnostics = sample.scan.diagnostics;
  return {
    requestDurationMs: sample.http.requestDurationMs,
    rssBytes: sample.runtime.rssBytes,
    heapUsedBytes: sample.runtime.heapUsedBytes,
    candidateCount: sample.scan.candidateCount,
    scanDurationMs: diagnostics?.durationMs ?? 0,
    scanRetryCount: diagnostics?.retryCount ?? 0,
    scanRateLimitCount: diagnostics?.rateLimitCount ?? 0,
    scanTransientErrorCount: diagnostics?.transientErrorCount ?? 0,
    subscribedTokenCount: sample.marketStream.subscribedTokenCount,
    dataCompleteTokenCount: sample.marketStream.dataCompleteTokenCount,
    unexpectedDisconnectCount:
      sample.marketStream.unexpectedDisconnectCount,
    recoveryCount: sample.marketStream.recoveryCount,
    paperBuyFillCount: sample.marketStream.paperBuyFillCount,
    paperSellFillCount: sample.marketStream.paperSellFillCount,
    placedBuyCount: sample.paperAutomation.placedBuyCount,
    settledMarketCount: sample.paperSettlement.settledMarketCount,
    validationCount: sample.periodicValidation.validationCount,
  };
}

async function persistCampaign(
  runDirectory: string,
  campaign: FormalTestCampaign,
): Promise<void> {
  await writeJson(resolve(runDirectory, campaignFile), campaign);
  await writeText(
    resolve(runDirectory, reportFile),
    renderFormalTestReport(campaign),
  );
}

async function applyRecordedDecisions(
  runDirectory: string,
  current: FormalTestCampaign,
): Promise<FormalTestCampaign> {
  let content: string;
  try {
    content = await readFile(resolve(runDirectory, decisionsFile), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return current;
    throw error;
  }
  let campaign = current;
  for (const line of content.split("\n").filter(Boolean)) {
    const record = JSON.parse(line) as DecisionRecord;
    campaign = decideFormalTestSegment(campaign, record);
  }
  return campaign;
}

async function latestStopRequest(
  runDirectory: string,
): Promise<ControlRecord | null> {
  try {
    const records = (await readFile(resolve(runDirectory, controlFile), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ControlRecord);
    return records.at(-1) ?? null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function appendRecord(runDirectory: string, record: unknown): Promise<void> {
  await appendFile(
    resolve(runDirectory, observationsFile),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
}

async function assertNewCampaignDirectory(runDirectory: string): Promise<void> {
  try {
    await readFile(resolve(runDirectory, campaignFile), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(
    `Run directory already contains a formal TEST campaign: ${runDirectory}`,
  );
}

async function campaignFileExists(runDirectory: string): Promise<boolean> {
  try {
    await readFile(resolve(runDirectory, campaignFile), "utf8");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readCampaign(runDirectory: string): Promise<FormalTestCampaign> {
  return JSON.parse(
    await readFile(resolve(runDirectory, campaignFile), "utf8"),
  ) as FormalTestCampaign;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, value, "utf8");
  await rename(temporary, path);
}

function parseRunDirectory(arguments_: string[]): string {
  const { values } = parseArgs({
    args: arguments_,
    options: { "run-dir": { type: "string" } },
    strict: true,
    allowPositionals: false,
  });
  return requiredDirectory(values["run-dir"]);
}

function runDirectoryFromRunArguments(arguments_: string[]): string {
  const index = arguments_.indexOf("--run-dir");
  return requiredDirectory(index === -1 ? undefined : arguments_[index + 1]);
}

async function waitForSupervisorStop(): Promise<void> {
  await new Promise<void>((resolveStop) => {
    const keepAlive = setInterval(() => undefined, 60 * 60 * 1_000);
    const finish = () => {
      clearInterval(keepAlive);
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolveStop();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

function requiredDirectory(value: string | undefined): string {
  return resolve(requiredString(value, "run-dir"));
}

function requiredString(value: string | undefined, name: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
