import { describe, expect, it } from "vitest";
import {
  LiveExecutionDisabledError,
  LiveExecutorDisabled,
} from "../src/infrastructure/execution/live-executor-disabled.js";

describe("LiveExecutorDisabled", () => {
  it("cannot submit a live order", async () => {
    const executor = new LiveExecutorDisabled();
    expect(executor.enabled).toBe(false);
    await expect(executor.placeOrder()).rejects.toBeInstanceOf(
      LiveExecutionDisabledError,
    );
  });
});
