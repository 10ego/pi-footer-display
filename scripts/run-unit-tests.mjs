import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(rootDir, ".test-dist");
const tscCommand = path.join(rootDir, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");

function run(command, args) {
  const result = spawnSync(command, args, { cwd: rootDir, stdio: "inherit", shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

fs.rmSync(outputDir, { recursive: true, force: true });
try {
  run(tscCommand, ["-p", "tsconfig.test.json"]);
  const testDir = path.join(outputDir, "tests");
  const testFiles = fs.readdirSync(testDir)
    .filter((fileName) => fileName.endsWith(".test.js"))
    .sort()
    .map((fileName) => path.join(testDir, fileName));
  if (testFiles.length === 0) throw new Error("TypeScript compilation produced no unit test files");
  run(process.execPath, ["--test", ...testFiles]);
} finally {
  fs.rmSync(outputDir, { recursive: true, force: true });
}
