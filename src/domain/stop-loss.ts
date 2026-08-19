const PRICE_SCALE = 1_000_000;

export const DEFAULT_STOP_LOSS_MULTIPLIER_MICROS = 400_000;
export const STOP_LOSS_CONFIRMATION_WINDOW_MS = 30_000;

export type StopLossSettings = {
  enabled: boolean;
  multiplierMicros: number;
};

export function calculateStopLossThresholdMicros(
  entryPriceMicros: number,
  multiplierMicros: number,
): number {
  if (!Number.isSafeInteger(entryPriceMicros) || entryPriceMicros <= 0) {
    throw new Error("Stop-loss entry price must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(multiplierMicros) ||
    multiplierMicros <= 0 ||
    multiplierMicros >= PRICE_SCALE
  ) {
    throw new Error("Stop-loss multiplier must be greater than 0 and less than 1");
  }
  return Math.max(
    1,
    Number(
      (BigInt(entryPriceMicros) * BigInt(multiplierMicros)) /
        BigInt(PRICE_SCALE),
    ),
  );
}
