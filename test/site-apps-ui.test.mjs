import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

// SiteApps の capabilities: ホストが提供しない操作（計測タグの公開・削除、所有権確認）は状態と値だけを見せる。値はすべて架空。
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://host.example.test" });
for (const key of ["window", "document", "HTMLElement", "HTMLInputElement", "Element", "Event", "MouseEvent", "SubmitEvent"]) globalThis[key] = dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createElement, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SiteApps } = await import("@niho/web/site-apps");
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const target = { projectId: "project_one", siteId: "site_one", siteOrigin: "https://www.one.example.test" };
const connection = {
  target,
  ga4: { measurementId: "G-FIXTURE01", trackingTagState: "published", propertyId: "1234567", reportingState: "connected", propertyTimeZone: "Asia/Tokyo", lastSyncedAt: null },
  searchConsole: { property: { kind: "url-prefix", value: "https://www.one.example.test/" }, ownershipState: "not-verified", verificationMethod: null, reportingState: "connected", lastSyncedAt: null }
};
function adapter(calls) {
  const record = (name) => async (...args) => { calls.push([name, args[0]]); return name === "readConnection" ? connection : null; };
  return new Proxy({}, { get: (_target, name) => record(String(name)) });
}
async function render(props) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(SiteApps, props))); await flush();
  return { container, cleanup: async () => { await act(async () => root.unmount()); container.remove(); } };
}
const buttons = (container) => [...container.querySelectorAll("button")].map((node) => node.textContent);

test("site apps hide tag publishing and ownership verification controls when the host does not provide them", async () => {
  const calls = [];
  const view = await render({ target, adapter: adapter(calls), capabilities: { trackingTag: false, ownershipVerification: false } });
  try {
    const text = view.container.textContent;
    // 状態と値は見せる
    assert.ok(text.includes("測定ID: G-FIXTURE01")); assert.ok(text.includes("公開済み"));
    // 所有権確認を扱わないホストでは、所有権の欄（未確認の表示を含む）を出さない
    assert.equal(text.includes("サイト所有権"), false); assert.equal(text.includes("未確認"), false);
    assert.ok(text.includes("プロパティID: 1234567"));
    // 計測タグの公開・削除と所有権確認のフォーム・ボタン・説明は出さない
    assert.equal(view.container.querySelector('input[placeholder="G-XXXXXXXXXX"]'), null);
    for (const label of ["タグの変更を確認", "タグを削除", "所有権を確認", "所有権確認の準備"]) assert.equal(buttons(view.container).includes(label), false, label);
    for (const label of ["計測タグの設定", "公開サイトへ計測タグを設定します", "確認コードまたはDNS", "所有権の確認方法", "プロパティの種類"]) assert.equal(text.includes(label), false, label);
    // レポートの接続・確認・解除は残す。Search Console のレポート接続はフォームの送信で準備する
    for (const label of ["接続内容を確認", "レポートを解除", "接続を確認", "同期を再試行", "レポート接続の準備"]) assert.ok(buttons(view.container).includes(label), label);
    const prepare = [...view.container.querySelectorAll("button")].find((node) => node.textContent === "レポート接続の準備");
    assert.equal(prepare.type, "submit"); assert.equal(prepare.disabled, false);
    await act(async () => prepare.form.requestSubmit()); await flush();
    assert.deepEqual(calls.at(-1), ["prepareSearchConsoleReportingConnection", { target, property: { kind: "url-prefix", value: "https://www.one.example.test/" } }]);
    assert.equal(calls.some(([name]) => name === "prepareSearchConsoleVerification"), false);
  } finally { await view.cleanup(); }
});

test("site apps keep every control by default", async () => {
  const view = await render({ target, adapter: adapter([]) });
  try {
    for (const label of ["タグの変更を確認", "タグを削除", "所有権を確認", "所有権確認の準備", "レポート接続の準備"]) assert.ok(buttons(view.container).includes(label), label);
    assert.ok(view.container.querySelector('input[placeholder="G-XXXXXXXXXX"]'));
    assert.equal([...view.container.querySelectorAll("button")].find((node) => node.textContent === "レポート接続の準備").type, "button");
  } finally { await view.cleanup(); }
});
