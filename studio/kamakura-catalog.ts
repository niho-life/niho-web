import { isStyleProperty } from "../src/style-values.js";
import { isTemplatePath, validatePagePath } from "../src/pages.js";
import type { EditorPage, EditorPageChange, EditorSite } from "../src/editor-types.js";
import type { BlockContracts, BlockSlot, PropRule, StyleProperty } from "../src/types.js";
import { KAMAKURA_MEDIA_ORIGIN } from "./kamakura-cms-contract.js";

export const KAMAKURA_CATALOG_CONTRACT_ERROR_CODE = "upstream_contract_invalid" as const;
export const KAMAKURA_CATALOG_CONTRACT_ERROR_STATUS = 502 as const;
export const KAMAKURA_EDITOR_SITE_ID = "kamakura" as const;
export const KAMAKURA_EDITOR_SITE_NAME = "鎌倉サイト";
const KAMAKURA_PREVIEW_SITE_NAME = "鎌倉サイト（Preview）";
const KAMAKURA_EDITOR_DOMAINS = ["https://next-kamakura.niho.life", "https://kamakura.niho.life"] as const;
export function isKamakuraEditorDomain(value: unknown): value is string {
  return typeof value === "string" && KAMAKURA_EDITOR_DOMAINS.some((domain) => domain === value);
}
/** キャンバスでorigin維持（`allow-same-origin`）を許す外部frameの上限。実行コード（editor）だけが持ち、サイト単位の許可とJSONからは増やせない。 */
export const KAMAKURA_ORIGIN_RETAINING_FRAME_SOURCES = ["https://www.google.com/maps/embed"] as const;
/** 不変HTML embedの置き場（Studio editor routeのCSP `frame-src` と同じprefix）。キャンバスでは権限なしのopaque iframeで描く。 */
export const KAMAKURA_EMBED_FRAME_SOURCE = `${KAMAKURA_MEDIA_ORIGIN}/niho-web/embeds/v1/` as const;
/** サイト単位で許可する外部frame。上限（origin維持）に入るものはorigin維持、入らない不変embedはopaqueで描かれる。 */
export const KAMAKURA_EXTERNAL_FRAME_SOURCES = [...KAMAKURA_ORIGIN_RETAINING_FRAME_SOURCES, KAMAKURA_EMBED_FRAME_SOURCE] as const;
export const KAMAKURA_COMMON_PAGE_ID = /^(?!(?:catalog|create|index)$)[a-z][a-z0-9-]{0,59}$/u;

const KAMAKURA_PAGE_CHANGE_ACTIONS = ["update", "create", "visibility"] as const satisfies readonly EditorPageChange["action"][];
export type KamakuraPageChangeAction = typeof KAMAKURA_PAGE_CHANGE_ACTIONS[number];
const isPageChangeAction = (value: unknown): value is KamakuraPageChangeAction => KAMAKURA_PAGE_CHANGE_ACTIONS.some((action) => action === value);

export type KamakuraLegacyPage = { readonly name: string; readonly path: string };
export type KamakuraCatalog = {
  readonly project: { readonly id: "kamakura-site"; readonly name: "NIHO kamakura"; readonly site: EditorSite };
  readonly sites: readonly EditorSite[];
  readonly pages: readonly EditorPage[];
  readonly legacy: readonly KamakuraLegacyPage[];
  readonly blockContracts: BlockContracts;
  readonly pagePathEditable?: boolean;
  readonly pageChangeActions?: readonly KamakuraPageChangeAction[];
  readonly nativePresentationPages: readonly string[];
};

export class KamakuraCatalogContractError extends Error {
  readonly code = KAMAKURA_CATALOG_CONTRACT_ERROR_CODE;

  constructor() {
    super("Kamakura catalog does not match the supported contract");
    this.name = "KamakuraCatalogContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function catalogText(value: unknown, maximum?: number): string {
  if (typeof value !== "string" || !value || (maximum !== undefined && value.length > maximum) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new KamakuraCatalogContractError();
  }
  return value;
}

function parseSite(value: unknown, previewOrigin?: string): EditorSite {
  const expectedName = previewOrigin === undefined ? KAMAKURA_EDITOR_SITE_NAME : KAMAKURA_PREVIEW_SITE_NAME;
  if (!isRecord(value) || value.id !== KAMAKURA_EDITOR_SITE_ID || value.name !== expectedName || !Array.isArray(value.domains) || value.domains.length !== 1
    || (previewOrigin === undefined ? !isKamakuraEditorDomain(value.domains[0]) : value.domains[0] !== previewOrigin)) {
    throw new KamakuraCatalogContractError();
  }
  return { id: KAMAKURA_EDITOR_SITE_ID, name: expectedName, domains: [value.domains[0]], externalFrameSources: KAMAKURA_EXTERNAL_FRAME_SOURCES };
}

function parsePropRule(value: unknown): PropRule {
  if (!isRecord(value) || (value.required !== undefined && typeof value.required !== "boolean")) throw new KamakuraCatalogContractError();
  const required = typeof value.required === "boolean" ? { required: value.required } : {};
  if (value.type === "string") {
    if (value.maxLength !== undefined && (!Number.isSafeInteger(value.maxLength) || (value.maxLength as number) < 1 || (value.maxLength as number) > 100_000)) throw new KamakuraCatalogContractError();
    return { type: "string", ...required, ...(value.maxLength === undefined ? {} : { maxLength: value.maxLength as number }) };
  }
  if (value.type === "url") return { type: "url", ...required };
  if (value.type === "boolean") return { type: "boolean", ...required };
  if (value.type === "number") {
    const min = value.min, max = value.max;
    if ((min !== undefined && (typeof min !== "number" || !Number.isFinite(min))) || (max !== undefined && (typeof max !== "number" || !Number.isFinite(max))) || (min !== undefined && max !== undefined && min > max)) throw new KamakuraCatalogContractError();
    return { type: "number", ...required, ...(min === undefined ? {} : { min: min as number }), ...(max === undefined ? {} : { max: max as number }) };
  }
  if (value.type === "enum" && Array.isArray(value.values) && value.values.length > 0 && value.values.length <= 200) {
    const values = value.values.map((entry) => catalogText(entry, 1_000));
    if (new Set(values).size !== values.length) throw new KamakuraCatalogContractError();
    return { type: "enum", ...required, values };
  }
  throw new KamakuraCatalogContractError();
}

function parseBlockContracts(value: unknown): BlockContracts {
  if (!isRecord(value)) throw new KamakuraCatalogContractError();
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 100) throw new KamakuraCatalogContractError();
  const unsafeBlockNames = new Set(["constructor", "prototype", "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable"]);
  const unsafePropNames = new Set(["__proto__", "prototype", "constructor", "key", "ref", "children", "dangerouslySetInnerHTML"]);
  const result: Record<string, { props: Record<string, PropRule>; slots?: Record<string, BlockSlot> }> = {};
  for (const [block, candidate] of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(block) || unsafeBlockNames.has(block) || !isRecord(candidate) || !isRecord(candidate.props)) throw new KamakuraCatalogContractError();
    const propEntries = Object.entries(candidate.props);
    if (propEntries.length > 100) throw new KamakuraCatalogContractError();
    const props: Record<string, PropRule> = {};
    for (const [name, rule] of propEntries) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(name) || unsafePropNames.has(name) || /^on/iu.test(name)) throw new KamakuraCatalogContractError();
      props[name] = parsePropRule(rule);
    }
    const contract: { props: Record<string, PropRule>; slots?: Record<string, BlockSlot> } = { props };
    if (candidate.slots !== undefined) {
      if (!isRecord(candidate.slots) || Object.keys(candidate.slots).length > 100) throw new KamakuraCatalogContractError();
      const slots: Record<string, BlockSlot> = {};
      for (const [name, rawSlot] of Object.entries(candidate.slots)) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(name) || unsafePropNames.has(name) || !isRecord(rawSlot)) throw new KamakuraCatalogContractError();
        const label = catalogText(rawSlot.label, 200);
        if (!label.trim()) throw new KamakuraCatalogContractError();
        let style: StyleProperty[] | undefined;
        if (rawSlot.style !== undefined) {
          if (!Array.isArray(rawSlot.style) || rawSlot.style.length > 50 || !rawSlot.style.every(isStyleProperty) || new Set(rawSlot.style).size !== rawSlot.style.length) throw new KamakuraCatalogContractError();
          style = [...rawSlot.style];
        }
        let text: string | undefined;
        if (rawSlot.text !== undefined) {
          text = catalogText(rawSlot.text, 64);
          if (props[text]?.type !== "string") throw new KamakuraCatalogContractError();
        }
        let data: BlockSlot["data"] | undefined;
        if (rawSlot.data !== undefined) {
          if (!isRecord(rawSlot.data)) throw new KamakuraCatalogContractError();
          const reason = catalogText(rawSlot.data.reason, 200), source = catalogText(rawSlot.data.source, 200);
          if (!reason.trim() || !source.trim()) throw new KamakuraCatalogContractError();
          data = { reason, source };
        }
        slots[name] = { label, ...(style === undefined ? {} : { style }), ...(text === undefined ? {} : { text }), ...(data === undefined ? {} : { data }) };
      }
      contract.slots = slots;
    }
    result[block] = contract;
  }
  return result;
}

export function parseKamakuraCatalogPage(candidate: unknown): EditorPage {
  if (!isRecord(candidate) || candidate.siteId !== KAMAKURA_EDITOR_SITE_ID || candidate.locale !== "ja" || typeof candidate.pageId !== "string" || !KAMAKURA_COMMON_PAGE_ID.test(candidate.pageId)) {
    throw new KamakuraCatalogContractError();
  }
  const entry: EditorPage = { siteId: KAMAKURA_EDITOR_SITE_ID, pageId: candidate.pageId, locale: "ja", title: catalogText(candidate.title) };
  if (candidate.kind !== undefined) {
    if (candidate.kind !== "page" && candidate.kind !== "template" && candidate.kind !== "shared") throw new KamakuraCatalogContractError();
    entry.kind = candidate.kind;
  }
  if (candidate.path !== undefined) {
    const path = catalogText(candidate.path, 160);
    if (validatePagePath(path) !== null && !(entry.kind === "template" && isTemplatePath(path))) throw new KamakuraCatalogContractError();
    entry.path = path;
  }
  if (candidate.visibility !== undefined) {
    if (candidate.visibility !== "public" && candidate.visibility !== "private") throw new KamakuraCatalogContractError();
    entry.visibility = candidate.visibility;
  }
  if (candidate.published !== undefined) {
    if (typeof candidate.published !== "boolean") throw new KamakuraCatalogContractError();
    entry.published = candidate.published;
  }
  if (candidate.publication !== undefined) {
    if (!isRecord(candidate.publication)) throw new KamakuraCatalogContractError();
    entry.publication = { label: catalogText(candidate.publication.label, 40), description: catalogText(candidate.publication.description, 300) };
  }
  return entry;
}

/**
 * Validate and normalize the Kamakura catalog at both the Worker and browser
 * boundaries. Page titles are content, not identifiers; the Worker bounds the
 * complete upstream response to 2 MiB instead of imposing a UI-specific title
 * length that can drift from the producer's metadata.
 */
export function parseKamakuraCatalog(value: unknown, previewOrigin?: string): KamakuraCatalog {
  if (!isRecord(value) || !isRecord(value.project) || value.project.id !== "kamakura-site" || value.project.name !== "NIHO kamakura") {
    throw new KamakuraCatalogContractError();
  }

  const projectSite = parseSite(value.project.site, previewOrigin);
  if (!Array.isArray(value.sites) || value.sites.length !== 1 || !Array.isArray(value.pages) || value.pages.length > 500 || !Array.isArray(value.legacy) || value.legacy.length > 5_000) {
    throw new KamakuraCatalogContractError();
  }

  const site = parseSite(value.sites[0], previewOrigin);
  if (projectSite.domains[0] !== site.domains[0]) throw new KamakuraCatalogContractError();
  const pages = value.pages.map(parseKamakuraCatalogPage);
  if (new Set(pages.map(({ pageId }) => pageId)).size !== pages.length) throw new KamakuraCatalogContractError();

  const legacyPath = /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/u;
  const legacy: KamakuraLegacyPage[] = value.legacy.map((candidate): KamakuraLegacyPage => {
    if (!isRecord(candidate)) throw new KamakuraCatalogContractError();
    const name = catalogText(candidate.name, 200);
    const path = catalogText(candidate.path, 2_048);
    if (!legacyPath.test(path)) throw new KamakuraCatalogContractError();
    return { name, path };
  });
  if (new Set(legacy.map(({ name }) => name)).size !== legacy.length || new Set(legacy.map(({ path }) => path)).size !== legacy.length) {
    throw new KamakuraCatalogContractError();
  }

  const actions = value.pageChangeActions;
  if (actions !== undefined && (!Array.isArray(actions) || !actions.length || actions.length > KAMAKURA_PAGE_CHANGE_ACTIONS.length
    || !actions.every(isPageChangeAction) || new Set(actions).size !== actions.length)) throw new KamakuraCatalogContractError();
  if (value.pagePathEditable !== undefined && typeof value.pagePathEditable !== "boolean") throw new KamakuraCatalogContractError();
  const pageChangeActions = actions === undefined ? {} : { pageChangeActions: [...actions], pagePathEditable: value.pagePathEditable === true };
  const blockContracts = parseBlockContracts(value.blockContracts);
  const nativePresentationPages = value.nativePresentationPages ?? [];
  if (!Array.isArray(nativePresentationPages) || nativePresentationPages.length > 500 ||
      nativePresentationPages.some((id) => typeof id !== "string" || !KAMAKURA_COMMON_PAGE_ID.test(id) || !pages.some((page) => page.pageId === id)) ||
      new Set(nativePresentationPages).size !== nativePresentationPages.length) throw new KamakuraCatalogContractError();
  return { project: { id: "kamakura-site", name: "NIHO kamakura", site: projectSite }, sites: [site], pages, legacy, blockContracts, nativePresentationPages, ...pageChangeActions };
}
