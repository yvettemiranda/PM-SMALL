import type {
  ImmediateBuyIntent,
  TargetSellIntent,
  TradingExecutionAdapter,
} from "../../domain/execution.js";

export class LiveExecutionDisabledError extends Error {
  public constructor() {
    super("Live execution is disabled in the first development phase");
    this.name = "LiveExecutionDisabledError";
  }
}

export class LiveExecutorDisabled implements TradingExecutionAdapter {
  public readonly mode = "LIVE";
  public readonly enabled = false;

  public executeBuy(_intent: ImmediateBuyIntent): never {
    throw new LiveExecutionDisabledError();
  }

  public executeTargetSells(_intent: TargetSellIntent): never {
    throw new LiveExecutionDisabledError();
  }

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
