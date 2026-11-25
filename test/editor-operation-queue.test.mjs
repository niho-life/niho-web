import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { editDocument, editDocumentById } from "@niho/web/editor-model";
import { acceptAppliedOperations, operationQueue, queuePageEdit, queuePageTravel } from "../dist/editor-operation-queue.js";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const apply = (document, operation) => editDocumentById(document, operation);
const edit = (document, operation) => editDocument(document, operation);

test("text operations capture an exact bounded child path context", () => {
  const base = structuredClone(fixture);
  const text = { type: "text", path: [0, 0, 0], value: "edited heading" };
  const queued = queuePageEdit(operationQueue(base), base, [text], edit, apply);
  assert.equal(queued.queue.fallback, false);
  assert.deepEqual(queued.queue.pending[0].preconditions, {
    parentId: "heading",
    oldValue: "海のそばで過ごす",
    textPathContext: [{ type: "target" }],
  });
});

test("canonical rebase preserves an unrelated concurrent property and an edit made in flight", () => {
  const base = structuredClone(fixture);
  const color = { type: "style", nodeId: "hero", breakpoint: "base", property: "color", value: "#334455" };
  const gap = { type: "style", nodeId: "hero", breakpoint: "base", property: "gap", value: 24 };
  const padding = { type: "style", nodeId: "hero", breakpoint: "base", property: "padding", value: "2rem" };
  const submitted = apply(base, color), local = apply(submitted, gap);
  const canonical = apply(apply(base, padding), color);
  const result = { status: "applied", version: "v2", revision: 2, document: { ...canonical, revision: 2 } };
  const queue = {
    ...operationQueue(base), pending: [color, gap],
    inFlight: { request: { target: { siteId: base.siteId, pageId: base.pageId, locale: base.locale }, baseVersion: "v1", operationId: "operation-1", operations: [color] }, count: 1, submitted },
  };

  const accepted = acceptAppliedOperations(queue, result, { past: [], present: local, future: [] }, apply);
  const declarations = accepted.history.present.body[0].style.base;
  assert.equal(accepted.replayFailed, false);
  assert.equal(declarations.color, "#334455");
  assert.equal(declarations.padding, "2rem");
  assert.equal(declarations.gap, 24);
  assert.equal(accepted.queue.base.body[0].style.base.padding, "2rem");
});

test("box grouping is reversible through the operation queue", () => {
  const base = structuredClone(fixture);
  const change = { type: "wrap", nodeIds: ["heading", "lead"], wrapperId: "group_intro", allowLayoutChange: true };
  const wrapped = queuePageEdit(operationQueue(base), base, [change], edit, apply);
  assert.equal(wrapped.queue.fallback, false);
  assert.equal(wrapped.queue.pending[0].type, "wrap");

  const undoneDocument = apply(wrapped.document, wrapped.queue.past[0].inverse[0]);
  const undone = queuePageTravel(wrapped.queue, wrapped.document, undoneDocument, "undo", apply);
  assert.equal(undone.fallback, false);
  assert.deepEqual(undoneDocument.body, base.body);

  const redoneDocument = apply(undoneDocument, undone.future[0].forward[0]);
  const redone = queuePageTravel(undone, undoneDocument, redoneDocument, "redo", apply);
  assert.equal(redone.fallback, false);
  assert.deepEqual(redoneDocument.body, wrapped.document.body);
});
