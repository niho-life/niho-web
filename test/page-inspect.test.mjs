import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { inspectPageDocument, PageInspectError, parsePageInspectQuery } from "@niho/web/core";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));

test("page inspection returns a compact outline for a thousand node document", () => {
  const document = structuredClone(fixture);
  document.body = Array.from({ length: 1000 }, (_, index) => ({
    type: "element", id: "node-" + index, tag: "div", attrs: { title: "x".repeat(1100) }, children: []
  }));
  const result = inspectPageDocument(document, { view: "outline" });
  assert.equal(result.items.length, 1000);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= Buffer.byteLength(JSON.stringify(document)) * 0.1);
});

test("outline depth, find filters and public node IDs return focused results", () => {
  const document = structuredClone(fixture);
  const summary = inspectPageDocument(document, { view: "outline", depth: 1 });
  assert.ok(summary.items.length < 10);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 10_000);
  const byNode = inspectPageDocument(document, { view: "find", node: "heading" });
  assert.deepEqual(byNode.items.map((item) => item.id), ["heading"]);
  const byText = inspectPageDocument(document, { view: "find", text: "複数の公開サイト" });
  assert.ok(byText.items.length > 0);
});

test("effective style reports resolved tokens and inherited values with their source", () => {
  const document = structuredClone(fixture);
  document.body[0].style.base.color = { token: "shared-accent" };
  const result = inspectPageDocument(document, { view: "effectiveStyle", node: "heading" }, {
    siteStyles: { tokens: { "shared-accent": { type: "color", value: "#123456" } } }
  });
  const base = result.style.variants.find((variant) => variant.breakpoint === "base" && variant.state === undefined);
  assert.deepEqual(base.values.color, { value: "#123456", token: "shared-accent", tokenSource: "siteShared", source: "inherited" });
});

test("inspection cursors continue a bounded projection and reject stale documents", () => {
  const document = structuredClone(fixture);
  document.body = Array.from({ length: 12 }, (_, index) => ({ type: "element", id: "node-" + index, tag: "div", children: [] }));
  const first = inspectPageDocument(document, { view: "outline", limit: 4 });
  assert.equal(first.items.length, 4);
  assert.equal(typeof first.nextCursor, "string");
  const second = inspectPageDocument(document, { view: "outline", limit: 4, cursor: first.nextCursor });
  assert.equal(second.items.length, 4);
  assert.notEqual(first.items[0].id, second.items[0].id);
  const changed = structuredClone(document);
  changed.title = "new version";
  assert.throws(() => inspectPageDocument(changed, { view: "outline", limit: 4, cursor: first.nextCursor }),
    (error) => error instanceof PageInspectError && error.code === "invalid_cursor");
});

test("subtree inspection pages oversized trees without dropping node paths", () => {
  const document = structuredClone(fixture);
  document.body[0].children = Array.from({ length: 9 }, (_, index) => ({
    type: "element", id: "child-" + index, tag: "p", children: [{ type: "text", text: "text " + index }]
  }));
  const first = inspectPageDocument(document, { view: "subtree", node: "hero", limit: 3 });
  assert.equal(first.complete, false);
  assert.equal(first.items.length, 3);
  const second = inspectPageDocument(document, { view: "subtree", node: "hero", limit: 3, cursor: first.nextCursor });
  assert.equal(second.items.length, 3);
  assert.notDeepEqual(first.items[0].path, second.items[0].path);
});

test("page inspection input rejects unknown filters, empty searches and invalid cursors", () => {
  assert.equal(parsePageInspectQuery({ view: "outline", unknown: "x" }), null);
  assert.equal(parsePageInspectQuery({ view: "find", text: "" }), null);
  assert.equal(parsePageInspectQuery({ view: "outline", cursor: "has spaces" }), null);
});
