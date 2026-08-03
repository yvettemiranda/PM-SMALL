export class LiveExecutionDisabledError extends Error {
  public constructor() {
    super("Live execution is disabled in the first development phase");
    this.name = "LiveExecutionDisabledError";
  }
}

export class LiveExecutorDisabled {
  public readonly enabled = false;

  public async placeOrder(): Promise<never> {
    throw new LiveExecutionDisabledError();
  }

  public async cancelOrder(): Promise<never> {
    throw new LiveExecutionDisabledError();
  }

  public async redeem(): Promise<never> {
    throw new LiveExecutionDisabledError();
  }
}
