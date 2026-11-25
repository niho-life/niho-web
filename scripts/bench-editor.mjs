import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { parsePageDocument } from "../dist/document.js";
import { editDocument } from "../dist/editor-model.js";
import { editorSessionFrom } from "../dist/editor-session.js";
import { inspectPageDocument } from "../dist/page-inspect.js";

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
const parsed = parsePageDocument(document);
const json = JSON.stringify(document);
const target = { siteId: document.siteId, pageId: document.pageId, locale: document.locale };
const snapshot = { document, version: "initial" };
const change = { type: "style", path: [49, 18], breakpoint: "base", property: "color", value: "#123456" };
const outline = { view: "outline" };
assert.equal(inspectPageDocument(parsed, outline).items.length, 1_000);
assert.equal(editDocument(parsed, change).body[49].children[18].style.base.color, "#123456");

const reference = () => JSON.parse(json);
const benchmarks = [
  { name: "parsePageDocument", run: () => parsePageDocument(document), limit: 1.25 },
  { name: "editorSessionFrom", run: () => editorSessionFrom(snapshot, target, {}), limit: 3 },
  { name: "editDocument", run: () => editDocument(parsed, change), limit: 3.5 },
  { name: "pages.inspect outline", run: () => inspectPageDocument(parsed, outline), limit: 4 }
];
// 実行機間の速度差を抑えるため、同じ入力の JSON デコードを各サンプルと交互に計測する。
// ウォームアップ後の複数バッチの中央値で、単発の GC やスケジューリングの影響を抑える。
const iterations = 8;
function sample(run) {
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) run();
  return (performance.now() - start) / iterations;
}
function median(values) {
  return values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
}

console.log(`編集性能ベンチマーク: 1,000 要素 / ${Buffer.byteLength(json)} bytes`);
for (const { name, run, limit } of benchmarks) {
  sample(reference);
  sample(run);
  sample(run);
  const times = [], ratios = [];
  for (let i = 0; i < 9; i += 1) {
    const before = i % 2 === 0 ? sample(reference) : undefined;
    const time = sample(run);
    times.push(time);
    ratios.push(time / (before ?? sample(reference)));
  }
  const ratio = median(ratios);
  console.log(`${name}: ${median(times).toFixed(2)} ms / 基準の ${ratio.toFixed(2)} 倍（上限 ${limit} 倍）`);
  if (ratio > limit) process.exitCode = 1;
}
