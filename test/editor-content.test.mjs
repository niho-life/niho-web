import * as helpers from "./editor-ui-support.mjs";
const { assert, readFileSync, findLayer, JSDOM, createMemoryPageOperationHost, createPageEditingApi, createPageEditingApiClient, editDocumentById, createBlankEmbedRegistry, pageScope, parsePageDocument, editorShortcuts, dom, createElement, act, createRoot, PageEditor, createMemoryAssetLibrary, renderPageToHtml, parseResolvedAssets, uniqueAssetReferences, fixture, flush, button, input, click, layerById, clickLayer, editorTab, reloadEditor, pageRow, clickPage, change, setup, sitePages, pageHost, dialog, panel, inputIn, buttonIn, press, treeShape, mountedAssetPanel, assetPanel, tool, assetCard, settle, chooseAsset, uploadFiles, clickCanvas, canvasNode, canvasBody, layerButton, shortcut, commandDialog, canvasOrder, dragEvent, pointer, png, imageTypes, garden, withImage, night, coverFrame, coverRemove, caps, yoga, wave, sourceLibrary, spy, sourceTabs, cardNames, assetButton, createBrowserRecoveryStore, RecoveryTooLargeError, status, toolbarButton, homeTarget, localTime, memoryStorage, recoveryKey, historyHost, versionRows, historyButton, pageOperationsAdapter, test, wait } = helpers;

test("editor shows the page list and accessible workspace controls", async () => {
  const app = await setup();
  try {
    assert.equal(document.querySelector('.e-tools button[title="ページ"]').getAttribute("aria-pressed"), "true");
    assert.equal(document.querySelector('[aria-label="ページ一覧"]').hidden, false);
    assert.equal(document.querySelector('[aria-label="要素を追加"]').hidden, true);
    assert.equal(document.querySelector('.e-tools button[title="アセット"]'), null);
    assert.ok(pageRow("ホーム")); assert.ok(document.querySelector('.e-canvas-tools input[aria-label="表示幅"]'));
    assert.equal(document.querySelector(".e-toolbar"), null); assert.ok(document.querySelector(".e-project-context")); assert.ok(document.querySelector(".e-inspector-actions"));
    const zoom = document.querySelector('.e-inspector-actions select[aria-label="表示倍率"]');
    assert.deepEqual([...zoom.options].map((option) => option.textContent), [zoom.options[0].textContent, "25%", "50%", "75%", "100%", "150%", "200%"]);
    assert.match(zoom.options[0].textContent, /^\d+%$/, "the closed select shows only the number, like STUDIO"); assert.equal(zoom.selectedOptions[0], zoom.options[0], "the fit scale is the first option");
    assert.deepEqual([...zoom.querySelectorAll("optgroup")].map((group) => group.label), ["全体表示", "倍率"], "fit is told apart from the fixed 50% by its group");
    await change(zoom, "0.5"); assert.equal(document.querySelector(".e-canvas-spacer").dataset.scale, "0.500");
    await click("左パネルを閉じる"); assert.equal(document.querySelector('[aria-label="サイト・ページ・レイヤー"]').hidden, false);
    await click("ページ"); assert.equal(document.querySelector('[aria-label="サイト・ページ・レイヤー"]').hidden, false);
    await click("右パネルを閉じる"); assert.equal(document.querySelector('[aria-label="インスペクタ"]').hidden, true);
    await click("右パネルを開く"); assert.equal(document.querySelector('[aria-label="インスペクタ"]').hidden, false);
  } finally { await app.cleanup(); }
});

test("three rails edit live text, color, size, position and viewport before draft save", async () => {
  const app = await setup();
  try {
    assert.ok(document.querySelector('[aria-label="サイト・ページ・レイヤー"]'));
    assert.ok(document.querySelector('[aria-label="インスペクタ"]'));
    const frame = document.querySelector("iframe");
    await act(async () => frame.contentDocument.querySelector("h1").dispatchEvent(new frame.contentWindow.MouseEvent("click", { bubbles: true, cancelable: true })));
    assert.deepEqual([...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].map((tab) => tab.textContent), ["テキスト", "ボックス", "変形", "設定"]);
    assert.equal(document.querySelector('.e-inspector-tabs [role="tab"][aria-selected="true"]').textContent, "テキスト");
    assert.equal(button("直し終える"), undefined);
    const textTab = document.querySelector('.e-inspector-tabs [role="tab"][aria-selected="true"]');
    await act(async () => textTab.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    await flush(); assert.equal(document.querySelector('.e-inspector-tabs [role="tab"][aria-selected="true"]').textContent, "ボックス");
    assert.equal(document.activeElement.textContent, "ボックス"); assert.ok(input("幅")); assert.equal(input("テキスト"), undefined);
    await editorTab("設定"); assert.ok(input("文字の種類"));
    await editorTab("テキスト");
    await change(input("テキスト"), "編集した見出し"); await change(input("文字色"), "#ff0000"); await change(input("文字サイズ"), "24");
    assert.ok(document.querySelector("iframe").contentDocument.body.textContent.includes("編集した見出し"));
    assert.equal(button("公開").disabled, true);
    await clickLayer("hero"); assert.deepEqual([...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].map((tab) => tab.textContent), ["ボックス", "変形", "設定"]);
    await editorTab("ボックス"); await change(input("配置の基準"), "absolute"); await change(input("上から"), "12");
    await change(document.querySelector('[aria-label="表示幅"]'), "375"); assert.equal(document.querySelector("iframe").style.width, "375px");
    await click("下書き保存"); assert.equal(app.calls.saves[0].expectedVersion, "v1"); assert.equal("trigger" in app.calls.saves[0], false);
    const saved = app.calls.saves[0].document; assert.equal(saved.body[0].children[0].children[0].text, "編集した見出し");
    assert.equal(saved.body[0].children[0].style.base.color, "#ff0000"); assert.equal(saved.body[0].children[0].style.base.fontSize, 24); assert.equal(saved.body[0].style.base.top, 12);
    assert.equal(saved.revision, 1); assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-scope]').getAttribute("data-nw-scope"), pageScope({ ...fixture, revision: 2 }));
    assert.equal(button("下書き保存").disabled, true);
  } finally { await app.cleanup(); }
});

test("Basic Icon and Video can be selected, edited, saved, reloaded and rendered", async () => {
  const app = await setup();
  const addPreset = async (id) => {
    await click("追加");
    const target = document.querySelector(`.e-preset-preview[data-preset="${id}"]`)?.closest("button");
    assert.ok(target, id); await act(async () => target.click()); await flush();
  };
  try {
    await click("追加");
    assert.deepEqual([...document.querySelectorAll(".e-add-category .e-preset-preview")].slice(0, 10).map((item) => item.dataset.preset), ["section", "box", "img", "text", "icon", "richtext", "video", "embed-blank", "embed-map", "embed-youtube"]);
    await addPreset("icon");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "アイコン");
    assert.deepEqual([...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].map((tab) => tab.textContent), ["アイコン", "文字", "ボックス", "変形"]);
    await change(input("アイコン"), "star"); await change(input("アクセシブルな名前"), "おすすめ");
    await editorTab("文字"); await change(input("文字サイズ"), "40"); await change(input("文字色"), "#123456");
    await click("下書き保存");
    assert.equal(app.stored().body.at(-1).icon, "star"); assert.equal(app.stored().body.at(-1).attrs["aria-label"], "おすすめ");
    await reloadEditor(); await clickLayer("node_1");
    assert.equal(input("アイコン").value, "star"); assert.equal(input("アクセシブルな名前").value, "おすすめ");

    await addPreset("video");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "動画");
    await change(input("動画 URL"), "https://media.example.test/intro.mp4");
    await change(input("動画の説明"), "施設の紹介動画"); await change(input("ポスター画像 URL"), "/poster.webp"); await change(input("先読み"), "none");
    const check = (caption) => [...document.querySelectorAll("label.e-check")].find((label) => label.textContent.includes(caption))?.querySelector("input");
    const controls = check("再生コントロールを表示"), loop = check("繰り返す");
    assert.equal(controls.checked, true); await act(async () => controls.click()); await act(async () => loop.click()); await flush();
    await click("下書き保存"); await reloadEditor(); await clickLayer("node_2");
    assert.equal(input("動画 URL").value, "https://media.example.test/intro.mp4"); assert.equal(input("動画の説明").value, "施設の紹介動画");
    assert.equal(check("再生コントロールを表示").checked, false); assert.equal(check("繰り返す").checked, true); assert.equal(input("先読み").value, "none");
    const html = renderPageToHtml(app.stored()), video = html.match(/<video[^>]*data-nw-node="node_2"[^>]*><\/video>/)?.[0];
    assert.ok(video.includes('src="https://media.example.test/intro.mp4"')); assert.ok(video.includes('aria-label="施設の紹介動画"'));
    assert.ok(video.includes('poster="/poster.webp"')); assert.ok(video.includes('loop=""')); assert.ok(!video.includes("controls=")); assert.ok(!video.includes("autoplay"));
  } finally { await app.cleanup(); }
});

test("VideoWithButton saves and reloads its closed tree, stays inert while editing and runs in preview", async () => {
  const app = await setup();
  try {
    await click("追加");
    const card = document.querySelector('.e-preset-preview[data-preset="video-with-button"]')?.closest("button");
    assert.ok(card); assert.equal(card.closest(".e-palette-group").querySelector("h3").textContent, "インタラクション");
    await act(async () => card.click()); await settle();
    let frame = document.querySelector("iframe"), rootElement = frame.contentDocument.querySelector("[data-nw-video-with-button]"), video = frame.contentDocument.querySelector("[data-nw-video]"), control = frame.contentDocument.querySelector("[data-nw-video-toggle]");
    assert.equal(video, null); assert.equal(control.disabled, true, "source未設定では外部要求も無効な操作も行わない");
    const rootId = rootElement.dataset.nwNode;
    const storedRoot = () => app.stored().body.find((node) => node.id === rootId);
    const videoId = rootElement.querySelector("[data-nw-missing-asset]").dataset.nwNode;
    await clickCanvas(videoId); await change(input("動画 URL"), "/intro.mp4"); await settle();
    frame = document.querySelector("iframe"); video = frame.contentDocument.querySelector("[data-nw-video]"); control = frame.contentDocument.querySelector("[data-nw-video-toggle]");
    let plays = 0; video.play = () => { plays++; return Promise.resolve(); };
    await act(async () => control.click()); await settle(); assert.equal(plays, 0, "edit canvas does not bind playback");
    await click("下書き保存");
    assert.deepEqual(storedRoot().interaction, { type: "video-toggle" }); assert.equal(storedRoot().children[0].attrs.src, "/intro.mp4");
    await reloadEditor(); await settle();
    assert.ok(document.querySelector("iframe").contentDocument.querySelector("[data-nw-video-with-button]"));
    await click("プレビュー"); await settle();
    frame = document.querySelector("iframe"); video = frame.contentDocument.querySelector("[data-nw-video]"); control = frame.contentDocument.querySelector("[data-nw-video-toggle]");
    let paused = true;
    Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
    Object.defineProperty(video, "ended", { configurable: true, get: () => false });
    video.play = () => { plays++; paused = false; video.dispatchEvent(new frame.contentWindow.Event("play")); return Promise.resolve(); };
    video.pause = () => { paused = true; video.dispatchEvent(new frame.contentWindow.Event("pause")); };
    await act(async () => control.click()); await settle();
    assert.equal(plays, 1); assert.equal(control.getAttribute("aria-label"), "動画を一時停止"); assert.equal(control.getAttribute("aria-pressed"), "true"); assert.equal(video.controls, true);
  } finally { await app.cleanup(); }
});

test("Loop Box palette and inspector save, reload and activate only in preview", async () => {
  const app = await setup();
  try {
    await click("追加");
    const card = document.querySelector('.e-preset-preview[data-preset="loop-box"]')?.closest("button");
    assert.ok(card); assert.equal(card.closest(".e-palette-group").querySelector("h3").textContent, "インタラクション");
    await act(async () => card.click()); await settle();
    assert.deepEqual([...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].map((tab) => tab.textContent), ["Loop Box", "ボックス", "変形"]);
    let frame = document.querySelector("iframe"), rootElement = frame.contentDocument.querySelector("[data-nw-loop-box-static]");
    assert.ok(rootElement); assert.equal(frame.contentDocument.querySelector("[data-nw-loop-box]"), null, "edit canvas stays inert");
    const rootId = rootElement.dataset.nwNode;
    await change(input("方向"), "column-reverse"); await change(input("速度（px/秒）"), "90");
    const pause = [...document.querySelectorAll("label.e-check")].find((label) => label.textContent.includes("ホバー中は一時停止"))?.querySelector("input");
    assert.equal(pause.checked, true); await act(async () => pause.click()); await settle();
    await click("下書き保存");
    let stored = app.stored().body.find((node) => node.id === rootId);
    assert.deepEqual(stored.interaction, { type: "loop-box", speed: 90, pauseOnHover: false }); assert.equal(stored.style.base.flexDirection, "column-reverse");
    await reloadEditor(); await clickLayer(rootId);
    assert.equal(input("方向").value, "column-reverse"); assert.equal(input("速度（px/秒）").value, "90");
    assert.equal([...document.querySelectorAll("label.e-check")].find((label) => label.textContent.includes("ホバー中は一時停止"))?.querySelector("input").checked, false);
    await click("プレビュー"); await settle();
    frame = document.querySelector("iframe"); assert.ok(frame.contentDocument.querySelector("[data-nw-loop-box]")); assert.equal(frame.contentDocument.querySelector("[data-nw-loop-box-static]"), null);
  } finally { await app.cleanup(); }
});

test("Basic の標準埋め込みはカード UI、URL 正規化、保存・再読込、プレビューを共有する", async () => {
  const xPostFrameUrl = "https://frame.example.test/widgets/x-post.html";
  const app = await setup({ props: { xPostFrameUrl } });
  const addPreset = async (id) => {
    await click("追加"); const target = document.querySelector(`.e-preset-preview[data-preset="${id}"]`)?.closest("button");
    assert.ok(target, id); await act(async () => target.click()); await flush();
  };
  try {
    await click("追加");
    const embedGroup = [...document.querySelectorAll(".e-palette-group")].find((group) => group.querySelector("h3")?.textContent === "埋め込み");
    assert.deepEqual([...embedGroup.querySelectorAll(".e-preset-card")].map((card) => card.querySelector(".e-preset-label").lastChild.textContent), ["Blank", "Map", "YouTube", "Vimeo", "Lottie", "Facebook", "X", "Instagram"]);
    await addPreset("embed-map");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "Map");
    assert.ok(document.querySelector("iframe").contentDocument.body.textContent.includes("Map の URL を設定してください"));
    await addPreset("embed-youtube");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "YouTube");
    assert.deepEqual([...document.querySelectorAll('.e-inspector-tabs [role="tab"]')].map((tab) => tab.textContent), ["埋め込み", "ボックス", "変形"]);
    const staticCanvas = document.querySelector("iframe");
    await change(input("埋め込み URL"), "https://youtube.com/shorts/dQw4w9WgXcQ");
    await change(input("アクセシブルなタイトル"), "施設紹介");
    assert.equal(input("埋め込み URL").value, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    assert.equal(document.querySelector("iframe").getAttribute("sandbox"), "allow-same-origin allow-scripts");
    assert.notEqual(document.querySelector("iframe"), staticCanvas, "sandbox flags take effect only after a frame navigation");
    assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-embed="youtube"] iframe').style.pointerEvents, "none");
    const trustedCanvas = document.querySelector("iframe");
    await change(input("埋め込み URL"), "");
    assert.notEqual(document.querySelector("iframe"), trustedCanvas);
    assert.equal(document.querySelector("iframe").getAttribute("sandbox"), "allow-same-origin");
    await change(input("埋め込み URL"), "https://youtube.com/shorts/dQw4w9WgXcQ");
    await addPreset("embed-vimeo");
    await addPreset("embed-lottie");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "Lottie");
    assert.ok(document.querySelector('[aria-label="インスペクタ"]').textContent.includes("lottie.host の Asset link"));
    assert.ok(document.querySelector("iframe").contentDocument.body.textContent.includes("Lottie の URL を設定してください"));
    await change(input("LottieFiles Asset link"), "https://lottie.host/123E4567-E89B-42D3-A456-426614174000/intro.json");
    await change(input("アクセシブルなタイトル"), "ローディングアニメーション");
    let canvas = document.querySelector("iframe"), lottieRoot = canvas.contentDocument.querySelector('[data-nw-embed="lottie"]');
    const lottieId = lottieRoot.dataset.nwNode;
    assert.equal(lottieRoot.dataset.nwLottieSource, "https://lottie.host/embed/123e4567-e89b-42d3-a456-426614174000/intro.json");
    assert.equal(lottieRoot.querySelector("iframe"), null, "edit canvas keeps the external player unloaded");
    await click("アニメーションを再生"); await settle();
    canvas = document.querySelector("iframe"); lottieRoot = canvas.contentDocument.querySelector('[data-nw-embed="lottie"]');
    assert.equal(lottieRoot.querySelector("iframe"), null, "the edit-mode motion replay also keeps Lottie static");
    await addPreset("embed-facebook");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "Facebook");
    assert.ok(document.querySelector('[aria-label="インスペクタ"]').textContent.includes("公開投稿の facebook.com URL"));
    await change(input("Facebook の投稿 URL"), "https://facebook.com/example.page/posts/123456789/");
    await change(input("アクセシブルなタイトル"), "Facebook のお知らせ");
    const facebookId = document.querySelector("iframe").contentDocument.querySelector('[data-nw-embed="facebook"]').dataset.nwNode;
    assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-facebook-link]').getAttribute("href"), "https://www.facebook.com/example.page/posts/123456789");
    assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-facebook-load]').hidden, true, "edit canvas keeps Facebook static");
    assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-embed="facebook"] iframe'), null);
    await addPreset("embed-x");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "X");
    assert.ok(document.querySelector('[aria-label="インスペクタ"]').textContent.includes("公開ポストの x.com URL"));
    await change(input("X のポスト URL"), "https://x.com/Example/status/1234567890123456789/");
    await change(input("アクセシブルなタイトル"), "X のお知らせ");
    const xRoot = document.querySelector("iframe").contentDocument.querySelector('[data-nw-embed="x"]'), xId = xRoot.dataset.nwNode;
    assert.equal(xRoot.dataset.nwSocialSource, "https://x.com/example/status/1234567890123456789"); assert.equal(xRoot.querySelector('[data-nw-social-load]').hidden, true); assert.equal(xRoot.querySelector("iframe"), null);
    await addPreset("embed-instagram");
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "Instagram");
    await change(input("Instagram の投稿・リール URL"), "https://instagram.com/reel/AbCdEf12345");
    await change(input("アクセシブルなタイトル"), "Instagram のお知らせ");
    const instagramRoot = document.querySelector("iframe").contentDocument.querySelector('[data-nw-embed="instagram"]'), instagramId = instagramRoot.dataset.nwNode;
    assert.equal(instagramRoot.dataset.nwSocialSource, "https://www.instagram.com/reel/AbCdEf12345/"); assert.equal(instagramRoot.querySelector('[data-nw-social-load]').hidden, true); assert.equal(instagramRoot.querySelector("iframe"), null);
    await click("下書き保存");
    assert.deepEqual(app.stored().body.slice(-7).map((node) => node.embed.provider), ["map", "youtube", "vimeo", "lottie", "facebook", "x", "instagram"]);
    assert.equal(app.stored().body.at(-6).embed.title, "施設紹介");
    assert.deepEqual(app.stored().body.at(-4).embed, { provider: "lottie", title: "ローディングアニメーション", source: "https://lottie.host/embed/123e4567-e89b-42d3-a456-426614174000/intro.json" });
    assert.deepEqual(app.stored().body.at(-3).embed, { provider: "facebook", title: "Facebook のお知らせ", source: "https://www.facebook.com/example.page/posts/123456789" });
    assert.deepEqual(app.stored().body.at(-2).embed, { provider: "x", title: "X のお知らせ", source: "https://x.com/example/status/1234567890123456789" });
    assert.deepEqual(app.stored().body.at(-1).embed, { provider: "instagram", title: "Instagram のお知らせ", source: "https://www.instagram.com/reel/AbCdEf12345/" });
    await reloadEditor(); await clickLayer("node_2");
    assert.equal(input("埋め込み URL").value, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
    assert.equal(input("アクセシブルなタイトル").value, "施設紹介");
    await clickLayer(lottieId); assert.equal(input("LottieFiles Asset link").value, "https://lottie.host/embed/123e4567-e89b-42d3-a456-426614174000/intro.json");
    await clickLayer(facebookId); assert.equal(input("Facebook の投稿 URL").value, "https://www.facebook.com/example.page/posts/123456789");
    await clickLayer(xId); assert.equal(input("X のポスト URL").value, "https://x.com/example/status/1234567890123456789");
    await clickLayer(instagramId); assert.equal(input("Instagram の投稿・リール URL").value, "https://www.instagram.com/reel/AbCdEf12345/");
    const html = renderPageToHtml(app.stored());
    assert.match(html, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/); assert.match(html, /title="施設紹介"/);
    assert.doesNotMatch(html, /<iframe[^>]+lottie\.host/); assert.match(html, /data-nw-lottie-source="https:\/\/lottie\.host\/embed\//);
    assert.doesNotMatch(html, /facebook\.com\/plugins\/post\.php/); assert.match(html, /href="https:\/\/www\.facebook\.com\/example\.page\/posts\/123456789"/);
    assert.doesNotMatch(html, /platform\.twitter\.com\/widgets\.js/); assert.doesNotMatch(html, /instagram\.com\/embed\.js/);
    assert.match(html, /href="https:\/\/x\.com\/example\/status\/1234567890123456789"/); assert.match(html, /href="https:\/\/www\.instagram\.com\/reel\/AbCdEf12345\/"/);
    await click("プレビュー"); await settle();
    canvas = document.querySelector("iframe"); lottieRoot = canvas.contentDocument.querySelector('[data-nw-embed="lottie"]');
    assert.equal(lottieRoot.querySelector("iframe")?.getAttribute("src"), "https://lottie.host/embed/123e4567-e89b-42d3-a456-426614174000/intro.json");
    const facebookRoot = canvas.contentDocument.querySelector('[data-nw-embed="facebook"]'), facebookButton = facebookRoot.querySelector('[data-nw-facebook-load]');
    assert.equal(facebookButton.hidden, false); assert.equal(facebookRoot.querySelector("iframe"), null);
    await act(async () => facebookButton.click()); await flush();
    assert.match(facebookRoot.querySelector("iframe").getAttribute("src"), /^https:\/\/www\.facebook\.com\/plugins\/post\.php\?href=/u);
    assert.equal(facebookRoot.querySelector("iframe").style.pointerEvents, "none");
    assert.ok(facebookRoot.querySelector('[data-nw-facebook-link]'));
    for (const provider of ["x", "instagram"]) {
      const socialRoot = canvas.contentDocument.querySelector(`[data-nw-embed="${provider}"]`), socialButton = socialRoot.querySelector('[data-nw-social-load]');
      assert.equal(socialButton.hidden, false); assert.equal(socialRoot.querySelector("iframe"), null);
      await act(async () => socialButton.click()); await flush();
      const frame = socialRoot.querySelector("iframe");
      if (provider === "x") {
        const frameUrl = new URL(frame.getAttribute("src"));
        assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin"); assert.equal(`${frameUrl.origin}${frameUrl.pathname}`, xPostFrameUrl); assert.deepEqual([...frameUrl.searchParams], [["url", "https://x.com/example/status/1234567890123456789"]]); assert.equal(frame.hasAttribute("srcdoc"), false);
      } else {
        assert.equal(frame.getAttribute("sandbox"), "allow-scripts"); assert.equal(frame.hasAttribute("src"), false); assert.ok(frame.getAttribute("srcdoc").includes("instagram.com/embed.js"));
      }
      assert.equal(frame.style.pointerEvents, "none"); assert.ok(socialRoot.querySelector('[data-nw-social-link]'));
    }
  } finally { await app.cleanup(); }
});

test("外部URLの新規追加はopt-inで、保存とTravel previewの制限権限を共有する", async () => {
  const blankEmbeds = createBlankEmbedRegistry({ parentOrigin: "https://editor.example.test", entries: [] });
  const app = await setup({ props: { enableUrlEmbeds: true, blankEmbeds } });
  const source = "https://travel.niho.life/embed/experiences/sea-kayak/book?locale=ja&campaign=kamakura";
  try {
    await click("追加");
    const card = document.querySelector('.e-preset-preview[data-preset="embed-url"]')?.closest("button");
    assert.ok(card); assert.match(card.textContent, /外部URL/u);
    await act(async () => card.click()); await flush();
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "外部URL");
    assert.match(document.querySelector("iframe").contentDocument.body.textContent, /外部URL の URL を設定/u);
    await change(input("公開HTTPS URL"), source);
    await change(input("アクセシブルなタイトル"), "NIHO Travel 予約");
    let canvas = document.querySelector("iframe"), root = canvas.contentDocument.querySelector('[data-nw-embed="url"]');
    assert.ok(root?.hasAttribute("data-nw-url-static")); assert.equal(root.querySelector("iframe"), null, "編集中は外部通信しない");
    await click("下書き保存");
    assert.deepEqual(app.stored().body.at(-1).embed, { provider: "url", title: "NIHO Travel 予約", source });
    assert.equal(app.stored().body.at(-1).style.base.width, "100%");
    assert.equal(app.stored().body.at(-1).style.base.height, 640);
    await click("プレビュー"); await settle();
    canvas = document.querySelector("iframe"); root = canvas.contentDocument.querySelector('[data-nw-embed="url"]');
    const frame = root.querySelector("iframe"), preview = new URL(frame.getAttribute("src"));
    assert.equal(preview.searchParams.get("locale"), "ja"); assert.equal(preview.searchParams.get("campaign"), "kamakura"); assert.equal(preview.searchParams.get("preview"), "1");
    assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin allow-forms");
    assert.equal(frame.getAttribute("referrerpolicy"), "origin"); assert.equal(frame.getAttribute("data-nw-url-embed-frame"), "");
    assert.equal(root.querySelector("[data-nw-url-fallback]").getAttribute("href"), preview.href);
  } finally { await app.cleanup(); }
});

test("Blank は承認済み key だけを選択し、未接続案内・保存・undo・preview を共有する", async () => {
  const disconnectedDocument = structuredClone(fixture);
  disconnectedDocument.body.push({ type: "element", id: "blank_existing", tag: "div", embed: { provider: "blank", title: "公開ガイド" }, children: [] });
  const disconnected = await setup({ document: disconnectedDocument });
  try {
    await click("追加");
    const card = document.querySelector('.e-preset-preview[data-preset="embed-blank"]').closest("button");
    assert.equal(card.disabled, true); assert.match(card.textContent, /未接続/u); assert.match(card.title, /接続されていません/u);
    const detailSelect = input("追加する要素"), blankOption = [...detailSelect.options].find((option) => option.value === "embed-blank");
    assert.equal(blankOption.disabled, true); assert.match(blankOption.textContent, /未接続/u);
    await change(detailSelect, "embed-blank");
    const addButton = button("要素を追加");
    assert.equal(addButton.disabled, true); assert.match(addButton.title, /接続されていません/u); assert.match(document.body.textContent, /追加できません/u);
    const blankCount = document.querySelector("iframe").contentDocument.querySelectorAll('[data-nw-embed="blank"]').length;
    const reactProps = Object.keys(addButton).find((key) => key.startsWith("__reactProps$"));
    assert.ok(reactProps, "中心 add handler");
    await act(async () => addButton[reactProps].onClick()); await flush();
    assert.match(document.querySelector('[role="alert"]').textContent, /追加できません/u);
    assert.equal(document.querySelector("iframe").contentDocument.querySelectorAll('[data-nw-embed="blank"]').length, blankCount, "中心の add 経路も未接続 Blank を拒否する");
    await clickLayer("blank_existing");
    assert.equal(input("承認済みの埋め込み").disabled, true);
    assert.match(document.querySelector('[aria-label="インスペクタ"]').textContent, /Blank 埋め込みが未接続です/u);
    assert.equal(input("アクセシブルなタイトル").disabled, false);
    await change(input("アクセシブルなタイトル"), "更新した公開ガイド");
    assert.equal(input("アクセシブルなタイトル").value, "更新した公開ガイド");
    await click("削除");
    assert.equal(document.querySelector("iframe").contentDocument.querySelector('[data-nw-node="blank_existing"]'), null);
    await click("元に戻す");
    assert.ok(document.querySelector("iframe").contentDocument.querySelector('[data-nw-node="blank_existing"]'));
  } finally { await disconnected.cleanup(); }

  const blankEmbeds = createBlankEmbedRegistry({ parentOrigin: "https://example.test", entries: [
    { key: "public-guide", label: "公開ガイド", src: "https://embed.example.test/public/guide", sandbox: "scripts" }
  ] });
  const app = await setup({ props: { blankEmbeds } });
  try {
    await click("追加");
    const card = document.querySelector('.e-preset-preview[data-preset="embed-blank"]').closest("button");
    assert.equal(card.disabled, false);
    await act(async () => card.click()); await flush();
    assert.equal(document.querySelector('[aria-label="インスペクタ"] .e-inspector-context strong').textContent, "Blank");
    assert.match(document.querySelector("iframe").contentDocument.body.textContent, /承認済みの埋め込みを選択/u);
    await change(input("承認済みの埋め込み"), "public-guide");
    await change(input("アクセシブルなタイトル"), "施設の公開ガイド");
    let canvas = document.querySelector("iframe"), root = canvas.contentDocument.querySelector('[data-nw-embed="blank"]');
    assert.ok(root); assert.equal(root.querySelector("iframe"), null, "edit canvas keeps Blank unloaded");
    assert.match(root.textContent, /公開ガイド（プレビューで表示）/u);
    await click("元に戻す");
    assert.equal(input("アクセシブルなタイトル").value, "埋め込みコンテンツ");
    await click("やり直す");
    assert.equal(input("アクセシブルなタイトル").value, "施設の公開ガイド");
    await click("下書き保存");
    assert.deepEqual(app.stored().body.at(-1).embed, { provider: "blank", title: "施設の公開ガイド", source: "public-guide" });
    await reloadEditor(); await clickLayer(app.stored().body.at(-1).id);
    assert.equal(input("承認済みの埋め込み").value, "public-guide");
    await click("プレビュー"); await settle();
    canvas = document.querySelector("iframe"); root = canvas.contentDocument.querySelector('[data-nw-embed="blank"]');
    assert.equal(root.querySelector("iframe").getAttribute("src"), "https://embed.example.test/public/guide");
    assert.equal(root.querySelector("iframe").getAttribute("sandbox"), "allow-scripts");
    assert.equal(root.querySelector('[data-nw-blank-fallback]').getAttribute("href"), "https://embed.example.test/public/guide");
  } finally { await app.cleanup(); }
});

test("canvas resize handle measures inline selections after layout without waiting for ResizeObserver", async () => {
  const previous = globalThis.ResizeObserver, observers = [];
  class TestResizeObserver {
    constructor(callback) { this.callback = callback; this.target = null; observers.push(this); }
    observe(target) { this.target = target; }
    disconnect() {}
    deliver() { this.callback([{ target: this.target }], this); }
  }
  let app;
  globalThis.ResizeObserver = TestResizeObserver;
  try {
    const doc = structuredClone(fixture);
    doc.body = [
      { type: "element", id: "block", tag: "div", children: [{ type: "text", text: "Block" }] },
      { type: "element", id: "inline_link", tag: "a", attrs: { href: "/about" }, children: [{ type: "text", text: "Inline link" }] }
    ];
    app = await setup({ document: doc });
    const frame = document.querySelector("iframe"), scheduled = [];
    frame.contentWindow.requestAnimationFrame = (callback) => { scheduled.push(callback); return scheduled.length; };
    frame.contentWindow.cancelAnimationFrame = () => {};
    const block = canvasNode("block"), inline = canvasNode("inline_link");
    let blockReads = 0, inlineReads = 0;
    block.getBoundingClientRect = () => { blockReads++; return { left: 1, top: 2, width: 120, height: 60 }; };
    inline.getBoundingClientRect = () => { inlineReads++; return { left: 3, top: 4, width: 44, height: 18 }; };

    await clickCanvas("block");
    assert.ok(observers.some((entry) => entry.target === block), "the selected block is observed");
    assert.equal(blockReads, 0, "the block is not measured synchronously");
    assert.equal(scheduled.length, 1, "initial geometry is scheduled after layout");
    await act(async () => scheduled.shift()(0));
    await settle();
    assert.equal(frame.contentDocument.querySelector(".nw-resize-handle")?.title, "120 × 60 px");

    await clickCanvas("inline_link");
    assert.ok(observers.some((entry) => entry.target === inline), "the inline element is observed");
    assert.equal(inlineReads, 0, "the inline element is not measured synchronously");
    assert.equal(scheduled.length, 1, "inline geometry is scheduled even without an observer notification");
    await act(async () => scheduled.shift()(0));
    await settle();
    assert.equal(frame.contentDocument.querySelector(".nw-resize-handle")?.title, "44 × 18 px", "the handle follows the current inline selection");
  } finally {
    if (app) await app.cleanup();
    if (previous === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = previous;
  }
});

test("canvas arrows reorder siblings in one history step while layer arrows move focus", async () => {
  const app = await setup();
  try {
    await tool("レイヤー"); await clickLayer("lead");
    assert.ok(await shortcut(layerButton("lead"), "ArrowUp"));
    assert.equal(document.activeElement, layerButton("heading"));
    assert.deepEqual(canvasOrder("hero"), ["heading", "lead", "link"]);
    assert.ok(await shortcut(canvasBody(), "ArrowUp"));
    assert.deepEqual(canvasOrder("hero"), ["lead", "heading", "link"]);
    assert.ok(await shortcut(canvasBody(), "z", { metaKey: true }));
    assert.deepEqual(canvasOrder("hero"), ["heading", "lead", "link"]);
    assert.equal(button("元に戻す").disabled, true);
    assert.ok(await shortcut(canvasBody(), "ArrowDown"));
    assert.deepEqual(canvasOrder("hero"), ["heading", "link", "lead"]);
    assert.ok(await shortcut(canvasBody(), "z", { metaKey: true }));
    assert.deepEqual(canvasOrder("hero"), ["heading", "lead", "link"]);
  } finally { await app.cleanup(); }
});

test("Alt-drag duplicates and moves to another parent in one undo step", async () => {
  const page = structuredClone(fixture);
  page.body.push({ id: "destination", type: "element", tag: "section", children: [] });
  const app = await setup({ document: page });
  try {
    await clickCanvas("heading");
    const transfer = { setData() {} }, destination = canvasNode("destination");
    destination.getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 100, width: 100, height: 100 });
    await dragEvent(canvasNode("heading"), "dragstart", transfer, { altKey: true });
    await dragEvent(destination, "dragover", transfer, { clientY: 50 });
    assert.equal(transfer.dropEffect, "copy");
    assert.equal(canvasNode("heading_copy1"), null);
    await dragEvent(destination, "drop", transfer, { clientY: 50 });
    assert.deepEqual(canvasOrder("hero"), ["heading", "lead", "link"]);
    assert.deepEqual(canvasOrder("destination"), ["heading_copy1"]);
    await click("元に戻す");
    assert.deepEqual(canvasOrder("destination"), []);
    assert.deepEqual(canvasOrder("hero"), ["heading", "lead", "link"]);
    assert.equal(button("元に戻す").disabled, true);
    await click("やり直す");
    assert.deepEqual(canvasOrder("destination"), ["heading_copy1"]);
  } finally { await app.cleanup(); }
});

test("spacing handles preview without history and commit only to the selected breakpoint", async () => {
  const app = await setup();
  try {
    await clickCanvas("hero"); await editorTab("ボックス"); await click("タブレット 768px〜");
    const canvas = canvasBody(), handle = (property) => canvas.querySelector(`[data-spacing="${property}"]`);
    const hero = canvasNode("hero"), originalStyle = hero.getAttribute("style");
    assert.ok(handle("paddingTop")); assert.ok(handle("gap"));
    await pointer(handle("paddingTop"), "pointerdown", 20);
    await pointer(handle("paddingTop"), "pointermove", 42);
    const preview = Number.parseFloat(hero.style.paddingTop);
    assert.ok(preview > 0);
    assert.equal(button("元に戻す").disabled, true);
    await pointer(handle("paddingTop"), "pointercancel", 42);
    assert.equal(hero.getAttribute("style"), originalStyle);
    await pointer(handle("paddingTop"), "pointerdown", 20);
    await pointer(handle("paddingTop"), "pointermove", 42);
    await pointer(handle("paddingTop"), "pointerup", 42);
    await click("下書き保存");
    const lastStyle = () => app.calls.saves.at(-1).document.body[0].style;
    assert.equal(lastStyle().base.paddingTop, undefined);
    assert.equal(lastStyle().responsive.find((entry) => entry.minWidth === 768).declarations.paddingTop, preview);
    await click("元に戻す");
    assert.equal(button("元に戻す").disabled, true);
    await pointer(handle("gap"), "pointerdown", 20);
    await pointer(handle("gap"), "pointermove", 30);
    await pointer(handle("gap"), "pointerup", 30);
    await click("下書き保存");
    assert.equal(lastStyle().base.gap, 16);
    const tablet = lastStyle().responsive.find((entry) => entry.minWidth === 768).declarations;
    assert.equal(tablet.gap, 26);
    assert.equal(tablet.paddingTop, undefined);
    await click("元に戻す");
    assert.equal(button("元に戻す").disabled, true);
  } finally { await app.cleanup(); }
});

test("spacing handles hide percent-based gaps instead of treating percentages as pixels", async () => {
  const page = structuredClone(fixture);
  page.body[0].style = { ...page.body[0].style, base: { ...page.body[0].style.base, display: "flex", gap: "10%" } };
  const app = await setup({ document: page });
  try {
    await clickCanvas("hero"); await editorTab("ボックス");
    const hero = canvasNode("hero"), computed = hero.ownerDocument.defaultView.getComputedStyle(hero);
    assert.equal(computed.gap, "var(--nw-Node-hero-base-gap)");
    assert.equal(hero.style.getPropertyValue("--nw-Node-hero-base-gap"), "10%");
    assert.equal(canvasBody().querySelector('[data-spacing="gap"]'), null);
  } finally { await app.cleanup(); }
});

test("spacing handles hide breakpoint properties protected by a specific style lock", async () => {
  const app = await setup({ locks: [{ nodeId: "hero", fields: ["style.responsive.paddingTop"], reason: "Tablet padding is host-managed" }] });
  try {
    await clickCanvas("hero"); await editorTab("ボックス"); await click("タブレット 768px〜");
    const canvas = canvasBody();
    assert.equal(canvas.querySelector('[data-spacing="paddingTop"]'), null);
    assert.ok(canvas.querySelector('[data-spacing="paddingRight"]'));
  } finally { await app.cleanup(); }
});

test("command palette searches layer names, full text and commands and guards unsaved navigation", async () => {
  const page = structuredClone(fixture);
  page.body[0].children[0].name = "メインタイトル";
  const app = await setup({ document: page });
  try {
    const search = () => commandDialog().querySelector('input[type="search"]');
    assert.ok(await shortcut(canvasBody(), "k", { metaKey: true }));
    assert.equal(document.activeElement, search());
    await change(search(), "メインタイトル");
    assert.ok(await shortcut(search(), "Enter"));
    assert.equal(commandDialog(), null);
    await click("コマンドパレット");
    await change(search(), "海のそばで過ごす");
    assert.match(commandDialog().querySelector('[aria-label="要素"]').textContent, /メインタイトル/u);
    assert.ok(await shortcut(search(), "Enter"));
    await click("コマンドパレット"); await change(search(), "複製");
    assert.match(commandDialog().querySelector("kbd").textContent, /⌘D/u);
    assert.ok(await shortcut(search(), "Enter"));
    assert.ok(canvasNode("heading_copy1"));
    await click("コマンドパレット"); await change(search(), "別ページ");
    assert.ok(await shortcut(search(), "Enter"));
    assert.ok(document.querySelector('[role="dialog"][aria-label="未保存の変更"]'));
    assert.equal(app.calls.reads.length, 1);
    await click("変更を破棄して移動");
    assert.equal(app.calls.reads.at(-1).pageId, "other");
  } finally { await app.cleanup(); }
});

test("locked and read-only values reject direct manipulation and palette edits", async () => {
  const cases = [{ locks: [{ nodeId: "hero", fields: ["*"], reason: "ホスト管理" }] }, { readOnly: { reason: "読み取り専用ページ" } }];
  for (const options of cases) {
    const app = await setup(options);
    try {
      await clickCanvas("lead");
      assert.equal(await shortcut(canvasBody(), "ArrowUp"), false);
      assert.deepEqual(canvasOrder("hero"), ["heading", "lead", "link"]);
      assert.equal(canvasBody().querySelector(".nw-spacing-handle"), null);
      const transfer = { setData() {} };
      await dragEvent(canvasNode("lead"), "dragstart", transfer, { altKey: true });
      await dragEvent(canvasNode("link"), "drop", transfer, { altKey: true });
      assert.equal(canvasNode("lead_copy1"), null);
      await click("コマンドパレット");
      const remove = [...commandDialog().querySelectorAll('section[aria-label="操作"] button')].find((item) => item.textContent.startsWith("削除"));
      assert.equal(remove.disabled, true);
      assert.ok(commandDialog().querySelector('section[aria-label="ページ"] button'));
      assert.equal(button("元に戻す").disabled, true);
    } finally { await app.cleanup(); }
  }
});

test("shortcut matrix shares structure and history across parent, iframe and layer focus", async () => {
  const app = await setup();
  try {
    await tool("レイヤー");
    const positions = [
      { name: "parent", target: () => document.body, command: { metaKey: true }, remove: "Delete" },
      { name: "iframe", target: canvasBody, command: { ctrlKey: true }, remove: "Backspace" },
      { name: "layer", target: () => layerButton("heading"), command: { metaKey: true }, remove: "Delete" },
    ];
    for (const { name, target, command, remove } of positions) {
      await clickLayer("heading");
      assert.ok(await shortcut(target(), "d", command), name);
      assert.ok(canvasNode("heading_copy1"), name);
      assert.ok(await shortcut(target(), "z", command), name);
      assert.equal(canvasNode("heading_copy1"), null, name);
      assert.equal(button("元に戻す").disabled, true, name);
      assert.ok(await shortcut(target(), "Z", { ...command, shiftKey: true }), name);
      assert.ok(canvasNode("heading_copy1"), name);
      assert.ok(await shortcut(target(), "z", command), name);
      assert.ok(await shortcut(target(), remove), name);
      assert.equal(canvasNode("heading"), null, name);
      assert.ok(await shortcut(document.body, "z", command), name);
      assert.ok(canvasNode("heading"), name);
      assert.equal(button("元に戻す").disabled, true, name);
    }
    assert.equal(await shortcut(canvasBody(), "d", { metaKey: true }), false, "no selected layer");
    assert.match(document.querySelector(".e-notice").textContent, /要素を選択/);
  } finally { await app.cleanup(); }
});

test("box grouping confirms layout changes and stays undoable and redoable", async () => {
  const app = await setup();
  try {
    await tool("レイヤー"); await clickLayer("link");
    assert.ok(await shortcut(layerButton("link"), "g", { metaKey: true }));
    assert.match(document.querySelector('[role="dialog"]').textContent, /並び方や余白が変わる/u);
    await click("適用する");
    assert.ok(canvasNode("group_1"));
    assert.equal(canvasNode("link").parentElement.closest('[data-nw-node="group_1"]')?.getAttribute("data-nw-node"), "group_1");
    await click("元に戻す"); assert.equal(!!canvasNode("group_1"), false); assert.ok(canvasNode("link"));
    await click("やり直す"); assert.ok(canvasNode("group_1"));

    await clickLayer("group_1");
    assert.ok(await shortcut(layerButton("group_1"), "g", { metaKey: true, shiftKey: true }));
    assert.match(document.querySelector('[role="dialog"]').textContent, /並び方や余白が変わる/u);
    await click("適用する");
    assert.equal(!!canvasNode("group_1"), false); assert.ok(canvasNode("link"));
    await click("元に戻す"); assert.ok(canvasNode("group_1"));
    await click("やり直す"); assert.equal(!!canvasNode("group_1"), false);
  } finally { await app.cleanup(); }
});

test("shortcut matrix preserves focused fields, direct editing, IME and dialog controls", async () => {
  const app = await setup();
  try {
    await tool("レイヤー"); await clickLayer("heading");
    for (const target of [document.body, canvasBody(), layerButton("heading")]) {
      assert.equal(await shortcut(target, "Delete", { isComposing: true }), false);
      assert.equal(await shortcut(target, "d", { ctrlKey: true, keyCode: 229 }), false);
    }
    const editable = document.createElement("div"); editable.setAttribute("contenteditable", "true");
    const richChild = document.createElement("span"); editable.append(richChild); canvasBody().append(editable);
    for (const target of [input("表示幅"), input("テキスト"), document.querySelector('select[aria-label="表示倍率"]'), richChild]) {
      assert.equal(await shortcut(target, "d", { ctrlKey: true }), false);
      assert.equal(await shortcut(target, "Delete"), false);
      assert.equal(await shortcut(target, "?", { shiftKey: true }), false);
      assert.equal(await shortcut(target, "ArrowDown"), false);
      assert.equal(await shortcut(target, "k", { metaKey: true }), false);
    }
    editable.remove();
    assert.ok(canvasNode("heading")); assert.equal(canvasNode("heading_copy1"), null);
    assert.ok(await shortcut(layerButton("heading"), "Escape"));
    assert.equal(layerButton("hero").getAttribute("aria-selected"), "true");
    assert.equal(document.activeElement, layerButton("hero"));
    assert.ok(await shortcut(document.activeElement, "Enter"));
    assert.equal(layerButton("heading").getAttribute("aria-selected"), "true");
    assert.equal(document.activeElement, layerButton("heading"));
    assert.ok(await shortcut(document.activeElement, "Enter"));
    const heading = canvasNode("heading");
    assert.equal(heading.contentEditable, "true");
    const original = heading.textContent; heading.textContent = "入力中";
    for (const target of [document.body, canvasBody(), layerButton("heading")]) {
      assert.equal(await shortcut(target, "Delete", {}, false), false);
      assert.match(document.querySelector(".e-notice").textContent, /入力を適用するか取り消して/);
    }
    assert.equal(await shortcut(heading, "Escape", { isComposing: true }), false);
    assert.equal(heading.textContent, "入力中");
    assert.ok(await shortcut(heading, "Escape"));
    assert.equal(heading.textContent, original); assert.equal(canvasBody().querySelector(".nw-text-toolbar"), null);
    assert.equal(layerButton("heading").getAttribute("aria-selected"), "true", "Esc cancels text before navigating");
    assert.ok(await shortcut(canvasBody(), "?", { shiftKey: true }));
    const help = document.querySelector('[role="dialog"][aria-label="ショートカット一覧"]'), close = help.querySelector("button");
    assert.equal(help.querySelectorAll("tbody tr").length, editorShortcuts.length);
    assert.deepEqual([...help.querySelectorAll("tbody kbd")].map((element) => element.textContent), editorShortcuts.map(({ keyLabel }) => keyLabel));
    assert.equal(document.activeElement, close);
    assert.equal(await shortcut(close, "Delete"), false);
    assert.equal(await shortcut(canvasBody(), "Delete", {}, false), false);
    assert.match(document.querySelector(".e-notice").textContent, /ダイアログを閉じて/);
    assert.ok(await shortcut(close, "Escape"));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.ok(canvasNode("heading"));
  } finally { await app.cleanup(); }
});

test("shortcut matrix denies mutations with reasons in read-only, locked, history and preview modes", async () => {
  const host = historyHost();
  const cases = [
    { options: { readOnly: { reason: "原文は業務画面で編集します。" } }, expected: /原文は業務画面/ },
    { options: { locks: [{ nodeId: "heading", fields: ["children"], reason: "ホストが管理する見出し" }] }, expected: /ホストが管理する見出し/ },
    { options: { adapter: host.adapter }, enter: async () => { await press(historyButton()); await press(versionRows()[1]); }, expected: /版の表示を閉じて/ },
    { options: {}, enter: () => click("プレビュー"), expected: /プレビューを閉じて/ },
  ];
  for (const { options, enter, expected } of cases) {
    const app = await setup(options);
    try {
      await tool("レイヤー"); await clickLayer("heading"); await enter?.();
      for (const target of [document.body, canvasBody(), layerButton("heading")]) {
        assert.equal(await shortcut(target, "Delete", {}, false), false, String(expected));
        assert.match(document.querySelector(".e-notice").textContent, expected);
        assert.ok(canvasNode("heading"));
      }
      assert.equal(await shortcut(canvasBody(), "d", { metaKey: true }, false), false);
      assert.equal(canvasNode("heading_copy1"), null);
    } finally { await app.cleanup(); }
  }
});

test("page switches reuse the canvas iframe and keep its current keyboard listener", async () => {
  const app = await setup();
  try {
    const scale = () => document.querySelector('select[aria-label="表示倍率"]').value;
    const oldFrame = document.querySelector("iframe"), oldBody = canvasBody(), OldKeyboardEvent = oldBody.ownerDocument.defaultView.KeyboardEvent;
    assert.ok(await shortcut(oldBody, "0", { ctrlKey: true })); assert.equal(scale(), "1");
    assert.ok(await shortcut(document.body, "+", { metaKey: true, shiftKey: true })); assert.equal(scale(), "1.5");
    assert.ok(await shortcut(oldBody, "-", { metaKey: true })); assert.equal(scale(), "1");
    assert.equal(button("元に戻す").disabled, true);
    await clickPage("別ページ");
    assert.equal(document.querySelector("iframe"), oldFrame, "page changes keep the same iframe");
    assert.equal(canvasBody(), oldBody, "the current page is rendered into the existing iframe document");
    const oldEvent = new OldKeyboardEvent("keydown", { key: "-", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => oldBody.dispatchEvent(oldEvent));
    assert.equal(oldEvent.defaultPrevented, true); assert.equal(scale(), "0.75");
    assert.ok(await shortcut(canvasBody(), "0", { ctrlKey: true })); assert.equal(scale(), "1");
  } finally { await app.cleanup(); }
});

test("page switches reset uncontrolled canvas DOM state without replacing the iframe", async () => {
  const page = (pageId) => ({ ...structuredClone(fixture), pageId, body: [{ type: "element", id: "shared-details", tag: "details", children: [
    { type: "element", id: "shared-summary", tag: "summary", children: [{ type: "text", text: "ページ内容" }] },
    { type: "element", id: "shared-content", tag: "p", children: [{ type: "text", text: "同じIDの内容" }] }
  ] }] });
  const app = await setup({ adapter: { readDocument: async (target) => ({ document: page(target.pageId), version: `v-${target.pageId}` }) } });
  try {
    const frame = document.querySelector("iframe"), body = canvasBody(), originalDetails = body.querySelector("details");
    assert.ok(originalDetails);
    originalDetails.open = true;
    await clickPage("別ページ");
    const currentDetails = canvasBody().querySelector("details");
    assert.equal(document.querySelector("iframe"), frame, "page changes keep the same iframe");
    assert.equal(canvasBody(), body, "the iframe document remains mounted");
    assert.equal(currentDetails, originalDetails, "matching nodes are reconciled instead of remounted");
    assert.equal(currentDetails.open, false, "the next page starts from its document state");
  } finally { await app.cleanup(); }
});

test("page switches reset uncontrolled form fields while reusing matching DOM nodes", async () => {
  const page = (pageId) => ({ ...structuredClone(fixture), pageId, body: [{ type: "element", id: "shared-form", tag: "form", attrs: { name: "contact" }, children: [
    { type: "element", id: "shared-input-label", tag: "label", attrs: { htmlFor: "shared-input-control" }, children: [{ type: "text", text: "名前" }] },
    { type: "element", id: "shared-input", tag: "input", attrs: { id: "shared-input-control", name: "name", type: "text", value: "initial" }, children: [] },
    { type: "element", id: "shared-checkbox-label", tag: "label", attrs: { htmlFor: "shared-checkbox-control" }, children: [{ type: "text", text: "通知を受け取る" }] },
    { type: "element", id: "shared-checkbox", tag: "input", attrs: { id: "shared-checkbox-control", name: "notify", type: "checkbox", checked: true }, children: [] },
    { type: "element", id: "shared-textarea-label", tag: "label", attrs: { htmlFor: "shared-textarea-control" }, children: [{ type: "text", text: "説明" }] },
    { type: "element", id: "shared-textarea", tag: "textarea", attrs: { id: "shared-textarea-control", name: "description" }, children: [{ type: "text", text: "saved" }] },
    { type: "element", id: "shared-select-label", tag: "label", attrs: { htmlFor: "shared-select-control" }, children: [{ type: "text", text: "分類" }] },
    { type: "element", id: "shared-select", tag: "select", attrs: { id: "shared-select-control", name: "category" }, children: [
      { type: "element", id: "shared-option-one", tag: "option", attrs: { value: "one", disabled: true }, children: [{ type: "text", text: "一" }] },
      { type: "element", id: "shared-option-two", tag: "option", attrs: { value: "two" }, children: [{ type: "text", text: "二" }] },
    ] },
  ] }] });
  const app = await setup({ adapter: { readDocument: async (target) => ({ document: page(target.pageId), version: `v-${target.pageId}` }) } });
  try {
    const input = canvasBody().querySelector('input[type="text"]'), checkbox = canvasBody().querySelector('input[type="checkbox"]');
    const textarea = canvasBody().querySelector("textarea"), select = canvasBody().querySelector("select");
    assert.ok(input); assert.ok(checkbox); assert.ok(textarea); assert.ok(select);
    input.value = "typed"; checkbox.checked = false; textarea.value = "typed"; select.selectedIndex = 1;
    await clickPage("別ページ");
    assert.equal(canvasBody().querySelector("input"), input);
    assert.equal(canvasBody().querySelector("select"), select);
    assert.equal(canvasBody().querySelector("textarea"), textarea);
    assert.equal(input.value, "initial");
    assert.equal(checkbox.checked, true);
    assert.equal(textarea.value, "saved");
    assert.equal(select.selectedIndex, 1, "the first enabled option is selected");
  } finally { await app.cleanup(); }
});

test("page switches reset only nodes owned by the current page in a shared presentation", async () => {
  const page = (pageId) => ({ ...structuredClone(fixture), pageId, body: [
    { type: "element", id: "shared-form", tag: "form", attrs: { name: "contact" }, children: [
      { type: "element", id: "shared-select-label", tag: "label", attrs: { htmlFor: "category" }, children: [{ type: "text", text: "分類" }] },
      { type: "element", id: "shared-node-id", tag: "select", attrs: { id: "category", name: "category" }, children: [
        { type: "element", id: "shared-option-disabled", tag: "option", attrs: { value: "disabled", disabled: true }, children: [{ type: "text", text: "無効" }] },
        { type: "element", id: "shared-option-enabled", tag: "option", attrs: { value: "enabled" }, children: [{ type: "text", text: "有効" }] },
      ] },
    ] },
  ] });
  const shared = (pageId) => ({ ...structuredClone(fixture), pageId, body: [{ type: "element", id: "shared-node-id", tag: "div", children: [] }] });
  const presentation = { schemaVersion: 1, siteId: "demo", locale: "ja-JP", version: "presentation-v1", reset: "neutral-v1", tokens: {}, fonts: [],
    shared: { header: shared("shared-header"), footer: shared("shared-footer") } };
  const app = await setup({ adapter: { readDocument: async (target) => ({ document: page(target.pageId), version: "v-" + target.pageId, presentation }) } });
  try {
    const frame = document.querySelector("iframe");
    assert.ok(frame, document.querySelector(".e-notice")?.textContent);
    const select = frame.contentDocument.body.querySelector("select");
    assert.ok(select);
    select.selectedIndex = 0;
    await clickPage("別ページ");
    assert.equal(frame.contentDocument.body.querySelector("select"), select);
    assert.equal(select.selectedIndex, 1, "footer nodes with colliding IDs do not shadow page nodes");
  } finally { await app.cleanup(); }
});
