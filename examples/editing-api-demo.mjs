import { readFile } from "node:fs/promises";
import { createPageEditingApi } from "../dist/editing-api.js";

const document = JSON.parse(await readFile(new URL("./page.json", import.meta.url), "utf8"));
document.body.push({ type: "component", id: "demo-booking-panel", block: "booking-panel", props: { title: "Book a visit" } });
const target = { siteId: document.siteId, pageId: document.pageId, locale: document.locale };
let version = "example-v1";
const hostApi = createPageEditingApi({
  async authenticate(request) {
    return request.headers.get("Authorization") === "Bearer example-token" ? { kind: "machine", subject: "example-agent" } : null;
  },
  async authorize(actor, capability, scope) {
    return actor.kind === "machine" && scope.siteId === target.siteId && ["pages.read", "pages.edit"].includes(capability);
  },
  async validationContext() {
    return { blocks: { "booking-panel": { props: { title: { type: "string", required: true } } } } };
  },
  async readPage(_actor, requested) {
    return requested.siteId === target.siteId && requested.pageId === target.pageId && requested.locale === target.locale ? { document, version } : null;
  },
  async savePage(_actor, requested, expectedVersion, candidate) {
    if (requested.siteId !== target.siteId || requested.pageId !== target.pageId || requested.locale !== target.locale || expectedVersion !== version) {
      return { status: "conflict" };
    }
    Object.assign(document, { ...candidate, revision: candidate.revision + 1 });
    version = `example-v${Number(version.slice("example-v".length)) + 1}`;
    return { status: "saved", version, document };
  }
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

console.log(JSON.stringify({
  operations: (await discover.json()).operations.map(({ id, method }) => ({ id, method })),
  read: { status: snapshotResponse.status, version: snapshot.version, block: snapshot.document.body.at(-1).block },
  save: { status: savedResponse.status, version: saved.version, title: saved.document.title,
    backgroundColor: saved.document.body[0].style.base.backgroundColor, addedForm: saved.document.body[0].children.at(-1).tag === "form" },
  staleSave: { status: conflictResponse.status, error: conflict.error }
}, null, 2));
