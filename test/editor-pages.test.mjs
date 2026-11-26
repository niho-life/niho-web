import * as helpers from "./editor-ui-support.mjs";
const { assert, readFileSync, findLayer, JSDOM, createMemoryPageOperationHost, createPageEditingApi, createPageEditingApiClient, editDocumentById, createBlankEmbedRegistry, pageScope, parsePageDocument, editorShortcuts, dom, createElement, act, createRoot, PageEditor, createMemoryAssetLibrary, renderPageToHtml, parseResolvedAssets, uniqueAssetReferences, fixture, flush, button, input, click, layerById, clickLayer, editorTab, reloadEditor, pageRow, clickPage, change, setup, sitePages, pageHost, dialog, panel, inputIn, buttonIn, press, treeShape, mountedAssetPanel, assetPanel, tool, assetCard, settle, chooseAsset, uploadFiles, clickCanvas, canvasNode, canvasBody, layerButton, shortcut, commandDialog, canvasOrder, dragEvent, pointer, png, imageTypes, garden, withImage, night, coverFrame, coverRemove, caps, yoga, wave, sourceLibrary, spy, sourceTabs, cardNames, assetButton, createBrowserRecoveryStore, RecoveryTooLargeError, status, toolbarButton, homeTarget, localTime, memoryStorage, recoveryKey, historyHost, versionRows, historyButton, pageOperationsAdapter, test, wait } = helpers;

test("page rows prefetch on focus and the matching snapshot serves the page switch", async () => {
  const prefetches = [];
  const app = await setup({ adapter: { prefetchDocument: async (target) => {
    prefetches.push(structuredClone(target));
    return { document: { ...structuredClone(fixture), ...target }, version: `prefetched-${target.pageId}` };
  } } });
  try {
    const other = pageRow("別ページ"); assert.ok(other);
    await act(async () => other.focus()); await flush();
    assert.deepEqual(prefetches, [{ siteId: "demo", pageId: "other", locale: "ja-JP" }]);
    await clickPage("別ページ");
    assert.equal(app.calls.reads.filter(({ pageId }) => pageId === "other").length, 0, "ページ切替は先読みしたsnapshotを使う");
    assert.equal(document.querySelector(".e-page[aria-current='page'] .e-page-name")?.textContent, "別ページ");
  } finally { await app.cleanup(); }
});

test("the adjacent page is prefetched automatically and serves a switch", async () => {
  const prefetches = [];
  const app = await setup({ adapter: { prefetchDocument: async (target) => {
    prefetches.push(structuredClone(target));
    return { document: { ...structuredClone(fixture), ...target }, version: `idle-${target.pageId}` };
  } } });
  try {
    assert.deepEqual(prefetches, [{ siteId: "demo", pageId: "other", locale: "ja-JP" }], "idle warmup should not depend on pointer movement");
    await clickPage("別ページ");
    assert.equal(app.calls.reads.filter(({ pageId }) => pageId === "other").length, 0, "the warmed snapshot serves the page switch");
  } finally { await app.cleanup(); }
});

test("a previously opened page is shown before its version revalidation finishes", async () => {
  const reads = [], homeReads = { count: 0 };
  let resolveHomeRefresh;
  const homeRefresh = new Promise((resolve) => { resolveHomeRefresh = resolve; });
  const app = await setup({ adapter: {
    prefetchDocument: undefined,
    readDocument: async (target) => {
      reads.push(target.pageId);
      if (target.pageId === "home" && ++homeReads.count === 2) return homeRefresh;
      return { document: { ...structuredClone(fixture), ...target }, version: `${target.pageId}-v${homeReads.count}` };
    }
  } });
  try {
    await clickPage("別ページ");
    await clickPage("ホーム");
    assert.equal(input("ページタイトル").value, fixture.title, "the saved page cache renders without waiting for the second home read");
    assert.deepEqual(reads, ["home", "other", "home"], "the cached navigation still revalidates the server version");

    const latest = structuredClone(fixture); latest.title = "サーバーで更新されたページ";
    await act(async () => resolveHomeRefresh({ document: { ...latest, pageId: "home", locale: "ja-JP" }, version: "home-v2" }));
    await flush();
    assert.equal(input("ページタイトル").value, latest.title, "a clean editor adopts the refreshed server session");
  } finally {
    resolveHomeRefresh({ document: { ...structuredClone(fixture), pageId: "home", locale: "ja-JP" }, version: "home-cleanup" });
    await app.cleanup();
  }
});

test("a page revalidation never replaces a newer local edit", async () => {
  let homeReads = 0, resolveHomeRefresh;
  const homeRefresh = new Promise((resolve) => { resolveHomeRefresh = resolve; });
  const app = await setup({ adapter: {
    prefetchDocument: undefined,
    readDocument: async (target) => {
      if (target.pageId === "home" && ++homeReads === 2) return homeRefresh;
      return { document: { ...structuredClone(fixture), ...target }, version: `${target.pageId}-v${homeReads}` };
    }
  } });
  try {
    await clickPage("別ページ");
    await clickPage("ホーム");
    await change(input("ページタイトル"), "手元の編集");
    const latest = structuredClone(fixture); latest.title = "別の編集者の更新";
    await act(async () => resolveHomeRefresh({ document: { ...latest, pageId: "home", locale: "ja-JP" }, version: "home-v2" }));
    await flush();
    assert.equal(input("ページタイトル").value, "手元の編集", "the pending local edit remains visible after server revalidation");
    assert.equal(button("下書き保存").disabled, false, "the local edit remains available for the existing version conflict flow");
  } finally {
    resolveHomeRefresh({ document: { ...structuredClone(fixture), pageId: "home", locale: "ja-JP" }, version: "home-cleanup" });
    await app.cleanup();
  }
});

test("both adjacent pages start prefetching before the first document finishes loading", async () => {
  const prefetches = [], reads = [];
  let finishInitialRead;
  const initialRead = new Promise((resolve) => { finishInitialRead = resolve; });
  const pages = [
    { siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム" },
    { siteId: "demo", pageId: "other", locale: "ja-JP", title: "別ページ" },
    { siteId: "demo", pageId: "last", locale: "ja-JP", title: "最後のページ" }
  ];
  const app = await setup({ adapter: {
    listPages: async () => pages,
    readDocument: async (target) => {
      reads.push(target.pageId);
      if (target.pageId === "home") await initialRead;
      return { document: { ...structuredClone(fixture), ...target }, version: `read-${target.pageId}`, releases: [] };
    },
    prefetchDocument: async (target) => {
      prefetches.push(target.pageId);
      return { document: { ...structuredClone(fixture), ...target }, version: `prefetched-${target.pageId}` };
    }
  } });
  try {
    assert.deepEqual(reads, ["home"], "the initial document is still loading");
    assert.deepEqual(new Set(prefetches), new Set(["last", "other"]), "both visible neighbors warm in parallel");
    finishInitialRead(); await wait(0);
    await clickPage("別ページ");
    assert.deepEqual(reads, ["home"], "the prefetched page skips a new document request");
    assert.equal(document.querySelector(".e-page[aria-current='page'] .e-page-name")?.textContent, "別ページ");
  } finally {
    finishInitialRead();
    await app.cleanup();
  }
});

test("responsive proposal control is absent without the optional host adapter", async () => {
  const absent = await setup();
  try { assert.equal(button("レスポンシブ提案"), undefined); }
  finally { await absent.cleanup(); }
  const present = await setup({ adapter: { responsiveProposal: { propose: async (request) => ({ fingerprint: request.fingerprint, changes: [] }) } } });
  try { assert.ok(button("レスポンシブ提案")); }
  finally { await present.cleanup(); }
});

test("breakpoint settings dialog analyzes every page and reports unused and nearby widths", async () => {
  const reads = [];
  const page = (pageId, width) => ({ schemaVersion: 1, siteId: "demo", pageId, locale: "ja-JP", revision: 1, title: pageId,
    tokens: {}, body: [{ type: "element", id: `${pageId}-root`, tag: "main",
      ...(width ? { style: { responsive: [{ minWidth: width, declarations: { fontSize: 24 } }] } } : {}), children: [{ type: "text", text: pageId }] }] });
  const docs = { home: page("home"), other: page("other", 1264) };
  const settings = { base: { name: "Mobile", previewWidth: 375 }, breakpoints: [
    { name: "Tablet", minWidth: 768, previewWidth: 900 }, { name: "PC", minWidth: 1280, previewWidth: 1440 }
  ] };
  const app = await setup({ adapter: {
    listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム" }, { siteId: "demo", pageId: "other", locale: "ja-JP", title: "別ページ" }],
    readDocument: async (target) => { reads.push(target.pageId); return { document: docs[target.pageId], version: `v-${target.pageId}` }; },
    breakpointSettings: { read: async () => ({ settings, version: "bp-v1" }), save: async () => ({ status: "saved", version: "bp-v2" }) }
  } });
  try {
    await click("編集モード");
    for (let attempt = 0; attempt < 5 && !document.querySelector(".e-breakpoint-analysis")?.textContent.includes("保存済み設定で全 2 文書"); attempt++) await flush();
    const analysis = document.querySelector(".e-breakpoint-analysis");
    assert.ok(analysis);
    assert.deepEqual(reads.sort(), ["home", "other"], "the current page is already loaded and the other page is fetched for analysis");
    assert.match(analysis.textContent, /どの文書からも使われていない段[\s\S]*タブレット 768px/u);
    assert.match(analysis.textContent, /近接した段（48px以内）[\s\S]*PC 1280px と 文書の段 1264px/u);
    assert.match(analysis.textContent, /正規化の plan/u);
  } finally { await app.cleanup(); }
});

test("breakpoint analysis fails closed when any page cannot be read", async () => {
  const settings = { base: { name: "Mobile", previewWidth: 375 }, breakpoints: [{ name: "PC", minWidth: 1280, previewWidth: 1440 }] };
  const app = await setup({ adapter: {
    readDocument: async (target) => target.pageId === "home"
      ? { document: { ...structuredClone(fixture), pageId: "home", locale: "ja-JP" }, version: "v-home" }
      : Promise.reject(new Error("別ページの読込に失敗しました。")),
    breakpointSettings: { read: async () => ({ settings, version: "bp-v1" }), save: async () => ({ status: "saved", version: "bp-v2" }) }
  } });
  try {
    await click("編集モード");
    for (let attempt = 0; attempt < 5 && !document.querySelector(".e-breakpoint-analysis")?.textContent.includes("別ページの読込に失敗しました"); attempt++) await flush();
    const analysis = document.querySelector(".e-breakpoint-analysis");
    assert.match(analysis.textContent, /別ページの読込に失敗しました/u);
    assert.doesNotMatch(analysis.textContent, /使われていない設定段はありません/u);
  } finally { await app.cleanup(); }
});

test("breakpoint analysis keeps the error state when another read resolves after abort", async () => {
  let resolveAbout;
  let contactStarted = false;
  const aboutRead = new Promise((resolve) => { resolveAbout = resolve; });
  const settings = { base: { name: "Mobile", previewWidth: 375 }, breakpoints: [{ name: "PC", minWidth: 1280, previewWidth: 1440 }] };
  const app = await setup({ adapter: {
    listPages: async () => [
      { siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム" },
      { siteId: "demo", pageId: "about", locale: "ja-JP", title: "紹介" },
      { siteId: "demo", pageId: "contact", locale: "ja-JP", title: "問い合わせ" }
    ],
    readDocument: async (target) => {
      if (target.pageId === "about") return aboutRead;
      contactStarted = true;
      throw new Error("問い合わせページの読込に失敗しました。");
    },
    breakpointSettings: { read: async () => ({ settings, version: "bp-v1" }), save: async () => ({ status: "saved", version: "bp-v2" }) }
  } });
  try {
    await click("編集モード");
    for (let attempt = 0; attempt < 30 && !document.querySelector(".e-breakpoint-analysis")?.textContent.includes("問い合わせページの読込に失敗しました"); attempt++) await flush();
    const analysis = document.querySelector(".e-breakpoint-analysis");
    assert.equal(contactStarted, true);
    assert.match(analysis.textContent, /問い合わせページの読込に失敗しました/u);
    resolveAbout({ document: { ...structuredClone(fixture), pageId: "about", locale: "ja-JP" }, version: "v-about" });
    await flush();
    assert.match(analysis.textContent, /問い合わせページの読込に失敗しました/u);
    assert.doesNotMatch(analysis.textContent, /確認中/u);
  } finally { await app.cleanup(); }
});

test("responsive proposal reviews exact changes, applies once and undo restores them", async () => {
  let requested;
  const app = await setup({ adapter: { responsiveProposal: { propose: async (request) => {
    requested = structuredClone(request);
    return { fingerprint: request.fingerprint, changes: [
      { nodeId: "hero", breakpoint: 768, property: "padding", value: "2rem" },
      { nodeId: "heading", breakpoint: 1280, property: "fontSize", value: 48 }
    ] };
  } } } });
  try {
    await click("レスポンシブ提案");
    assert.match(document.querySelector('[role="dialog"]').textContent, /ページ全体/u);
    await click("提案を依頼");
    assert.deepEqual(requested.target, { siteId: "demo", pageId: "home", locale: "ja-JP" });
    assert.deepEqual(requested.scope, { type: "page" });
    assert.deepEqual(requested.breakpoints, [768, 1280]);
    const review = document.querySelector(".e-responsive-proposal-review");
    assert.match(review.textContent, /768px以上.*内側余白.*指定なし.*2rem/us);
    assert.match(review.textContent, /1280px以上.*文字サイズ.*指定なし.*48/us);
    await click("この変更を適用");
    await click("下書き保存");
    assert.equal(app.calls.saves.at(-1).document.body[0].style.responsive.find((entry) => entry.minWidth === 768).declarations.padding, "2rem");
    assert.equal(app.calls.saves.at(-1).document.body[0].children[0].style.responsive.find((entry) => entry.minWidth === 1280).declarations.fontSize, 48);
    await click("元に戻す");
    await click("下書き保存");
    assert.equal(app.calls.saves.at(-1).document.body[0].style.responsive.find((entry) => entry.minWidth === 768).declarations.padding, undefined);
    assert.equal(app.calls.saves.at(-1).document.body[0].children[0].style, undefined);
  } finally { await app.cleanup(); }
});

test("initialTarget opens the requested page and falls back when the page is absent", async () => {
  const requested = await setup({ props: { initialTarget: { siteId: "demo", pageId: "other", locale: "ja-JP" } } });
  try { assert.deepEqual(requested.calls.reads, [{ siteId: "demo", pageId: "other", locale: "ja-JP" }]); }
  finally { await requested.cleanup(); }
  const absent = await setup({ props: { initialTarget: { siteId: "demo", pageId: "missing", locale: "ja-JP" } } });
  try { assert.deepEqual(absent.calls.reads, [{ siteId: "demo", pageId: "home", locale: "ja-JP" }]); }
  finally { await absent.cleanup(); }
});

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

test("unrelated page edits preserve the shared text-style context for memoized canvas nodes", async () => {
  let renders = 0;
  const blocks = { Counter: { props: {}, component: () => { renders++; return createElement("span", null, "counter"); } } };
  const page = structuredClone(fixture);
  page.textStyles = { body: { base: { fontSize: 16 } } };
  page.body = Array.from({ length: 40 }, (_, index) => ({ type: "component", id: `counter-${index}`, block: "Counter", props: {}, style: { textStyle: "body" } }));
  const app = await setup({ document: page, blocks });
  try {
    const initialRenders = renders;
    assert.equal(initialRenders, page.body.length);
    await change(input("ページタイトル"), "更新したページタイトル");
    assert.equal(renders, initialRenders, "metadata edits should not rerender unchanged canvas nodes");
  } finally { await app.cleanup(); }
});

test("form completion inspector filters candidates, shows loading and unresolved IDs, and saves only an eligible page ID", async () => {
  let resolvePages;
  const page = structuredClone(fixture); page.body.push({ type: "element", id: "contact_form", tag: "form", formCompletionPageId: "removed", attrs: { name: "contact" }, children: [
    { type: "element", id: "contact_submit", tag: "button", attrs: { type: "submit" }, children: [{ type: "text", text: "送信" }] }
  ] });
  const app = await setup({ document: page, adapter: { listFormCompletionPages: (_target, signal) => new Promise((resolve, reject) => {
    resolvePages = resolve; signal.addEventListener("abort", () => reject(new dom.window.DOMException("aborted", "AbortError")), { once: true });
  }) } });
  try {
    await clickLayer("contact_form"); await editorTab("フォーム");
    assert.match(document.querySelector('[aria-label="インスペクタ"]').textContent, /完了ページを読み込んでいます/u);
    await act(async () => resolvePages([
      { siteId: "demo", pageId: "thanks", locale: "ja-JP", title: "送信完了", path: "/thanks", kind: "page", visibility: "public", published: true },
      { siteId: "demo", pageId: "home", locale: "ja-JP", title: "現在", path: "/", kind: "page", visibility: "public", published: true },
      { siteId: "demo", pageId: "private", locale: "ja-JP", title: "非公開", path: "/private", kind: "page", visibility: "private", published: true },
      { siteId: "demo", pageId: "draft", locale: "ja-JP", title: "未公開", path: "/draft", kind: "page", visibility: "public", published: false },
      { siteId: "demo", pageId: "template", locale: "ja-JP", title: "テンプレート", path: "/items/[slug]", kind: "template", visibility: "public", published: true },
      { siteId: "other", pageId: "foreign", locale: "ja-JP", title: "別サイト", path: "/foreign", kind: "page", visibility: "public", published: true }
    ])); await flush();
    const select = input("完了ページ");
    assert.deepEqual([...select.options].map((option) => [option.value, option.disabled]), [["", false], ["removed", true], ["thanks", false]]);
    assert.match(select.selectedOptions[0].textContent, /未解決/u);
    await change(select, "thanks"); await click("下書き保存");
    assert.equal(app.stored().body.find((node) => node.id === "contact_form").formCompletionPageId, "thanks");
    assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-node="contact_form"]').getAttribute("formCompletionPageId"), null);
  } finally { await app.cleanup(); }
});

test("form completion inspector is unconnected without the capability and ignores a late result from the previous page", async () => {
  const page = structuredClone(fixture); page.body.push({ type: "element", id: "contact_form", tag: "form", formCompletionPageId: "removed", children: [] });
  const unconnected = await setup({ document: page });
  try {
    await clickLayer("contact_form"); await editorTab("フォーム");
    assert.match(document.querySelector('[aria-label="インスペクタ"]').textContent, /完了ページは未接続/u);
    assert.equal(input("完了ページ"), undefined);
  } finally { await unconnected.cleanup(); }

  const pending = new Map();
  const app = await setup({ document: page, adapter: { listFormCompletionPages: (target, signal) => new Promise((resolve, reject) => {
    pending.set(target.pageId, resolve); signal.addEventListener("abort", () => reject(new dom.window.DOMException("aborted", "AbortError")), { once: true });
  }) } });
  try {
    await clickLayer("contact_form"); await editorTab("フォーム");
    const old = pending.get("home"); await clickPage("別ページ"); await clickLayer("contact_form"); await editorTab("フォーム");
    await act(async () => old([{ siteId: "demo", pageId: "old", locale: "ja-JP", title: "古い候補", path: "/old", kind: "page", visibility: "public", published: true }])); await flush();
    assert.match(document.querySelector('[aria-label="インスペクタ"]').textContent, /読み込んでいます/u);
    assert.doesNotMatch(document.querySelector('[aria-label="インスペクタ"]').textContent, /古い候補/u);
    await act(async () => pending.get("other")([{ siteId: "demo", pageId: "done", locale: "ja-JP", title: "新しい候補", path: "/done", kind: "page", visibility: "public", published: true }])); await flush();
    assert.deepEqual([...input("完了ページ").options].map((option) => option.value), ["", "removed", "done"]);
  } finally { await app.cleanup(); }
});

test("English publication states stay separate from the Japanese draft and retry only when allowed", async () => {
  const states = [
    ["queued", "処理待ち"], ["translating", "翻訳中"], ["review-required", "未翻訳"], ["publishing", "公開中"],
    ["published", "公開済み"], ["withdrawn", "取り下げ"], ["retryable-failure", "失敗（再試行可能）"], ["superseded", "新しい版に置換済み"]
  ];
  let refreshIndex = 0;
  const app = await setup({
    englishPublication: { state: "initial-release-required", retryable: true, updatedAt: "2026-10-27T01:02:03.000Z" },
    adapter: {
      listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja", title: "ホーム" }, { siteId: "demo", pageId: "other", locale: "ja", title: "別ページ" }],
      englishPublication: {
        refresh: async () => {
          const [state] = states[refreshIndex++];
          return { state, retryable: state === "retryable-failure" };
        },
        retry: async () => ({ status: "accepted", englishPublication: { state: "queued", retryable: false } })
      }
    }
  });
  try {
    const publication = () => document.querySelector(".e-english-publication");
    assert.match(publication().textContent, /最初の英語版公開待ち/u);
    assert.equal(button("英語公開を再試行"), undefined, "初回公開待ちは retryable が不正に true でも再試行しない");

    await change(input("ページタイトル"), "保存前の日本語タイトル");
    await click("状態を更新");
    assert.equal(input("ページタイトル").value, "保存前の日本語タイトル", "状態更新は未保存文書を上書きしない");
    await click("元に戻す");
    assert.equal(input("ページタイトル").value, fixture.title, "状態更新後も undo 履歴を保持する");

    for (const [, label] of states.slice(1, -1)) {
      await click("状態を更新");
      if (label === "公開済み") {
        assert.equal(publication(), null, "正常な公開済み状態では画面上部の帯を表示しない");
        await clickPage("別ページ"); await clickPage("ホーム");
        continue;
      }
      assert.ok(publication().querySelector("strong").textContent.includes(label), label);
    }
    assert.ok(button("英語公開を再試行"));
    await click("英語公開を再試行");
    assert.match(publication().textContent, /処理待ち/u);
    assert.doesNotMatch(publication().textContent, /公開済み/u, "accepted を公開済みと決めつけない");
    await click("状態を更新");
    assert.equal(publication(), null, "新しい版に置換済みのバナーは表示しない");

    await change(input("ページタイトル"), "保存する日本語タイトル");
    await click("下書き保存");
    assert.equal(app.calls.saves.at(-1).expectedVersion, "v1", "状態操作は文書 version を進めない");
  } finally { await app.cleanup(); }
});

test("a late English publication refresh is ignored after switching pages", async () => {
  let resolveRefresh;
  const app = await setup({ adapter: {
    listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja", title: "ホーム" }, { siteId: "demo", pageId: "other", locale: "ja", title: "別ページ" }],
    readDocument: async (target) => ({ document: { ...structuredClone(fixture), pageId: target.pageId, locale: "ja" }, version: `v-${target.pageId}`,
      englishPublication: target.pageId === "home" ? { state: "queued", retryable: false } : { state: "withdrawn", retryable: false } }),
    englishPublication: {
      refresh: () => new Promise((resolve) => { resolveRefresh = resolve; }),
      retry: async () => ({ status: "accepted", englishPublication: { state: "queued", retryable: false } })
    }
  } });
  try {
    await click("状態を更新");
    await clickPage("別ページ");
    assert.match(document.querySelector(".e-english-publication").textContent, /取り下げ/u);
    await act(async () => resolveRefresh({ state: "published", retryable: false })); await flush();
    assert.match(document.querySelector(".e-english-publication").textContent, /取り下げ/u);
    assert.doesNotMatch(document.querySelector(".e-english-publication").textContent, /公開済み/u);
  } finally { await app.cleanup(); }
});

test("English publication retry failures show only a safe message and keep the draft", async () => {
  const app = await setup({
    englishPublication: { state: "retryable-failure", retryable: true },
    adapter: {
      listPages: async () => [{ siteId: "demo", pageId: "home", locale: "ja", title: "ホーム" }],
      englishPublication: {
        refresh: async () => ({ state: "retryable-failure", retryable: true }),
        retry: async () => { throw new Error("SENSITIVE_UPSTREAM_ERROR"); }
      }
    }
  });
  try {
    await change(input("ページタイトル"), "保持する日本語下書き");
    await click("英語公開を再試行");
    assert.equal(input("ページタイトル").value, "保持する日本語下書き");
    assert.match(document.body.textContent, /英語公開を再試行できませんでした/u);
    assert.doesNotMatch(document.body.textContent, /SENSITIVE_UPSTREAM_ERROR/u);
  } finally { await app.cleanup(); }
});

test("Basic のフォーム一覧とインスペクタでフォーム項目を編集し、既存フォームへ安全に追加できる", async () => {
  const app = await setup();
  const addPreset = async (id) => {
    await click("追加"); const target = document.querySelector(`.e-preset-preview[data-preset="${id}"]`)?.closest("button");
    assert.ok(target, id); await act(async () => target.click()); await flush();
  };
  try {
    await click("追加");
    const labels = [...document.querySelectorAll(".e-add-category .e-preset-card")].map((item) => item.textContent);
    for (const label of ["Form1", "Form2", "Form3", "Input", "Textarea", "Select", "Radio", "Confirm", "Checkbox", "File", "Submit", "Search", "Password"]) assert.ok(labels.some((text) => text.endsWith(label)), label);
    await addPreset("form-1");
    assert.ok(input("フォーム名")); assert.ok(document.body.textContent.includes("完了設定")); assert.ok(document.body.textContent.includes("項目一覧"));
    await change(input("フォーム名"), "contact_form");
    const formId = document.querySelector("iframe").contentDocument.querySelector("form[data-nw-node]").dataset.nwNode;
    await addPreset("form-input");
    assert.ok(input("項目名")); assert.equal(input("入力タイプ").value, "text");
    await change(input("項目名"), "company"); await change(input("入力タイプ"), "email"); await change(input("プレースホルダー"), "company@example.com");
    const required = [...document.querySelectorAll("label.e-check")].find((label) => label.textContent.includes("必須項目"))?.querySelector("input");
    await act(async () => required.click()); await flush(); await click("下書き保存");
    const form = app.stored().body.at(-1), controls = form.children.filter((node) => node.type === "element" && node.tag === "input");
    assert.equal(form.tag, "form"); assert.equal(form.attrs.name, "contact_form"); assert.equal(form.children.some((node) => node.type === "element" && node.tag === "form"), false);
    assert.ok(controls.some((control) => control.attrs.name === "company" && control.attrs.type === "email" && control.attrs.required === true && control.attrs.placeholder === "company@example.com"));
    await clickCanvas(formId);
    const itemButtons = [...document.querySelectorAll(".e-form-items button")];
    assert.equal(itemButtons.length, 4);
    await act(async () => itemButtons.find((item) => item.textContent.includes("company")).click()); await flush();
    assert.equal(input("項目名").value, "company");
  } finally { await app.cleanup(); }
});

test("host adapters receive only the documented editor target fields", async () => {
  const app = await setup(), target = { siteId: "demo", pageId: "home", locale: "ja-JP" };
  try {
    assert.deepEqual(app.calls.reads[0], target);
    await change(input("ページタイトル"), "変更したタイトル"); await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].target, target);
    await click("公開"); assert.deepEqual(app.calls.prepares[0].target, target);
    await act(async () => document.querySelector('[role="dialog"] input[type="checkbox"]').click());
    await click("この内容を公開"); assert.deepEqual(app.calls.releases[0].target, target);
  } finally { await app.cleanup(); }
});

test("read-only documents stay selectable and navigable but block every document write path", async () => {
  const recoveryCalls = { read: 0, write: 0, remove: 0 }, recovery = {
    read: async () => { recoveryCalls.read++; return null; }, write: async () => { recoveryCalls.write++; }, remove: async () => { recoveryCalls.remove++; }
  };
  const revision = { id: "rev-one", revision: 1, kind: "draft", createdAt: "2026-10-21T00:00:00.000Z" };
  const readOnly = { reason: "公開テキストの原文は業務編集画面が正本です。", editUrl: "/staff/business/public-text/home", editLabel: "業務原稿を編集" };
  const app = await setup({ readOnly, props: { recovery }, adapter: {
    preparePageChange: async () => { throw new Error("must not prepare"); }, applyPageChange: async () => { throw new Error("must not apply"); },
    listRevisions: async () => ({ entries: [revision] }), readRevision: async () => ({ document: structuredClone(fixture) }),
    createSnapshot: async () => { throw new Error("must not snapshot"); }
  } });
  try {
    assert.ok(document.body.textContent.includes("原文（読み取り専用）")); assert.ok(document.body.textContent.includes(readOnly.reason));
    const canonical = [...document.querySelectorAll("a")].find((node) => node.textContent === "業務原稿を編集"); assert.equal(canonical?.getAttribute("href"), readOnly.editUrl);
    assert.equal(input("ページタイトル").disabled, true); assert.equal(button("下書き保存").disabled, true); assert.equal(button("公開").disabled, true);
    const openTool = async (name) => { const target = [...document.querySelectorAll(".e-tools button")].find((node) => node.querySelector("small")?.textContent === name); assert.ok(target); await act(async () => target.click()); await flush(); };
    await openTool("レイヤー"); const heading = await layerById("heading"); assert.equal(heading.disabled, false); await act(async () => heading.click()); await flush(); assert.equal(input("テキスト").disabled, true);
    await openTool("ページ"); assert.equal(document.querySelector('button[aria-label="ページを追加"]').disabled, true); assert.equal(document.querySelector('button[aria-label="ホーム の操作"]').disabled, true);
    await click("履歴"); await act(async () => [...document.querySelectorAll("button")].find((node) => node.textContent.includes("2026/10/21"))?.click()); await flush();
    assert.equal(button("この版を復元").disabled, true); assert.ok(document.body.textContent.includes(readOnly.reason));
    assert.deepEqual(recoveryCalls, { read: 0, write: 0, remove: 0 }); assert.equal(app.calls.saves.length, 0); assert.equal(app.calls.prepares.length, 0);
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

test("data-linked props show a lock reason while display props remain editable", async () => {
  const doc = structuredClone(fixture); doc.body.push({ type: "component", id: "notice", block: "Notice", props: { heading: "表示名", count: 5 } });
  const blocks = { Notice: { props: { heading: { type: "string", required: true }, count: { type: "number", required: true } }, lockedProps: { count: "外部データから取得します" }, component: ({ heading, count }) => createElement("p", null, `${heading}: ${count}`) } };
  const app = await setup({ document: doc, blocks });
  try {
    await clickLayer("notice"); await editorTab("設定"); assert.equal(input("count").disabled, true); assert.ok(document.body.textContent.includes("ロック: 外部データから取得します"));
    await change(input("heading"), "編集後の表示名"); await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].document.body.at(-1).props, { heading: "編集後の表示名", count: 5 });
  } finally { await app.cleanup(); }
});

test("host can hide business block insertion while retaining existing block editing", async () => {
  const doc = structuredClone(fixture); doc.body.push({ type: "component", id: "notice", block: "Notice", props: { heading: "Before" } });
  const blocks = { Notice: { props: { heading: { type: "string", required: true } }, component: ({ heading }) => createElement("p", null, heading) } };
  const app = await setup({ document: doc, blocks, insertableBlocks: [] });
  try {
    assert.equal(document.querySelector('select[aria-label="追加する要素"] option[value="block:Notice"]'), null);
    await clickLayer("notice"); await editorTab("設定"); await change(input("heading"), "After"); await click("下書き保存");
    assert.equal(app.calls.saves[0].document.body.at(-1).props.heading, "After");
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

test("page panel shows the path tree, kinds, states and counts, and selecting a row loads that page", async () => {
  const host = pageHost(), app = await setup({ adapter: host.adapter });
  try {
    assert.equal(document.querySelector('[aria-label="ページ"]')?.getAttribute("aria-pressed"), "true");
    assert.deepEqual(treeShape(), ["ホーム", "私たちについて", { circles: ["バドミントン", "囲碁"] }], "templates leave the path tree");
    assert.equal(pageRow("ホーム").getAttribute("aria-current"), "page"); assert.ok(pageRow("ホーム").textContent.includes("/"));
    // 状態は札ではなく右端の点（緑＝公開中・輪郭＝非公開）とそのツールチップ・読み上げで示す。
    assert.ok(pageRow("囲碁").textContent.includes("/circles/kamakura-go")); assert.equal(pageRow("囲碁").textContent.includes("非公開"), false, "no text badge");
    assert.equal(document.querySelector(".e-page .e-badge"), null, "page rows carry no badge");
    assert.equal(pageRow("囲碁").querySelector(".e-page-state").className, "e-page-state is-private"); assert.equal(pageRow("囲碁").querySelector(".e-page-state").getAttribute("aria-label"), "非公開");
    assert.equal(pageRow("囲碁").querySelector(".e-page-state").title, "非公開");
    assert.equal(pageRow("ホーム").querySelector(".e-page-state").className, "e-page-state is-live"); assert.equal(pageRow("ホーム").querySelector(".e-page-state").getAttribute("aria-label"), "公開中");
    // テンプレートは「テンプレート」の見出しの下（パスの階層には入れない）。
    const templates = document.querySelector(".e-page-section"); assert.equal(templates.querySelector("h3").textContent, "テンプレート");
    assert.deepEqual(treeShape(templates.querySelector(".e-page-templates")), ["体験詳細"]); assert.ok(templates.contains(pageRow("体験詳細"))); assert.ok(pageRow("体験詳細").textContent.includes("/experiences/[slug]"));
    assert.equal(document.querySelector(".e-page-templates .e-folder"), null); assert.equal(pageRow("ヘッダー"), undefined);
    assert.ok(document.body.textContent.includes("公開中 3 / 4 ページ"));
    assert.equal(document.querySelector('[aria-label="体験詳細 の操作"]'), null); assert.equal(document.querySelector('[aria-label="ヘッダー の操作"]'), null);
    assert.ok(document.querySelector('[aria-label="私たちについて の操作"]'));
    const folder = [...document.querySelectorAll(".e-folder")].find((node) => node.textContent === "circles");
    assert.equal(folder.getAttribute("aria-expanded"), "true"); await press(folder);
    assert.equal(folder.getAttribute("aria-expanded"), "false"); assert.equal(pageRow("バドミントン"), undefined); await press(folder);
    await clickPage("私たちについて");
    assert.deepEqual(app.calls.reads.at(-1), { siteId: "demo", pageId: "about", locale: "ja-JP" }); assert.equal(pageRow("私たちについて").getAttribute("aria-current"), "page");
    await press(document.querySelector('[aria-label="検索"]'));
    await change(document.querySelector('input[aria-label="ページを検索"]'), "circles");
    assert.deepEqual(treeShape(), ["バドミントン", "囲碁"]); assert.equal(document.querySelector(".e-page-section"), null, "no template matches circles");
    await change(document.querySelector('input[aria-label="ページを検索"]'), "slug");
    assert.equal(document.querySelector(".e-page-tree:not(.e-page-templates)"), null); assert.deepEqual(treeShape(document.querySelector(".e-page-templates")), ["体験詳細"], "search also filters the template section");
    await change(document.querySelector('input[aria-label="ページを検索"]'), "存在しない");
    assert.ok(document.body.textContent.includes("一致するページはありません")); assert.equal(document.querySelector(".e-page-section"), null);
    await press(document.querySelector('[aria-label="検索"]')); assert.equal(document.querySelector('input[aria-label="ページを検索"]'), null);
    assert.equal(treeShape().length, 3); assert.ok(document.querySelector(".e-page-section"));
  } finally { await app.cleanup(); }
});

test("host publication notes replace the generic unpublished badge in the page list, page settings and site components", async () => {
  const preview = { label: "プレビューのみ", description: "公開サイトは移行前の表示のままです。ここで編集しても公開サイトには出ません。" };
  const partial = { label: "一部で公開中", description: "新しい表示で公開中の 1 ページにだけ出ます。" };
  const app = await setup({ adapter: { listPages: async () => [
    { siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム", path: "/" },
    { siteId: "demo", pageId: "about", locale: "ja-JP", title: "私たちについて", path: "/about", published: false, publication: preview },
    { siteId: "demo", pageId: "draft", locale: "ja-JP", title: "準備中", path: "/draft", published: false },
    { siteId: "demo", pageId: "header", locale: "ja-JP", title: "ヘッダー", kind: "shared", publication: partial }
  ] } });
  try {
    // ホストの label と description は点のツールチップ・読み上げに回り、行には文字の札を出さない。
    const dot = (title) => pageRow(title).querySelector(".e-page-state");
    assert.equal(dot("私たちについて").className, "e-page-state is-unpublished"); assert.equal(dot("私たちについて").getAttribute("aria-label"), `${preview.label}：${preview.description}`);
    assert.equal(dot("私たちについて").title, `${preview.label}：${preview.description}`);
    assert.equal(pageRow("私たちについて").querySelector(".e-badge, .e-badge-publication"), null); assert.ok(!pageRow("私たちについて").textContent.includes("プレビューのみ"));
    assert.ok(!pageRow("私たちについて").textContent.includes("未公開"));
    assert.ok(pageRow("私たちについて").title.includes(preview.description));
    assert.equal(pageRow("私たちについて").querySelector(".e-page-label > .e-page-name").textContent, "私たちについて");
    assert.deepEqual([...pageRow("私たちについて").querySelectorAll(".e-page-label > .e-page-path")].map((node) => node.textContent), ["/about"]);
    assert.equal(dot("準備中").className, "e-page-state is-unpublished"); assert.equal(dot("準備中").getAttribute("aria-label"), "未公開"); assert.ok(!pageRow("準備中").textContent.includes("未公開"));
    assert.equal(dot("ホーム").className, "e-page-state is-live"); assert.equal(pageRow("ホーム").querySelector(".e-badge-publication"), null);
    assert.ok(document.body.textContent.includes("公開中 1 / 3 ページ"));
    await clickPage("私たちについて");
    const settings = await panel("ページ");
    const state = [...settings.querySelectorAll(".e-rows > div")].find((row) => row.querySelector("dt")?.textContent === "公開状態");
    assert.equal(state?.querySelector("dd")?.textContent, `${preview.label}${preview.description}`);
    await click("コンポーネント");
    const card = document.querySelector('.e-site-component[aria-label="ヘッダー"]');
    assert.equal(card?.querySelector(".e-badge-publication")?.textContent, partial.label);
    assert.ok(card?.textContent.includes(`サイト共通。${partial.description}`));
  } finally { await app.cleanup(); }
});

test("multi-page release selects only pages with changes and can resume from the saved operation status", async () => {
  const pages = [
    { siteId: "demo", pageId: "home", locale: "ja-JP", title: "ホーム", kind: "page" },
    { siteId: "demo", pageId: "about", locale: "ja-JP", title: "私たちについて", kind: "page" },
    { siteId: "demo", pageId: "contact", locale: "ja-JP", title: "お問い合わせ", kind: "page" }
  ];
  const absent = await setup();
  try { assert.equal(document.querySelector(".e-page-release-select"), null, "hosts without the optional methods do not show multi-page controls"); }
  finally { await absent.cleanup(); }

  let plannedItems, applied = 0, statusReads = 0, operationId;
  const app = await setup({ adapter: {
    listPages: async () => pages,
    readDocument: async (target) => ({ document: { ...structuredClone(fixture), ...target }, version: `v-${target.pageId}`, presentation: { version: `p-${target.pageId}` }, hasSavedDraft: true }),
    prepareRelease: async (request) => ({ ...request, confirmationToken: `single-${request.target.pageId}`, domain: "https://example.test",
      changes: request.target.pageId === "about" ? [] : [{ path: "title", before: "旧タイトル", after: request.target.pageId === "home" ? "ホーム更新" : "お問い合わせ更新" }] }),
    prepareReleaseSet: async (items) => {
      plannedItems = structuredClone(items); operationId = "550e8400-e29b-41d4-a716-446655440000";
      return { siteId: "demo", operationId, confirmationToken: "set-token", domain: "https://example.test", items: structuredClone(items) };
    },
    releaseSet: async (plan) => {
      applied++;
      return { status: "publishing", operationId: plan.operationId, items: plan.items.map((item, index) => index === 0
        ? { target: item.target, status: "released", version: "released-home" } : { target: item.target, status: "pending" }) };
    },
    releaseSetStatus: async (id) => {
      statusReads++; assert.equal(id, operationId);
      return { status: "completed", operationId: id, httpStatus: 200, result: { status: "completed", operationId: id,
        items: plannedItems.map((item, index) => ({ target: item.target, status: "released", version: `released-${index}` })) } };
    }
  } });
  try {
    for (const title of ["ホーム", "私たちについて", "お問い合わせ"]) {
      const checkbox = document.querySelector(`[aria-label="「${title}」を一括公開の対象にする"]`); assert.ok(checkbox, title);
      await press(checkbox);
    }
    await click("選択したページの変更を確認");
    const confirmation = document.querySelector('[role="dialog"]'); assert.ok(confirmation);
    assert.ok(confirmation.textContent.includes("https://example.test"), "the release destination is visible before confirmation");
    assert.match(confirmation.textContent, /差分がある 2 ページ/u);
    assert.ok(confirmation.textContent.includes("ホーム")); assert.ok(confirmation.textContent.includes("お問い合わせ"));
    assert.ok(!confirmation.textContent.includes("私たちについて"), "unchanged pages are excluded");
    assert.deepEqual(plannedItems.map((item) => item.target.pageId), ["home", "contact"]);
    assert.deepEqual(plannedItems.map((item) => item.presentationVersion), ["p-home", "p-contact"]);
    const consent = confirmation.querySelector(".e-release-set-confirm input"); await press(consent);
    await click("2 ページを公開");
    assert.equal(applied, 1); assert.match(document.querySelector('[role="dialog"]').textContent, /ページは処理待ち/u);
    await click("状態を確認");
    assert.equal(statusReads, 1); assert.equal(document.querySelector('[role="dialog"]').textContent.includes("公開済み"), true);
    await click("ページ一覧に戻る"); assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally { await app.cleanup(); }
});

test("multi-page release rejects a host plan outside the confirmed site, destination, targets, or versions", async () => {
  const invalidPlans = [
    (plan) => ({ ...plan, siteId: "another-site" }),
    (plan) => ({ ...plan, domain: "https://untrusted.example" }),
    (plan) => ({ ...plan, items: plan.items.map((item, index) => index ? item : { ...item, target: { ...item.target, pageId: "unreviewed" } }) }),
    (plan) => ({ ...plan, items: plan.items.map((item, index) => index ? item : { ...item, expectedVersion: "different-version" }) })
  ];
  for (const corrupt of invalidPlans) {
    let applied = 0;
    const app = await setup({ adapter: {
      prepareReleaseSet: async (items) => corrupt({ siteId: "demo", operationId: "550e8400-e29b-41d4-a716-446655440000",
        confirmationToken: "set-token", domain: "https://example.test", items: structuredClone(items) }),
      releaseSet: async () => { applied++; return { status: "conflict" }; },
      releaseSetStatus: async (operationId) => ({ status: "unknown", operationId })
    } });
    try {
      for (const title of ["ホーム", "別ページ"]) {
        const checkbox = document.querySelector(`[aria-label="「${title}」を一括公開の対象にする"]`); assert.ok(checkbox, title);
        await press(checkbox);
      }
      await click("選択したページの変更を確認");
      const dialog = document.querySelector('[role="dialog"]'); assert.ok(dialog);
      assert.ok(dialog.querySelector('[role="alert"]'), dialog.textContent);
      assert.equal(dialog.querySelector(".e-release-set-confirm"), null, "an unchecked plan must not reach user confirmation");
      assert.equal(applied, 0);
    } finally { await app.cleanup(); }
  }
});

test("page status maps visibility, published and the host publication to a dot and its words", async () => {
  const { pageStatus } = await import("../dist/editor-pages.js");
  const base = { siteId: "demo", pageId: "p", locale: "ja-JP", title: "P" };
  assert.deepEqual(pageStatus(base), { state: "live", text: "公開中" });
  assert.deepEqual(pageStatus({ ...base, published: false }), { state: "unpublished", text: "未公開" });
  assert.deepEqual(pageStatus({ ...base, visibility: "private" }), { state: "private", text: "非公開" });
  const preview = { label: "プレビューのみ", description: "公開サイトは移行前のままです。" };
  assert.deepEqual(pageStatus({ ...base, published: false, publication: preview }), { state: "unpublished", text: "プレビューのみ：公開サイトは移行前のままです。" });
  assert.deepEqual(pageStatus({ ...base, publication: { label: "公開中", description: "保存・公開した内容は反映されます。" } }), { state: "live", text: "公開中：保存・公開した内容は反映されます。" });
  assert.deepEqual(pageStatus({ ...base, visibility: "private", published: false, publication: preview }), { state: "private", text: "非公開 · プレビューのみ：公開サイトは移行前のままです。" });
});

test("public information edits are undoable document edits saved in meta", async () => {
  const host = pageHost(), app = await setup({ adapter: host.adapter });
  try {
    const page = await panel("ページ");
    await change(inputIn(page, "説明文"), "海のそばの暮らしを\n紹介します。");
    assert.equal(document.querySelector('[role="status"]').textContent, "未保存の変更あり");
    assert.ok(page.textContent.includes("16 / 500")); assert.ok(!page.textContent.includes("検索結果に表示される文章です。"), "説明文の欄は文字数だけを出す");
    assert.equal(buttonIn(page, "画像を選ぶ"), undefined); assert.equal(inputIn(page, "画像 URL").closest("details"), null);
    await change(inputIn(page, "画像 URL"), "javascript:alert(1)");
    assert.ok(page.textContent.includes("URL は https:// か / から始まる形式")); assert.equal(button("下書き保存").disabled, true);
    await change(inputIn(page, "画像 URL"), "/cover.jpg"); await change(inputIn(page, "画像の説明"), "海の写真");
    await act(async () => [...page.querySelectorAll("label.e-check")].find((node) => node.textContent.includes("検索エンジンに表示しない")).querySelector("input").click()); await flush();
    await act(async () => [...page.querySelectorAll("label.e-check")].find((node) => node.textContent.includes("組織")).querySelector("input").click()); await flush();
    assert.ok(!page.textContent.includes("検索結果での見え方"), "検索結果の見本は出さない");
    assert.equal(inputIn(page, "説明文").value, "海のそばの暮らしを 紹介します。");
    await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].document.meta, { description: "海のそばの暮らしを 紹介します。", ogImage: { src: "/cover.jpg", alt: "海の写真" }, noindex: true, structuredData: ["organization"] });
    await click("元に戻す"); assert.equal(button("下書き保存").disabled, false);
    assert.equal([...page.querySelectorAll("label.e-check")].find((node) => node.textContent.includes("組織")).querySelector("input").checked, false);
  } finally { await app.cleanup(); }
});

test("unsupported structured data stays visible and can be removed", async () => {
  const doc = { ...structuredClone(fixture), meta: { structuredData: ["event"] } };
  const host = pageHost(), app = await setup({ document: doc, adapter: host.adapter });
  try {
    const page = await panel("ページ"); assert.ok(page.textContent.includes("未対応: event"));
    await press(page.querySelector('[aria-label="event を外す"]'));
    await click("下書き保存"); assert.equal("meta" in app.calls.saves[0].document, false);
  } finally { await app.cleanup(); }
});

test("renaming a page validates input, reviews impact, applies the exact plan and reloads", async () => {
  const host = pageHost(), app = await setup({ adapter: host.adapter });
  try {
    const trigger = document.querySelector('[aria-label="私たちについて の操作"]');
    await press(trigger);
    const menuItem = document.querySelector('[role="menuitem"]');
    assert.equal(await shortcut(menuItem, "Escape"), true);
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, trigger);
    await press(trigger);
    assert.ok(document.querySelector('[role="menu"]')); await press(button("名前とURLを変更"));
    assert.equal(inputIn(dialog(), "ページ名").value, "私たちについて"); assert.equal(inputIn(dialog(), "URL パス").value, "/about");
    assert.equal(buttonIn(dialog(), "影響を確認").disabled, true);
    await change(inputIn(dialog(), "URL パス"), "/About");
    assert.match(dialog().querySelector('[role="alert"]').textContent, /半角英小文字/); assert.equal(buttonIn(dialog(), "影響を確認").disabled, true);
    await change(inputIn(dialog(), "URL パス"), "/experiences/kayak");
    assert.match(dialog().querySelector('[role="alert"]').textContent, /テンプレート「体験詳細」/);
    assert.equal(host.calls.prepares.length, 0);
    await change(inputIn(dialog(), "URL パス"), "/company"); assert.equal(dialog().querySelector('[role="alert"]'), null);
    await press(buttonIn(dialog(), "影響を確認"));
    assert.deepEqual(host.calls.prepares[0], { action: "update", target: { siteId: "demo", pageId: "about", locale: "ja-JP" }, title: "私たちについて", path: "/company" });
    const text = dialog().textContent;
    for (const expected of ["https://example.test", "https://example.test/about", "https://example.test/company", "ホーム · 2 件", "ヘッダー", "sitemap の URL が変わります。"]) assert.ok(text.includes(expected), expected);
    assert.equal(buttonIn(dialog(), "変更を反映").disabled, true);
    await act(async () => dialog().querySelector('input[type="checkbox"]').click());
    const lists = host.calls.lists; await press(buttonIn(dialog(), "変更を反映"));
    assert.equal(host.calls.applies.length, 1);
    assert.deepEqual(host.calls.applies[0], { change: host.calls.prepares[0], confirmationToken: "page-token", domain: "https://example.test", impact: { before: "https://example.test/about", after: "https://example.test/company",
      redirect: { from: "https://example.test/about", to: "https://example.test/company" }, linkedFrom: [{ pageId: "home", locale: "ja-JP", title: "ホーム", count: 2 }], navigation: ["ヘッダー"], notes: ["sitemap の URL が変わります。"] } });
    assert.equal(dialog(), null); assert.equal(host.calls.lists, lists + 1);
    assert.ok(document.body.textContent.includes("ページ名とURLを変更しました。"));
    assert.deepEqual(app.calls.reads.at(-1), { siteId: "demo", pageId: "about", locale: "ja-JP" });
    assert.ok(pageRow("私たちについて").textContent.includes("/company")); assert.equal(pageRow("私たちについて").getAttribute("aria-current"), "page");
  } finally { await app.cleanup(); }
});

test("page edits stay disabled while the page list reloads after an applied change", async () => {
  const host = pageHost(), listPages = host.adapter.listPages;
  let waitForList = false, releaseList;
  const listGate = new Promise((resolve) => { releaseList = resolve; });
  host.adapter.listPages = async (...args) => {
    if (waitForList) { waitForList = false; await listGate; }
    return listPages(...args);
  };
  const app = await setup({ adapter: host.adapter });
  try {
    await press(document.querySelector('[aria-label="私たちについて の操作"]'));
    await press(button("名前とURLを変更"));
    await change(inputIn(dialog(), "URL パス"), "/company");
    await press(buttonIn(dialog(), "影響を確認"));
    await act(async () => dialog().querySelector('input[type="checkbox"]').click());
    waitForList = true;
    await press(buttonIn(dialog(), "変更を反映"));
    assert.equal(dialog(), null);
    assert.equal(input("ページタイトル").disabled, true);
    assert.equal(button("要素を追加").disabled, true);
    await act(async () => releaseList()); await flush();
    assert.equal(input("ページタイトル").disabled, false);
  } finally { releaseList(); await app.cleanup(); }
});

test("page change conflicts keep inputs and reload the list; unknown results are not retried", async () => {
  let mode = "conflict";
  const host = pageHost({ apply: async () => { if (mode === "throw") throw new Error("offline"); return { status: "conflict" }; } }), app = await setup({ adapter: host.adapter });
  try {
    await press(document.querySelector('[aria-label="私たちについて の操作"]')); await press(button("複製"));
    assert.equal(inputIn(dialog(), "ページ名").value, "私たちについて のコピー"); assert.equal(inputIn(dialog(), "URL パス").value, "/about-copy");
    await change(inputIn(dialog(), "URL パス"), "/company");
    await press(buttonIn(dialog(), "影響を確認")); await act(async () => dialog().querySelector('input[type="checkbox"]').click());
    const lists = host.calls.lists; await press(buttonIn(dialog(), "変更を反映"));
    assert.ok(dialog()); assert.match(dialog().textContent, /競合しました（409）/);
    assert.equal(inputIn(dialog(), "URL パス").value, "/company"); assert.equal(inputIn(dialog(), "ページ名").value, "私たちについて のコピー"); assert.equal(host.calls.lists, lists + 1);
    mode = "throw"; await press(buttonIn(dialog(), "影響を確認")); await act(async () => dialog().querySelector('input[type="checkbox"]').click());
    await press(buttonIn(dialog(), "変更を反映"));
    assert.match(dialog().textContent, /反映されたか確認できません/); assert.equal(buttonIn(dialog(), "変更を反映"), undefined);
    const reads = app.calls.reads.length; await press(buttonIn(dialog(), "ページ一覧を再読込"));
    assert.equal(dialog(), null); assert.equal(app.calls.reads.length, reads + 1); assert.equal(host.calls.applies.length, 2);
  } finally { await app.cleanup(); }
});

test("page management prepare conflicts reload the catalog before another review", async () => {
  let conflict = true;
  const host = pageHost({ prepare: (change) => {
    if (conflict) { const error = new Error("version conflict"); error.status = 409; throw error; }
    return { change, confirmationToken: "page-token", domain: "https://example.test", impact: { linkedFrom: [], navigation: [], notes: [] } };
  } });
  const app = await setup({ adapter: host.adapter });
  try {
    await press(document.querySelector('[aria-label="私たちについて の操作"]')); await press(button("名前とURLを変更"));
    await change(inputIn(dialog(), "URL パス"), "/company");
    const lists = host.calls.lists;
    await press(buttonIn(dialog(), "影響を確認")); await flush();
    assert.match(dialog().textContent, /競合しました（409）/);
    assert.match(dialog().textContent, /ページ一覧を再読込しました/u);
    assert.equal(host.calls.lists, lists + 1);
    assert.ok(buttonIn(dialog(), "影響を確認"), "the user can review again against the refreshed catalog");
    conflict = false;
    await press(buttonIn(dialog(), "影響を確認")); await flush();
    assert.ok(dialog().textContent.includes("変更の影響を確認"));
  } finally { await app.cleanup(); }
});

test("invalid plans and private changes use their own confirmation", async () => {
  let domain = "https://evil.example.test";
  const host = pageHost({ prepare: (change) => ({ change, confirmationToken: "t", domain, impact: { before: `${domain}/about`, linkedFrom: [{ pageId: "home", locale: "ja-JP", title: "ホーム", count: 1 }], navigation: [], notes: [] } }),
    apply: async (plan) => ({ status: "applied", page: { ...sitePages()[1], visibility: plan.change.visibility } }) });
  const app = await setup({ adapter: host.adapter });
  try {
    await press(document.querySelector('[aria-label="私たちについて の操作"]')); await press(button("非公開にする"));
    assert.ok(dialog().textContent.includes("公開中のURLは表示されなくなり")); await press(buttonIn(dialog(), "影響を確認"));
    assert.match(dialog().textContent, /影響を確認できませんでした/); assert.ok(buttonIn(dialog(), "影響を確認"));
    domain = "https://example.test"; await press(buttonIn(dialog(), "影響を確認"));
    assert.ok(dialog().textContent.includes("公開サイトに表示されなくなります")); assert.ok(dialog().textContent.includes("ホーム · 1 件"));
    const confirm = [...dialog().querySelectorAll("button")].find((node) => node.textContent === "非公開にする");
    assert.ok(confirm.className.includes("e-danger-primary")); assert.equal(confirm.disabled, true);
    await act(async () => dialog().querySelector('input[type="checkbox"]').click()); await press(confirm);
    assert.deepEqual(host.calls.applies[0].change, { action: "visibility", target: { siteId: "demo", pageId: "about", locale: "ja-JP" }, visibility: "private" });
    assert.ok(document.body.textContent.includes("ページを非公開にしました。"));
  } finally { await app.cleanup(); }
});

test("page operations wait for unsaved edits and the page tab switch opens the visibility dialog", async () => {
  const host = pageHost(), app = await setup({ adapter: host.adapter });
  try {
    const page = await panel("ページ"), toggle = page.querySelector('[role="switch"]');
    assert.equal(toggle.getAttribute("aria-checked"), "false");
    await change(input("ページタイトル"), "未保存のタイトル");
    assert.equal(document.querySelector('[aria-label="ページを追加"]').disabled, true); assert.equal(toggle.disabled, true);
    assert.equal(document.querySelector('[aria-label="私たちについて の操作"]').disabled, true);
    assert.ok(!document.body.textContent.includes("未保存の変更を保存してから操作できます。")); assert.equal(toggle.title, "保存してから変更できます");
    await click("下書き保存"); assert.equal(toggle.disabled, false);
    await press(toggle); assert.equal(dialog().getAttribute("aria-label"), "ページを非公開にする");
    await act(async () => dialog().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))); await flush();
    assert.equal(dialog(), null);
    await press(document.querySelector('[aria-label="ページを追加"]'));
    assert.equal(inputIn(dialog(), "URL パス").value, "/new-page"); assert.equal(buttonIn(dialog(), "影響を確認").disabled, true);
    await change(inputIn(dialog(), "ページ名"), "新しいページ"); assert.equal(buttonIn(dialog(), "影響を確認").disabled, false);
    await press(buttonIn(dialog(), "影響を確認"));
    assert.deepEqual(host.calls.prepares[0], { action: "create", siteId: "demo", locale: "ja-JP", title: "新しいページ", path: "/new-page" });
  } finally { await app.cleanup(); }
  const legacy = await setup();
  try {
    assert.equal(document.querySelector('[aria-label="ページを追加"]'), null); assert.equal(document.querySelector('[role="switch"]'), null);
    assert.equal(document.querySelector('[aria-label="ホーム の操作"]'), null);
    assert.ok((await panel("サイト")).textContent.includes("このサイトではサイト設定を編集できません。"));
  } finally { await legacy.cleanup(); }
});

test("site settings load, save with the optimistic version, keep input on 409 and guard site switching", async () => {
  let mode = "normal";
  const host = pageHost({ saveSettings: (request) => mode === "conflict" ? { status: "conflict" } : mode === "throw" ? Promise.reject(new Error("offline")) : { status: "saved", version: `s-${request.expectedVersion}-next` } });
  const app = await setup({ adapter: host.adapter });
  try {
    const site = await panel("サイト"); assert.equal(document.querySelector(".e-page-settings"), null);
    assert.ok(site.textContent.includes("https://example.test"));
    assert.equal(inputIn(site, "サイトタイトル").value, "デモサイト"); assert.equal(buttonIn(site, "サイト設定を保存").disabled, true);
    await change(inputIn(site, "言語"), "Japanese");
    assert.match(site.querySelector('[role="alert"]').textContent, /ja や ja-JP/); assert.equal(buttonIn(site, "サイト設定を保存").disabled, true);
    await change(inputIn(site, "言語"), "ja-JP"); await change(inputIn(site, "サイトタイトル"), "新しいサイト名");
    await press(buttonIn(site, "サイト設定を保存"));
    assert.deepEqual(host.calls.settingsSaves[0], { siteId: "demo", settings: { title: "新しいサイト名", description: "サイトの説明", locale: "ja-JP" }, expectedVersion: "s1" });
    assert.ok(site.textContent.includes("サイト設定を保存しました。")); assert.equal(buttonIn(site, "サイト設定を保存").disabled, true);
    mode = "conflict"; await change(inputIn(site, "説明文"), "競合する説明"); await press(buttonIn(site, "サイト設定を保存"));
    assert.equal(host.calls.settingsSaves[1].expectedVersion, "s-s1-next");
    assert.ok(site.textContent.includes("サイト設定が競合しました（409）。入力を保持しています。")); assert.equal(inputIn(site, "説明文").value, "競合する説明");
    mode = "throw"; await press(buttonIn(site, "サイト設定を保存"));
    assert.ok(site.textContent.includes("サイト設定を保存できませんでした。入力を保持しています。")); assert.equal(inputIn(site, "説明文").value, "競合する説明");
    await change(document.querySelector('[aria-label="編集するサイト"]'), "second");
    assert.ok(dialog()); await click("編集を続ける"); assert.equal(inputIn(site, "説明文").value, "競合する説明");
    mode = "conflict"; await press(buttonIn(site, "サイト設定を保存"));
    host.setSettings({ title: "他の人の変更", locale: "ja" });
    const reads = host.calls.settingsReads; await press(buttonIn(site, "最新の設定を読み込む（入力を破棄）"));
    assert.equal(host.calls.settingsReads, reads + 1); assert.equal(inputIn(site, "サイトタイトル").value, "他の人の変更"); assert.equal(inputIn(site, "説明文").value, "");
    await change(document.querySelector('[aria-label="編集するサイト"]'), "second"); assert.equal(dialog(), null);
  } finally { await app.cleanup(); }
});

test("site settings load failures can be retried", async () => {
  let fail = true;
  const host = pageHost(), read = host.adapter.readSiteSettings;
  host.adapter.readSiteSettings = async (...args) => { if (fail) throw new Error("offline"); return read(...args); };
  const app = await setup({ adapter: host.adapter });
  try {
    const site = await panel("サイト"); assert.ok(site.textContent.includes("サイト設定を読み込めませんでした。"));
    assert.ok(document.querySelector("iframe").contentDocument.body.textContent.includes("海のそばで過ごす"));
    assert.ok(document.body.textContent.includes("文書単体で編集を開始しました"));
    fail = false; await press(buttonIn(site, "再試行")); assert.equal(inputIn(site, "サイトタイトル").value, "デモサイト");
  } finally { await app.cleanup(); }
});

test("an invalid reload keeps the current session when site settings also fail", async () => {
  let invalid = false;
  const app = await setup({ adapter: {
    readDocument: async (target) => ({ document: invalid ? { ...structuredClone(fixture), siteId: target.siteId, pageId: target.pageId, body: [{ type: "element", id: "duplicate", tag: "div", children: [] }, { type: "element", id: "duplicate", tag: "div", children: [] }] } : { ...structuredClone(fixture), siteId: target.siteId, pageId: target.pageId }, version: "v1" }),
    readSiteSettings: async () => { throw new Error("offline"); }
  } });
  try {
    assert.ok(document.querySelector("iframe").contentDocument.body.textContent.includes("海のそばで過ごす"));
    invalid = true; await clickPage("別ページ"); await settle();
    assert.ok(document.body.textContent.includes("現在の編集内容は保持されています"));
    assert.ok(document.querySelector("iframe").contentDocument.body.textContent.includes("海のそばで過ごす"));
  } finally { await app.cleanup(); }
});

test("release confirmation shows the public URL and the search result information", async () => {
  const doc = { ...structuredClone(fixture), meta: { description: "公開する説明文" } };
  const host = pageHost(), app = await setup({ document: doc, adapter: host.adapter });
  try {
    await click("公開");
    const text = dialog().textContent;
    for (const expected of ["公開URL", "https://example.test/", "検索結果に出る情報", fixture.title, "公開する説明文", "表示する", "現在の見出し"]) assert.ok(text.includes(expected), expected);
  } finally { await app.cleanup(); }
});
