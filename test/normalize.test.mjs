import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeNormalization, decodeNormalizationOperations, lintDocuments, planNormalization, selectNormalizationOperations, verifyNormalization
} from "@niho/web/normalize";
import { editDocumentById } from "@niho/web/editor-model";
import { lintDocument } from "@niho/web/core";

const page = (pageId, body, tokens = {}, locale = "ja") => ({
  schemaVersion: 1, siteId: "sample", pageId, locale, revision: 1, title: pageId, tokens, body
});
const element = (id, style, children = [], tag = "p") => ({ type: "element", id, tag, ...(style ? { style } : {}), children });
const color = (value) => ({ type: "color", value });
const typography = { fontFamily: "Inter", fontSize: "16px", lineHeight: 1.5, letterSpacing: 0 };
const block = { type: "component", id: "listing", block: "listing", props: {},
  slots: { item: { base: { color: "#123456", opacity: 0.8 }, responsive: [{ minWidth: 768, declarations: { opacity: 0.8 } }] } } };
const blocks = { listing: { props: {}, slots: { item: { label: "項目", style: ["color", "opacity"] } } } };
const breakpoints = { version: "settings-1", settings: { base: { name: "Mini", previewWidth: 375 }, breakpoints: [
  { name: "Mobile", minWidth: 480, previewWidth: 480 },
  { name: "Tablet", minWidth: 768, previewWidth: 768 },
  { name: "Small", minWidth: 800, previewWidth: 800 },
  { name: "PC", minWidth: 1280, previewWidth: 1280 }
] } };

test("lintDocument reports all shared normalization rules with site context", () => {
  const children = Array.from({ length: 8 }, (_, index) => element(`child-${index}`, { base: { color: "#aabbcc" } }));
  const document = page("lint", [element("section", { base: { opacity: 0.8 },
    responsive: [{ minWidth: 768, declarations: { opacity: 0.8 } }] }, children, "section")], {
    unused: { type: "color", value: "#ffffff" }
  });
  const settings = { version: "bp-v1", settings: { base: { name: "Mobile", previewWidth: 375 }, breakpoints: [
    { name: "Tablet", minWidth: 768, previewWidth: 800 }, { name: "PC", minWidth: 1280, previewWidth: 1360 }
  ] } };
  const findings = lintDocument(document, { tokens: { brand: color("#abc") }, breakpointSettings: settings });
  assert.deepEqual(new Set(findings.map(({ code }) => code)), new Set([
    "literal-matches-token", "redundant-override", "unnamed-large-section", "unused-token", "unused-breakpoint"
  ]));
  assert.ok(findings.some(({ code, tokenName }) => code === "literal-matches-token" && tokenName === "brand"));
  assert.ok(findings.some(({ code, breakpoint }) => code === "unused-breakpoint" && breakpoint === 1280));
});

test("lintDocuments still reports configured breakpoints when the catalog is empty", () => {
  const findings = lintDocuments([], { breakpointSettings: {
    version: "bp-empty-v1",
    settings: { base: { name: "Mobile", previewWidth: 375 }, breakpoints: [{ name: "PC", minWidth: 1280, previewWidth: 1360 }] }
  } });
  assert.deepEqual(findings.map(({ code, breakpoint }) => ({ code, breakpoint })), [{ code: "unused-breakpoint", breakpoint: 1280 }]);
});

test("lint does not equate different non-hex colors when comparing tokens", () => {
  const document = page("color-lint", [element("text", { base: { color: "white" } })]);
  const findings = lintDocument(document, { tokens: { dark: color("black") } });
  assert.ok(!findings.some(({ code }) => code === "literal-matches-token"));
  assert.ok(lintDocument(page("same-color", [element("text", { base: { color: "WHITE" } })]), { tokens: { light: color("white") } })
    .some(({ code }) => code === "literal-matches-token"));
});

test("lint counts page tokens used through a referenced site text style", () => {
  const document = page("inherited-style", [element("heading", { base: {}, textStyle: "heading" })], {
    headingSize: { type: "length", value: "40px" }
  });
  const findings = lintDocument(document, {
    tokens: { headingSize: { type: "length", value: "32px" } },
    textStyles: { heading: { base: { fontSize: { token: "headingSize" } } } }
  });
  assert.ok(!findings.some(({ code, tokenName }) => code === "unused-token" && tokenName === "headingSize"));
});

function apply(batch, document, input) {
  const operations = decodeNormalizationOperations(JSON.parse(JSON.stringify(batch.operations)));
  return operations.reduce((next, operation) => editDocumentById(next, operation, input.blocks, [], input.components, input.siteStyles), document);
}

test("normalization keeps document identity and approval boundaries and aliases colliding names", () => {
  const heading = element("heading", undefined, [{ type: "text", text: "今月のイベント" }], "h2");
  const entries = [
    heading,
    element("a", { base: { ...typography, color: "#123456", opacity: 0.8 }, responsive: [
      { minWidth: 768, declarations: { opacity: 0.8, lineHeight: 1.5 } },
      { minWidth: 800, declarations: { width: "300px" } }
    ], states: { hover: { color: "#123456" }, focus: { opacity: 0.9 }, active: { opacity: 0.7 } },
    hidden: [{ minWidth: 320, maxWidth: 399 }] }),
    element("b", { base: typography, responsive: [{ minWidth: 768, declarations: { lineHeight: 1.5 } }] }),
    element("different", { base: { ...typography, fontWeight: 600 } }),
    block,
    ...Array.from({ length: 4 }, (_, index) => element(`extra-${index}`, undefined))
  ];
  const ja = page("about", [element("section", undefined, entries, "section")], { "color-123456-2": color("#222") });
  const en = page("about", [element("en", { base: { color: "#123456" } })], {}, "en");
  const input = { documents: [{ document: ja, version: "ja-1" }, { document: en, version: "en-1" }], blocks,
    breakpointSettings: breakpoints, siteStylesRevision: { stage: "draft", version: "ss-1" },
    siteStyles: { tokens: { "color-123456": color("#111") } } };
  const original = structuredClone(input), analysis = analyzeNormalization(input), plan = planNormalization(input);
  assert.deepEqual(input, original);
  assert.deepEqual(planNormalization(input), plan);
  assert.deepEqual(plan.siteStylesRevision, input.siteStylesRevision);
  assert.deepEqual(analysis.textCombinations.map(({ count }) => count), [3]);
  assert.deepEqual(analysis.textStyleGroups[0].nodes.map(({ nodeId }) => nodeId), ["a", "b"]);
  assert.deepEqual(analysis.colors[0].occurrences.map(({ nodeId }) => nodeId), ["en", "a", "a", "listing"]);
  assert.deepEqual(analysis.unusedBreakpoints, [480, 1280]);
  assert.deepEqual(analysis.nearbyBreakpoints, [{ from: 800, into: 768 }]);
  assert.equal(plan.proposals.find(({ kind }) => kind === "section-name").suggestion.name, "今月のイベント");

  const [batch] = selectNormalizationOperations(JSON.parse(JSON.stringify(plan)));
  assert.deepEqual(batch.target, { siteId: "sample", pageId: "about", locale: "ja", revision: 1, version: "ja-1" });
  assert.ok(batch.operations.some(({ type, slot }) => type === "slotStyle" && slot === "item"));
  assert.ok(batch.operations.some(({ type }) => type === "textStyle"));
  assert.ok(batch.operations.every(({ type }) => type !== "token"));
  const normalized = apply(batch, ja, input);
  assert.equal(verifyNormalization(input, [normalized, en]).status, "equivalent");
  assert.equal(verifyNormalization(input, [{ ...normalized, revision: 2 }, en]).status, "equivalent");
  assert.equal(Object.values(normalized.textStyles)[0].responsive, undefined);
  assert.equal(verifyNormalization(input, [en, normalized]).status, "unsupported");

  const jaColor = plan.proposals.find(({ kind, target }) => kind === "color-token" && target.locale === "ja");
  assert.equal(jaColor.classification, "semantic change");
  assert.equal(jaColor.operations[0].name, "color-123456-3");
  const [approvedColor] = selectNormalizationOperations(plan, { includeLossless: false, approvedProposalIds: [jaColor.id] });
  const changedColor = apply(approvedColor, ja, input);
  assert.deepEqual(changedColor.tokens["color-123456-2"], color("#222"));
  assert.deepEqual(changedColor.tokens["color-123456-3"], color("#123456"));
  assert.equal(verifyNormalization(input, [changedColor, en]).status, "changed");

  const documentMerge = plan.proposals.find((proposal) => proposal.kind === "merge-breakpoints" && proposal.operations);
  assert.equal(documentMerge.classification, "lossy");
  const [mergeBatch] = selectNormalizationOperations(plan, { includeLossless: false, approvedProposalIds: [documentMerge.id] });
  const merged = apply(mergeBatch, ja, input);
  assert.equal(merged.body[0].children[1].style.responsive[0].declarations.width, "300px");
  assert.equal(verifyNormalization(input, [merged, en]).status, "changed");
  assert.throws(() => selectNormalizationOperations(plan, { approvedProposalIds: [documentMerge.id] }), /同時/);
  const settingMerge = plan.proposals.find((proposal) => proposal.kind === "merge-breakpoints" && proposal.siteSettingsChanges);
  assert.equal(settingMerge.siteSettingsChanges[0].expectedVersion, "settings-1");
  assert.equal(settingMerge.siteSettingsChanges[0].settings.breakpoints.some(({ minWidth }) => minWidth === 800), false);
  assert.equal(plan.proposals.find(({ kind, siteSettingsChanges }) => kind === "remove-breakpoint" && siteSettingsChanges[0].minWidth === 480).classification, "lossy");
  assert.ok(!plan.proposals.some(({ siteSettingsChanges }) => siteSettingsChanges?.some(({ minWidth }) => minWidth === 1280)));
  const nearbyPc = structuredClone(input);
  Object.assign(nearbyPc.breakpointSettings.settings.breakpoints.at(-1), { minWidth: 832, previewWidth: 832 });
  assert.ok(analyzeNormalization(nearbyPc).nearbyBreakpoints.some(({ from, into }) => from === 832 && into === 800));
  assert.ok(!planNormalization(nearbyPc).proposals.some(({ siteSettingsChanges }) => siteSettingsChanges?.some(({ minWidth }) => minWidth === 832)));
});

test("lossless verification expands components and checks presentation, shared pages and slot CSS", () => {
  const components = { schemaVersion: 1, siteId: "sample", revision: 1, tokens: {},
    components: [{ id: "card", name: "カード", kind: "part", version: 1, root: element("root", { base: { opacity: 0.8 } }) }] };
  const main = page("main", [
    { type: "instance", id: "card-instance", component: "card", style: { responsive: [{ minWidth: 768, declarations: { opacity: 0.8 } }] } },
    block
  ]);
  const header = page("header", [element("header-title", { base: { color: "#111" }, responsive: [{ minWidth: 800, declarations: { color: "#111" } }] })]);
  const footer = page("footer", [element("footer-title", undefined)]);
  const presentation = { schemaVersion: 1, siteId: "sample", locale: "ja", version: "presentation-1", reset: "neutral-v1",
    tokens: {}, fonts: [], shared: { header, footer }, layout: { responsive: [{ minWidth: 900, declarations: { width: "100%" } }] } };
  const input = { documents: [{ document: main, componentsVersion: "c-1", presentation }, header], components, componentsVersion: "c-1", blocks };
  const plan = planNormalization(input);
  const batches = selectNormalizationOperations(plan);
  assert.equal(batches.length, 2);
  const next = [main, header].map((document) => apply(batches.find(({ target }) => target.pageId === document.pageId), document, input));
  assert.equal(next[0].body[0].style?.responsive?.length ?? 0, 0);
  assert.equal(next[0].body[1].slots.item.responsive?.length ?? 0, 0);
  assert.deepEqual(verifyNormalization(input, next), { status: "equivalent", documentsChecked: 5 });
  assert.deepEqual(verifyNormalization(input, next.map((document) => ({ ...document, revision: 2 }))), { status: "equivalent", documentsChecked: 5 });
  assert.equal(verifyNormalization({ ...input, components: undefined }, next).status, "unsupported");
  assert.equal(verifyNormalization({ ...input, componentsVersion: "stale" }, next).status, "unsupported");
  assert.equal(verifyNormalization({ ...input, documents: [{ document: main, presentationVersion: "presentation-1" }, header] }, next).status, "unsupported");
  const changedSlot = structuredClone(main);
  changedSlot.body[1].slots.item.responsive[0].declarations.opacity = 0.6;
  assert.equal(verifyNormalization(input, [changedSlot, header]).slot, "item");
});

test("verification refuses shorthand, hidden and state changes and missing shared tokens", () => {
  const document = page("unsafe", [
    element("box", { base: { margin: 8 }, responsive: [
      { minWidth: 768, declarations: { marginLeft: 2 } },
      { minWidth: 800, declarations: { margin: 8 } }
    ], hidden: [{ minWidth: 0, maxWidth: 479 }], states: { active: { opacity: 0.8 } } }, [], "div")
  ]);
  assert.equal(analyzeNormalization({ documents: [document] }).redundantOverrides.length, 1);
  assert.equal(planNormalization({ documents: [document] }).proposals.some(({ kind }) => kind === "redundant-overrides"), false);
  const withoutOverride = structuredClone(document);
  withoutOverride.body[0].style.responsive.pop();
  assert.equal(verifyNormalization({ documents: [document] }, [withoutOverride]).width, 800);
  const hidden = structuredClone(document);
  hidden.body[0].style.hidden[0].maxWidth = 480;
  assert.equal(verifyNormalization({ documents: [document] }, [hidden]).status, "changed");
  const active = structuredClone(document);
  active.body[0].style.states.active.opacity = 0.7;
  assert.equal(verifyNormalization({ documents: [document] }, [active]).status, "changed");
  const shared = page("shared", [element("style", { base: { color: { token: "brand" } } })]);
  assert.equal(verifyNormalization({ documents: [shared] }, [shared]).status, "unsupported");
  const fallback = page("fallback", [element("wide", { base: { width: "320px" },
    responsive: [{ minWidth: 768, declarations: { width: "calc(100% - 16px)" } }] })]);
  const changedFallback = structuredClone(fallback);
  changedFallback.body[0].style.base.width = "300px";
  assert.equal(verifyNormalization({ documents: [fallback] }, [changedFallback]).status, "changed");
});

test("1,000-element analysis is deterministic with the benchmark input shape", () => {
  const body = Array.from({ length: 100 }, (_, i) => element(`section-${i}`, undefined,
    Array.from({ length: 9 }, (_, j) => element(`copy-${i}-${j}`, { base: { color: "#333" } })), "section"));
  const input = { documents: [page("large", body)], siteStyles: {} };
  const analysis = analyzeNormalization(input);
  assert.equal(analysis.elements, 1000);
  assert.equal(analysis.colors[0].count, 900);
  assert.equal(analysis.sectionNames.length, 100);
  assert.deepEqual(analyzeNormalization(input), analysis);
});

test("color tokens are canonical, local to repeated pages, and avoid component collisions", () => {
  const first = page("first", [
    element("short-hex", { base: { color: "#369" } }),
    element("upper-hex", { base: { color: "#336699" } })
  ], { "color-336699-2": color("#222222") });
  const second = page("second", [element("single", { base: { color: "#336699" } })]);
  const components = { schemaVersion: 1, siteId: "sample", revision: 1,
    tokens: { "color-336699-3": color("#000000") }, components: [] };
  const input = { documents: [first, second], siteStyles: { tokens: { "color-336699": color("#ffffff") } }, components };
  const analysis = analyzeNormalization(input);
  assert.equal(analysis.colors[0].value, "#336699");
  assert.equal(analysis.colors[0].count, 3);
  const proposals = planNormalization(input).proposals.filter(({ kind }) => kind === "color-token");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].target.pageId, "first");
  assert.equal(proposals[0].operations[0].name, "color-336699-4");
  assert.deepEqual(proposals[0].operations[0].token, color("#336699"));
});
