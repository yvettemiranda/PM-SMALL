export type PaperFillInput = {
  queueAheadSizeMicros: number;
  observedTradeSizeMicros: number;
  originalSizeMicros: number;
  filledSizeMicros: number;
  incomingTradeSizeMicros: number;
};

export type PaperFillResult = {
  nextObservedTradeSizeMicros: number;
  nextFilledSizeMicros: number;
  incrementalFillSizeMicros: number;
};

export function calculateConservativePaperFill(
  input: PaperFillInput,
): PaperFillResult {
  const nextObservedTradeSizeMicros =
    input.observedTradeSizeMicros + input.incomingTradeSizeMicros;
  const volumeAfterQueue = Math.max(
    0,
    nextObservedTradeSizeMicros - input.queueAheadSizeMicros,
  );
  const nextFilledSizeMicros = Math.min(
    input.originalSizeMicros,
    volumeAfterQueue,
  );

  return {
    nextObservedTradeSizeMicros,
    nextFilledSizeMicros: Math.max(input.filledSizeMicros, nextFilledSizeMicros),
    incrementalFillSizeMicros: Math.max(
      0,
      nextFilledSizeMicros - input.filledSizeMicros,
    ),
  };
}
