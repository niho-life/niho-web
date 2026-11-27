import { createElement } from "react";
import type { BlockRegistry } from "../src/react.js";
import type { ElementAttributes, ElementNode, EmbedDescriptor, PageDocument, PageNode, PublicPropValue } from "../src/types.js";
import { assetKey, collectAssetReferences, type ResolvedAsset } from "../src/assets.js";
import type { CmsPublicAsset } from "../src/cms-v2.js";
import { isSafePublicUrl } from "../src/validation-utils.js";
import { MANAGED_EMBED_REF, managedEmbedContract, registeredNihoEmbed, type ManagedPublicPolicy } from "./managed-embed-contract.js";
import type { ManagedD1 } from "./managed-sites.js";

declare const __PUBLIC_NIHO_EMBEDS_PATH__: string;
declare const __PUBLIC_PRESENTATION_PATH__: string;
export const publicScriptPaths = {
  nihoEmbeds: typeof __PUBLIC_NIHO_EMBEDS_PATH__ === "string" ? __PUBLIC_NIHO_EMBEDS_PATH__ : null,
  presentation: typeof __PUBLIC_PRESENTATION_PATH__ === "string" ? __PUBLIC_PRESENTATION_PATH__ : null
};

type EmbedScope = { siteId: string; pageId: string; locale: string; parentOrigin: string; publicPath: string };
export type PublishedEmbed = { refId: string; src: URL };

export async function resolvePublishedEmbeds(db: ManagedD1, document: PageDocument, scope: EmbedScope, policy: ManagedPublicPolicy): Promise<PublishedEmbed[]> {
  if (!policy.frameOrigins.length) return [];
  const refs = new Set<string>();
  const collect = (nodes: readonly PageNode[]) => {
    for (const node of nodes) {
      if (node.type === "element") collect(node.children);
      if (node.type === "component" && node.block === "ManagedEmbed" &&
        typeof node.props.refId === "string" && MANAGED_EMBED_REF.test(node.props.refId)) refs.add(node.props.refId);
    }
  };
  collect(document.body);
  if (!refs.size) return [];
  const connections = await db.prepare(`
    SELECT ref_id, src FROM managed_embed_connections
    WHERE site_id = ?1 AND page_id = ?2 AND locale = ?3 AND parent_origin = ?4 AND public_path = ?5
      AND ref_id IN (SELECT value FROM json_each(?6))
  `).bind(scope.siteId, scope.pageId, scope.locale, scope.parentOrigin, scope.publicPath, JSON.stringify([...refs]))
    .all<{ ref_id: string; src: string }>();
  if (!connections.success) return [];
  return (connections.results ?? []).flatMap(({ ref_id, src }) => {
    const url = registeredNihoEmbed(src, scope.parentOrigin, scope.publicPath);
    return url && policy.frameOrigins.includes(url.origin) ? [{ refId: ref_id, src: url }] : [];
  });
}

const GOOGLE_TAG = "https://www.googletagmanager.com";
const ANALYTICS = "https://*.google-analytics.com";

async function ga4PublicTag(measurementId: string | null) {
  if (!measurementId) return null;
  const source = `window.dataLayer=window.dataLayer||[];function gtag(){window.dataLayer.push(arguments)}gtag("js",new Date());gtag("config","${measurementId}",{allow_google_signals:false,allow_ad_personalization_signals:false,page_location:location.origin+location.pathname});`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return {
    scripts: `<script>${source}</script><script async src="${GOOGLE_TAG}/gtag/js?id=${measurementId}"></script>`,
    scriptSources: [`'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`, GOOGLE_TAG],
    imageSources: [GOOGLE_TAG, ANALYTICS],
    connectSources: [GOOGLE_TAG, ANALYTICS]
  };
}

export function publicResourceSource(value: unknown, parentOrigin: string, allowedOrigins: readonly string[], approvedAssetUrls?: ReadonlySet<string>): string | undefined {
  if (!isSafePublicUrl(value) || value.startsWith("#")) return undefined;
  const resolved = new URL(value, parentOrigin), { origin } = resolved;
  if (origin === parentOrigin) return "'self'";
  return allowedOrigins.includes(origin) || approvedAssetUrls?.has(resolved.href) ? origin : undefined;
}

export async function managedPublicHead({
  measurementId = null, scriptUrls = [], frameSources = [], imageSources = [], mediaSources = [], inlineStyles = false, resolveEmbed = false
}: {
  measurementId?: string | null;
  scriptUrls?: readonly URL[];
  frameSources?: Iterable<string>;
  imageSources?: Iterable<string>;
  mediaSources?: Iterable<string>;
  inlineStyles?: boolean;
  resolveEmbed?: boolean;
} = {}) {
  const analytics = await ga4PublicTag(measurementId);
  const directive = (name: string, values: Iterable<string>) => {
    const sources = [...new Set(values)].sort();
    return `${name} ${sources.length ? sources.join(" ") : "'none'"}`;
  };
  return {
    scripts: scriptUrls.map((url) => `<script type="module" src="${url.pathname}"></script>`).join("") + (analytics?.scripts ?? ""),
    csp: [
      "default-src 'none'",
      directive("script-src", [...scriptUrls.map(({ href }) => href), ...(analytics?.scriptSources ?? [])]),
      directive("style-src", inlineStyles ? ["'unsafe-inline'"] : []),
      directive("img-src", [...imageSources, ...(analytics?.imageSources ?? [])]),
      directive("media-src", mediaSources), "font-src 'none'", directive("frame-src", frameSources),
      directive("connect-src", [...(resolveEmbed ? ["'self'"] : []), ...(analytics?.connectSources ?? [])]),
      "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"
    ].join("; ")
  };
}

function frameOrigin(embed: EmbedDescriptor): string | undefined {
  if (!embed.source || embed.provider === "blank" || embed.provider === "x") return undefined;
  return new URL(embed.source).origin;
}

export function planManagedPublicRender(document: PageDocument, policy: ManagedPublicPolicy, parentOrigin: string, embeds: readonly PublishedEmbed[],
  assetManifest: readonly CmsPublicAsset[] = []) {
  const frames = new Set<string>(), images = new Set<string>(), media = new Set<string>();
  let presentation = false, managedEmbed = false;
  const embedByRef = new Map(embeds.map(({ refId, src }) => [refId, src.origin]));
  const approvedAssetUrls = new Set(assetManifest.map(({ url }) => new URL(url, parentOrigin).href));
  const resource = (value: unknown) => publicResourceSource(value, parentOrigin, policy.resourceOrigins, approvedAssetUrls);
  const resourceAttributes = ["src", "srcSet", "poster"] as const;
  const fallbackImage = (node: ElementNode): ElementNode => {
    const alt = node.attrs?.alt;
    const attrs = typeof alt === "string" && alt ? { role: "img", "aria-label": alt } : { "aria-hidden": "true" };
    return { type: "element", id: node.id, tag: "span", attrs, ...(node.style && { style: node.style }), children: [] };
  };
  const project = (nodes: readonly PageNode[]): PageNode[] => nodes.map((node): PageNode => {
    if (node.type === "component" && node.block === "ManagedEmbed") {
      const origin = embedByRef.get(String(node.props.refId));
      if (!origin || !publicScriptPaths.nihoEmbeds) return { type: "element", id: node.id, tag: "div", children: [] };
      frames.add(origin);
      managedEmbed = true;
      return node;
    }
    if (node.type !== "element") return node;
    if (node.embed) {
      const origin = frameOrigin(node.embed);
      const needsPresentation = ["lottie", "facebook", "instagram"].includes(node.embed.provider);
      if (!origin || !policy.frameOrigins.includes(origin) || needsPresentation && !publicScriptPaths.presentation) {
        return { ...node, embed: { provider: node.embed.provider, title: node.embed.title } };
      }
      presentation ||= needsPresentation;
      frames.add(origin);
    }
    const attrs = node.attrs && { ...node.attrs };
    if (attrs) for (const key of resourceAttributes) {
      if (attrs[key] !== undefined && !resource(attrs[key])) delete attrs[key];
    }
    if (node.tag === "img" && !node.asset && !attrs?.src) {
      if (!attrs?.srcSet) return fallbackImage(node);
      attrs.src = attrs.srcSet;
    }
    if (node.tag === "video" && !node.asset && !attrs?.src) {
      const caption = [attrs?.["aria-label"], attrs?.title].find((value): value is string => typeof value === "string" && !!value.trim()) ?? "動画";
      return { type: "element", id: node.id, tag: "span", ...(node.style && { style: node.style }),
        children: [{ type: "text", text: caption }] };
    }
    const children = project(node.children);
    if (node.interaction?.type === "video-toggle") {
      const video = children[0];
      if (video?.type !== "element" || video.tag !== "video") {
        const { interaction: _interaction, ...wrapper } = node;
        return { ...wrapper, children: children.slice(0, 1) };
      }
    }
    if (node.interaction) presentation = true;
    const fallback = children.at(-1), original = node.children.at(-1);
    if (node.tag === "picture" && fallback?.type === "element" && fallback.tag !== "img" && original?.type === "element") {
      const source = children.find((child): child is ElementNode => child.type === "element" && child.tag === "source" && typeof child.attrs?.srcSet === "string");
      const alternative = source?.attrs?.srcSet;
      if (typeof alternative !== "string") return { ...node, tag: "span", children: [fallback] };
      const attrs: ElementAttributes = { ...original.attrs, src: alternative };
      delete attrs.srcSet;
      children[children.length - 1] = { ...original, attrs };
    }
    return { ...node, ...(attrs && { attrs }), children };
  });
  const body = project(document.body);
  const collectMedia = (nodes: readonly PageNode[]) => {
    for (const node of nodes) {
      if (node.type !== "element") continue;
      if (node.tag !== "video" || typeof node.attrs?.src === "string") {
        for (const key of resourceAttributes) {
          const source = resource(node.attrs?.[key]);
          if (source) (node.tag === "video" && key === "src" ? media : images).add(source);
        }
      }
      collectMedia(node.children);
    }
  };
  collectMedia(body);
  const meta = document.meta && { ...document.meta };
  const faviconSource = resource(meta?.favicon);
  if (faviconSource) images.add(faviconSource);
  else if (meta) delete meta.favicon;
  const defaultOgSource = resource(policy.seo.defaultOgImage);
  if (defaultOgSource) images.add(defaultOgSource);
  if (meta?.ogImage && "src" in meta.ogImage && !resource(meta.ogImage.src)) delete meta.ogImage;
  const rendered = { ...document, body, ...(meta && { meta }) };
  const assets: Record<string, ResolvedAsset> = {};
  const manifest = new Map(assetManifest.map((asset) => [assetKey(asset.reference), asset]));
  for (const { reference, target } of collectAssetReferences(rendered)) {
    const key = assetKey(reference), asset = manifest.get(key);
    const source = resource(asset?.url);
    if (!asset || !source) continue;
    assets[key] = { src: asset.url, ...(asset.width === null ? {} : { width: asset.width }), ...(asset.height === null ? {} : { height: asset.height }) };
    if (target === "video") media.add(source);
    else if (target !== "ogImage") images.add(source);
  }
  const scriptUrls = [managedEmbed ? publicScriptPaths.nihoEmbeds : null, presentation ? publicScriptPaths.presentation : null]
    .flatMap((path) => path ? [new URL(path, parentOrigin)] : []);
  return {
    document: rendered,
    assets,
    head: (measurementId: string | null) => managedPublicHead({
      measurementId, scriptUrls, frameSources: frames, imageSources: images, mediaSources: media, inlineStyles: true, resolveEmbed: managedEmbed
    })
  };
}

export const managedPublicBlocks = {
  ManagedEmbed: {
    ...managedEmbedContract,
    component: ({ refId, background, initialHeight }: Record<string, PublicPropValue>) => createElement("div", {
      "data-managed-embed-ref": refId, "data-managed-embed-background": background, "data-managed-embed-height": initialHeight,
      "data-nw-slot": "frame", style: { minHeight: Number(initialHeight), overflow: "hidden" }
    }, createElement("p", { "data-managed-embed-status": "", role: "status" }))
  }
} satisfies BlockRegistry;
