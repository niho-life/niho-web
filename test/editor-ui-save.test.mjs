import { useTestClock } from "./ui-test-clock.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageScope, parsePageDocument } from "@niho/web/core";
import { createMemoryPageOperationHost } from "../examples/memory-page-operation-host.mjs";
import { createPageEditingApi } from "@niho/web/editing-api";
import { createPageEditingApiClient } from "@niho/web/editing-client";
import { editDocumentById } from "@niho/web/editor-model";
import {
  act, button, buttonIn, change, click, clickLayer, clickPage, dialog,
  dom, editorTab, fixture, flush, historyButton, historyHost, input, inputIn,
  pageRow, press, setup, tool, versionRows
} from "./editor-ui-fixture.mjs";

test("performance measurements finish after the canvas is ready and a draft is acknowledged", async () => {
  const events = [];
  const saved = Promise.withResolvers();
  const app = await setup({
    props: { measurePerformance: (operation) => {
      events.push(["begin", operation]);
      return () => events.push(["finish", operation]);
    } },
    save: () => saved.promise
  });
  try {
    assert.deepEqual(events, [["begin", "initial-load"], ["finish", "initial-load"]]);
    await clickPage("別ページ");
    assert.deepEqual(events.slice(2), [["begin", "page-switch"], ["finish", "page-switch"]]);
    const editRenderPhases = () => events.filter(([, operation]) => operation === "edit-render").map(([phase]) => phase);
    const assertEditRenderFinished = () => {
      const phases = editRenderPhases();
      assert.ok(phases.length >= 2);
      assert.equal(phases.length % 2, 0);
      for (let index = 0; index < phases.length; index += 2) assert.deepEqual(phases.slice(index, index + 2), ["begin", "finish"]);
    };
    await change(input("ページタイトル"), "保存の計測");
    assertEditRenderFinished();
    await click("下書き保存");
    const saveEvents = () => events.filter(([, operation]) => operation === "save");
    assert.deepEqual(saveEvents(), [["begin", "save"]]);
    await act(async () => saved.resolve({ status: "saved", version: "v2", revision: fixture.revision + 1 }));
    assert.deepEqual(saveEvents(), [["begin", "save"], ["finish", "save"]]);
    assertEditRenderFinished();
  } finally { await app.cleanup(); }
});

test("invalid URL buffers stay visible, block saving, and can be cancelled", async () => {
  const app = await setup();
  try {
    await clickLayer("link"); await editorTab("設定"); await change(input("リンク先 URL"), "javascript:alert(1)");
    assert.equal(input("リンク先 URL").value, "javascript:alert(1)");
    assert.ok(document.body.textContent.includes("文書のルールに合いません"));
    assert.equal(button("下書き保存").disabled, true);
    assert.equal(document.querySelector("iframe").contentDocument.querySelector("a").getAttribute("href"), "/about");
    await click("入力を取り消す"); assert.equal(input("リンク先 URL").value, "/about");
    assert.equal(app.calls.saves.length, 0);
  } finally { await app.cleanup(); }
});

test("409 and network failures retain edits, history and expectedVersion for retry", async () => {
  let mode = "conflict";
  const app = await setup({ save: async () => { if (mode === "throw") throw new Error("offline"); if (mode === "throw409") throw { status: 409 }; return mode === "conflict" ? { status: "conflict" } : { status: "saved", version: "v2", revision: 2 }; } });
  try {
    await clickLayer("heading"); await change(input("テキスト"), "失わない編集");
    await click("下書き保存"); assert.ok(document.body.textContent.includes("409")); assert.equal(input("テキスト").value, "失わない編集");
    mode = "throw"; await click("下書き保存"); assert.ok(document.body.textContent.includes("編集内容を保持しています"));
    mode = "throw409"; await click("下書き保存"); assert.ok(document.body.textContent.includes("409"));
    mode = "saved"; await click("下書き保存"); assert.equal(app.calls.saves.length, 4); assert.ok(app.calls.saves.every((request) => request.expectedVersion === "v1"));
    await click("元に戻す"); assert.equal(button("下書き保存").disabled, false);
    await click("やり直す"); assert.equal(button("下書き保存").disabled, true);
  } finally { await app.cleanup(); }
});

test("in-flight save checkpoints the captured document without losing later edits", async () => {
  let finish; let saves = 0;
  const app = await setup({ save: () => ++saves === 1 ? new Promise((resolve) => { finish = resolve; }) : Promise.resolve({ status: "saved", version: "v3", revision: 3 }) });
  try {
    await clickLayer("heading"); await change(input("テキスト"), "保存開始時"); await click("下書き保存");
    await change(input("テキスト"), "保存中に続けた編集");
    await act(async () => finish({ status: "saved", version: "v2", revision: 2 })); await flush();
    assert.equal(input("テキスト").value, "保存中に続けた編集"); assert.equal(button("下書き保存").disabled, false);
    await click("元に戻す"); assert.equal(button("下書き保存").disabled, true);
    await click("やり直す"); assert.equal(button("下書き保存").disabled, false);
    await click("下書き保存"); assert.equal(app.calls.saves[1].expectedVersion, "v2"); assert.equal(app.calls.saves[1].document.revision, 2); assert.equal(app.calls.saves[1].document.body[0].children[0].children[0].text, "保存中に続けた編集");
    assert.equal(button("下書き保存").disabled, true);
    await click("元に戻す"); assert.equal(button("下書き保存").disabled, false);
    await click("やり直す"); assert.equal(button("下書き保存").disabled, true);
    assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-scope]').getAttribute("data-nw-scope"), pageScope({ ...fixture, revision: 3 }));
  } finally { await app.cleanup(); }
});

test("publishing and rollback require the allowed domain, authoritative diff and explicit confirmation", async () => {
  const app = await setup();
  try {
    await click("公開"); assert.ok(document.querySelector('[role="dialog"]'));
    assert.ok(document.body.textContent.includes("https://example.test")); assert.ok(document.body.textContent.includes("現在の見出し"));
    assert.equal(button("この内容を公開").disabled, true); assert.equal(app.calls.releases.length, 0);
    await act(async () => document.querySelector('[role="dialog"] input[type="checkbox"]').click());
    await click("この内容を公開"); assert.equal(app.calls.releases[0].confirmationToken, "reviewed-token");
    assert.equal(app.calls.releases[0].expectedVersion, "v1");
  } finally { await app.cleanup(); }
  const invalid = await setup({ domain: "https://other.example" });
  try { await click("公開"); assert.equal(document.querySelector('[role="dialog"]'), null); assert.equal(invalid.calls.releases.length, 0); } finally { await invalid.cleanup(); }
});

test("dirty navigation requires explicit discard and can keep editing", async () => {
  const app = await setup();
  try {
    await change(input("ページタイトル"), "変更したタイトル");
    await clickPage("別ページ");
    assert.ok(document.querySelector('[role="dialog"]')); await click("編集を続ける"); assert.equal(input("ページタイトル").value, "変更したタイトル");
    await clickPage("別ページ"); await click("変更を破棄して移動");
    assert.equal(pageRow("別ページ").getAttribute("aria-current"), "page"); assert.equal(app.calls.reads.at(-1).pageId, "other"); assert.equal(button("下書き保存").disabled, true);
  } finally { await app.cleanup(); }
});

test("rollback uses its own confirmation bound to the selected published revision", async () => {
  const app = await setup();
  try {
    await change(document.querySelector('[aria-label="戻す版"]'), "1"); await click("戻す内容を確認");
    assert.equal(app.calls.prepares[0].action, "rollback"); assert.equal(app.calls.prepares[0].revision, 1);
    assert.equal(button("この版に戻す").disabled, true);
    assert.ok(!document.querySelector('[role="dialog"]').textContent.includes("検索結果に出る情報"));
    await act(async () => document.querySelector('[role="dialog"] input[type="checkbox"]').click()); await click("この版に戻す");
    assert.equal(app.calls.releases[0].action, "rollback"); assert.equal(app.calls.releases[0].revision, 1);
  } finally { await app.cleanup(); }
});

test("discarding a pending invalid buffer resets fields even when the loaded value is unchanged", async () => {
  const app = await setup();
  try {
    await change(input("ページタイトル"), ""); assert.equal(input("ページタイトル").value, "");
    await clickPage("別ページ"); await click("変更を破棄して移動");
    assert.equal(input("ページタイトル").value, fixture.title); assert.equal(button("公開").disabled, false);
  } finally { await app.cleanup(); }
});

test("invalid saved revision responses retain edits and do not advance the optimistic lock", async () => {
  let invalidRevision = 1;
  const app = await setup({ save: async () => ({ status: "saved", version: "v2", revision: invalidRevision }) });
  try {
    await change(input("ページタイトル"), "保持する編集"); await click("下書き保存");
    assert.equal(input("ページタイトル").value, "保持する編集"); assert.equal(button("下書き保存").disabled, false);
    invalidRevision = 2; await click("下書き保存");
    assert.ok(app.calls.saves.every((request) => request.expectedVersion === "v1" && request.document.revision === 1));
    assert.equal(button("下書き保存").disabled, true);
  } finally { await app.cleanup(); }
});

// 保存状態・自動保存・端末内の復元・競合の比較・版履歴（docs/save-history-contract.md）
const { createBrowserRecoveryStore, RecoveryTooLargeError } = await import("@niho/web/history");


const status = () => document.querySelector('[role="status"]').textContent;

const toolbarButton = (text) => [...document.querySelectorAll(".e-inspector-actions button,.e-preview-exit")].find((node) => node.textContent === text || node.getAttribute("aria-label") === text);

const homeTarget = { siteId: "demo", pageId: "home", locale: "ja-JP" };

const localTime = (value) => { const date = new Date(value), pad = (number) => String(number).padStart(2, "0"); return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`; };

function memoryStorage() {
  const data = new Map();
  return { get length() { return data.size; }, key: (index) => [...data.keys()][index] ?? null, getItem: (key) => data.has(key) ? data.get(key) : null, setItem: (key, value) => { data.set(key, String(value)); }, removeItem: (key) => { data.delete(key); } };
}

const recoveryKey = "niho-web:recovery:v1:staff:demo/home/ja-JP";

test("a host without the new methods and props keeps manual saving and shows no history, autosave or recovery controls", async (t) => {
  const advance = useTestClock(t, act);
  const app = await setup();
  try {
    assert.equal(toolbarButton("履歴"), undefined); assert.equal(document.querySelector('[role="switch"]'), null);
    assert.equal(document.querySelector(".e-recovery"), null); assert.equal(document.querySelector(".e-versions"), null);
    assert.equal(status(), "保存済み");
    await change(input("ページタイトル"), "手動の編集"); assert.equal(status(), "未保存の変更あり");
    await advance(150); assert.equal(app.calls.saves.length, 0);
    await click("下書き保存"); assert.match(status(), /^保存済み（\d{2}:\d{2}）$/);
    await click("公開"); assert.ok(!dialog().textContent.includes("影響するコンポーネント"));
  } finally { await app.cleanup(); }
});

test("save problems show conflict, login and failure states with retry or compare while keeping the edit", async () => {
  let mode = "auth";
  const app = await setup({ save: async () => {
    if (mode === "auth") throw { status: 401 }; if (mode === "forbidden") throw { status: 403 }; if (mode === "fail") throw new Error("server");
    return mode === "conflict" ? { status: "conflict" } : { status: "saved", version: "v2", revision: 2 };
  } });
  try {
    await change(input("ページタイトル"), "残す編集"); await click("下書き保存");
    assert.equal(status(), "ログインを確認してください"); assert.ok(toolbarButton("再試行")); assert.equal(toolbarButton("比較する"), undefined);
    assert.ok(document.querySelector(".e-notice").textContent.includes("再度ログイン"));
    mode = "forbidden"; await press(toolbarButton("再試行")); assert.equal(status(), "ログインを確認してください");
    mode = "fail"; await press(toolbarButton("再試行")); assert.equal(status(), "保存できませんでした");
    mode = "conflict"; await press(toolbarButton("再試行"));
    assert.equal(status(), "競合しています"); assert.ok(toolbarButton("比較する")); assert.equal(toolbarButton("再試行"), undefined);
    assert.ok(dialog(), "a manual conflict opens the comparison"); await press(buttonIn(dialog(), "閉じて編集を続ける")); assert.equal(dialog(), null);
    await press(toolbarButton("比較する")); assert.ok(dialog()); await press(buttonIn(dialog(), "閉じて編集を続ける"));
    mode = "saved"; await click("下書き保存");
    assert.match(status(), /^保存済み（\d{2}:\d{2}）$/); assert.equal(toolbarButton("再試行"), undefined); assert.equal(toolbarButton("比較する"), undefined);
    assert.equal(input("ページタイトル").value, "残す編集"); assert.ok(app.calls.saves.every((request) => request.expectedVersion === "v1"));
  } finally { await app.cleanup(); }
});

test("autosave saves the scheduled target after the delay, waits for valid input, can be switched off and pauses after a conflict", async (t) => {
  const advance = useTestClock(t, act);
  let version = 1, conflict = false;
  const app = await setup({ props: { autosave: { delayMs: 100 } }, save: async (request) => conflict ? { status: "conflict" } : { status: "saved", version: `v${++version}`, revision: request.document.revision + 1 } });
  try {
    const toggle = document.querySelector('[role="switch"]');
    assert.equal(toggle.textContent, "自動保存"); assert.equal(toggle.getAttribute("aria-checked"), "true");
    await change(input("ページタイトル"), "自動で保存"); assert.equal(status(), "自動保存を待っています"); assert.equal(app.calls.saves.length, 0);
    await advance(300);
    assert.equal(app.calls.saves.length, 1); assert.deepEqual(app.calls.saves[0].target, homeTarget); assert.equal(app.calls.saves[0].expectedVersion, "v1"); assert.equal(app.calls.saves[0].trigger, "autosave");
    assert.equal(app.calls.saves[0].document.title, "自動で保存"); assert.match(status(), /^保存済み（\d{2}:\d{2}）$/);
    await press(toggle); assert.equal(toggle.getAttribute("aria-checked"), "false");
    await clickLayer("link"); await editorTab("設定"); await change(input("リンク先 URL"), "/news"); await change(input("リンク先 URL"), "javascript:alert(1)");
    assert.equal(status(), "入力を確認中");
    await press(toggle); await advance(300); assert.equal(app.calls.saves.length, 1, "no autosave while an invalid input is pending");
    await click("入力を取り消す"); await advance(300);
    assert.equal(app.calls.saves.length, 2); assert.equal(app.calls.saves[1].expectedVersion, "v2"); assert.equal(app.calls.saves[1].document.body[0].children[2].attrs.href, "/news");
    conflict = true; await click("ページ全体"); await change(input("ページタイトル"), "競合する編集"); await advance(300);
    assert.equal(app.calls.saves.length, 3); assert.equal(status(), "競合しています"); assert.ok(toolbarButton("比較する")); assert.equal(dialog(), null);
    await change(input("ページタイトル"), "さらに編集"); await advance(300); assert.equal(app.calls.saves.length, 3, "autosave pauses after a conflict");
  } finally { await app.cleanup(); }
});

test("an offline autosave failure retries once when the connection returns", async (t) => {
  const advance = useTestClock(t, act);
  let online = true, drop = true, fail = true, version = 1;
  Object.defineProperty(dom.window.navigator, "onLine", { configurable: true, get: () => online });
  const app = await setup({ props: { autosave: { delayMs: 100 } }, save: async (request) => {
    if (drop) { drop = false; online = false; throw new Error("network"); }
    if (fail) throw new Error("server");
    return { status: "saved", version: `v${++version}`, revision: request.document.revision + 1 };
  } });
  try {
    await change(input("ページタイトル"), "オフラインの編集"); await advance(300);
    assert.equal(app.calls.saves.length, 1); assert.equal(status(), "オフラインです"); assert.ok(toolbarButton("再試行"));
    await advance(300); assert.equal(app.calls.saves.length, 1);
    online = true; await act(async () => dom.window.dispatchEvent(new dom.window.Event("online"))); await flush();
    assert.equal(app.calls.saves.length, 2); assert.equal(status(), "保存できませんでした");
    await advance(300); await act(async () => dom.window.dispatchEvent(new dom.window.Event("online"))); await flush();
    assert.equal(app.calls.saves.length, 2, "only one retry per offline failure");
    fail = false; await press(toolbarButton("再試行")); assert.equal(app.calls.saves.length, 3); assert.match(status(), /^保存済み/);
  } finally { delete dom.window.navigator.onLine; await app.cleanup(); }
});

test("the unsaved-changes dialog can save and then move, and stays on the page when that save fails", async () => {
  let fail = true;
  const app = await setup({ save: async () => { if (fail) throw new Error("server"); return { status: "saved", version: "v2", revision: 2 }; } });
  try {
    await change(input("ページタイトル"), "移動前の編集"); await clickPage("別ページ");
    await click("保存して移動");
    assert.equal(dialog(), null); assert.equal(status(), "保存できませんでした"); assert.equal(pageRow("ホーム").getAttribute("aria-current"), "page"); assert.equal(input("ページタイトル").value, "移動前の編集");
    fail = false; await clickPage("別ページ"); await click("保存して移動");
    assert.equal(app.calls.saves.length, 2); assert.equal(app.calls.saves[1].document.title, "移動前の編集");
    assert.equal(pageRow("別ページ").getAttribute("aria-current"), "page"); assert.equal(app.calls.reads.at(-1).pageId, "other"); assert.equal(status(), "保存済み");
    await change(input("ページタイトル"), "別の編集"); await change(input("ページタイトル"), "");
    await clickPage("ホーム"); assert.ok(dialog()); assert.equal(buttonIn(dialog(), "保存して移動"), undefined, "pending input cannot be saved");
  } finally { await app.cleanup(); }
});

test("the conflict comparison shows the diff, overwrites with the latest version only after confirmation, or discards to the latest", async () => {
  const latest = { ...structuredClone(fixture), title: "他の人のタイトル", revision: 5 };
  function host(saveResults, readFails = 0) {
    let reads = 0, failures = readFails;
    return { save: async () => saveResults.shift(), adapter: { readDocument: async (target) => {
      if (++reads === 1) return { document: { ...structuredClone(fixture), pageId: target.pageId }, version: "v1" };
      if (failures-- > 0) throw new Error("offline");
      return { document: { ...structuredClone(latest), pageId: target.pageId }, version: "v9" };
    } } };
  }
  const app = await setup(host([{ status: "conflict" }, { status: "saved", version: "v10", revision: 6 }], 1));
  try {
    await change(input("ページタイトル"), "私の編集"); await click("下書き保存");
    assert.ok(dialog().textContent.includes("最新の内容を取得できませんでした。編集内容は保持しています。"));
    await press(buttonIn(dialog(), "再試行"));
    const text = dialog().textContent;
    for (const expected of ["変更箇所", "最新の保存内容", "あなたの編集", "ページタイトル", "他の人のタイトル", "私の編集"]) assert.ok(text.includes(expected), expected);
    const overwrite = buttonIn(dialog(), "あなたの編集で上書き保存"); assert.equal(overwrite.disabled, true);
    await act(async () => dialog().querySelector('input[type="checkbox"]').click()); assert.equal(overwrite.disabled, false);
    await press(overwrite);
    assert.equal(app.calls.saves.length, 2); assert.equal(app.calls.saves[1].expectedVersion, "v9"); assert.equal(app.calls.saves[1].document.revision, 5); assert.equal(app.calls.saves[1].document.title, "私の編集");
    assert.equal(dialog(), null); assert.match(status(), /^保存済み/); assert.equal(button("下書き保存").disabled, true);
  } finally { await app.cleanup(); }
  const discard = await setup(host([{ status: "conflict" }]));
  try {
    await change(input("ページタイトル"), "捨てる編集"); await click("下書き保存");
    await press(buttonIn(dialog(), "最新の内容を読み込む（あなたの編集を破棄）"));
    assert.equal(dialog(), null); assert.equal(input("ページタイトル").value, "他の人のタイトル"); assert.equal(status(), "保存済み"); assert.equal(button("下書き保存").disabled, true);
    await change(input("ページタイトル"), "最新から編集"); await click("下書き保存"); assert.equal(discard.calls.saves.at(-1).expectedVersion, "v9");
  } finally { await discard.cleanup(); }
});

test("recovery offers unsaved work after a load, restores it as an undoable edit and is cleared after saving", async (t) => {
  const advance = useTestClock(t, act);
  const storage = memoryStorage(), store = createBrowserRecoveryStore({ scope: "staff", storage });
  const updatedAt = new Date(Date.now() - 60_000).toISOString();
  store.write({ target: homeTarget, baseVersion: "v1", baseRevision: 1, document: { ...structuredClone(fixture), title: "端末の編集" }, updatedAt });
  const app = await setup({ props: { recovery: store } });
  try {
    await flush();
    const banner = document.querySelector(".e-recovery");
    assert.equal(banner.getAttribute("role"), "status");
    assert.ok(banner.textContent.includes(`保存されていない変更があります（${localTime(updatedAt)}）`)); assert.ok(!banner.textContent.includes("その後"));
    await press(buttonIn(banner, "比較する")); assert.ok(dialog().textContent.includes("端末に残っていた内容")); assert.ok(dialog().textContent.includes("保存済みの内容"));
    await press(buttonIn(dialog(), "閉じる"));
    await press(buttonIn(document.querySelector(".e-recovery"), "復元する"));
    assert.equal(document.querySelector(".e-recovery"), null); assert.equal(input("ページタイトル").value, "端末の編集"); assert.equal(status(), "未保存の変更あり");
    assert.ok(document.querySelector(".e-notice").textContent.includes("端末に残っていた変更を復元しました。保存すると新しい版として記録されます。"));
    await click("元に戻す"); assert.equal(input("ページタイトル").value, fixture.title); await click("やり直す");
    await advance(900);
    const stored = JSON.parse(storage.getItem(recoveryKey));
    assert.equal(stored.document.title, "端末の編集"); assert.equal(stored.baseVersion, "v1"); assert.deepEqual(Object.keys(stored), ["v", "target", "baseVersion", "baseRevision", "document", "updatedAt"]);
    await click("下書き保存"); await flush(); assert.equal(storage.getItem(recoveryKey), null);
  } finally { await app.cleanup(); }
});

test("stale recovery compares before restoring, discard removes it, identical entries are dropped and discarded navigation clears it", async (t) => {
  const advance = useTestClock(t, act);
  const storage = memoryStorage(), store = createBrowserRecoveryStore({ scope: "staff", storage });
  const write = (document, baseVersion = "v1") => store.write({ target: homeTarget, baseVersion, baseRevision: 1, document, updatedAt: new Date().toISOString() });
  write({ ...structuredClone(fixture), title: "古い基準の編集" }, "v0");
  let app = await setup({ props: { recovery: store } });
  try {
    await flush(); const banner = document.querySelector(".e-recovery");
    assert.ok(banner.textContent.includes("その後、別の保存がありました。"));
    await press(buttonIn(banner, "復元する")); assert.ok(dialog(), "a stale entry is compared first"); assert.equal(input("ページタイトル").value, fixture.title);
    assert.ok(dialog().textContent.includes("古い基準の編集"));
    await press(buttonIn(dialog(), "復元した内容で編集を続ける")); assert.equal(dialog(), null); assert.equal(input("ページタイトル").value, "古い基準の編集");
  } finally { await app.cleanup(); }
  write({ ...structuredClone(fixture), title: "捨てる退避" });
  app = await setup({ props: { recovery: store } });
  try {
    await flush(); await press(buttonIn(document.querySelector(".e-recovery"), "破棄")); await flush();
    assert.equal(document.querySelector(".e-recovery"), null); assert.equal(storage.getItem(recoveryKey), null); assert.equal(input("ページタイトル").value, fixture.title);
  } finally { await app.cleanup(); }
  write({ ...structuredClone(fixture), revision: 9 });
  app = await setup({ props: { recovery: store } });
  try {
    await flush(); assert.equal(document.querySelector(".e-recovery"), null); assert.equal(storage.getItem(recoveryKey), null);
    await change(input("ページタイトル"), "退避される編集"); await advance(900);
    assert.equal(JSON.parse(storage.getItem(recoveryKey)).document.title, "退避される編集");
    await clickPage("別ページ"); await click("変更を破棄して移動"); await flush();
    assert.equal(storage.getItem(recoveryKey), null);
  } finally { await app.cleanup(); }
  const failing = { read: () => null, write: () => { throw new RecoveryTooLargeError(); }, remove: () => {} };
  app = await setup({ props: { recovery: failing } });
  try {
    await change(input("ページタイトル"), "大きな編集"); await advance(900);
    assert.ok(document.querySelector(".e-notice").textContent.includes("変更が大きすぎるため端末へ退避していません。保存して作業を残してください。"));
  } finally { await app.cleanup(); }
});

test("the version panel lists revisions, loads more, shows a revision read-only, compares it and restores it as an edit", async () => {
  const host = historyHost(), app = await setup({ adapter: host.adapter });
  try {
    const rollbackPanel = document.querySelector(".e-left .e-history");
    assert.equal(rollbackPanel.hidden, true, "版の復元操作は履歴パネルに集約する");
    await press(historyButton()); assert.equal(historyButton().getAttribute("aria-pressed"), "true");
    assert.equal(rollbackPanel.hidden, false);
    assert.ok(document.querySelector('.e-left [aria-label="バージョン管理"]')); assert.ok(document.querySelector(".e-inspector-context"));
    assert.deepEqual(host.calls.lists[0], { target: homeTarget });
    assert.deepEqual(versionRows().map((row) => row.querySelector(".e-version-time").textContent), ["現在の編集内容", localTime(host.entries[0].createdAt), localTime(host.entries[1].createdAt)]);
    assert.ok(versionRows()[1].textContent.includes("自動保存") && versionRows()[1].textContent.includes("AI · 編集AI") && versionRows()[1].textContent.includes("委任元: 編集者A"));
    assert.ok(versionRows()[1].textContent.includes("section#hero · 見た目: color"), "履歴は変更値を含めず、操作対象と種別を表示する");
    assert.ok(versionRows()[2].textContent.includes("スナップショット") && versionRows()[2].textContent.includes("公開前の確認"));
    await click("さらに表示"); assert.deepEqual(host.calls.lists[1], { target: homeTarget, cursor: "2" });
    assert.equal(versionRows().length, 4); assert.ok(versionRows()[3].textContent.includes("公開")); assert.equal(versionRows()[3].disabled, false); assert.equal(button("さらに表示"), undefined);
    await press(versionRows()[1]);
    assert.deepEqual(host.calls.reads[0], { target: homeTarget, id: "rev_3" });
    const bar = document.querySelector(".e-history-bar");
    assert.ok(bar.textContent.includes(`${localTime(host.entries[0].createdAt)} · 自動保存`));
    for (const name of ["下書き保存", "公開", "プレビュー", "元に戻す"]) assert.equal(toolbarButton(name).disabled, true, name);
    assert.equal(buttonIn(bar, "公開版をこの版に戻す…"), undefined);
    await press(buttonIn(bar, "差分を見る"));
    for (const expected of ["現在の編集内容", "この版", "ページタイトル", "以前のタイトル", fixture.title]) assert.ok(dialog().textContent.includes(expected), expected);
    await press(buttonIn(dialog(), "閉じる"));
    await press(buttonIn(document.querySelector(".e-history-bar"), "この版を復元"));
    assert.equal(document.querySelector(".e-history-bar"), null); assert.equal(status(), "未保存の変更あり"); assert.equal(toolbarButton("下書き保存").disabled, false);
    assert.ok(document.querySelector(".e-notice").textContent.includes(`${localTime(host.entries[0].createdAt)} の版を作業コピーに復元しました。`));
    await press(historyButton()); assert.equal(input("ページタイトル").value, "以前のタイトル");
    await click("元に戻す"); assert.equal(input("ページタイトル").value, fixture.title);
  } finally { await app.cleanup(); }
});

test("expired history snapshots keep their summaries visible and cannot be opened", async () => {
  const host = historyHost({ expiredSnapshot: true }), app = await setup({ adapter: host.adapter });
  try {
    await press(historyButton()); await click("さらに表示");
    const expired = versionRows()[3];
    assert.ok(expired.textContent.includes("公開"));
    assert.ok(expired.textContent.includes("保存期間を過ぎています"));
    assert.equal(expired.disabled, true);
    assert.equal(host.calls.reads.length, 0);
  } finally { await app.cleanup(); }
});

test("published rollback stays on the page panel when version history is not connected", async () => {
  const app = await setup();
  try {
    const rollbackPanel = document.querySelector(".e-left .e-history");
    assert.equal(rollbackPanel.hidden, false);
    await tool("スタイル");
    assert.equal(rollbackPanel.hidden, true);
  } finally { await app.cleanup(); }
});

test("published revisions can start the rollback confirmation, snapshots require a saved state, and page switches close the panel", async () => {
  let snapshotResult;
  const host = historyHost({ snapshot: () => snapshotResult }), app = await setup({ adapter: host.adapter });
  try {
    await press(historyButton()); await click("さらに表示");
    await press(versionRows()[3]);
    assert.ok(document.querySelector(".e-versions").textContent.includes("版の表示を閉じてから作成できます。"));
    await press(buttonIn(document.querySelector(".e-history-bar"), "公開版をこの版に戻す…"));
    assert.equal(app.calls.prepares[0].action, "rollback"); assert.equal(app.calls.prepares[0].revision, 1); assert.ok(dialog().textContent.includes("版 1 に戻す前の確認"));
    await press(buttonIn(dialog(), "編集に戻る")); assert.equal(document.querySelector(".e-history-bar"), null);
    const plus = document.querySelector('[aria-label="スナップショットを作成"]'); assert.equal(plus.disabled, false);
    await press(plus); const name = inputIn(dialog(), "スナップショット名"); assert.match(name.value, /^スナップショット \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
    await change(name, "a\u0007b"); await press(buttonIn(dialog(), "作成する")); assert.ok(dialog().textContent.includes("120文字以内")); assert.equal(host.calls.snapshots.length, 0);
    snapshotResult = { status: "conflict" }; await change(inputIn(dialog(), "スナップショット名"), "公開前"); await press(buttonIn(dialog(), "作成する"));
    assert.ok(dialog().textContent.includes("保存先が更新されています（409）。最新の状態を確認してから作成してください。"));
    snapshotResult = undefined; await press(buttonIn(dialog(), "作成する"));
    assert.deepEqual(host.calls.snapshots.at(-1), { target: homeTarget, expectedVersion: "v1", label: "公開前" });
    assert.equal(dialog(), null); assert.ok(versionRows()[1].textContent.includes("公開前")); assert.ok(document.querySelector(".e-notice").textContent.includes("スナップショットを作成しました。"));
    await press(versionRows()[2]); await press(buttonIn(document.querySelector(".e-history-bar"), "この版を復元"));
    assert.equal(document.querySelector('[aria-label="スナップショットを作成"]').disabled, true, "snapshots need a saved state");
    assert.ok(document.querySelector(".e-versions").textContent.includes("スナップショットは保存済みの状態にだけ作成できます。"));
    await press(versionRows()[4]); assert.equal(buttonIn(document.querySelector(".e-history-bar"), "公開版をこの版に戻す…").disabled, true);
    assert.ok(document.querySelector(".e-versions").textContent.includes("スナップショットは保存済みの状態にだけ作成できます。"));
    await press(buttonIn(document.querySelector(".e-history-bar"), "閉じる"));
    await click("下書き保存"); assert.equal(document.querySelector('[aria-label="スナップショットを作成"]').disabled, false);
    await click("ページ"); assert.equal(historyButton().getAttribute("aria-pressed"), "false");
    await clickPage("別ページ"); assert.equal(document.querySelector(".e-versions"), null);
  } finally { await app.cleanup(); }
});

test("release confirmation shows the plan URL and the affected shared parts, pages and site settings", async () => {
  const app = await setup({ adapter: { prepareRelease: async (request) => ({ ...request, confirmationToken: "t", domain: "https://example.test", changes: [], url: "https://example.test/about-us",
    affected: [{ kind: "shared", name: "ヘッダー", detail: "全ページのナビゲーション" }, { kind: "page", name: "ホーム" }, { kind: "site", name: "サイト共通の設定" }] }) } });
  try {
    await click("公開"); const text = dialog().textContent;
    for (const expected of ["公開URL", "https://example.test/about-us", "影響するコンポーネント・ページ・サイト設定", "コンポーネント", "ヘッダー", "全ページのナビゲーション", "ページ", "サイト設定", "サイト共通の設定"]) assert.ok(text.includes(expected), expected);
  } finally { await app.cleanup(); }
});

function pageOperationsAdapter(normalize = (document) => document) {
  let canonical = parsePageDocument(fixture), version = "v1";
  const operations = [];
  return {
    operations, saved: () => canonical,
    external(document) { canonical = { ...document, revision: canonical.revision + 1 }; version = `v${canonical.revision}`; },
    adapter: {
      async readDocument() { return { version, document: structuredClone(canonical) }; },
      async applyOperations(request) {
        operations.push(request);
        if (request.baseVersion !== version) return { status: "conflict" };
        let next = canonical;
        for (const operation of request.operations) next = editDocumentById(next, operation);
        canonical = { ...normalize(next), revision: canonical.revision + 1 };
        version = `v${canonical.revision}`;
        return { status: "applied", version, revision: canonical.revision, document: structuredClone(canonical) };
      }
    },
  };
}

test("operation-connected editor saves text and inverse/forward edits, then reloads the canonical draft", async () => {
  const host = pageOperationsAdapter();
  const app = await setup({ adapter: host.adapter });
  try {
    await clickLayer("heading"); await change(input("テキスト"), "海のそばで暮らす");
    await click("下書き保存");
    assert.equal(app.calls.saves.length, 0);
    assert.deepEqual(host.operations[0].operations, [{ type: "text", parentId: "heading", childPath: [0], value: "海のそばで暮らす",
      preconditions: { parentId: "heading", oldValue: fixture.body[0].children[0].children[0].text, textPathContext: [{ type: "target" }] } }]);
    assert.ok(JSON.stringify(host.operations[0]).length < 1024);
    await click("元に戻す"); await click("下書き保存");
    assert.deepEqual(host.operations[1].operations[0].preconditions, { parentId: "heading", oldValue: "海のそばで暮らす", textPathContext: [{ type: "target" }] });
    assert.equal(host.operations[1].operations[0].value, fixture.body[0].children[0].children[0].text);
    await click("やり直す"); await click("下書き保存");
    assert.deepEqual(host.operations[2].operations[0].preconditions, { parentId: "heading", oldValue: fixture.body[0].children[0].children[0].text, textPathContext: [{ type: "target" }] });
    assert.equal(host.operations[2].operations[0].value, "海のそばで暮らす");
    await app.reload(); await clickLayer("heading");
    assert.equal(input("テキスト").value, "海のそばで暮らす");
  } finally { await app.cleanup(); }
});

test("operation-connected editor retains the retry ID and reapplies edits made during canonical acknowledgment", async () => {
  const host = pageOperationsAdapter((document) => ({ ...document, meta: { description: "Canonical host field" } }));
  const send = host.adapter.applyOperations;
  let complete, firstResponse;
  const attempts = [];
  host.adapter.applyOperations = async (request) => {
    attempts.push(request);
    if (attempts.length === 1) {
      firstResponse = await send(request);
      throw new Error("response lost");
    }
    if (attempts.length !== 2) return send(request);
    await new Promise((resolve) => { complete = resolve; });
    return firstResponse;
  };
  const app = await setup({ adapter: host.adapter });
  try {
    await change(input("ページタイトル"), "一度目の編集"); await click("下書き保存");
    await click("下書き保存");
    await change(input("ページタイトル"), "応答中にも編集");
    await act(async () => complete()); await flush();
    assert.equal(attempts[0].operationId, attempts[1].operationId);
    assert.equal(input("ページタイトル").value, "応答中にも編集");
    await click("下書き保存");
    assert.equal(attempts[2].baseVersion, "v2");
    assert.notEqual(attempts[2].operationId, attempts[1].operationId);
    assert.deepEqual(attempts[2].operations, [{ type: "title", value: "応答中にも編集" }]);
    await click("元に戻す"); await click("下書き保存");
    assert.deepEqual(attempts[3].operations, [{ type: "title", value: "一度目の編集" }]);
    assert.equal(host.saved().meta.description, "Canonical host field");
    assert.equal(app.calls.saves.length, 0);
  } finally { await app.cleanup(); }
});

async function waitForConflictReviewButton() {
  const name = "最新に適用して保存";
  const current = button(name);
  if (current) return current;

  const ready = Promise.withResolvers();
  const observer = new dom.window.MutationObserver(() => {
    const control = button(name);
    if (control) ready.resolve(control);
  });
  const deadline = AbortSignal.timeout(10_000);
  const onTimeout = () => ready.reject(new Error(`競合確認ダイアログに「${name}」が表示されませんでした`));
  observer.observe(document.body, { childList: true, subtree: true });
  deadline.addEventListener("abort", onTimeout, { once: true });
  try { return await ready.promise; }
  finally {
    observer.disconnect();
    deadline.removeEventListener("abort", onTimeout);
  }
}

test("operation conflict keeps the local queue and retries a CLI write only after review", async () => {
  const storage = createMemoryPageOperationHost([{ document: fixture, version: "v1" }]);
  const api = createPageEditingApi({
    ...storage,
    async authenticate(request) {
      const clientKind = request.headers.get("Authorization") === "Bearer gui" ? "gui" : "cli";
      return { kind: clientKind === "gui" ? "human" : "machine", subject: "editor", clientKind };
    },
    async authorize() { return true; },
  });
  const clientFor = (clientKind) => createPageEditingApiClient({
    origin: "https://edit.example", siteId: homeTarget.siteId, headers: { Authorization: `Bearer ${clientKind}` },
    fetch: (url, options) => api(new Request(url, options))
  });
  const cli = clientFor("cli"), gui = clientFor("gui"), operations = [];
  const reapplied = Promise.withResolvers();
  const app = await setup({ adapter: {
    readDocument: (target, signal) => gui.read(target, signal),
    applyOperations: ({ target, ...request }, signal) => {
      operations.push(request);
      const response = gui.applyOperations(target, request, signal);
      if (operations.length === 2) response.then(reapplied.resolve, reapplied.reject);
      return response;
    },
  } });
  try {
    await change(input("ページタイトル"), "GUIの編集");
    const external = await cli.applyOperations(homeTarget, {
      baseVersion: "v1", operationId: crypto.randomUUID(), operations: [{ type: "meta", field: "description", value: "CLIの編集" }]
    });
    assert.equal(external.status, "applied");
    await click("下書き保存");
    const retry = await waitForConflictReviewButton();
    assert.equal(retry.disabled, true);
    assert.equal(input("ページタイトル").value, "GUIの編集");
    const confirm = document.querySelector('[role="dialog"] input[type="checkbox"]');
    await act(async () => confirm.click()); await flush();
    await press(retry);
    assert.equal(operations.length, 2);
    assert.equal(operations[1].baseVersion, external.version);
    assert.notEqual(operations[1].operationId, operations[0].operationId);
    assert.equal((await reapplied.promise).status, "applied");
    assert.equal(storage.readJournal().length, 2);
    const { document: saved } = await cli.read(homeTarget);
    assert.equal(saved.title, "GUIの編集");
    assert.equal(saved.meta.description, "CLIの編集");
    assert.deepEqual(storage.readJournal().map(({ actor }) => actor.clientKind), ["cli", "gui"]);
    assert.equal(app.calls.saves.length, 0);
  } finally { await app.cleanup(); }
});

test("an overlapping operation conflict retains the draft in the configured recovery store", async () => {
  const host = pageOperationsAdapter(), recovered = [];
  const store = { read: () => null, write: (entry) => recovered.push(entry), remove() {} };
  const app = await setup({ adapter: host.adapter, props: { recovery: store } });
  try {
    await change(input("ページタイトル"), "復元できる GUI の編集");
    host.external({ ...host.saved(), title: "同じ項目を CLI で編集" });
    await click("下書き保存");
    assert.equal(button("最新に適用して保存"), undefined);
    assert.ok(button("あなたの編集で上書き保存")?.disabled);
    assert.equal(recovered.at(-1).document.title, "復元できる GUI の編集");
    assert.equal(input("ページタイトル").value, "復元できる GUI の編集");
  } finally { await app.cleanup(); }
});

test("an operation-connected editor saves duplication and its inverse", async () => {
  const host = pageOperationsAdapter();
  const app = await setup({ adapter: host.adapter });
  try {
    await clickLayer("heading"); await click("複製"); await click("下書き保存");
    const copy = host.saved().body[0].children[1];
    assert.notEqual(copy.id, "heading");
    assert.deepEqual(host.operations[0].operations, [{ type: "duplicate", nodeId: "heading" }]);
    await click("元に戻す"); await click("下書き保存");
    assert.deepEqual(host.operations[1].operations, [{ type: "remove", nodeId: copy.id }]);
    assert.equal(app.calls.saves.length, 0);
  } finally { await app.cleanup(); }
});

test("operation-connected autosave sends the queue and falls back for a restored document", async (t) => {
  const advance = useTestClock(t, act);
  const host = pageOperationsAdapter(), recovery = {
    read() { return { target: homeTarget, document: { ...fixture, title: "端末に退避した編集" }, baseRevision: fixture.revision, baseVersion: "v1", updatedAt: new Date().toISOString() }; },
    write() {}, remove() {}
  };
  const app = await setup({ adapter: host.adapter, props: { recovery, autosave: { delayMs: 100 } } });
  try {
    await click("破棄");
    await change(input("ページタイトル"), "自動保存する編集");
    await advance(250);
    assert.equal(host.operations.length, 1);
    assert.deepEqual(host.operations[0].operations, [{ type: "title", value: "自動保存する編集" }]);
    assert.equal(app.calls.saves.length, 0);
  } finally { await app.cleanup(); }
  const restored = await setup({ adapter: host.adapter, props: { recovery }, save: async (request) => {
    host.external(request.document);
    return { status: "saved", version: `v${host.saved().revision}`, revision: host.saved().revision };
  } });
  try {
    await click("復元する");
    await click("復元した内容で編集を続ける");
    await click("下書き保存");
    assert.equal(restored.calls.saves.length, 1);
    assert.equal(restored.calls.saves[0].document.title, "端末に退避した編集");
    assert.equal(host.operations.length, 1);
    await change(input("ページタイトル"), "次の編集は操作で保存");
    await click("下書き保存");
    assert.equal(restored.calls.saves.length, 1);
    assert.deepEqual(host.operations[1].operations, [{ type: "title", value: "次の編集は操作で保存" }]);
  } finally { await restored.cleanup(); }
});
