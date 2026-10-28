import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  createInsertionNode, defineBuilder, formInsertionPresets, layoutInsertionPresets, matchesMotionPreset, partInsertionPresets, resolveBuilderDefinition, sectionInsertionPresets, standardBuilderDefinition
} from "@niho/web/builder";
import { generatePageCss, parseComponentLibrary, parsePageDocument } from "@niho/web/core";
import { renderPageToHtml } from "@niho/web/server";
import { commitHistory, editDocument, travelHistory } from "../dist/editor-model.js";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));
const doc = () => structuredClone(fixture);

test("layout compositions are opt-in and every catalog entry creates a valid document subtree", () => {
  assert.equal(resolveBuilderDefinition().insertions.some((entry) => entry.id === "grid"), false);
  const catalog = resolveBuilderDefinition({ insertions: layoutInsertionPresets });
  let page = doc();
  for (const preset of catalog.insertions) {
    const node = createInsertionNode(preset, { document: page });
    page = parsePageDocument({ ...page, body: [...page.body, node] });
  }
  assert.ok(page.body.some((node) => node.type === "element" && node.style?.base?.display === "grid"));
  assert.equal(resolveBuilderDefinition().motions.length, 0);
});

test("Basic catalog includes safe icons, native video and closed embeds in the reference-like order", () => {
  const basic = resolveBuilderDefinition().insertions.filter((entry) => (entry.category ?? "basic") === "basic");
  const ordered = ["section", "box", "img", "text", "icon", "richtext", "video", "embed-blank", "embed-map", "embed-youtube", "embed-vimeo", "embed-lottie", "embed-facebook", "embed-x", "embed-instagram"];
  assert.deepEqual(basic.filter((entry) => ordered.includes(entry.id)).map((entry) => entry.id), ordered);
  assert.ok(basic.filter((entry) => ordered.slice(0, 7).includes(entry.id)).every((entry) => entry.group === "基本"));
  assert.ok(basic.filter((entry) => ordered.slice(7).includes(entry.id)).every((entry) => entry.group === "埋め込み"));
  let page = doc();
  for (const id of ["icon", "video"]) page = editDocument(page, { type: "add", parentId: null, node: createInsertionNode(basic.find((entry) => entry.id === id), { document: page }) });
  const iconIndex = page.body.findIndex((node) => node.type === "element" && node.icon);
  const videoIndex = page.body.findIndex((node) => node.type === "element" && node.tag === "video");
  assert.equal(page.body[videoIndex].attrs.src, undefined, "新規動画は実在しない URL を持たない");
  page = editDocument(page, { type: "icon", path: [iconIndex], name: "star" });
  page = editDocument(page, { type: "attribute", path: [iconIndex], name: "aria-label", value: "おすすめ" });
  page = editDocument(page, { type: "video", path: [videoIndex], source: { asset: { provider: "uploads", id: "intro" } } });
  const reloaded = parsePageDocument(JSON.parse(JSON.stringify(page)));
  assert.equal(reloaded.body[iconIndex].icon, "star"); assert.equal(reloaded.body[iconIndex].attrs["aria-label"], "おすすめ");
  assert.deepEqual(reloaded.body[videoIndex].asset, { provider: "uploads", id: "intro" }); assert.equal(reloaded.body[videoIndex].attrs.src, undefined);
  const html = renderPageToHtml(reloaded, {}, { assets: { "uploads:intro": { src: "/media/intro.mp4" } } });
  assert.ok(html.includes("★")); assert.ok(html.includes('src="/media/intro.mp4"'));
});

test("VideoWithButton uses a closed structural binding that survives reload, duplication and deletion", () => {
  const preset = resolveBuilderDefinition().insertions.find((entry) => entry.id === "video-with-button");
  assert.ok(preset); assert.equal(preset.group, "インタラクション");
  let page = editDocument(doc(), { type: "add", parentId: null, node: createInsertionNode(preset, { document: doc() }) });
  const index = page.body.length - 1, root = page.body[index];
  assert.deepEqual(root.interaction, { type: "video-toggle" });
  assert.deepEqual(root.children.map((child) => child.tag), ["video", "button"]);
  assert.equal(root.children[0].attrs.src, undefined); assert.equal(root.children[0].attrs.controls, true);
  page = editDocument(page, { type: "video", path: [index, 0], source: { src: "/intro.mp4" } });
  const reloaded = parsePageDocument(JSON.parse(JSON.stringify(page)));
  const duplicated = editDocument(reloaded, { type: "duplicate", path: [index] });
  assert.deepEqual(duplicated.body.slice(-2).map((node) => node.interaction), [{ type: "video-toggle" }, { type: "video-toggle" }]);
  assert.equal(new Set(duplicated.body.slice(-2).flatMap((node) => [node.id, ...node.children.map((child) => child.id)])).size, 6);
  const removed = editDocument(duplicated, { type: "remove", path: [index + 1] });
  assert.equal(removed.body.filter((node) => node.type === "element" && node.interaction?.type === "video-toggle").length, 1);
  assert.throws(() => parsePageDocument({ ...page, body: [{ ...root, interaction: { type: "video-toggle", script: "alert(1)" } }] }), /interaction/);
  assert.throws(() => editDocument(page, { type: "remove", path: [index, 0] }), /video-toggle/);
  assert.throws(() => parsePageDocument({ ...page, body: [{ ...root, children: [root.children[0], { ...root.children[1], children: [{ type: "element", id: "nested-control", tag: "span", children: [{ type: "text", text: "再生" }] }] }] }] }), /video-toggle/);
});

test("Loop Box uses a bounded closed descriptor and survives edit, reload and duplication", () => {
  const preset = resolveBuilderDefinition().insertions.find((entry) => entry.id === "loop-box");
  assert.ok(preset); assert.equal(preset.group, "インタラクション");
  let page = editDocument(doc(), { type: "add", parentId: null, node: createInsertionNode(preset, { document: doc() }) });
  const index = page.body.length - 1, root = page.body[index];
  assert.deepEqual(root.interaction, { type: "loop-box", speed: 60, pauseOnHover: true });
  assert.equal(root.style.base.flexDirection, "row"); assert.equal(root.children.length, 3);
  page = editDocument(page, { type: "loopBox", path: [index], speed: 125.5, pauseOnHover: false });
  page = editDocument(page, { type: "style", path: [index], breakpoint: "base", property: "flexDirection", value: "column-reverse" });
  const reloaded = parsePageDocument(JSON.parse(JSON.stringify(page)));
  assert.deepEqual(reloaded.body[index].interaction, { type: "loop-box", speed: 125.5, pauseOnHover: false });
  assert.equal(reloaded.body[index].style.base.flexDirection, "column-reverse");
  const duplicated = editDocument(reloaded, { type: "duplicate", path: [index] });
  assert.deepEqual(duplicated.body.slice(-2).map((node) => node.interaction), [{ type: "loop-box", speed: 125.5, pauseOnHover: false }, { type: "loop-box", speed: 125.5, pauseOnHover: false }]);
  const reject = (interaction, children = root.children) => assert.throws(() => parsePageDocument({ ...page, body: [{ ...root, interaction, children }] }), /interaction|loop-box/);
  reject({ type: "loop-box", speed: -1, pauseOnHover: true });
  reject({ type: "loop-box", speed: 1001, pauseOnHover: true });
  reject({ type: "loop-box", speed: 60, pauseOnHover: "yes" });
  reject({ type: "loop-box", speed: 60, pauseOnHover: true, script: "alert(1)" });
  reject({ type: "loop-box", speed: 60, pauseOnHover: true }, []);
  reject({ type: "loop-box", speed: 60, pauseOnHover: true }, [{ ...root.children[0], interaction: { type: "loop-box", speed: 60, pauseOnHover: false } }, ...root.children.slice(1)]);
});

test("標準埋め込み preset は空で始まり provider を固定して保存・再読込できる", () => {
  const basic = resolveBuilderDefinition().insertions.filter((entry) => (entry.category ?? "basic") === "basic");
  let page = doc();
  const embedIds = ["embed-blank", "embed-map", "embed-youtube", "embed-vimeo", "embed-lottie", "embed-facebook", "embed-x", "embed-instagram"];
  for (const id of embedIds) {
    page = editDocument(page, { type: "add", parentId: null, node: createInsertionNode(basic.find((entry) => entry.id === id), { document: page }) });
  }
  const start = page.body.length - embedIds.length;
  assert.deepEqual(page.body.slice(start).map((node) => node.embed.provider), ["blank", "map", "youtube", "vimeo", "lottie", "facebook", "x", "instagram"]);
  assert.ok(page.body.slice(start).every((node) => node.embed.source === undefined && node.children.length === 0));
  assert.equal(page.body[start + 5].style.base.height, 650);
  assert.equal(page.body[start + 5].style.base.maxWidth, 550);
  assert.equal(page.body[start + 6].style.base.maxWidth, 550);
  assert.equal(page.body[start + 7].style.base.maxWidth, 540);
  const edited = editDocument(page, { type: "embedSource", path: [start + 2], source: "https://youtu.be/dQw4w9WgXcQ" });
  const titled = editDocument(edited, { type: "embedTitle", path: [start + 2], title: "紹介動画" });
  assert.deepEqual(titled.body[start + 2].embed, { provider: "youtube", source: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", title: "紹介動画" });
  const history = commitHistory(commitHistory({ past: [], present: page, future: [] }, edited), titled);
  assert.equal(travelHistory(history, "undo", {}, []).present.body[start + 2].embed.title, "YouTube 動画");
  const reloaded = parsePageDocument(JSON.parse(JSON.stringify(titled)));
  assert.deepEqual(reloaded.body[start + 2].embed, titled.body[start + 2].embed);
  const lottie = editDocument(reloaded, { type: "embedSource", path: [start + 4], source: "https://lottie.host/123e4567-e89b-42d3-a456-426614174000/intro.json" });
  assert.equal(lottie.body[start + 4].embed.source, "https://lottie.host/embed/123e4567-e89b-42d3-a456-426614174000/intro.json");
  const facebook = editDocument(lottie, { type: "embedSource", path: [start + 5], source: "https://facebook.com/example.page/posts/123456789/" });
  assert.equal(facebook.body[start + 5].embed.source, "https://www.facebook.com/example.page/posts/123456789");
  const x = editDocument(facebook, { type: "embedSource", path: [start + 6], source: "https://x.com/Example/status/1234567890123456789/" });
  assert.equal(x.body[start + 6].embed.source, "https://x.com/example/status/1234567890123456789");
  const instagram = editDocument(x, { type: "embedSource", path: [start + 7], source: "https://instagram.com/reel/AbCdEf12345" });
  assert.equal(instagram.body[start + 7].embed.source, "https://www.instagram.com/reel/AbCdEf12345/");
  const blank = editDocument(instagram, { type: "embedSource", path: [start], source: "public-guide" });
  assert.deepEqual(parsePageDocument(JSON.parse(JSON.stringify(blank))).body.slice(start, start + 3).map((node) => node.embed.provider), ["blank", "map", "youtube"]);
  assert.equal(blank.body[start].embed.source, "public-guide");
  assert.throws(() => editDocument(titled, { type: "embedSource", path: [start + 2], source: "https://example.test/video" }), /YouTube/);
});

test("Basic のフォームと全フォームパーツは有効な部分木として保存・再読込できる", () => {
  assert.deepEqual(formInsertionPresets.map(({ id }) => id), ["form-1", "form-2", "form-3", "form-input", "form-textarea", "form-select", "form-radio", "form-confirm", "form-checkbox", "form-file", "form-submit", "form-search", "form-password"]);
  assert.ok(formInsertionPresets.slice(0, 3).every((preset) => preset.group === "フォーム"));
  assert.ok(formInsertionPresets.slice(3).every((preset) => preset.group === "フォームパーツ"));
  let page = doc();
  for (const preset of formInsertionPresets) page = editDocument(page, { type: "add", parentId: null, node: createInsertionNode(preset, { document: page }) });
  const reloaded = parsePageDocument(JSON.parse(JSON.stringify(page)));
  assert.equal(reloaded.body.filter((node) => node.type === "element" && node.tag === "form").length, formInsertionPresets.length);
  const html = renderPageToHtml(reloaded);
  assert.match(html, /<label[^>]*for="/); assert.match(html, /required=""/); assert.match(html, /<option[^>]*>選択肢 1<\/option>/);
});

test("standard parts and sections validate, survive editing and reload, and render through SSR", () => {
  let page = doc();
  for (const preset of [...partInsertionPresets, ...sectionInsertionPresets]) {
    const node = createInsertionNode(preset, { document: page });
    page = parsePageDocument({ ...page, body: [...page.body, node] });
  }
  assert.deepEqual(partInsertionPresets.map(({ id }) => id), ["part-button", "part-card", "part-heading-set", "part-list"]);
  assert.deepEqual(sectionInsertionPresets.map(({ id }) => id), ["section-header", "section-hero", "section-feature-grid", "section-cta", "section-faq", "section-footer"]);
  assert.ok(page.body.some((node) => node.type === "element" && node.style?.responsive?.length), "section layouts carry responsive declarations");

  const buttonIndex = page.body.findIndex((node) => node.type === "element" && node.tag === "a" && node.children[0]?.text === "詳しく見る");
  const edited = editDocument(page, { type: "text", path: [buttonIndex, 0], value: "内容を見る" });
  const reloaded = parsePageDocument(JSON.parse(JSON.stringify(edited)));
  assert.equal(reloaded.body[buttonIndex].children[0].text, "内容を見る");
  const html = renderPageToHtml(reloaded);
  assert.match(html, /内容を見る/);
  assert.match(html, /@media \(min-width:768px\)/);
  assert.match(html, /よくある質問/);
});

test("insertion categories are closed while omitted host categories remain backward compatible", () => {
  const legacy = { id: "legacy", label: "従来項目", group: "独自", create: ({ id }) => ({ type: "element", id: id(), tag: "div", children: [] }) };
  const resolved = resolveBuilderDefinition({ insertions: [legacy] });
  assert.equal(resolved.insertions.find(({ id }) => id === "legacy").category, undefined);
  assert.equal(resolved.insertions.find(({ id }) => id === "part-card").category, "parts");
  assert.equal(resolved.insertions.find(({ id }) => id === "section-hero").category, "sections");
  assert.throws(() => defineBuilder({ insertions: [{ ...legacy, category: "marketing" }] }), /正しくありません/);
});

test("the standard catalog and a custom composed subtree use only unique factory IDs", () => {
  const custom = defineBuilder({ insertions: [{
    id: "feature-card", label: "特徴カード", group: "カスタム", glyph: "◇",
    create: ({ id, target }) => ({ type: "element", id: id(), tag: "article", attrs: { lang: target.locale }, children: [
      { type: "element", id: id(), tag: "h2", children: [{ type: "text", text: "特徴" }] },
      { type: "element", id: id(), tag: "p", children: [{ type: "text", text: "説明" }] }
    ] })
  }] });
  const resolved = resolveBuilderDefinition(custom);
  assert.ok(resolved.insertions.length > standardBuilderDefinition.insertions.length);
  const preset = resolved.insertions.find((entry) => entry.id === "feature-card");
  const node = createInsertionNode(preset, { document: doc() });
  assert.equal(node.tag, "article");
  assert.equal(node.attrs.lang, "ja-JP");
  assert.equal(new Set([node.id, ...node.children.map((child) => child.id)]).size, 3);
  assert.doesNotThrow(() => parsePageDocument({ ...doc(), body: [...doc().body, node] }));
});

test("preset validation rejects repeated IDs, unissued IDs and invalid HTML nesting", () => {
  const repeated = { id: "repeated", label: "重複", group: "検査", create: ({ id }) => {
    const same = id(); return { type: "element", id: same, tag: "div", children: [{ type: "element", id: same, tag: "p", children: [] }] };
  } };
  assert.throws(() => createInsertionNode(repeated, { document: doc() }), /duplicate node ID/);
  const hardcoded = { id: "hardcoded", label: "固定", group: "検査", create: () => ({ type: "element", id: "unsafe", tag: "div", children: [] }) };
  assert.throws(() => createInsertionNode(hardcoded, { document: doc() }), /id factory/);
  const nested = { id: "nested", label: "不正な入れ子", group: "検査", create: ({ id }) => ({
    type: "element", id: id(), tag: "p", children: [{ type: "element", id: id(), tag: "div", children: [] }]
  }) };
  assert.throws(() => createInsertionNode(nested, { document: doc() }), /nesting/);
});

test("custom presets cannot bypass insertable blocks or component placement policy", () => {
  const blocks = { Notice: { props: { heading: { type: "string", required: true } } } };
  const block = { id: "notice", label: "お知らせ", group: "業務", create: ({ id }) => ({ type: "component", id: id(), block: "Notice", props: { heading: "案内" } }) };
  assert.throws(() => createInsertionNode(block, { document: doc(), blocks, insertableBlocks: [] }), /新しく配置できません/);

  const library = parseComponentLibrary({ schemaVersion: 1, siteId: "demo", revision: 1, tokens: {}, components: [{
    id: "card", name: "カード", kind: "part", version: 1, root: { type: "element", id: "root", tag: "div", children: [] }
  }] });
  const instance = { id: "instance", label: "コンポーネント", group: "コンポーネント", create: ({ id }) => ({ type: "instance", id: id(), component: "card" }) };
  assert.throws(() => createInsertionNode(instance, { document: doc(), components: library, canInsertInstance: () => false }), /配置できません/);

  const libraryWithBlock = parseComponentLibrary({ schemaVersion: 1, siteId: "demo", revision: 1, tokens: {}, components: [{
    id: "notice-card", name: "お知らせカード", kind: "part", version: 1, root: { type: "element", id: "root", tag: "div", children: [
      { type: "component", id: "notice", block: "Notice", props: { heading: "案内" } }
    ] }
  }] }, blocks);
  const wrappedBlock = { id: "wrapped-block", label: "コンポーネント内ブロック", group: "コンポーネント", create: ({ id }) => ({ type: "instance", id: id(), component: "notice-card" }) };
  assert.throws(
    () => createInsertionNode(wrappedBlock, { document: doc(), blocks, components: libraryWithBlock, insertableBlocks: [] }),
    /追加が許可されていない/
  );

  const unlocked = createInsertionNode({ id: "child", label: "子", group: "検査", create: ({ id }) => ({ type: "element", id: id(), tag: "div", children: [] }) }, { document: doc() });
  assert.throws(() => editDocument(doc(), { type: "add", parentId: "hero", node: unlocked }, {}, [{ nodeId: "hero", fields: ["children"], reason: "運営管理" }]), /運営管理/);
});

test("a custom motion preset merges and removes only its declared paths in one undoable edit", () => {
  const source = doc();
  source.body[0].style.hidden = [{ minWidth: 1440 }];
  source.body[0].style.base.rotate = 12;
  source.body[0].style.states = { hover: { color: "#334455" } };
  const style = {
    base: { transitionTimingFunction: "ease-out", transitionDuration: 240 },
    states: { hover: { translate: "0 -6px" }, focus: { color: { token: "brand" } }, active: { scale: 0.98 } },
    appear: { effect: "fade-up", trigger: "load", duration: 500, delay: 0 }
  };
  const siteStyles = { tokens: { brand: { type: "color", value: "#195640" } } };
  const edited = editDocument(source, { type: "motionPreset", path: [0], style }, {}, [], undefined, siteStyles);
  assert.deepEqual(edited.body[0].style.responsive, source.body[0].style.responsive);
  assert.deepEqual(edited.body[0].style.hidden, source.body[0].style.hidden);
  assert.equal(edited.body[0].style.base.padding.token, "space");
  assert.equal(edited.body[0].style.base.rotate, 12);
  assert.deepEqual(edited.body[0].style.states.hover, { color: "#334455", translate: "0 -6px" });
  assert.equal(matchesMotionPreset(edited.body[0].style, { id: "ordered-differently", label: "順序違い", style: {
    states: { hover: { translate: "0 -6px" }, active: { scale: 0.98 }, focus: { color: { token: "brand" } } },
    base: { transitionDuration: 240, transitionTimingFunction: "ease-out" },
    appear: { delay: 0, duration: 500, trigger: "load", effect: "fade-up" }
  } }), true, "subset comparison ignores object key order and unrelated manual style");

  const history = commitHistory({ past: [], present: source, future: [] }, edited);
  assert.deepEqual(travelHistory(history, "undo", {}, [], undefined, siteStyles).present, source);
  const next = { base: { transitionDuration: 160 }, states: { focus: { scale: 1.03 } } };
  const switched = editDocument(edited, { type: "motionPreset", path: [0], previous: style, style: next }, {}, [], undefined, siteStyles);
  assert.equal(switched.body[0].style.base.rotate, 12);
  assert.equal(switched.body[0].style.base.transitionDuration, 160);
  assert.equal(switched.body[0].style.base.transitionTimingFunction, undefined);
  assert.deepEqual(switched.body[0].style.states, { hover: { color: "#334455" }, focus: { scale: 1.03 } });
  assert.equal(switched.body[0].style.appear, undefined);
  const cleared = editDocument(switched, { type: "motionPreset", path: [0], previous: next, style: undefined }, {}, [], undefined, siteStyles);
  assert.equal(cleared.body[0].style.base.rotate, 12);
  assert.deepEqual(cleared.body[0].style.states, { hover: { color: "#334455" } });
  assert.deepEqual(cleared.body[0].style.responsive, source.body[0].style.responsive);
  assert.throws(() => editDocument(source, { type: "motionPreset", path: [0], style }, {}, [{ nodeId: "hero", fields: ["style.states"], reason: "管理値" }], undefined, siteStyles), /管理値/);
  assert.throws(() => editDocument(source, { type: "motionPreset", path: [0], style }, {}, [], undefined), /unknown token/);
  assert.throws(() => editDocument(source, { type: "motionPreset", path: [0], style: { base: { animation: "unsafe 1s" } } }, {}, [], undefined, siteStyles), /未対応/);
  assert.throws(() => defineBuilder({ motions: [{ id: "unsafe", label: "unsafe", style: { base: { color: "red" } } }] }), /未対応/);
  assert.throws(() => defineBuilder({ motions: [{ id: "unknown", label: "unknown", style: { states: { hover: { filter: "blur(1px)" } } } }] }), /未対応/);

  const css = generatePageCss(edited, {}, undefined, siteStyles);
  assert.match(css, /prefers-reduced-motion:no-preference/);
  assert.match(css, /translate:0 -6px/);
  for (const rule of css.split("\n").filter((line) => /animation|transition/.test(line))) assert.ok(rule.startsWith("@media (prefers-reduced-motion:no-preference)"));
});

test("motion presets also apply to component instances without changing the wire contract", () => {
  const library = parseComponentLibrary({ schemaVersion: 1, siteId: "demo", revision: 1, tokens: {}, components: [{
    id: "card", name: "カード", kind: "part", version: 1, root: { type: "element", id: "root", tag: "article", children: [] }
  }] });
  const source = doc(); source.body.push({ type: "instance", id: "card-use", component: "card", style: { responsive: [{ minWidth: 768, declarations: { width: "50%" } }] } });
  const parsed = parsePageDocument(source, {}, { components: library });
  const edited = editDocument(parsed, { type: "motionPreset", path: [1], style: { states: { focus: { scale: 1.04 } }, base: { transitionDuration: 180 } } }, {}, [], library);
  assert.equal(edited.body[1].type, "instance");
  assert.deepEqual(edited.body[1].style.responsive, source.body[1].style.responsive);
  assert.deepEqual(Object.keys(edited.body[1]).sort(), ["component", "id", "style", "type"]);
  assert.equal(JSON.stringify(parsePageDocument(fixture)), JSON.stringify(fixture), "existing documents remain byte-equivalent after parsing");
});
