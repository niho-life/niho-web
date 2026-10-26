import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkTextMarks, localizedInputProblem, parseLocaleReleaseApplyResult, parseLocaleReleasePending, parseLocaleReleasePrepareResult, parseLocaleReleaseStateResult,
  parseLocalizationCommandResult, parseLocalizationImageResult, parseLocalizationItem, parseLocalizationItemResult, parseLocalizationListResult,
  parseLocalizationOverviewResult, parseLocalizationPreviewResult, parseLocalizationUnit, parsePreviewFrameMessage, previewFrameSrc, richSegments,
  segmentsToRichText, segmentsToText, textSegments, visibleLength, createOperationId, createPreviewNonce, isLocalizationOperationId,
} from "@niho/web/localization-workspace-model";
import { parseEditorLocaleReleaseState } from "../dist/editor-locale-release.js";
import { previewFrameLayout } from "../dist/localization-workspace-preview.js";
import { createLocalizationMemory } from "../examples/localization-workspace-memory.mjs";

const signal = new AbortController().signal;
const M = (id) => `⟦${id}⟧`;
const clone = (value) => structuredClone(value);
async function samples() {
  const memory = createLocalizationMemory();
  const overview = await memory.adapter.loadOverview(signal);
  const list = await memory.adapter.listItems({ cursor: null }, signal);
  const item = await memory.adapter.loadItem({ itemKey: "aG9tZQ" }, signal);
  return { memory, overview, list, item };
}

test("the fictional memory adapter speaks the contract the parsers accept", async () => {
  const { overview, list, item, memory } = await samples();
  const parsed = parseLocalizationOverviewResult(overview);
  assert.equal(parsed.status, "ready");
  assert.deepEqual(parsed.overview.languages, { source: "日本語", target: "English" });
  assert.deepEqual(parsed.overview.groups.map((group) => [group.id, group.items]), [["pages", 2], ["shared", 1], ["posts", 2]]);
  const page = parseLocalizationListResult(list);
  assert.equal(page.items.length, 2);
  assert.equal(page.nextCursor, "p2");
  const loaded = parseLocalizationItemResult(item, "aG9tZQ");
  assert.deepEqual(loaded.item.units.map((unit) => [unit.unitId, unit.kind, unit.state]), [["title", "text", "draft"], ["lead", "text", "missing"], ["body", "rich-text", "missing"], ["cover", "image", "source"]]);
  const about = parseLocalizationItemResult(await memory.adapter.loadItem({ itemKey: "YWJvdXQ" }, signal), "YWJvdXQ");
  assert.equal(about.item.units[1].state, "review-needed");
  assert.equal(about.item.units[1].previousSource, "小さな町の工房です。");
  assert.throws(() => parseLocalizationItemResult(item, "YWJvdXQ"), /identity mismatch/);
  assert.deepEqual(parseLocalizationItemResult({ status: "not_found" }, "x1"), { status: "not_found" });
  assert.deepEqual(parseLocalizationOverviewResult({ status: "forbidden" }), { status: "forbidden" });
  assert.throws(() => parseLocalizationOverviewResult({ status: "forbidden", reason: "secret" }), /unknown field/);
});

test("parsers reject unknown keys, mismatched states and oversized values", async () => {
  const { overview, list, item } = await samples();
  const withKey = (value, at, key) => { const copy = clone(value); at(copy)[key] = 1; return copy; };
  assert.throws(() => parseLocalizationOverviewResult(withKey(overview, (v) => v.overview, "debug")), /unknown field/);
  assert.throws(() => parseLocalizationOverviewResult(withKey(overview, (v) => v.overview.settings.translator, "apiKey")), /unknown field/);
  assert.throws(() => parseLocalizationListResult(withKey(list, (v) => v.items[0], "storageKey")), /unknown field/);
  assert.throws(() => parseLocalizationItemResult(withKey(item, (v) => v.item.units[0], "context"), "aG9tZQ"), /unknown field/);
  const same = clone(overview); same.overview.targetLocale = "ja";
  assert.throws(() => parseLocalizationOverviewResult(same), /differ/);
  const duplicatePermission = clone(overview); duplicatePermission.overview.permissions = ["edit", "edit"];
  assert.throws(() => parseLocalizationOverviewResult(duplicatePermission), /duplicate permission/);
  const unknownPermission = clone(overview); unknownPermission.overview.permissions = ["admin"];
  assert.throws(() => parseLocalizationOverviewResult(unknownPermission), /unknown permission/);
  for (const frameUrl of ["http://frame.example.test/", "https://frame.example.test/#x", "https://user:pw@frame.example.test/", "javascript:alert(1)"]) {
    const bad = clone(overview); bad.overview.preview = { frameUrl };
    assert.throws(() => parseLocalizationOverviewResult(bad), /frame URL/, frameUrl);
  }
  const local = clone(overview); local.overview.preview = { frameUrl: "http://127.0.0.1:4180/frame.html" };
  assert.equal(parseLocalizationOverviewResult(local).overview.preview.frameUrl, "http://127.0.0.1:4180/frame.html");

  const tooMany = { status: "ready", items: Array.from({ length: 501 }, () => list.items[0]), nextCursor: null };
  assert.throws(() => parseLocalizationListResult(tooMany), /bounded array/);
  assert.throws(() => parseLocalizationListResult({ ...clone(list), nextCursor: "a/b" }), /cursor/);
  const excluded = clone(list.items[0]); excluded.state = "excluded";
  assert.throws(() => parseLocalizationListResult({ status: "ready", items: [excluded], nextCursor: null }), /reason/);
  const overReviewed = clone(list.items[0]); overReviewed.reviewedUnits = overReviewed.totalUnits + 1;
  assert.throws(() => parseLocalizationListResult({ status: "ready", items: [overReviewed], nextCursor: null }), /reviewed exceeds/);
  const badKey = clone(list.items[0]); badKey.key = "../etc";
  assert.throws(() => parseLocalizationListResult({ status: "ready", items: [badKey], nextCursor: null }), /item key/);

  const unit = clone(item.item.units[0]);
  assert.throws(() => parseLocalizationUnit({ ...unit, value: "x".repeat(100_001) }), /invalid text/);
  assert.throws(() => parseLocalizationUnit({ ...unit, value: null }), /does not fit the state/);
  assert.throws(() => parseLocalizationUnit({ ...unit, state: "reviewed", previousSource: "前" }), /previous source/);
  assert.throws(() => parseLocalizationUnit({ ...unit, label: "" }), /invalid text/);
  assert.throws(() => parseLocalizationUnit({ ...unit, unitId: "1bad" }), /unit ID/);
  const lead = clone(item.item.units[1]);
  assert.throws(() => parseLocalizationUnit({ ...lead, marks: [lead.marks[0]] }), /one to one/);
  assert.throws(() => parseLocalizationUnit({ ...lead, source: `${lead.source}${M("m0")}` }), /one to one/);
  assert.throws(() => parseLocalizationUnit({ ...lead, marks: Array.from({ length: 201 }, (_, i) => ({ id: `m${i}`, label: "印" })) }), /bounded array/);
  assert.throws(() => parseLocalizationUnit({ ...lead, candidate: { candidateId: "c1", value: `${M("zz")}` } }), /unknown mark/);
  assert.equal(parseLocalizationUnit({ ...lead, state: "draft", value: `${M("m0")} only` }).value, `${M("m0")} only`, "stored values with too few marks still load");
  const body = clone(item.item.units[2]);
  assert.throws(() => parseLocalizationUnit({ ...body, state: "draft", value: { kind: "rich-text", children: [{ type: "element", id: "zz", tag: "a", children: [] }] } }), /unknown rich text element/);
  assert.throws(() => parseLocalizationUnit({ ...body, source: { kind: "rich-text", children: [{ type: "element", id: "l1", tag: "script", children: [] }] } }), /unsupported rich text node/);
  const cover = clone(item.item.units[3]);
  assert.throws(() => parseLocalizationUnit({ ...cover, source: { ...cover.source, url: "javascript:alert(1)" } }), /https URL/);
  assert.throws(() => parseLocalizationUnit({ ...cover, required: true }), /cannot use the source/);
  assert.throws(() => parseLocalizationItem({ ...clone(item.item), units: [unit, unit] }), /duplicate unit/);
  assert.throws(() => parseLocalizationItem({ ...clone(item.item), units: Array.from({ length: 2001 }, () => unit) }), /bounded array/);

  assert.throws(() => parseLocalizationPreviewResult({ status: "ready", material: { big: "x".repeat(2 * 1024 * 1024) }, nextCursor: null }), /too large/);
  assert.throws(() => parseLocalizationPreviewResult({ status: "ready", material: { n: Infinity }, nextCursor: null }), /non-finite/);
  assert.throws(() => parseLocalizationPreviewResult({ status: "ready", material: JSON.parse('{"__proto__":{"x":1}}'), nextCursor: null }), /reserved key/);
  assert.throws(() => parseLocalizationImageResult({ status: "uploaded", image: { asset: { kind: "image-url", src: "https://media.example.test/a.png" }, url: "http://media.example.test/a.png" } }), /https URL/);
});

test("command results must point at the requested unit and item", async () => {
  const { memory } = await samples();
  const input = { itemKey: "aG9tZQ", operationId: createOperationId(), unitId: "title", expectedVersion: "v1", expectedSourceVersion: "s1", action: "set-value", value: "Workshop" };
  const applied = await memory.adapter.command(input, signal);
  assert.equal(parseLocalizationCommandResult(applied, { itemKey: "aG9tZQ", unitId: "title" }).status, "applied");
  assert.throws(() => parseLocalizationCommandResult(applied, { itemKey: "aG9tZQ", unitId: "lead" }), /unit identity/);
  assert.throws(() => parseLocalizationCommandResult(applied, { itemKey: "YWJvdXQ", unitId: "title" }), /item identity/);
  assert.deepEqual(await memory.adapter.command(input, signal), applied, "the same operationId returns the same result without writing twice");
  assert.equal(memory.state.items[0].units[0].version, 2);
  const conflict = parseLocalizationCommandResult(await memory.adapter.command({ ...input, operationId: createOperationId() }, signal), { itemKey: "aG9tZQ", unitId: "title" });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.unit.version, "v2");
  assert.deepEqual(parseLocalizationCommandResult({ status: "invalid", message: "札が合いません。" }, input), { status: "invalid", message: "札が合いません。" });
  assert.ok(isLocalizationOperationId(createOperationId()));
});

test("marks: text tokens become chips and must match the source one to one", () => {
  const value = `Open ${M("m0")}. Mail ${M("m1")}.`;
  const segments = textSegments(value);
  assert.deepEqual(segments.map((segment) => segment.type === "text" ? segment.text : `[${segment.id}]`), ["Open ", "[m0]", ". Mail ", "[m1]", "."]);
  assert.equal(segmentsToText(segments), value);
  const marks = [{ id: "m0", label: "営業時間" }, { id: "m1", label: "メールアドレス" }];
  assert.equal(checkTextMarks(value, marks), null);
  assert.deepEqual(checkTextMarks(`Open ${M("m0")}.`, marks), { kind: "missing", ids: ["m1"] });
  assert.deepEqual(checkTextMarks(`${M("m0")}${M("m0")}${M("m1")}`, marks), { kind: "extra", ids: ["m0"] });
  assert.deepEqual(checkTextMarks(`${M("m0")}${M("m1")}${M("x")}`, marks), { kind: "unknown", ids: ["x"] });
  assert.equal(visibleLength(`ab${M("m0")}ｃ`), 3);
  const unit = { kind: "text", marks, required: true, singleLine: true, maxLength: 10, source: `営業時間は${M("m0")}です。お問い合わせは${M("m1")}へ。` };
  assert.match(localizedInputProblem(unit, textSegments(`Open ${M("m0")}`)).message, /札が足りません：メールアドレス/);
  assert.match(localizedInputProblem(unit, textSegments(`${M("m0")}${M("m1")} 12345678901`)).message, /10 文字以内/);
  assert.match(localizedInputProblem(unit, textSegments(`${M("m0")}${M("m1")}`)).message, /訳文を入れてください/);
  assert.equal(localizedInputProblem(unit, textSegments(`A ${M("m1")} ${M("m0")}`)).value, `A ${M("m1")} ${M("m0")}`, "marks may move");
});

test("marks: rich text elements become paired chips; text may move around them but the structure may not change", () => {
  const source = { kind: "rich-text", children: [{ type: "text", text: "詳しくは" }, { type: "element", id: "l1", tag: "a", children: [{ type: "text", text: "こちら" }, { type: "element", id: "b1", tag: "strong", children: [{ type: "text", text: "！" }] }] }, { type: "element", id: "br1", tag: "br", children: [] }] };
  const segments = richSegments(source);
  assert.deepEqual(segments.map((segment) => segment.type === "text" ? segment.text : `${segment.edge}:${segment.id}`), ["詳しくは", "open:l1", "こちら", "open:b1", "！", "close:b1", "close:l1", "single:br1"]);
  assert.deepEqual(segmentsToRichText(segments, source).value, source);
  const moved = [{ type: "mark", id: "l1", edge: "open" }, { type: "text", text: "Click " }, { type: "mark", id: "b1", edge: "open" }, { type: "text", text: "here" }, { type: "mark", id: "b1", edge: "close" }, { type: "mark", id: "l1", edge: "close" }, { type: "text", text: " for details" }, { type: "mark", id: "br1", edge: "single" }];
  assert.deepEqual(segmentsToRichText(moved, source).value.children.map((node) => node.type === "text" ? node.text : node.id), ["l1", " for details", "br1"]);
  assert.deepEqual(segmentsToRichText(moved.filter((segment) => !(segment.type === "mark" && segment.id === "b1")), source).problem, { kind: "missing", ids: ["b1"] });
  const outside = [{ type: "mark", id: "b1", edge: "open" }, { type: "mark", id: "b1", edge: "close" }, { type: "mark", id: "l1", edge: "open" }, { type: "mark", id: "l1", edge: "close" }, { type: "mark", id: "br1", edge: "single" }];
  assert.equal(segmentsToRichText(outside, source).problem.kind, "order", "a nested element cannot leave its parent");
  const reversed = [{ type: "mark", id: "l1", edge: "close" }, { type: "mark", id: "b1", edge: "open" }, { type: "mark", id: "b1", edge: "close" }, { type: "mark", id: "l1", edge: "open" }, { type: "mark", id: "br1", edge: "single" }];
  assert.equal(segmentsToRichText(reversed, source).problem.kind, "order");
  const unit = { kind: "rich-text", required: true, source };
  assert.match(localizedInputProblem(unit, moved.filter((segment) => !(segment.type === "mark" && segment.id === "l1"))).message, /札が足りません：リンク/);
});

test("preview frame messages are accepted only with the right type, protocol and nonce", () => {
  const nonce = createPreviewNonce();
  assert.match(nonce, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(previewFrameSrc("https://frame.example.test/render", nonce), `https://frame.example.test/render#niho-preview=${nonce}`);
  assert.throws(() => previewFrameSrc("https://frame.example.test/render#x", nonce));
  const ok = { type: "niho-localization-preview", protocol: 1, nonce, event: "ready" };
  assert.deepEqual(parsePreviewFrameMessage(ok, nonce), { event: "ready" });
  assert.equal(parsePreviewFrameMessage({ ...ok, nonce: "x".repeat(32) }, nonce), null);
  assert.equal(parsePreviewFrameMessage({ ...ok, protocol: 2 }, nonce), null);
  assert.equal(parsePreviewFrameMessage({ ...ok, event: "render" }, nonce), null);
  assert.equal(parsePreviewFrameMessage({ ...ok, extra: 1 }, nonce), null);
  assert.deepEqual(parsePreviewFrameMessage({ ...ok, event: "error", message: "描けませんでした" }, nonce), { event: "error", message: "描けませんでした" });
});

test("release: progress, resume, blockers and history kinds are strict; editor parsers stay available from the old module", () => {
  const summary = { releaseId: "en-1", version: "r1", label: "10/1 の公開", publishedAt: "2026-10-01T01:00:00.000Z", pages: 3, sharedResources: 1 };
  const state = parseLocaleReleaseStateResult({ status: "ready", current: summary, history: [{ ...summary, releaseId: "en-0", version: "r0", operation: "rollback", by: null, restorable: true }], pending: null });
  assert.equal(state.history[0].operation, "rollback");
  assert.throws(() => parseLocaleReleaseStateResult({ status: "ready", current: summary, history: [{ ...summary, operation: "publish", by: null, restorable: true }], pending: null }), /duplicate release/);
  assert.throws(() => parseLocaleReleaseStateResult({ status: "ready", current: summary, history: [{ ...summary, releaseId: "en-0", version: "r0", operation: "delete", by: null, restorable: true }], pending: null }), /operation/);
  const pending = { operation: "publish", stage: "apply", progress: { done: 1, total: 2 }, resumeToken: "apply-1", releaseId: null, startedAt: "2026-10-26T00:00:00Z", startedBy: null };
  assert.equal(parseLocaleReleasePending(pending).stage, "apply");
  assert.throws(() => parseLocaleReleasePending({ ...pending, progress: { done: 3, total: 2 } }), /progress/);
  assert.throws(() => parseLocaleReleasePending({ ...pending, operation: "rollback" }), /rollback needs/);
  assert.throws(() => parseLocaleReleasePending({ ...pending, resumeToken: "has space" }), /token/);
  const request = { operation: "publish", releaseId: null, expectedVersion: "o1", expectedCurrentVersion: "r1", resumeToken: null };
  const plan = { confirmationToken: "confirm-1", expiresAt: "2026-10-26T00:02:00.000Z", address: "https://example.test/en/", pages: 4, previous: summary, prepared: { ...summary, releaseId: "en-2", version: "r2" } };
  assert.equal(parseLocaleReleasePrepareResult({ status: "ready", plan }, request).plan.pages, 4);
  assert.throws(() => parseLocaleReleasePrepareResult({ status: "ready", plan: { ...plan, previous: null } }, request), /previous release mismatch/);
  assert.throws(() => parseLocaleReleasePrepareResult({ status: "ready", plan: { ...plan, address: "https://example.test/en/?token=x" } }, request), /address/);
  assert.throws(() => parseLocaleReleasePrepareResult({ status: "blocked", blockers: [] }, request), /at least one/);
  assert.deepEqual(parseLocaleReleasePrepareResult({ status: "blocked", blockers: [{ id: "b1", message: "確認していない項目があります。", itemKey: "aG9tZQ" }] }, request).blockers[0].itemKey, "aG9tZQ");
  assert.throws(() => parseLocaleReleasePrepareResult({ status: "ready", plan: { ...plan, prepared: summary } }, { ...request, operation: "rollback", releaseId: "en-9" }), /equals the current|rollback target/);
  assert.throws(() => parseLocaleReleaseApplyResult({ status: "applied", current: summary }, { prepared: { releaseId: "en-2", version: "r2" } }), /mismatch/);
  assert.equal(parseLocaleReleaseApplyResult({ status: "applying", progress: { done: 1, total: 2 }, resumeToken: "apply-2" }, { prepared: null }).resumeToken, "apply-2");
  assert.deepEqual(parseEditorLocaleReleaseState({ siteId: "demo", locale: "en", current: null, history: [] }, "demo", "en"), { siteId: "demo", locale: "en", current: null, history: [] });
});


test("preview frame layout: PC draws at 1280px and scales down to the box; phone widths shrink only when the box is narrower", async () => {
  const pc = previewFrameLayout("pc", 344, 800);
  assert.equal(pc.frameWidth, 1280);
  assert.ok(Math.abs(pc.scale - 344 / 1280) < 1e-9);
  assert.equal(pc.boxHeight, 560);
  assert.equal(pc.frameHeight, Math.round(560 / pc.scale));
  assert.deepEqual(previewFrameLayout("320", 400, 800), { frameWidth: 320, frameHeight: 560, scale: 1, boxHeight: 560 });
  assert.ok(previewFrameLayout("360", 344, 800).scale < 1);
  assert.equal(previewFrameLayout("pc", 0, 400).scale, 1, "no shrinking before the box is measured");
  assert.equal(previewFrameLayout("pc", 0, 400).boxHeight, 420, "minimum height");
});
