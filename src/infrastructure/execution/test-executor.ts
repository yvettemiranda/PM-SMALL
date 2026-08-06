import type {
  ImmediateBuyExecution,
  ImmediateBuyIntent,
  TargetSellExecution,
  TargetSellIntent,
  TradingExecutionAdapter,
} from "../../domain/execution.js";
import type { PaperDatabase } from "../db/database.js";

export class TestExecutor implements TradingExecutionAdapter {
  public readonly mode = "TEST";
  public readonly enabled = true;

  public constructor(private readonly database: PaperDatabase) {}

  public executeBuy(intent: ImmediateBuyIntent): ImmediateBuyExecution {
    return this.database.executeTestFakBuy(intent);
  }

  public executeTargetSells(intent: TargetSellIntent): TargetSellExecution {
    return this.database.executeTestFakSells(intent);
  }
}
