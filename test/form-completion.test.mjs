import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { DocumentValidationError, parsePageDocument, resolveFormCompletionPath } from "@niho/web/core";
import { commitHistory, editDocument, travelHistory } from "../dist/editor-model.js";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const form = (completion) => ({ type: "element", id: "contact_form", tag: "form", ...(completion ? { formCompletionPageId: completion } : {}), attrs: { name: "contact" }, children: [
  { type: "element", id: "send", tag: "button", attrs: { type: "submit" }, children: [{ type: "text", text: "送信" }] }
] });
const document = (completion) => ({ ...structuredClone(fixture), body: [form(completion)] });
const page = (overrides = {}) => ({ siteId: "demo", pageId: "thanks", locale: "ja-JP", title: "送信完了", path: "/thanks", kind: "page", visibility: "public", published: true, ...overrides });

test("form completion page ID is validated as form-only document data and rejects executable or transport fields", () => {
  const parsed = parsePageDocument(document("thanks"));
  assert.equal(parsed.body[0].formCompletionPageId, "thanks");
  assert.equal(parsed.body[0].attrs.formCompletionPageId, undefined);
  for (const value of ["https://evil.example/thanks", "/thanks", "<script>alert(1)</script>", "javascript:alert(1)", "x onclick=alert(1)"]) {
    assert.throws(() => parsePageDocument(document(value)), DocumentValidationError);
  }
  const nonForm = document(); nonForm.body = [{ type: "element", id: "box", tag: "div", formCompletionPageId: "thanks", children: [] }];
  assert.throws(() => parsePageDocument(nonForm), /only form/u);
  for (const attrs of [{ action: "/collect" }, { method: "post" }, { onsubmit: "alert(1)" }]) {
    const unsafe = document(); unsafe.body[0].attrs = { ...unsafe.body[0].attrs, ...attrs };
    assert.throws(() => parsePageDocument(unsafe), DocumentValidationError);
  }
});

test("formCompletionPage operation is validated, lock-aware, duplicated, and preserved by history", () => {
  const original = parsePageDocument(document());
  const completed = editDocument(original, { type: "formCompletionPage", path: [0], pageId: "thanks" });
  assert.equal(completed.body[0].formCompletionPageId, "thanks");
  assert.equal(editDocument(completed, { type: "duplicate", path: [0] }).body[1].formCompletionPageId, "thanks");
  assert.throws(() => editDocument(original, { type: "formCompletionPage", path: [0], pageId: "/thanks" }), DocumentValidationError);
  assert.throws(() => editDocument(original, { type: "formCompletionPage", path: [0], pageId: "thanks" }, {}, [{ nodeId: "contact_form", fields: ["formCompletionPageId"], reason: "ホスト管理" }]), /ホスト管理/u);
  const history = commitHistory({ past: [], present: original, future: [] }, completed);
  assert.equal(travelHistory(history, "undo", {}, []).present.body[0].formCompletionPageId, undefined);
  assert.equal(travelHistory(travelHistory(history, "undo", {}, []), "redo", {}, []).present.body[0].formCompletionPageId, "thanks");
  assert.equal(editDocument(completed, { type: "formCompletionPage", path: [0], pageId: undefined }).body[0].formCompletionPageId, undefined);
});

test("resolver revalidates the current candidate and fails closed for stale, unsafe, ambiguous, or wrong forms", () => {
  const completed = parsePageDocument(document("thanks")), valid = page();
  assert.equal(resolveFormCompletionPath(completed, "contact_form", [valid]), "/thanks");
  assert.equal(resolveFormCompletionPath(completed, "missing", [valid]), null);
  assert.equal(resolveFormCompletionPath({ ...completed, body: [{ type: "element", id: "contact_form", tag: "div", children: [] }] }, "contact_form", [valid]), null);
  for (const unsafe of [
    [], [page({ pageId: "other" })], [page({ siteId: "other" })], [page({ locale: "en" })], [page({ pageId: "home", path: "/" })],
    [page({ kind: "template" })], [page({ visibility: "private" })], [page({ published: false })], [page({ path: "https://evil.example/thanks" })],
    [page({ path: "/items/[slug]" })], [page(), page({ path: "/thanks-new" })], [page(), page({ visibility: "private" })]
  ]) assert.equal(resolveFormCompletionPath(completed, "contact_form", unsafe), null);
  assert.equal(resolveFormCompletionPath(completed, "contact_form", [page({ path: "/complete" })]), "/complete", "current safe path is resolved on every call");
});
