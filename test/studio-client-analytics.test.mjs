import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { at, dashboard } from "./project-view-fixtures.mjs";

// Studio の client（studio/client.tsx）のアナリティクスのタブ: 集計は owner / editor、接続欄は owner だけ。値はすべて架空。
const ORIGIN = "https://studio.example.test";
const SITE = "https://site.example.test";
const BASE = "/api/projects/project-alpha/sites/site-alpha";
const project = { id: "project-alpha", name: "架空のプロジェクト", site: { id: "site-alpha", name: "架空のサイト", domains: [SITE] }, members: [{ userId: "member_one", displayName: "参加者（架空）" }] };
const directory = { status: "ready", entries: [{ project, summary: { projectId: project.id, siteId: project.site.id, publicationStatus: "published", publishedUrl: SITE, thumbnail: null, updatedAt: at, lastAccessedAt: null } }] };
const notConnected = {
  ga4: { measurementId: null, trackingTagState: "not-configured", propertyId: null, reportingState: "not-connected", propertyTimeZone: null, lastSyncedAt: null },
  searchConsole: { property: null, ownershipState: "not-verified", verificationMethod: null, reportingState: "not-connected", lastSyncedAt: null }
};

const bundleDirectory = mkdtempSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../node_modules/.tmp-studio-client-analytics-"));
after(() => rmSync(bundleDirectory, { recursive: true, force: true }));
const bundle = path.join(bundleDirectory, "client.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../studio/client.tsx", import.meta.url))],
  bundle: true, external: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"], format: "esm", platform: "node", target: "node22", outfile: bundle, logLevel: "silent",
  define: { "process.env.NODE_ENV": '"production"' }
});

let dom;
const GLOBALS = ["window", "document", "navigator", "location", "history", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLAnchorElement", "Element", "Node", "Text", "Event", "MouseEvent", "KeyboardEvent", "FocusEvent", "InputEvent", "PopStateEvent", "DOMParser", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "DocumentFragment"];
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
const flush = async () => { for (let index = 0; index < 8; index += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

function fakeApi(t, role) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const target = String(url), method = init.method ?? "GET";
    calls.push(`${method} ${target}`);
    if (target === "/api/session") return json({ status: "authenticated", subject: "subject-one", email: "member@example.test" });
    if (target === "/api/projects") return json(directory);
    if (target === `${BASE}/dashboard`) return json(dashboard(project));
    if (target === `${BASE}/membership`) return role === "owner"
      ? json({ status: "ready", projectName: project.name, siteName: project.site.name, members: [], invitations: [] })
      : json({ error: "forbidden" }, 403);
    const report = /^\/api\/projects\/project-alpha\/sites\/site-alpha\/analytics\/report\?period=(7d|28d|3m|12m)$/u.exec(target);
    if (report && method === "GET") return json({ projectId: project.id, siteId: project.site.id, period: report[1], ga4: { state: "not-connected" }, searchConsole: { state: "not-connected" } });
    if (target === `${BASE}/analytics/connection` && method === "GET") return json({ target: { projectId: project.id, siteId: project.site.id, siteOrigin: SITE }, ...notConnected });
    return json({ error: "not_found" }, 404);
  });
  return calls;
}
let instance = 0;
async function openStudio(t, role) {
  installDom(`/projects/${project.id}/sites/${project.site.id}`);
  const calls = fakeApi(t, role);
  await act(async () => { await import(`${pathToFileURL(bundle).href}?instance=${++instance}`); });
  await flush();
  return calls;
}
const button = (text) => [...document.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
const click = async (node) => { assert.ok(node, "target not found"); await act(async () => node.click()); await flush(); };

test("owners see the site analytics and the reporting connection in the Analytics tab", async (t) => {
  const calls = await openStudio(t, "owner");
  assert.equal(calls.some((call) => call.includes("/analytics/")), false, "開くまで分析を読まない");
  // ホームの要約の「アクセス解析を見る」はアナリティクスのタブを開く
  await click(button("アクセス解析を見る"));
  assert.equal(button("アナリティクス").getAttribute("aria-current"), "page");
  assert.ok(document.querySelector(".pv-analytics-content .studio-analytics .nw-analytics"));
  assert.ok(calls.includes(`GET ${BASE}/analytics/report?period=28d`));
  assert.ok(calls.includes(`GET ${BASE}/membership`));
  assert.ok(calls.includes(`GET ${BASE}/analytics/connection`));
  const apps = document.querySelector(".studio-analytics .nw-site-apps");
  assert.ok(apps, "owner には接続欄");
  assert.ok(apps.textContent.includes(SITE));
  // Studio は計測タグの公開・削除と所有権確認を扱わない
  assert.equal(apps.querySelector('input[placeholder="G-XXXXXXXXXX"]'), null);
  for (const label of ["タグの変更を確認", "所有権確認の準備", "所有権を確認"]) assert.equal(button(label), undefined, label);
  assert.ok(button("接続内容を確認")); assert.ok(button("レポート接続の準備"));
  assert.equal(button("解析接続（準備中）"), undefined);
});

test("editors see the site analytics without the connection controls", async (t) => {
  const calls = await openStudio(t, "editor");
  await click(button("アナリティクス"));
  assert.ok(document.querySelector(".studio-analytics .nw-analytics"));
  assert.ok(calls.includes(`GET ${BASE}/analytics/report?period=28d`));
  assert.equal(document.querySelector(".nw-site-apps"), null);
  assert.equal(calls.includes(`GET ${BASE}/analytics/connection`), false);
});
