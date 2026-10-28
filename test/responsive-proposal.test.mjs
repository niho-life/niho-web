import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { prepareResponsiveProposal, requestResponsiveProposal, ResponsiveProposalTimeoutError } from "@niho/web/editor";
import { commitHistory, editDocument, fingerprint, travelHistory } from "../dist/editor-model.js";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const document = () => structuredClone(fixture);
const request = (source = document(), scope = { type: "page" }) => ({
  target: { siteId: source.siteId, pageId: source.pageId, locale: source.locale },
  document: structuredClone(source), fingerprint: fingerprint(source), scope, breakpoints: [768, 1024]
});

test("valid responsive proposal applies as one history entry and one undo restores every change", () => {
  const source = document(), input = request(source);
  const review = prepareResponsiveProposal({ document: source, request: input, response: { fingerprint: input.fingerprint, changes: [
    { nodeId: "hero", breakpoint: 768, property: "padding", value: "2rem" },
    { nodeId: "heading", breakpoint: 1024, property: "fontSize", value: 48 }
  ] } });
  assert.equal(review.changes[0].before, null);
  assert.equal(review.changes[1].after, 48);
  const changed = review.operations.reduce((page, operation) => editDocument(page, operation), source);
  let history = commitHistory({ past: [], present: source, future: [] }, changed);
  assert.equal(history.past.length, 1);
  assert.equal(history.present.body[0].style.responsive[0].declarations.padding, "2rem");
  assert.equal(history.present.body[0].children[0].style.responsive[0].declarations.fontSize, 48);
  history = travelHistory(history, "undo", {}, []);
  assert.deepEqual(history.present, source);
});

test("malicious, out-of-scope, duplicate and unparseable proposal changes are rejected atomically", () => {
  const source = document(), input = request(source, { type: "node", nodeId: "heading" });
  const response = (changes, extra = {}) => ({ fingerprint: input.fingerprint, changes, ...extra });
  assert.throws(() => prepareResponsiveProposal({ document: source, request: input, response: response([
    { nodeId: "link", breakpoint: 768, property: "width", value: 10 }
  ]) }), /対象範囲外/u);
  assert.throws(() => prepareResponsiveProposal({ document: source, request: input, response: response([
    { nodeId: "heading", breakpoint: 768, property: "color", value: "red" }
  ]) }), /変更できない/u);
  assert.throws(() => prepareResponsiveProposal({ document: source, request: input, response: response([
    { nodeId: "heading", breakpoint: 768, property: "width", value: "10px;display:none" }
  ]) }), /unsafe|invalid|unsupported|CSS|正しく/u);
  assert.throws(() => prepareResponsiveProposal({ document: source, request: input, response: response([
    { nodeId: "heading", breakpoint: 768, property: "width", value: 10 },
    { nodeId: "heading", breakpoint: 768, property: "width", value: 20 }
  ]) }), /重複/u);
  assert.throws(() => prepareResponsiveProposal({ document: source, request: input, response: response([
    { nodeId: "heading", breakpoint: 900, property: "width", value: 10 }
  ]) }), /依頼していない/u);
  assert.throws(() => prepareResponsiveProposal({ document: source, request: input, response: response([
    { nodeId: "heading", breakpoint: 768, property: "width", value: 10, href: "https://invalid.example" }
  ]) }), /未対応/u);
  assert.throws(() => prepareResponsiveProposal({ document: source, request: input, response: response([], { meta: { title: "changed" } }) }), /未対応/u);
  assert.deepEqual(source, fixture, "rejected review never mutates the live document");
});

test("stale document and mismatched response fingerprints are rejected", () => {
  const source = document(), input = request(source), changed = editDocument(source, { type: "title", value: "changed" });
  const validShape = { fingerprint: input.fingerprint, changes: [{ nodeId: "hero", breakpoint: 768, property: "gap", value: 24 }] };
  assert.throws(() => prepareResponsiveProposal({ document: changed, request: input, response: validShape }), /文書が変更/u);
  assert.throws(() => prepareResponsiveProposal({ document: source, request: input, response: { ...validShape, fingerprint: "another" } }), /対象文書/u);
});

test("proposal request aborts on cancellation and times out even when the host ignores abort", async () => {
  const input = request(), cancel = new AbortController(); let hostAborted = false;
  const pending = requestResponsiveProposal({ propose: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => {
    hostAborted = true; reject(new DOMException("aborted", "AbortError"));
  }, { once: true })) }, input, cancel.signal, 1_000);
  cancel.abort();
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(hostAborted, true);
  await assert.rejects(requestResponsiveProposal({ propose: () => new Promise(() => {}) }, input, new AbortController().signal, 5), ResponsiveProposalTimeoutError);
});
