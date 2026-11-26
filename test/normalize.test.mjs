import test from "node:test";
import assert from "node:assert/strict";
import { analyzeNormalization, planNormalization } from "@niho/web/normalize";

const settings = (breakpoints = [{ name: "Tablet", minWidth: 768, previewWidth: 840 }, { name: "PC", minWidth: 1280, previewWidth: 1280 }]) => ({
  version: "bp-v1", settings: { base: { name: "Mobile", previewWidth: 375 }, breakpoints }
});
const page = (pageId, body, extra = {}) => ({
  kind: "page", version: `version-${pageId}`, document: {
    schemaVersion: 1, siteId: "site", pageId, locale: "ja", revision: 1, title: pageId, tokens: {}, body, ...extra
  }
});
const node = (id, style, extra = {}) => ({ type: "element", id, tag: "div", style, children: [], ...extra });
const input = (documents, options = {}) => ({
  siteId: "site", siteStyles: { version: "styles-v1", styles: {} }, breakpoints: settings(), documents, ...options
});

test("repeated color literals propose a shared token but require explicit approval", () => {
  const snapshot = input([
    page("one", [node("one-a", { base: { color: "#abc" } })]),
    page("two", [node("two-a", { base: { backgroundColor: "#aabbcc" } })])
  ]);
  const proposal = analyzeNormalization(snapshot).proposals.find(({ kind }) => kind === "color-token");
  assert.ok(proposal);
  assert.equal(proposal.classification, "semantic");
  assert.equal(proposal.value, "#aabbcc");
  assert.equal(proposal.occurrences.length, 2);

  const safeByDefault = planNormalization(snapshot);
  assert.equal(safeByDefault.acceptedProposalIds.includes(proposal.id), false);
  assert.equal(safeByDefault.pages.length, 0);
  assert.deepEqual(safeByDefault.siteStyles, {});

  const approved = planNormalization(snapshot, [proposal.id]);
  assert.deepEqual(approved.siteStyles.tokens[proposal.tokenName], { type: "color", value: "#aabbcc" });
  assert.equal(approved.pages.length, 2);
  assert.ok(approved.pages.every(({ operations }) => operations.length === 1 && operations[0].type === "style"
    && operations[0].value.token === proposal.tokenName));
  assert.throws(() => planNormalization(snapshot, ["unknown"]), /unknown normalization approval/u);
});

test("matching typography groups become an explicitly approved text style", () => {
  const snapshot = input([
    page("one", [node("heading-one", { base: { fontSize: 28, fontWeight: 700, color: "#222222" } })]),
    page("two", [node("heading-two", { base: { color: "#111111", fontWeight: 700, fontSize: 28 } })])
  ]);
  const proposal = analyzeNormalization(snapshot).proposals.find(({ kind }) => kind === "text-style");
  assert.ok(proposal);
  assert.equal(proposal.classification, "semantic");
  assert.deepEqual(proposal.style.base, { fontSize: 28, fontWeight: 700 });
  const plan = planNormalization(snapshot, [proposal.id]);
  assert.deepEqual(plan.siteStyles.textStyles[proposal.styleName], proposal.style);
  assert.equal(plan.pages.length, 2);
  assert.ok(plan.pages.every(({ operations }) => operations.some((operation) => operation.type === "nodeTextStyle" && operation.name === proposal.styleName)));
});

test("component slot and instance styles normalize across locales without token name collisions", () => {
  const blocks = { Cards: { props: {}, slots: { title: { label: "見出し", style: ["color"] } } } };
  const components = { version: "components-v1", library: { schemaVersion: 1, siteId: "site", revision: 1, tokens: {}, components: [
    { id: "badge", name: "バッジ", kind: "part", version: 1, root: { type: "element", id: "root", tag: "span",
      style: { responsive: [{ minWidth: 768, declarations: { color: "#ff0000" } }] }, children: [] } }
  ] } };
  const snapshot = input([
    page("home", [{ type: "component", id: "cards", block: "Cards", props: {}, slots: { title: { base: { color: "#336699" } } } }], { locale: "ja-JP" }),
    page("home", [{ type: "instance", id: "badge-instance", component: "badge", style: { base: { color: "#336699" } } }], { locale: "en-US" })
  ], {
    blocks,
    components,
    siteStyles: { version: "styles-v1", styles: { tokens: { "color-336699": { type: "color", value: "#000000" } } } }
  });
  const proposal = analyzeNormalization(snapshot).proposals.find(({ kind }) => kind === "color-token");
  assert.ok(proposal);
  assert.equal(proposal.tokenName, "color-336699-2");
  assert.deepEqual(new Set(proposal.occurrences.map(({ target }) => target.locale)), new Set(["ja-JP", "en-US"]));
  assert.equal(analyzeNormalization({ ...snapshot, documents: [...snapshot.documents].reverse() }).proposals.find(({ kind }) => kind === "color-token").id, proposal.id);
  assert.equal(analyzeNormalization(snapshot).proposals.some(({ kind, minWidth }) => kind === "unused-breakpoint" && minWidth === 768), false);

  const plan = planNormalization(snapshot, [proposal.id]);
  assert.equal(plan.expectedComponentsVersion, "components-v1");
  assert.deepEqual(plan.siteStyles.tokens[proposal.tokenName], { type: "color", value: "#336699" });
  const operations = plan.pages.flatMap(({ target, operations }) => operations.map((operation) => ({ locale: target.locale, operation })));
  assert.ok(operations.some(({ locale, operation }) => locale === "ja-JP" && operation.type === "slotStyle" && operation.value.token === proposal.tokenName));
  assert.ok(operations.some(({ locale, operation }) => locale === "en-US" && operation.type === "style" && operation.value.token === proposal.tokenName));
});

test("redundant responsive values are lossless only across every inherited style boundary", () => {
  const safe = input([page("safe", [node("safe-node", { base: { color: "#123456" }, responsive: [{ minWidth: 768, declarations: { color: "#123456" } }] })])]);
  const redundant = analyzeNormalization(safe).proposals.find(({ kind }) => kind === "remove-redundant-override");
  assert.ok(redundant);
  assert.equal(redundant.classification, "lossless");
  assert.deepEqual(planNormalization(safe).pages[0].operations, [{ type: "style", nodeId: "safe-node", breakpoint: 768, property: "color", value: undefined }]);

  const changingInheritedValue = input([page("changing", [node("body", { textStyle: "body", responsive: [{ minWidth: 768, declarations: { fontSize: 16 } }] })], {
    textStyles: { body: { base: { fontSize: 16 }, responsive: [{ minWidth: 1024, declarations: { fontSize: 20 } }] } }
  })]);
  assert.equal(analyzeNormalization(changingInheritedValue).proposals.some(({ kind }) => kind === "remove-redundant-override"), false);

  const components = { version: "components-v1", library: { schemaVersion: 1, siteId: "site", revision: 1,
    tokens: { light: { type: "color", value: "#eeeeee" }, dark: { type: "color", value: "#111111" } }, components: [
      { id: "badge", name: "バッジ", kind: "part", version: 1, root: { type: "element", id: "root", tag: "span", children: [] } }
    ] } };
  const instanceTokens = input([page("instance", [node("wrapper", undefined), {
    type: "instance", id: "badge-instance", component: "badge", style: { base: { color: { token: "light" } }, responsive: [{ minWidth: 768, declarations: { color: { token: "dark" } } }] }
  }])], { components });
  assert.equal(analyzeNormalization(instanceTokens).proposals.some(({ kind }) => kind === "remove-redundant-override"), false);
});

test("unused breakpoints are lossless while merging nearby used breakpoints requires approval", () => {
  const breakpointSettings = settings([
    { name: "Tablet", minWidth: 768, previewWidth: 768 },
    { name: "PC", minWidth: 800, previewWidth: 800 }
  ]);
  const snapshot = input([page("one", [node("a", { responsive: [
    { minWidth: 768, declarations: { color: "#111111" } }, { minWidth: 800, declarations: { color: "#222222" } }
  ] })])], { breakpoints: breakpointSettings });
  const merge = analyzeNormalization(snapshot).proposals.find(({ kind }) => kind === "merge-breakpoints");
  assert.ok(merge);
  assert.equal(merge.classification, "lossy");
  const defaultPlan = planNormalization(snapshot);
  assert.equal(defaultPlan.breakpoints.breakpoints.length, 2);
  const plan = planNormalization(snapshot, [merge.id]);
  assert.equal(plan.breakpoints.breakpoints.length, 1);
  assert.equal(plan.breakpoints.breakpoints[0].name, "PC");
  assert.ok(plan.pages[0].operations.some((operation) => operation.type === "style" && operation.breakpoint === 768 && operation.value === undefined));
});

test("a semantic token rewrite cannot race with a lossy breakpoint merge", () => {
  const breakpointSettings = settings([
    { name: "Tablet", minWidth: 768, previewWidth: 768 },
    { name: "PC", minWidth: 800, previewWidth: 800 }
  ]);
  const snapshot = input([page("one", [
    node("a", { responsive: [{ minWidth: 768, declarations: { color: "#aabbcc" } }] }),
    node("b", { base: { color: "#aabbcc" }, responsive: [{ minWidth: 800, declarations: { color: "#ddeeff" } }] })
  ])], { breakpoints: breakpointSettings });
  const proposals = analyzeNormalization(snapshot).proposals;
  const merge = proposals.find(({ kind }) => kind === "merge-breakpoints");
  const color = proposals.find(({ kind }) => kind === "color-token");
  assert.ok(merge && color);
  assert.throws(() => planNormalization(snapshot, [merge.id, color.id]), /overlaps a merged breakpoint/u);
});

test("redundant slot overrides are removed through slotStyle operations", () => {
  const blocks = { Cards: { props: {}, slots: { title: { label: "見出し", style: ["color"] } } } };
  const snapshot = input([page("one", [{ type: "component", id: "cards", block: "Cards", props: {}, slots: {
    title: { base: { color: "#123456" }, responsive: [{ minWidth: 768, declarations: { color: "#123456" } }] }
  } }])], { blocks });
  const proposal = analyzeNormalization(snapshot).proposals.find(({ kind }) => kind === "remove-redundant-override");
  assert.ok(proposal);
  assert.equal(proposal.occurrence.slot, "title");
  assert.deepEqual(planNormalization(snapshot).pages[0].operations, [
    { type: "slotStyle", nodeId: "cards", slot: "title", breakpoint: 768, property: "color", value: undefined }
  ]);
});

test("large unnamed sections receive a lossless editor name suggestion", () => {
  const section = { type: "element", id: "section", tag: "section", children: [
    { type: "element", id: "heading", tag: "h2", children: [{ type: "text", text: "ご利用の流れ" }] },
    ...Array.from({ length: 4 }, (_, index) => node(`item-${index}`, undefined))
  ] };
  const snapshot = input([page("one", [section])]);
  const proposal = analyzeNormalization(snapshot).proposals.find(({ kind }) => kind === "name-section");
  assert.ok(proposal);
  assert.equal(proposal.name, "ご利用の流れ");
  assert.equal(proposal.classification, "lossless");
  assert.deepEqual(planNormalization(snapshot).pages[0].operations, [{ type: "name", nodeId: "section", value: "ご利用の流れ" }]);
});
