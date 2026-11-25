import { readFile } from "node:fs/promises";

const [reportPath] = process.argv.slice(2);
if (!reportPath) throw new Error("usage: node scripts/compare-editor-performance.mjs <performance-report.json>");
const report = JSON.parse(await readFile(reportPath, "utf8"));
const MAX_RATIO = 1.25;
const MIN_REGRESSION_MS = 0.75;
let failed = false;

for (const result of report.results) {
  if (result.baselineMs === null || result.candidateMs === null) {
    if (result.baselineAvailable && !result.candidateAvailable) {
      console.error(`${result.name}: analyzer was removed from the candidate`);
      failed = true;
    } else if (result.candidateAvailable && !result.baselineAvailable) {
      console.log(`${result.name}: candidate ${result.candidateMs.toFixed(2)} ms; comparison starts after the analyzer lands on the merge target`);
    } else {
      console.log(`${result.name}: analyzer not available yet`);
    }
    continue;
  }
  const ratio = result.candidateMs / Math.max(result.baselineMs, 0.01);
  const delta = result.candidateMs - result.baselineMs;
  const regressed = ratio > MAX_RATIO && delta > MIN_REGRESSION_MS;
  console.log(`${result.name}: ${result.baselineMs.toFixed(2)} ms -> ${result.candidateMs.toFixed(2)} ms (${ratio.toFixed(2)}x)${regressed ? " REGRESSION" : ""}`);
  if (regressed) failed = true;
}

if (failed) process.exitCode = 1;
