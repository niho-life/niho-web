import { readFile } from "node:fs/promises";
import { createPageEditingApi } from "../dist/editing-api.js";
import { createMemoryPageOperationHost } from "./memory-page-operation-host.mjs";

const document = JSON.parse(await readFile(new URL("./page.json", import.meta.url), "utf8"));
document.body.push({ type: "component", id: "demo-booking-panel", block: "booking-panel", props: { title: "Book a visit" } });
const target = { siteId: document.siteId, pageId: document.pageId, locale: document.locale };
const storage = createMemoryPageOperationHost([{ document, version: "example-v1" }],
  { blocks: { "booking-panel": { props: { title: { type: "string", required: true } } } } });
const hostApi = createPageEditingApi({
  ...storage,
  async authenticate(request) {
    return request.headers.get("Authorization") === "Bearer example-token" ? { kind: "machine", subject: "example-agent", clientKind: "api" } : null;
  },
  async authorize(actor, capability, scope) {
    return actor.kind === "machine" && scope.siteId === target.siteId && ["pages.read", "pages.edit"].includes(capability);
  },

});

const route = `/api/edit/v1/sites/${target.siteId}`;
const call = async (path, method = "GET", body) => hostApi(new Request(`https://example.host${path}`, {
  method,
  headers: { Authorization: "Bearer example-token", ...(body ? { "Content-Type": "application/json" } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {})
}));
const discover = await call(`${route}/capabilities`);
const readPath = `${route}/operations/pages.read/${target.pageId}?locale=${encodeURIComponent(target.locale)}`;
const snapshotResponse = await call(readPath);
const snapshot = await snapshotResponse.json();
const changed = structuredClone(snapshot.document);
changed.title = "Updated with the host-neutral editing API";
changed.body[0].style.base.backgroundColor = "#e8f0e8";
changed.body[0].children.push({ type: "element", id: "contact-form", tag: "form", attrs: { name: "contact" }, children: [
  { type: "element", id: "contact-name-label", tag: "label", attrs: { htmlFor: "contact-name" }, children: [{ type: "text", text: "Name" }] },
  { type: "element", id: "contact-name", tag: "input", attrs: { type: "text", name: "name", id: "contact-name", required: true }, children: [] }
] });
const savePath = `${route}/operations/pages.save/${target.pageId}?locale=${encodeURIComponent(target.locale)}`;
const savedResponse = await call(savePath, "PUT", { expectedVersion: snapshot.version, document: changed });
const saved = await savedResponse.json();
const conflictResponse = await call(savePath, "PUT", { expectedVersion: snapshot.version, document: snapshot.document });
const conflict = await conflictResponse.json();

const applyPath = `${route}/operations/pages.apply/${target.pageId}?locale=${encodeURIComponent(target.locale)}`;
const input = { baseVersion: saved.version, operationId: crypto.randomUUID(),
  operations: [{ type: "text", parentId: "heading", childPath: [0], value: "海のそばで暮らす" }] };
const appliedResponse = await call(applyPath, "POST", input);
const applied = await appliedResponse.json();
const retry = await (await call(applyPath, "POST", input)).json();
if (appliedResponse.status !== 200 || applied.version !== retry.version || storage.readJournal().length !== 1) throw new Error("operation retry did not return the committed draft");

console.log(JSON.stringify({
  operations: (await discover.json()).operations.map(({ id, method }) => ({ id, method })),
  read: { status: snapshotResponse.status, version: snapshot.version, block: snapshot.document.body.at(-1).block },
  save: { status: savedResponse.status, version: saved.version, title: saved.document.title,
    backgroundColor: saved.document.body[0].style.base.backgroundColor, addedForm: saved.document.body[0].children.at(-1).tag === "form" },
  apply: { status: appliedResponse.status, revision: applied.revision, bytes: Buffer.byteLength(JSON.stringify(input)), sameVersionOnRetry: applied.version === retry.version },
  staleSave: { status: conflictResponse.status, error: conflict.error }
}, null, 2));
