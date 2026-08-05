import { z } from "zod";

const nullableString = z.string().nullable();

const scanDiagnosticsSchema = z.object({
  phase: z.enum(["EVENTS", "ORDER_BOOKS", "COMPLETE", "FAILED"]),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  durationMs: z.number().nonnegative(),
  eventPageCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  eligibleTokenCount: z.number().int().nonnegative(),
  orderBookBatchCount: z.number().int().nonnegative(),
  orderBookCount: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
});

const paperValidationResultSchema = z.object({
  passed: z.boolean(),
  errors: z.array(z.string()),
  sqliteIntegrity: z.string(),
  activeOrderCount: z.number().int().nonnegative(),
  openPositionCount: z.number().int().nonnegative(),
  pendingSettlementCount: z.number().int().nonnegative(),
  checkedAt: z.string(),
});

const runtimeSchema = z.object({
  uptimeSeconds: z.number().nonnegative(),
  rssBytes: z.number().int().nonnegative(),
  heapTotalBytes: z.number().int().nonnegative(),
  heapUsedBytes: z.number().int().nonnegative(),
  externalBytes: z.number().int().nonnegative(),
});

const statusSchema = z.object({
  version: z.string(),
  executionMode: z.string(),
  liveExecutionEnabled: z.boolean(),
  strategy: z.object({
    mode: z.string(),
    status: z.string(),
    initialCapitalMicros: z.number(),
    availableCashMicros: z.number(),
    reservedCashMicros: z.number(),
    realizedPnlMicros: z.number(),
    positionCostMicros: z.number(),
  }),
  configuration: z.object({
    maxMarketDurationDays: z.number().positive(),
  }),
  runtime: runtimeSchema,
  marketScan: z.object({
    candidateCount: z.number().int().nonnegative(),
    lastScanAt: nullableString,
    lastError: nullableString,
    scanning: z.boolean(),
    diagnostics: scanDiagnosticsSchema.nullable().optional(),
  }),
  marketStream: z.object({
    running: z.boolean(),
    connected: z.boolean(),
    subscribedTokenCount: z.number().int().nonnegative(),
    dataCompleteTokenCount: z.number().int().nonnegative(),
    lastEventAt: nullableString,
    processedTradeEvents: z.number().int().nonnegative(),
    ignoredTradeEvents: z.number().int().nonnegative(),
    paperBuyFillCount: z.number().int().nonnegative(),
    paperSellFillCount: z.number().int().nonnegative(),
    createdPaperSellCount: z.number().int().nonnegative(),
    connectionCount: z.number().int().nonnegative(),
    fullSnapshotCount: z.number().int().nonnegative(),
    unexpectedDisconnectCount: z.number().int().nonnegative(),
    recoveryCount: z.number().int().nonnegative(),
    lastFullSnapshotDurationMs: z.number().nonnegative().nullable(),
    lastRecoveryDurationMs: z.number().nonnegative().nullable(),
    lastError: nullableString,
  }),
  paperAutomation: z.object({
    running: z.boolean(),
    lastRunAt: nullableString,
    lastError: nullableString,
    placedBuyCount: z.number().int().nonnegative(),
    cancelledStartedBuyCount: z.number().int().nonnegative(),
    cancelledProgressedBuyCount: z.number().int().nonnegative(),
  }),
  paperSettlement: z.object({
    running: z.boolean(),
    lastRunAt: nullableString,
    lastError: nullableString,
    checkedMarketCount: z.number().int().nonnegative(),
    waitingMarketCount: z.number().int().nonnegative(),
    settledMarketCount: z.number().int().nonnegative(),
  }),
  paperValidation: z.object({
    running: z.boolean(),
    validationCount: z.number().int().nonnegative(),
    failedValidationCount: z.number().int().nonnegative(),
    lastRunAt: nullableString,
    lastError: nullableString,
    lastResult: paperValidationResultSchema.nullable(),
  }),
});

const validationResponseSchema = z.object({
  validation: paperValidationResultSchema,
});

const statusSafetySchema = z.object({
  executionMode: z.string(),
  liveExecutionEnabled: z.boolean(),
  strategy: z.object({ mode: z.string(), status: z.string() }),
  marketStream: z.object({ running: z.boolean() }),
  paperAutomation: z.object({ running: z.boolean() }),
  paperSettlement: z.object({ running: z.boolean() }),
  paperValidation: z.object({
    running: z.boolean(),
    failedValidationCount: z.number().int().nonnegative(),
    lastError: nullableString,
    lastResult: z
      .object({
        passed: z.boolean(),
        errors: z.array(z.string()),
        sqliteIntegrity: z.string(),
      })
      .nullable(),
  }),
});

const validationSafetySchema = z.object({
  validation: z.object({
    passed: z.boolean(),
    errors: z.array(z.string()),
    sqliteIntegrity: z.string(),
  }),
});

type AvailableEndpoint = { httpStatus: number; payload: unknown };

export type AvailablePaperSoakSafetyInput = {
  status?: AvailableEndpoint | undefined;
  validation?: AvailableEndpoint | undefined;
  requireRunning: boolean;
};

export type PaperSoakEvaluationInput = {
  sampledAt: string;
  requestDurationMs: number;
  statusHttpStatus: number;
  validationHttpStatus: number;
  statusPayload: unknown;
  validationPayload: unknown;
  requireRunning: boolean;
};

export type PaperSoakSample = {
  type: "sample";
  sampledAt: string;
  version: string;
  http: {
    requestDurationMs: number;
    statusCode: number;
    validationStatusCode: number;
  };
  safety: {
    executionMode: string;
    liveExecutionEnabled: boolean;
    strategyMode: string;
    strategyStatus: string;
  };
  configuration: { maxMarketDurationDays: number };
  runtime: z.infer<typeof runtimeSchema>;
  strategy: {
    initialCapitalMicros: number;
    availableCashMicros: number;
    reservedCashMicros: number;
    realizedPnlMicros: number;
    positionCostMicros: number;
  };
  scan: {
    candidateCount: number;
    lastScanAt: string | null;
    lastError: string | null;
    scanning: boolean;
    diagnostics: z.infer<typeof scanDiagnosticsSchema> | null;
  };
  marketStream: z.infer<typeof statusSchema>["marketStream"];
  paperAutomation: z.infer<typeof statusSchema>["paperAutomation"];
  paperSettlement: z.infer<typeof statusSchema>["paperSettlement"];
  periodicValidation: z.infer<typeof statusSchema>["paperValidation"];
  ledgerValidation: z.infer<typeof paperValidationResultSchema>;
  warnings: string[];
  criticalErrors: string[];
};

export function evaluatePaperSoakSample(
  input: PaperSoakEvaluationInput,
): PaperSoakSample {
  const status = statusSchema.parse(input.statusPayload);
  const ledgerValidation = validationResponseSchema.parse(
    input.validationPayload,
  ).validation;
  const warnings: string[] = [];
  const criticalErrors = [
    ...collectStatusCriticalErrors(
      status,
      input.statusHttpStatus,
      input.requireRunning,
    ),
    ...collectValidationCriticalErrors(
      ledgerValidation,
      input.validationHttpStatus,
    ),
  ];

  addWarning(warnings, "Market scan error", status.marketScan.lastError);
  addWarning(
    warnings,
    "Paper automation error",
    status.paperAutomation.lastError,
  );
  addWarning(
    warnings,
    "Paper settlement error",
    status.paperSettlement.lastError,
  );
  addWarning(warnings, "Market stream error", status.marketStream.lastError);
  if (status.marketScan.lastScanAt === null) {
    warnings.push("Market scan has not completed yet");
  }
  if ((status.marketScan.diagnostics ?? null) === null) {
    warnings.push("Market scan diagnostics are not available yet");
  }
  if (
    status.marketStream.subscribedTokenCount > 0 &&
    !status.marketStream.connected
  ) {
    warnings.push("Market stream is disconnected with active subscriptions");
  }
  if (
    status.marketStream.connected &&
    status.marketStream.dataCompleteTokenCount <
      status.marketStream.subscribedTokenCount
  ) {
    warnings.push(
      `Market stream data is incomplete: ${status.marketStream.dataCompleteTokenCount}/${status.marketStream.subscribedTokenCount}`,
    );
  }

  return {
    type: "sample",
    sampledAt: input.sampledAt,
    version: status.version,
    http: {
      requestDurationMs: input.requestDurationMs,
      statusCode: input.statusHttpStatus,
      validationStatusCode: input.validationHttpStatus,
    },
    safety: {
      executionMode: status.executionMode,
      liveExecutionEnabled: status.liveExecutionEnabled,
      strategyMode: status.strategy.mode,
      strategyStatus: status.strategy.status,
    },
    configuration: {
      maxMarketDurationDays: status.configuration.maxMarketDurationDays,
    },
    runtime: status.runtime,
    strategy: {
      initialCapitalMicros: status.strategy.initialCapitalMicros,
      availableCashMicros: status.strategy.availableCashMicros,
      reservedCashMicros: status.strategy.reservedCashMicros,
      realizedPnlMicros: status.strategy.realizedPnlMicros,
      positionCostMicros: status.strategy.positionCostMicros,
    },
    scan: {
      candidateCount: status.marketScan.candidateCount,
      lastScanAt: status.marketScan.lastScanAt,
      lastError: status.marketScan.lastError,
      scanning: status.marketScan.scanning,
      diagnostics: status.marketScan.diagnostics ?? null,
    },
    marketStream: status.marketStream,
    paperAutomation: status.paperAutomation,
    paperSettlement: status.paperSettlement,
    periodicValidation: status.paperValidation,
    ledgerValidation,
    warnings,
    criticalErrors,
  };
}

export function evaluateAvailablePaperSoakSafety(
  input: AvailablePaperSoakSafetyInput,
): string[] {
  const criticalErrors: string[] = [];
  if (input.status !== undefined) {
    const parsed = statusSafetySchema.safeParse(input.status.payload);
    if (parsed.success) {
      criticalErrors.push(
        ...collectStatusCriticalErrors(
          parsed.data,
          input.status.httpStatus,
          input.requireRunning,
        ),
      );
    } else if (input.status.httpStatus !== 200) {
      criticalErrors.push(
        `Status endpoint returned HTTP ${input.status.httpStatus}`,
      );
    }
  }
  if (input.validation !== undefined) {
    const parsed = validationSafetySchema.safeParse(input.validation.payload);
    if (parsed.success) {
      criticalErrors.push(
        ...collectValidationCriticalErrors(
          parsed.data.validation,
          input.validation.httpStatus,
        ),
      );
    } else if (input.validation.httpStatus !== 200) {
      criticalErrors.push(
        `Validation endpoint returned HTTP ${input.validation.httpStatus}`,
      );
    }
  }
  return criticalErrors;
}

function collectStatusCriticalErrors(
  status: z.infer<typeof statusSafetySchema>,
  httpStatus: number,
  requireRunning: boolean,
): string[] {
  const errors: string[] = [];
  if (httpStatus !== 200) {
    errors.push(`Status endpoint returned HTTP ${httpStatus}`);
  }
  if (status.executionMode !== "PAPER") {
    errors.push(`Execution mode is not PAPER: ${status.executionMode}`);
  }
  if (status.liveExecutionEnabled) {
    errors.push("Live execution is enabled");
  }
  if (status.strategy.mode !== "PAPER") {
    errors.push(`Strategy mode is not PAPER: ${status.strategy.mode}`);
  }
  if (requireRunning && status.strategy.status !== "RUNNING") {
    errors.push(`Paper strategy is not RUNNING: ${status.strategy.status}`);
  }
  if (!status.paperValidation.running) {
    errors.push("Periodic paper validation service is not running");
  }
  if (status.paperValidation.lastResult === null) {
    errors.push("Periodic paper validation has no result");
  } else if (!status.paperValidation.lastResult.passed) {
    errors.push(
      `Periodic paper validation failed: ${joinErrors(
        status.paperValidation.lastResult.errors,
      )}`,
    );
  }
  if (status.paperValidation.lastError !== null) {
    errors.push(
      `Periodic paper validation error: ${status.paperValidation.lastError}`,
    );
  }
  if (status.paperValidation.failedValidationCount > 0) {
    errors.push(
      `Periodic paper validation recorded ${status.paperValidation.failedValidationCount} failed run`,
    );
  }
  if (!status.paperAutomation.running) {
    errors.push("Paper automation service is not running");
  }
  if (!status.paperSettlement.running) {
    errors.push("Paper settlement service is not running");
  }
  if (!status.marketStream.running) {
    errors.push("Market stream service is not running");
  }
  return errors;
}

function collectValidationCriticalErrors(
  validation: z.infer<typeof validationSafetySchema>["validation"],
  httpStatus: number,
): string[] {
  const errors: string[] = [];
  if (httpStatus !== 200) {
    errors.push(`Validation endpoint returned HTTP ${httpStatus}`);
  }
  if (!validation.passed) {
    errors.push(
      `Paper ledger validation failed: ${joinErrors(validation.errors)}`,
    );
  }
  if (validation.sqliteIntegrity !== "ok") {
    errors.push(
      `SQLite integrity check failed: ${validation.sqliteIntegrity}`,
    );
  }
  return errors;
}

function addWarning(
  warnings: string[],
  label: string,
  error: string | null,
): void {
  if (error !== null) {
    warnings.push(`${label}: ${error}`);
  }
}

function joinErrors(errors: readonly string[]): string {
  return errors.length === 0 ? "unknown error" : errors.join("; ");
}
