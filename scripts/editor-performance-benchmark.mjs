import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const baseDirectory = process.env.NIHO_PERF_BASE_DIST;
const candidateDirectory = process.env.NIHO_PERF_CANDIDATE_DIST;
if (!baseDirectory || !candidateDirectory) throw new Error("NIHO_PERF_BASE_DIST and NIHO_PERF_CANDIDATE_DIST are required");

const ELEMENT_COUNT = 1000;
const WARMUP_ROUNDS = 4;
const SAMPLE_ROUNDS = 15;

function syntheticDocument() {
  const body = [];
  for (let sectionIndex = 0; sectionIndex < 100; sectionIndex++) {
    const children = [];
    for (let childIndex = 0; childIndex < 9; childIndex++) {
      children.push({
        type: "element",
        id: `paragraph-${sectionIndex}-${childIndex}`,
        tag: "p",
        children: [{ type: "text", text: `合成コンテンツ ${sectionIndex}-${childIndex}` }]
      });
    }
    body.push({ type: "element", id: `section-${sectionIndex}`, tag: "section", children });
  }
  if (body.length + body.reduce((total, node) => total + node.children.length, 0) !== ELEMENT_COUNT) throw new Error("synthetic document must contain 1,000 elements");
  return { schemaVersion: 1, siteId: "synthetic-site", pageId: "synthetic-page", locale: "ja", revision: 1, title: "Synthetic performance document", tokens: {}, body };
}

async function importDist(directory, file) {
  return import(pathToFileURL(resolve(directory, file)).href);
}

async function loadSuite(directory) {
  const [document, model, inspect] = await Promise.all([
    importDist(directory, "document.js"),
    importDist(directory, "editor-model.js"),
    importDist(directory, "page-inspect.js")
  ]);
  if (typeof document.parsePageDocument !== "function" || typeof model.editDocument !== "function" || typeof inspect.inspectPageDocument !== "function") {
    throw new Error("one of the required performance APIs is missing from dist");
  }
  const parsed = document.parsePageDocument(syntheticDocument());
  return { document, model, inspect, parsed };
}

async function loadNormalizationAnalyzer(directory) {
  const packageRoot = dirname(directory);
  const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
  const exported = packageJson.exports?.["./normalize"];
  const entry = typeof exported === "string" ? exported : exported?.import;
  if (typeof entry !== "string") return null;
  const module = await import(pathToFileURL(resolve(packageRoot, entry)).href);
  if (typeof module.analyzeNormalization === "function") return (document) => module.analyzeNormalization({
    siteId: document.siteId,
    siteStyles: { version: "benchmark-styles-v1", styles: {} },
    breakpoints: { version: "benchmark-breakpoints-v1", settings: { base: { name: "PC", previewWidth: 1280 }, breakpoints: [] } },
    documents: [{ kind: "page", version: "benchmark-page-v1", document }]
  });
  const analyze = module.analyzeNormalization ?? module.analyzeDocuments ?? module.analyze;
  if (typeof analyze !== "function") return null;
  return (document) => analyze({ documents: [document], siteStyles: {} });
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function consume(value) {
  if (value && typeof value === "object") {
    if (Array.isArray(value.body)) return value.body.length;
    if (Array.isArray(value.items)) return value.items.length;
    return Object.keys(value).length;
  }
  return String(value).length;
}

function time(operation) {
  const started = performance.now();
  const value = operation();
  return { duration: performance.now() - started, value };
}

function measurePair(name, baselineOperation, candidateOperation, consumeValue) {
  for (let round = 0; round < WARMUP_ROUNDS; round++) {
    consumeValue(baselineOperation());
    consumeValue(candidateOperation());
  }
  const baselineSamples = [], candidateSamples = [];
  for (let round = 0; round < SAMPLE_ROUNDS; round++) {
    const firstIsBaseline = round % 2 === 0;
    const first = time(firstIsBaseline ? baselineOperation : candidateOperation);
    consumeValue(first.value);
    const second = time(firstIsBaseline ? candidateOperation : baselineOperation);
    consumeValue(second.value);
    (firstIsBaseline ? baselineSamples : candidateSamples).push(first.duration);
    (firstIsBaseline ? candidateSamples : baselineSamples).push(second.duration);
  }
  return { name, baselineMs: median(baselineSamples), candidateMs: median(candidateSamples) };
}

function measureSingle(operation, consumeValue) {
  for (let round = 0; round < WARMUP_ROUNDS; round++) consumeValue(operation());
  const samples = [];
  for (let round = 0; round < SAMPLE_ROUNDS; round++) {
    const sample = time(operation);
    consumeValue(sample.value);
    samples.push(sample.duration);
  }
  return median(samples);
}

const baseline = await loadSuite(baseDirectory);
const candidate = await loadSuite(candidateDirectory);
const rawDocument = syntheticDocument();
const textEdit = { type: "text", path: [0, 0, 0], value: "合成編集後" };
const styleEdit = { type: "style", path: [0, 0], breakpoint: "base", property: "color", value: "#0055aa" };
const results = [
  measurePair("document.load-validation", () => baseline.document.parsePageDocument(rawDocument), () => candidate.document.parsePageDocument(rawDocument), consume),
  measurePair("editor.editDocument", () => baseline.model.editDocument(baseline.parsed, textEdit), () => candidate.model.editDocument(candidate.parsed, textEdit), consume),
  measurePair("editor.editStyle", () => baseline.model.editDocument(baseline.parsed, styleEdit), () => candidate.model.editDocument(candidate.parsed, styleEdit), consume),
  measurePair("pages.inspect-outline", () => baseline.inspect.inspectPageDocument(baseline.parsed, { view: "outline", limit: 1000 }), () => candidate.inspect.inspectPageDocument(candidate.parsed, { view: "outline", limit: 1000 }), consume)
];

const [baselineAnalyze, candidateAnalyze] = await Promise.all([
  loadNormalizationAnalyzer(baseDirectory),
  loadNormalizationAnalyzer(candidateDirectory)
]);
if (baselineAnalyze && candidateAnalyze) {
  results.push(measurePair("normalization.analyze", () => baselineAnalyze(baseline.parsed), () => candidateAnalyze(candidate.parsed), consume));
} else if (candidateAnalyze) {
  results.push({ name: "normalization.analyze", baselineMs: null, candidateMs: measureSingle(() => candidateAnalyze(candidate.parsed), consume), baselineAvailable: false, candidateAvailable: true });
} else if (baselineAnalyze) {
  results.push({ name: "normalization.analyze", baselineMs: measureSingle(() => baselineAnalyze(baseline.parsed), consume), candidateMs: null, baselineAvailable: true, candidateAvailable: false });
} else results.push({ name: "normalization.analyze", baselineMs: null, candidateMs: null, baselineAvailable: false, candidateAvailable: false });

console.log(JSON.stringify({ schemaVersion: 1, nodeVersion: process.version, elementCount: ELEMENT_COUNT, results }, null, 2));
