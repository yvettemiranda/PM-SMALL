import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

describe("paper soak CLI", () => {
  const servers: Server[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails on a returned LIVE status even when validation times out", async () => {
    const { baseUrl, server } = await listen((request, response) => {
      if (request.url?.startsWith("/api/status")) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(makeLiveStatus()));
      }
      // Deliberately leave validation open until the CLI aborts it.
    });
    servers.push(server);
    const output = createOutputPath();

    const result = await runCli(baseUrl, output, [
      "--duration-seconds",
      "0.3",
      "--interval-seconds",
      "0.05",
      "--request-timeout-seconds",
      "0.1",
    ]);

    expect(result.code).toBe(1);
    const summary = readRecords(output).at(-1);
    expect(summary).toMatchObject({ type: "summary", result: "FAILED" });
    expect(summary?.criticalErrors).toEqual(
      expect.arrayContaining(["Live execution is enabled"]),
    );
  });

  it("retains LIVE when validation returns an HTTP error object", async () => {
    const { baseUrl, server } = await listen((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.startsWith("/api/status")) {
        response.end(JSON.stringify(makeLiveStatus()));
      } else {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "temporarily unavailable" }));
      }
    });
    servers.push(server);
    const output = createOutputPath();

    const result = await runCli(baseUrl, output, [
      "--duration-seconds",
      "0.3",
      "--interval-seconds",
      "0.05",
      "--request-timeout-seconds",
      "0.1",
    ]);

    expect(result.code).toBe(1);
    const records = readRecords(output);
    expect(records[0]).toMatchObject({
      type: "safety_failure",
      criticalErrors: expect.arrayContaining([
        "Live execution is enabled",
        "Validation endpoint returned HTTP 500",
      ]),
    });
    expect(records.at(-1)).toMatchObject({
      type: "summary",
      result: "FAILED",
    });
  });

  it("cannot complete without a valid sample", async () => {
    const { baseUrl, server } = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    servers.push(server);
    const output = createOutputPath();

    const result = await runCli(baseUrl, output, [
      "--duration-seconds",
      "0.12",
      "--interval-seconds",
      "0.1",
      "--request-timeout-seconds",
      "0.05",
      "--max-consecutive-errors",
      "10",
    ]);

    expect(result.code).toBe(1);
    expect(readRecords(output).at(-1)).toMatchObject({
      type: "summary",
      result: "FAILED",
      sampleCount: 0,
      criticalErrors: ["No valid PAPER soak sample was recorded"],
    });
  });

  function createOutputPath(): string {
    const directory = mkdtempSync(join(tmpdir(), "pm-small-soak-cli-"));
    directories.push(directory);
    return join(directory, "evidence.jsonl");
  }
});

async function listen(
  handler: RequestListener,
): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not expose a TCP port");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

function runCli(
  baseUrl: string,
  output: string,
  extraArguments: string[],
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "src/cli/paper-soak.ts",
        "--base-url",
        baseUrl,
        "--output",
        output,
        ...extraArguments,
      ],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

function readRecords(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function makeLiveStatus() {
  return {
    executionMode: "LIVE",
    liveExecutionEnabled: true,
    strategy: { mode: "PAPER", status: "RUNNING" },
    paperAutomation: { running: true },
    paperSettlement: { running: true },
    marketStream: { running: true },
    paperValidation: {
      running: true,
      failedValidationCount: 0,
      lastError: null,
      lastResult: {
        passed: true,
        errors: [],
        sqliteIntegrity: "ok",
      },
    },
  };
}
