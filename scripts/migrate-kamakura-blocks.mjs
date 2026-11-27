import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { cmsPageBindingProblems, parseCmsPageBindings } from "../dist/cms-page-bindings.js";
import { parseCmsSchema } from "../dist/cms-v2-schema.js";
import { mergeStyle } from "../dist/component-expand.js";
import { resolvePageDocument } from "../dist/components.js";
import { parsePageDocument } from "../dist/document.js";
import { normalizeNodeFragment } from "../dist/editor-fragment.js";
import { parseEmbedDescriptor } from "../dist/embeds.js";
import { MANAGED_EMBED_REF, managedBlockContracts } from "../dist/managed-embed-block.js";
import { parseSitePresentation, sitePresentationHostViewKey } from "../dist/presentation.js";
import { identifier, isSafeHttpsOrigin, keys, record } from "../dist/validation-utils.js";

const replacementKind = new Map([
  ...["KamakuraCmsList", "KamakuraCompanyDirectory", "KamakuraRecentArticles"].map((block) => [block, "cms-list"]),
  ["KamakuraCmsDetail", "cms-detail"], ["KamakuraCarousel", "carousel"],
  ...["KamakuraLegacyFrame", "KamakuraCalendarEmbed", "KamakuraMapEmbed"].map((block) => [block, "frame"]),
  ...["KamakuraLegacyForm", "KamakuraDropInBooking", "KamakuraRentalForm", "KamakuraContactForm", "ManagedEmbed"].map((block) => [block, "managed-embed"])
]);

function indexElements(nodes, byId = new Map()) {
  for (const node of nodes) if (node.type === "element") {
    byId.set(node.id, node);
    indexElements(node.children, byId);
  }
  return byId;
}

function mergeDefinitions(into, source, kind) {
  for (const [name, value] of Object.entries(source ?? {})) {
    if (Object.hasOwn(into, name) && JSON.stringify(into[name]) !== JSON.stringify(value)) throw new Error(`conflicting ${kind}: ${name}`);
    into[name] = value;
  }
}

function explicitPublicFrame(input, source, allowedOrigins) {
  const requested = parseEmbedDescriptor(input, "replacement.embed");
  if (!requested.source || !["map", "url", "youtube", "vimeo"].includes(requested.provider)) return null;
  const actual = parseEmbedDescriptor({ provider: requested.provider, source, title: requested.title }, "view.frame");
  if (actual.source !== requested.source) return null;
  const url = new URL(requested.source);
  const checkedNames = new Set(["token", "launchtoken", "accesstoken", "apikey", "signature", "key", "auth"]);
  if (!allowedOrigins.has(url.origin) || /^\/embed\/(?:dropin|rental|inquiry)\//u.test(url.pathname) ||
    [...url.searchParams.keys()].some((key) => checkedNames.has(key.toLowerCase().replace(/[-_]/gu, "")))) return null;
  return requested;
}

/** Offline conversion of one whole draft. Missing or unsupported replacements return no draft to save. */
export function migrateKamakuraBlocks(input) {
  const source = record(input, "input");
  keys(source, ["document", "sourceBlocks", "sourceComponents", "sourceStyles", "presentation", "target", "replacements", "cmsSchema", "frameOrigins"], "input");
  const target = record(source.target, "target");
  keys(target, ["siteId", "pageId", "locale", "revision", "version"], "target");
  identifier(target.siteId, "target.siteId");
  identifier(target.pageId, "target.pageId");
  if (!Number.isSafeInteger(target.revision) || target.revision < 1 ||
    typeof target.version !== "string" || !/^[^\u0000-\u001f\u007f]{1,200}$/u.test(target.version)) throw new Error("invalid target draft version");
  const legacy = resolvePageDocument(source.document, source.sourceComponents, source.sourceBlocks, source.sourceStyles).document;
  if (target.locale !== legacy.locale) throw new Error("source and target locales differ");
  const presentation = source.presentation === undefined ? undefined : parseSitePresentation(source.presentation, legacy, source.sourceBlocks);
  const views = new Map((presentation?.hostViews ?? []).map((view) => [sitePresentationHostViewKey(view.block, view.props), view]));
  const frameOrigins = source.frameOrigins ?? [];
  if (!Array.isArray(frameOrigins) || !frameOrigins.every(isSafeHttpsOrigin)) throw new Error("invalid destination frame origins");
  const allowedOrigins = new Set(frameOrigins);
  if (!Array.isArray(source.replacements)) throw new Error("replacements must be an array");
  const replacements = new Map();
  for (const value of source.replacements) {
    const entry = record(value, "replacement"), id = identifier(entry.nodeId, "replacement.nodeId");
    if (replacements.has(id)) throw new Error("duplicate replacement node");
    replacements.set(id, entry);
  }
  const { version, ...scope } = target;
  const draft = { ...legacy, ...scope, body: [], tokens: { ...legacy.tokens }, textStyles: { ...legacy.textStyles } };
  const lists = [], migrated = [], blocked = [];
  let detail;
  const occupied = { ...legacy, body: [...legacy.body] };
  const wrap = (node, children) => ({ type: "element", id: node.id, tag: "div",
    ...(node.name !== undefined && { name: node.name }), ...(node.style !== undefined && { style: node.style }), children });

  function convert(node, entry) {
    const kind = replacementKind.get(node.block);
    if (!kind) return "unsupported-block";
    if (!entry) return "missing-replacement";
    if (entry.kind !== kind) return "wrong-replacement-kind";
    if (kind === "managed-embed") {
      keys(entry, ["nodeId", "kind", "refId", "background", "initialHeight"], "replacement");
      if (typeof entry.refId !== "string" || !MANAGED_EMBED_REF.test(entry.refId)) return "missing-target-embed-reference";
      if (Object.keys(node.slots ?? {}).some((slot) => slot !== "frame")) return "form-slot-style-requires-review";
      return { type: "component", id: node.id, block: "ManagedEmbed", ...(node.name !== undefined && { name: node.name }),
        ...(node.style !== undefined && { style: node.style }), ...(node.slots !== undefined && { slots: node.slots }),
        props: { refId: entry.refId, background: entry.background ?? "white", initialHeight: entry.initialHeight ?? 720 } };
    }
    if (kind === "cms-list" || kind === "cms-detail") {
      keys(entry, ["nodeId", "kind", "body", "binding", "slotBindings"], "replacement");
      if (!Array.isArray(entry.body) || !entry.body.length) return "missing-cms-layout";
      if (kind === "cms-detail" && detail) return "multiple-cms-detail-bindings";
      const body = structuredClone(entry.body), byId = indexElements(body), binding = record(entry.binding, "replacement.binding");
      if (!Array.isArray(binding.fields) || !binding.fields.every((field) => byId.has(field?.nodeId))) return "cms-binding-outside-replacement";
      if (kind === "cms-list" && !byId.has(binding.templateNodeId)) return "cms-template-outside-replacement";
      applySlotStyles(node, byId, entry.slotBindings);
      if (kind === "cms-list") lists.push(binding); else detail = binding;
      occupied.body.push(...body);
      return wrap(node, body);
    }
    const view = views.get(sitePresentationHostViewKey(node.block, node.props));
    if (!view) return "missing-source-host-view";
    const body = structuredClone(view.document.body), byId = indexElements(body);
    if (kind === "frame") {
      keys(entry, ["nodeId", "kind", "embed"], "replacement");
      const [frame, extra] = view.externalFrames ?? [];
      if (!frame || extra || frame.frameKey || frame.loading === "eager") return "frame-needs-host-behavior";
      const checked = explicitPublicFrame(entry.embed, frame.src, allowedOrigins);
      if (!checked || frame.allowFullScreen && checked.provider !== "map" && checked.provider !== "youtube" && checked.provider !== "vimeo") {
        return "frame-destination-not-confirmed";
      }
      byId.get(frame.nodeId).embed = checked;
    } else {
      keys(entry, ["nodeId", "kind"], "replacement");
      if (!view.carousel || view.externalFrames?.length) return "carousel-needs-host-behavior";
      const { rootId, ...binding } = view.carousel;
      byId.get(rootId).interaction = { type: "carousel", binding };
    }
    applySlotStyles(node, byId, view.slotBindings);
    mergeDefinitions(draft.tokens, view.document.tokens, "token");
    mergeDefinitions(draft.textStyles, view.document.textStyles, "text style");
    const children = normalizeNodeFragment(body, occupied);
    occupied.body.push(...children);
    return wrap(node, children);
  }

  function visit(nodes) {
    return nodes.map((node) => {
      if (node.type === "element") return { ...node, children: visit(node.children) };
      if (node.type !== "component") return node;
      const entry = replacements.get(node.id);
      replacements.delete(node.id);
      const replacement = convert(node, entry);
      if (typeof replacement === "string") { blocked.push({ nodeId: node.id, block: node.block, reason: replacement }); return node; }
      migrated.push({ nodeId: node.id, block: node.block, replacement: entry.kind });
      return replacement;
    });
  }
  draft.body = visit(legacy.body);
  for (const nodeId of replacements.keys()) blocked.push({ nodeId, reason: "unknown-component-node" });
  if (blocked.length) return { status: "blocked", blocked };
  const document = parsePageDocument(draft, managedBlockContracts);
  const cmsBindings = lists.length || detail ? parseCmsPageBindings({
    schemaVersion: 1, siteId: document.siteId, pageId: document.pageId, locale: document.locale, lists, ...(detail && { detail })
  }, document) : null;
  if (cmsBindings) {
    const problems = cmsPageBindingProblems(document, cmsBindings, parseCmsSchema(source.cmsSchema));
    if (problems.length) return { status: "blocked", blocked: problems };
  }
  return { status: "ready", snapshot: { document, version }, cmsBindings, migrated };
}

function applySlotStyles(node, nodes, bindings) {
  for (const [slot, style] of Object.entries(node.slots ?? {})) {
    const targets = bindings && Object.hasOwn(bindings, slot) ? bindings[slot] : [];
    if (!Array.isArray(targets) || !targets.length || targets.some((id) => !nodes.has(id))) throw new Error(`unmapped style for slot ${slot}`);
    for (const id of targets) {
      const element = nodes.get(id);
      element.style = mergeStyle(element.style, style);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) {
    console.error("Usage: node scripts/migrate-kamakura-blocks.mjs <input.json|->");
    process.exitCode = 2;
  } else try {
    const result = migrateKamakuraBlocks(JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8")));
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.status !== "ready") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid migration input");
    process.exitCode = 2;
  }
}
