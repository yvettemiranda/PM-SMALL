import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const tscPath = fileURLToPath(
  new URL("../node_modules/typescript/bin/tsc", import.meta.url),
);

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
execFileSync(process.execPath, [tscPath, "-p", "tsconfig.build.json"], {
  cwd: projectRoot,
  stdio: "inherit",
});
cpSync(new URL("../src/web", import.meta.url), new URL("../dist/web", import.meta.url), {
  recursive: true,
});
cpSync(
  new URL("../src/infrastructure/db/migrations", import.meta.url),
  new URL("../dist/infrastructure/db/migrations", import.meta.url),
  { recursive: true },
);
