export type ShutdownOutcome = {
  exitCode: 0 | 1;
  error: string | null;
};

export async function runShutdownWithDeadline(
  shutdown: () => Promise<void>,
  timeoutMs: number,
): Promise<ShutdownOutcome> {
  let timer: NodeJS.Timeout | null = null;
  const cleanup: Promise<ShutdownOutcome> = Promise.resolve()
    .then(shutdown)
    .then(
      () => ({ exitCode: 0 as const, error: null }),
      (error: unknown) => ({
        exitCode: 1 as const,
        error: errorMessage(error),
      }),
    );
  const timeout = new Promise<ShutdownOutcome>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          exitCode: 1,
          error: `Server shutdown timed out after ${timeoutMs}ms`,
        }),
      timeoutMs,
    );
  });

  const outcome = await Promise.race([cleanup, timeout]);
  if (timer !== null) {
    clearTimeout(timer);
  }
  return outcome;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
