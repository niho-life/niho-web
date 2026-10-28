import assert from "node:assert/strict";
import { test } from "node:test";
import { cssForSitePresentation, initializeSitePresentation, parsePageDocument, parseSitePresentation, presentationAssetDocument } from "@niho/web/core";
import { renderPageToHtml, renderSitePageToHtml } from "@niho/web/server";
import { createExternalFramePolicy } from "@niho/web";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SitePageRenderer } from "@niho/web/react";

const element = (id, tag, text, style) => ({ type: "element", id, tag, ...(style ? { style } : {}), children: text === undefined ? [] : [{ type: "text", text }] });
const page = (siteId, locale, pageId, body) => ({ schemaVersion: 1, siteId, pageId, locale, revision: 1, title: pageId, tokens: {}, body });
const site = (siteId = "synthetic", locale = "en") => ({
  schemaVersion: 1, siteId, locale, version: "site-v7:deps-a1", reset: "neutral-v1", tokens: {},
  layout: { base: { display: "flex", flexDirection: "column", alignItems: "center", width: "100%" } },
  fonts: [{ family: "Synthetic Sans", sources: [{ url: "https://media.example.test/fonts/synthetic.woff2", format: "woff2" }], weight: "100 900", display: "swap", unicodeRange: "U+0000-00FF" }],
  shared: {
    header: page(siteId, locale, "shared-header", [element("header-nav", "header", "Shared header")]),
    footer: page(siteId, locale, "shared-footer", [element("footer-note", "footer", "Shared footer")]),
  },
});
const siteWithMenu = (siteId = "synthetic", locale = "en") => {
  const presentation = site(siteId, locale);
  presentation.shared.header.body[0].children.push({ type: "element", id: "menu-trigger-node", tag: "a", attrs: { id: "menu-trigger", href: "#site-menu" }, children: [{ type: "text", text: "Menu" }] });
  presentation.overlays = [{ id: "site-menu", label: "Site menu", triggerIds: ["menu-trigger"], closeIds: ["menu-close"], document:
    page(siteId, locale, "shared-menu", [{ type: "element", id: "menu-panel", tag: "nav", children: [
      { type: "element", id: "menu-first", tag: "a", attrs: { href: "/one" }, children: [{ type: "text", text: "First menu item" }] },
      { type: "element", id: "menu-close-node", tag: "a", attrs: { id: "menu-close", href: "#site-menu" }, children: [{ type: "text", text: "Close" }] },
    ] }]) }];
  return presentation;
};

test("public runtime toggles VideoWithButton by click and native media events, then cleans up", async () => {
  const document = page("synthetic", "en", "video", [{ type: "element", id: "video-box", tag: "div", interaction: { type: "video-toggle" }, children: [
    { type: "element", id: "movie", tag: "video", attrs: { src: "/intro.mp4", "aria-label": "Intro", controls: true }, children: [] },
    { type: "element", id: "toggle", tag: "button", attrs: { type: "button", "aria-label": "動画を視聴", "aria-pressed": "false" }, children: [{ type: "text", text: "見る" }] }
  ] }]);
  const dom = new JSDOM(`<!doctype html><body>${renderPageToHtml(document)}</body>`), video = dom.window.document.querySelector("video"), control = dom.window.document.querySelector("button");
  let paused = true, plays = 0, pauses = 0;
  Object.defineProperty(video, "paused", { configurable: true, get: () => paused });
  Object.defineProperty(video, "ended", { configurable: true, get: () => false });
  video.play = () => { plays++; paused = false; video.dispatchEvent(new dom.window.Event("play")); return Promise.resolve(); };
  video.pause = () => { pauses++; paused = true; video.dispatchEvent(new dom.window.Event("pause")); };
  const cleanup = initializeSitePresentation(dom.window.document);
  control.click(); await Promise.resolve();
  assert.equal(plays, 1); assert.equal(control.getAttribute("aria-label"), "動画を一時停止"); assert.equal(control.getAttribute("aria-pressed"), "true"); assert.equal(control.textContent, "一時停止");
  control.click(); assert.equal(pauses, 1); assert.equal(control.getAttribute("aria-label"), "動画を視聴"); assert.equal(control.getAttribute("aria-pressed"), "false"); assert.equal(control.textContent, "見る");
  paused = false; video.dispatchEvent(new dom.window.Event("play")); assert.equal(control.getAttribute("aria-pressed"), "true", "native controls also synchronize the button");
  cleanup(); assert.equal(control.getAttribute("aria-label"), "動画を視聴"); assert.equal(control.getAttribute("aria-pressed"), "false"); assert.equal(control.textContent, "見る");
  control.click(); assert.equal(plays, 1, "cleanup removes the binding"); dom.window.close();
});

test("Lottie runtime mounts only the fixed canonical iframe when motion is allowed and fully cleans up", () => {
  const document = page("synthetic", "en", "lottie", [{ type: "element", id: "motion", tag: "div", embed: { provider: "lottie", title: "Calm loading animation", source: "https://lottie.host/123e4567-e89b-42d3-a456-426614174000/calm.json" }, children: [] }]);
  const dom = new JSDOM(`<!doctype html><body>${renderPageToHtml(document)}</body>`), root = dom.window.document.querySelector('[data-nw-embed="lottie"]');
  assert.ok(root.querySelector('[data-nw-lottie-fallback][role="img"]')); assert.equal(root.querySelector("iframe"), null, "SSR is static");
  let reduced = false, listeners = [];
  dom.window.matchMedia = () => ({ get matches() { return reduced; }, addEventListener: (_type, listener) => listeners.push(listener), removeEventListener: (_type, listener) => { listeners = listeners.filter((entry) => entry !== listener); } });
  const editCleanup = initializeSitePresentation(dom.window.document, { interactive: false });
  assert.equal(root.querySelector("iframe"), null, "edit mode never loads the player"); editCleanup();
  reduced = true;
  const cleanup = initializeSitePresentation(dom.window.document);
  assert.equal(root.querySelector("iframe"), null, "reduced motion prevents the initial request");
  reduced = false; listeners.forEach((listener) => listener(new dom.window.Event("change")));
  const frame = root.querySelector("iframe");
  assert.equal(frame.getAttribute("src"), "https://lottie.host/embed/123e4567-e89b-42d3-a456-426614174000/calm.json");
  assert.equal(frame.getAttribute("sandbox"), "allow-scripts"); assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer"); assert.equal(frame.getAttribute("loading"), "lazy");
  assert.equal(frame.getAttribute("title"), "Calm loading animation"); assert.equal(frame.getAttribute("tabindex"), "-1"); assert.equal(frame.style.pointerEvents, "none");
  assert.equal(frame.hasAttribute("allow"), false); assert.equal(frame.hasAttribute("allowfullscreen"), false);
  reduced = true; listeners.forEach((listener) => listener(new dom.window.Event("change"))); assert.equal(root.querySelector("iframe"), null);
  reduced = false; listeners.forEach((listener) => listener(new dom.window.Event("change"))); assert.ok(root.querySelector("iframe"));
  const fallback = root.querySelector('[data-nw-lottie-fallback]'); cleanup();
  assert.equal(root.querySelector("iframe"), null); assert.ok(fallback.isConnected); assert.equal(listeners.length, 0);
  reduced = false; listeners.forEach((listener) => listener(new dom.window.Event("change"))); assert.equal(root.querySelector("iframe"), null);
  root.dataset.nwLottieSource = "https://untrusted.example/animation.json";
  const invalidCleanup = initializeSitePresentation(dom.window.document); assert.equal(root.querySelector("iframe"), null, "runtime revalidates the canonical origin"); invalidCleanup(); dom.window.close();
});

test("Facebook runtime waits for explicit activation, revalidates canonical data and keeps the link fallback", () => {
  const source = "https://www.facebook.com/example.page/posts/123456789";
  const document = page("synthetic", "ja", "facebook", [{ type: "element", id: "post", tag: "div", embed: { provider: "facebook", title: "Facebook のお知らせ", source }, children: [] }]);
  const dom = new JSDOM(`<!doctype html><body>${renderPageToHtml(document)}</body>`), root = dom.window.document.querySelector('[data-nw-embed="facebook"]');
  const button = root.querySelector("[data-nw-facebook-load]"), link = root.querySelector("[data-nw-facebook-link]");
  assert.equal(root.querySelector("iframe"), null); assert.equal(button.hidden, true); assert.equal(link.getAttribute("href"), source);
  const staticCleanup = initializeSitePresentation(dom.window.document, { interactive: false });
  assert.equal(button.hidden, true); button.click(); assert.equal(root.querySelector("iframe"), null); staticCleanup();
  const cleanup = initializeSitePresentation(dom.window.document);
  assert.equal(button.hidden, false); assert.equal(root.querySelector("iframe"), null, "runtime reveal alone makes no third-party request");
  button.click();
  const frame = root.querySelector("iframe[data-nw-facebook-frame]");
  assert.equal(root.querySelector("[data-nw-facebook-status]").style.visibility, "hidden");
  assert.equal(frame.getAttribute("src"), "https://www.facebook.com/plugins/post.php?href=https%3A%2F%2Fwww.facebook.com%2Fexample.page%2Fposts%2F123456789");
  assert.equal(frame.getAttribute("title"), "Facebook のお知らせ"); assert.equal(frame.getAttribute("sandbox"), "allow-scripts allow-same-origin");
  assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer"); assert.equal(frame.getAttribute("loading"), "lazy");
  assert.equal(frame.hasAttribute("allow"), false); assert.equal(frame.hasAttribute("allowfullscreen"), false); assert.equal(link.isConnected, true); assert.equal(button.hidden, true);
  cleanup(); assert.equal(root.querySelector("iframe"), null); assert.equal(button.hidden, true); assert.equal(link.isConnected, true);
  assert.equal(root.querySelector("[data-nw-facebook-status]").style.visibility, "");
  button.click(); assert.equal(root.querySelector("iframe"), null, "cleanup removes the activation listener");
  root.dataset.nwFacebookSource = "https://evil.example/post"; link.setAttribute("href", "https://evil.example/post");
  const invalidCleanup = initializeSitePresentation(dom.window.document); assert.equal(button.hidden, true); button.click(); assert.equal(root.querySelector("iframe"), null); invalidCleanup(); dom.window.close();
});

test("X と Instagram runtime は明示操作後だけ opaque srcdoc を生成して cleanup する", () => {
  const cases = [
    { provider: "x", source: "https://x.com/example/status/1234567890123456789", title: "X のお知らせ", script: "https://platform.twitter.com/widgets.js", markup: "twitter-tweet" },
    { provider: "instagram", source: "https://www.instagram.com/reel/AbCdEf12345/", title: "Instagram のお知らせ", script: "https://www.instagram.com/embed.js", markup: "instagram-media" }
  ];
  const document = page("synthetic", "ja", "social", cases.map(({ provider, source, title }) => ({ type: "element", id: provider, tag: "div", embed: { provider, source, title }, children: [] })));
  const dom = new JSDOM(`<!doctype html><body>${renderPageToHtml(document)}</body>`);
  for (const entry of cases) {
    const root = dom.window.document.querySelector(`[data-nw-embed="${entry.provider}"]`), button = root.querySelector("[data-nw-social-load]"), link = root.querySelector("[data-nw-social-link]");
    assert.equal(root.querySelector("iframe"), null); assert.equal(button.hidden, true); assert.equal(link.getAttribute("href"), entry.source);
  }
  const staticCleanup = initializeSitePresentation(dom.window.document, { interactive: false });
  for (const entry of cases) assert.equal(dom.window.document.querySelector(`[data-nw-embed="${entry.provider}"] [data-nw-social-load]`).hidden, true);
  staticCleanup();
  const cleanup = initializeSitePresentation(dom.window.document);
  for (const entry of cases) {
    const root = dom.window.document.querySelector(`[data-nw-embed="${entry.provider}"]`), button = root.querySelector("[data-nw-social-load]");
    assert.equal(button.hidden, false); assert.equal(root.querySelector("iframe"), null, "buttonを表示しただけでは外部通信しない");
    button.click();
    const frame = root.querySelector(`iframe[data-nw-${entry.provider}-frame]`), srcdoc = frame.getAttribute("srcdoc");
    assert.equal(frame.hasAttribute("src"), false); assert.equal(frame.getAttribute("sandbox"), "allow-scripts"); assert.equal(frame.getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(frame.getAttribute("loading"), "lazy"); assert.equal(frame.getAttribute("title"), entry.title); assert.equal(frame.hasAttribute("allow"), false); assert.equal(frame.hasAttribute("allowfullscreen"), false);
    assert.match(srcdoc, new RegExp(entry.markup)); assert.ok(srcdoc.includes(entry.script)); assert.ok(srcdoc.includes(entry.source));
    assert.equal(root.querySelector("[data-nw-social-status]").style.visibility, "hidden"); assert.equal(button.hidden, true); assert.ok(root.querySelector("[data-nw-social-link]").isConnected);
  }
  cleanup();
  for (const entry of cases) {
    const root = dom.window.document.querySelector(`[data-nw-embed="${entry.provider}"]`), button = root.querySelector("[data-nw-social-load]");
    assert.equal(root.querySelector("iframe"), null); assert.equal(button.hidden, true); assert.equal(root.querySelector("[data-nw-social-status]").style.visibility, "");
    button.click(); assert.equal(root.querySelector("iframe"), null, "cleanup は activation listener も除く");
  }
  const xRoot = dom.window.document.querySelector('[data-nw-embed="x"]');
  xRoot.dataset.nwSocialSource = "https://evil.example/post"; xRoot.querySelector("[data-nw-social-link]").setAttribute("href", "https://evil.example/post");
  const invalidCleanup = initializeSitePresentation(dom.window.document); assert.equal(xRoot.querySelector("[data-nw-social-load]").hidden, true); invalidCleanup(); dom.window.close();
});

test("Loop Box fills the viewport with inert safe copies, pauses, honors reduced motion and cleans up", async () => {
  const document = page("synthetic", "en", "loop", [{ type: "element", id: "loop", tag: "div", interaction: { type: "loop-box", speed: 60, pauseOnHover: true },
    attrs: { "aria-label": "Highlights" }, style: { base: { display: "flex", flexDirection: "row", gap: 0, overflow: "hidden" } }, children: [
      { type: "element", id: "link", tag: "a", attrs: { id: "featured", href: "/details" }, children: [{ type: "text", text: "Original link" }] },
      { type: "element", id: "photo", tag: "img", attrs: { src: "/photo.webp", alt: "Photo", width: 200, height: 100 }, children: [] }
    ] }]);
  const dom = new JSDOM(`<!doctype html><body>${renderPageToHtml(document)}</body>`, { url: "https://example.test" });
  const root = dom.window.document.querySelector("[data-nw-loop-box]"), track = root.querySelector("[data-nw-loop-box-track]"), mount = root.querySelector("[data-nw-loop-box-clones]");
  Object.defineProperty(root, "clientWidth", { configurable: true, value: 500 });
  root.getBoundingClientRect = () => ({ width: 500, height: 100, top: 0, right: 500, bottom: 100, left: 0, x: 0, y: 0, toJSON() {} });
  track.getBoundingClientRect = () => ({ width: 200, height: 100, top: 0, right: 200, bottom: 100, left: 0, x: 0, y: 0, toJSON() {} });
  let reduced = false, mediaListeners = [];
  dom.window.matchMedia = () => ({ get matches() { return reduced; }, addEventListener: (_type, listener) => mediaListeners.push(listener), removeEventListener: (_type, listener) => { mediaListeners = mediaListeners.filter((entry) => entry !== listener); } });
  const animations = [];
  dom.window.HTMLElement.prototype.animate = function (frames, options) {
    const animation = { frames, options, pauses: 0, plays: 0, cancelled: false, pause() { this.pauses++; }, play() { this.plays++; }, cancel() { this.cancelled = true; } };
    animations.push(animation); return animation;
  };
  const cleanup = initializeSitePresentation(dom.window.document);
  assert.equal(mount.children.length, 5, "copies cover the 500px viewport beyond one 200px sequence");
  assert.equal(animations.length, 6); assert.equal(animations[0].options.duration, 200 / 60 * 1000); assert.equal(animations[0].frames[1].transform, "translate3d(-200px,0,0)");
  const copy = mount.firstElementChild;
  assert.equal(copy.getAttribute("aria-hidden"), "true"); assert.equal(copy.hasAttribute("inert"), true);
  assert.equal(copy.hasAttribute("data-nw-loop-box-track"), false, "runtime markers are not duplicated");
  assert.equal(copy.querySelector("#featured"), null); assert.equal(copy.querySelector("a").hasAttribute("href"), false); assert.equal(copy.querySelector("a").tabIndex, -1);
  assert.equal(copy.querySelector("img").getAttribute("src"), "/photo.webp"); assert.equal(copy.querySelector("img").getAttribute("loading"), "lazy");
  assert.notEqual(copy.querySelector("img").style.visibility, "hidden", "image marquees keep their visual content");
  assert.equal(root.querySelector('[data-nw-loop-box-track] #featured').getAttribute("href"), "/details", "the accessible original is unchanged");
  root.dispatchEvent(new dom.window.MouseEvent("mouseenter")); assert.ok(animations.every((animation) => animation.pauses === 1));
  root.dispatchEvent(new dom.window.MouseEvent("mouseleave")); assert.ok(animations.every((animation) => animation.plays === 1));
  reduced = true; mediaListeners.forEach((listener) => listener(new dom.window.Event("change"))); await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.equal(mount.children.length, 0); assert.ok(animations.every((animation) => animation.cancelled));
  reduced = false; mediaListeners.forEach((listener) => listener(new dom.window.Event("change"))); await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.equal(mount.children.length, 5);
  const count = animations.length; cleanup(); assert.equal(mount.children.length, 0); assert.equal(root.getAttribute("style"), null);
  dom.window.dispatchEvent(new dom.window.Event("resize")); await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.equal(mount.children.length, 0); assert.equal(animations.length, count, "cleanup removes resize and media listeners");
  root.dataset.nwLoopSpeed = "0"; const stopped = initializeSitePresentation(dom.window.document);
  assert.equal(mount.children.length, 0); assert.equal(animations.length, count, "speed 0 keeps the original static"); stopped(); dom.window.close();
});

test("Loop Box flexDirection selects the horizontal or vertical axis and reverse sign", () => {
  for (const [direction, expected] of [["row", "translate3d(-100px,0,0)"], ["row-reverse", "translate3d(100px,0,0)"], ["column", "translate3d(0,-100px,0)"], ["column-reverse", "translate3d(0,100px,0)"]]) {
    const document = page("synthetic", "en", `loop-${direction}`, [{ type: "element", id: "loop", tag: "div", interaction: { type: "loop-box", speed: 50, pauseOnHover: false },
      style: { base: { display: "flex", flexDirection: direction, gap: 0, overflow: "hidden" } }, children: [element("card", "p", "Card")] }]);
    const dom = new JSDOM(`<!doctype html><body>${renderPageToHtml(document)}</body>`), root = dom.window.document.querySelector("[data-nw-loop-box]"), track = root.querySelector("[data-nw-loop-box-track]");
    Object.defineProperties(root, { clientWidth: { configurable: true, value: 300 }, clientHeight: { configurable: true, value: 300 } });
    root.getBoundingClientRect = () => ({ width: 300, height: 300, top: 0, right: 300, bottom: 300, left: 0, x: 0, y: 0, toJSON() {} });
    track.getBoundingClientRect = () => ({ width: 100, height: 100, top: 0, right: 100, bottom: 100, left: 0, x: 0, y: 0, toJSON() {} });
    dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    let frames; dom.window.HTMLElement.prototype.animate = (keyframes) => { frames ??= keyframes; return { cancel() {}, pause() {}, play() {} }; };
    const cleanup = initializeSitePresentation(dom.window.document);
    assert.equal(frames[1].transform, expected, direction); cleanup(); dom.window.close();
  }
});

test("native presentation is generic and canvas/SSR share one reset, font and scoped composition", () => {
  const document = page("synthetic-two", "fr", "business", [element("body-copy", "p", "Body copy")]);
  const presentation = site("synthetic-two", "fr");
  const parsed = parseSitePresentation(presentation, document);
  const output = cssForSitePresentation(parsed, document);
  const html = renderSitePageToHtml(document, parsed);
  assert.match(output.css, /@font-face\{font-family:"Synthetic Sans"/);
  assert.match(output.css, /:where\(h1,h2,h3,h4,h5,h6,p,ul,ol,dl,dd,figure,blockquote\)\{margin:0;padding:0\}/);
  assert.match(output.css, /details:not\(\[open\]\)>:not\(summary\)\{display:none!important\}/);
  assert.match(output.css, /summary::-webkit-details-marker\{display:none\}/);
  assert.ok(html.includes(output.css));
  for (const text of ["Shared header", "Body copy", "Shared footer"]) assert.ok(html.includes(text), text);
  const owners = [...html.matchAll(/data-nw-owner="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(new Set(owners).size >= 3, "layout/header/body/footer scopes must not collide");
  assert.equal(parsed.siteId, "synthetic-two");
  const dom = new JSDOM(html);
  const root = dom.window.document.querySelector('[data-nw-node="layout"]');
  assert.equal(dom.window.getComputedStyle(root).display, "flex", "native layout must actually match its generated CSS selector");
  const slot = dom.window.document.querySelector('[data-nw-presentation-body]');
  assert.equal(dom.window.getComputedStyle(slot).display, "contents", "composition wrappers must not add authored layout boxes");
  dom.window.close();
});

test("canonical shared page is substituted only in its native slot", () => {
  const presentation = site(), edited = page("synthetic", "en", "shared-header", [element("edited-nav", "header", "Edited header")]);
  const html = renderSitePageToHtml(edited, presentation);
  assert.equal((html.match(/Edited header/g) ?? []).length, 1);
  assert.equal(html.includes("Body copy"), false);
  assert.ok(html.includes("Shared footer"));
});

test("generic second-site overlay renders hidden, substitutes its canonical document and collects it once", () => {
  const document = page("second-site", "fr", "body", [element("body-copy", "p", "Second body")]);
  const presentation = parseSitePresentation(siteWithMenu("second-site", "fr"), document);
  const html = renderSitePageToHtml(document, presentation);
  assert.match(html, /id="site-menu"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*hidden=""/);
  assert.match(html, /id="menu-trigger"[^>]*aria-controls="site-menu"[^>]*aria-expanded="false"[^>]*data-nw-overlay-open="site-menu"/);
  assert.match(html, /id="menu-close"[^>]*data-nw-overlay-close="site-menu"/);
  assert.equal((html.match(/First menu item/g) ?? []).length, 1);
  const edited = page("second-site", "fr", "shared-menu", [element("edited-menu", "nav", "Edited menu")]);
  const editedHtml = renderSitePageToHtml(edited, presentation);
  assert.equal((editedHtml.match(/Edited menu/g) ?? []).length, 1);
  assert.equal(editedHtml.includes("First menu item"), false);
  assert.match(editedHtml, /data-nw-overlay-editing=""/);
  const assets = presentationAssetDocument(edited, presentation);
  assert.equal(assets.body.filter((node) => node.id === "edited-menu").length, 1);
  assert.equal(assets.body.some((node) => node.id === "menu-panel"), false);
});

test("presentation schema rejects hostile resources, mismatched targets, extras and unbounded input", () => {
  const document = page("synthetic", "en", "body", []);
  const reject = (mutate) => { const input = structuredClone(site()); mutate(input); assert.throws(() => parseSitePresentation(input, document)); };
  reject((input) => { input.fonts[0].sources[0].url = "javascript:alert(1)"; });
  reject((input) => { input.fonts[0].sources[0].url = "http://media.example.test/font.woff2"; });
  reject((input) => { input.fonts[0].sources[0].format = "truetype"; });
  reject((input) => { input.fonts[0].unicodeRange = "U+0000-00FF;src:url(x)"; });
  reject((input) => { input.fonts[0].script = "alert(1)"; });
  reject((input) => { input.fonts[0].weight = "900 100"; });
  reject((input) => { input.shared.header.siteId = "other"; });
  reject((input) => { input.shared.footer.pageId = "shared-header"; });
  reject((input) => { input.siteId = "other"; });
  reject((input) => { input.fonts = Array.from({ length: 513 }, () => input.fonts[0]); });
  reject((input) => { input.overlays = siteWithMenu().overlays; input.overlays[0].id = "bad target"; });
  reject((input) => { input.overlays = siteWithMenu().overlays; input.overlays[0].document.siteId = "foreign"; });
  reject((input) => { input.overlays = siteWithMenu().overlays; input.overlays[0].document.pageId = "shared-header"; });
  reject((input) => { input.overlays = siteWithMenu().overlays; input.overlays[0].closeIds = ["menu-trigger"]; });
  reject((input) => { input.overlays = siteWithMenu().overlays; input.overlays.push({ ...structuredClone(input.overlays[0]), id: "menu-trigger", document: { ...input.overlays[0].document, pageId: "second-menu" }, triggerIds: ["second-trigger"], closeIds: ["second-close"] }); });
  reject((input) => { input.overlays = Array.from({ length: 9 }, (_, index) => ({ ...siteWithMenu().overlays[0], id: `menu-${index}`, document: { ...siteWithMenu().overlays[0].document, pageId: `menu-page-${index}` }, triggerIds: [`trigger-${index}`], closeIds: [`close-${index}`] })); });
});

test("trusted overlay runtime opens, traps focus, closes and fully cleans up", () => {
  const document = page("synthetic", "en", "body", []), html = renderSitePageToHtml(document, siteWithMenu());
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: "https://example.test" });
  const root = dom.window.document, toggle = root.getElementById("menu-trigger"), overlay = root.getElementById("site-menu"), closeControl = root.getElementById("menu-close");
  const cleanup = initializeSitePresentation(root);
  root.documentElement.style.overflow = "clip";
  root.documentElement.style.scrollbarGutter = "auto";
  overlay.querySelector("nav").insertAdjacentHTML("afterbegin", '<a href="/hidden" style="display:none">Invisible item</a>');
  toggle.focus(); toggle.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  toggle.click();
  assert.equal(overlay.hidden, false); assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(root.documentElement.style.overflow, "hidden");
  assert.equal(root.activeElement.textContent, "First menu item", "focus starts at a visible content control");
  toggle.focus(); root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true }));
  assert.equal(root.activeElement.textContent, "First menu item", "focus cannot escape the dialog");
  closeControl.focus(); closeControl.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true }));
  assert.equal(root.activeElement.textContent, "First menu item", "Tab wraps to the first content control");
  root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  assert.equal(overlay.hidden, true); assert.equal(toggle.getAttribute("aria-expanded"), "false"); assert.equal(root.activeElement, toggle); assert.equal(root.documentElement.style.overflow, "clip");
  toggle.click(); assert.equal(overlay.hidden, false);
  const navigation = root.querySelector('[data-nw-node="menu-panel"]').querySelector('a[href="/one"]');
  const event = new dom.window.Event("click", { bubbles: true, cancelable: true });
  navigation.dispatchEvent(event); assert.equal(overlay.hidden, true); assert.equal(event.defaultPrevented, false);
  toggle.click();
  const previewClick = new dom.window.Event("click", { bubbles: true, cancelable: true });
  previewClick.preventDefault(); navigation.dispatchEvent(previewClick);
  assert.equal(overlay.hidden, true); assert.equal(root.activeElement, toggle, "blocked preview navigation returns focus to the opener");
  toggle.click(); assert.equal(overlay.hidden, false); cleanup();
  assert.equal(overlay.hidden, true); assert.equal(root.documentElement.style.overflow, "clip");
  assert.equal(root.documentElement.style.scrollbarGutter, "auto");
  toggle.click(); assert.equal(overlay.hidden, true, "cleanup removes control listeners");
  dom.window.close();
});

test("background asset references remain native through parse, asset collection and render", () => {
  const backgroundImage = { asset: { provider: "synthetic-assets", id: "hero" } };
  const document = page("synthetic", "en", "business", [element("hero", "section", undefined, { base: { width: "100%", height: "5px", backgroundImage } })]);
  const parsed = parsePageDocument(document), presentation = parseSitePresentation(site(), parsed);
  const merged = presentationAssetDocument(parsed, presentation);
  assert.deepEqual(parsed.body[0].style.base.backgroundImage, backgroundImage);
  assert.deepEqual(merged.body.find((node) => node.id === "hero").style.base.backgroundImage, backgroundImage);
  const html = renderSitePageToHtml(parsed, presentation, {}, { assets: { "synthetic-assets:hero": { src: "https://media.example.test/hero.webp" } } });
  for (const declaration of ["background-image:url(\"https://media.example.test/hero.webp\");", "height:5px;", "width:100%;"]) assert.ok(html.includes(declaration), declaration);
  assert.equal(html.includes("min-height:48px"), false);
});

const hostBlocks = {
  Gallery: { props: { variant: { type: "enum", values: ["wide", "compact"], required: true } }, slots: { image: { label: "画像", style: ["height"] } }, component: () => "REAL HOST COMPONENT" },
};
function siteWithHostView() {
  const presentation = site();
  presentation.hostViews = [{
    id: "gallery-wide", block: "Gallery", props: { variant: "wide" },
    document: page("synthetic", "en", "host-gallery-wide", [{ type: "element", id: "gallery-root", tag: "section", children: [
      { type: "element", id: "previous", tag: "a", attrs: { href: "#gallery-root" }, children: [{ type: "text", text: "Previous" }] },
      { type: "element", id: "next", tag: "a", attrs: { href: "#gallery-root" }, children: [{ type: "text", text: "Next" }] },
      { type: "element", id: "pause", tag: "a", attrs: { href: "#gallery-root" }, children: [{ type: "text", text: "Pause" }] },
      { type: "element", id: "slide-one", tag: "div", style: { base: { backgroundImage: { asset: { provider: "gallery", id: "one" } } } }, children: [{ type: "text", text: "REAL SLIDE ONE" }] },
      { type: "element", id: "slide-two", tag: "div", children: [{ type: "text", text: "REAL SLIDE TWO" }] },
      { type: "element", id: "map", tag: "div", children: [] },
    ] }]),
    slotBindings: { image: ["slide-one", "slide-two"] },
    externalFrames: [{ nodeId: "map", src: "https://maps.example.test/embed/exact?place=NIHO%20Kamakura", title: "Read only map", allowFullScreen: true, frameKey: "gallery-map", autoHeightMax: 900 }],
    carousel: { rootId: "gallery-root", slideIds: ["slide-one", "slide-two"], previousIds: ["previous"], nextIds: ["next"], playPauseIds: ["pause"], autoplayMs: 4000, loop: true, swipe: true },
  }];
  return presentation;
}

test("host block views require exact normalized props, render in a distinct scope, and remain outside the page document", () => {
  const document = page("synthetic", "en", "body", [{ type: "component", id: "gallery-block", block: "Gallery", props: { variant: "wide" }, slots: { image: { base: { height: "240px" } } } }]);
  const presentation = parseSitePresentation(siteWithHostView(), document, hostBlocks);
  const html = renderSitePageToHtml(document, presentation, hostBlocks, { assets: { "gallery:one": { src: "https://media.example.test/one.webp" } } });
  assert.match(html, /data-nw-host-view="gallery-wide"/);
  assert.match(html, /REAL SLIDE ONE/); assert.match(html, /REAL SLIDE TWO/);
  assert.match(html, /data-nw-carousel-slide="1"[^>]*hidden=""/);
  assert.match(html, /iframe[^>]*src="https:\/\/maps\.example\.test\/embed\/exact\?place=NIHO%20Kamakura"[^>]*title="Read only map"/);
  assert.match(html, /iframe[^>]*sandbox="allow-scripts"/); assert.equal(/iframe[^>]* allow=/.test(html), false, "view descriptors cannot add feature permissions");
  assert.match(html, /style="width:100%;height:100%;border:0;display:block"/);
  assert.match(html, /data-nw-slot="image"/); assert.match(html, /height:240px/);
  const owners = [...html.matchAll(/data-nw-owner="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(new Set(owners).size >= 4, "host view uses its own owner scope");
  assert.equal(document.body[0].type, "component"); assert.equal(Object.hasOwn(document, "hostViews"), false);
  const assets = presentationAssetDocument(document, presentation);
  assert.ok(assets.body.some((node) => node.id === "gallery-root"), "view assets are collected through the transient presentation document");
  assert.throws(() => renderSitePageToHtml({ ...document, body: [{ ...document.body[0], props: { variant: "compact" } }] }, presentation, hostBlocks), /host view is missing/);
  const changed = { ...document, body: [element("before", "p", "Before"), { ...document.body[0], props: { variant: "compact" } }, element("after", "p", "After")] };
  const canvas = renderToStaticMarkup(createElement(SitePageRenderer, { document: changed, presentation, blocks: hostBlocks, canvas: { viewportHeight: 900 } }));
  assert.match(canvas, /Before.*REAL HOST COMPONENT.*After/u);
  assert.doesNotMatch(canvas, /data-nw-host-view="gallery-wide"/u);
  const withoutComponent = { Gallery: { ...hostBlocks.Gallery, component: undefined } };
  const placeholder = renderToStaticMarkup(createElement(SitePageRenderer, { document: changed, presentation, blocks: withoutComponent, canvas: { viewportHeight: 900 } }));
  assert.match(placeholder, /Before.*data-nw-missing-host-view=""[^>]*role="status"[^>]*>このブロックの表示例はありません.*After/u);
  assert.throws(() => renderSitePageToHtml(changed, presentation, withoutComponent), /host view is missing/u);
  assert.match(renderSitePageToHtml(document, presentation, hostBlocks, { hostViewMode: "fallback" }), /REAL HOST COMPONENT/);
  assert.doesNotMatch(renderSitePageToHtml(document, presentation, hostBlocks, { hostViewMode: "off" }), /data-nw-host-view="/);
});

test("host view validation rejects duplicates, hostile frames, cross-target documents, executable recursion and overlapping bindings", () => {
  const document = page("synthetic", "en", "body", [{ type: "component", id: "gallery-block", block: "Gallery", props: { variant: "wide" } }]);
  const reject = (mutate) => { const input = siteWithHostView(); mutate(input); assert.throws(() => parseSitePresentation(input, document, hostBlocks)); };
  reject((input) => input.hostViews.push(structuredClone(input.hostViews[0])));
  reject((input) => { input.hostViews[0].document.siteId = "foreign"; });
  reject((input) => { input.hostViews[0].document.locale = "ja"; });
  reject((input) => { input.hostViews[0].document.pageId = "shared-header"; });
  reject((input) => { input.hostViews[0].externalFrames[0].src = "javascript:alert(1)"; });
  reject((input) => { input.hostViews[0].externalFrames[0].src = "https://maps.example.test/embed%0ajavascript:alert(1)"; });
  reject((input) => { input.hostViews[0].externalFrames[0].sandbox = "allow-scripts"; });
  reject((input) => { input.hostViews[0].externalFrames[0].autoHeightMax = 9000; });
  reject((input) => { input.hostViews[0].document.body.push({ type: "component", id: "recursive", block: "Gallery", props: { variant: "wide" } }); });
  reject((input) => { input.hostViews[0].carousel.nextIds = ["slide-one"]; });
  reject((input) => { input.hostViews[0].props = { variant: "unknown" }; });
});

test("frame auto-height accepts only its opaque matching window and restores styles on cleanup", () => {
  const document = page("synthetic", "en", "body", [{ type: "component", id: "gallery-block", block: "Gallery", props: { variant: "wide" } }]);
  const html = renderSitePageToHtml(document, siteWithHostView(), hostBlocks);
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: "https://example.test" });
  const frame = dom.window.document.querySelector("iframe"), wrapper = frame.closest("[data-nw-host-view]");
  const cleanup = initializeSitePresentation(dom.window.document);
  const message = (source, origin, data) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source, origin, data }));
  message(frame.contentWindow, "https://maps.example.test", { type: "niho-native-frame-size", frameKey: "gallery-map", height: 640 });
  assert.notEqual(wrapper.style.height, "640px");
  message(frame.contentWindow, "null", { type: "niho-native-frame-size", frameKey: "other", height: 640 });
  assert.notEqual(wrapper.style.height, "640px");
  message(frame.contentWindow, "null", { type: "niho-native-frame-size", frameKey: "gallery-map", height: 640 });
  assert.equal(frame.style.height, "640px"); assert.equal(wrapper.style.height, "640px");
  message(frame.contentWindow, "null", { type: "niho-native-frame-size", frameKey: "gallery-map", height: 901 });
  assert.equal(wrapper.style.height, "640px");
  cleanup(); assert.equal(wrapper.style.height, ""); assert.equal(frame.style.height, "100%"); dom.window.close();
});

test("two components using one host view keep independent carousel state", () => {
  const document = page("synthetic", "en", "body", ["one", "two"].map((id) => ({ type: "component", id, block: "Gallery", props: { variant: "wide" } })));
  const html = renderSitePageToHtml(document, siteWithHostView(), hostBlocks);
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: "https://example.test" });
  dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  const roots = [...dom.window.document.querySelectorAll("[data-nw-host-view]")], cleanup = initializeSitePresentation(dom.window.document);
  roots[0].querySelector("[data-nw-carousel-next]").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(roots[0].querySelectorAll("[data-nw-carousel-slide]")[1].hidden, false);
  assert.equal(roots[1].querySelectorAll("[data-nw-carousel-slide]")[0].hidden, false);
  cleanup(); dom.window.close();
});

test("native carousel starts deterministically, supports manual controls, pauses for reduced motion and cleans up", () => {
  const document = page("synthetic", "en", "body", [{ type: "component", id: "gallery-block", block: "Gallery", props: { variant: "wide" } }]);
  const html = renderSitePageToHtml(document, siteWithHostView(), hostBlocks, { assets: { "gallery:one": { src: "https://media.example.test/one.webp" } } });
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: "https://example.test" });
  let intervalCalls = 0;
  dom.window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  dom.window.setInterval = () => { intervalCalls++; return 7; };
  const root = dom.window.document, slides = [...root.querySelectorAll("[data-nw-carousel-slide]")], next = root.querySelector("[data-nw-carousel-next]");
  const cleanup = initializeSitePresentation(root);
  assert.equal(slides[0].hidden, false); assert.equal(slides[1].hidden, true); assert.equal(intervalCalls, 0, "reduced motion disables autoplay");
  next.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(slides[0].hidden, true); assert.equal(slides[1].hidden, false);
  cleanup();
  assert.equal(slides[0].hidden, false); assert.equal(slides[1].hidden, true);
  next.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(slides[0].hidden, false, "cleanup removes carousel listeners");
  dom.window.close();
});

test("native carousel pauses on hover and focus, and its play control supports Space", () => {
  const document = page("synthetic", "en", "body", [{ type: "component", id: "gallery-block", block: "Gallery", props: { variant: "wide" } }]);
  const html = renderSitePageToHtml(document, siteWithHostView(), hostBlocks, { assets: { "gallery:one": { src: "https://media.example.test/one.webp" } } });
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: "https://example.test" });
  const callbacks = new Map(); let sequence = 0, clears = 0;
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.setInterval = (callback) => { const id = ++sequence; callbacks.set(id, callback); return id; };
  dom.window.clearInterval = (id) => { callbacks.delete(id); clears++; };
  const root = dom.window.document, container = root.querySelector("[data-nw-host-view]"), play = root.querySelector("[data-nw-carousel-play-pause]");
  const cleanup = initializeSitePresentation(root);
  assert.equal(callbacks.size, 1);
  container.dispatchEvent(new dom.window.MouseEvent("mouseenter")); assert.equal(callbacks.size, 0);
  container.dispatchEvent(new dom.window.MouseEvent("mouseleave")); assert.equal(callbacks.size, 1);
  container.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true })); assert.equal(callbacks.size, 0);
  container.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: true, relatedTarget: root.body })); assert.equal(callbacks.size, 1);
  play.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "Space" }));
  assert.equal(play.getAttribute("aria-pressed"), "true"); assert.equal(callbacks.size, 0);
  cleanup(); assert.ok(clears >= 3);
  play.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "Space" }));
  assert.equal(play.getAttribute("aria-pressed"), "false", "cleanup restores state and removes keyboard listeners");
  dom.window.close();
});

test("only trusted host code can retain a different frame origin, including shared slots", () => {
  const presentation = siteWithHostView(), document = page("synthetic", "en", "body", []);
  presentation.shared.header.body = [{ type: "component", id: "header-gallery", block: "Gallery", props: { variant: "wide" } }];
  const externalFramePolicy = createExternalFramePolicy({ parentOrigin: "https://editor.example.test", sources: ["https://maps.example.test/embed/exact"] });
  const html = renderSitePageToHtml(document, presentation, hostBlocks, { externalFramePolicy });
  assert.match(html, /iframe[^>]*sandbox="allow-scripts allow-same-origin"/);
  assert.match(renderSitePageToHtml(document, presentation, hostBlocks), /iframe[^>]*sandbox="allow-scripts"/);
  assert.doesNotMatch(renderSitePageToHtml(document, presentation, hostBlocks, { hostViewMode: "off" }), /data-nw-host-view=/);
  assert.equal(externalFramePolicy({ src: "https://editor.example.test/api/editor" }), "opaque");
  assert.equal(externalFramePolicy({ src: "https://maps.example.test/other" }), "opaque");
  assert.equal(externalFramePolicy({ src: "https://maps.example.test/embed/exact#unexpected" }), "opaque");
  assert.throws(() => createExternalFramePolicy({ parentOrigin: "https://editor.example.test", sources: ["https://editor.example.test/"] }));
  assert.throws(() => createExternalFramePolicy({ parentOrigin: "https://editor.example.test", sources: ["http://maps.example.test/embed/exact"] }));
});

test("site frame sources narrow trusted origins and match path boundaries", () => {
  const policy = createExternalFramePolicy({
    parentOrigin: "https://editor.example.test",
    sources: ["https://maps.example.test/embed", "https://video.example.test/player"],
    siteSources: ["https://maps.example.test/embed"]
  });
  assert.equal(policy({ src: "https://maps.example.test/embed/place?id=1" }), "retain-origin");
  assert.equal(policy({ src: "https://maps.example.test/embedding" }), "blocked");
  assert.equal(policy({ src: "https://video.example.test/player" }), "blocked");
  assert.equal(policy({ src: "https://editor.example.test/embed" }), "blocked");
  assert.equal(policy({ src: "not-a-url" }), "blocked");
  assert.equal(createExternalFramePolicy({ parentOrigin: "https://editor.example.test", sources: ["https://maps.example.test/embed"], siteSources: [] })({ src: "https://maps.example.test/embed" }), "blocked");
  const blocked = renderSitePageToHtml(page("synthetic", "en", "body", [{ type: "component", id: "gallery", block: "Gallery", props: { variant: "wide" } }]), siteWithHostView(), hostBlocks, { externalFramePolicy: createExternalFramePolicy({ parentOrigin: "https://editor.example.test", sources: ["https://maps.example.test/embed"], siteSources: [] }) });
  assert.doesNotMatch(blocked, /<iframe/);
  assert.match(blocked, /data-nw-frame-blocked/);
  assert.throws(() => createExternalFramePolicy({ parentOrigin: "https://editor.example.test", sources: ["https://maps.example.test/embed"], siteSources: ["http://maps.example.test/embed"] }));
});

test("editing keeps frame sizing active without starting interactive controls", () => {
  const document = page("synthetic", "en", "body", [{ type: "component", id: "gallery-block", block: "Gallery", props: { variant: "wide" } }]);
  const dom = new JSDOM(`<!doctype html><body>${renderSitePageToHtml(document, siteWithHostView(), hostBlocks)}</body>`, { url: "https://editor.example.test" });
  const frame = dom.window.document.querySelector("iframe"), messages = [];
  frame.contentWindow.postMessage = (data) => messages.push(data);
  const cleanup = initializeSitePresentation(dom.window.document, { interactive: false });
  assert.deepEqual(messages, [{ type: "niho-native-frame-request-size", frameKey: "gallery-map" }]);
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { source: frame.contentWindow, origin: "null", data: { type: "niho-native-frame-size", frameKey: "gallery-map", height: 600 } }));
  assert.equal(frame.style.height, "600px");
  dom.window.document.querySelector("[data-nw-carousel-next]").click();
  assert.equal(dom.window.document.querySelectorAll("[data-nw-carousel-slide]")[1].hidden, true);
  cleanup(); frame.dispatchEvent(new dom.window.Event("load"));
  assert.equal(messages.length, 1); dom.window.close();
});

test("native disclosure content fills the authored flex box while keeping native closed state", () => {
  const document = page("synthetic", "en", "body", [{ type: "element", id: "disclosure", tag: "details", style: { base: { display: "flex", flexDirection: "column", alignItems: "flex-start" } }, children: [element("summary", "summary", "Read more"), element("content", "div", "Details")] }]);
  const html = renderSitePageToHtml(document, site(), {});
  assert.match(html, /data-nw-node="disclosure"\]::details-content\{width:100%;min-width:0;\}/);
  assert.equal(JSDOM.fragment(html).querySelector("details").open, false);
});

test("carousel fade cancels interrupted animations, completes once and restores on cleanup", async () => {
  const document = page("synthetic", "en", "body", [{ type: "component", id: "gallery-block", block: "Gallery", props: { variant: "wide" } }]);
  const presentation = siteWithHostView(); presentation.hostViews[0].carousel.fadeMs = 1200;
  const dom = new JSDOM(`<!doctype html><html><body>${renderSitePageToHtml(document, presentation, hostBlocks)}</body></html>`);
  const root = dom.window.document, slides = [...root.querySelectorAll("[data-nw-carousel-slide]")], next = root.querySelector("[data-nw-carousel-next]");
  const animations = [];
  for (const slide of slides) slide.animate = (_frames, options) => {
    let finish; const animation = { finished: new Promise(resolve => { finish = resolve; }), cancel() { this.cancelled = true; }, finish: () => finish(), options };
    animations.push(animation); return animation;
  };
  const cleanup = initializeSitePresentation(root);
  const click = () => next.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  click(); assert.equal(animations.length, 2); assert.equal(animations[0].options.duration, 1200); assert.ok(slides.every(slide => !slide.hidden));
  click(); assert.ok(animations.slice(0, 2).every(animation => animation.cancelled));
  animations.slice(2).forEach(animation => animation.finish()); await Promise.resolve(); await Promise.resolve();
  assert.equal(slides[0].hidden, false); assert.equal(slides[1].hidden, true);
  click(); cleanup(); assert.ok(animations.every(animation => animation.cancelled));
  assert.equal(slides[0].hidden, false); assert.equal(slides[1].hidden, true); dom.window.close();
  const invalid = siteWithHostView(); invalid.hostViews[0].carousel.fadeMs = 3001;
  assert.throws(() => parseSitePresentation(invalid, document, hostBlocks), /fade duration/);
});

test("host view scopes cannot collide with the target and overlay bindings reach nested views", () => {
  const document = page("synthetic", "en", "body", [{ type: "component", id: "gallery-block", block: "Gallery", props: { variant: "wide" } }]);
  const collision = siteWithHostView(); collision.hostViews[0].document.pageId = "body";
  assert.throws(() => parseSitePresentation(collision, document, hostBlocks), /distinct from the target/);
  assert.throws(() => renderSitePageToHtml(document, collision, hostBlocks), /distinct from the target/);
  const presentation = siteWithHostView(), menu = siteWithMenu(); presentation.overlays = menu.overlays;
  presentation.hostViews[0].document.body[0].children.push({ type: "element", id: "host-menu-trigger", tag: "a", attrs: { id: "menu-trigger", href: "#site-menu" }, children: [{ type: "text", text: "Host menu" }] });
  const dom = new JSDOM(renderSitePageToHtml(document, presentation, hostBlocks));
  const trigger = dom.window.document.querySelector('[data-nw-host-view] [data-nw-overlay-open="site-menu"]');
  assert.ok(trigger); const cleanup = initializeSitePresentation(dom.window.document);
  trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(dom.window.document.querySelector('[data-nw-overlay="site-menu"]').hidden, false);
  cleanup(); dom.window.close();
});
