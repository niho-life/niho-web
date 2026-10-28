import { resolvePageLink } from "./presentation-links.js";
import { resolvePageStyles, type SiteStyles } from "./site-styles.js";
import { createElement, Fragment, type ComponentType, type ReactElement } from "react";
import type { BlockContract, PageDocument, PageNode, PublicPropValue, SitePresentation, SitePresentationExternalFrame, SitePresentationHostView, SitePresentationOverlay } from "./types.js";
import { parsePageDocument } from "./document.js";
import { cssForDocument, pageScope, resolveViewportHeightUnits } from "./css.js";
import { parseResolvedAssets, resolvedAsset, type ResolvedAssetMap } from "./assets.js";
import { cssForSitePresentation, parseSitePresentation, presentationLayoutDocument, sitePresentationHostViewKey } from "./presentation.js";
import { iconGlyph } from "./icons.js";
import { parseBlankEmbedRegistry, resolveBlankEmbed, type BlankEmbedRegistry } from "./embeds.js";

export type BlockDefinition = BlockContract & {
  /** ホストアプリが所有する同期 React コンポーネント。JSON から実行コードを読まない。 */
  component: ComponentType<Record<string, PublicPropValue>>;
};
export type BlockRegistry = Readonly<Record<string, BlockDefinition>>;
/** 実行コード側だけで指定する外部frame policy。snapshotから権限を要求できない。 */
export type ExternalFramePolicy = (frame: Readonly<SitePresentationExternalFrame>) => "blocked" | "opaque" | "retain-origin";
export function createExternalFramePolicy({ parentOrigin, sources, siteSources }: { parentOrigin: string; sources: readonly string[]; siteSources?: readonly string[] }): ExternalFramePolicy {
  const parent = new URL(parentOrigin);
  const parseSources = (list: readonly string[] | undefined) => {
    if (!Array.isArray(list) || list.length > 16) throw new Error("Invalid external frame policy");
    return list.map((source) => {
      if (typeof source !== "string") throw new Error("Invalid external frame policy");
      const url = new URL(source);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.origin === parent.origin) throw new Error("Frame origin retention requires a trusted external HTTPS source");
      return url;
    });
  };
  const allowed = parseSources(sources);
  const siteAllowed = siteSources === undefined ? undefined : parseSources(siteSources);
  const matches = (source: URL, candidate: URL, prefix: boolean) => source.origin === candidate.origin && (source.pathname === candidate.pathname || prefix && candidate.pathname.startsWith(source.pathname.endsWith("/") ? source.pathname : `${source.pathname}/`));
  return (frame) => {
    let url: URL;
    try { url = new URL(frame.src); } catch { return siteAllowed ? "blocked" : "opaque"; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return siteAllowed ? "blocked" : "opaque";
    const prefix = siteAllowed !== undefined;
    return allowed.some((source) => matches(source, url, prefix)) && (siteAllowed === undefined || siteAllowed.some((source) => matches(source, url, true))) ? "retain-origin" : siteAllowed ? "blocked" : "opaque";
  };
}
export type PageRendererProps = {
  document: unknown; blocks?: BlockRegistry;
  siteStyles?: SiteStyles;
  /** ホストが解決した素材。描画前に検証する。 */
  assets?: ResolvedAssetMap;
  /** 解決できない素材画像。既定は描画しない。placeholder はエディター用。 */
  missingAssets?: "omit" | "placeholder";
  /** @internal SitePageRendererが検証済みの表示専用URL対応を渡す。 */
  links?: SitePresentation["links"];
  /** @internal SitePageRendererが検証済みoverlay controlへ付ける既知属性。 */
  overlayBindings?: readonly SitePresentationOverlay[];
  /** @internal SitePageRendererが検証済みhost block viewを解決する。 */
  hostViews?: readonly SitePresentationHostView[];
  /** @internal host view文書に既知属性だけを付ける。 */
  hostViewBinding?: SitePresentationHostView;
  /** display-only host viewの優先方法。公開hostはfallback/offで実componentを選べる。 */
  hostViewMode?: "prefer" | "fallback" | "off";
  externalFramePolicy?: ExternalFramePolicy;
  /** trusted host code が作った Blank iframe registry。文書の key を固定 URL と sandbox へ解決する。 */
  blankEmbeds?: BlankEmbedRegistry;
  /**
   * @internal エディターのキャンバスだけが渡す。viewportHeight は viewport 高さの単位を倍率 100% の高さの px に置き換える基準、
   * siteOrigin は文書の root-relative な画像 URL（`/x.svg`）をサイトの公開 origin で解決する（キャンバスの iframe は Studio の origin のため）。
   */
  canvas?: { viewportHeight?: number | undefined; siteOrigin?: string | undefined; /** Studio previewだけで標準media操作を許可する。 */ interactive?: boolean | undefined } | undefined;
};

const canvasCssText = (css: string, canvas: PageRendererProps["canvas"]) => canvas?.viewportHeight ? resolveViewportHeightUnits(css, canvas.viewportHeight) : css;
const rootRelative = (value: string) => value.startsWith("/") && !value.startsWith("//");
const embedAllow = { map: undefined, youtube: "encrypted-media; picture-in-picture; fullscreen", vimeo: "picture-in-picture; fullscreen" } as const;
const embedLabel = { map: "Map", youtube: "YouTube", vimeo: "Vimeo", lottie: "Lottie", facebook: "Facebook", x: "X", instagram: "Instagram", blank: "Blank" } as const;
function withSiteOrigin(attrs: Record<string, unknown>, siteOrigin: string): void {
  if (typeof attrs.src === "string" && rootRelative(attrs.src)) attrs.src = siteOrigin + attrs.src;
  if (typeof attrs.poster === "string" && rootRelative(attrs.poster)) attrs.poster = siteOrigin + attrs.poster;
  if (typeof attrs.srcSet === "string") attrs.srcSet = attrs.srcSet.split(",").map((entry) => { const trimmed = entry.trim(); return rootRelative(trimmed) ? siteOrigin + trimmed : trimmed; }).join(", ");
}

/** useEffect を使わず、Next.js の初期 HTML と静的 SSR の両方で本文を返す。 */
export function PageRenderer({ document: input, blocks = {}, assets: assetInput, missingAssets = "omit", siteStyles, overlayBindings = [], hostViews = [], hostViewBinding, hostViewMode = "prefer", externalFramePolicy, blankEmbeds: blankEmbedInput, canvas, links }: PageRendererProps): ReactElement {
  const document = resolvePageStyles(parsePageDocument(input, blocks, siteStyles ? { siteStyles } : {}), siteStyles);
  const blankEmbeds = blankEmbedInput === undefined ? undefined : parseBlankEmbedRegistry(blankEmbedInput);
  const assets = assetInput === undefined ? {} : parseResolvedAssets(assetInput);
  const scope = pageScope(document);
  type VideoInteractionChild = { role: "video" | "button"; ready: boolean };
  const videoReady = (node: PageNode | undefined): boolean => node?.type === "element" && node.tag === "video" &&
    (typeof node.attrs?.src === "string" || !!node.asset && !!resolvedAsset(assets, node.asset));
  function render(node: PageNode, videoInteraction?: VideoInteractionChild): ReactElement | string | null {
    if (node.type === "text") return node.text;
    // 部品ライブラリなしの検証で拒否済み。下書きは resolvePageDocument で展開してから描画する。
    if (node.type === "instance") throw new Error("Unresolved component instance: resolve the document before rendering");
    if (node.type === "component") {
      const candidates = hostViews.filter((view) => view.block === node.block);
      const definition = blocks[node.block]!;
      if (candidates.length && hostViewMode !== "off" && (hostViewMode === "prefer" || !definition?.component)) {
        const view = candidates.find((candidate) => sitePresentationHostViewKey(candidate.block, candidate.props) === sitePresentationHostViewKey(node.block, node.props));
        if (view) return createElement("div", { key: node.id, "data-nw-node": node.id, "data-nw-owner": scope, "data-nw-block": node.block, "data-nw-host-view": view.id },
          createElement(PageRenderer, { document: view.document, assets, missingAssets, hostViewBinding: view, hostViewMode: "off", overlayBindings, ...(links ? { links } : {}), ...(externalFramePolicy ? { externalFramePolicy } : {}), ...(blankEmbeds ? { blankEmbeds } : {}), ...(canvas ? { canvas } : {}) }));
        if (!canvas) throw new Error(`Registered host view is missing for block props: ${node.block}`);
      }
      if (!definition?.component) {
        if (canvas) return createElement("div", { key: node.id, "data-nw-node": node.id, "data-nw-owner": scope, "data-nw-block": node.block, "data-nw-missing-host-view": "", role: "status" }, "このブロックの表示例はありません");
        throw new Error(`Registered block has no React component: ${node.block}`);
      }
      // 枠の属性や style をブロックの props へ混ぜない。
      return createElement("div", { key: node.id, "data-nw-node": node.id, "data-nw-owner": scope, "data-nw-block": node.block }, createElement(definition.component, node.props));
    }
    const attrs = { ...node.attrs };
    if (links && typeof attrs.href === "string") attrs.href = resolvePageLink(attrs.href, links);
    if (typeof attrs.autocomplete === "string") { attrs.autoComplete = attrs.autocomplete; delete attrs.autocomplete; }
    if (canvas?.siteOrigin) withSiteOrigin(attrs, canvas.siteOrigin);
    if (hostViewBinding) {
      for (const [slot, ids] of Object.entries(hostViewBinding.slotBindings ?? {})) if (ids.includes(node.id)) attrs["data-nw-slot"] = slot;
      const binding = hostViewBinding.carousel;
      if (binding?.rootId === node.id) {
        attrs["data-nw-carousel"] = hostViewBinding.id;
        attrs["data-nw-carousel-loop"] = String(binding.loop !== false);
        attrs["data-nw-carousel-swipe"] = String(binding.swipe === true);
        if (binding.fadeMs !== undefined) attrs["data-nw-carousel-fade"] = binding.fadeMs;
        if (binding.autoplayMs !== undefined) attrs["data-nw-carousel-autoplay"] = binding.autoplayMs;
        if (binding.initiallyPlaying === false) attrs["data-nw-carousel-paused"] = "true";
      }
      const slide = binding?.slideIds.indexOf(node.id) ?? -1;
      if (slide >= 0) { attrs["data-nw-carousel-slide"] = slide; attrs["aria-hidden"] = slide === 0 ? "false" : "true"; if (slide !== 0) attrs.hidden = true; }
      if (binding?.previousIds?.includes(node.id)) attrs["data-nw-carousel-previous"] = "";
      if (binding?.nextIds?.includes(node.id)) attrs["data-nw-carousel-next"] = "";
      if (binding?.playPauseIds?.includes(node.id)) { attrs["data-nw-carousel-play-pause"] = ""; attrs["aria-pressed"] = String(binding.initiallyPlaying === false); }
    }
    if (node.interaction?.type === "video-toggle") attrs["data-nw-video-with-button"] = "";
    if (node.interaction?.type === "loop-box") {
      attrs[canvas && !canvas.interactive ? "data-nw-loop-box-static" : "data-nw-loop-box"] = "";
      attrs["data-nw-loop-speed"] = node.interaction.speed;
      attrs["data-nw-loop-pause-hover"] = String(node.interaction.pauseOnHover);
    }
    if (videoInteraction?.role === "video") {
      attrs["data-nw-video"] = "";
      attrs.controls = true;
    }
    if (videoInteraction?.role === "button") {
      attrs["data-nw-video-toggle"] = "";
      attrs["aria-label"] = typeof node.attrs?.["aria-label"] === "string" ? node.attrs["aria-label"] : "動画を再生";
      attrs["aria-pressed"] = "false";
      if (!videoInteraction.ready) attrs.disabled = true;
    }
    const htmlId = typeof attrs.id === "string" ? attrs.id : undefined;
    const opens = htmlId ? overlayBindings.find((overlay) => overlay.triggerIds.includes(htmlId)) : undefined;
    const closes = htmlId ? overlayBindings.find((overlay) => overlay.closeIds.includes(htmlId)) : undefined;
    if (opens) { attrs["aria-controls"] = opens.id; attrs["aria-expanded"] = "false"; attrs["data-nw-overlay-open"] = opens.id; }
    if (closes) attrs["data-nw-overlay-close"] = closes.id;
    if (node.asset) {
      const resolved = resolvedAsset(assets, node.asset);
      if (!resolved) return missingAssets === "placeholder" ? createElement("span", { key: node.id, "data-nw-node": node.id, "data-nw-owner": scope, "data-nw-missing-asset": "", role: node.tag === "img" ? "img" : "status",
        "aria-label": node.tag === "img" ? typeof attrs.alt === "string" && attrs.alt ? attrs.alt : "画像を表示できません" : "動画を表示できません" }) : null;
      attrs.src = resolved.src;
      // 寸法を持たない画像にだけ付け、レイアウトのずれを防ぐ。
      if (node.tag === "img" && attrs.width === undefined && attrs.height === undefined && resolved.width !== undefined && resolved.height !== undefined) { attrs.width = resolved.width; attrs.height = resolved.height; }
    }
    if (node.icon) return createElement("span", { ...attrs, key: node.id, "data-nw-node": node.id, "data-nw-owner": scope }, iconGlyph(node.icon));
    // trusted presentation binding は従来どおり空div置換を優先し、標準embedのpolicyへ混ぜない。
    if (node.embed && !hostViewBinding?.externalFrames?.some((candidate) => candidate.nodeId === node.id)) {
      if (!node.embed.source) return missingAssets === "placeholder" ? createElement("div", { ...attrs, key: node.id, "data-nw-node": node.id, "data-nw-owner": scope,
        "data-nw-empty-embed": node.embed.provider, role: "status" }, node.embed.provider === "blank" ? "承認済みの埋め込みを選択してください" : `${embedLabel[node.embed.provider]} の URL を設定してください`) : null;
      if (node.embed.provider === "blank") {
        const entry = resolveBlankEmbed(blankEmbeds, node.embed.source);
        if (!entry) return missingAssets === "placeholder" ? createElement("div", { ...attrs, key: node.id, "data-nw-node": node.id, "data-nw-owner": scope,
          "data-nw-empty-embed": "blank", role: "status" }, blankEmbeds ? "この埋め込みはホストで承認されていません" : "Blank 埋め込み registry が接続されていません") : null;
        if (canvas && !canvas.interactive) return createElement("div", { ...attrs, key: node.id, "data-nw-node": node.id, "data-nw-owner": scope,
          "data-nw-embed": "blank", "data-nw-blank-static": "", role: "status" }, `${entry.label}（プレビューで表示）`);
        return createElement("div", { ...attrs, key: node.id, "data-nw-node": node.id, "data-nw-owner": scope, "data-nw-embed": "blank", "data-nw-blank-key": entry.key },
          createElement("div", { "data-nw-blank-player": "", style: { display: "flex", flexDirection: "column", width: "100%", height: "100%" } },
            createElement("iframe", { src: entry.src, title: node.embed.title, loading: "lazy", referrerPolicy: "strict-origin-when-cross-origin", sandbox: entry.sandboxValue,
              style: { width: "100%", minHeight: 0, flex: "1 1 auto", border: 0, display: "block", ...(canvas ? { pointerEvents: "none" } : {}) } }),
            createElement("a", { href: entry.src, target: "_blank", rel: "noopener noreferrer", "data-nw-blank-fallback": "", style: { flex: "0 0 auto", padding: 8, textAlign: "center" } }, `${entry.label}を新しいタブで開く`)));
      }
      if (node.embed.provider === "lottie") return createElement("div", { ...attrs, key: node.id, "data-nw-node": node.id, "data-nw-owner": scope,
        "data-nw-embed": "lottie", "data-nw-lottie-source": node.embed.source, "data-nw-lottie-title": node.embed.title,
        ...(canvas && !canvas.interactive ? { "data-nw-lottie-static": "" } : {}) },
        createElement("div", { "data-nw-lottie-player": "", style: { display: "grid", width: "100%", height: "100%" } },
          createElement("span", { "data-nw-lottie-fallback": "", role: "img", "aria-label": node.embed.title,
            style: { gridArea: "1 / 1", display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%" } }, node.embed.title)));
      if (node.embed.provider === "facebook") return createElement("div", { ...attrs, key: node.id, "data-nw-node": node.id, "data-nw-owner": scope,
        "data-nw-embed": "facebook", "data-nw-facebook-source": node.embed.source, "data-nw-facebook-title": node.embed.title,
        ...(canvas ? { "data-nw-facebook-canvas": "" } : {}),
        ...(canvas && !canvas.interactive ? { "data-nw-facebook-static": "" } : {}) },
        createElement("div", { "data-nw-facebook-player": "", style: { display: "flex", flexDirection: "column", width: "100%", height: "100%" } },
          createElement("div", { "data-nw-facebook-frame-mount": "", style: { display: "grid", flex: "1 1 auto", minHeight: 0 } },
            createElement("span", { "data-nw-facebook-status": "", role: "status", style: { gridArea: "1 / 1", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, textAlign: "center" } }, "Facebook の投稿はまだ読み込まれていません。")),
          createElement("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 12, padding: 12 } },
            createElement("button", { type: "button", "data-nw-facebook-load": "", hidden: true }, "Facebook の投稿を表示"),
            createElement("a", { href: node.embed.source, target: "_blank", rel: "noopener noreferrer", "data-nw-facebook-link": "" }, "Facebook で投稿を見る"))));
      if (node.embed.provider === "x" || node.embed.provider === "instagram") {
        const provider = node.embed.provider, service = embedLabel[provider], content = provider === "x" ? "ポスト" : "投稿";
        return createElement("div", { ...attrs, key: node.id, "data-nw-node": node.id, "data-nw-owner": scope,
          "data-nw-embed": provider, "data-nw-social-source": node.embed.source, "data-nw-social-title": node.embed.title,
          ...(canvas ? { "data-nw-social-canvas": "" } : {}),
          ...(canvas && !canvas.interactive ? { "data-nw-social-static": "" } : {}) },
          createElement("div", { "data-nw-social-player": "", style: { display: "flex", flexDirection: "column", width: "100%", height: "100%" } },
            createElement("div", { "data-nw-social-frame-mount": "", style: { display: "grid", flex: "1 1 auto", minHeight: 0 } },
              createElement("span", { "data-nw-social-status": "", role: "status", style: { gridArea: "1 / 1", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, textAlign: "center" } }, `${service} の${content}はまだ読み込まれていません。`)),
            createElement("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "center", gap: 12, padding: 12 } },
              createElement("button", { type: "button", "data-nw-social-load": "", hidden: true }, `${service} の${content}を表示`),
              createElement("a", { href: node.embed.source, target: "_blank", rel: "noopener noreferrer", "data-nw-social-link": "" }, `${service} で${content}を見る`))));
      }
      const frame = createElement("iframe", {
        src: node.embed.source, title: node.embed.title, loading: "lazy", referrerPolicy: "strict-origin-when-cross-origin",
        sandbox: "allow-scripts allow-same-origin", ...(embedAllow[node.embed.provider] ? { allow: embedAllow[node.embed.provider] } : {}),
        ...(node.embed.provider === "youtube" || node.embed.provider === "vimeo" ? { allowFullScreen: true } : {}),
        style: { width: "100%", height: "100%", border: 0, display: "block", ...(canvas ? { pointerEvents: "none" } : {}) }
      });
      return createElement("div", { ...attrs, key: node.id, "data-nw-node": node.id, "data-nw-owner": scope, "data-nw-embed": node.embed.provider }, frame);
    }
    if (node.tag === "video") {
      if (typeof attrs.src !== "string") return missingAssets === "placeholder" ? createElement("span", { key: node.id, "data-nw-node": node.id, "data-nw-owner": scope,
        "data-nw-missing-asset": "", role: "status", "aria-label": "動画を選んでください" }, "動画を選んでください") : null;
      if (attrs.controls === undefined) attrs.controls = true;
      if (attrs.preload === undefined) attrs.preload = "metadata";
    }
    if (node.tag === "a" && attrs.target === "_blank") {
      attrs.rel = [...new Set(`${attrs.rel ?? ""} noopener noreferrer`.trim().split(/\s+/))].join(" ");
    }
    // action / method は文書から受け付けない。method=dialog は form が dialog 外なら送信せず、
    // 静的 HTML でも現在 URL へ入力値を誤送信しない。送信処理はホストの trusted code が所有する。
    if (node.tag === "form") attrs.method = "dialog";
    const frame = hostViewBinding?.externalFrames?.find((candidate) => candidate.nodeId === node.id);
    if (frame) {
      const frameAccess = externalFramePolicy?.(frame);
      if (frameAccess === "blocked") return createElement("div", { ...attrs, key: node.id, "data-nw-node": node.id, "data-nw-owner": scope, "data-nw-frame-blocked": "", role: "status" }, "外部コンテンツを表示できません");
      return createElement("iframe", { ...attrs, key: node.id, "data-nw-node": node.id, "data-nw-owner": scope, src: frame.src, title: frame.title,
      loading: frame.loading ?? "lazy", referrerPolicy: frame.referrerPolicy ?? "strict-origin-when-cross-origin", sandbox: frameAccess === "retain-origin" ? "allow-scripts allow-same-origin" : "allow-scripts",
      style: { width: "100%", height: "100%", border: 0, display: "block" },
      ...(frame.frameKey ? { "data-nw-frame-key": frame.frameKey, "data-nw-frame-max-height": frame.autoHeightMax ?? 1200 } : {}),
      ...(frame.allowFullScreen ? { allowFullScreen: true } : {}) });
    }
    if (node.interaction?.type === "loop-box") {
      const children = node.children.map((child) => render(child));
      return createElement(node.tag, { ...attrs, key: node.id, "data-nw-node": node.id, "data-nw-owner": scope },
        createElement("div", { "data-nw-loop-box-track": "", style: { display: "flex", flexDirection: "inherit", alignItems: "inherit", gap: "inherit", flex: "0 0 auto" } }, ...children),
        createElement("div", { "data-nw-loop-box-clones": "", "aria-hidden": "true", style: { display: "contents" } }));
    }
    // children を渡さないことで React の void element 契約を守る。
    return createElement(node.tag, { ...attrs,
      ...(canvas && node.tag === "video" && (!canvas.interactive || videoInteraction?.role !== "video") ? { onPlay: (event: { currentTarget: { pause(): void } }) => event.currentTarget.pause() } : {}), key: node.id, "data-nw-node": node.id, "data-nw-owner": scope },
      ...(node.children.length ? node.children.map((child, index) => render(child, node.interaction?.type === "video-toggle"
        ? { role: index === 0 ? "video" : "button", ready: videoReady(node.children[0]) } : undefined)) : []));
  }
  return createElement(Fragment, null,
    // React 18 HTML-escapes text children inside <style>, which changes CSS selectors.
    // cssForDocument only emits identifiers and values accepted by the closed CSS schema.
    createElement("style", { "data-nw-style": scope, dangerouslySetInnerHTML: { __html: canvasCssText(cssForDocument(document, assets), canvas) } }),
    createElement("div", { "data-nw-scope": scope, lang: document.locale }, ...document.body.map((node) => render(node))));
}

export type SitePageRendererProps = PageRendererProps & { presentation: unknown };
/**
 * PageEditor と SSR が共有する native site composition。
 * 編集対象が canonical header/footer 自身なら、その文書を該当 slot にだけ置き、本文へ複製しない。
 */
export function SitePageRenderer({ document: input, presentation: presentationInput, blocks = {}, assets: assetInput, missingAssets = "omit", siteStyles, hostViewMode = "prefer", externalFramePolicy, blankEmbeds: blankEmbedInput, canvas }: SitePageRendererProps): ReactElement {
  const document = resolvePageStyles(parsePageDocument(input, blocks, siteStyles ? { siteStyles } : {}), siteStyles);
  const blankEmbeds = blankEmbedInput === undefined ? undefined : parseBlankEmbedRegistry(blankEmbedInput);
  const presentation: SitePresentation = parseSitePresentation(presentationInput, document, blocks);
  const assets = assetInput === undefined ? {} : parseResolvedAssets(assetInput);
  const output = cssForSitePresentation(presentation, document, blocks, assets), layout = presentationLayoutDocument(presentation);
  const layoutScope = pageScope(layout), shared = presentation.shared;
  const overlays = presentation.overlays ?? [], hostViews = presentation.hostViews ?? [];
  const hostOptions = { hostViews, hostViewMode, ...(presentation.links ? { links: presentation.links } : {}), ...(externalFramePolicy ? { externalFramePolicy } : {}), ...(blankEmbeds ? { blankEmbeds } : {}), ...(canvas ? { canvas } : {}) };
  const header: PageDocument = document.pageId === shared.header.pageId ? document : shared.header;
  const footer: PageDocument = document.pageId === shared.footer.pageId ? document : shared.footer;
  const body = document.pageId === shared.header.pageId || document.pageId === shared.footer.pageId ? null
    : overlays.some((overlay) => document.pageId === overlay.document.pageId) ? null
    : createElement("main", { "data-nw-presentation-body": "" }, createElement(PageRenderer, { document, blocks, assets, missingAssets, overlayBindings: overlays, ...hostOptions, ...(siteStyles ? { siteStyles } : {}) }));
  return createElement(Fragment, null,
    createElement("style", { "data-nw-presentation-style": output.scope, dangerouslySetInnerHTML: { __html: canvasCssText(output.css, canvas) } }),
    createElement("div", { "data-nw-presentation": output.scope, "data-nw-scope": layoutScope, lang: document.locale },
      createElement("div", { "data-nw-owner": layoutScope, "data-nw-node": "layout" },
      createElement("div", { "data-nw-presentation-header": "" }, createElement(PageRenderer, { document: header, blocks, assets, missingAssets, overlayBindings: overlays, ...hostOptions })),
      body,
      createElement("div", { "data-nw-presentation-footer": "" }, createElement(PageRenderer, { document: footer, blocks, assets, missingAssets, overlayBindings: overlays, ...hostOptions })),
      ...overlays.map((overlay) => {
        const editing = document.pageId === overlay.document.pageId, overlayDocument = editing ? document : overlay.document;
        return createElement("div", { key: overlay.id, id: overlay.id, role: "dialog", "aria-modal": "true", "aria-label": overlay.label, tabIndex: -1, "data-nw-overlay": overlay.id,
          ...(editing ? { "data-nw-overlay-editing": "" } : { hidden: true }) },
          createElement("button", { type: "button", tabIndex: -1, "aria-hidden": "true", "aria-label": overlay.label + "を閉じる", "data-nw-overlay-backdrop": "", "data-nw-overlay-close": overlay.id }),
          createElement("div", { "data-nw-overlay-content": "" }, createElement(PageRenderer, { document: overlayDocument, blocks, assets, missingAssets, overlayBindings: overlays, ...hostOptions })));
      }))));
}
