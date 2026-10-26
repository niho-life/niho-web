import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { dashboard, directory, project } from "./project-view-fixtures.mjs";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://host.example.test" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Event", "MouseEvent"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ProjectDirectory } = await import("@niho/web/project-directory");
const { ProjectDashboard } = await import("@niho/web/project-dashboard");
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (name) => [...document.querySelectorAll("button")].find((node) => (node.getAttribute("aria-label") || node.textContent) === name);
const click = async (name) => { assert.ok(button(name), name); await act(async () => button(name).click()); await flush(); };
const directoryAdapter = (loadDirectory = async () => directory()) => ({ loadDirectory, isThumbnailUrlAllowed: (url) => url.startsWith("https://assets.example.test/") });
const dashboardAdapter = (loadDashboard = async () => dashboard()) => ({ loadDashboard });
async function setup(Component, inputProps) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container), calls = { creates: 0, dashboards: [], editors: [], settings: [], backs: 0 };
  const callbacks = { onCreateProject: () => calls.creates++, onOpenDashboard: (value) => calls.dashboards.push(value), onOpenEditor: (value) => calls.editors.push(value), onOpenSettings: (value, section) => calls.settings.push([value, section]), onBackToProjects: () => calls.backs++ };
  let props = { ...callbacks, ...inputProps };
  const rerender = async (next) => { props = { ...props, ...next }; await act(async () => root.render(createElement(Component, props))); await flush(); };
  await rerender({});
  return { calls, rerender, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}
async function search(value) {
  const input = document.querySelector('input[type="search"]');
  await act(async () => { Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); await flush();
}
const cards = () => [...document.querySelectorAll(".pv-card")];
const rows = () => [...document.querySelectorAll(".pv-directory-list tbody tr")];

test("directory is independent from management and supports two Projects, search, sort and scoped routes", async () => {
  const app = await setup(ProjectDirectory, { adapter: directoryAdapter() });
  try {
    assert.equal(document.querySelector(".nw-project-manager"), null);
    assert.equal(cards().length, 2); assert.ok(cards()[0].textContent.includes("twoの"));
    assert.equal(rows().length, 2); assert.ok(rows()[0].textContent.includes("twoの"));
    assert.equal(document.body.textContent.includes("未取得"), false);
    assert.equal(document.body.textContent.includes("最終アクセス"), false);
    assert.equal(document.body.textContent.includes("プラン"), false);
    assert.match(rows()[0].querySelector(".pv-avatars").getAttribute("aria-label"), /共通参加者（架空）/u);
    assert.equal(cards()[0].querySelectorAll(".pv-live").length, 1);
    assert.equal(cards()[0].querySelector(".pv-domain").textContent, project("two").site.domains[0]);
    assert.equal(cards()[0].querySelector(".pv-actions"), null);
    assert.equal(document.querySelectorAll("textarea").length, 0);
    await click("新規プロジェクト"); assert.equal(app.calls.creates, 1);
    await click(`${project("two").name}（${project("two").site.name}）のダッシュボード`); assert.deepEqual(app.calls.dashboards[0], project("two"));
    await act(async () => rows()[0].querySelectorAll(".pv-project-menu button")[1].click()); assert.equal(app.calls.editors[0].site.id, "site_two");
    await app.rerender({ editorAction: "pending" });
    assert.equal(rows()[0].querySelectorAll(".pv-project-menu button")[1].textContent, "エディター接続待ち");
    await app.rerender({ editorAction: "hidden", memberDetails: "hidden", createAction: "disabled" });
    assert.equal(rows()[0].querySelectorAll(".pv-project-menu button").length, 1);
    assert.equal([...document.querySelectorAll("th")].some((node) => node.textContent === "メンバー"), false);
    assert.equal(button("新規プロジェクト"), undefined);
    await app.rerender({ editorAction: "enabled" });
    await search("one.example.test"); assert.equal(cards().length, 1); assert.equal(rows().length, 1); assert.ok(cards()[0].textContent.includes("oneの"));
    await search("存在しない名前"); assert.ok(document.body.textContent.includes("条件に一致する"));
    await click("検索解除"); assert.equal(cards().length, 2); assert.equal(rows().length, 2);
    const select = document.querySelector("select"); await act(async () => { select.value = "name"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    assert.ok(cards()[0].textContent.includes("oneの")); assert.ok(rows()[0].textContent.includes("oneの"));
    const open = button(`${project().name}（${project().site.name}）のダッシュボード`); open.focus(); assert.equal(document.activeElement, open);
    assert.ok([...document.querySelectorAll("button")].every((node) => node.type === "button"));
    const img = cards()[0].querySelector("img"); assert.ok(img.alt); await act(async () => img.dispatchEvent(new Event("error")));
    assert.equal(cards()[0].querySelector("img"), null); assert.ok(cards()[0].querySelector(".pv-preview-initial"));
    assert.equal(document.body.textContent.includes("プレビューなし"), false);
  } finally { await app.cleanup(); }
});

test("directory accepts a host-controlled external search without duplicating its input", async () => {
  const changes = [];
  const app = await setup(ProjectDirectory, { adapter: directoryAdapter(), searchValue: "one", onSearchValueChange: (value) => changes.push(value), searchControl: "external" });
  try {
    assert.equal(document.querySelector('input[type="search"]'), null);
    assert.equal(cards().length, 1); assert.ok(cards()[0].textContent.includes("oneの"));
    await app.rerender({ searchValue: "存在しない名前" });
    await click("検索解除"); assert.deepEqual(changes, [""]);
    await app.rerender({ searchValue: "" }); assert.equal(cards().length, 2);
  } finally { await app.cleanup(); }
});

test("directory can render display-only member summaries without falling back to Project members", async () => {
  const input = directory();
  input.entries[1].summary.members = { status: "ready", data: [{ displayName: "一覧オーナー", role: "owner" }, { displayName: "一覧編集者", role: "editor" }] };
  input.entries[0].summary.members = { status: "unavailable" };
  const app = await setup(ProjectDirectory, { adapter: directoryAdapter(async () => input), memberDetails: "summary" });
  try {
    assert.equal([...document.querySelectorAll("th")].some((node) => node.textContent === "メンバー"), true);
    assert.match(rows()[0].querySelector(".pv-avatars").getAttribute("aria-label"), /一覧オーナー（オーナー）、一覧編集者（編集者）/u);
    assert.equal(rows()[1].querySelector(".pv-avatars"), null);
    assert.equal(rows()[1].textContent.includes("共通参加者（架空）"), false);
    assert.equal(document.body.textContent.includes("未取得"), false);
  } finally { await app.cleanup(); }
});

test("directory empty, loading, failed, forbidden and retry states never retain previous cards", async () => {
  let resolveLoad, mode = "loading";
  const adapter = directoryAdapter(async () => {
    if (mode === "loading") return new Promise((resolve) => { resolveLoad = resolve; });
    if (mode === "failed") throw new Error("private internal details");
    if (mode === "forbidden") return { status: "forbidden" };
    return directory();
  });
  const app = await setup(ProjectDirectory, { adapter });
  try {
    assert.ok(document.querySelector('[aria-busy="true"]')); assert.equal(cards().length, 0);
    await act(async () => resolveLoad({ status: "ready", entries: [] })); await flush();
    assert.ok(document.body.textContent.includes("参加中のプロジェクトはまだありません"));
    mode = "ready"; await click("再読込"); assert.equal(cards().length, 2);
    mode = "failed"; await click("再読込"); assert.equal(cards().length, 0); assert.ok(document.querySelector('[role="alert"]'));
    assert.equal(document.body.textContent.includes("private internal"), false);
    mode = "forbidden"; await click("再試行"); assert.ok(document.body.textContent.includes("権限がありません")); assert.equal(cards().length, 0);
    assert.equal(button("エディター"), undefined);
    mode = "ready"; await click("再試行"); assert.equal(cards().length, 2);
  } finally { await app.cleanup(); }
});

test("directory adapter replacement and unmount abort and discard ignored-abort responses", async () => {
  let finishOld, oldSignal;
  const old = directoryAdapter(async (signal) => { oldSignal = signal; return new Promise((resolve) => { finishOld = resolve; }); });
  const app = await setup(ProjectDirectory, { adapter: old });
  try {
    await app.rerender({ adapter: directoryAdapter(async () => ({ status: "ready", entries: [] })) });
    assert.equal(oldSignal.aborted, true);
    await act(async () => finishOld(directory())); await flush(); assert.equal(cards().length, 0);
    let signal;
    await app.rerender({ adapter: directoryAdapter(async (value) => { signal = value; return new Promise(() => {}); }) });
    await app.cleanup(); assert.equal(signal.aborted, true);
  } catch (error) { await app.cleanup(); throw error; }
});

test("returning to the directory restores focus after delayed loading, once per session", async () => {
  let finish;
  const app = await setup(ProjectDirectory, { adapter: directoryAdapter(async () => new Promise((resolve) => { finish = resolve; })), initialFocusProjectId: "project_two" });
  try {
    await act(async () => finish(directory())); await flush();
    assert.equal(document.activeElement.getAttribute("aria-label"), `${project("two").name}（${project("two").site.name}）の一覧行を開く`);
    document.querySelector("input").focus(); await search("one");
    assert.equal(document.activeElement, document.querySelector("input"));
    await app.rerender({ adapter: directoryAdapter(), initialFocusProjectId: "project_absent" });
    assert.equal(document.activeElement.classList.contains("pv-list-open"), false);
  } finally { await app.cleanup(); }
});

test("dashboard shows only selected Site facts, zero versus unknown, analytic dates, and real host actions", async () => {
  const selected = project(); const requests = [];
  const app = await setup(ProjectDashboard, { project: selected, adapter: dashboardAdapter(async (target) => { requests.push(target); return dashboard(); }) });
  try {
    assert.deepEqual(requests, [{ projectId: selected.id, siteId: selected.site.id }]);
    assert.equal(document.querySelector(".pv-project-identity h1")?.textContent, selected.name);
    assert.equal(document.querySelector(".pv-page-title")?.tagName, "H2");
    assert.equal(document.querySelector(".pv-panel h3")?.textContent, "公開情報");
    assert.ok(document.body.textContent.includes("公開中")); assert.ok(document.body.textContent.includes("合成ページを更新"));
    assert.deepEqual([...document.querySelectorAll(".pv-panel:first-child .pv-stats dd")].map((node) => node.textContent), ["7"]);
    assert.equal(document.querySelector(".pv-panel:first-child").textContent.includes("未取得"), false, "取得できない概要値は行ごと隠す");
    const summary = document.querySelector(".pv-analytics-summary");
    assert.deepEqual([...summary.querySelectorAll("dd")].map((node) => node.textContent), ["0"]);
    assert.ok(summary.textContent.includes("対象期間")); assert.ok(summary.textContent.includes("解析取得日時"));
    assert.equal(summary.textContent.includes("未取得"), false);
    assert.equal(document.querySelector(".pv-panel:first-child .pv-badge")?.textContent, "公開中");
    assert.ok(document.querySelector(".pv-changes thead"));
    assert.deepEqual([...document.querySelectorAll(".pv-changes tbody tr")].map((node) => node.children.length), [2]);
    assert.equal(document.querySelector('a.pv-link').href, "https://one.example.test/");
    // STUDIO と同じく上のタブで画面を切り替え、左のメニューはホームの中だけ。同じ画面を 2 か所から開かない
    assert.deepEqual([...document.querySelectorAll(".pv-project-tabs button")].map((node) => node.textContent), ["ホーム", "アナリティクス"]);
    assert.deepEqual([...document.querySelectorAll(".pv-dashboard-nav button")].map((node) => node.textContent), ["ダッシュボード", "メンバー", "プロジェクト設定"]);
    assert.equal(document.querySelector(".pv-global-nav, .pv-home-nav, .pv-nav-heading"), null);
    assert.equal(button("ホーム").getAttribute("aria-current"), "true");
    assert.equal(button("ダッシュボード").getAttribute("aria-current"), "page");
    await click("デザインエディタ"); assert.deepEqual(app.calls.editors[0], selected);
    await click("プロジェクト設定"); assert.deepEqual(app.calls.settings[0], [selected, "site"]);
    await click("アナリティクス"); assert.equal(button("アナリティクス").getAttribute("aria-current"), "page");
    assert.equal(button("ホーム").getAttribute("aria-current"), null); assert.equal(document.querySelector(".pv-dashboard-nav"), null, "アナリティクスは左のメニューを持たない");
    assert.deepEqual([...document.querySelectorAll(".pv-stats dd")].map((node) => node.textContent), ["0"]);
    assert.ok(document.body.textContent.includes("対象期間")); assert.ok(document.body.textContent.includes("解析取得日時")); assert.ok(document.querySelectorAll("time[datetime]").length >= 4);
    await click("解析接続設定"); assert.deepEqual(app.calls.settings[1], [selected, "analytics"]);
    await click("ホーム"); await click("アクセス解析を見る"); assert.equal(button("アナリティクス").getAttribute("aria-current"), "page");
    await click("ホーム"); await click("メンバー"); assert.ok(document.body.textContent.includes("メンバー（1名）")); assert.ok(document.body.textContent.includes("共通参加者（架空）"));
    await click("プロジェクト一覧へ戻る"); assert.equal(app.calls.backs, 1);
    for (const text of ["CMS", "フォーム", "課金"]) assert.equal(document.body.textContent.includes(text), false);
  } finally { await app.cleanup(); }
});

test("dashboard unpublished, empty changes, disconnected Analytics, and partial failure are actionable", async () => {
  const input = dashboard(); input.overview.data = { publicationStatus: "unpublished", publishedUrl: null, lastPublishedAt: null, publishedPageCount: 0, assetBytes: 0, recentChanges: [] }; input.analytics = { status: "disconnected" };
  const app = await setup(ProjectDashboard, { project: project(), adapter: dashboardAdapter(async () => input) });
  try {
    assert.ok(document.body.textContent.includes("未公開")); assert.ok(document.body.textContent.includes("直近の変更はありません")); assert.equal(document.querySelector("a"), null);
    assert.ok(document.querySelector(".pv-analytics-summary").textContent.includes("まだ接続されていません"));
    await click("アナリティクス"); assert.ok(document.body.textContent.includes("まだ接続されていません")); assert.equal(document.querySelector(".pv-stats"), null);
    await click("解析接続設定"); assert.equal(app.calls.settings[0][1], "analytics");
    const unknown = dashboard(); unknown.overview.data = { publicationStatus: "unknown", publishedUrl: null, lastPublishedAt: null, publishedPageCount: null, assetBytes: null, recentChanges: [] };
    await app.rerender({ adapter: dashboardAdapter(async () => unknown) });
    assert.equal(document.querySelector(".pv-panel:first-child .pv-badge"), null);
    assert.equal(document.querySelector(".pv-panel:first-child").textContent.includes("未取得"), false);
    const partial = dashboard(); partial.overview = { status: "unavailable" };
    await app.rerender({ adapter: dashboardAdapter(async () => partial) });
    assert.ok(document.body.textContent.includes("公開情報を取得できませんでした")); assert.ok(button("デザインエディタ"));
    assert.deepEqual([...document.querySelectorAll(".pv-analytics-summary dd")].map((node) => node.textContent), ["0"]);
    await click("アナリティクス"); assert.equal(document.querySelector(".pv-stats dd").textContent, "0");
    partial.analytics = { status: "unavailable" };
    await app.rerender({ adapter: dashboardAdapter(async () => partial) }); await click("アナリティクス");
    assert.ok(document.body.textContent.includes("アクセス解析を取得できませんでした")); assert.ok(button("再試行"));
    await click("ホーム"); assert.ok(document.querySelector(".pv-analytics-summary [role=alert]"));
  } finally { await app.cleanup(); }
});

test("dashboard members are read-only with roles, host fallback, empty, unavailable and long-name states", async () => {
  const selected = project(); selected.members = [];
  const app = await setup(ProjectDashboard, { project: selected, adapter: dashboardAdapter(async () => dashboard(selected)) });
  try {
    assert.ok(button("プロジェクト一覧へ戻る")); await click("プロジェクト一覧へ戻る"); assert.equal(app.calls.backs, 1);
    await click("メンバー"); assert.ok(document.body.textContent.includes("メンバー（0名）")); assert.ok(document.body.textContent.includes("メンバーはいません"));
    assert.equal(document.querySelector(".pv-member-list"), null);
    // ホストが members を返さなければ Project 正本の参加者（役割なし）
    const next = project(); next.members = [{ userId: "first", displayName: "長い参加者名".repeat(18) }, { userId: "second", displayName: "二人目" }];
    await app.rerender({ project: next, adapter: dashboardAdapter(async () => dashboard(next)) });
    await click("メンバー"); assert.equal(document.querySelectorAll(".pv-member-table tbody tr").length, 2);
    assert.ok(document.body.textContent.includes(next.members[0].displayName)); assert.ok(document.body.textContent.includes("メンバー（2名）"));
    assert.equal(document.querySelector(".pv-member-table button"), null); assert.equal(document.querySelector(".pv-role"), null);
    // ホストが返した members（役割つき）を Project.members より優先し、順序はホストのまま。追加・解除・権限変更の操作は置かない
    const withRoles = dashboard(next); withRoles.members = { status: "ready", data: [{ displayName: "オーナー（架空）", role: "owner" }, { displayName: "編集者（架空）", role: "editor" }, { displayName: "役割なし（架空）", role: null }] };
    await app.rerender({ adapter: dashboardAdapter(async () => withRoles) });
    await click("メンバー");
    assert.deepEqual([...document.querySelectorAll(".pv-member-table tbody tr")].map((node) => node.textContent), ["オーナー（架空）オーナー", "編集者（架空）編集者", "役割なし（架空）"]);
    assert.ok(document.querySelector(".pv-member-table .pv-role")); assert.ok(document.body.textContent.includes("メンバー（3名）"));
    assert.equal(document.body.textContent.includes(next.members[0].displayName), false);
    assert.equal(document.querySelector(".pv-member-table button, .pv-member-table input, .pv-member-table select"), null);
    await click("プロジェクト設定を開く"); assert.deepEqual(app.calls.settings.at(-1), [next, "site"]);
    // 設定画面の無いホストでは設定への導線も出さない
    await app.rerender({ settingsAction: "disabled" }); await click("メンバー");
    assert.equal(button("プロジェクト設定を開く"), undefined); assert.equal(document.querySelectorAll(".pv-member-table tbody tr").length, 3);
    // 取得失敗はメンバーだけ（公開情報は残る）
    const failed = dashboard(next); failed.members = { status: "unavailable" };
    await app.rerender({ settingsAction: "enabled", adapter: dashboardAdapter(async () => failed) });
    await click("メンバー"); assert.ok(document.querySelector(".pv-panel [role=alert]").textContent.includes("メンバーを取得できませんでした")); assert.ok(button("再試行"));
    assert.equal(document.querySelector(".pv-member-table"), null);
    await click("ダッシュボード"); assert.ok(document.body.textContent.includes("公開中"));
  } finally { await app.cleanup(); }
});

test("dashboard shows host site views as top tabs and project settings content in Home", async () => {
  const selected = project(), changes = [];
  const siteViews = [{ id: "cms", label: "CMS", content: createElement("p", { id: "cms-body" }, "CMS の中身"), actions: createElement("a", { id: "cms-action", href: "#legacy" }, "旧画面") }, { id: "translations", label: "翻訳", content: createElement("p", { id: "translations-body" }, "翻訳の中身") }];
  const app = await setup(ProjectDashboard, { project: selected, adapter: dashboardAdapter(async () => dashboard(selected)), siteViews, activeSiteView: null, onSiteViewChange: (id) => changes.push(id), headerEnd: createElement("span", { id: "account" }, "A"), settingsContent: createElement("p", { id: "settings-body" }, "メンバーと招待") });
  try {
    const tabs = [...document.querySelectorAll(".pv-project-tabs button")].map((node) => node.textContent);
    assert.deepEqual(tabs, ["ホーム", "CMS", "翻訳", "アナリティクス"]);
    const home = [...document.querySelectorAll(".pv-dashboard-nav button")].map((node) => node.textContent);
    assert.deepEqual(home, ["ダッシュボード", "メンバー", "プロジェクト設定"]);
    assert.equal(new Set([...tabs, ...home]).size, tabs.length + home.length, "同じ名前の入口を 2 つ出さない");
    // ホストの右端（アカウントなど）はいつも、サイト機能の操作はその機能を開いている間だけ帯に出す
    assert.ok(document.querySelector(".pv-project-end #account"));
    assert.equal(document.querySelector("#cms-action"), null);
    await click("CMS");
    assert.deepEqual(changes, ["cms"]);
    await app.rerender({ activeSiteView: "cms" });
    assert.equal(document.querySelector("#cms-body")?.textContent, "CMS の中身");
    // サイト機能を開くと画面全体がその機能になる: ホームの左のメニューを閉じ、上のタブは残す
    assert.equal(document.querySelector(".pv-dashboard-nav"), null);
    assert.equal(document.querySelector(".pv-dashboard-layout")?.getAttribute("data-section"), "site");
    assert.equal(document.querySelector(".pv-dashboard-content"), null);
    assert.equal(document.querySelector(".pv-site-view")?.getAttribute("aria-label"), "CMS");
    assert.equal(button("CMS").getAttribute("aria-current"), "page");
    assert.equal(button("ホーム").getAttribute("aria-current"), null);
    assert.ok(document.querySelector(".pv-project-end #cms-action"));
    await click("ホーム");
    assert.deepEqual(changes, ["cms", null]);
    await app.rerender({ activeSiteView: null });
    await click("プロジェクト設定");
    assert.equal(document.querySelector("#settings-body")?.textContent, "メンバーと招待");
    assert.equal(document.querySelector(".pv-page-title").textContent, "プロジェクト設定");
    assert.equal(button("プロジェクト設定").getAttribute("aria-current"), "page");
    assert.equal(app.calls.settings.length, 0);
    await app.rerender({ activeSiteView: "unknown" });
    assert.ok(document.querySelector(".pv-dashboard-content"));
    // 設定の中身を持つホストが解析の接続設定だけを持たないとき: プロジェクト設定は開け、解析接続は無効の正直なラベル
    await app.rerender({ activeSiteView: null, settingsAction: "disabled" });
    assert.equal(button("プロジェクト設定").disabled, false);
    await click("アナリティクス");
    assert.equal(button("解析接続（準備中）").disabled, true);
    assert.equal(button("解析接続設定"), undefined);
    assert.equal(app.calls.settings.length, 0);
  } finally { await app.cleanup(); }
});

test("dashboard back navigation stays available while its read is pending", async () => {
  let resolve; const selected = project();
  const app = await setup(ProjectDashboard, { project: selected, adapter: dashboardAdapter(() => new Promise((done) => { resolve = done; })) });
  try {
    assert.equal(document.querySelector(".pv-project-identity h1")?.textContent, "プロジェクトダッシュボード");
    assert.ok(button("プロジェクト一覧へ戻る"));
    await click("プロジェクト一覧へ戻る"); assert.equal(app.calls.backs, 1);
    await act(async () => resolve({ status: "forbidden", projectId: selected.id, siteId: selected.site.id })); await flush();
    assert.equal(document.querySelector(".pv-project-identity h1")?.textContent, "プロジェクトダッシュボード");
    assert.ok(button("プロジェクト一覧へ戻る")); assert.ok(document.body.textContent.includes("権限がありません"));
    assert.equal(document.querySelector(".pv-project-identity h1")?.textContent, "プロジェクトダッシュボード");
  } finally { await app.cleanup(); }
});

test("dashboard mismatch, failure and permission loss clear all sensitive facts and actions", async () => {
  let result = dashboard(), fail = false;
  const app = await setup(ProjectDashboard, { project: project(), adapter: dashboardAdapter(async () => { if (fail) throw new Error("secret"); return result; }) });
  try {
    assert.ok(button("プロジェクト一覧へ戻る"));
    for (const field of ["projectId", "siteId"]) {
      result = dashboard(); result[field] = "mismatch"; await click(button("再読込") ? "再読込" : "再試行");
      assert.ok(document.body.textContent.includes("読み込めませんでした")); assert.ok(button("プロジェクト一覧へ戻る")); assert.equal(button("デザインエディタ"), undefined); assert.equal(document.querySelector("a"), null);
    }
    result = dashboard(); await click("再試行"); assert.ok(button("デザインエディタ"));
    result = { status: "forbidden", projectId: "project_one", siteId: "site_one" }; await click("再読込");
    assert.ok(document.body.textContent.includes("権限がありません")); assert.ok(button("プロジェクト一覧へ戻る")); assert.equal(document.body.textContent.includes(project().name), false); assert.equal(document.querySelector(".pv-project-identity h1")?.textContent, "プロジェクトダッシュボード"); assert.equal(button("プロジェクト設定"), undefined); assert.equal(document.querySelector(".pv-dashboard-nav"), null);
    fail = true; await click("再試行"); assert.ok(document.body.textContent.includes("読み込めませんでした")); assert.ok(button("プロジェクト一覧へ戻る")); assert.equal(document.body.textContent.includes("secret"), false);
  } finally { await app.cleanup(); }
});

test("dashboard draws with the shared white tokens that a host can override", async () => {
  const selected = project();
  const app = await setup(ProjectDashboard, { project: selected, adapter: dashboardAdapter(async () => dashboard(selected)) });
  try {
    const css = [...document.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
    // トークンの定義は詳細度 0（:where）なので、ホストは :root や .nw-project-view で上書きできる（#159）
    assert.ok(css.includes(":where(:root){") && css.includes("--nw-bg:#fff") && css.includes("--nw-border:rgba(34,34,34,.1)"));
    assert.ok(css.includes(".nw-project-dashboard{padding:0;border-radius:0;background:var(--nw-bg)}"));
    // 帯は 1 段: 左にプロジェクト、中央にタブ、右にデザインエディタとホストの操作
    assert.ok(css.includes(".pv-project-bar{position:relative;z-index:2;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:16px;min-height:64px;padding:0 20px;background:var(--nw-bg);border-bottom:1px solid var(--nw-border)"));
    assert.ok(css.includes(".pv-project-tabs button[aria-current]{color:var(--nw-text);font-weight:650;box-shadow:inset 0 -2px 0 var(--nw-text)}"));
    assert.ok(css.includes(".pv-dashboard-layout:not([data-section=home]){grid-template-columns:minmax(0,1fr)}"));
    assert.ok(css.includes(".pv-dashboard-nav{display:flex;flex-direction:column;gap:2px;margin:0;padding:22px 14px;border-right:1px solid var(--nw-border);background:var(--nw-bg)"));
    // 現在地は一段の灰色の面、公開中は緑の点だけ
    assert.ok(css.includes(".pv-dashboard-nav button[aria-current=page]{background:var(--nw-surface-2);"));
    assert.ok(css.includes(".pv-project-identity[data-publication=published] i{background:var(--nw-live)}"));
    assert.equal(/--niho-(?!sticky-top)|--pv-/u.test(css), false, "no host-specific or private color variables are left");
    assert.ok(css.includes(".pv-changes,.nw-project-view .pv-member-table{width:100%"));
    assert.ok(css.includes(".pv-panel-heading{display:flex;align-items:center;justify-content:space-between"));
  } finally { await app.cleanup(); }
});

test("dashboard Project/Site switching, adapter replacement and unmount discard stale results", async () => {
  const pending = []; const adapter = dashboardAdapter(async (target, signal) => new Promise((resolve) => pending.push({ target, signal, resolve })));
  const selected = project(), next = project("two");
  const app = await setup(ProjectDashboard, { project: selected, adapter });
  try {
    await app.rerender({ project: next }); assert.equal(pending[0].signal.aborted, true);
    await act(async () => pending[1].resolve(dashboard(next))); await flush();
    await act(async () => pending[0].resolve(dashboard(selected))); await flush();
    assert.ok(document.body.textContent.includes(next.name)); assert.equal(document.body.textContent.includes(selected.name), false);
    await app.rerender({ adapter: dashboardAdapter(async () => ({ status: "forbidden", projectId: next.id, siteId: next.site.id })) });
    assert.equal(button("デザインエディタ"), undefined);
    await app.rerender({ adapter }); const last = pending.at(-1); await app.cleanup(); assert.equal(last.signal.aborted, true);
    await act(async () => last.resolve(dashboard(next))); await flush();
  } catch (error) { await app.cleanup(); throw error; }
});

test("long Japanese names and URLs remain complete and the stylesheet defines 320px-friendly layouts", async () => {
  const input = directory(); input.entries[0].project.name = "長い日本語のプロジェクト".repeat(8); input.entries[0].project.site.domains = [`https://${"long".repeat(15)}.example.test`]; input.entries[0].summary.publishedUrl = input.entries[0].project.site.domains[0];
  input.entries[0].summary.updatedAt = null;
  const app = await setup(ProjectDirectory, { adapter: directoryAdapter(async () => input) });
  try {
    assert.ok(document.body.textContent.includes(input.entries[0].project.name)); assert.ok(document.body.textContent.includes(input.entries[0].project.site.domains[0]));
    assert.ok(rows()[1].textContent.includes(input.entries[0].project.name));
    const css = [...document.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n"); assert.ok(css.includes("overflow-wrap:anywhere")); assert.ok(css.includes("@media(max-width:600px)")); assert.ok(css.includes(".pv-project-menu>div{position:static;width:100%")); assert.ok(css.includes(":focus-visible")); assert.ok(css.includes(".pv-dashboard-content{width:min(100%,992px)"));
    assert.equal(css.includes(".pv-grid{display:none}"), false); assert.ok(css.includes(".pv-grid{display:grid;grid-template-columns:minmax(0,1fr)")); assert.ok(css.includes(".pv-directory-list td:empty{display:none}")); assert.equal(css.includes("overflow-x:auto"), false);
    // 900px 以下はタブを帯の 2 段目、ホームのメニューを本文の上に置いて折り返す。600px 以下は操作も 1 段下げる。横スクロールで欠けさせない
    const dashboardMobile = css.slice(css.indexOf(".nw-project-dashboard{"));
    assert.ok(dashboardMobile.includes("@media(max-width:900px){.nw-project-dashboard .pv-project-bar{grid-template-columns:minmax(0,1fr) auto;gap:0 10px;padding:0 14px}"));
    assert.ok(dashboardMobile.includes(".nw-project-dashboard .pv-project-tabs{grid-column:1/-1;grid-row:2;flex-wrap:wrap"));
    assert.ok(dashboardMobile.includes("@media(max-width:600px){") && dashboardMobile.includes(".nw-project-dashboard .pv-dashboard-nav{flex-direction:row;flex-wrap:wrap") && dashboardMobile.includes(".nw-project-dashboard .pv-project-end{grid-column:1/-1;grid-row:2") && dashboardMobile.includes(".nw-project-dashboard .pv-project-tabs{grid-row:3"));
    assert.equal(dashboardMobile.includes("overflow-x:auto"), false);
  } finally { await app.cleanup(); }
});
