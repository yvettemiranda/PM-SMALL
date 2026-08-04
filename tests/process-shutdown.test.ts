import { describe, expect, it } from "vitest";
import { runShutdownWithDeadline } from "../src/services/process-shutdown.js";

describe("runShutdownWithDeadline", () => {
  it("returns a failure within the deadline when cleanup never settles", async () => {
    const startedAt = Date.now();

    const outcome = await runShutdownWithDeadline(
      () => new Promise<void>(() => {}),
      10,
    );

    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(outcome).toEqual({
      exitCode: 1,
      error: "Server shutdown timed out after 10ms",
    });
  });

  it("reports successful and failed cleanup", async () => {
    await expect(
      runShutdownWithDeadline(async () => undefined, 100),
    ).resolves.toEqual({ exitCode: 0, error: null });
    await expect(
      runShutdownWithDeadline(async () => {
        throw new Error("database close failed");
      }, 100),
    ).resolves.toEqual({ exitCode: 1, error: "database close failed" });
  });
});
