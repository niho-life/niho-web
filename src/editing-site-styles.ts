import { parseSiteStyles, type SiteStyles, type SiteStylesSnapshot } from "./site-styles.js";
import type { DesignToken, TextStyle } from "./types.js";
import { identifier, keys, line, localeCode, record } from "./validation-utils.js";
import { EDITOR_RELEASE_WARNING_CODES, type EditorReleaseWarning } from "./editor-types.js";

export const SITE_STYLES_FEATURE = "site.styles" as const;
export const SITE_STYLES_OPERATION_IDS = Object.freeze(["site.styles.read", "site.styles.edit", "site.styles.publish"] as const);
export type EditingSiteStylesOperationId = typeof SITE_STYLES_OPERATION_IDS[number];

export type EditingSiteStyleKind = "token" | "textStyle";
export type EditingSiteStylesRename = { readonly type: "rename"; readonly styleKind: EditingSiteStyleKind; readonly from: string; readonly to: string };
export type EditingSiteStylesEdit =
  | { readonly type: "set"; readonly styleKind: "token"; readonly name: string; readonly value: DesignToken }
  | { readonly type: "set"; readonly styleKind: "textStyle"; readonly name: string; readonly value: TextStyle }
  | { readonly type: "delete"; readonly styleKind: EditingSiteStyleKind; readonly name: string }
  | { readonly type: "rename"; readonly styleKind: EditingSiteStyleKind; readonly from: string; readonly to: string };

export type EditingSiteStylesUsage = {
  readonly kind: "page" | "locale" | "component" | "presentation" | "shared" | "template" | "siteStyle";
  readonly id: string;
  readonly locale?: string;
  readonly path?: string;
};

export type EditingSiteStylesEditRequest = { readonly expectedVersion: string; readonly edits: readonly EditingSiteStylesEdit[] };
export type EditingSiteStylesEditResult =
  | { readonly status: "saved"; readonly version: string; readonly styles: SiteStyles }
  | { readonly status: "referenced"; readonly usages: readonly EditingSiteStylesUsage[] }
  | { readonly status: "conflict" };
export type EditingSiteStylesPublishRequest = { readonly expectedDraftVersion: string; readonly expectedPublishedVersion: string };
export type EditingSiteStylesPublishResult =
  | { readonly status: "published"; readonly version: string; readonly styles: SiteStyles;
      readonly urls: readonly string[]; readonly elapsedMs: number; readonly warnings: readonly EditorReleaseWarning[] }
  | { readonly status: "failed"; readonly failedUrl: string; readonly message: string }
  | { readonly status: "conflict" };

/**
 * `edit` is one storage transaction: rename rewrites every reference with the definition, while a
 * referenced delete returns all usages without writing. `publish` switches the style pointer and
 * static publication manifest in the same transaction.
 */
export type EditingSiteStylesHostAdapter<Actor> = {
  read(actor: Actor, siteId: string): Promise<SiteStylesSnapshot | null>;
  edit(actor: Actor, siteId: string, input: EditingSiteStylesEditRequest): Promise<EditingSiteStylesEditResult>;
  publish(actor: Actor, siteId: string, input: EditingSiteStylesPublishRequest): Promise<EditingSiteStylesPublishResult>;
};

const VERSION_LIMIT = 200;
const styleName = (value: unknown, path: string) => identifier(value, path);
export const editingSiteStylesVersion = (value: unknown, path: string): string => line(value, path, VERSION_LIMIT);

function checkedStyles(value: unknown, path: string): SiteStyles {
  const source = record(value, path); keys(source, ["tokens", "textStyles"], path);
  return parseSiteStyles(source as SiteStyles);
}

export function parseEditingSiteStylesSnapshot(value: unknown): SiteStylesSnapshot {
  const source = record(value, "$result"); keys(source, ["draft", "published"], "$result");
  const draft = record(source.draft, "$result.draft"), published = record(source.published, "$result.published");
  keys(draft, ["version", "styles"], "$result.draft"); keys(published, ["version", "styles"], "$result.published");
  return {
    draft: { version: editingSiteStylesVersion(draft.version, "$result.draft.version"), styles: checkedStyles(draft.styles, "$result.draft.styles") },
    published: { version: editingSiteStylesVersion(published.version, "$result.published.version"), styles: checkedStyles(published.styles, "$result.published.styles") }
  };
}

function parsedSet(source: Record<string, unknown>, path: string): EditingSiteStylesEdit {
  const name = styleName(source.name, `${path}.name`);
  if (source.styleKind === "token") {
    const styles = parseSiteStyles({ tokens: { [name]: source.value as DesignToken } });
    return { type: "set", styleKind: "token", name, value: styles.tokens![name]! };
  }
  if (source.styleKind === "textStyle") {
    // References are validated after the complete edit list is applied to the current draft.
    return { type: "set", styleKind: "textStyle", name, value: record(source.value, `${path}.value`) as unknown as TextStyle };
  }
  throw new TypeError(`${path}.styleKind: invalid style kind`);
}

function parseEdit(value: unknown, index: number): EditingSiteStylesEdit {
  const path = `$input.edits[${index}]`, source = record(value, path);
  if (source.type === "set") { keys(source, ["type", "styleKind", "name", "value"], path); return parsedSet(source, path); }
  if (source.styleKind !== "token" && source.styleKind !== "textStyle") throw new TypeError(`${path}.styleKind: invalid style kind`);
  if (source.type === "delete") {
    keys(source, ["type", "styleKind", "name"], path);
    return { type: "delete", styleKind: source.styleKind, name: styleName(source.name, `${path}.name`) };
  }
  if (source.type === "rename") {
    keys(source, ["type", "styleKind", "from", "to"], path);
    const from = styleName(source.from, `${path}.from`), to = styleName(source.to, `${path}.to`);
    if (from === to) throw new TypeError(`${path}: rename must change the name`);
    return { type: "rename", styleKind: source.styleKind, from, to };
  }
  throw new TypeError(`${path}.type: invalid edit type`);
}

export function parseEditingSiteStylesEditRequest(value: unknown): EditingSiteStylesEditRequest {
  const source = record(value, "$input"); keys(source, ["expectedVersion", "edits"], "$input");
  if (!Array.isArray(source.edits) || source.edits.length < 1 || source.edits.length > 500) throw new TypeError("$input.edits: expected 1 to 500 edits");
  return { expectedVersion: editingSiteStylesVersion(source.expectedVersion, "$input.expectedVersion"), edits: source.edits.map(parseEdit) };
}

export function parseEditingSiteStylesPublishRequest(value: unknown): EditingSiteStylesPublishRequest {
  const source = record(value, "$input"); keys(source, ["expectedDraftVersion", "expectedPublishedVersion"], "$input");
  return { expectedDraftVersion: editingSiteStylesVersion(source.expectedDraftVersion, "$input.expectedDraftVersion"),
    expectedPublishedVersion: editingSiteStylesVersion(source.expectedPublishedVersion, "$input.expectedPublishedVersion") };
}

function usage(value: unknown, index: number, strict: boolean): EditingSiteStylesUsage {
  const path = `$result.usages[${index}]`, source = record(value, path);
  if (strict) keys(source, ["kind", "id", "locale", "path"], path);
  if (!["page", "locale", "component", "presentation", "shared", "template", "siteStyle"].includes(String(source.kind))) throw new TypeError(`${path}.kind: invalid usage kind`);
  return { kind: source.kind as EditingSiteStylesUsage["kind"], id: identifier(source.id, `${path}.id`),
    ...(source.locale === undefined ? {} : { locale: localeCode(source.locale, `${path}.locale`) }),
    ...(source.path === undefined ? {} : { path: line(source.path, `${path}.path`, 500) }) };
}

function parseSiteStylesEditResult(value: unknown, expectedVersion: string, strict: boolean): Exclude<EditingSiteStylesEditResult, { status: "conflict" }> {
  const source = record(value, "$result");
  if (source.status === "referenced") {
    if (strict) keys(source, ["status", "usages"], "$result");
    if (!Array.isArray(source.usages) || source.usages.length < 1 || source.usages.length > 10_000) throw new TypeError("$result.usages: invalid usage list");
    return { status: "referenced", usages: source.usages.map((entry, index) => usage(entry, index, strict)) };
  }
  if (strict) keys(source, ["status", "version", "styles"], "$result");
  const version = editingSiteStylesVersion(source.version, "$result.version");
  if (source.status !== "saved" || version === expectedVersion) throw new TypeError("$result: invalid saved result");
  return { status: "saved", version, styles: checkedStyles(source.styles, "$result.styles") };
}

/** Strict host-result validation used by the server adapter boundary. */
export function parseEditingSiteStylesEditResult(value: unknown, expectedVersion: string): Exclude<EditingSiteStylesEditResult, { status: "conflict" }> {
  return parseSiteStylesEditResult(value, expectedVersion, true);
}

/** Tolerant client-result parsing that drops fields added by a newer server. */
export function parseEditingSiteStylesEditResponse(value: unknown, expectedVersion: string): Exclude<EditingSiteStylesEditResult, { status: "conflict" }> {
  return parseSiteStylesEditResult(value, expectedVersion, false);
}

function parseSiteStylesPublishResult(value: unknown, expectedVersion: string, strict: boolean): Exclude<EditingSiteStylesPublishResult, { status: "conflict" }> {
  const source = record(value, "$result");
  if (source.status === "failed") {
    if (strict) keys(source, ["status", "failedUrl", "message"], "$result");
    const failedUrl = line(source.failedUrl, "$result.failedUrl", 512), message = line(source.message, "$result.message", 1000);
    if (!failedUrl.startsWith("https://")) throw new TypeError("$result.failedUrl: expected HTTPS URL");
    return { status: "failed", failedUrl, message };
  }
  if (strict) keys(source, ["status", "version", "styles", "urls", "elapsedMs", "warnings"], "$result");
  const version = editingSiteStylesVersion(source.version, "$result.version");
  if (source.status !== "published" || version === expectedVersion) throw new TypeError("$result: invalid published result");
  if (!Array.isArray(source.urls) || source.urls.length > 1000 || source.urls.some((value) => {
    if (typeof value !== "string" || value.length > 2048) return true;
    try { const parsed = new URL(value); return parsed.protocol !== "https:" || !!parsed.username || !!parsed.password; } catch { return true; }
  }) || !Number.isSafeInteger(source.elapsedMs) || Number(source.elapsedMs) < 0 || Number(source.elapsedMs) > 600_000
    || !Array.isArray(source.warnings) || source.warnings.length > 100 || source.warnings.some((warning) => {
      if (!warning || typeof warning !== "object" || Array.isArray(warning)) return true;
      const item = warning as Record<string, unknown>;
      return !EDITOR_RELEASE_WARNING_CODES.includes(item.code as EditorReleaseWarning["code"])
        || typeof item.message !== "string" || item.message.length > 1000;
    })) throw new TypeError("$result: invalid publication summary");
  return { status: "published", version, styles: checkedStyles(source.styles, "$result.styles"),
    urls: source.urls as string[], elapsedMs: Number(source.elapsedMs), warnings: source.warnings as EditorReleaseWarning[] };
}

/** Strict host-result validation used by the server adapter boundary. */
export function parseEditingSiteStylesPublishResult(value: unknown, expectedVersion: string): Exclude<EditingSiteStylesPublishResult, { status: "conflict" }> {
  return parseSiteStylesPublishResult(value, expectedVersion, true);
}

/** Tolerant client-result parsing that drops fields added by a newer server. */
export function parseEditingSiteStylesPublishResponse(value: unknown, expectedVersion: string): Exclude<EditingSiteStylesPublishResult, { status: "conflict" }> {
  return parseSiteStylesPublishResult(value, expectedVersion, false);
}

/** Rename one local definition and its references inside the draft style library. */
export function renameSiteStyle(styles: SiteStyles, styleKind: EditingSiteStyleKind, fromValue: string, toValue: string): SiteStyles {
  const current = parseSiteStyles(styles), from = styleName(fromValue, "$rename.from"), to = styleName(toValue, "$rename.to");
  if (from === to) throw new TypeError("rename must change the name");
  const definitions = styleKind === "token" ? current.tokens ?? {} : current.textStyles ?? {};
  if (!Object.hasOwn(definitions, from)) throw new TypeError("rename source does not exist");
  if (Object.hasOwn(definitions, to)) throw new TypeError("rename target already exists");
  const renamed = Object.fromEntries(Object.entries(definitions).filter(([name]) => name !== from));
  renamed[to] = definitions[from]!;
  if (styleKind === "token") {
    const rewrite = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rewrite);
      if (!value || typeof value !== "object") return value;
      if (Object.keys(value).length === 1 && (value as { token?: unknown }).token === from) return { token: to };
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry)]));
    };
    return parseSiteStyles({ ...current, tokens: renamed as NonNullable<SiteStyles["tokens"]>, ...(current.textStyles ? { textStyles: rewrite(current.textStyles) as NonNullable<SiteStyles["textStyles"]> } : {}) });
  }
  return parseSiteStyles({ ...current, textStyles: renamed as NonNullable<SiteStyles["textStyles"]> });
}

/** Build the shared edit request used by the GUI facade and CLI. */
export function siteStylesEdits(before: SiteStyles, after: SiteStyles, renames: readonly EditingSiteStylesRename[] = []): EditingSiteStylesEdit[] {
  const old = parseSiteStyles(before), next = parseSiteStyles(after), edits: EditingSiteStylesEdit[] = [];
  for (const rename of renames) {
    const source = rename.styleKind === "token" ? old.tokens : old.textStyles;
    const target = rename.styleKind === "token" ? next.tokens : next.textStyles;
    if (!source || !Object.hasOwn(source, rename.from) || !target || !Object.hasOwn(target, rename.to)) throw new TypeError("rename does not match the saved and edited styles");
    edits.push(rename);
  }
  for (const styleKind of ["token", "textStyle"] as const) {
    const previous = styleKind === "token" ? old.tokens ?? {} : old.textStyles ?? {};
    const current = styleKind === "token" ? next.tokens ?? {} : next.textStyles ?? {};
    const kindRenames = renames.filter((rename) => rename.styleKind === styleKind);
    const renamedSources = new Set(kindRenames.map(({ from }) => from));
    const renamedTargets = new Set(kindRenames.map(({ to }) => to));
    for (const { from, to } of kindRenames) {
      const source = previous[from];
      const destination = current[to];
      if (destination !== undefined && JSON.stringify(destination) !== JSON.stringify(source)) {
        edits.push(styleKind === "token" ? { type: "set", styleKind, name: to, value: destination as DesignToken }
          : { type: "set", styleKind, name: to, value: destination as TextStyle });
      }
    }
    for (const name of new Set([...Object.keys(previous), ...Object.keys(current)])) {
      if (renamedTargets.has(name)) continue;
      const value = current[name];
      if (renamedSources.has(name)) {
        if (value !== undefined) edits.push(styleKind === "token" ? { type: "set", styleKind, name, value: value as DesignToken }
          : { type: "set", styleKind, name, value: value as TextStyle });
        continue;
      }
      if (value === undefined) edits.push({ type: "delete", styleKind, name });
      else if (JSON.stringify(value) !== JSON.stringify(previous[name])) {
        edits.push(styleKind === "token" ? { type: "set", styleKind, name, value: value as DesignToken }
          : { type: "set", styleKind, name, value: value as TextStyle });
      }
    }
  }
  return edits;
}
