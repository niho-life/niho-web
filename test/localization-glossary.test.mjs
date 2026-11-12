import assert from "node:assert/strict";
import { test } from "node:test";
import { GLOSSARY_LIMITS, glossaryHintForUnit, glossaryVersion, parseGlossaryEntries, withGlossaryContext } from "@niho/web/localization";

const entries = [{ source: "鎌倉", target: "Kamakura" }, { source: "シェアリビング", target: "shared living" }];
const unit = (sourceValue, context = "p text", translatable = true) => ({ unitId: "u1", translatable, sourceValue, context, sourceFingerprint: "sha256:fixed" });

test("語彙は前後の空白を除いて検証し、重複・上限・不正な形を拒否する", () => {
  assert.deepEqual(parseGlossaryEntries([{ source: " 鎌倉 ", target: " Kamakura " }]), [{ source: "鎌倉", target: "Kamakura" }]);
  assert.deepEqual(parseGlossaryEntries([]), []);
  const reject = (input, pattern) => assert.throws(() => parseGlossaryEntries(input), pattern);
  reject({}, /expected a glossary array/);
  reject([{ source: "鎌倉", target: "Kamakura" }, { source: "鎌倉", target: "K" }], /duplicate glossary source/);
  reject([{ source: "NIHO", target: "NIHO" }, { source: "niho", target: "Niho" }], /duplicate glossary source/);
  reject([{ source: "", target: "x" }], /invalid text/);
  reject([{ source: "x", target: "   " }], /invalid text/);
  reject([{ source: "x", target: "a\nb" }], /invalid text/);
  reject([{ source: "x".repeat(GLOSSARY_LIMITS.text + 1), target: "y" }], /invalid text/);
  reject([{ source: "x", target: "y", note: "z" }], /unknown field/);
  reject(["x"], /expected a JSON object/);
  reject(Array.from({ length: GLOSSARY_LIMITS.entries + 1 }, (_, index) => ({ source: `s${index}`, target: "t" })), /expected a glossary array/);
  assert.equal(parseGlossaryEntries(Array.from({ length: GLOSSARY_LIMITS.entries }, (_, index) => ({ source: `s${index}`, target: "t" }))).length, GLOSSARY_LIMITS.entries);
});

test("語彙の版は中身のハッシュで、順序に依らず、中身が変わると変わる", async () => {
  const version = await glossaryVersion(entries);
  assert.match(version, /^glossary-[0-9a-f]{16}$/);
  assert.equal(await glossaryVersion([...entries].reverse()), version);
  assert.equal(await glossaryVersion([{ source: " 鎌倉", target: "Kamakura " }, entries[1]]), version, "空白を除いた中身で決まる");
  assert.notEqual(await glossaryVersion([{ source: "鎌倉", target: "Kamakura City" }, entries[1]]), version);
  assert.notEqual(await glossaryVersion([entries[0]]), version);
  assert.match(await glossaryVersion([]), /^glossary-[0-9a-f]{16}$/);
  await assert.rejects(() => glossaryVersion([{ source: "", target: "x" }]));
});

test("単位の原文に含まれる語だけを、翻訳の材料に添える文字列にする", () => {
  assert.equal(glossaryHintForUnit(entries, "鎌倉駅から徒歩2分"), "Glossary (use these translations): 鎌倉 → Kamakura");
  assert.equal(glossaryHintForUnit(entries, "鎌倉のシェアリビング"), "Glossary (use these translations): 鎌倉 → Kamakura; シェアリビング → shared living");
  assert.equal(glossaryHintForUnit(entries, "ドロップインのご案内"), "", "含まれる語が無ければ空");
  assert.equal(glossaryHintForUnit([], "鎌倉"), "");
  assert.equal(glossaryHintForUnit(entries, ""), "");
  // 英語の原文（英語→日本語）は大文字小文字を区別しない
  assert.equal(glossaryHintForUnit([{ source: "Drop-in", target: "ドロップイン" }], "Join our DROP-IN day"), "Glossary (use these translations): Drop-in → ドロップイン");
  // リッチテキストは文字だけで照合する（要素をまたいだ語も見つかる）
  const rich = { kind: "rich-text", children: [{ type: "text", text: "ようこそ" }, { type: "element", id: "a1", tag: "a", children: [{ type: "text", text: "鎌" }] }, { type: "text", text: "倉へ" }] };
  assert.equal(glossaryHintForUnit(entries, rich), "Glossary (use these translations): 鎌倉 → Kamakura");
  assert.equal(glossaryHintForUnit(entries, { kind: "asset", asset: { provider: "x", id: "鎌倉" } }), "", "素材は対象外");
});

test("添える語彙は件数と長さに上限がある", () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ source: `語${index}`, target: `word${index}` }));
  const text = many.map((entry) => entry.source).join(" ");
  const hint = glossaryHintForUnit(many, text);
  assert.equal(hint.split("; ").length, GLOSSARY_LIMITS.hints, "件数の上限");
  assert.ok(hint.startsWith("Glossary (use these translations): 語0 → word0; 語1 → word1"), "先に並んだ語を優先");
  const long = Array.from({ length: 10 }, (_, index) => ({ source: `用語${index}`, target: "T".repeat(110) }));
  const longHint = glossaryHintForUnit(long, long.map((entry) => entry.source).join(" "));
  assert.ok(longHint.length <= GLOSSARY_LIMITS.hintLength, `長さの上限（${longHint.length}）`);
  assert.ok(longHint.split("; ").length >= 1);
});

test("依頼用の複製の context にだけ語彙を添え、元の単位と原文の指紋は変えない", () => {
  const units = [unit("鎌倉のご案内"), unit("ドロップイン"), unit({ kind: "asset", asset: { provider: "x", id: "鎌倉" } }, "image", false), unit("鎌倉の写真", "image alt", false)];
  const frozen = JSON.stringify(units);
  const result = withGlossaryContext(units, entries);
  assert.equal(JSON.stringify(units), frozen, "元の単位は変えない");
  assert.equal(result[0].context, "p text | Glossary (use these translations): 鎌倉 → Kamakura");
  assert.equal(result[0].sourceFingerprint, "sha256:fixed");
  assert.equal(result[0].sourceValue, "鎌倉のご案内");
  assert.equal(result[1], units[1], "語彙を含まない単位は同じオブジェクト");
  assert.equal(result[2], units[2]);
  assert.equal(result[3], units[3], "翻訳しない単位には添えない");
  assert.notEqual(result[0], units[0]);
  assert.deepEqual(withGlossaryContext(units, []), units, "語彙が空なら今までと同じ");
});
