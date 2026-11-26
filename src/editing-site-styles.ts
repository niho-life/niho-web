import { parseSiteStyles, type SiteStyles, type SiteStylesSnapshot } from "./site-styles.js";
import { identifier, keys, line, localeCode, record } from "./validation-utils.js";

export const SITE_STYLES_FEATURE = "site.styles" as const;
export const SITE_STYLES_OPERATION_IDS = Object.freeze([
  "site.styles.read", "site.styles.save", "site.styles.release-plan", "site.styles.release",
  "site.styles.migration-plan", "site.styles.migration-apply"
] as const);
export type EditingSiteStylesOperationId = typeof SITE_STYLES_OPERATION_IDS[number];

export type SitePublicationEpoch = string;
export type EditingSiteStyleKind = "token" | "textStyle";
export type EditingSiteStylesMigrationChange =
  | { readonly kind: "delete"; readonly styleKind: EditingSiteStyleKind; readonly name: string }
  | { readonly kind: "rename"; readonly styleKind: EditingSiteStyleKind; readonly from: string; readonly to: string };

export type EditingSiteStylesAffected = {
  readonly kind: "page" | "locale" | "component" | "presentation" | "shared" | "template";
  readonly id: string;
  readonly version: string;
  readonly locale?: string;
};

export type EditingSiteStylesReleaseRequest = {
  readonly expectedVersion: string;
  readonly expectedStylesVersion: string;
  readonly sitePublicationEpoch: SitePublicationEpoch;
  readonly operationId: string;
};
export type EditingSiteStylesReleasePlan = EditingSiteStylesReleaseRequest & {
  readonly siteId: string;
  readonly confirmationToken: string;
  readonly expiresAt: string;
  readonly before: SiteStyles;
  readonly after: SiteStyles;
  readonly affected: readonly EditingSiteStylesAffected[];
};
export type EditingSiteStylesReleaseApply = EditingSiteStylesReleaseRequest & { readonly confirmationToken: string };
export type EditingSiteStylesReleaseResult = {
  readonly status: "released";
  readonly operationId: string;
  readonly stylesVersion: string;
  readonly sitePublicationEpoch: SitePublicationEpoch;
};

export type EditingSiteStylesMigrationRequest = EditingSiteStylesReleaseRequest & { readonly changes: readonly EditingSiteStylesMigrationChange[] };
export type EditingSiteStylesMigrationPlan = EditingSiteStylesMigrationRequest & {
  readonly siteId: string;
  readonly confirmationToken: string;
  readonly expiresAt: string;
  readonly classification: "lossless" | "semantic" | "visual-change";
  readonly before: SiteStyles;
  readonly after: SiteStyles;
  readonly affected: readonly EditingSiteStylesAffected[];
};
export type EditingSiteStylesMigrationApply = EditingSiteStylesMigrationRequest & { readonly confirmationToken: string };
export type EditingSiteStylesMigrationResult = {
  readonly status: "applied";
  readonly operationId: string;
  readonly version: string;
  readonly stylesVersion: string;
  readonly sitePublicationEpoch: SitePublicationEpoch;
};

export type EditingSiteStylesFailureStatus =
  | "conflict" | "duplicate" | "invalid" | "not_found" | "migration_required"
  | "publication_in_progress" | "migration_in_progress";
export type EditingSiteStylesFailure = { readonly status: EditingSiteStylesFailureStatus };

/**
 * The host owns immutable snapshots, reference enumeration, operation journaling and the two
 * mutually-exclusive site fences. Apply methods must make their pointer changes and recorded
 * result visible in one storage transaction; the HTTP layer deliberately has no sequential fallback.
 */
export type EditingSiteStylesHostAdapter<Actor> = {
  read(actor: Actor, siteId: string): Promise<SiteStylesSnapshot | null>;
  /** Must CAS the draft version and reject any removal/rename even if the HTTP preflight raced. */
  save(actor: Actor, siteId: string, expectedVersion: string, styles: SiteStyles): Promise<{ readonly status: "saved"; readonly version: string } | EditingSiteStylesFailure>;
  prepareRelease?(actor: Actor, siteId: string, input: EditingSiteStylesReleaseRequest): Promise<{ readonly status: "prepared"; readonly plan: EditingSiteStylesReleasePlan } | EditingSiteStylesFailure>;
  release?(actor: Actor, siteId: string, input: EditingSiteStylesReleaseApply): Promise<EditingSiteStylesReleaseResult | EditingSiteStylesFailure>;
  prepareMigration?(actor: Actor, siteId: string, input: EditingSiteStylesMigrationRequest): Promise<{ readonly status: "prepared"; readonly plan: EditingSiteStylesMigrationPlan } | EditingSiteStylesFailure>;
  applyMigration?(actor: Actor, siteId: string, input: EditingSiteStylesMigrationApply): Promise<EditingSiteStylesMigrationResult | EditingSiteStylesFailure>;
};

const VERSION_LIMIT = 200;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EXPIRES_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const styleName = (value: unknown, path: string) => identifier(value, path);
export const editingSiteStylesVersion = (value: unknown, path: string): string => line(value, path, VERSION_LIMIT);
export function editingSiteStylesOperationId(value: unknown, path: string): string {
  const parsed = line(value, path, 36);
  if (!OPERATION_ID.test(parsed)) throw new TypeError(`${path}: invalid operation ID`);
  return parsed;
}

function checkedStyles(value: unknown, path: string): SiteStyles {
  const source = record(value, path); keys(source, ["tokens", "textStyles"], path);
  return parseSiteStyles(source as SiteStyles);
}
export function parseEditingSiteStylesSnapshot(value: unknown): SiteStylesSnapshot {
  const source = record(value, "$result"); keys(source, ["draft", "published", "sitePublicationEpoch"], "$result");
  const draft = record(source.draft, "$result.draft"), published = record(source.published, "$result.published");
  keys(draft, ["version", "styles"], "$result.draft"); keys(published, ["stylesVersion", "styles"], "$result.published");
  return {
    sitePublicationEpoch: editingSiteStylesVersion(source.sitePublicationEpoch, "$result.sitePublicationEpoch"),
    draft: { version: editingSiteStylesVersion(draft.version, "$result.draft.version"), styles: checkedStyles(draft.styles, "$result.draft.styles") },
    published: { stylesVersion: editingSiteStylesVersion(published.stylesVersion, "$result.published.stylesVersion"), styles: checkedStyles(published.styles, "$result.published.styles") }
  };
}

export function parseEditingSiteStylesReleaseRequest(value: unknown, path = "$input"): EditingSiteStylesReleaseRequest {
  const source = record(value, path); keys(source, ["expectedVersion", "expectedStylesVersion", "sitePublicationEpoch", "operationId"], path);
  return { expectedVersion: editingSiteStylesVersion(source.expectedVersion, `${path}.expectedVersion`),
    expectedStylesVersion: editingSiteStylesVersion(source.expectedStylesVersion, `${path}.expectedStylesVersion`),
    sitePublicationEpoch: editingSiteStylesVersion(source.sitePublicationEpoch, `${path}.sitePublicationEpoch`),
    operationId: editingSiteStylesOperationId(source.operationId, `${path}.operationId`) };
}

export function parseEditingSiteStylesReleaseApply(value: unknown): EditingSiteStylesReleaseApply {
  const source = record(value, "$input"); keys(source, ["expectedVersion", "expectedStylesVersion", "sitePublicationEpoch", "operationId", "confirmationToken"], "$input");
  return { ...parseEditingSiteStylesReleaseRequest({ expectedVersion: source.expectedVersion, expectedStylesVersion: source.expectedStylesVersion,
    sitePublicationEpoch: source.sitePublicationEpoch, operationId: source.operationId }),
    confirmationToken: editingSiteStylesVersion(source.confirmationToken, "$input.confirmationToken") };
}

function migrationChange(value: unknown, index: number): EditingSiteStylesMigrationChange {
  const path = `$input.changes[${index}]`, source = record(value, path);
  if (source.styleKind !== "token" && source.styleKind !== "textStyle") throw new TypeError(`${path}.styleKind: invalid style kind`);
  if (source.kind === "delete") {
    keys(source, ["kind", "styleKind", "name"], path);
    return { kind: source.kind, styleKind: source.styleKind, name: styleName(source.name, `${path}.name`) };
  }
  if (source.kind === "rename") {
    keys(source, ["kind", "styleKind", "from", "to"], path);
    const from = styleName(source.from, `${path}.from`), to = styleName(source.to, `${path}.to`);
    if (from === to) throw new TypeError(`${path}: rename must change the name`);
    return { kind: source.kind, styleKind: source.styleKind, from, to };
  }
  throw new TypeError(`${path}.kind: invalid migration kind`);
}
export function parseEditingSiteStylesMigrationRequest(value: unknown): EditingSiteStylesMigrationRequest {
  const source = record(value, "$input"); keys(source, ["expectedVersion", "expectedStylesVersion", "sitePublicationEpoch", "operationId", "changes"], "$input");
  if (!Array.isArray(source.changes) || source.changes.length < 1 || source.changes.length > 500) throw new TypeError("$input.changes: expected 1 to 500 changes");
  const changes = source.changes.map(migrationChange);
  return { ...parseEditingSiteStylesReleaseRequest({ expectedVersion: source.expectedVersion, expectedStylesVersion: source.expectedStylesVersion,
    sitePublicationEpoch: source.sitePublicationEpoch, operationId: source.operationId }), changes };
}
export function parseEditingSiteStylesMigrationApply(value: unknown): EditingSiteStylesMigrationApply {
  const source = record(value, "$input"); keys(source, ["expectedVersion", "expectedStylesVersion", "sitePublicationEpoch", "operationId", "changes", "confirmationToken"], "$input");
  return { ...parseEditingSiteStylesMigrationRequest({ expectedVersion: source.expectedVersion, expectedStylesVersion: source.expectedStylesVersion,
    sitePublicationEpoch: source.sitePublicationEpoch, operationId: source.operationId, changes: source.changes }),
    confirmationToken: editingSiteStylesVersion(source.confirmationToken, "$input.confirmationToken") };
}

function affected(value: unknown, index: number): EditingSiteStylesAffected {
  const path = `$result.plan.affected[${index}]`, source = record(value, path); keys(source, ["kind", "id", "version", "locale"], path);
  if (!["page", "locale", "component", "presentation", "shared", "template"].includes(String(source.kind))) throw new TypeError(`${path}.kind: invalid dependency kind`);
  return { kind: source.kind as EditingSiteStylesAffected["kind"], id: identifier(source.id, `${path}.id`),
    version: editingSiteStylesVersion(source.version, `${path}.version`), ...(source.locale === undefined ? {} : { locale: localeCode(source.locale, `${path}.locale`) }) };
}
function planBase(value: Record<string, unknown>, expected: EditingSiteStylesReleaseRequest, migration: boolean) {
  const request = parseEditingSiteStylesReleaseRequest({ expectedVersion: value.expectedVersion, expectedStylesVersion: value.expectedStylesVersion,
    sitePublicationEpoch: value.sitePublicationEpoch, operationId: value.operationId });
  const expectedBase = parseEditingSiteStylesReleaseRequest({ expectedVersion: expected.expectedVersion, expectedStylesVersion: expected.expectedStylesVersion,
    sitePublicationEpoch: expected.sitePublicationEpoch, operationId: expected.operationId });
  if (JSON.stringify(request) !== JSON.stringify(expectedBase)) throw new TypeError("$result.plan: request binding mismatch");
  if (!Array.isArray(value.affected) || value.affected.length > 10_000) throw new TypeError("$result.plan.affected: invalid dependency list");
  const expiresAt = line(value.expiresAt, "$result.plan.expiresAt", 24);
  if (!EXPIRES_AT.test(expiresAt) || Date.parse(expiresAt) <= 0) throw new TypeError("$result.plan.expiresAt: invalid expiry");
  return { ...request, siteId: identifier(value.siteId, "$result.plan.siteId"),
    confirmationToken: editingSiteStylesVersion(value.confirmationToken, "$result.plan.confirmationToken"), expiresAt,
    before: checkedStyles(value.before, "$result.plan.before"), after: checkedStyles(value.after, "$result.plan.after"),
    affected: value.affected.map(affected), ...(migration ? {} : {}) };
}
export function parseEditingSiteStylesReleasePlan(value: unknown, expected: EditingSiteStylesReleaseRequest, siteId?: string): EditingSiteStylesReleasePlan {
  const source = record(value, "$result.plan"); keys(source, ["siteId", "expectedVersion", "expectedStylesVersion", "sitePublicationEpoch", "operationId", "confirmationToken", "expiresAt", "before", "after", "affected"], "$result.plan");
  const plan = planBase(source, expected, false);
  if (siteId !== undefined && plan.siteId !== siteId) throw new TypeError("$result.plan.siteId: site mismatch");
  return plan;
}
export function parseEditingSiteStylesMigrationPlan(value: unknown, expected: EditingSiteStylesMigrationRequest, siteId?: string): EditingSiteStylesMigrationPlan {
  const source = record(value, "$result.plan"); keys(source, ["siteId", "expectedVersion", "expectedStylesVersion", "sitePublicationEpoch", "operationId", "confirmationToken", "expiresAt", "classification", "before", "after", "affected", "changes"], "$result.plan");
  if (!Array.isArray(source.changes)) throw new TypeError("$result.plan.changes: invalid changes");
  const parsed = parseEditingSiteStylesMigrationRequest({ expectedVersion: source.expectedVersion, expectedStylesVersion: source.expectedStylesVersion,
    sitePublicationEpoch: source.sitePublicationEpoch, operationId: source.operationId, changes: source.changes });
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) throw new TypeError("$result.plan: migration binding mismatch");
  if (!["lossless", "semantic", "visual-change"].includes(String(source.classification))) throw new TypeError("$result.plan.classification: invalid classification");
  const base = planBase(source, expected, true);
  if (siteId !== undefined && base.siteId !== siteId) throw new TypeError("$result.plan.siteId: site mismatch");
  return { ...base, changes: parsed.changes, classification: source.classification as EditingSiteStylesMigrationPlan["classification"] };
}

export function siteStylesRequireMigration(before: SiteStyles, after: SiteStyles): boolean {
  const old = parseSiteStyles(before), next = parseSiteStyles(after);
  return Object.keys(old.tokens ?? {}).some((name) => !Object.hasOwn(next.tokens ?? {}, name))
    || Object.keys(old.textStyles ?? {}).some((name) => !Object.hasOwn(next.textStyles ?? {}, name));
}
