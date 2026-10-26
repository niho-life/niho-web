import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createLocalizationMemory } from "../examples/localization-workspace-memory.mjs";
import { at, dashboard } from "./project-view-fixtures.mjs";

// Studio の client（studio/client.tsx）を jsdom で動かし、Dashboard の「翻訳」が Worker の切替（site-admin の translationsView）で
// 枠と翻訳の画面（LocalizationWorkspace）に分かれることと、翻訳の画面の URL・戻る/進むを確かめる。値はすべて架空。
const ORIGIN = "https://studio.example.test";
const LOC = "/api/projects/project-kamakura/sites/kamakura/localization";
const FRAME = "https://next-kamakura.niho.life/_studio/localization-preview";
/** CMS の項目の 1 件（架空）。デモのメモリの「お知らせ一覧」をこの key で見せる */
const CMS_KEY = Buffer.from("cms:posts:morning-walk").toString("base64url");
const MEMORY_KEY = "bmV3cw";
const project = { id: "project-kamakura", name: "架空の鎌倉プロジェクト", site: { id: "kamakura", name: "架空のサイト", domains: ["https://site.example.test"] }, members: [{ userId: "member_one", displayName: "参加者（架空）" }] };
const directory = { status: "ready", entries: [{ project, summary: { projectId: project.id, siteId: project.site.id, publicationStatus: "published", publishedUrl: project.site.domains[0], thumbnail: null, updatedAt: at, lastAccessedAt: null } }] };

/** studio/client.tsx を 1 つの ESM に束ねる（React は外のものを使い、テストの act と同じ実体にする）。 */
const bundleDirectory = mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/.tmp-studio-client-l10n-"));
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
const bundle = path.join(bundleDirectory, "client.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../studio/client.tsx", import.meta.url))],
  bundle: true, external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"], format: "esm", platform: "node", target: "node22", outfile: bundle, logLevel: "silent",
  define: { "process.env.NODE_ENV": '"production"' }
});

let dom;
const GLOBALS = ["window", "document", "navigator", "location", "history", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLAnchorElement", "HTMLIFrameElement", "Element", "Node", "Text", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "InputEvent", "PopStateEvent", "MessageEvent", "DOMParser", "File", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DocumentFragment", "Range", "getSelection"];
/** 画面ごとに新しい jsdom（前の画面の listener を持ち込まない）。 */
function installDom(pathname) {
  dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: `${ORIGIN}${pathname}`, pretendToBeVisual: true });
  for (const key of GLOBALS) {
    const value = typeof dom.window[key] === "function" && /^[a-z]/u.test(key) ? dom.window[key].bind(dom.window) : dom.window[key];
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  dom.window.scrollTo = () => undefined;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
}
installDom("/");
const { act } = await import("react");
const wait = (ms) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const flush = async () => { for (let index = 0; index < 10; index += 1) await wait(0); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/** 偽の Studio API と翻訳の BFF（中身は W1 のデモ用のメモリの adapter）。呼ばれた要求を返す。 */
function fakeApi(t) {
  const calls = [];
  const memory = createLocalizationMemory({ frameUrl: FRAME });
  const local = (text) => text.replaceAll(CMS_KEY, MEMORY_KEY), shown = (value) => JSON.parse(JSON.stringify(value).replaceAll(MEMORY_KEY, CMS_KEY));
  const reply = (value) => json(shown(value), value.status === "forbidden" ? 403 : value.status === "not_found" ? 404 : 200);
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url), method = init.method ?? "GET";
    calls.push(`${method} ${target}`);
    if (target.startsWith(`${LOC}/`)) {
      const action = local(target.slice(LOC.length)), body = typeof init.body === "string" ? JSON.parse(local(init.body)) : {};
      const signal = init.signal ?? new AbortController().signal, a = memory.adapter;
      if (method === "PUT" && action === "/settings") return reply(await a.saveSettings(body, signal));
      if (method !== "POST") return json({ error: "method_not_allowed" }, 405);
      if (action === "/overview") return reply(await a.loadOverview(signal));
      if (action === "/items") return reply(await a.listItems({ cursor: null }, signal));
      if (action === "/catalog/advance") return reply(await a.advanceCatalog({}, signal));
      if (action === "/preview/items") return reply(await a.loadPreview(body, signal));
      if (action === "/release") return reply(await a.readRelease(signal));
      const after = /^\/items\/after\/([^/]+)$/u.exec(action), item = /^\/items\/([^/]+)(\/command|\/translate)?$/u.exec(action), job = /^\/jobs\/([^/]+)$/u.exec(action);
      if (after) return reply(await a.listItems({ cursor: after[1] }, signal));
      if (item && !item[2]) return reply(await a.loadItem({ itemKey: item[1] }, signal));
      if (item?.[2] === "/command") return reply(await a.command(body, signal));
      if (item?.[2] === "/translate") return reply(await a.requestTranslation(body, signal));
      if (job) return reply(await a.readJob({ jobId: job[1] }, signal));
      return json({ error: "not_found" }, 404);
    }
    if (method !== "GET") return json({ error: "method_not_allowed" }, 405);
    if (target === "/api/session") return json({ status: "authenticated", subject: "subject-one", email: "editor@example.test" });
    if (target === "/api/projects") return json(directory);
    if (target === "/api/projects/project-kamakura/sites/kamakura/dashboard") return json(dashboard(project));
    if (target === "/api/projects/project-kamakura/sites/kamakura/site-admin") return json({ connected: true });
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
const text = (node) => node.textContent.replace(/\s+/gu, " ").trim();
const byText = (selector, value) => [...document.querySelectorAll(selector)].find((node) => text(node) === value);
const click = async (node) => { assert.ok(node, "target not found"); await act(async () => node.click()); await flush(); };
const row = (title) => [...document.querySelectorAll("button.cw-row-open")].find((node) => node.querySelector(".cw-row-title")?.textContent === title);
const rowLink = (title) => [...document.querySelectorAll("a.cw-row-open")].find((node) => node.querySelector(".cw-row-title")?.textContent === title);
const cmsLink = () => [...document.querySelectorAll(".lw-item a.cw-button")].find((node) => text(node).startsWith("CMS で開く"));
const historyMove = async (direction) => { await act(async () => { window.history[direction](); await new Promise((resolve) => setTimeout(resolve, 20)); }); await flush(); };

test("Studio の翻訳は、翻訳の画面で URL の 1 件を開き、一覧・1 件の移動と戻る/進むを URL に合わせる", async (t) => {
  const calls = await openStudio(t, "/projects/kamakura-site/admin/translations/aG9tZQ");
  assert.equal(document.querySelector(".studio-site-frame"), null);
  assert.ok(document.querySelector(".studio-site-translations .nw-collection.nw-localization"), "LocalizationWorkspace");
  // プロジェクトの中は Dashboard の帯が 1 段のヘッダー（Studio のヘッダーを重ねない）。アカウントは帯の右端
  assert.equal(document.querySelector(".studio-shell-header"), null);
  assert.ok(document.querySelector(".studio-content-project > .nw-project-dashboard .pv-project-end .studio-account"));
  assert.equal(document.querySelector(".studio-legacy-link"), null);
  // URL の 1 件を最初に開く。固定ページの原文はコードで管理なので「CMS で開く」を出さない
  assert.ok(calls.includes(`POST ${LOC}/items/aG9tZQ`));
  assert.ok(document.querySelector('.lw-unit[data-unit-id="title"]'), "1 件の項目");
  assert.equal(cmsLink(), undefined);
  // プレビューの枠は鎌倉の Worker の枠を sandbox で開く
  const frame = document.querySelector("iframe.lw-frame");
  assert.ok(frame, "プレビュー");
  assert.ok(frame.getAttribute("src").startsWith(`${FRAME}#niho-preview=`));
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts");

  // CMS 項目は同じ項目の英語タブに直接入り、固定ページはこの画面の 1 件へ移る。
  const root = document.querySelector(".nw-localization");
  await click(byText("button.cw-back", "一覧へ"));
  assert.equal(window.location.pathname, "/projects/kamakura-site/admin/translations");
  assert.equal(rowLink("お知らせ一覧")?.getAttribute("href"), "/projects/kamakura-site/admin/cms/posts/morning-walk?lang=en");
  await click(row("私たちについて"));
  assert.equal(window.location.pathname, "/projects/kamakura-site/admin/translations/YWJvdXQ");
  assert.equal(document.querySelector(".nw-localization"), root, "同じ画面のまま");
  assert.equal(cmsLink(), undefined, "固定ページの原文はコードで管理");

  // 戻る: URL の一覧で開き直す。進む: 1 件で開き直す
  await historyMove("back");
  assert.equal(window.location.pathname, "/projects/kamakura-site/admin/translations");
  assert.ok(rowLink("お知らせ一覧"), "一覧");
  assert.equal(document.querySelector(".lw-item"), null);
  await historyMove("forward");
  assert.equal(window.location.pathname, "/projects/kamakura-site/admin/translations/YWJvdXQ");
  assert.ok(document.querySelector(".lw-item"), "1 件");
  assert.ok(calls.includes(`POST ${LOC}/items/YWJvdXQ`));

  // 上のタブで開いている翻訳をもう一度押しても移らない。ホームへ移ると Dashboard の URL
  assert.equal(document.querySelector(".pv-dashboard-nav"), null, "翻訳を開いている間はホームの左のメニューを出さない");
  await click(byText(".pv-project-tabs button", "翻訳"));
  assert.equal(window.location.pathname, "/projects/kamakura-site/admin/translations/YWJvdXQ");
  await click(byText(".pv-project-tabs button", "ホーム"));
  assert.equal(window.location.pathname, "/projects/kamakura-site/admin");
  assert.equal(document.querySelector(".nw-localization"), null);
  // 読んだだけで書き込みは呼んでいない
  assert.equal(calls.some((call) => call.startsWith("PUT ") || /\/(command|translate|release\/(prepare|apply))$/u.test(call)), false);
});
