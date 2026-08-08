import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("formal TEST campaign server wrapper", () => {
  const scriptPath = resolve("scripts/formal-test-campaign.sh");

  it("has valid Bash syntax and keeps start behind explicit confirmation", () => {
    expect(() =>
      execFileSync("bash", ["-n", scriptPath], { stdio: "pipe" }),
    ).not.toThrow();
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain('start_confirmation="START-TEST-72H"');
    expect(script).toContain('if [[ $# -ne 2 || "$1" != "--confirm"');
    expect(script).toContain("--checkpoint-seconds 14400");
    expect(script).toContain("--target-seconds 259200");
    expect(script).toContain("read_image_runtime_identity()");
    expect(script).toContain(
      'monitor_identity="$(read_image_runtime_identity "$image")"',
    );
    expect(script).toContain(
      'chown -R "$monitor_identity" "$run_directory"',
    );
    expect(
      script.indexOf('chown -R "$monitor_identity" "$run_directory"'),
    ).toBeLessThan(script.indexOf("docker run -d"));
  });
});
