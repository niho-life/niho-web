import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { at, dashboard } from "./project-view-fixtures.mjs";

// Studio の client（studio/client.tsx）を jsdom で動かし、Dashboard の「CMS」が Worker の切替（site-admin の cmsView）で
// 枠とコレクション画面に分かれることと、コレクション画面の URL の合わせ方を確かめる。値はすべて架空。
const ORIGIN = "https://studio.example.test";
const CMS = "/api/projects/project-kamakura/sites/kamakura/cms";
const project = { id: "project-kamakura", name: "架空の鎌倉プロジェクト", site: { id: "kamakura", name: "架空のサイト", domains: ["https://site.example.test"] }, members: [{ userId: "member_one", displayName: "参加者（架空）" }] };
const directory = { status: "ready", entries: [{ project, summary: { projectId: project.id, siteId: project.site.id, publicationStatus: "published", publishedUrl: project.site.domains[0], thumbnail: null, updatedAt: at, lastAccessedAt: null } }] };
const schema = {
  status: "ready",
  collections: [{
    id: "posts", label: "記事", addLabel: "新しく書く", icon: "document", ordering: "publishedAt", pathPrefix: "/posts/",
    titleField: "title", slugField: "slug", imageField: null, subtitleField: null,
    capabilities: { create: true, duplicate: true, remove: true, unpublish: true, schedule: true },
    fields: [
      { key: "title", label: "タイトル", type: "text", required: true, placement: "main" },
      { key: "body", label: "本文", type: "richText", placement: "main" },
      { key: "slug", label: "アドレス", type: "slug", required: true, placement: "side" }
    ]
  }]
};
const summary = { id: "morning-walk", title: "海辺の朝さんぽ", subtitle: null, imageUrl: null, path: "/posts/morning-walk", status: "published", publishedAt: at, updatedAt: at, updatedBy: "書き手（架空）", scheduledAt: null, publishFailed: false, order: null };
const item = { ...summary, version: "v1", values: { title: "海辺の朝さんぽ", body: "<h2 id=\"index_Ab3dE5fG\">はじめに</h2><p>朝の<strong>海辺</strong>。</p>", slug: "morning-walk" } };

/** studio/client.tsx を 1 つの ESM に束ねる（React は外のものを使い、テストの act と同じ実体にする）。 */
const bundleDirectory = mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/.tmp-studio-client-"));
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
const bundle = path.join(bundleDirectory, "client.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../studio/client.tsx", import.meta.url))],
  bundle: true, external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"], format: "esm", platform: "node", target: "node22", outfile: bundle, logLevel: "silent",
  define: { "process.env.NODE_ENV": '"production"' }
});

let dom;
const GLOBALS = ["window", "document", "navigator", "location", "history", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLAnchorElement", "Element", "Node", "Text", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "InputEvent", "PopStateEvent", "DOMParser", "File", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DocumentFragment", "Range", "getSelection"];
/** 画面ごとに新しい jsdom（前の画面の listener を持ち込まない）。 */
function installDom(pathname) {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: `${ORIGIN}${pathname}`, pretendToBeVisual: true });
  for (const key of GLOBALS) {
    const value = typeof dom.window[key] === "function" && /^[a-z]/u.test(key) ? dom.window[key].bind(dom.window) : dom.window[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  // jsdom は配置を持たない。ProseMirror が位置を測る所だけ空の値を返す
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
  dom.window.document.elementFromPoint = () => null;
  dom.window.scrollTo = () => undefined;
  globalThis.ClipboardEvent ??= class ClipboardEvent extends dom.window.Event { constructor(type, init = {}) { super(type, init); this.clipboardData = init.clipboardData ?? null; } };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}
installDom("/");
const { act } = await import("react");
const wait = (ms) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const flush = async () => { for (let index = 0; index < 8; index += 1) await wait(0); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/** 偽の Studio API と CMS の BFF。呼ばれた path を返す。 */
function fakeApi(t, cmsView) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url), method = init.method ?? "GET";
    calls.push(`${method} ${target}`);
    if (method !== "GET") return json({ error: "method_not_allowed" }, 405);
    if (target === "/api/session") return json({ status: "authenticated", subject: "subject-one", email: "editor@example.test" });
    if (target === "/api/projects") return json(directory);
    if (target === "/api/projects/project-kamakura/sites/kamakura/dashboard") return json(dashboard(project));
    if (target === "/api/projects/project-kamakura/sites/kamakura/site-admin") return json({ origin: "https://admin.example.test", paths: { cms: "/admin", translations: "/admin/localization" }, ...(cmsView === undefined ? {} : { cmsView }) });
    if (target === `${CMS}/schema`) return json(schema);
    if (target === `${CMS}/collections/posts/items`) return json({ status: "ready", collectionId: "posts", items: [summary] });
    if (target === `${CMS}/collections/posts/items/morning-walk`) return json({ status: "ready", item });
    return json({ error: "not_found" }, 404);
  });
  return calls;
}

let instance = 0;
async function openStudio(t, pathname, cmsView) {
  installDom(pathname);
  const calls = fakeApi(t, cmsView);
  await act(async () => { await import(`${pathToFileURL(bundle).href}?instance=${++instance}`); });
  await flush();
  return calls;
}
const byText = (selector, text) => [...document.querySelectorAll(selector)].find((node) => node.textContent.replace(/\s+/gu, " ").trim() === text);
const click = async (node) => { assert.ok(node, "target not found"); await act(async () => node.click()); await flush(); };

test("切替が off（frame・値なし）の Dashboard の CMS は、従来どおりサイト側の管理画面の枠", async (t) => {
  for (const cmsView of [undefined, "frame", "unknown"]) {
    const calls = await openStudio(t, "/projects/kamakura-site/admin/cms", cmsView);
    const frame = document.querySelector(".studio-site-frame iframe");
    assert.ok(frame, String(cmsView));
    assert.equal(frame.getAttribute("src"), "https://admin.example.test/admin");
    assert.equal(document.querySelector(".nw-collection"), null);
    assert.equal(calls.some((call) => call.includes("/cms/")), false, "BFF を呼ばない");
  }
});

test("切替が on（workspace）の CMS は、コレクション画面で項目を開き、本文を TipTap で出し、URL を合わせる", async (t) => {
  const calls = await openStudio(t, "/projects/kamakura-site/admin/cms/posts/morning-walk", "workspace");
  assert.equal(document.querySelector(".studio-site-frame"), null);
  assert.ok(document.querySelector(".studio-site-cms .nw-collection"), "CollectionWorkspace");
  // 旧画面は別のタブで開ける
  const legacy = byText(".studio-site-cms-bar a", "旧画面（/admin）を開く ↗");
  assert.ok(legacy);
  assert.equal(legacy.getAttribute("href"), "https://admin.example.test/admin");
  assert.equal(legacy.getAttribute("target"), "_blank");
  assert.equal(legacy.getAttribute("rel"), "noopener");
  // URL の項目を最初に開き、本文は TipTap の部品（ProseMirror）で出す
  assert.ok(calls.includes(`GET ${CMS}/collections/posts/items/morning-walk`));
  assert.equal(document.querySelector('[data-field="title"] input')?.value, "海辺の朝さんぽ");
  const prose = document.querySelector('[data-field="body"] .studio-rich-mount .ProseMirror');
  assert.ok(prose, "TipTap");
  assert.match(prose.textContent, /はじめに/u);

  // 一覧へ戻ると URL が一覧になり、項目を開くと項目の URL になる（画面は作り直さない＝schema を読み直さない）
  const schemaReads = () => calls.filter((call) => call === `GET ${CMS}/schema`).length;
  assert.equal(schemaReads(), 1);
  await click(byText("button.cw-back", "一覧へ"));
  assert.equal(window.location.pathname, "/projects/kamakura-site/admin/cms/posts");
  assert.ok(document.querySelector(".cw-row-open[data-item-id=\"morning-walk\"]"));
  await click(document.querySelector(".cw-row-open[data-item-id=\"morning-walk\"]"));
  assert.equal(window.location.pathname, "/projects/kamakura-site/admin/cms/posts/morning-walk");
  assert.equal(schemaReads(), 1);

  // 戻る: URL の一覧で開き直す。進む: 項目で開き直す
  await act(async () => { window.history.back(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  await flush();
  assert.equal(window.location.pathname, "/projects/kamakura-site/admin/cms/posts");
  assert.ok(document.querySelector(".cw-list"), "一覧");
  assert.equal(document.querySelector(".cw-editor-bar"), null);
  await act(async () => { window.history.forward(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  await flush();
  assert.equal(window.location.pathname, "/projects/kamakura-site/admin/cms/posts/morning-walk");
  assert.equal(document.querySelector('[data-field="title"] input')?.value, "海辺の朝さんぽ");

  // サイトナビで開いている CMS をもう一度押しても移らない。ホームへ移ると Dashboard の URL
  await click(byText(".pv-global-nav button", "CMS"));
  assert.equal(window.location.pathname, "/projects/kamakura-site/admin/cms/posts/morning-walk");
  await click(byText(".pv-global-nav button", "ホーム"));
  assert.equal(window.location.pathname, "/projects/kamakura-site/admin");
  assert.equal(document.querySelector(".nw-collection"), null);
  // 書き込みは呼んでいない（読んだだけで値を書き換えない）
  assert.equal(calls.some((call) => !call.startsWith("GET ")), false);
});
