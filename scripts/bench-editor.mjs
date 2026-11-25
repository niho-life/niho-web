import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const document = {
  schemaVersion: 1, siteId: "benchmark", pageId: "fixture", locale: "ja", revision: 1, title: "性能計測用の合成文書",
  tokens: { accent: { type: "color", value: "#446688" } },
  body: Array.from({ length: 50 }, (_, section) => ({
    type: "element", id: `section-${section}`, tag: "section",
    style: { base: { display: "grid", gap: 12, padding: 24 } },
    children: Array.from({ length: 19 }, (_, item) => ({
      type: "element", id: `item-${section}-${item}`, tag: "div",
      attrs: { title: "Synthetic document content. ".repeat(32) },
      style: {
        base: { color: { token: "accent" }, backgroundColor: "#ffffff", minHeight: 24 },
        responsive: [{ minWidth: 768, declarations: { minHeight: 48, padding: 8 } }]
      },
      children: []
    }))
  }))
};
const json = JSON.stringify(document);
const target = { siteId: document.siteId, pageId: document.pageId, locale: document.locale };
const change = { type: "style", path: [49, 18], breakpoint: "base", property: "color", value: "#123456" };
const outline = { view: "outline" };

async function loadApi(distDirectory) {
  const load = (name) => import(pathToFileURL(resolve(distDirectory, name)).href);
  const [documentModule, editorModel, editorSession, nodeTree, pageInspect] = await Promise.all([
    load("document.js"), load("editor-model.js"), load("editor-session.js"), load("node-tree.js"), load("page-inspect.js")
  ]);
  return { ...documentModule, ...editorModel, ...editorSession, ...nodeTree, ...pageInspect };
}

function createBenchmarks(api, required) {
  if (typeof api.parsePageDocument !== "function") throw new Error("parsePageDocument is unavailable in the benchmark dist");
  const parsed = api.parsePageDocument(document);
  const snapshot = { document, version: "initial" };
  const history = { past: [], present: parsed, future: [], editRevision: 0 };
  const dirtySession = { history: { ...history, editRevision: 1 }, savedEditRevision: 0, operationQueue: {} };
  const benchmarks = [];

  if (typeof api.parsePageDocument === "function") benchmarks.push({ name: "parsePageDocument", run: () => api.parsePageDocument(document) });
  if (typeof api.editorSessionFrom === "function") benchmarks.push({ name: "editorSessionFrom", run: () => api.editorSessionFrom(snapshot, target, {}) });
  if (typeof api.editDocument === "function") {
    assert.equal(api.editDocument(parsed, change).body[49].children[18].style.base.color, "#123456");
    benchmarks.push({ name: "editDocument", run: () => api.editDocument(parsed, change) });
  }
  if (typeof api.inspectPageDocument === "function") {
    assert.equal(api.inspectPageDocument(parsed, outline).items.length, 1_000);
    benchmarks.push({ name: "pages.inspect outline", run: () => api.inspectPageDocument(parsed, outline) });
  }
  if (typeof api.commitHistory === "function") {
    assert.strictEqual(api.commitHistory(history, parsed), history);
    benchmarks.push({ name: "commitHistory unchanged", run: () => api.commitHistory(history, parsed) });
  }
  if (typeof api.indexNodeDocument === "function") {
    assert.equal(api.indexNodeDocument(parsed).paths.get("item-49-18")?.join("."), "49.18");
    benchmarks.push({ name: "node ID index build", run: () => api.indexNodeDocument({ ...parsed }) });
    benchmarks.push({ name: "node ID index reuse", run: () => api.indexNodeDocument(parsed).paths.get("item-49-18") });
  }
  if (typeof api.hasUnsavedPageChanges === "function") {
    assert.equal(api.hasUnsavedPageChanges(dirtySession), true);
    benchmarks.push({ name: "page dirty check", run: () => api.hasUnsavedPageChanges(dirtySession) });
  }

  if (required) {
    const requiredNames = ["parsePageDocument", "editorSessionFrom", "editDocument", "pages.inspect outline"];
    for (const name of requiredNames) assert.ok(benchmarks.some((benchmark) => benchmark.name === name), `${name} is unavailable in the candidate dist`);
  }
  return benchmarks;
}

let lastResult;
function sample(run, iterations) {
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) lastResult = run();
  return (performance.now() - start) / iterations;
}

function calibrateIterations(run) {
  const minimumBatchMs = 6;
  const maximumIterations = 131_072;
  let iterations = 1;
  while (iterations < maximumIterations) {
    if (sample(run, iterations) * iterations >= minimumBatchMs) return iterations;
    iterations = Math.min(iterations * 2, maximumIterations);
  }
  return iterations;
}

function median(values) {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

const currentDist = fileURLToPath(new URL("../dist/", import.meta.url));
const currentBenchmarks = createBenchmarks(await loadApi(currentDist), true);
const baselineDist = process.env.EDITOR_BENCH_BASELINE_DIST;
const baselineBenchmarks = baselineDist ? createBenchmarks(await loadApi(resolve(baselineDist)), false) : undefined;
const baselineByName = new Map(baselineBenchmarks?.map((benchmark) => [benchmark.name, benchmark]) ?? []);
const currentNames = new Set(currentBenchmarks.map((benchmark) => benchmark.name));
const iterationsByName = new Map();

if (baselineBenchmarks) {
  for (const baseline of baselineBenchmarks) {
    if (!currentNames.has(baseline.name)) {
      console.error(`${baseline.name}: candidate removed a benchmark present in the base version`);
      process.exitCode = 1;
    }
  }
  for (const current of currentBenchmarks) {
    const baseline = baselineByName.get(current.name);
    iterationsByName.set(current.name, calibrateIterations((baseline ?? current).run));
  }
}

console.log(`編集性能ベンチマーク: 1,000 要素 / ${Buffer.byteLength(json)} bytes`);
if (!baselineBenchmarks) console.log("基準版dist未指定のため、CI退行判定をスキップします。");

for (const current of currentBenchmarks) {
  const baseline = baselineByName.get(current.name);
  const iterations = iterationsByName.get(current.name) ?? 8;
  const currentTimes = [], baselineTimes = [];

  for (let warmup = 0; warmup < 3; warmup += 1) {
    sample(current.run, iterations);
    if (baseline) sample(baseline.run, iterations);
  }

  for (let round = 0; round < 15; round += 1) {
    if (baseline && round % 2 === 1) {
      baselineTimes.push(sample(baseline.run, iterations));
      currentTimes.push(sample(current.run, iterations));
    } else {
      currentTimes.push(sample(current.run, iterations));
      if (baseline) baselineTimes.push(sample(baseline.run, iterations));
    }
  }

  const currentMs = median(currentTimes);
  if (!baseline) {
    console.log(`${current.name}: 候補版 ${currentMs.toFixed(2)} ms（base版に比較対象なし）`);
    continue;
  }

  const baselineMs = median(baselineTimes);
  const ratio = currentMs / Math.max(baselineMs, 0.01);
  const deltaMs = currentMs - baselineMs;
  const regressed = ratio > 1.25 && deltaMs > 0.75;
  console.log(`${current.name}: 基準版 ${baselineMs.toFixed(2)} ms → 現行版 ${currentMs.toFixed(2)} ms（${ratio.toFixed(2)} 倍、差 ${deltaMs.toFixed(2)} ms）${regressed ? " 退行" : ""}`);
  if (regressed) process.exitCode = 1;
}
