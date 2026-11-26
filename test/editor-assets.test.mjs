import * as helpers from "./editor-ui-support.mjs";
const { assert, readFileSync, findLayer, JSDOM, createMemoryPageOperationHost, createPageEditingApi, createPageEditingApiClient, editDocumentById, createBlankEmbedRegistry, pageScope, parsePageDocument, editorShortcuts, dom, createElement, act, createRoot, PageEditor, createMemoryAssetLibrary, renderPageToHtml, parseResolvedAssets, uniqueAssetReferences, fixture, flush, button, input, click, layerById, clickLayer, editorTab, reloadEditor, pageRow, clickPage, change, setup, sitePages, pageHost, dialog, panel, inputIn, buttonIn, press, treeShape, mountedAssetPanel, assetPanel, tool, assetCard, settle, chooseAsset, uploadFiles, clickCanvas, canvasNode, canvasBody, layerButton, shortcut, commandDialog, canvasOrder, dragEvent, pointer, png, imageTypes, garden, withImage, night, coverFrame, coverRemove, caps, yoga, wave, sourceLibrary, spy, sourceTabs, cardNames, assetButton, createBrowserRecoveryStore, RecoveryTooLargeError, status, toolbarButton, homeTarget, localTime, memoryStorage, recoveryKey, historyHost, versionRows, historyButton, pageOperationsAdapter, test, wait } = helpers;

test("a ready MP4 can replace a native video without storing its resolved URL", async () => {
  const clip = { id: "intro", name: "紹介.mp4", mimeType: "video/mp4", bytes: 4096, alt: "", src: "/media/intro.mp4" };
  const library = createMemoryAssetLibrary({ siteId: "demo", seed: [garden, clip] });
  const doc = structuredClone(fixture); doc.body.push({ type: "element", id: "movie", tag: "video", attrs: { src: "/old.mp4", "aria-label": "紹介動画", controls: true }, children: [] });
  const app = await setup({ document: doc, assets: library });
  try {
    await clickCanvas("movie"); assert.deepEqual([...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].map((tab) => tab.textContent), ["動画", "ボックス", "変形", "設定"]);
    await click("動画を置き換え"); await settle();
    assert.equal(assetPanel().querySelector("h2").textContent, "動画を選ぶ"); assert.equal(assetCard("庭の緑.png"), undefined); assert.ok(assetCard("紹介.mp4"));
    await chooseAsset("紹介.mp4"); await settle();
    const edited = app.calls.saves.length ? app.calls.saves.at(-1).document : null;
    assert.equal(input("動画 URL").value, ""); assert.ok(canvasNode("movie").getAttribute("src").endsWith("/media/intro.mp4"));
    await click("下書き保存");
    const saved = app.calls.saves.at(-1).document.body.find((node) => node.id === "movie");
    assert.deepEqual(saved.asset, { provider: "uploads", id: "intro" }); assert.equal(saved.attrs.src, undefined); assert.equal(edited, null);
    await reloadEditor(); await settle(); assert.ok(canvasNode("movie").getAttribute("src").endsWith("/media/intro.mp4"));
  } finally { await app.cleanup(); }
});

test("layer tree keeps ID selection through sibling edits and clears only a removed target", async () => {
  const app = await setup();
  try {
    await tool("レイヤー"); await clickLayer("heading");
    const destinations = [...input("移動先").options].map((option) => ({ value: option.value, text: option.textContent }));
    assert.deepEqual(destinations.slice(0, 2), [
      { value: "", text: "ページ直下" },
      { value: "hero", text: "セクション" },
    ]);
    assert.equal(destinations.some(({ text }) => text.includes("hero") || text.includes("heading")), false);
    await click("下へ"); assert.equal(document.querySelector('[data-node-id="heading"] button.e-layer').getAttribute("aria-selected"), "true");
    await click("元に戻す"); assert.equal(document.querySelector('[data-node-id="heading"] button.e-layer').getAttribute("aria-selected"), "true");
    await click("複製"); assert.equal(document.querySelector('[data-node-id="heading"] button.e-layer').getAttribute("aria-selected"), "true");
    await click("削除"); assert.equal(document.querySelector('[data-node-id="heading"]'), null); assert.equal(document.querySelector(".e-layer-root").getAttribute("aria-pressed"), "true");
    assert.deepEqual([...document.querySelectorAll('[role="treeitem"]')].filter((item) => item.tabIndex === 0), [document.querySelector(".e-layer-root")]);
    await click("元に戻す"); assert.ok(document.querySelector('[data-node-id="heading"]')); assert.equal(document.querySelector(".e-layer-root").getAttribute("aria-pressed"), "true");
  } finally { await app.cleanup(); }
});

test("layer tree collapse uses roving focus and canvas selection reopens ancestors", async () => {
  const app = await setup();
  try {
    await tool("レイヤー"); await clickLayer("heading");
    const toggle = document.querySelector('[data-node-id="hero"] .e-layer-toggle');
    await act(async () => toggle.click()); await settle();
    assert.equal(document.querySelector('[data-node-id="heading"]'), null);
    assert.equal(document.querySelector('[data-node-id="hero"] button.e-layer').tabIndex, 0);
    assert.equal([...document.querySelectorAll('[role="treeitem"]')].filter((item) => item.tabIndex === 0).length, 1);
    await clickCanvas("heading");
    assert.equal(document.querySelector('[data-node-id="hero"] button.e-layer').getAttribute("aria-expanded"), "true");
    assert.equal(document.querySelector('[data-node-id="heading"] button.e-layer').getAttribute("aria-selected"), "true");
    const heading = document.querySelector('[data-node-id="heading"] button.e-layer');
    heading.focus(); await act(async () => heading.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))); await settle();
    assert.equal(document.activeElement, document.querySelector('[data-node-id="hero"] button.e-layer'));
  } finally { await app.cleanup(); }
});

test("failed asset preview resolution can be retried", async () => {
  const library = createMemoryAssetLibrary({ siteId: "demo", seed: [garden] });
  let attempts = 0;
  const assets = { ...library, resolveAssets: async (request, signal) => {
    attempts++;
    if (attempts === 1) throw new Error("temporary failure");
    return library.resolveAssets(request, signal);
  } };
  const app = await setup({ document: withImage({ asset: { provider: "uploads", id: "garden" }, attrs: { alt: "庭" } }), assets });
  try {
    await settle();
    assert.equal(attempts, 1);
    assert.ok(button("アセットを再読み込み"));
    await click("アセットを再読み込み");
    await settle();
    assert.equal(attempts, 2);
    assert.equal(button("アセットを再読み込み"), undefined);
    assert.ok(canvasNode("photo")?.getAttribute("src")?.includes("/media/garden.png"));
    await clickCanvas("photo"); await editorTab("画像"); assert.equal(input("レスポンシブ画像 URL"), undefined);
  } finally { await app.cleanup(); }
});

test("asset resolution revalidates on new references and before release, not when opening the library", async () => {
  const extra = { ...garden, id: "extra", name: "別の庭.png", src: "/media/extra.png", thumbnailUrl: "/media/extra.png" };
  const library = createMemoryAssetLibrary({ siteId: "demo", seed: [garden, extra] });
  const resolutions = [];
  const assets = { ...library, resolveAssets: async (request, signal) => { resolutions.push(request.references); return library.resolveAssets(request, signal); } };
  const app = await setup({ document: withImage({ asset: { provider: "uploads", id: "garden" }, attrs: { alt: "庭" } }), assets });
  try {
    await settle(); assert.equal(resolutions.length, 1);
    await tool("アセット"); await settle(); assert.equal(resolutions.length, 1);
    await chooseAsset("別の庭.png"); await click("ページに追加"); await settle();
    assert.equal(resolutions.length, 2);
    assert.deepEqual(resolutions.at(-1), [{ provider: "uploads", id: "extra" }]);
    await click("下書き保存"); await settle();
    await click("公開"); await settle();
    assert.equal(resolutions.length, 3, "公開内容の確認前に参照済み素材を再検証する");
    assert.deepEqual(resolutions.at(-1).map(({ id }) => id).sort(), ["extra", "garden"]);
    await click("編集に戻る");
  } finally { await app.cleanup(); }
});

test("changing the asset adapter does not retain the previous session's resolved image", async () => {
  const first = createMemoryAssetLibrary({ siteId: "demo", seed: [garden] });
  const second = createMemoryAssetLibrary({ siteId: "demo", seed: [{ ...garden, src: "/media/new-garden.png" }] });
  const app = await setup({ document: withImage({ asset: { provider: "uploads", id: "garden" }, attrs: { alt: "庭" } }), assets: first });
  try {
    await settle();
    assert.ok(canvasNode("photo")?.getAttribute("src")?.includes("/media/garden.png"));
    await act(async () => app.root.render(createElement(PageEditor, { adapter: app.adapter, assets: second })));
    await settle();
    assert.ok(canvasNode("photo")?.getAttribute("src")?.includes("/media/new-garden.png"));
  } finally { await app.cleanup(); }
});

test("staff upload an image, set its alt, replace a page image, save the draft and see it after reload", async () => {
  let app;
  const library = createMemoryAssetLibrary({
    siteId: "demo", seed: [garden, { id: "guide", name: "利用案内.pdf", mimeType: "application/pdf", bytes: 4096, src: "/media/guide.pdf" }],
    upload: { accept: imageTypes, maxBytes: 1024 * 1024 }, quota: { limitBytes: 10 * 1024 * 1024 },
    documents: () => app ? [{ pageId: "home", locale: "ja-JP", title: "ホーム", state: "draft", document: app.stored() }] : [],
    store: async (_file, meta) => ({ src: `/media/${meta.id}.png`, thumbnailUrl: `/media/${meta.id}.png`, width: 1200, height: 800 })
  });
  app = await setup({ document: withImage(), assets: library });
  try {
    assert.equal(assetPanel(), null, "閉じている間は AssetLibraryPanel をマウントしない");
    await tool("アセット"); assert.ok(assetPanel()); assert.equal(assetPanel().closest("[hidden]"), null);
    assert.ok(assetCard("庭の緑.png").getAttribute("aria-label").startsWith("庭の緑.png（画像・600×400・2 KB"));
    assert.ok(assetCard("利用案内.pdf").getAttribute("aria-label").startsWith("利用案内.pdf（PDF・4 KB"));
    assert.ok(assetPanel().textContent.includes("ストレージ使用量 6 KB / 10 MB"));
    await uploadFiles([png("海辺の朝.png", 1500)]);
    assert.ok(assetPanel().textContent.includes("海辺の朝.png: 追加しました。"));
    assert.equal(document.activeElement, input("代替テキスト"));
    await change(input("代替テキスト"), "朝の海辺"); await click("変更を保存");
    assert.ok(assetPanel().textContent.includes("保存しました。"));
    await click("一覧に戻る");
    const first = assetPanel().querySelector(".e-asset-card");
    assert.ok(first.getAttribute("aria-label").startsWith("海辺の朝.png（画像・1200×800")); assert.equal(document.activeElement, first);
    await tool("レイヤー"); await clickCanvas("photo"); await editorTab("画像");
    await click("画像を置き換え");
    assert.equal(assetPanel().closest("[hidden]"), null); assert.equal(assetPanel().querySelector("h2").textContent, "画像を選ぶ");
    assert.equal(await shortcut(assetPanel().querySelector("h2"), "Escape"), true);
    assert.equal(assetPanel(), null);
    await click("画像を置き換え");
    assert.equal(assetCard("利用案内.pdf"), undefined);
    await chooseAsset("海辺の朝.png");
    assert.ok(document.body.textContent.includes("画像を置き換えました。代替テキストを確認してください。"));
    assert.equal(canvasNode("photo").getAttribute("src"), "/media/asset-1.png"); assert.equal(canvasNode("photo").getAttribute("alt"), "朝の海辺");
    assert.equal(assetPanel(), null);
    await editorTab("画像"); assert.equal(input("画像の説明").value, "朝の海辺");
    await click("下書き保存");
    const saved = app.calls.saves[0].document.body[0].children.at(-1);
    assert.deepEqual(saved.asset, { provider: "uploads", id: "asset-1" }); assert.deepEqual(saved.attrs, { alt: "朝の海辺" });
    await reloadEditor();
    assert.equal(app.calls.reads.length, 2); assert.equal(canvasNode("photo").getAttribute("src"), "/media/asset-1.png");
  } finally { await app.cleanup(); }
});

test("staff choose the page social cover from the library, save it as an asset reference and see it after reload", async () => {
  let app;
  const terrace = { id: "terrace", name: "テラス.jpg", mimeType: "image/jpeg", bytes: 1024, width: 1200, height: 630, alt: "テラス", src: "/media/terrace.jpg", thumbnailUrl: "/media/terrace.jpg" };
  const host = pageHost(), library = createMemoryAssetLibrary({ siteId: "demo", seed: [garden, night, terrace], documents: () => app ? [{ pageId: "home", locale: "ja-JP", title: "ホーム", state: "draft", document: app.stored() }] : [] });
  app = await setup({ adapter: host.adapter, assets: library });
  try {
    let page = await panel("ページ");
    assert.equal(coverFrame(page).textContent, "画像は未設定です"); assert.equal(coverFrame(page).getAttribute("aria-label"), "画像を選ぶ"); assert.equal(coverRemove(page), undefined);
    assert.equal(inputIn(page, "画像 URL"), undefined, "素材を選べる画面では URL 入力を出さない"); assert.equal(inputIn(page, "画像の説明"), undefined);
    await press(coverFrame(page));
    assert.equal(assetPanel().closest("[hidden]"), null); assert.equal(assetPanel().querySelector("h2").textContent, "ソーシャルカバーを選ぶ");
    await chooseAsset("夜の海.avif");
    assert.equal(assetPanel().querySelector('[role="alert"]').textContent, "ソーシャルカバーに使えるのは JPEG・PNG・WebP・GIF の画像です。");
    assert.equal(app.stored().meta, undefined); assert.equal(button("下書き保存").disabled, true);
    await chooseAsset("庭の緑.png");
    assert.ok(document.body.textContent.includes("ソーシャルカバーを設定しました。"));
    assert.equal(assetPanel(), null);
    page = await panel("ページ");
    assert.equal(coverFrame(page).querySelector("img").getAttribute("src"), "/media/garden.png");
    assert.equal(coverFrame(page).getAttribute("aria-label"), "画像を変更"); assert.ok(coverRemove(page));
    await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].document.meta, { ogImage: { asset: { provider: "uploads", id: "garden" }, alt: "庭の緑" } }, "画像の説明は素材の説明を使う");
    await reloadEditor();
    page = await panel("ページ");
    assert.equal(coverFrame(page).querySelector("img").getAttribute("src"), "/media/garden.png");
    // ソーシャルカバーで使っているアセットは削除できず、使用箇所の置き換えでカバーも差し替わる（SNS で表示できない形式は拒否）。
    await tool("アセット"); await chooseAsset("庭の緑.png");
    assert.equal(button("削除…").disabled, true); assert.ok(assetPanel().textContent.includes("このページで使用中です。"));
    await click("このページの使用箇所を置き換え"); await chooseAsset("夜の海.avif");
    assert.equal(assetPanel().querySelector('[role="alert"]').textContent, "この画像はソーシャルカバーにも使われています。ソーシャルカバーに使えるのは JPEG・PNG・WebP・GIF の画像です。");
    await chooseAsset("テラス.jpg"); assert.ok(document.body.textContent.includes("このページの使用箇所を置き換えました。"));
    page = await panel("ページ");
    assert.equal(coverFrame(page).querySelector("img").getAttribute("src"), "/media/terrace.jpg");
    await press(coverRemove(page)); assert.equal(coverFrame(page).textContent, "画像は未設定です"); assert.equal(coverRemove(page), undefined);
    await click("下書き保存"); assert.equal(app.calls.saves[1].document.meta, undefined);
  } finally { await app.cleanup(); }
});

test("the site social cover is chosen from the library, saved with site settings and resolved after reload", async () => {
  const host = pageHost(), library = createMemoryAssetLibrary({ siteId: "demo", seed: [garden] });
  let app = await setup({ adapter: host.adapter, assets: library });
  try {
    const site = await panel("サイト");
    assert.equal(inputIn(site, "画像の説明"), undefined);
    await press(coverFrame(site));
    assert.equal(assetPanel().querySelector("h2").textContent, "ソーシャルカバーを選ぶ");
    await chooseAsset("庭の緑.png");
    assert.equal(assetPanel(), null); assert.equal(button("下書き保存").disabled, true);
    assert.equal(coverFrame(site).querySelector("img").getAttribute("src"), "/media/garden.png");
    await press(buttonIn(site, "サイト設定を保存"));
    assert.deepEqual(host.calls.settingsSaves[0].settings, { title: "デモサイト", description: "サイトの説明", ogImage: { asset: { provider: "uploads", id: "garden" }, alt: "庭の緑" }, locale: "ja" });
    const page = await panel("ページ"); assert.equal(coverFrame(page).textContent, "サイト共通の画像を使います");
  } finally { await app.cleanup(); }
  app = await setup({ adapter: host.adapter, assets: library });
  try {
    const site = await panel("サイト");
    assert.equal(coverFrame(site).querySelector("img").getAttribute("src"), "/media/garden.png");
    await press(coverRemove(site)); assert.equal(coverFrame(site).textContent, "画像は未設定です");
    await press(buttonIn(site, "サイト設定を保存"));
    assert.deepEqual(host.calls.settingsSaves[1].settings, { title: "デモサイト", description: "サイトの説明", locale: "ja" });
  } finally { await app.cleanup(); }
});

test("library images can be added inside the selected element and saved as its background", async () => {
  const app = await setup({ assets: createMemoryAssetLibrary({ siteId: "demo", seed: [garden] }) });
  try {
    await clickLayer("hero"); await tool("アセット"); await chooseAsset("庭の緑.png");
    await click("ページに追加");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "画像");
    assert.ok(document.querySelector('[data-node-id="node_1"]'));
    assert.equal(canvasNode("node_1").parentElement.getAttribute("data-nw-node"), "hero");
    assert.equal(canvasNode("node_1").getAttribute("src"), "/media/garden.png"); assert.equal(canvasNode("node_1").getAttribute("width"), "600");
    await tool("レイヤー"); await clickLayer("hero"); assert.equal(document.querySelector('[aria-label="インスペクタ"] [role="tab"][aria-selected="true"]').textContent, "ボックス"); await click("背景画像を選ぶ");
    assert.equal(assetPanel().querySelector("h2").textContent, "背景画像を選ぶ");
    await chooseAsset("庭の緑.png");
    await change(input("背景のサイズ"), "cover");
    await click("下書き保存");
    const hero = app.calls.saves[0].document.body[0];
    assert.deepEqual(hero.style.base.backgroundImage, { asset: { provider: "uploads", id: "garden" } }); assert.equal(hero.style.base.backgroundSize, "cover");
    assert.deepEqual(hero.children.at(-1), { type: "element", id: "node_1", tag: "img", asset: { provider: "uploads", id: "garden" }, attrs: { alt: "庭の緑" }, style: { base: { maxWidth: "100%", height: "auto" } }, children: [] });
    await click("背景画像を外す");
  } finally { await app.cleanup(); }
});

test("uploads explain rejected formats, sizes, quota, scans and permissions, and cross-site listings fail closed", async () => {
  let mode = "host";
  const library = createMemoryAssetLibrary({ siteId: "demo", seed: [{ id: "existing", name: "既存.png", mimeType: "image/png", bytes: 1000, src: "/media/existing.png" }], upload: { accept: ["image/png"], maxBytes: 1000 }, quota: { limitBytes: 1500 } });
  const guarded = { ...library, uploadAsset: async (request, signal) => {
    if (mode === "scan") return { status: "rejected", reason: "scan" };
    if (mode === "forbidden") throw Object.assign(new Error("forbidden"), { status: 403 });
    return library.uploadAsset(request, signal);
  } };
  const app = await setup({ assets: guarded });
  try {
    await tool("アセット");
    await uploadFiles([new File(["%PDF"], "案内.pdf", { type: "application/pdf" }), png("大きい.png", 2000), png("中くらい.png", 600)]);
    const text = () => assetPanel().querySelector(".e-asset-uploads").textContent;
    assert.ok(text().includes("案内.pdf: この形式はアップロードできません。アップロードできる形式: PNG"));
    assert.ok(text().includes("大きい.png: ファイルが大きすぎます（上限 1000 B）。"));
    assert.ok(text().includes("中くらい.png: 容量の上限を超えるためアップロードできません。"));
    mode = "scan"; await uploadFiles([png("検査.png", 10)]); assert.ok(text().includes("検査.png: 安全性の確認で受け付けられませんでした。"));
    mode = "forbidden"; await uploadFiles([png("権限.png", 10)]); assert.ok(text().includes("権限.png: アセットを追加する権限がありません。"));
    assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 1);
    await act(async () => assetPanel().querySelector('[aria-label="案内.pdf の通知を閉じる"]').click()); assert.ok(!text().includes("案内.pdf"));
  } finally { await app.cleanup(); }
  const foreign = { ...library, listAssets: async (query, signal) => { const result = await library.listAssets(query, signal); return { ...result, assets: [...result.assets, { ...result.assets[0], id: "foreign", siteId: "other" }] }; } };
  const crossSite = await setup({ assets: foreign });
  try {
    await tool("アセット");
    assert.ok(assetPanel().textContent.includes("アセットを読み込めませんでした。")); assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 0);
  } finally { await crossSite.cleanup(); }
  const readOnly = await setup({ assets: createMemoryAssetLibrary({ siteId: "demo", seed: [garden] }) });
  try {
    await tool("アセット");
    assert.equal(button("アップロード"), undefined); assert.ok(assetPanel().textContent.includes("このサイトにアセットを追加する権限がありません。"));
  } finally { await readOnly.cleanup(); }
});

test("assets used on this page or other pages cannot be deleted; unused assets are deleted after confirmation", async () => {
  const other = withImage({ asset: { provider: "uploads", id: "elsewhere" }, attrs: { alt: "" } }); other.pageId = "about";
  const image = (id, name) => ({ id, name, mimeType: "image/png", bytes: 1024, src: `/media/${id}.png` });
  let hideUsages = false;
  const library = createMemoryAssetLibrary({ siteId: "demo", seed: [image("here", "使用中.png"), image("spare", "未使用.png"), image("trash", "削除する.png"), image("elsewhere", "他ページ.png")],
    documents: () => [{ pageId: "about", locale: "ja-JP", title: "紹介", state: "published", document: other }] });
  const app = await setup({ document: withImage({ asset: { provider: "uploads", id: "here" }, attrs: { alt: "ここ" } }), assets: { ...library, listAssetUsages: async (request, signal) => hideUsages ? [] : library.listAssetUsages(request, signal) } });
  try {
    assert.equal(canvasNode("photo").getAttribute("src"), "/media/here.png");
    await tool("アセット");
    assert.ok(assetCard("使用中.png").getAttribute("aria-label").endsWith("・使用中）")); assert.ok(assetCard("他ページ.png").getAttribute("aria-label").endsWith("・使用中）"));
    await chooseAsset("使用中.png");
    assert.equal(button("削除…").disabled, true);
    assert.ok(assetPanel().textContent.includes("このページ: 1 か所")); assert.ok(assetPanel().textContent.includes("このページで使用中です。先に別の画像へ置き換えてください。"));
    await click("このページの使用箇所を置き換え");
    assert.equal(assetPanel().querySelector("h2").textContent, "置き換える画像を選ぶ");
    await chooseAsset("未使用.png");
    assert.equal(canvasNode("photo").getAttribute("src"), "/media/spare.png"); assert.ok(document.body.textContent.includes("このページの使用箇所を置き換えました。"));
    await chooseAsset("未使用.png"); assert.ok(assetPanel().textContent.includes("このページ: 1 か所"));
    await click("一覧に戻る"); await chooseAsset("削除する.png");
    await click("削除…"); assert.ok(assetPanel().textContent.includes("「削除する.png」を削除します。元に戻せません。"));
    await click("削除する"); assert.equal(assetCard("削除する.png"), undefined);
    await chooseAsset("他ページ.png");
    assert.equal(button("削除…").disabled, true); assert.ok(assetPanel().textContent.includes("紹介（ja-JP）・公開中"));
    assert.ok(assetPanel().textContent.includes("公開中または下書きのページで使用中のため削除できません。"));
    hideUsages = true; await click("使用状況を再確認"); assert.equal(button("削除…").disabled, false);
    await click("削除…"); await click("削除する");
    assert.ok(assetCard("他ページ.png") === undefined && assetPanel().textContent.includes("公開中または下書きのページで使用中のため削除できません。"));
    assert.ok(assetPanel().textContent.includes("紹介（ja-JP）・公開中"));
  } finally { await app.cleanup(); }
});

test("without an asset adapter the editor keeps the URL image fields and shows no library", async () => {
  const app = await setup({ document: withImage() });
  try {
    assert.equal(document.querySelector('.e-tools button[aria-label="アセット"]'), null); assert.equal(assetPanel(), null);
    await clickCanvas("photo"); await editorTab("画像");
    assert.equal(input("画像 URL").value, "/photo.webp"); assert.equal(button("画像を置き換え"), undefined); assert.equal(button("背景画像を選ぶ"), undefined);
    await change(input("画像 URL"), "/other.webp");
    // 文書は root-relative のまま保存し、キャンバスの iframe（Studio の origin）ではサイトの公開 origin で解決して表示する。
    assert.equal(canvasNode("photo").getAttribute("src"), "https://example.test/other.webp");
  } finally { await app.cleanup(); }
});

test("image URL locks disable responsive replacement and keep alt editable", async () => {
  for (const field of ["attrs.src", "attrs.srcSet", "asset"]) {
    const app = await setup({ document: withImage({ attrs: { src: "/photo.webp", srcSet: "/large.webp", alt: "Sea" } }), locks: [{ nodeId: "photo", fields: [field], reason: "業務画像" }] });
    try {
      await clickCanvas("photo"); await editorTab("画像");
      assert.equal(input("画像 URL").disabled, true);
      assert.equal(input("レスポンシブ画像 URL").disabled, true);
      assert.equal(input("画像の説明").disabled, false);
      assert.equal(button("下書き保存").disabled, true);
    } finally { await app.cleanup(); }
  }
});

test("upload, stock and connect tools scope their libraries while the image picker keeps all sources", async () => {
  const { adapter } = spy(sourceLibrary());
  const app = await setup({ document: withImage(), assets: adapter });
  try {
    assert.deepEqual([...document.querySelectorAll(".e-tools button")].filter((node) => !node.classList.contains("e-panel-toggle")).map((node) => node.title), ["追加", "ページ", "レイヤー", "スタイル", "アップロード", "ストック", "接続", "コンポーネント", "コンテンツ編集"]);
    await tool("アップロード");
    assert.deepEqual(sourceTabs().map((node) => node.getAttribute("aria-label") ?? node.textContent), ["サイト"]);
    assert.deepEqual(cardNames(), ["庭の緑.png"]); assert.ok(button("アップロード"));
    await tool("接続");
    assert.deepEqual(sourceTabs().map((node) => node.getAttribute("aria-label") ?? node.textContent), ["体験写真"]);
    assert.deepEqual(cardNames(), ["朝ヨガ.png"]);
    await tool("レイヤー"); await clickCanvas("photo"); await editorTab("画像"); await click("画像を置き換え");
    assert.equal(assetPanel().querySelector("h2").textContent, "画像を選ぶ");
    assert.deepEqual(sourceTabs().map((node) => node.getAttribute("aria-label") ?? node.textContent), ["すべて", "サイト", "体験写真", "ストック（未接続）"]);
    await click("体験写真");
    await chooseAsset("朝ヨガ.png");
    assert.equal(canvasNode("photo").getAttribute("src"), "/cms/yoga.png"); assert.equal(canvasNode("photo").getAttribute("alt"), "海辺で朝ヨガ");
    await click("下書き保存");
    const saved = app.calls.saves[0].document;
    assert.deepEqual(saved.body[0].children.at(-1).asset, { provider: "experience", id: "yoga" }); assert.ok(!JSON.stringify(saved).includes("/cms/"));
  } finally { await app.cleanup(); }
});

test("asset panel reads only while open and reuses cached provider and list scopes", async () => {
  const library = sourceLibrary({ stock: true });
  let providerReads = 0;
  const { calls, adapter } = spy({ ...library, listProviders: async (...args) => { providerReads++; return library.listProviders(...args); } });
  const app = await setup({ document: withImage(), assets: adapter });
  try {
    assert.equal(assetPanel(), null);
    assert.equal(providerReads, 0);
    assert.equal(calls.lists.length, 0);

    await tool("アップロード"); await settle();
    assert.equal(providerReads, 1);
    assert.equal(calls.lists.length, 1);
    const afterUpload = calls.lists.length;

    await tool("ストック"); await settle();
    assert.equal(calls.lists.length, afterUpload + 1);
    await tool("アップロード"); await settle();
    assert.equal(calls.lists.length, afterUpload + 1, "同じ範囲へ戻ったときは一覧を再取得しない");
    assert.deepEqual(cardNames(), ["庭の緑.png"]);
    assert.equal(providerReads, 1, "非表示化して再表示しても出所一覧は一度だけ取得する");

    await tool("レイヤー");
    assert.equal(assetPanel(), null, "別パネルを表示している間は素材パネルを隠す");
    assert.ok(mountedAssetPanel(), "初回表示後はアップロード状態を保つため素材パネルをマウントしたままにする");
    await tool("アップロード"); await settle();
    assert.equal(calls.lists.length, afterUpload + 1, "素材パネルを再度開いてもキャッシュ済み範囲を使う");
    assert.equal(providerReads, 1);
    assert.deepEqual(cardNames(), ["庭の緑.png"]);
  } finally { await app.cleanup(); }
});

test("processing assets are fetched again when the asset panel is reopened", async () => {
  const library = sourceLibrary(); let reads = 0;
  const { adapter } = spy({ ...library, listAssets: async (query, signal) => {
    reads++;
    const result = await library.listAssets(query, signal);
    return reads === 1 ? { ...result, assets: result.assets.map((asset) => ({ ...asset, status: "processing" })) } : result;
  } });
  const app = await setup({ document: withImage(), assets: adapter });
  try {
    await tool("アップロード"); await settle();
    assert.equal(reads, 1);
    await tool("レイヤー"); await tool("アップロード"); await settle();
    assert.equal(reads, 2, "処理中の一覧はキャッシュせず再取得する");
    assert.deepEqual(cardNames(), ["庭の緑.png"]);
  } finally { await app.cleanup(); }
});

test("upload keeps running while the asset panel is hidden", async () => {
  const library = sourceLibrary(); let resolveUpload; let uploadSignal;
  const adapter = { ...library, uploadAsset: (request, signal) => new Promise((resolve) => {
    uploadSignal = signal;
    resolveUpload = async () => resolve(await library.uploadAsset(request, signal));
  }) };
  const app = await setup({ document: withImage(), assets: adapter });
  try {
    await tool("アップロード"); await settle();
    await uploadFiles([png("継続.png", 10)]);
    assert.ok(resolveUpload);
    await tool("レイヤー");
    assert.equal(uploadSignal.aborted, false, "パネル切り替えで進行中のアップロードを中断しない");
    await act(async () => resolveUpload()); await settle();
    assert.equal(uploadSignal.aborted, false);
    await tool("アップロード"); await settle();
    assert.ok(assetCard("継続.png"));
  } finally { await app.cleanup(); }
});

test("provider scopes clear hidden folder filters and wait for the matching source", async () => {
  const { calls, adapter } = spy(sourceLibrary({ stock: true }));
  const app = await setup({ document: withImage(), assets: adapter });
  try {
    await tool("アップロード"); await settle();
    await change(assetPanel().querySelector('select[aria-label="フォルダ"]'), "photos");
    assert.equal(calls.lists.at(-1).folderId, "photos");

    let before = calls.lists.length;
    await tool("ストック"); await settle();
    assert.equal(calls.lists.slice(before).some((query) => query.provider === "uploads"), false);
    assert.equal(calls.lists.at(-1).provider, "stock"); assert.equal(calls.lists.at(-1).folderId, null);
    assert.equal(assetPanel().querySelector('select[aria-label="フォルダ"]'), null); assert.deepEqual(cardNames(), ["波.png"]);

    before = calls.lists.length;
    await tool("接続"); await settle();
    assert.equal(calls.lists.slice(before).some((query) => query.provider === "stock"), false);
    assert.equal(calls.lists.at(-1).provider, "experience"); assert.equal(calls.lists.at(-1).folderId, null);
    assert.equal(assetPanel().querySelector('select[aria-label="フォルダ"]'), null); assert.deepEqual(cardNames(), ["朝ヨガ.png"]);

    await tool("レイヤー"); await clickCanvas("photo"); await editorTab("画像"); await click("画像を置き換え"); await settle();
    assert.equal(Object.hasOwn(calls.lists.at(-1), "provider"), false); assert.equal(calls.lists.at(-1).folderId, null);
    assert.deepEqual(sourceTabs().map((node) => node.getAttribute("aria-label") ?? node.textContent), ["すべて", "サイト", "体験写真", "ストック"]);
    assert.deepEqual(cardNames(), ["庭の緑.png", "朝ヨガ.png", "波.png"]);
  } finally { await app.cleanup(); }
});

test("CMS photos show their origin and terms read-only, without save, upload, folders or delete", async () => {
  const { calls, adapter } = spy(sourceLibrary());
  const app = await setup({ assets: adapter });
  try {
    await tool("接続"); await chooseAsset("朝ヨガ.png");
    assert.equal(input("名前").readOnly, true); assert.equal(input("代替テキスト").readOnly, true); assert.equal(input("保存先フォルダ"), undefined);
    assert.equal(button("変更を保存"), undefined); assert.equal(button("削除…"), undefined); assert.ok(button("ページに追加"));
    const text = assetPanel().textContent;
    for (const expected of ["出所体験写真NIHO の体験原稿で公開を許可された写真体験「鎌倉の朝ヨガ」の写真", "利用条件体験の公開中だけ表示されます。写真の差し替え・非公開は体験原稿で行います。",
      "「体験写真」で管理しています", "「体験写真」のアセットはここでは削除できません。", "このページ: 0 か所"]) assert.ok(text.includes(expected), expected);
    await click("一覧に戻る"); await tool("アップロード"); await chooseAsset("庭の緑.png");
    assert.equal(input("名前").readOnly, false); assert.ok(button("変更を保存")); assert.ok(button("削除…")); assert.ok(input("保存先フォルダ"));
    await click("一覧に戻る"); const beforeConnect = calls.lists.length; await tool("接続");
    assert.equal(calls.lists.length, beforeConnect, "接続タブへ戻ると取得済みの一覧を使う"); assert.deepEqual(cardNames(), ["朝ヨガ.png"]);
    assert.ok(!assetPanel().textContent.includes("NIHO の体験原稿で公開を許可された写真"), "一覧の上に出所の説明文を出さない");
    assert.equal(assetButton("アップロード"), undefined); assert.equal(button("フォルダを追加"), undefined); assert.equal(assetPanel().querySelector('select[aria-label="フォルダ"]'), null);
    assert.ok(!assetPanel().textContent.includes("このサイトにアセットを追加する権限がありません。"));
    await tool("アップロード"); assert.ok(assetButton("アップロード")); assert.ok(assetPanel().querySelector('select[aria-label="フォルダ"]')); assert.deepEqual(cardNames(), ["庭の緑.png"]);
  } finally { await app.cleanup(); }
});

test("an unconnected stock source explains why without requesting a listing", async () => {
  const { calls, adapter } = spy(sourceLibrary()), errors = [], original = console.error;
  console.error = (...args) => { errors.push(args); };
  const app = await setup({ assets: adapter });
  try {
    await tool("ストック"); const before = calls.lists.length;
    assert.equal(sourceTabs().length, 1); assert.equal(sourceTabs()[0].getAttribute("aria-pressed"), "true");
    assert.ok(assetPanel().textContent.includes("ストックアセットはまだ接続されていません。")); assert.ok(assetPanel().textContent.includes("ライセンス確認済みのストック素材"));
    assert.equal(calls.lists.length, before); assert.ok(calls.lists.every((query) => query.provider !== "stock"));
    assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 0); assert.equal(assetPanel().querySelector('[role="alert"]'), null); assert.equal(assetButton("アップロード"), undefined);
    await tool("アップロード"); assert.deepEqual(cardNames(), ["庭の緑.png"]);
    assert.deepEqual(errors, []);
  } finally { console.error = original; await app.cleanup(); }
});

test("connected stock shows its license and is acquired into site uploads before placement", async () => {
  const { calls, adapter } = spy(sourceLibrary({ stock: true }));
  const app = await setup({ assets: adapter });
  try {
    await tool("ストック");
    assert.equal(calls.lists.at(-1).provider, "stock");
    assert.ok(assetCard("波.png").getAttribute("aria-label").endsWith("・ライセンスあり）")); assert.ok(assetCard("波.png").querySelector(".e-asset-badges").textContent.includes("ライセンス"));
    await chooseAsset("波.png");
    const link = [...assetPanel().querySelectorAll("a")].find((node) => node.textContent === "ライセンスを確認");
    assert.equal(link.getAttribute("href"), "https://license.example.test/terms"); assert.equal(link.getAttribute("target"), "_blank"); assert.equal(link.getAttribute("rel"), "noopener noreferrer");
    for (const expected of ["出所ストックライセンス確認済みのストック素材", "ライセンステスト用ライセンス", "クレジット: 見本ストック", "テストの中だけで使えます。"]) assert.ok(assetPanel().textContent.includes(expected), expected);
    await click("ページに追加");
    assert.deepEqual(calls.acquires, [{ siteId: "demo", reference: { provider: "stock", id: "wave" }, expectedVersion: "1" }]);
    assert.ok(assetPanel().textContent.includes("ライセンス情報を記録して配置しました。"));
    assert.ok(assetPanel().textContent.includes("出所サイトこのサイトにアップロードした素材「ストック」から取り込んだ素材")); assert.ok(assetPanel().textContent.includes("ライセンステスト用ライセンス"));
    assert.equal(canvasNode("node_1").getAttribute("src"), "/stock/wave.png");
    await click("下書き保存");
    assert.deepEqual(app.calls.saves[0].document.body.at(-1).asset, { provider: "uploads", id: "asset-1" }); assert.ok(!JSON.stringify(app.calls.saves[0].document).includes('"stock"'));
    await click("一覧に戻る"); assert.deepEqual(cardNames(), ["波.png"]);
    await tool("アップロード"); assert.equal(calls.lists.at(-1).provider, "uploads");
    assert.deepEqual(cardNames(), ["波.png", "庭の緑.png"]); assert.ok(assetCard("波.png").getAttribute("aria-label").includes("・ライセンスあり"));
  } finally { await app.cleanup(); }
});

test("a removed provider leaves its open asset detail read-only and blocks placement", async () => {
  const library = sourceLibrary(); let removed = false;
  const adapter = { ...library, listProviders: async (request, signal) => {
    const providers = await library.listProviders(request, signal);
    return removed ? providers.filter((provider) => provider.id !== "experience") : providers;
  } };
  const app = await setup({ assets: adapter });
  try {
    await tool("接続"); await chooseAsset("朝ヨガ.png");
    removed = true;
    await clickPage("別ページ"); await settle();
    assert.equal(input("名前").readOnly, true);
    assert.equal(input("代替テキスト").readOnly, true);
    assert.equal(button("変更を保存"), undefined);
    assert.equal(button("削除…"), undefined);
    assert.equal(button("ページに追加").disabled, true);
    assert.ok(assetPanel().textContent.includes("出所が確認できないアセットは利用できません。"));
  } finally { await app.cleanup(); }
});

test("acquisition cannot place an asset returned from an unavailable provider", async () => {
  const library = sourceLibrary({ stock: true });
  const adapter = { ...library, listProviders: async (request, signal) => [
    ...await library.listProviders(request, signal),
    { id: "offline", kind: "stock", label: "未接続", origin: "未接続の出所", status: "unavailable", capabilities: caps() }
  ], acquireAsset: async (request, signal) => {
    const result = await library.acquireAsset(request, signal);
    return result.status === "ready" ? { ...result, asset: { ...result.asset, provider: "offline" } } : result;
  } };
  const app = await setup({ assets: adapter });
  try {
    await tool("ストック"); await chooseAsset("波.png");
    await click("ページに追加");
    assert.equal(canvasNode("node_1"), null);
    assert.ok(assetPanel().textContent.includes("この出所は現在利用できません。"));
  } finally { await app.cleanup(); }
});

test("photos unpublished in the CMS become placeholders after the editor reloads and are left out of public HTML", async () => {
  const library = sourceLibrary(), reference = { provider: "experience", id: "yoga" }, doc = withImage({ asset: reference, attrs: { alt: "海辺で朝ヨガ" } });
  const publicHtml = async () => renderPageToHtml(doc, {}, { assets: parseResolvedAssets(await library.resolveAssets({ siteId: "demo", references: uniqueAssetReferences(parsePageDocument(doc)) }, new AbortController().signal)) });
  const app = await setup({ document: doc, assets: library });
  try {
    assert.equal(canvasNode("photo").getAttribute("src"), "/cms/yoga.png"); assert.ok((await publicHtml()).includes('src="/cms/yoga.png"'));
    library.setPublished(reference, false);
    // エディター内の再読込で解決をやり直し、非公開になった写真をプレビューから外す。
    await reloadEditor(); await settle();
    assert.equal(canvasNode("photo").hasAttribute("data-nw-missing-asset"), true); assert.equal(canvasNode("photo").getAttribute("src"), null);
    await clickCanvas("photo"); await editorTab("画像"); assert.ok(document.querySelector('[aria-label="インスペクタ"]').textContent.includes("画像を表示できません"));
    const html = await publicHtml(); assert.ok(!html.includes("/cms/yoga.png")); assert.ok(!html.includes('data-nw-node="photo"'));
    await tool("接続"); assert.equal(!!assetCard("朝ヨガ.png"), false);
  } finally { await app.cleanup(); }
});

test("source listing failures and assets from undeclared or other sources fail closed", async () => {
  let failing = true, mode = "ok";
  const library = sourceLibrary(), lists = [], uploads = [];
  const adapter = { ...library,
    listProviders: async (request, signal) => { if (failing) throw new Error("offline"); return library.listProviders(request, signal); },
    listAssets: async (query, signal) => {
      lists.push(query); const result = await library.listAssets(query, signal);
      if (mode === "unknown") return { ...result, assets: [...result.assets, { ...result.assets[0], provider: "other", id: "x" }] };
      if (mode === "mixed" && query.provider === "uploads") return { ...result, assets: [...result.assets, ...(await library.listAssets({ ...query, provider: "experience" }, signal)).assets] };
      return result;
    },
    uploadAsset: async (request, signal) => {
      uploads.push(request.provider); const result = await library.uploadAsset(request, signal);
      return mode === "upload" && result.status === "uploaded" ? { ...result, asset: { ...result.asset, provider: "experience" } } : result;
    } };
  const app = await setup({ assets: adapter });
  try {
    await tool("アップロード");
    assert.ok(assetPanel().textContent.includes("アセットの出所を読み込めませんでした。")); assert.ok(button("再読み込み"));
    assert.equal(lists.length, 0); assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 0); assert.equal(assetPanel().querySelector('input[type="search"]'), null);
    failing = false; await click("再読み込み"); assert.deepEqual(sourceTabs().map((node) => node.textContent), ["サイト"]); assert.deepEqual(cardNames(), ["庭の緑.png"]);
    mode = "unknown"; await tool("接続");
    assert.ok(assetPanel().textContent.includes("アセットを読み込めませんでした。出所が確認できないアセットは利用できません。")); assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 0);
    mode = "mixed";
    const mixedAdapter = { ...adapter };
    await act(async () => app.root.render(createElement(PageEditor, { adapter: app.adapter, assets: mixedAdapter }))); await flush();
    await tool("アップロード");
    assert.ok(assetPanel().textContent.includes("出所が確認できないアセットは利用できません。")); assert.equal(assetPanel().querySelectorAll(".e-asset-card").length, 0);
    mode = "ok"; await click("再読み込み"); assert.deepEqual(cardNames(), ["庭の緑.png"]);
    mode = "upload"; await uploadFiles([png("混入.png", 10)]);
    assert.deepEqual(uploads, ["uploads"]);
    assert.ok(assetPanel().querySelector(".e-asset-uploads").textContent.includes("混入.png: 出所が確認できないアセットは利用できません。")); assert.deepEqual(cardNames(), ["庭の緑.png"]);
  } finally { await app.cleanup(); }
});

test("recently used assets are requested with recent, also while picking, and legacy adapters show no sources", async () => {
  let app;
  const { calls, adapter } = spy(sourceLibrary({ documents: () => app ? [{ pageId: "home", locale: "ja-JP", title: "ホーム", state: "draft", document: app.stored() }] : [] }));
  app = await setup({ document: withImage({ asset: { provider: "experience", id: "yoga" }, attrs: { alt: "朝ヨガ" } }), assets: adapter });
  try {
    await tool("接続"); assert.equal(button("最近使った").getAttribute("aria-pressed"), "false"); assert.equal("recent" in calls.lists.at(-1), false);
    await click("最近使った");
    assert.equal(button("最近使った").getAttribute("aria-pressed"), "true"); assert.equal(calls.lists.at(-1).recent, true); assert.deepEqual(cardNames(), ["朝ヨガ.png"]);
    await tool("レイヤー"); await clickCanvas("photo"); await editorTab("画像"); await click("画像を置き換え");
    assert.equal(button("最近使った").getAttribute("aria-pressed"), "true"); assert.equal(calls.lists.at(-1).recent, true); assert.equal(calls.lists.at(-1).kind, "image");
  } finally { await app.cleanup(); }
  const legacy = await setup({ assets: createMemoryAssetLibrary({ siteId: "demo", seed: [garden] }) });
  try { await tool("アセット"); assert.equal(button("最近使った"), undefined); assert.equal(document.querySelector('[aria-label="アセットの出所"]'), null); } finally { await legacy.cleanup(); }
});
