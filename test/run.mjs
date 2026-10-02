// Bundles test/*.test.ts with esbuild ("obsidian" → test/obsidian-stub.ts) and
// runs them with node's built-in test runner.
import esbuild from "esbuild";
import { readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

const out = ".test-dist";
rmSync(out, { recursive: true, force: true });
const entries = readdirSync("test")
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `test/${f}`);

await esbuild.build({
  entryPoints: entries,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  outdir: out,
  outExtension: { ".js": ".mjs" },
  alias: { obsidian: "./test/obsidian-stub.ts" },
  logLevel: "warning",
});

const files = entries.map((e) => `${out}/${basename(e, ".ts")}.mjs`);
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
