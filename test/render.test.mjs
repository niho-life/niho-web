import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { createBlankEmbedRegistry, DocumentValidationError, pageScope, PageRenderer as RootPageRenderer } from "@niho/web";
import { PageRenderer, SitePageRenderer } from "@niho/web/react";
import { renderPageToHtml, renderSitePageToHtml } from "@niho/web/server";
import { generatePageCss } from "@niho/web/core";

const fixture = JSON.parse(readFileSync(new URL("../examples/page.json", import.meta.url), "utf8"));

test("React server rendering and Astro HTML helper produce the same initial content", () => {
  const html = renderPageToHtml(fixture);
  assert.equal(RootPageRenderer, PageRenderer);
  assert.equal(html, renderToString(createElement(PageRenderer, { document: fixture })));
  assert.match(html, /<h1 data-nw-node="heading"[^>]*>海のそばで過ごす<\/h1>/);
  assert.ok(html.includes(`data-nw-scope="${pageScope(fixture)}" lang="ja-JP"`));
  assert.ok(html.includes("<style data-nw-style="));
  assert.ok(html.includes(`data-nw-scope="${pageScope(fixture)}"] [data-nw-owner="${pageScope(fixture)}"][data-nw-node="hero"]`));
  assert.ok(html.includes("padding:var(--nw-space)"));
});

test("text and attribute values are escaped and blank targets gain safe rel", () => {
  const doc = structuredClone(fixture);
  doc.body[0].children[0].children[0].text = "<script>alert('x')</script>&";
  doc.body[0].children[2].attrs = { href: "https://example.com/?x=1&y=2", title: '\" onclick=\"evil', target: "_blank", rel: "nofollow" };
  const html = renderPageToHtml(doc);
  assert.ok(html.includes("&lt;script&gt;")); assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("title=\"&quot; onclick=&quot;evil\""));
  assert.ok(html.includes("href=\"https://example.com/?x=1&amp;y=2\""));
  assert.ok(html.includes("rel=\"nofollow noopener noreferrer\""));
});

test("フォーム SSR はラベル・必須・選択肢を保ち、完了ページ設定があっても送信先を持たない", () => {
  const doc = structuredClone(fixture); doc.body = [{ type: "element", id: "form", tag: "form", formCompletionPageId: "thanks", attrs: { name: "contact", "aria-label": "お問い合わせ" }, children: [
    { type: "element", id: "label", tag: "label", attrs: { htmlFor: "email" }, children: [{ type: "text", text: "メール" }] },
    { type: "element", id: "email", tag: "input", attrs: { id: "email", type: "email", name: "email", required: true }, children: [] },
    { type: "element", id: "choice-label", tag: "label", attrs: { htmlFor: "choice" }, children: [{ type: "text", text: "選択" }] },
    { type: "element", id: "choice", tag: "select", attrs: { id: "choice", name: "choice" }, children: [{ type: "element", id: "one", tag: "option", attrs: { value: "one" }, children: [{ type: "text", text: "選択肢" }] }] },
    { type: "element", id: "send", tag: "button", attrs: { type: "submit" }, children: [{ type: "text", text: "送信" }] }
  ] }];
  const html = renderPageToHtml(doc);
  assert.match(html, /<form[^>]*method="dialog"/); assert.ok(!/<form[^>]*(?:action=|method="(?:get|post)")/.test(html));
  assert.ok(!html.includes("thanks")); assert.ok(!html.includes("formCompletionPageId"));
  assert.match(html, /<label[^>]*for="email"[^>]*>メール<\/label>/); assert.match(html, /<input[^>]*required=""/);
  assert.match(html, /<option value="one"[^>]*>選択肢<\/option>/); assert.match(html, /<button type="submit"/);
});

test("registered dynamic blocks render in initial HTML with allowlisted props only", () => {
  const doc = structuredClone(fixture); let received;
  doc.body.push({ type: "component", id: "notice", block: "PublicNotice", props: { heading: "Today's notice", href: "/about" }, style: { base: { marginTop: 24 } } });
  const blocks = { PublicNotice: { props: { heading: { type: "string", required: true }, href: { type: "url", required: true } },
    component: (props) => { received = props; return createElement("aside", null, createElement("a", { href: props.href }, props.heading)); }
  } };
  const html = renderPageToHtml(doc, blocks);
  assert.deepEqual(received, { heading: "Today's notice", href: "/about" });
  assert.match(html, /<div data-nw-node="notice"[^>]*data-nw-block="PublicNotice"><aside><a href="\/about">/);
  assert.ok(html.includes("margin-top:24px"));
  assert.ok(html.includes("Today&#x27;s notice"));
  assert.equal(html, renderToString(createElement(PageRenderer, { document: doc, blocks })));
});

test("all validation finishes before any registered block executes", () => {
  const doc = structuredClone(fixture); let called = 0;
  doc.body.unshift({ type: "component", id: "notice", block: "Notice", props: {} });
  doc.body.push({ type: "element", id: "bad", tag: "script", children: [] });
  const blocks = { Notice: { props: {}, component: () => { called++; return null; } } };
  assert.throws(() => renderPageToHtml(doc, blocks), DocumentValidationError);
  assert.equal(called, 0);
  assert.throws(() => renderPageToHtml({ ...fixture, body: [{ type: "component", id: "x", block: "Unknown", props: {} }] }), DocumentValidationError);
});

test("void media elements have accessible image attributes and no children", () => {
  const doc = structuredClone(fixture);
  doc.body = [{ type: "element", id: "picture", tag: "picture", children: [
    { type: "element", id: "avif", tag: "source", attrs: { srcSet: "/image.avif", type: "image/avif", media: "(min-width: 768px)" }, children: [] },
    { type: "element", id: "photo", tag: "img", attrs: { src: "/image.jpg", alt: "風景", width: 600, height: 400, loading: "lazy" }, children: [] }
  ] }];
  const html = renderPageToHtml(doc);
  assert.ok(html.includes('srcSet="/image.avif"')); assert.ok(html.includes('alt="風景"'));
  assert.ok(!html.includes("</img>"));
});

test("nested document nodes carry their own CSS owner rather than the ancestor scope", () => {
  const inner = { ...structuredClone(fixture), pageId: "inner" };
  const outer = structuredClone(fixture);
  outer.body.push({ type: "component", id: "nested", block: "NestedPage", props: {} });
  const html = renderPageToHtml(outer, { NestedPage: { props: {}, component: () => createElement(PageRenderer, { document: inner }) } });
  const outerScope = pageScope(outer), innerScope = pageScope(inner);
  assert.notEqual(outerScope, innerScope);
  assert.ok(html.includes(`data-nw-node="heading" data-nw-owner="${innerScope}"`));
  assert.ok(html.includes(`[data-nw-scope="${outerScope}"] [data-nw-owner="${outerScope}"][data-nw-node="hero"]`));
});

const imageDocument = () => {
  const doc = structuredClone(fixture);
  doc.body[0].children.push(
    { type: "element", id: "photo", tag: "img", asset: { provider: "uploads", id: "sea" }, attrs: { alt: "海" }, children: [] },
    { type: "element", id: "sized", tag: "img", asset: { provider: "uploads", id: "sea" }, attrs: { alt: "", width: 300 }, children: [] },
    { type: "element", id: "lost", tag: "img", asset: { provider: "uploads", id: "lost" }, attrs: { alt: "" }, children: [] });
  return doc;
};
const seaAssets = { "uploads:sea": { src: "/media/sea.webp", width: 1200, height: 800 } };

test("asset images render resolved URLs with intrinsic size and omit or mark unresolved assets", () => {
  const doc = imageDocument(), html = renderPageToHtml(doc, {}, { assets: seaAssets });
  assert.equal(html, renderToString(createElement(PageRenderer, { document: doc, assets: seaAssets })));
  const photo = html.match(/<img[^>]*data-nw-node="photo"[^>]*>/)?.[0], sized = html.match(/<img[^>]*data-nw-node="sized"[^>]*>/)?.[0];
  assert.ok(photo.includes('src="/media/sea.webp"')); assert.ok(photo.includes('width="1200"')); assert.ok(photo.includes('height="800"')); assert.ok(photo.includes('alt="海"'));
  assert.ok(sized.includes('width="300"')); assert.ok(!sized.includes("height="));
  assert.ok(!html.includes('data-nw-node="lost"'));
  const placeholder = renderToString(createElement(PageRenderer, { document: doc, assets: seaAssets, missingAssets: "placeholder" }));
  assert.match(placeholder, /<span data-nw-node="lost" data-nw-owner="[^"]+" data-nw-missing-asset="" role="img" aria-label="画像を表示できません"><\/span>/);
  assert.ok(!renderPageToHtml(doc).includes("<img"));
});

test("icons and videos render accessibly in SSR and unresolved video assets fail gracefully", () => {
  const doc = structuredClone(fixture);
  doc.body = [
    { type: "element", id: "done", tag: "span", icon: "check", attrs: { role: "img", "aria-label": "完了" }, style: { base: { color: "#123456", fontSize: 28 } }, children: [] },
    { type: "element", id: "clip", tag: "video", asset: { provider: "uploads", id: "clip" }, attrs: { "aria-label": "紹介動画", poster: "/poster.webp", muted: true, playsInline: true }, children: [] },
    { type: "element", id: "lost-video", tag: "video", asset: { provider: "uploads", id: "lost" }, attrs: { title: "見つからない動画" }, children: [] },
    { type: "element", id: "empty-video", tag: "video", attrs: { "aria-label": "準備中の動画" }, children: [] }
  ];
  const html = renderPageToHtml(doc, {}, { assets: { "uploads:clip": { src: "/media/clip.mp4" } } });
  assert.match(html, /<span[^>]*data-nw-node="done"[^>]*>✓<\/span>/);
  const video = html.match(/<video[^>]*data-nw-node="clip"[^>]*><\/video>/)?.[0];
  assert.ok(video.includes('src="/media/clip.mp4"')); assert.ok(video.includes('poster="/poster.webp"'));
  assert.ok(video.includes('controls=""')); assert.ok(video.includes('preload="metadata"')); assert.ok(!video.includes("autoplay"));
  assert.ok(!html.includes('data-nw-node="lost-video"'));
  assert.ok(!html.includes('data-nw-node="empty-video"'));
  const placeholder = renderToString(createElement(PageRenderer, { document: doc, assets: { "uploads:clip": { src: "/media/clip.mp4" } }, missingAssets: "placeholder" }));
  assert.match(placeholder, /data-nw-node="lost-video"[^>]*data-nw-missing-asset=""[^>]*role="status"[^>]*aria-label="動画を表示できません"/);
  assert.match(placeholder, /data-nw-node="empty-video"[^>]*data-nw-missing-asset=""[^>]*role="status"[^>]*aria-label="動画を選んでください"[^>]*>動画を選んでください<\/span>/);
  const canvas = renderToString(createElement(PageRenderer, { document: doc, assets: { "uploads:clip": { src: "/media/clip.mp4" } }, canvas: { siteOrigin: "https://site.example" } }));
  assert.ok(canvas.includes('poster="https://site.example/poster.webp"'));
});

test("VideoWithButton SSR keeps native controls and emits only the closed runtime binding", () => {
  const doc = structuredClone(fixture);
  doc.body = [{ type: "element", id: "video-box", tag: "div", interaction: { type: "video-toggle" }, style: { base: { position: "relative" } }, children: [
    { type: "element", id: "movie", tag: "video", attrs: { src: "/intro.mp4", "aria-label": "紹介動画", controls: true, preload: "metadata" }, children: [] },
    { type: "element", id: "toggle", tag: "button", attrs: { type: "button", "aria-label": "動画を再生", "aria-pressed": "false" }, style: { base: { position: "absolute", right: 16, bottom: 16 } }, children: [{ type: "text", text: "再生" }] }
  ] }];
  const html = renderPageToHtml(doc);
  assert.match(html, /data-nw-video-with-button=""/); assert.match(html, /<video[^>]*controls=""[^>]*data-nw-video=""/);
  assert.match(html, /<button[^>]*aria-label="動画を再生"[^>]*aria-pressed="false"[^>]*data-nw-video-toggle=""/);
  assert.match(html, /position:absolute/); assert.ok(!html.includes("autoplay")); assert.ok(!html.includes("onclick"));

  doc.body[0].children[0].attrs = { "aria-label": "未設定動画", controls: true };
  const empty = renderToString(createElement(PageRenderer, { document: doc, missingAssets: "placeholder" }));
  assert.match(empty, /動画を選んでください/); assert.match(empty, /data-nw-video-toggle=""[^>]*disabled=""/);
});

test("Loop Box SSR keeps one accessible original and a fixed empty runtime mount", () => {
  const doc = structuredClone(fixture);
  doc.body = [{ type: "element", id: "loop", tag: "div", interaction: { type: "loop-box", speed: 60, pauseOnHover: true }, style: { base: { display: "flex", flexDirection: "row", overflow: "hidden" } }, children: [
    { type: "element", id: "first", tag: "p", children: [{ type: "text", text: "Accessible original" }] },
    { type: "element", id: "second", tag: "a", attrs: { href: "/details" }, children: [{ type: "text", text: "More" }] }
  ] }];
  const html = renderPageToHtml(doc);
  assert.equal((html.match(/Accessible original/g) ?? []).length, 1);
  assert.match(html, /data-nw-loop-box=""[^>]*data-nw-loop-speed="60"[^>]*data-nw-loop-pause-hover="true"/);
  assert.match(html, /data-nw-loop-box-track=""/); assert.match(html, /data-nw-loop-box-clones=""[^>]*aria-hidden="true"/);
  assert.match(html, /href="\/details"/); assert.ok(!html.includes("onclick"));
  const editCanvas = renderToString(createElement(PageRenderer, { document: doc, canvas: { interactive: false } }));
  assert.match(editCanvas, /data-nw-loop-box-static=""/); assert.doesNotMatch(editCanvas, /data-nw-loop-box=""/);
});

test("closed standard embeds render fixed trusted iframe attributes and empty sources make no request", () => {
  const doc = structuredClone(fixture);
  doc.body = [
    { type: "element", id: "map", tag: "div", embed: { provider: "map", title: "周辺地図", source: "https://www.google.com/maps/embed?pb=!1m18!2m3%20Public%20Place" }, children: [] },
    { type: "element", id: "youtube", tag: "div", embed: { provider: "youtube", title: "紹介動画", source: "https://youtu.be/dQw4w9WgXcQ" }, children: [] },
    { type: "element", id: "vimeo", tag: "div", embed: { provider: "vimeo", title: "作品動画", source: "https://vimeo.com/123456789?h=Unlisted_1" }, children: [] },
    { type: "element", id: "lottie", tag: "div", embed: { provider: "lottie", title: "読み込み中も伝わるアニメーション", source: "https://lottie.host/123e4567-e89b-42d3-a456-426614174000/intro.json" }, children: [] },
    { type: "element", id: "facebook", tag: "div", embed: { provider: "facebook", title: "公開されたお知らせ", source: "https://facebook.com/example.page/posts/123456789/" }, children: [] },
    { type: "element", id: "x", tag: "div", embed: { provider: "x", title: "X の公開ポスト", source: "https://x.com/Example/status/1234567890123456789/" }, children: [] },
    { type: "element", id: "instagram", tag: "div", embed: { provider: "instagram", title: "Instagram の公開投稿", source: "https://instagram.com/p/AbCdEf12345" }, children: [] },
    { type: "element", id: "empty", tag: "div", embed: { provider: "map", title: "準備中の地図" }, children: [] }
  ];
  const html = renderPageToHtml(doc);
  assert.ok(!html.includes('data-nw-node="empty"')); assert.equal((html.match(/<iframe/g) ?? []).length, 3);
  assert.match(html, /data-nw-embed="map"><iframe src="https:\/\/www\.google\.com\/maps\/embed\?pb=/);
  assert.match(html, /title="周辺地図" loading="lazy" referrerPolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin"/);
  assert.match(html, /src="https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ"/);
  assert.match(html, /allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen=""/i);
  assert.match(html, /src="https:\/\/player\.vimeo\.com\/video\/123456789\?h=Unlisted_1"/);
  assert.match(html, /data-nw-embed="lottie"[^>]*data-nw-lottie-source="https:\/\/lottie\.host\/embed\/123e4567-e89b-42d3-a456-426614174000\/intro\.json"/);
  assert.match(html, /data-nw-lottie-fallback=""[^>]*role="img"[^>]*aria-label="読み込み中も伝わるアニメーション"/);
  assert.match(html, /data-nw-embed="facebook"[^>]*data-nw-facebook-source="https:\/\/www\.facebook\.com\/example\.page\/posts\/123456789"/);
  assert.match(html, /data-nw-facebook-status=""[^>]*role="status"[^>]*>Facebook の投稿はまだ読み込まれていません。<\/span>/);
  assert.match(html, /href="https:\/\/www\.facebook\.com\/example\.page\/posts\/123456789"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.match(html, /data-nw-facebook-load="" hidden=""[^>]*>Facebook の投稿を表示<\/button>/);
  assert.match(html, /data-nw-embed="x"[^>]*data-nw-social-source="https:\/\/x\.com\/example\/status\/1234567890123456789"/);
  assert.match(html, /data-nw-social-status=""[^>]*role="status"[^>]*>X のポストはまだ読み込まれていません。<\/span>/);
  assert.match(html, /href="https:\/\/x\.com\/example\/status\/1234567890123456789"[^>]*data-nw-social-link=""/);
  assert.match(html, /data-nw-embed="instagram"[^>]*data-nw-social-source="https:\/\/www\.instagram\.com\/p\/AbCdEf12345\/"/);
  assert.match(html, /data-nw-social-load="" hidden=""[^>]*>Instagram の投稿を表示<\/button>/);
  assert.equal((html.match(/<iframe/g) ?? []).length, 3, "遅延埋め込みの SSR は外部通信を開始しない");
  assert.ok(!html.includes("/plugins/post.php"));
  assert.ok(!html.includes("platform.twitter.com/widgets.js")); assert.ok(!html.includes("instagram.com/embed.js"));
  assert.ok(!html.includes('src="https://lottie.host/')); assert.ok(!html.includes(" inert="), "SSR markup avoids React 18/19 boolean inert serialization");
  assert.ok(!html.includes("javascript:")); assert.ok(!html.includes("srcDoc=")); assert.ok(!html.includes("pointer-events"));
  const placeholder = renderToString(createElement(PageRenderer, { document: doc, missingAssets: "placeholder" }));
  assert.match(placeholder, /data-nw-node="empty"[^>]*data-nw-empty-embed="map"[^>]*role="status"[^>]*>Map の URL を設定してください<\/div>/);
  const canvas = renderToString(createElement(PageRenderer, { document: doc, canvas: {} }));
  assert.match(canvas, /<iframe[^>]*style="[^"]*pointer-events:none/);
  assert.match(canvas, /data-nw-embed="facebook"[^>]*data-nw-facebook-static=""/);
  assert.match(canvas, /data-nw-embed="x"[^>]*data-nw-social-static=""/);
  assert.match(canvas, /data-nw-embed="instagram"[^>]*data-nw-social-static=""/);
  assert.equal((canvas.match(/<iframe/g) ?? []).length, 3, "編集キャンバスは遅延埋め込みを静的に保つ");
});

test("Blank embed resolves only an approved key and edit canvas never starts external communication", () => {
  const doc = structuredClone(fixture); doc.body = [
    { type: "element", id: "approved", tag: "div", embed: { provider: "blank", title: "公開ガイド", source: "public-guide" }, children: [] },
    { type: "element", id: "unknown", tag: "div", embed: { provider: "blank", title: "不明", source: "unknown-card" }, children: [] },
    { type: "element", id: "empty", tag: "div", embed: { provider: "blank", title: "未設定" }, children: [] }
  ];
  const blankEmbeds = createBlankEmbedRegistry({ parentOrigin: "https://site.example.test", entries: [
    { key: "public-guide", label: "公開ガイド", src: "https://embed.example.test/public/guide", sandbox: "scripts-forms" }
  ] });
  const withoutRegistry = renderPageToHtml(doc);
  assert.doesNotMatch(withoutRegistry, /embed\.example\.test|<iframe/u);
  const placeholder = renderToString(createElement(PageRenderer, { document: doc, missingAssets: "placeholder" }));
  assert.match(placeholder, /registry が接続されていません/u); assert.doesNotMatch(placeholder, /embed\.example\.test|<iframe/u);
  const editCanvas = renderToString(createElement(PageRenderer, { document: doc, blankEmbeds, missingAssets: "placeholder", canvas: { interactive: false } }));
  assert.match(editCanvas, /data-nw-blank-static=""/u); assert.match(editCanvas, /公開ガイド（プレビューで表示）/u);
  assert.doesNotMatch(editCanvas, /embed\.example\.test|<iframe/u);
  assert.match(editCanvas, /この埋め込みはホストで承認されていません/u);
  const html = renderPageToHtml(doc, {}, { blankEmbeds });
  assert.equal((html.match(/<iframe/g) ?? []).length, 1);
  assert.match(html, /data-nw-blank-key="public-guide"/u);
  assert.match(html, /src="https:\/\/embed\.example\.test\/public\/guide"[^>]*title="公開ガイド"[^>]*sandbox="allow-scripts allow-forms"/u);
  assert.match(html, /href="https:\/\/embed\.example\.test\/public\/guide"[^>]*rel="noopener noreferrer"[^>]*data-nw-blank-fallback=""/u);
  assert.doesNotMatch(html, /unknown-card|data-nw-node="unknown"/u);
  const preview = renderToString(createElement(PageRenderer, { document: doc, blankEmbeds, canvas: { interactive: true } }));
  assert.match(preview, /src="https:\/\/embed\.example\.test\/public\/guide"/u);
  const shared = (pageId) => ({ schemaVersion: 1, siteId: doc.siteId, pageId, locale: doc.locale, revision: 1, title: pageId, tokens: {}, body: [] });
  const presentation = { schemaVersion: 1, siteId: doc.siteId, locale: doc.locale, version: "site-v1", reset: "neutral-v1", tokens: {}, fonts: [], layout: { base: {} },
    shared: { header: shared("shared-header"), footer: shared("shared-footer") } };
  const siteHtml = renderSitePageToHtml(doc, presentation, {}, { blankEmbeds });
  assert.match(siteHtml, /data-nw-blank-key="public-guide"/u); assert.equal((siteHtml.match(/<iframe/g) ?? []).length, 1);
  assert.match(renderToString(createElement(SitePageRenderer, { document: doc, presentation, blankEmbeds })), /embed\.example\.test\/public\/guide/u);
});

test("unsafe resolved asset maps throw before any block executes", () => {
  const doc = imageDocument(); let called = 0;
  doc.body.unshift({ type: "component", id: "notice", block: "Notice", props: {} });
  const blocks = { Notice: { props: {}, component: () => { called++; return null; } } };
  for (const src of ["javascript:alert(1)", "data:image/png;base64,AAAA", "http://example.com/a.png", "#x", '/a.png" onerror="x', "/a b.png", "/a<b.png"]) {
    assert.throws(() => renderPageToHtml(doc, blocks, { assets: { "uploads:sea": { src } } }), DocumentValidationError, src);
  }
  assert.throws(() => renderPageToHtml(doc, blocks, { assets: { "uploads:sea": { src: "/a.png", url: "/b.png" } } }), DocumentValidationError);
  assert.equal(called, 0);
});

test("background images compile from resolved assets and only the unresolved declaration is omitted", () => {
  const doc = structuredClone(fixture);
  doc.body[0].style.base.backgroundImage = { asset: { provider: "uploads", id: "a" } }; doc.body[0].style.base.backgroundSize = "cover";
  doc.body[0].style.responsive[0].declarations.backgroundImage = { asset: { provider: "uploads", id: "wide" } };
  const css = generatePageCss(doc, {}, { "uploads:a": { src: "/media/a.webp" } });
  assert.ok(css.includes('background-image:url("/media/a.webp");background-size:cover;'));
  assert.ok(css.includes("@media (min-width:768px)") && css.includes("max-width:64rem;"));
  assert.equal(css.match(/background-image/g).length, 1);
  assert.ok(!generatePageCss(doc).includes("background-image")); assert.ok(generatePageCss(doc).includes("background-size:cover;"));
  assert.throws(() => generatePageCss(doc, {}, { "uploads:a": { src: "javascript:alert(1)" } }), DocumentValidationError);
  assert.ok(renderPageToHtml(doc, {}, { assets: { "uploads:a": { src: "/media/a.webp" } } }).includes('background-image:url("/media/a.webp");'));
});

test("canvas rendering resolves viewport-height units and root-relative image URLs without changing public output", () => {
  const doc = structuredClone(fixture);
  doc.body[0].style = { ...(doc.body[0].style ?? {}), base: { ...(doc.body[0].style?.base ?? {}), minHeight: "100vh", height: "60vh" } };
  doc.body[0].children.push({ type: "element", id: "placeholder-image", tag: "img", attrs: { src: "/placeholder.svg", alt: "" }, children: [] });
  const publicHtml = renderPageToHtml(doc);
  assert.ok(publicHtml.includes("min-height:100vh"), "public CSS keeps viewport units");
  assert.ok(publicHtml.includes('src="/placeholder.svg"'), "public HTML keeps root-relative URLs");
  const canvasHtml = renderToString(createElement(PageRenderer, { document: doc, canvas: { viewportHeight: 900, siteOrigin: "https://site.example" } }));
  assert.ok(canvasHtml.includes("min-height:900px"), "canvas resolves vh against the 100% viewport height");
  assert.ok(canvasHtml.includes("height:540px"), "every vh value is resolved");
  assert.ok(!/\d(?:dvh|svh|lvh|vh)\b/.test(canvasHtml.replace(/<[^>]*data-nw-scope="[^"]*"/g, "")), "no viewport-height unit remains in canvas CSS");
  assert.ok(canvasHtml.includes('src="https://site.example/placeholder.svg"'), "canvas resolves root-relative image URLs against the site origin");
  assert.ok(canvasHtml.includes(`data-nw-scope="${pageScope(doc)}"`), "scope names are not rewritten");
});
