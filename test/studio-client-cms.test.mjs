import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { EDITING_OPERATIONS } from "@niho/web/editing-api";
import { at, dashboard } from "./project-view-fixtures.mjs";

// Studio の client（studio/client.tsx）を jsdom で動かし、Dashboard の「CMS」が Worker の切替（site-admin の cmsView）で
// 枠とコレクション画面に分かれることと、コレクション画面の URL の合わせ方を確かめる。値はすべて架空。
const ORIGIN = "https://studio.example.test";
const CMS = "/api/projects/project-kamakura/sites/kamakura/cms";
const EDITING_API = "/api/projects/project-kamakura/sites/kamakura/editor/editing-api/v1";
const project = { id: "project-kamakura", name: "架空の鎌倉プロジェクト", site: { id: "kamakura", name: "架空のサイト", domains: ["https://site.example.test"] }, members: [{ userId: "member_one", displayName: "参加者（架空）" }] };
const directory = { status: "ready", entries: [{ project, summary: { projectId: project.id, siteId: project.site.id, publicationStatus: "published", publishedUrl: project.site.domains[0], thumbnail: null, updatedAt: at, lastAccessedAt: null, members: { status: "ready", data: [{ displayName: "一覧オーナー", role: "owner" }, { displayName: "一覧編集者", role: "editor" }] } } }] };
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
function fakeApi(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url), method = init.method ?? "GET";
    calls.push(`${method} ${target}`);
    if (target === "/api/projects/project-kamakura/sites/kamakura/invitations" && method === "POST") return json({ invitationUrl: `${ORIGIN}/invite/example` });
    if (method !== "GET") return json({ error: "method_not_allowed" }, 405);
    if (target === "/api/session") return json({ status: "authenticated", subject: "subject-one", email: "editor@example.test" });
    if (target === "/api/projects") return json(directory);
    if (target === "/api/projects/project-kamakura/sites/kamakura/dashboard") return json(dashboard(project));
    if (target === "/api/projects/project-kamakura/sites/kamakura/site-admin") return json({ connected: true });
    if (target === `${ORIGIN}${EDITING_API}/sites/kamakura/capabilities`) return json({ apiVersion: "v1", siteId: "kamakura", operations: [EDITING_OPERATIONS[0]] });
    if (target === "/api/projects/project-kamakura/sites/kamakura/membership") return json({
      status: "ready", projectName: project.name, siteName: project.site.name,
      members: [{ subject: "subject-one", email: "owner@example.test", role: "owner", displayName: "オーナー（架空）", createdAt: at, isCurrent: true }],
      invitations: [{ id: "invite-one", email: "editor@example.test", role: "editor", createdAt: at, expiresAt: at, status: "pending" }]
    });
    if (target === `${CMS}/schema`) return json(schema);
    if (target === `${CMS}/collections/posts/items`) return json({ status: "ready", collectionId: "posts", items: [summary] });
    if (target === `${CMS}/collections/posts/items/morning-walk`) return json({ status: "ready", item });
    if (target === `${CMS}/collections/posts/items/morning-walk/english-publication`) return json({ status: "ready", englishPublications: { "cms:posts:morning-walk": { state: "retryable-failure", retryable: true, updatedAt: at } } });
    return json({ error: "not_found" }, 404);
  });
  return calls;
}

let instance = 0;
async function openStudio(t, pathname) {
  installDom(pathname);
  const calls = fakeApi(t);
  await act(async () => { await import(`${pathToFileURL(bundle).href}?instance=${++instance}`); });
  await flush();
  return calls;
}
const byText = (selector, text) => [...document.querySelectorAll(selector)].find((node) => node.textContent.replace(/\s+/gu, " ").trim() === text);
const click = async (node) => { assert.ok(node, "target not found"); await act(async () => node.click()); await flush(); };
const input = async (node, value) => { await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(node, value); node.dispatchEvent(new Event("input", { bubbles: true })); }); await flush(); };

test("Project一覧はStudio shellの中央検索・選択済み左nav・アカウントと、disabled導線なしで表示する", async (t) => {
  await openStudio(t, "/");
  const header = document.querySelector(".studio-shell-header");
  assert.ok(header?.querySelector(".studio-logo"));
  assert.ok(header?.querySelector('.studio-directory-search input[type="search"]'));
  assert.ok(header?.querySelector(".studio-account"));
  const nav = document.querySelector(".studio-directory-nav a");
  assert.equal(nav?.getAttribute("href"), "/");
  assert.equal(nav?.getAttribute("aria-current"), "page");
  assert.equal(nav?.textContent.includes("プロジェクト一覧"), true);
  assert.ok(document.querySelector(".studio-directory-main>.nw-project-view"));
  assert.equal(document.querySelector('.nw-project-view input[type="search"]'), null, "検索欄を重複させない");
  assert.equal(byText("button", "新規プロジェクト"), undefined);
  assert.equal([...document.querySelectorAll("th")].some((node) => node.textContent === "メンバー"), true);
  assert.match(document.querySelector(".pv-avatars")?.getAttribute("aria-label") ?? "", /一覧オーナー（オーナー）、一覧編集者（編集者）/u);
  assert.equal(document.body.textContent.includes("参加者（架空）"), false, "Project.membersを全員扱いしない");
  assert.ok(document.querySelector(".pv-preview-initial"));
  const css = readFileSync(new URL("../studio/public/studio.css", import.meta.url), "utf8");
  assert.match(css, /\.studio-shell-header\{height:64px;display:grid/u);
  assert.match(css, /@media\(max-width:600px\).*\.studio-content-directory\{grid-template-columns:48px minmax\(0,1fr\)/u);
});

test("Studio の CMS は、コレクション画面で項目を開き、本文を TipTap で出し、URL を合わせる", async (t) => {
  const calls = await openStudio(t, "/projects/kamakura-site/admin/cms/posts/morning-walk");
  assert.equal(document.querySelector(".studio-site-frame"), null);
  assert.ok(document.querySelector(".studio-site-cms .nw-collection"), "CollectionWorkspace");
  // プロジェクトの中は Dashboard の帯が 1 段のヘッダー（Studio のヘッダーを重ねない）。アカウントは帯の右端
  assert.equal(document.querySelector(".studio-shell-header"), null);
  assert.ok(document.querySelector(".studio-content-project > .nw-project-dashboard .pv-project-end .studio-account"));
  assert.equal(document.querySelector(".studio-legacy-link"), null);
  // URL の項目を最初に開き、本文は TipTap の部品（ProseMirror）で出す
  assert.ok(calls.includes(`GET ${CMS}/collections/posts/items/morning-walk`), JSON.stringify(calls));
  assert.ok(calls.includes(`GET ${CMS}/collections/posts/items/morning-walk/english-publication`));
  assert.equal(document.querySelector('[data-field="title"] input')?.value, "海辺の朝さんぽ");
  assert.match(document.querySelector(".cw-english-publications")?.textContent ?? "", /記事ページ.*失敗（再試行可能）/su);
  assert.equal(document.querySelector(".cw-english-publications")?.textContent.includes("cms:posts"), false);
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

  // 上のタブで開いている CMS をもう一度押しても移らない。ホームへ移ると Dashboard の URL
  assert.equal(document.querySelector(".pv-dashboard-nav"), null, "CMSを開いている間はホームの左のメニューを出さない");
  await click(byText(".pv-project-tabs button", "CMS"));
  assert.equal(window.location.pathname, "/projects/kamakura-site/admin/cms/posts/morning-walk");
  await click(byText(".pv-project-tabs button", "ホーム"));
  assert.equal(window.location.pathname, "/projects/kamakura-site/admin");
  assert.equal(document.querySelector(".nw-collection"), null);
  // 書き込みは呼んでいない（読んだだけで値を書き換えない）
  assert.equal(calls.some((call) => !call.startsWith("GET ")), false);
});

test("Studio のオーナー向けメンバー管理は表を使い、上部の招待ボタンでフォームを開く", async (t) => {
  const calls = await openStudio(t, "/projects/kamakura-site/admin", "workspace");
  await click(byText(".pv-dashboard-nav button", "プロジェクト設定"));
  assert.ok(document.querySelector(".studio-members"));
  assert.equal(document.querySelector(".studio-invite-form"), null, "招待フォームを常時表示しない");
  assert.equal(document.querySelectorAll(".studio-admin-table").length, 2);
  assert.equal(document.querySelectorAll(".studio-admin-list").length, 0);
  assert.equal(document.querySelector(".studio-role")?.textContent, "オーナー");
  assert.equal(document.querySelector(".studio-status")?.textContent, "承諾待ち");

  const invite = byText(".studio-section-actions button", "招待");
  assert.equal(invite.getAttribute("aria-expanded"), "false");
  await click(invite);
  assert.ok(document.querySelector("#studio-invite-fields .studio-invite-form"));
  assert.equal(byText(".studio-section-actions button", "閉じる").getAttribute("aria-expanded"), "true");
  await input(document.querySelector('.studio-invite-form input[type="email"]'), "new@example.test");
  await click(byText(".studio-invite-form button", "招待 URL を作成"));
  assert.ok(calls.includes("POST /api/projects/project-kamakura/sites/kamakura/invitations"));
  assert.equal(document.querySelector(".studio-copy input")?.value, `${ORIGIN}/invite/example`);
});

test("Studio-native の CMS を Dashboard から開き、下書き作成の再送とプレビューを同じサイトで行う", async (t) => {
  const project = { id: "project-native", name: "架空の Studio サイト",
    site: { id: "site-native", name: "架空のサイト", domains: ["https://public.example.test"] }, members: [] };
  const root = `/projects/${project.id}/sites/${project.site.id}`, apiRoot = `/api${root}`, endpoint = `${apiRoot}/cms/v2`;
  const schema = { contractVersion: 2, siteId: project.site.id, schemaRevision: "initial", retiredFields: [],
    collections: [{ id: "posts", label: "お知らせ", addLabel: "項目を追加", pathPrefix: "/cms/posts/", titleField: "title",
      slugField: "slug", imageField: null, subtitleField: null, capabilities: { create: true, remove: true, schedule: true },
      fields: [{ key: "title", fieldId: "title", label: "タイトル", type: "text", placement: "main" }] }] };
  const item = { siteId: project.site.id, schemaRevision: "initial", locale: "ja", itemId: "item_fixture", collectionId: "posts",
    revision: "rev_fixture", values: { title: "架空の下書き" } };
  const otherItem = { ...item, itemId: "item_other", revision: "rev_other", values: { title: "別の記事" } };
  let liveOtherItem = otherItem;
  const observed = [];
  let attempts = 0;
  let finishSave;
  let discardEdits = false;
  installDom(root);
  t.mock.method(window, "confirm", (message) => {
    observed.push({ path: "confirm", input: message });
    return discardEdits;
  });
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    if (url === "/api/session") return json({ status: "authenticated", subject: "example-owner", email: "owner@example.test" });
    if (url === "/api/config") return json({ managedProjectsEnabled: true, publicSitesOrigin: project.site.domains[0] });
    if (url === "/api/projects") return json({ status: "ready", entries: [{ project, summary: {
      ...directory.entries[0].summary, projectId: project.id, siteId: project.site.id, publishedUrl: project.site.domains[0]
    } }] });
    if (url === `${apiRoot}/dashboard`) return json(dashboard(project));
    if (url === `${endpoint}/discover`) return json({ siteId: project.site.id, contractVersion: 2, schemaRevision: "initial", operations: ["cms.schema.apply"] });
    if (!String(url).startsWith(endpoint)) return json({ error: "not_found" }, 404);
    const path = String(url).slice(endpoint.length + 1), input = JSON.parse(init.body);
    assert.equal(input.siteId, project.site.id);
    observed.push({ path, key: new Headers(init.headers).get("X-Studio-Operation-Key"), input });
    if (path === "cms.schema.read") return json(schema);
    if (path === "cms.release.current") return json({ snapshot: null, locale: "ja", collectionRoot: "/s/native/cms" });
    if (path === "cms.items.list") return json({ items: attempts < 2 ? [] : [
      { id: item.itemId, title: item.values.title, revision: item.revision, removedAt: null, scheduleId: null, status: "draft", scheduledAt: null },
      { id: liveOtherItem.itemId, title: liveOtherItem.values.title, revision: liveOtherItem.revision, removedAt: null, scheduleId: null, status: "draft", scheduledAt: null },
    ], nextCursor: null });
    if (path === "cms.items.read") return json({ item: input.itemId === otherItem.itemId ? liveOtherItem : item,
      summary: { id: input.itemId, title: input.itemId === otherItem.itemId ? liveOtherItem.values.title : item.values.title,
        revision: input.itemId === otherItem.itemId ? liveOtherItem.revision : item.revision,
        removedAt: null, scheduleId: null, status: "draft", scheduledAt: null } });
    if (path === "cms.items.create") return ++attempts === 1 ? json({ error: "service_unavailable" }, 503) : json({ item });
    if (path === "cms.items.save") return new Promise((resolve) => { finishSave = () => resolve(json({ item: {
      ...(input.itemId === otherItem.itemId ? liveOtherItem : item), revision: "rev_saved", values: input.values
    } })); });
    if (path === "cms.preview.prepare") return json({ previewId: "fixture-preview", expiresAt: at });
    if (path === "cms.preview.read") return json({ preview: { title: input.previewId === "fixture-preview" ? "編集済みの下書き" : item.values.title, fields: [] }, expiresAt: at });
    return json({ error: "not_found" }, 404);
  });
  await act(async () => { await import(`${pathToFileURL(bundle).href}?instance=${++instance}`); });
  await flush();
  assert.ok(byText("button", "CMS"), document.body.textContent);
  await click(byText("button", "CMS"));
  if (!byText("button", "項目を追加")) await wait(350);
  assert.equal(window.location.pathname, `${root}/cms`);
  assert.ok(document.querySelector('[aria-label="CMS"]'));
  await click(byText("button", "項目を追加"));
  assert.match(document.querySelector('[aria-label="CMS"]').textContent, /操作が完了しませんでした/u);
  await click(byText("button", "項目を追加"));
  const creates = observed.filter(({ path }) => path === "cms.items.create");
  assert.equal(creates.length, 2);
  assert.ok(creates[0].key);
  assert.equal(creates[0].key, creates[1].key);
  const title = document.querySelector(".studio-native-cms-item input");
  await input(title, "編集済みの下書き");
  await click(byText("button", "下書きを保存"));
  assert.equal(title.disabled, true, "保存応答を待つ間の編集を止める");
  finishSave();
  await flush();
  assert.equal(document.querySelector(".studio-native-cms-item input").disabled, false);
  await click(byText("button", "下書きをプレビュー"));
  assert.equal(document.querySelector('[aria-label="下書きプレビュー"] h2')?.textContent, "編集済みの下書き");
  assert.equal(observed.find(({ path }) => path === "cms.preview.read")?.input.previewId, "fixture-preview");
  assert.doesNotMatch(window.location.href, /fixture-preview/u);

  const otherRow = byText('ul[aria-label="項目一覧"] button', "別の記事 下書き");
  assert.ok(otherRow);
  await input(document.querySelector(".studio-native-cms-item input"), "保存していない変更");
  await click(otherRow);
  assert.equal(observed.filter(({ path }) => path === "confirm").length, 1);
  assert.equal(observed.filter(({ path, input }) => path === "cms.items.read" && input.itemId === otherItem.itemId).length, 0);
  assert.equal(document.querySelector(".studio-native-cms-item input").value, "保存していない変更");

  discardEdits = true;
  await click(otherRow);
  assert.equal(observed.filter(({ path, input }) => path === "cms.items.read" && input.itemId === otherItem.itemId).length, 1);
  assert.equal(document.querySelector(".studio-native-cms-item input").value, "別の記事");

  liveOtherItem = { ...liveOtherItem, revision: "rev_external", values: { title: "別の編集者が保存した内容" } };
  await click(byText("button", "一覧を更新"));
  assert.equal(document.querySelector(".studio-native-cms-item input").value, "別の編集者が保存した内容");
  await input(document.querySelector(".studio-native-cms-item input"), "更新後に保存する内容");
  await click(byText("button", "下書きを保存"));
  const latestSave = observed.filter(({ path }) => path === "cms.items.save").at(-1);
  assert.equal(latestSave.input.expectedRevision, "rev_external");
  finishSave();
  await flush();
});
